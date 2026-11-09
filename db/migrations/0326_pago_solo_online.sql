-- ============================================================================
-- 0326_pago_solo_online.sql — «Pago solo online (lista automática)» (MOM
-- §41.11; pedido de Kenku Perú y Aurela del 09-11-2026,
-- docs/kapta/pago-solo-online.md).
--
-- POR QUÉ. La web de cada tienda deja de ofrecer contra entrega a quien ya
-- tuvo una entrega fallida y nunca recibió un pedido. Kapta calcula esa lista
-- una vez al día (05:00 de Lima), la manda ENTERA a cada tienda (cada envío la
-- reemplaza: COD Core 0.10.45, `POST /wp-json/cod-core/v1/pago-solo-online`) y
-- la usa como un freno más de la «Lista de pago adelantado» (§41) en los
-- pedidos que crea Kapta: el mismo `prepayOrderCheck`, con lo que el owner
-- decida cobrar (adelanto por defecto, decisión del 09-11-2026).
--
-- LA REGLA (decidida por el owner, 09-11-2026). Cliente = los últimos 9
-- dígitos del celular, Kenku y Aurela juntos (la organización), todo el
-- historial, solo contra entrega (`coverage` = `lima` o `provincia_cod`), sin
-- los pedidos con un hecho de la migración de plataforma. Entra con CERO
-- `entregado` y (A) al menos un `devuelto`, o (B) 5 o más pedidos con el 75 %
-- o más `anulado` (el «anulador»). Un anulado después de salir, solo, ya no
-- basta. Es `pago_online_candidates`.
--
-- QUÉ CREA.
--   * `pago_online_settings`: por organización, la posición (apagado,
--     simulación, activo; sin fila = apagado), qué se cobra (`adelanto` o
--     `pago_completo`; nace en `adelanto`) y la corrida vigente, la que lee el
--     freno.
--   * `pago_online_runs`: una fila por cálculo (cuentas, freno de cambio
--     brusco, quién lo aceptó). Sin celulares.
--   * `pago_online_phones`: los celulares de una corrida en Activo, con sus
--     por qué entran (devuelto o anulador), sus cuentas y los correos que van
--     con ellos. SOLO el servidor: ni la RLS ni
--     un grant dejan que el navegador los lea.
--   * `pago_online_sends`: el registro de cada envío a cada tienda (estado,
--     cuentas, código HTTP, error, reintento, verificación por GET). Sin
--     celulares.
--   * `pago_online_exceptions`: la excepción de Kapta (un celular que no entra
--     a la lista aunque cumpla la regla), con motivo, persona y fecha; se
--     quita, no se borra. Las tiendas tienen la suya (`-987654321`).
--   * Las funciones del servidor: `pago_online_candidates` (la regla),
--     `pago_online_build` (calcula y guarda), `pago_online_por_confirmar`
--     (cuántos pedidos de Por confirmar frenaría) y `pago_online_lookup` (el
--     freno de un celular).
--
-- No cambia datos. Correrla otra vez no cambia nada. Todo nace apagado.
-- ============================================================================

create table if not exists public.pago_online_settings (
  org_id          uuid primary key references public.organizations(id) on delete cascade,
  mode            text not null default 'apagado' check (mode in ('apagado', 'simulacion', 'activo')),
  -- Lo que se le pide al cliente de la lista en los pedidos de Kapta (§41.11):
  -- el adelanto de la escalera del §8 (S/ 20, `ADELANTO_MINIMO`) o el pago
  -- completo. Decisión del owner del 09-11-2026: adelanto.
  requirement     text not null default 'adelanto' check (requirement in ('adelanto', 'pago_completo')),
  -- La corrida que lee el freno. Solo una corrida en Activo que pasó el freno
  -- de cambio brusco (o que alguien aceptó) llega aquí.
  current_run_id  uuid,
  updated_by      uuid references auth.users(id) on delete set null,
  updated_at      timestamptz not null default now()
);

