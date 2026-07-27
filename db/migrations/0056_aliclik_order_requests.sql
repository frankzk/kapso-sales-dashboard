-- ============================================================================
-- 0056_aliclik_order_requests.sql — registro de intención de creación.
--
-- POR QUÉ EXISTE ESTA TABLA. Crear un pedido en Aliclik es una escritura hacia
-- afuera, irreversible, con ventanas de cancelación estrictas — y la API NO
-- tiene idempotency key. Sin protección propia:
--   * un doble clic crea DOS pedidos reales;
--   * dos operadoras sobre el mismo pedido crean DOS pedidos reales;
--   * un timeout de red deja al equipo sin saber si el pedido existe o no
--     (Aliclik pudo haberlo creado igual), y el reintento crea el segundo.
--
-- La fila se escribe ANTES del POST. El índice único parcial es el candado: dos
-- intentos vivos sobre el mismo pedido chocan en la base (23505) en lugar de
-- convertirse en dos guías. Es el mismo criterio que `createDirectFenixGuide`
-- aplica al rechazar un pedido que ya tiene guía activa.
--
-- `status = 'failed'` queda FUERA del único a propósito: un intento que falló
-- de verdad debe poder reintentarse. Los 'pending' NO se excluyen — un pending
-- es justamente el caso peligroso (¿se creó o no?), y lo resuelve el cron de
-- reconciliación buscando el pedido huérfano por teléfono, no un reintento a
-- ciegas.
--
-- Aplicar DESPUÉS de supabase/policies.sql.
-- ============================================================================

create table if not exists aliclik_order_requests (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references stores(id) on delete cascade,
  order_id     uuid not null references orders(id) on delete cascade,
  modality     text not null check (modality in ('cod', 'agency')),
  -- pending  → escrito antes del POST; no sabemos el resultado
  -- sent     → 201 recibido, tenemos orderNumber
  -- failed   → la API rechazó; se puede reintentar
  -- duplicate→ el guard detectó que ya existía
  status       text not null default 'pending'
                 check (status in ('pending', 'sent', 'failed', 'duplicate')),
  order_number text,
  -- El cuerpo enviado, ya redactado (sin la clave de recojo). Sirve para
  -- reportar una incidencia a Aliclik: su soporte pide request y response.
  request      jsonb not null default '{}'::jsonb,
  response     jsonb,
  http_status  integer,
  error        text,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

-- EL CANDADO. Un solo intento vivo por pedido.
create unique index if not exists aliclik_order_requests_live_uniq
  on aliclik_order_requests(order_id)
  where status <> 'failed';

create index if not exists aliclik_order_requests_store_idx
  on aliclik_order_requests(store_id, created_at desc);
-- Para que el cron encuentre los huérfanos: intentos que quedaron en 'pending'.
create index if not exists aliclik_order_requests_pending_idx
  on aliclik_order_requests(store_id, created_at)
  where status = 'pending';

alter table aliclik_order_requests enable row level security;

drop policy if exists aliclik_order_requests_select on aliclik_order_requests;
create policy aliclik_order_requests_select on aliclik_order_requests for select to authenticated
  using (store_id in (select auth_store_ids()));

revoke all on aliclik_order_requests from anon, authenticated, service_role;
grant select         on aliclik_order_requests to authenticated;
grant all privileges on aliclik_order_requests to service_role;

comment on table aliclik_order_requests is
  'Intención de creación en Aliclik, escrita ANTES del POST. El único parcial impide dos guías por pedido.';
