-- ============================================================================
-- 0064_tanders_payment_check.sql — validar la constancia de PAGO de cada
-- entrega Tanders antes de dar el pedido por cobrado.
--
-- Tanders sube dos evidencias por entrega: la foto del paquete y el comprobante
-- del pago, que el repartidor yapea a Grupo GF SAC. Ese segundo comprobante es
-- el que dice si el dinero llegó, y hasta ahora nadie lo miraba una por una.
--
-- Se pasa por el lector de comprobantes que ya existe (lib/vision.ts, el mismo
-- de los Yape de adelanto) y se comprueban dos cosas: que el Yape vaya a Grupo
-- GF SAC y que el monto sea el de la guía. Un pago a otra cuenta es dinero que
-- no llegó; un monto distinto es un cobro mal hecho.
--
-- El estado BLOQUEA: mientras no sea 'validado' o 'revisado', el pedido no se
-- da por cobrado. `pendiente` y `rechazado` son distintos a propósito —
-- pendiente es "todavía no lo sé", rechazado es "esto está mal": marcar un
-- fallo del lector como rechazo mandaría a investigar un fraude inexistente.
-- ============================================================================

alter table shipments
  -- pendiente | validado | rechazado | revisado. Null = no aplica (no es Tanders
  -- entregado todavía).
  add column if not exists payment_check_state text;

comment on column shipments.payment_check_state is
  'Validación de la constancia de pago (Tanders). Solo validado/revisado dan el cobro por bueno.';

create index if not exists shipments_payment_check_idx
  on shipments(store_id, payment_check_state)
  where payment_check_state is not null;

-- ----------------------------------------------------------------------------
-- Cada intento de comprobación, con lo que el lector leyó. Es la evidencia de
-- POR QUÉ se aceptó o se rechazó un cobro: sin esto, un rechazo es una palabra
-- sin respaldo y un administrador no puede revisarlo con criterio.
-- ----------------------------------------------------------------------------

create table if not exists tanders_payment_checks (
  id               uuid primary key default gen_random_uuid(),
  shipment_id      uuid not null references shipments(id) on delete cascade,
  store_id         uuid not null references stores(id) on delete cascade,
  -- La imagen que se analizó, tal como la sirve Tanders.
  image_url        text,
  state            text not null,
  reasons          text[] not null default '{}',
  -- Lo que el lector transcribió (para que el revisor no tenga que abrir la
  -- imagen para entender el veredicto).
  recipient_name   text,
  amount           numeric(14, 2),
  operation_number text,
  expected_amount  numeric(14, 2),
  model            text,
  -- Respuesta cruda de la API de evidencias: su forma no está documentada.
  raw              jsonb,
  checked_at       timestamptz not null default now(),
  -- Revisión manual: quién dio por bueno un rechazo, y por qué.
  reviewed_by      uuid references auth.users(id) on delete set null,
  reviewed_at      timestamptz,
  review_note      text
);

create index if not exists tanders_payment_checks_shipment_idx
  on tanders_payment_checks(shipment_id, checked_at desc);
create index if not exists tanders_payment_checks_store_idx
  on tanders_payment_checks(store_id, state);

-- Un mismo nº de operación en dos entregas es un comprobante reutilizado: el
-- índice lo hace barato de detectar.
create index if not exists tanders_payment_checks_operation_idx
  on tanders_payment_checks(operation_number)
  where operation_number is not null;

alter table tanders_payment_checks enable row level security;

drop policy if exists tanders_payment_checks_select on tanders_payment_checks;
create policy tanders_payment_checks_select on tanders_payment_checks for select to authenticated
  using (store_id in (select auth_store_ids()));

-- Tabla nueva en `public`: revocar explícitamente lo que no se quiere conceder
-- (ver 5m del DEPLOY — las default privileges de Supabase conceden de más).
revoke all on tanders_payment_checks from anon, authenticated;
grant select on tanders_payment_checks to authenticated;
grant all privileges on tanders_payment_checks to service_role;

comment on table tanders_payment_checks is
  'Comprobaciones de la constancia de pago de entregas Tanders: qué leyó el lector y por qué se aceptó o rechazó.';
