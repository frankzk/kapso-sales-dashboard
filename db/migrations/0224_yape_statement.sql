-- 0224_yape_statement.sql — el estado de cuenta de Yape Empresa, y los
-- comprobantes que se validan solos al cruzarlo (MOM §16.2).
--
-- POR QUÉ. «Validar pagos» pedía una persona para cada comprobante porque el
-- lector valida UNA IMAGEN, no un depósito (0158): faltaba conexión con el
-- estado de cuenta. El reporte de movimientos que Yape manda por correo
-- («Te compartimos tus movimientos», desde notificaciones@yape.pe) ES esa
-- conexión. Un escenario de Make lo reenvía a /api/webhooks/yape-movements,
-- que guarda cada movimiento aquí y valida los comprobantes que coinciden con
-- uno sin margen de duda: mismo monto, mismo minuto y la clienta como pagadora
-- (o, en el cobro del courier, el mismo canal), y nadie más lo reclama.
--
-- El 04-10-2026, a mano, el primer reporte cuadró 66 de 87 comprobantes.
--
-- TRES TABLAS:
--   · `yape_statement_imports`: cada reporte recibido y lo que se hizo con él.
--   · `yape_statement_movements`: cada movimiento, UNA vez. Los reportes se
--     solapan (cada uno trae dos semanas), así que la llave es la huella de la
--     fila: el mismo movimiento en dos reportes es la misma fila.
--   · `yape_statement_matches`: qué movimiento concilió qué comprobante. Los
--     dos únicos: un movimiento paga UN comprobante y un comprobante se
--     concilia con UN movimiento. Es la última línea contra cobrar dos pedidos
--     con el mismo dinero.
--
-- Nombres de quien paga y su mensaje: datos personales, solo el servidor
-- (service_role) los lee.

create table if not exists yape_statement_imports (
  id              uuid primary key default gen_random_uuid(),
  message_id      text not null,
  file_name       text not null default '',
  received_at     timestamptz,
  subject         text,
  destination     text,
  period_from     timestamptz,
  period_to       timestamptz,
  movements       integer not null default 0,
  new_movements   integer not null default 0,
  unreadable      integer not null default 0,
  validated       integer not null default 0,
  report          jsonb not null default '{}'::jsonb,
  error           text,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz
);

create index if not exists yape_statement_imports_created_idx
  on yape_statement_imports (created_at desc);

create table if not exists yape_statement_movements (
  movement_key     text primary key,
  kind             text not null check (kind in ('ingreso', 'egreso')),
  origin           text not null,
  destination      text not null,
  -- «YAPE» para un Yape directo; si no, el prefijo de la app («PLIN», «BCP»…).
  channel          text not null,
  payer_name       text not null,
  amount           numeric(12, 2) not null,
  occurred_at      timestamptz not null,
  -- «Datos adicionales»: el mensaje que escribió quien pagó.
  extra            text,
  first_import_id  uuid references yape_statement_imports(id) on delete set null,
  created_at       timestamptz not null default now()
);

create index if not exists yape_statement_movements_time_idx
  on yape_statement_movements (occurred_at);
create index if not exists yape_statement_movements_amount_idx
  on yape_statement_movements (amount, occurred_at);

create table if not exists yape_statement_matches (
  id             uuid primary key default gen_random_uuid(),
  movement_key   text not null unique references yape_statement_movements(movement_key),
  payment_id     uuid not null unique references order_payments(id) on delete cascade,
  order_id       uuid not null references orders(id) on delete cascade,
  store_id       uuid not null references stores(id) on delete cascade,
  import_id      uuid references yape_statement_imports(id) on delete set null,
  -- minuto_y_clienta | minuto_y_clienta_pm | minuto_y_canal (lib/yape-statement/match.ts)
  rule           text not null,
  -- Segundos entre el minuto de la constancia y el movimiento.
  delta_seconds  integer,
  -- false mientras se valida; si la validación no llega a escribirse, la fila
  -- se borra y el movimiento queda libre para la pasada siguiente.
  validated      boolean not null default false,
  created_at     timestamptz not null default now()
);

create index if not exists yape_statement_matches_order_idx
  on yape_statement_matches (order_id);

comment on table yape_statement_imports is
  'Reportes de movimientos de Yape Empresa recibidos por correo (Make → /api/webhooks/yape-movements) y su resultado.';
comment on table yape_statement_movements is
  'Movimientos del estado de cuenta de Yape, uno por fila aunque llegue en varios reportes.';
comment on table yape_statement_matches is
  'Qué movimiento del estado de cuenta concilió qué comprobante. Únicos por movimiento y por comprobante.';

alter table yape_statement_imports enable row level security;
alter table yape_statement_movements enable row level security;
alter table yape_statement_matches enable row level security;
-- RLS sin policy ya deniega, pero Supabase concede por defecto todos los
-- privilegios a anon y authenticated (0053): se quitan, como segunda cerradura.
revoke all on yape_statement_imports   from anon, authenticated;
revoke all on yape_statement_movements from anon, authenticated;
revoke all on yape_statement_matches   from anon, authenticated;
grant all privileges on yape_statement_imports to service_role;
grant all privileges on yape_statement_movements to service_role;
grant all privileges on yape_statement_matches to service_role;
