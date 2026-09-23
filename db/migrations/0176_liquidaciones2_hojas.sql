-- ============================================================================
-- 0184_liquidaciones2_hojas.sql — Liquidaciones 2: dominios, hojas, columnas
-- configurables, equivalencias de estado y observaciones de cuadre.
--
-- DE DÓNDE VIENE. La operación llevaba el cierre de Lima en un Google Sheet
-- («MASTER KEY 2.0»): una hoja por motorizado, una por courier, dos hojas
-- consolidadas por tienda con una columna por repartidor y un resolver de
-- estatus en 400 mil COUNTIFS. El cruce del 16-09-2026 contra esta base dijo
-- dos cosas: los pedidos y montos de Shopify coinciden casi al 100 %, pero de
-- los 4.764 pedidos que los motorizados marcaron entregados en la hoja, Kapta
-- no tenía NINGUNO como entregado por motorizado (rutas casi sin uso: 2 rutas,
-- 1 parada). Y al revés: 2.563 entregas de Provincia que Kapta sí conoce por
-- las APIs de Aliclik, Shalom y Tanders estaban «Pendiente» en la hoja. Lima
-- vive en la hoja; Provincia vive en Kapta. Liquidaciones 2 junta las dos.
--
-- LA IDEA, en tres piezas:
--   * DOMINIO: el grupo que define el contrato — clave de fila (pedido, guía,
--     punto de ruta, valor de catálogo), vocabulario de estados y su
--     equivalente en Kapta. Reparto propio, Courier externo, Consolidado…
--   * HOJA: una instancia del dominio (Roy, Aliclik Lima, Revisar Aurela).
--     Hereda la plantilla de columnas del dominio y puede añadir columnas
--     manuales propias. No puede romper el contrato.
--   * COLUMNA: cuatro tipos y nada más. `campo` lee del pedido (solo lectura),
--     `manual` se teclea, `lookup` busca en otra hoja, `derivada` aplica una
--     regla con nombre (el resolver de estatus, la zona, el mes). No hay motor
--     de fórmulas: lo que en la hoja era COUNTIFS por fila aquí es una regla.
--
-- ESTADOS. Cada dominio tiene su lista cerrada de estados; cada estado mapea a
-- un estado OPERATIVO de Kapta (el general se deriva de ahí, lib/order-status)
-- y declara su efecto: `informa`, `entrega`, `devolucion` o `anulacion`. Un
-- valor que llega y no está en la lista NO se inventa: se guarda literal como
-- alias sin equivalente y la fila queda a revisión — la regla que ya aplica
-- Tanders (MOM §9.4). Mapear a `entrega` no cierra el pedido por sí solo: crea
-- la propuesta con la evidencia de la fila y el cierre pasa por la puerta
-- única a entregado (MOM §11.4).
--
-- OBSERVACIONES. Cuando un valor externo no coincide con el de Kapta (monto,
-- estado, pedido) se abre una observación con los dos valores, la diferencia y
-- un motivo del catálogo. Nadie la resuelve sin motivo. Es la entidad que
-- faltaba: las correcciones de liquidación (0093) solo cubren monto/comisión
-- dentro de un lote, y las bitácoras (order_events, ingest_anomalies) no
-- explican una diferencia.
--
-- HISTORIAL. Cada celda manual deja rastro en `sheet_cell_history`, que es
-- APPEND-ONLY con el mismo patrón que order_events (0053): authenticated solo
-- lee; service_role lee e inserta; nadie actualiza ni borra.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- Dominios
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists sheet_domains (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  key          text not null,
  name         text not null,
  -- Qué identifica una fila dentro de las hojas del dominio.
  row_key      text not null check (row_key in ('pedido', 'guia', 'punto', 'valor', 'periodo')),
  description  text,
  position     integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, key)
);