create table if not exists public.pago_online_runs (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references public.organizations(id) on delete cascade,
  -- El día de Lima del cálculo.
  run_date              date not null,
  mode                  text not null check (mode in ('simulacion', 'activo')),
  trigger               text not null check (trigger in ('cron', 'manual')),
  -- El candado de la tarea diaria: una sola corrida del cron por organización,
  -- día y posición (`<día>:<posición>`). Las manuales no lo llevan.
  daily_key             text,
  status                text not null default 'calculando' check (status in ('calculando', 'listo', 'error')),
  requirement           text not null check (requirement in ('adelanto', 'pago_completo')),
  phones                integer not null default 0 check (phones >= 0),
  emails                integer not null default 0 check (emails >= 0),
  two_or_more           integer not null default 0 check (two_or_more >= 0),
  anuladores            integer not null default 0 check (anuladores >= 0),
  excepted              integer not null default 0 check (excepted >= 0),
  por_confirmar_listed  integer not null default 0 check (por_confirmar_listed >= 0),
  por_confirmar_braked  integer not null default 0 check (por_confirmar_braked >= 0),
  -- El freno de cambio brusco (§4.5): contra la corrida vigente.
  baseline_phones       integer,
  guard                 text check (guard in ('primera', 'ok', 'bloqueado', 'aceptado')),
  guard_reason          text check (guard_reason is null or length(guard_reason) <= 500),
  accepted_by           uuid references auth.users(id) on delete set null,
  accepted_at           timestamptz,
  regla                 text check (regla is null or length(regla) <= 300),
  error                 text check (error is null or length(error) <= 500),
  started_at            timestamptz not null default now(),
  finished_at           timestamptz
);
create unique index if not exists pago_online_runs_daily_uniq
  on public.pago_online_runs (org_id, daily_key) where daily_key is not null;
create index if not exists pago_online_runs_org_idx
  on public.pago_online_runs (org_id, started_at desc);

do $$ begin
  alter table public.pago_online_settings
    add constraint pago_online_settings_run_fk foreign key (current_run_id)
    references public.pago_online_runs(id) on delete set null;
exception when duplicate_object then null; end $$;

create table if not exists public.pago_online_phones (
  run_id  uuid not null references public.pago_online_runs(id) on delete cascade,
  org_id  uuid not null references public.organizations(id) on delete cascade,
  -- Los últimos 9 dígitos, como la tienda.
  phone   text not null check (phone ~ '^[0-9]{9}$'),
  -- Por qué entra: `devuelto` (1+ devuelto) o `anulador` (5+ pedidos con 75 %
  -- o más anulados). `failed` es la cuenta de lo que lo hizo entrar: los
  -- devueltos, o los anulados del anulador; `orders`, sus pedidos contra
  -- entrega que cuentan (sin los de la migración de plataforma).
  reason  text not null default 'devuelto' check (reason in ('devuelto', 'anulador')),
  failed  integer not null check (failed >= 1),
  orders  integer not null default 0 check (orders >= 0),
  emails  text[] not null default '{}'::text[],
  primary key (run_id, phone)
);
create index if not exists pago_online_phones_lookup_idx on public.pago_online_phones (org_id, phone);

create table if not exists public.pago_online_sends (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  store_id         uuid not null references public.stores(id) on delete cascade,
  -- Null en una prueba («Enviar prueba»): no es una corrida.
  run_id           uuid references public.pago_online_runs(id) on delete set null,
  kind             text not null check (kind in ('diaria', 'manual', 'prueba')),
  attempt          integer not null default 1 check (attempt between 1 and 4),
  status           text not null default 'enviando' check (status in (
                     'enviando', 'enviado', 'reintento', 'fallido', 'sin_endpoint',
                     'credenciales', 'demasiado_grande', 'freno_cambio', 'sin_claves')),
  phones_sent      integer not null default 0 check (phones_sent >= 0),
  emails_sent      integer not null default 0 check (emails_sent >= 0),
  http_status      integer,
  error            text check (error is null or length(error) <= 500),
  -- El freno de cambio brusco de esta tienda: su último envío bueno.
  baseline_phones  integer,
  guard_reason     text check (guard_reason is null or length(guard_reason) <= 500),
  -- Lo que contestó la tienda (`celulares`, `correos`, `descartados`,
  -- `actualizado`, `regla`): cuentas, nunca números.
  response         jsonb,
  -- El GET de verificación después de un envío bueno: las mismas cuentas.
  verify           jsonb,
  verify_error     text check (verify_error is null or length(verify_error) <= 500),
  next_attempt_at  timestamptz,
  alerted          text check (alerted is null or alerted in ('dos_dias', 'freno_cambio', 'demasiado_grande')),
  actor            uuid references auth.users(id) on delete set null,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz
);
-- El candado de cada intento: dos pasadas a la vez no mandan dos veces.
create unique index if not exists pago_online_sends_attempt_uniq
  on public.pago_online_sends (run_id, store_id, attempt) where run_id is not null;
