-- ============================================================================
-- 0247_voice_lead_calls.sql — agente de voz para leads, piloto Biru (MOM §33).
--
-- Un agente de ElevenLabs SEPARADO del de Reproprovincia llama a los leads de
-- anuncio que conversaron con el bot, no compraron y ninguna asesora tocó. No
-- crea pedidos: toma los datos y deja el lead en «Atender ahora», o anota por
-- qué no compra, o agenda volver a llamar, o registra que no quiere llamadas.
--
-- Cuatro piezas, ningún estado nuevo del pedido:
--   1. `voice_calls` aprende a qué llama (`purpose`): un pedido (lo de siempre)
--      o un lead. Las de lead no tienen `order_id` y nunca lo tendrán, así
--      ninguna lectura por pedido (cola, candado Swayp, panel del Master) las ve.
--      Sus resultados son otros y se validan por carril.
--   2. `leads.contact_opt_out_at`: la persona pidió no ser contactada. Ningún
--      agente la vuelve a llamar y los envíos automáticos de WhatsApp la saltan.
--   3. Ajustes por tienda `stores.voice_lead_*`, apagados por defecto.
--   4. El candado del reintento automático Swayp (0209) deja de tomar el lock de
--      la organización en cada llamada de lead: solo aplica a llamadas con pedido.
--
-- El grupo de control NO necesita tabla: va en `lead_experiments` (0144) con el
-- experimento `agente_voz_leads_v1`, sorteado con su propia sal e independiente
-- de `frio_cobertura_v1`.
--
-- Se aplica a mano ANTES del código (DEPLOY.md). Es idempotente.
-- ============================================================================

-- ── 1. voice_calls: pedido o lead ───────────────────────────────────────────
alter table voice_calls
  add column if not exists purpose text not null default 'order',
  add column if not exists lead_id uuid references leads(id) on delete cascade,
  -- Lo que el agente de leads recibió al marcar (nombre, producto, oferta, lo
  -- que la persona escribió en el chat). Va aparte de `outcome_payload`, que
  -- las tools reescriben enteras.
  add column if not exists lead_context jsonb;

alter table voice_calls alter column order_id drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'voice_calls_purpose_check') then
    alter table voice_calls add constraint voice_calls_purpose_check
      check (purpose in ('order', 'lead'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'voice_calls_target_check') then
    alter table voice_calls add constraint voice_calls_target_check check (
      (purpose = 'order' and order_id is not null and lead_id is null)
      or (purpose = 'lead' and lead_id is not null and order_id is null)
    );
  end if;
end $$;

-- Los resultados por carril. Los de pedido no cambian (§11.8). Los de lead son
-- los de §33; `no_contesta` y `sin_resultado` son de los dos porque los
-- escriben la línea y el barrido, que no distinguen. Un lead NUNCA usa
-- `confirma`: es la marca que dispara la salida Swayp (`salidasSwaypPendientes`).
alter table voice_calls drop constraint if exists voice_calls_outcome_check;
alter table voice_calls add constraint voice_calls_outcome_check check (
  outcome is null
  or (purpose = 'order' and outcome in ('confirma', 'programar', 'no_contesta', 'cancela', 'sin_resultado'))
  or (purpose = 'lead' and outcome in (
    'atender_ahora', 'volver_a_llamar', 'no_compra', 'no_llamar', 'no_contesta', 'sin_resultado'
  ))
);

create index if not exists voice_calls_lead_idx
  on voice_calls(lead_id, queued_at desc) where lead_id is not null;

comment on column voice_calls.purpose is
  'MOM §33. order = agente de pedidos (§11.8, order_id); lead = agente de leads (lead_id). '
  'Nunca se mezclan en topes, cola, tableros ni escrituras.';
comment on column voice_calls.lead_id is
  'MOM §33. El lead que llama el agente de leads. Solo con purpose = lead; ese agente no crea pedidos.';
comment on column voice_calls.lead_context is
  'MOM §33. Lo que el agente de leads recibió al marcar (ficha y chat). Se escribe una vez, al marcar.';

-- ── 2. Pidió no ser contactado ──────────────────────────────────────────────
alter table leads
  add column if not exists contact_opt_out_at timestamptz;

comment on column leads.contact_opt_out_at is
  'MOM §33. La persona pidió no ser contactada (se lo dijo al agente de voz). Ningún agente la llama '
  'y el drip y la secuencia de carritos la saltan. Una asesora todavía puede responderle si ella escribe.';

-- ── 3. Ajustes por tienda ───────────────────────────────────────────────────
alter table stores
  add column if not exists voice_lead_enabled boolean not null default false,
  add column if not exists voice_lead_auto boolean not null default false,
  add column if not exists voice_lead_daily_cap integer not null default 40
    check (voice_lead_daily_cap between 0 and 300),
  add column if not exists voice_lead_max_attempts integer not null default 2
    check (voice_lead_max_attempts between 1 and 4),
  add column if not exists voice_lead_wait_minutes integer not null default 120
    check (voice_lead_wait_minutes between 0 and 1440),
  add column if not exists voice_lead_max_age_hours integer not null default 48
    check (voice_lead_max_age_hours between 1 and 168),
  add column if not exists voice_lead_holdout_pct integer not null default 50
    check (voice_lead_holdout_pct between 0 and 90),
  add column if not exists voice_lead_hour_start integer not null default 9
    check (voice_lead_hour_start between 0 and 23),
  add column if not exists voice_lead_hour_end integer not null default 20
    check (voice_lead_hour_end between 1 and 24),
  add column if not exists voice_lead_campaign_ids text[] not null default '{}',
  add column if not exists voice_lead_product text,
  add column if not exists voice_lead_offer text;

comment on column stores.voice_lead_enabled is
  'MOM §33. Habilita el agente de leads: su cola y el botón del drawer del lead. Apagado por defecto.';
comment on column stores.voice_lead_auto is
  'MOM §33. El barrido llama solo. Apagarlo es la marcha atrás sin perder el sorteo.';
comment on column stores.voice_lead_holdout_pct is
  'MOM §33. Porcentaje de los leads elegibles que van al grupo de control: el agente nunca los llama.';
comment on column stores.voice_lead_campaign_ids is
  'MOM §33. Campañas de Meta (campaign_id) cuyos leads llama el agente. Vacío = ninguna.';
comment on column stores.voice_lead_offer is
  'MOM §33. Precios y promociones que el agente puede decir, tal cual. Lo que no esté aquí no lo ofrece.';

-- ── 4. El candado Swayp solo aplica a llamadas con pedido ───────────────────
-- La función no cambia (0209). Con `order_id` nulo nunca levantaba el error,
-- pero tomaba el lock de la organización que también toma
-- `swayp_emission_claim`: cada llamada de lead se ponía en fila con Swayp.
drop trigger if exists swayp_auto_voice_interlock on voice_calls;
create trigger swayp_auto_voice_interlock before insert on voice_calls for each row
  when (new.mode = 'real' and new.order_id is not null) execute function swayp_auto_voice_interlock();