-- Vocabulario de estados del dominio y su equivalente en Kapta.
create table if not exists sheet_domain_statuses (
  id                  uuid primary key default gen_random_uuid(),
  domain_id           uuid not null references sheet_domains(id) on delete cascade,
  code                text not null,
  label               text not null,
  -- Estado operativo de Kapta (lib/order-status.ts OPERATIONAL_STATUSES).
  operational_status  text not null,
  -- Qué hace sobre el pedido: `informa` no cierra nada; `entrega` y
  -- `devolucion` proponen el cierre; `anulacion` es del courier y NO anula el
  -- pedido Shopify (MOM §9.4).
  effect              text not null default 'informa'
                        check (effect in ('informa', 'entrega', 'devolucion', 'anulacion')),
  position            integer not null default 0,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (domain_id, code)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Hojas y columnas
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists sheets (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  domain_id   uuid not null references sheet_domains(id) on delete cascade,
  -- Tienda a la que pertenece la hoja cuando el dominio es por tienda
  -- (Pedidos, Consolidado). Null para catálogos y hojas de repartidor.
  store_id    uuid references stores(id) on delete cascade,
  key         text not null,
  name        text not null,
  position    integer not null default 0,
  active      boolean not null default true,
  -- Configuración libre de la hoja: filtros por defecto, mapeo de importación…
  config      jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, key)
);
create index if not exists sheets_domain_idx on sheets(domain_id, position);
create index if not exists sheets_store_idx on sheets(store_id) where store_id is not null;

create table if not exists sheet_columns (
  id          uuid primary key default gen_random_uuid(),
  sheet_id    uuid not null references sheets(id) on delete cascade,
  key         text not null,
  label       text not null,
  kind        text not null check (kind in ('campo', 'manual', 'lookup', 'derivada')),
  data_type   text not null default 'text'
                check (data_type in ('text', 'number', 'date', 'select', 'boolean', 'status')),
  -- `campo`: {"field": "order_total"}; `lookup`: {"sheet": "catalogo_zonas",
  -- "match": "distrito", "by": "district", "return": "zona"}; `derivada`:
  -- {"rule": "estatus_consolidado"}. Lo interpreta lib/sheets/engine.ts.
  source      jsonb not null default '{}'::jsonb,
  -- Opciones de un `select`, en orden.
  options     jsonb not null default '[]'::jsonb,
  position    integer not null default 0,
  width       integer,
  visible     boolean not null default true,
  pinned      boolean not null default false,
  required    boolean not null default false,
  -- Una columna de plantilla la define el dominio; una local la añadió la hoja.
  from_template boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (sheet_id, key)
);
create index if not exists sheet_columns_sheet_idx on sheet_columns(sheet_id, position);

-- ─────────────────────────────────────────────────────────────────────────────
-- Filas, celdas e historial
-- ─────────────────────────────────────────────────────────────────────────────
-- Una fila guarda SOLO los valores manuales e importados. Los `campo` se leen
-- del pedido en cada consulta y los `derivada`/`lookup` se calculan: así un
-- cambio en el Master se ve en la hoja sin recalcular nada.
create table if not exists sheet_rows (
  id               uuid primary key default gen_random_uuid(),
  sheet_id         uuid not null references sheets(id) on delete cascade,
  order_id         uuid references orders(id) on delete set null,
  -- Clave según el dominio: nº de pedido, guía, «fecha#punto», valor de catálogo.
  row_key          text not null,
  values           jsonb not null default '{}'::jsonb,
  source           text not null default 'manual'
                     check (source in ('manual', 'importacion', 'sincronizacion')),
  import_batch_id  uuid,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (sheet_id, row_key)
);
create index if not exists sheet_rows_order_idx on sheet_rows(order_id) where order_id is not null;