create index if not exists pago_online_sends_store_idx
  on public.pago_online_sends (store_id, started_at desc);
create index if not exists pago_online_sends_due_idx
  on public.pago_online_sends (next_attempt_at) where status = 'reintento';

create table if not exists public.pago_online_exceptions (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  phone           text not null check (phone ~ '^[0-9]{9}$'),
  reason          text not null check (length(btrim(reason)) between 8 and 500),
  -- El pedido desde el que se exceptuó, para mostrarlo sin el celular.
  order_id        uuid,
  order_name      text,
  added_by        uuid references auth.users(id) on delete set null,
  added_at        timestamptz not null default now(),
  removed_at      timestamptz,
  removed_by      uuid references auth.users(id) on delete set null,
  removed_reason  text,
  constraint pago_online_exceptions_removed_ck check (
    (removed_at is null and removed_by is null and removed_reason is null)
    or (removed_at is not null and removed_reason is not null and length(btrim(removed_reason)) >= 8)
  )
);
create unique index if not exists pago_online_exceptions_live_uniq
  on public.pago_online_exceptions (org_id, phone) where removed_at is null;

-- ── La regla ────────────────────────────────────────────────────────────────

-- Los clientes de la lista de una organización (regla del owner del
-- 09-11-2026), con por qué entran, sus cuentas, los correos que van con ellos
-- (solo un correo visto con UN solo celular en los pedidos de la organización)
-- y si Kapta los exceptuó. Cuentan solo los pedidos contra entrega (`lima`,
-- `provincia_cod`) que NO tienen un hecho de la migración de plataforma
-- (`cancelled_woocommerce`, `legacy_shopify_sale_cancelled`,
-- `woo_sale_ended_pending_return`, MOM §38): esos son artefactos del cambio
-- de Shopify a WooCommerce y no cuentan para nada (ni fallas ni entregas).
-- Entra con CERO `entregado` y:
--   (A) `devuelto`: al menos un `devuelto`; o
--   (B) `anulador`: 5 o más pedidos (el owner: «más de 4») con el 75 % o más
--       `anulado` (cualquier anulado, antes o después de salir).
-- Los umbrales (5 y 0,75) son los de `PAGO_ONLINE_ANULADOR_MIN_ORDERS` y
-- `PAGO_ONLINE_ANULADOR_RATIO` (lib/pago-online.ts): si cambian, cambian en
-- los dos sitios. Los hechos de la migración se leen una vez por
-- `order_events_kind_idx` (store_id, kind) y se descartan con un hash.
-- La consulta de referencia del pedido de las tiendas (§3.1) ya no es esta:
-- la lista de Kapta manda.
create or replace function public.pago_online_candidates(p_org uuid)
returns table(phone text, failed integer, reason text, orders integer, emails text[], excepted boolean)
language sql stable
set search_path = public
as $$
  with st as materialized (select s.id from public.stores s where s.org_id = p_org),
  mig as materialized (
    select distinct ev.order_id from public.order_events ev join st on st.id = ev.store_id
    where ev.kind in ('cancelled_woocommerce', 'legacy_shopify_sale_cancelled', 'woo_sale_ended_pending_return')
  ),
  h as materialized (
    select right(regexp_replace(coalesce(om.customer_phone, ''), '\D', '', 'g'), 9) as phone,
      count(*)::int as orders,
      count(*) filter (where om.general_status = 'devuelto')::int as devueltos,
      count(*) filter (where om.general_status = 'anulado')::int as anulados,
      count(*) filter (where om.general_status = 'entregado')::int as received
    from public.order_master om join st on st.id = om.store_id
    where om.coverage in ('lima', 'provincia_cod')
      and not exists (select 1 from mig where mig.order_id = om.order_id)
    group by 1
  ),
  l as materialized (
    select h.phone,
      case when h.devueltos >= 1 then h.devueltos else h.anulados end as failed,
      case when h.devueltos >= 1 then 'devuelto' else 'anulador' end as reason,
      h.orders
    from h
    where length(h.phone) = 9 and h.received = 0
      and (h.devueltos >= 1
           -- (B) el anulador: 5 y 0,75, los mismos de lib/pago-online.ts.
           or (h.orders >= 5 and h.anulados::numeric >= 0.75 * h.orders))
  ),
  e as materialized (
    select right(regexp_replace(coalesce(o.customer_phone, ''), '\D', '', 'g'), 9) as phone,
      lower(btrim(coalesce(o.raw->'woo'->'billing'->>'email', o.raw->'billing'->>'email', o.raw->>'email'))) as email
    from public.orders o join st on st.id = o.store_id
    where coalesce(o.raw->'woo'->'billing'->>'email', o.raw->'billing'->>'email', o.raw->>'email') like '%@%'
  ),
  ev as materialized (
    select e.email, min(e.phone) as phone from e
    where e.email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and length(e.email) <= 254 and length(e.phone) = 9
    group by e.email having count(distinct e.phone) = 1
  ),
  em as materialized (select ev.phone, array_agg(ev.email order by ev.email) as emails from ev group by ev.phone)
  select l.phone, l.failed, l.reason, l.orders, coalesce(em.emails, '{}'::text[]),
    exists (select 1 from public.pago_online_exceptions x where x.org_id = p_org and x.phone = l.phone and x.removed_at is null)
  from l left join em on em.phone = l.phone
  order by l.phone;
