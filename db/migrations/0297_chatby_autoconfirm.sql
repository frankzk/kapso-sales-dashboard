-- 0297_chatby_autoconfirm.sql — Confirmación automática por Chatby y guía
-- Aliclik automática con tope diario (MOM §6.1, «Confirmó por Chatby»,
-- decisión del owner del 01-11-2026).
--
-- QUÉ ES. Una pasada cada 10 minutos (/api/cron/chatby-autoconfirm) lee la
-- conversación de Chatby de los pedidos de Provincia COD en Por confirmar de
-- las últimas 72 h (los mismos dos GET de la ficha, solo lectura) y, si el
-- mensaje de la clienta nombra el pedido, dice confirmar y pagar en casa, el
-- monto coincide con el total y la dirección es la del pedido, lo confirma por
-- el mismo camino que la mesa (`register_confirmation_attempt_v2`, sin actor,
-- `source = 'chatby'`). A lo que confirmó le crea la guía Aliclik por el camino
-- del botón, hasta `daily_cap` guías por día de Lima en la organización.
--
-- ENCENDIDO AL INSTALAR. Lo pidió el owner: la fila de cada organización nace
-- con `enabled = true` y `daily_cap = 20`. Se apaga desde la base
-- (`update chatby_auto_settings set enabled = false …`). Sin esta migración el
-- código no hace nada: no hay fila que lo encienda.
--
-- Solo las organizaciones con tiendas activas que NO son tiendas cliente de
-- Grupo GF (§29.15.1: Chatby es una integración con credenciales únicas de
-- Grupo GF y queda apagada para una organización cliente).
--
-- `chatby_auto_checks` es la marca de procesado: una fila por pedido mirado.
-- No guarda la conversación ni la dirección (§25): el id del mensaje, el
-- resultado, el motivo y la guía. Lo resuelto (`confirmado`, `para_asesora`)
-- no se vuelve a leer; lo pendiente se relee cada `recheck_minutes`.

create table if not exists chatby_auto_settings (
  org_id             uuid primary key references organizations(id) on delete cascade,
  enabled            boolean not null default true,
  guide_enabled      boolean not null default true,
  daily_cap          integer not null default 20 check (daily_cap between 0 and 200),
  window_hours       integer not null default 72 check (window_hours between 1 and 168),
  max_orders_per_run integer not null default 20 check (max_orders_per_run between 1 and 100),
  recheck_minutes    integer not null default 30 check (recheck_minutes between 5 and 1440),
  updated_by         uuid references auth.users(id) on delete set null,
  updated_at         timestamptz not null default now()
);

create table if not exists chatby_auto_checks (
  order_id      uuid primary key references orders(id) on delete cascade,
  store_id      uuid not null references stores(id),
  org_id        uuid not null references organizations(id),
  outcome       text not null
                check (outcome in ('confirmado', 'para_asesora', 'sin_confirmacion', 'sin_conversacion', 'error')),
  reason        text,
  message_id    text,
  evidence      jsonb not null default '{}',
  reads         integer not null default 0,
  checked_at    timestamptz not null default now(),
  confirmed_at  timestamptz,
  -- La guía automática: null = pendiente (o todavía no confirmado).
  guide_state   text check (guide_state in ('creada', 'fallo', 'para_persona', 'ya_tenia', 'fuera')),
  guide_code    text,
  guide_detail  text,
  guide_at      timestamptz
);
create index if not exists chatby_auto_checks_guides_idx
  on chatby_auto_checks (org_id, guide_state, guide_at desc)
  where outcome = 'confirmado';
create index if not exists chatby_auto_checks_checked_idx
  on chatby_auto_checks (org_id, checked_at);

alter table chatby_auto_settings enable row level security;
alter table chatby_auto_checks enable row level security;
drop policy if exists chatby_auto_settings_read on chatby_auto_settings;
create policy chatby_auto_settings_read on chatby_auto_settings
  for select to authenticated using (org_id in (select auth_org_ids()));
drop policy if exists chatby_auto_checks_read on chatby_auto_checks;
create policy chatby_auto_checks_read on chatby_auto_checks
  for select to authenticated using (store_id in (select auth_store_ids()));
grant select on chatby_auto_settings, chatby_auto_checks to authenticated;
grant all on chatby_auto_settings, chatby_auto_checks to service_role;

insert into chatby_auto_settings (org_id)
select distinct s.org_id
  from stores s
 where s.status = 'active'
   and s.org_id is not null
   -- Cliente es la organización AJENA a la del operador (§29.15.1). Aurela y
   -- Kenku tienen contrato con Grupo GF dentro de su propia organización: no
   -- son clientes, y la primera versión de este filtro las dejaba fuera.
   and not exists (
     select 1
       from logistics_service_agreements a
       join logistics_providers p on p.id = a.provider_id
      where a.client_org_id = s.org_id
        and p.org_id <> s.org_id
   )
on conflict (org_id) do nothing;
