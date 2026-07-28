-- ============================================================================
-- 0049_yape_payments.sql — validación de los pagos Yape y clave de recojo de
-- los envíos por Shalom.
--
-- El proceso real: el cliente paga un ADELANTO para que el pedido se despache y,
-- antes de recibir la clave con la que recoge el paquete en la agencia, paga la
-- DIFERENCIA. La clave es la llave del paquete: si se entrega antes de cobrar,
-- el dinero se pierde.
--
-- De ahí las tres cosas que esta migración hace cumplir a nivel de base de datos:
--
--  1. UN COMPROBANTE, UN PAGO. Un mismo Yape no puede registrarse dos veces, ni
--     asociarse a dos pedidos, ni servir de adelanto y de diferencia a la vez, ni
--     volver a subirse desde otra tienda o por otro usuario. Se garantiza con
--     índices únicos GLOBALES (no por tienda) sobre el nº de operación y sobre la
--     huella del archivo.
--  2. LA CLAVE VA CIFRADA. `pickup_key_enc` guarda AES-256-GCM (lib/crypto.ts,
--     la misma ENCRYPTION_KEY que cifra los tokens de tienda). Nunca hay texto
--     plano en la base. La tabla NO tiene policy de select para `authenticated`:
--     RLS activo sin policy = denegado. La clave solo sale por un server action
--     que comprueba permisos y condiciones.
--  3. VER LA CLAVE DEJA RASTRO IMBORRABLE. `pickup_key_views` es append-only,
--     como `order_events` (0045): quién la vio, cuándo, con qué pagos validados.
--
-- Aplicar DESPUÉS de supabase/policies.sql (usa auth_store_ids()).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- order_payments — un comprobante Yape, atado a UN pedido
-- ----------------------------------------------------------------------------