$$;

-- Cuántos pedidos de Por confirmar de la organización son de un celular de
-- la lista, y cuántos frenaría hoy lo que se cobra: sin el pago completo
-- (`orderFullyPaid`: la pasarela del checkout o `pago_completo`) y, con
-- `adelanto`, sin el adelanto validado de la escalera del §8.
create or replace function public.pago_online_por_confirmar(p_org uuid, p_phones text[], p_requirement text)
returns jsonb
language sql stable
set search_path = public
as $$
  with ph as materialized (select distinct unnest(p_phones) as phone),
  o as materialized (
    select om.payment_state, om.financial_status, om.payment_gateway, om.total_refunded,
      right(regexp_replace(coalesce(om.customer_phone, ''), '\D', '', 'g'), 9) as phone
    from public.order_master om join public.stores s on s.id = om.store_id
    where s.org_id = p_org and om.macro_stage = 'por_confirmar'
  ),
  m as materialized (select o.* from o join ph on ph.phone = o.phone)
  select jsonb_build_object(
    'listed', count(*),
    -- Todo con `coalesce`: un `null` aquí no es «pagado».
    'braked', count(*) filter (where not (
      (lower(btrim(coalesce(m.financial_status, ''))) = 'paid' and coalesce(m.total_refunded, 0) <= 0 and coalesce(m.payment_gateway, '') = 'checkout')
      or coalesce(m.payment_state, '') = 'pago_completo'
      or (p_requirement = 'adelanto' and coalesce(m.payment_state, '') in ('adelanto_validado', 'diferencia_cargada', 'pago_completo'))
    ))
  ) from m;
$$;

-- Calcula la lista de la organización. Con `p_run` guarda sus celulares (una
-- corrida en Activo); sin él, solo cuenta (Simulación). Devuelve las cuentas,
-- nunca los celulares.
create or replace function public.pago_online_build(p_org uuid, p_run uuid, p_requirement text)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_rows jsonb;
  v_phones text[];
  v_emails integer;
  v_two integer;
  v_anul integer;
  v_exc integer;
  v_pc jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('p', c.phone, 'f', c.failed, 'r', c.reason, 'o', c.orders, 'e', to_jsonb(c.emails))
                  order by c.phone) filter (where not c.excepted), '[]'::jsonb),
         coalesce(array_agg(c.phone order by c.phone) filter (where not c.excepted), '{}'::text[]),
         coalesce(sum(cardinality(c.emails)) filter (where not c.excepted), 0)::int,
         -- «2 o más»: dos o más devueltos (los anuladores no entran en esta cuenta).
         count(*) filter (where not c.excepted and c.reason = 'devuelto' and c.failed >= 2)::int,
         count(*) filter (where not c.excepted and c.reason = 'anulador')::int,
         count(*) filter (where c.excepted)::int
    into v_rows, v_phones, v_emails, v_two, v_anul, v_exc
    from public.pago_online_candidates(p_org) c;

  if p_run is not null then
    insert into public.pago_online_phones (run_id, org_id, phone, failed, reason, orders, emails)
    select p_run, p_org, r->>'p', (r->>'f')::int, r->>'r', (r->>'o')::int, array(select jsonb_array_elements_text(r->'e'))
    from jsonb_array_elements(v_rows) r
    on conflict (run_id, phone) do nothing;
  end if;

  v_pc := public.pago_online_por_confirmar(p_org, v_phones, p_requirement);
  return jsonb_build_object(
    'phones', cardinality(v_phones),
    'emails', v_emails,
    'two_or_more', v_two,
    'anuladores', v_anul,
    'excepted', v_exc,
    'por_confirmar_listed', coalesce((v_pc->>'listed')::int, 0),
    'por_confirmar_braked', coalesce((v_pc->>'braked')::int, 0)
  );
