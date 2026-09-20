-- 0172_collection_alerts.sql — la cola de cobranza del número de Shalom, con
-- dueño y escalamiento.
--
-- EL HUECO. La ingesta (0171) ya registra sola el comprobante que llega por el
-- 600, o anota por qué no pudo. Pero no avisa a NADIE: hay que entrar a
-- Revisión de pagos o a Anomalías a mirar. Un proceso de cobranza sin dueño es
-- un proceso que se atiende cuando alguien se acuerda.
--
-- POR QUÉ NO SE REUSA LA ALERTA DE LEADS. La de «Yape/Shalom por verificar»
-- reparte entre las asesoras CONECTADAS, tipo ronda, y filtra `has_order =
-- false`. Aquí es al revés en las dos cosas: hay pedido, y hay un responsable
-- —no una competencia por atender primero—. Ofrecérsela a quien esté en línea
-- convertiría una responsabilidad en una rifa.
--
-- POR QUÉ LA ESCALERA ES CONFIGURABLE. Escribir «Gerardo, luego Yohalis, luego
-- Frank» en el código significa un despliegue el día que alguien cambie de
-- puesto o se vaya de vacaciones. Vive en la base y se edita desde Ajustes.
--
-- LA ESPERA NO MIRA SI ESTÁ CONECTADO, a diferencia de la de asesoras: la
-- oferta aguanta sus minutos aunque tenga el navegador cerrado. Si saltara al
-- desconectarse, en la práctica todo acabaría en el último escalón.

create table if not exists store_collection_escalation (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references stores(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  -- El orden de la escalera: 1 es el responsable principal.
  sort        integer not null default 100,
  -- Minutos antes de pasar al siguiente. El ÚLTIMO escalón lo ignora: ahí se
  -- queda, porque después de él no hay a quién avisar.
  minutes     integer not null default 30 check (minutes between 1 and 1440),
  created_at  timestamptz not null default now(),
  unique (store_id, user_id)
);

create index if not exists store_collection_escalation_idx
  on store_collection_escalation (store_id, sort);

alter table store_collection_escalation enable row level security;
drop policy if exists store_collection_escalation_select on store_collection_escalation;
create policy store_collection_escalation_select on store_collection_escalation
  for select to authenticated using (store_id in (select auth_store_ids()));

create table if not exists collection_alerts (
  id                  uuid primary key default gen_random_uuid(),
  store_id            uuid not null references stores(id) on delete cascade,
  -- `registrado`: entró solo y hay que validarlo.
  -- `sin_atribuir`: llegó plata y no se supo de qué pedido es.
  kind                text not null check (kind in ('registrado', 'sin_atribuir')),
  order_id            uuid references orders(id) on delete set null,
  payment_id          uuid references order_payments(id) on delete set null,
  phone               text,
  -- La deduplicación: Kapso reentrega webhooks, y dos alertas del mismo
  -- comprobante son dos personas mirando lo mismo.
  inbound_message_id  text,
  amount              numeric(12, 2),
  detail              text,

  status              text not null default 'abierta'
                        check (status in ('abierta', 'atendida', 'descartada')),

  -- A quién le toca AHORA, y desde cuándo. De aquí sale el escalamiento.
  offered_to          uuid references auth.users(id) on delete set null,
  offered_at          timestamptz,
  -- Quiénes ya dejaron pasar su turno (o lo rechazaron a mano).
  passed              uuid[] not null default '{}',
  claimed_by          uuid references auth.users(id) on delete set null,
  claimed_at          timestamptz,

  resolved_by         uuid references auth.users(id) on delete set null,
  resolved_at         timestamptz,
  resolution          text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists collection_alerts_inbound_uniq
  on collection_alerts (store_id, inbound_message_id)
  where inbound_message_id is not null;

-- Las abiertas de una tienda, que es lo que se consulta en cada pasada.
create index if not exists collection_alerts_open_idx
  on collection_alerts (store_id, created_at) where status = 'abierta';
-- Y las mías, que es lo que pinta la pantalla.
create index if not exists collection_alerts_offered_idx
  on collection_alerts (offered_to, status);

alter table collection_alerts enable row level security;
drop policy if exists collection_alerts_select on collection_alerts;
create policy collection_alerts_select on collection_alerts for select to authenticated
  using (store_id in (select auth_store_ids()));

comment on table collection_alerts is
  'Cobranza del número de Shalom: un comprobante que entró solo y hay que '
  'validar, o plata que llegó y no se supo de qué pedido es. Tiene dueño y '
  'escalamiento por tiempo (store_collection_escalation).';
comment on column collection_alerts.passed is
  'Quienes ya dejaron pasar su turno. Se les salta al recalcular la oferta.';
comment on column collection_alerts.offered_to is
  'A quién le toca ahora. NULL mientras no haya escalera configurada: la '
  'alerta existe igual y se ve en la cola de la tienda.';
