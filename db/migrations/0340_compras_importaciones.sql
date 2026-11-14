-- ============================================================================
-- 0340_compras_importaciones.sql — «Compras»: importaciones (MOM §45,
-- 14-11-2026). Fases 1 a 3 de docs/compras/referencia-modulo-compras.md §11:
-- la importación con sus productos, documentos, estados e historial; el dinero
-- (costos repartidos, pagos, costo aterrizado, margen) y la recepción en la
-- bodega propia de Kapta en Lima, con sus alertas.
--
-- QUÉ CREA.
--   * `import_suppliers`: el proveedor mínimo (nombre, país, WhatsApp, notas),
--     uno por nombre dentro de la organización. Se da de alta desde el
--     formulario de la importación.
--   * `imports`: la importación. Código `IMP-<año de Lima>-<NNN>` único por
--     organización. Montos en USD; `fx_pen_per_usd` es el tipo de cambio de
--     ESTA importación (soles por 1 USD), opcional hasta «Pasar a Costos».
--   * `import_items`: los productos, con la recepción (`received_qty` nulo =
--     todavía no se contó) y `cost_pushed_at` (ya pasó a Costos).
--   * `import_costs`: los costos a repartir (envío, importación, adicional) y
--     su regla de reparto. Un costo «todo a un producto» cuyo producto se
--     quita NO desaparece (§13.4 de la referencia): `item_id` pasa a nulo y el
--     cálculo lo reparte por valor, con aviso.
--   * `import_payments`, `import_documents`: pagos (USD) y documentos.
--   * `import_events`: el historial. Append-only: no se edita ni se borra.
--   * El bucket privado `import-files` (25 MB; PDF, JPG, PNG, WEBP, XLSX).
--
-- Los valores cerrados van con CHECK en la base (§13.11 de la referencia: allí
-- solo los validaba la aplicación).
--
-- QUIÉN LEE Y ESCRIBE. Solo el servidor (service_role), después de comprobar
-- `purchases.manage` / `purchases.money` en la organización: RLS encendida y
-- SIN políticas, sin privilegios para anon ni authenticated. Así un costo o un
-- pago no se puede leer con la sesión de alguien sin «Montos de compras».
--
-- No cambia datos existentes y no usa `drop` (DEPLOY.md, 0248). Correrla otra
-- vez no cambia nada.
-- ============================================================================