create table if not exists sheet_cell_history (
  id              uuid primary key default gen_random_uuid(),
  row_id          uuid not null references sheet_rows(id) on delete cascade,
  column_key      text not null,
  previous_value  jsonb,
  new_value       jsonb,
  reason          text,
  actor           uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists sheet_cell_history_row_idx on sheet_cell_history(row_id, created_at desc);

-- Alias de importación por hoja: lo que escribe la gente o trae el archivo,
-- normalizado (mayúsculas, sin acentos), y a qué estado del dominio equivale.
-- `status_code` null = alias visto y todavía sin equivalente: la fila queda a
-- revisión hasta que alguien lo asigne desde la configuración.
create table if not exists sheet_status_aliases (
  id           uuid primary key default gen_random_uuid(),
  sheet_id     uuid not null references sheets(id) on delete cascade,
  alias        text not null,
  status_code  text,
  seen_count   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (sheet_id, alias)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Observaciones de cuadre
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists sheet_observation_reasons (
  code         text primary key,
  label        text not null,
  description  text,
  position     integer not null default 0
);

insert into sheet_observation_reasons (code, label, description, position) values
  ('descuento_en_puerta',    'Descuento en puerta',            'El motorizado cobró menos porque la clienta negoció al recibir.', 10),
  ('cobro_parcial_adelanto', 'Cobro parcial: hubo adelanto',   'Parte del monto ya se pagó por Yape/Plin antes de la entrega.', 20),
  ('producto_adicional',     'Producto adicional o faltante',  'Se entregó un producto de más o de menos respecto al pedido.', 30),
  ('redondeo_courier',       'Redondeo del courier',           'Diferencia de céntimos por cómo redondea el reporte del courier.', 40),
  ('delivery_aparte',        'Delivery cobrado aparte',        'El costo de envío se cobró como línea separada.', 50),
  ('anulado_tras_entrega',   'Anulado en Shopify tras entregar', 'El pedido figura anulado en Shopify pero el repartidor lo entregó.', 60),
  ('error_transcripcion',    'Error de transcripción',         'El valor de la hoja está mal tecleado o mal leído.', 70),
  ('estado_sin_equivalente', 'Estado sin equivalente',         'El estado reportado no está en el vocabulario del dominio.', 80),
  ('pedido_no_encontrado',   'Pedido no encontrado',           'El código de la fila no corresponde a ningún pedido de Kapta.', 90),
  ('otro',                   'Otro',                           'Motivo explicado en la nota.', 100)
on conflict (code) do nothing;

create table if not exists sheet_observations (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  sheet_id         uuid not null references sheets(id) on delete cascade,
  row_id           uuid references sheet_rows(id) on delete set null,
  order_id         uuid references orders(id) on delete set null,
  -- Qué se comparó: `monto`, `estado`, `pedido`, `courier`…
  field            text not null,
  external_value   text,
  kapta_value      text,
  difference       numeric(12, 2),
  reason_code      text references sheet_observation_reasons(code),
  note             text,
  status           text not null default 'abierta' check (status in ('abierta', 'resuelta')),
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  resolved_by      uuid references auth.users(id) on delete set null,
  resolved_at      timestamptz,
  resolution_note  text,
  -- Resolver exige motivo: es la regla de la entidad.
  constraint sheet_observations_resolved_has_reason
    check (status <> 'resuelta' or (reason_code is not null and resolved_at is not null))
);
create index if not exists sheet_observations_open_idx on sheet_observations(org_id, status, created_at desc);
create index if not exists sheet_observations_sheet_idx on sheet_observations(sheet_id, status);
create index if not exists sheet_observations_order_idx on sheet_observations(order_id) where order_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS. Lectura para miembros de la organización; escritura para owner/admin.
-- Las ediciones de celda y las observaciones pasan por server actions con el
-- service role y sus propias comprobaciones de permiso (sheets.edit).
-- ─────────────────────────────────────────────────────────────────────────────
alter table sheet_domains            enable row level security;
alter table sheet_domain_statuses    enable row level security;
alter table sheets                   enable row level security;
alter table sheet_columns            enable row level security;
alter table sheet_rows               enable row level security;
alter table sheet_cell_history       enable row level security;
alter table sheet_status_aliases     enable row level security;
alter table sheet_observation_reasons enable row level security;
alter table sheet_observations       enable row level security;

drop policy if exists sheet_domains_select on sheet_domains;
create policy sheet_domains_select on sheet_domains for select to authenticated
  using (org_id in (select auth_org_ids()));
drop policy if exists sheet_domains_write on sheet_domains;
create policy sheet_domains_write on sheet_domains for all to authenticated
  using (org_id in (select auth_admin_org_ids()))
  with check (org_id in (select auth_admin_org_ids()));

drop policy if exists sheet_domain_statuses_select on sheet_domain_statuses;
create policy sheet_domain_statuses_select on sheet_domain_statuses for select to authenticated
  using (domain_id in (select id from sheet_domains where org_id in (select auth_org_ids())));
drop policy if exists sheet_domain_statuses_write on sheet_domain_statuses;
create policy sheet_domain_statuses_write on sheet_domain_statuses for all to authenticated
  using (domain_id in (select id from sheet_domains where org_id in (select auth_admin_org_ids())))
  with check (domain_id in (select id from sheet_domains where org_id in (select auth_admin_org_ids())));

drop policy if exists sheets_select on sheets;
create policy sheets_select on sheets for select to authenticated
  using (org_id in (select auth_org_ids()));
drop policy if exists sheets_write on sheets;
create policy sheets_write on sheets for all to authenticated
  using (org_id in (select auth_admin_org_ids()))
  with check (org_id in (select auth_admin_org_ids()));

drop policy if exists sheet_columns_select on sheet_columns;
create policy sheet_columns_select on sheet_columns for select to authenticated
  using (sheet_id in (select id from sheets where org_id in (select auth_org_ids())));
drop policy if exists sheet_columns_write on sheet_columns;
create policy sheet_columns_write on sheet_columns for all to authenticated
  using (sheet_id in (select id from sheets where org_id in (select auth_admin_org_ids())))
  with check (sheet_id in (select id from sheets where org_id in (select auth_admin_org_ids())));

drop policy if exists sheet_rows_select on sheet_rows;
create policy sheet_rows_select on sheet_rows for select to authenticated
  using (sheet_id in (select id from sheets where org_id in (select auth_org_ids())));
drop policy if exists sheet_rows_write on sheet_rows;
create policy sheet_rows_write on sheet_rows for all to authenticated
  using (sheet_id in (select id from sheets where org_id in (select auth_admin_org_ids())))
  with check (sheet_id in (select id from sheets where org_id in (select auth_admin_org_ids())));

drop policy if exists sheet_cell_history_select on sheet_cell_history;
create policy sheet_cell_history_select on sheet_cell_history for select to authenticated
  using (row_id in (
    select r.id from sheet_rows r join sheets s on s.id = r.sheet_id
     where s.org_id in (select auth_org_ids())
  ));

drop policy if exists sheet_status_aliases_select on sheet_status_aliases;
create policy sheet_status_aliases_select on sheet_status_aliases for select to authenticated
  using (sheet_id in (select id from sheets where org_id in (select auth_org_ids())));
drop policy if exists sheet_status_aliases_write on sheet_status_aliases;
create policy sheet_status_aliases_write on sheet_status_aliases for all to authenticated
  using (sheet_id in (select id from sheets where org_id in (select auth_admin_org_ids())))
  with check (sheet_id in (select id from sheets where org_id in (select auth_admin_org_ids())));

drop policy if exists sheet_observation_reasons_select on sheet_observation_reasons;
create policy sheet_observation_reasons_select on sheet_observation_reasons for select to authenticated
  using (true);

drop policy if exists sheet_observations_select on sheet_observations;
create policy sheet_observations_select on sheet_observations for select to authenticated
  using (org_id in (select auth_org_ids()));
drop policy if exists sheet_observations_write on sheet_observations;
create policy sheet_observations_write on sheet_observations for all to authenticated
  using (org_id in (select auth_admin_org_ids()))
  with check (org_id in (select auth_admin_org_ids()));

-- Append-only, mismo patrón que order_events (0053).
revoke all on sheet_cell_history from anon, authenticated, service_role;
grant select         on sheet_cell_history to authenticated;
grant select, insert on sheet_cell_history to service_role;

-- El catálogo de motivos es dato de aplicación: nadie lo edita desde la UI.
revoke all on sheet_observation_reasons from anon, authenticated;
grant select on sheet_observation_reasons to authenticated;