create table if not exists order_payments (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references stores(id) on delete cascade,
  order_id          uuid not null references orders(id) on delete cascade,
  kind              text not null check (kind in ('adelanto', 'diferencia')),
  amount            numeric(12, 2),
  -- Identificador natural del pago. Único en TODO el sistema cuando existe.
  operation_number  text,
  -- Fecha y hora exactas del movimiento, tal como aparecen en el comprobante.
  paid_at           timestamptz,
  payer_name        text,
  payer_phone       text,
  -- Imagen del comprobante en el bucket privado `yape-vouchers`.
  file_path         text,
  file_type         text,
  -- Huella del archivo: detecta la misma imagen re-subida con otro nombre.
  file_sha256       text,
  validation_status text not null default 'pendiente_revision'
                      check (validation_status in (
                        'pendiente_revision',
                        'validado',
                        'rechazado',
                        'posible_duplicado',
                        'info_incompleta',
                        'revision_admin'
                      )),
  registered_by     uuid references auth.users(id) on delete set null,
  registered_at     timestamptz not null default now(),
  validated_by      uuid references auth.users(id) on delete set null,
  validated_at      timestamptz,
  notes             text,
  -- Qué vio el lector de comprobantes (lib/vision.ts) en la imagen: auditoría de
  -- por qué el sistema aceptó o dudó del comprobante.
  vision            jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Un pago rechazado deja de ocupar su sitio: pudo ser un error de carga, y su nº
-- de operación o su archivo tienen que poder volver a usarse en el pedido
-- correcto. Por eso los tres índices son PARCIALES.
create unique index if not exists order_payments_operation_uniq
  on order_payments(operation_number)
  where operation_number is not null and validation_status <> 'rechazado';

create unique index if not exists order_payments_file_uniq
  on order_payments(file_sha256)
  where file_sha256 is not null and validation_status <> 'rechazado';

-- Un solo adelanto y una sola diferencia vivos por pedido.
create unique index if not exists order_payments_kind_uniq
  on order_payments(order_id, kind)
  where validation_status <> 'rechazado';

create index if not exists order_payments_order_idx on order_payments(order_id);
create index if not exists order_payments_store_idx on order_payments(store_id, validation_status);
-- Búsqueda de posibles duplicados por coincidencia difusa (monto + fecha).
create index if not exists order_payments_fuzzy_idx on order_payments(amount, paid_at);

alter table order_payments enable row level security;

drop policy if exists order_payments_select on order_payments;
create policy order_payments_select on order_payments for select to authenticated
  using (store_id in (select auth_store_ids()));

grant select on order_payments to authenticated;
grant all privileges on order_payments to service_role;

drop trigger if exists order_payments_touch on order_payments;
create trigger order_payments_touch before update on order_payments
  for each row execute function public.touch_updated_at();

comment on column order_payments.operation_number is
  'Nº de operación del Yape. Único en todo el sistema: es lo que detecta un mismo comprobante recortado.';
comment on column order_payments.file_sha256 is
  'Huella del archivo: detecta la misma imagen re-subida con otro nombre.';

-- ----------------------------------------------------------------------------
-- shalom_pickup_keys — la clave, cifrada y sin lectura directa
-- ----------------------------------------------------------------------------

create table if not exists shalom_pickup_keys (
  order_id     uuid primary key references orders(id) on delete cascade,
  store_id     uuid not null references stores(id) on delete cascade,
  -- AES-256-GCM (lib/crypto.ts). NUNCA texto plano.
  key_enc      text not null,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  replaced_at  timestamptz,
  replaced_by  uuid references auth.users(id) on delete set null
);

alter table shalom_pickup_keys enable row level security;

-- SIN policy de select: RLS activo y sin policy = nadie con rol `authenticated`
-- puede leer esta tabla, ni siquiera un administrador. La clave solo se obtiene
-- a través del server action, que comprueba permisos y deja auditoría. Tampoco
-- se otorga `select` al rol authenticated, por si algún día se añadiera una
-- policy por error.
grant all privileges on shalom_pickup_keys to service_role;

-- ----------------------------------------------------------------------------
-- pickup_key_views — quién vio la clave. APPEND-ONLY.
-- ----------------------------------------------------------------------------

create table if not exists pickup_key_views (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references stores(id) on delete cascade,
  order_id       uuid not null references orders(id) on delete cascade,
  user_id        uuid references auth.users(id) on delete set null,
  viewed_at      timestamptz not null default now(),
  ip             text,
  user_agent     text,
  reason         text,
  -- Estado de los dos pagos EN EL MOMENTO de mostrarla: sin esto no se puede
  -- responder "¿ya estaban ambos validados cuando la vio?".
  payment_state  jsonb not null default '{}'::jsonb,
  -- true cuando un administrador la mostró saltándose alguna condición.
  override       boolean not null default false
);

create index if not exists pickup_key_views_order_idx on pickup_key_views(order_id, viewed_at desc);
create index if not exists pickup_key_views_user_idx  on pickup_key_views(user_id, viewed_at desc);

alter table pickup_key_views enable row level security;

drop policy if exists pickup_key_views_select on pickup_key_views;
create policy pickup_key_views_select on pickup_key_views for select to authenticated
  using (store_id in (select auth_store_ids()));

-- "La visualización de la clave no deberá poder eliminarse del historial."
grant select on pickup_key_views to authenticated;
grant select, insert on pickup_key_views to service_role;

drop trigger if exists pickup_key_views_append_only on pickup_key_views;
create trigger pickup_key_views_append_only before update or delete on pickup_key_views
  for each row execute function public.reject_mutation();

-- ----------------------------------------------------------------------------
-- pickup_key_shares — cuándo se le entregó la clave al cliente
-- ----------------------------------------------------------------------------

create table if not exists pickup_key_shares (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references stores(id) on delete cascade,
  order_id   uuid not null references orders(id) on delete cascade,
  shared_by  uuid references auth.users(id) on delete set null,
  shared_at  timestamptz not null default now(),
  channel    text not null default 'whatsapp',  -- whatsapp | llamada | mensaje | otro
  confirmed  boolean not null default false,
  note       text
);

create index if not exists pickup_key_shares_order_idx on pickup_key_shares(order_id, shared_at desc);

alter table pickup_key_shares enable row level security;

drop policy if exists pickup_key_shares_select on pickup_key_shares;
create policy pickup_key_shares_select on pickup_key_shares for select to authenticated
  using (store_id in (select auth_store_ids()));

grant select on pickup_key_shares to authenticated;
grant select, insert on pickup_key_shares to service_role;

-- ----------------------------------------------------------------------------
-- user_permissions — concesiones y revocaciones puntuales (§16)
-- ----------------------------------------------------------------------------

create table if not exists user_permissions (
  user_id    uuid not null references auth.users(id) on delete cascade,
  org_id     uuid not null references organizations(id) on delete cascade,
  permission text not null,
  -- false = revocado aunque el rol lo conceda. Gana siempre sobre el rol.
  granted    boolean not null default true,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, org_id, permission)
);

alter table user_permissions enable row level security;

drop policy if exists user_permissions_select on user_permissions;
create policy user_permissions_select on user_permissions for select to authenticated
  using (user_id = auth.uid() or org_id in (select auth_admin_org_ids()));

grant select on user_permissions to authenticated;
grant all privileges on user_permissions to service_role;

-- ----------------------------------------------------------------------------
-- Indicadores de pago y clave en el Master (§"Información visible en el Master")
-- ----------------------------------------------------------------------------

alter table order_master
  -- sin_pago | adelanto_pendiente | adelanto_cargado | adelanto_validado
  -- | diferencia_pendiente | diferencia_cargada | pago_completo | posible_duplicado
  add column if not exists payment_state text,
  -- sin_clave | clave_bloqueada | clave_disponible | clave_enviada
  add column if not exists key_state     text;

create index if not exists order_master_payment_idx
  on order_master(store_id, payment_state) where payment_state is not null;