-- ── Proveedores ────────────────────────────────────────────────────────────
create table if not exists public.import_suppliers (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  country     text check (country is null or char_length(country) <= 80),
  whatsapp    text check (whatsapp is null or whatsapp ~ '^\+?[0-9]{6,15}$'),
  notes       text check (notes is null or char_length(notes) <= 1000),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.import_suppliers is
  'Compras (MOM §45): proveedores de las importaciones. Uno por nombre (sin mayúsculas) en la organización. Solo service_role.';

create unique index if not exists import_suppliers_org_name_uniq
  on public.import_suppliers (org_id, lower(btrim(name)));

create or replace trigger import_suppliers_touch before update on public.import_suppliers
  for each row execute function public.touch_updated_at();

-- ── Importaciones ──────────────────────────────────────────────────────────
create table if not exists public.imports (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references public.organizations(id) on delete cascade,
  code                     text not null check (code ~ '^IMP-[0-9]{4}-[0-9]{3,}$'),
  supplier_id              uuid references public.import_suppliers(id) on delete set null,
  origin                   text check (origin is null or char_length(origin) <= 80),
  platform_order           text check (platform_order is null or char_length(platform_order) <= 60),
  transport                text not null default 'courier'
                             check (transport in ('courier', 'air', 'sea', 'land')),
  carrier                  text check (carrier is null or char_length(carrier) <= 60),
  tracking_number          text check (tracking_number is null or char_length(tracking_number) <= 80),
  -- Solo http(s): el enlace se abre desde el panel.
  tracking_url             text check (tracking_url is null or (tracking_url ~* '^https?://' and char_length(tracking_url) <= 500)),
  ordered_on               date,
  eta                      date,
  arrived_on               date,
  status                   text not null default 'cotizacion' check (status in (
                             'cotizacion', 'pagado', 'en_produccion', 'en_transito', 'en_aduana',
                             'en_camino_bodega', 'recibido', 'ingresado', 'cerrado', 'cancelado')),
  -- Soles por 1 USD de ESTA importación. Opcional hasta «Pasar a Costos».
  fx_pen_per_usd           numeric(10, 4) check (fx_pen_per_usd is null or fx_pen_per_usd > 0),
  reported_to_warehouse_at timestamptz,
  reported_by              uuid references auth.users(id) on delete set null,
  notes                    text check (notes is null or char_length(notes) <= 2000),
  created_by               uuid references auth.users(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint imports_code_org_uniq unique (org_id, code),
  -- Para que los hijos no puedan colgar de una importación de otra org.
  constraint imports_id_org_uniq unique (id, org_id)
);

comment on table public.imports is
  'Compras (MOM §45): una importación. Montos en USD; fx_pen_per_usd es su propio tipo de cambio. Solo service_role.';
comment on column public.imports.fx_pen_per_usd is
  'Soles por 1 USD de esta importación. Hace falta para mostrar en soles y para «Pasar a Costos».';

create index if not exists imports_org_status_idx on public.imports (org_id, status, created_at desc);
create index if not exists imports_supplier_idx on public.imports (supplier_id) where supplier_id is not null;

create or replace trigger imports_touch before update on public.imports
  for each row execute function public.touch_updated_at();

-- ── Productos ──────────────────────────────────────────────────────────────
create table if not exists public.import_items (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null,
  import_id       uuid not null,
  store_id        uuid references public.stores(id) on delete set null,
  sku             text check (sku is null or char_length(sku) between 1 and 80),
  name            text not null check (char_length(btrim(name)) between 1 and 200),
  image_path      text,
  qty             integer not null check (qty between 1 and 10000000),
  unit_cost_usd   numeric(14, 4) not null default 0 check (unit_cost_usd >= 0),
  unit_weight_kg  numeric(12, 4) check (unit_weight_kg is null or unit_weight_kg >= 0),
  sale_price_pen  numeric(12, 2) check (sale_price_pen is null or sale_price_pen >= 0),
  -- Recepción. received_qty nulo = todavía no se contó.
  received_qty    integer check (received_qty is null or received_qty between 0 and 10000000),
  damaged_qty     integer check (damaged_qty is null or damaged_qty >= 0),
  reception_note  text check (reception_note is null or char_length(reception_note) <= 300),
  received_at     timestamptz,
  received_by     uuid references auth.users(id) on delete set null,
  -- «Pasar a Costos» (MOM §45): una sola vez por línea.
  cost_pushed_at  timestamptz,
  cost_pushed_by  uuid references auth.users(id) on delete set null,
  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint import_items_import_fk foreign key (import_id, org_id)
    references public.imports (id, org_id) on delete cascade,
  constraint import_items_damaged_needs_received check (damaged_qty is null or received_qty is not null),
  constraint import_items_damaged_le_received check (
    received_qty is null or damaged_qty is null or damaged_qty <= received_qty),
  constraint import_items_id_import_uniq unique (id, import_id)
);

comment on table public.import_items is
  'Compras (MOM §45): productos de una importación, con su recepción y la marca de «Pasar a Costos». Solo service_role.';

create index if not exists import_items_import_idx on public.import_items (import_id, position);
create index if not exists import_items_sku_idx on public.import_items (org_id, sku) where sku is not null;

create or replace trigger import_items_touch before update on public.import_items
  for each row execute function public.touch_updated_at();

-- ── Documentos ─────────────────────────────────────────────────────────────
create table if not exists public.import_documents (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  import_id     uuid not null,
  kind          text not null check (kind in (
                  'proforma', 'invoice', 'packing', 'payment', 'tracking', 'customs', 'photo', 'other')),
  storage_path  text not null unique,
  filename      text check (filename is null or char_length(filename) <= 200),
  mime          text not null check (mime in (
                  'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
  size_bytes    integer not null check (size_bytes between 1 and 26214400),
  uploaded_by   uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint import_documents_import_fk foreign key (import_id, org_id)
    references public.imports (id, org_id) on delete cascade,
  constraint import_documents_id_import_uniq unique (id, import_id)
);

comment on table public.import_documents is
  'Compras (MOM §45): documentos en el bucket privado import-files. Proforma y comprobante de pago solo con «Montos de compras». Solo service_role.';

create index if not exists import_documents_import_idx on public.import_documents (import_id, created_at);

-- ── Costos a repartir ──────────────────────────────────────────────────────
create table if not exists public.import_costs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null,
  import_id   uuid not null,
  kind        text not null check (kind in ('envio', 'importacion', 'adicional')),
  label       text not null check (char_length(btrim(label)) between 1 and 120),
  amount_usd  numeric(14, 2) not null check (amount_usd > 0),
  allocation  text not null default 'value' check (allocation in ('value', 'units', 'weight', 'item')),
  item_id     uuid,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint import_costs_import_fk foreign key (import_id, org_id)
    references public.imports (id, org_id) on delete cascade,
  -- El producto elegido es de la MISMA importación. Si se quita, el costo se
  -- queda (item_id nulo) y el cálculo lo reparte por valor con aviso.
  constraint import_costs_item_fk foreign key (item_id, import_id)
    references public.import_items (id, import_id) on delete set null (item_id),
  constraint import_costs_item_only_for_item check (allocation = 'item' or item_id is null)
);

comment on table public.import_costs is
  'Compras (MOM §45): costos de una importación (USD) con su reparto. Quitar el producto de un costo «a un producto» lo deja con item_id nulo: se reparte por valor, no desaparece. Solo service_role.';

create index if not exists import_costs_import_idx on public.import_costs (import_id, created_at);

-- ── Pagos ──────────────────────────────────────────────────────────────────
create table if not exists public.import_payments (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  import_id    uuid not null,
  amount_usd   numeric(14, 2) not null check (amount_usd > 0),
  paid_on      date not null,
  method       text not null check (method in (
                 'transferencia', 'tarjeta', 'paypal', 'alibaba', 'western_union', 'efectivo', 'otro')),
  note         text check (note is null or char_length(note) <= 300),
  document_id  uuid,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint import_payments_import_fk foreign key (import_id, org_id)
    references public.imports (id, org_id) on delete cascade,
  -- El comprobante es de la misma importación.
  constraint import_payments_document_fk foreign key (document_id, import_id)
    references public.import_documents (id, import_id) on delete set null (document_id)
);

comment on table public.import_payments is
  'Compras (MOM §45): pagos de una importación (USD). Solo service_role.';

create index if not exists import_payments_import_idx on public.import_payments (import_id, paid_on);

-- ── Historial (append-only) ────────────────────────────────────────────────
create table if not exists public.import_events (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null,
  import_id  uuid not null,
  -- status: cambio de estado o nota · producto · dinero (costos, pagos,
  -- montos y documentos con montos: solo con «Montos de compras») · documento
  -- · recepcion · bodega (aviso a la bodega) · costos (pasó a Costos) · datos.
  kind       text not null check (kind in (
               'status', 'nota', 'producto', 'dinero', 'documento', 'recepcion', 'bodega', 'costos', 'datos')),
  status     text check (status is null or status in (
               'cotizacion', 'pagado', 'en_produccion', 'en_transito', 'en_aduana',
               'en_camino_bodega', 'recibido', 'ingresado', 'cerrado', 'cancelado')),
  note       text check (note is null or char_length(note) <= 1000),
  by_user    uuid references auth.users(id) on delete set null,
  at         timestamptz not null default now(),
  constraint import_events_import_fk foreign key (import_id, org_id)
    references public.imports (id, org_id) on delete cascade,
  constraint import_events_status_kind check (status is null or kind = 'status')
);

comment on table public.import_events is
  'Compras (MOM §45): historial de cada importación. Append-only: ni se edita ni se borra. Solo service_role.';

create index if not exists import_events_import_idx on public.import_events (import_id, at desc);

create or replace trigger import_events_append_only before update or delete on public.import_events
  for each row execute function public.reject_mutation();

-- ── Solo el servidor ───────────────────────────────────────────────────────
-- Supabase concede todo a los tres roles al crear la tabla: sin el revoke, la
-- RLS sin políticas seguiría siendo la única barrera.
alter table public.import_suppliers enable row level security;
alter table public.imports          enable row level security;
alter table public.import_items     enable row level security;
alter table public.import_documents enable row level security;
alter table public.import_costs     enable row level security;
alter table public.import_payments  enable row level security;
alter table public.import_events    enable row level security;

revoke all on public.import_suppliers, public.imports, public.import_items, public.import_documents,
  public.import_costs, public.import_payments from anon, authenticated;
grant all privileges on public.import_suppliers, public.imports, public.import_items, public.import_documents,
  public.import_costs, public.import_payments to service_role;

-- El historial: el servidor lo lee y agrega; no lo cambia (tampoco truncate).
revoke all on public.import_events from anon, authenticated, service_role;
grant select, insert on public.import_events to service_role;

-- ── Bucket privado ─────────────────────────────────────────────────────────
-- En Supabase existe `storage.buckets`; en una base sin Storage (la de pruebas)
-- se salta. El código también lo crea si falta (privado).
do $bucket$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('import-files', 'import-files', false, 26214400, array[
      'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
    on conflict (id) do nothing;
  end if;
end
$bucket$;