end;
$$;

-- El freno de UN celular (9 dígitos): está en la corrida vigente, la
-- organización está en Activo y Kapta no lo exceptuó. Sin fila: no está.
create or replace function public.pago_online_lookup(p_org uuid, p_phone text)
returns table(listed boolean, failed integer, reason text, orders integer, requirement text)
language sql stable
set search_path = public
as $$
  select (p.phone is not null
          and not exists (select 1 from public.pago_online_exceptions x
                          where x.org_id = p_org and x.phone = p_phone and x.removed_at is null)),
         p.failed,
         p.reason,
         p.orders,
         s.requirement
  from public.pago_online_settings s
  left join public.pago_online_phones p on p.run_id = s.current_run_id and p.phone = p_phone
  where s.org_id = p_org and s.mode = 'activo';
$$;

-- ── Permisos ────────────────────────────────────────────────────────────────

alter table public.pago_online_settings enable row level security;
alter table public.pago_online_runs enable row level security;
alter table public.pago_online_phones enable row level security;
alter table public.pago_online_sends enable row level security;
alter table public.pago_online_exceptions enable row level security;

-- Leen los miembros de la organización lo que no lleva celulares de la lista
-- (como `prepay_list_settings`). Escribe solo el servidor, después de
-- comprobar `automations.manage` o `prepay_list.manage`.
drop policy if exists pago_online_settings_read on public.pago_online_settings;
create policy pago_online_settings_read on public.pago_online_settings
  for select to authenticated using (org_id in (select auth_org_ids()));
drop policy if exists pago_online_runs_read on public.pago_online_runs;
create policy pago_online_runs_read on public.pago_online_runs
  for select to authenticated using (org_id in (select auth_org_ids()));
drop policy if exists pago_online_sends_read on public.pago_online_sends;
create policy pago_online_sends_read on public.pago_online_sends
  for select to authenticated using (org_id in (select auth_org_ids()));
-- Las excepciones, como las altas de la lista de pago adelantado (0309): el
-- celular lo escribió una persona del equipo.
drop policy if exists pago_online_exceptions_read on public.pago_online_exceptions;
create policy pago_online_exceptions_read on public.pago_online_exceptions
  for select to authenticated using (org_id in (select auth_org_ids()));
-- `pago_online_phones`: sin política. El navegador no lee los celulares de la
-- lista, ni de su organización.

revoke all on public.pago_online_settings, public.pago_online_runs, public.pago_online_phones,
  public.pago_online_sends, public.pago_online_exceptions from anon, authenticated;
grant select on public.pago_online_settings, public.pago_online_runs, public.pago_online_sends,
  public.pago_online_exceptions to authenticated;
grant all on public.pago_online_settings, public.pago_online_runs, public.pago_online_phones,
  public.pago_online_sends, public.pago_online_exceptions to service_role;

revoke all on function public.pago_online_candidates(uuid) from public, anon, authenticated;
revoke all on function public.pago_online_por_confirmar(uuid, text[], text) from public, anon, authenticated;
revoke all on function public.pago_online_build(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.pago_online_lookup(uuid, text) from public, anon, authenticated;
grant execute on function public.pago_online_candidates(uuid) to service_role;
grant execute on function public.pago_online_por_confirmar(uuid, text[], text) to service_role;
grant execute on function public.pago_online_build(uuid, uuid, text) to service_role;
grant execute on function public.pago_online_lookup(uuid, text) to service_role;
