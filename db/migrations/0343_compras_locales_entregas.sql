-- ============================================================================
-- 0343_compras_locales_entregas.sql — «Compras»: compras LOCALES a laboratorios
-- y maquilas (en soles), unidades de CORTESÍA y ENTREGAS PARCIALES con foto
-- (MOM §45.12–§45.14, decisión del owner del 14-11-2026: «cuando nos llegue la
-- mercadería poder hacer los cruces parciales con foto y evidencia de lo que
-- llega, y también subir la captura de lo que le pagamos al laboratorio»).
--
-- QUÉ CAMBIA.
--   * `imports.kind`: 'importacion' (default: todas las filas de antes) |
--     'local'. El código va por tipo: `IMP-AAAA-NNN` la importación y
--     `LOC-AAAA-NNN` la compra local (CHECK `imports_code_kind_ck`; los `IMP-`
--     de antes lo cumplen tal cual).
--   * `imports.proforma_number` (nulo, hasta 80 caracteres): el código de la
--     proforma invoice. Con la guía de envío (`tracking_number`) y la orden de
--     Alibaba (`platform_order`) son los tres «códigos de trazabilidad» de una
--     importación (decisión del owner del 14-11-2026, MOM §45.15); la app los
--     pide para avanzar de estado. Las filas de antes quedan nulas.
--   * `imports.status` e `import_events.status`: el estado nuevo
--     'recibido_parcial' («Recibido parcial», entre «En camino a bodega» y
--     «Recibido»).
--   * `import_items`: el costo por unidad EN SOLES de una compra local
--     (`unit_cost_currency` USD | PEN, default USD, y `unit_cost_pen`), con el
--     CHECK `import_items_unit_cost_ck`: exactamente un costo, el de su moneda
--     (como los costos y pagos de la 0342). `unit_cost_usd` deja de ser NOT
--     NULL (una fila en soles lo tiene nulo); sigue con su default 0 y su CHECK
--     ≥ 0, así que las filas de antes (USD) quedan correctas sin tocarlas. Y
--     `courtesy_qty` (entero ≥ 0, default 0): las unidades que el laboratorio
--     regala; no suben ningún monto.
--   * `import_deliveries` + `import_delivery_lines`: cada entrega (fecha de
--     Lima, quién, nota) y, por producto que llegó, recibidas, dañadas y nota.
--     Llaves foráneas compuestas como en la 0340: una entrega no cuelga de una
--     importación de otra organización, una línea no cuelga de una entrega de
--     otra importación ni de un producto de otra importación. Un producto con
--     entregas no se puede borrar (la línea lo impide: `no action`); la app lo
--     dice antes.
--   * `import_documents.delivery_id` (nulo): la foto de una entrega es un
--     documento de tipo 'photo' ligado a ella (CHECK: solo fotos). Quitar la
--     entrega deja la foto en Documentos (`on delete set null`): la evidencia
--     no se pierde.
--   * `import_costs.igv_treatment` ('neto' | 'con_igv' | 'inafecto', default
--     'neto'; MOM §45.3, decisión del owner del 14-11-2026: hay costos que no
--     llevan IGV, como el flete internacional). Backfill: `includes_igv` →
--     'con_igv', el resto 'neto' (el default). CHECK
--     `import_costs_igv_treatment_matches_ck`: 'con_igv' ⇔ `includes_igv` (las
--     reglas de `gross_amount` de la 0342 siguen igual). Para que el código
--     anterior (que solo escribe `includes_igv`) no choque con ese CHECK
--     mientras sale el nuevo, el trigger `import_costs_igv_treatment_fill`
--     pone 'con_igv' a una fila que llega con `includes_igv` y el default.
--   * Los TOTALES de cada producto (`import_items.received_qty`,
--     `damaged_qty`, `reception_note`, `received_at`, `received_by`) pasan a ser
--     la SUMA de sus entregas. Siguen siendo columnas guardadas —todo el código
--     y los reportes las leen igual— y las mantiene el trigger
--     `import_delivery_lines_sync` en la MISMA transacción en que se escribe,
--     corrige o borra una línea (también por cascada). Bloquea la fila del
--     producto antes de sumar, así dos entregas a la vez no se pisan. Un
--     producto sin ninguna entrega queda con sus totales nulos («sin contar»).
--
-- EL BACKFILL (la opción conservadora). Antes de la 0343 la recepción era un
-- solo formulario que escribía los totales directo en `import_items`. Para que
-- la regla «total = Σ entregas» valga también para esas filas SIN cambiar sus
-- números, por cada importación con algún producto ya contado
-- (`received_qty` no nulo) y sin ninguna línea de entrega se crea UNA entrega
-- marcada `legacy` («Recepción registrada antes de las entregas parciales»),
-- con la fecha de llegada (o, sin ella, el día de Lima del último conteo) y
-- quien contó, y una línea por producto contado con sus recibidas, dañadas y
-- nota tal cual. Los productos no contados no reciben línea (siguen «sin
-- contar»). No se toca ni una fila de `import_items`: el trigger se crea
-- DESPUÉS del backfill. Se descartó tratar la recepción vieja como «primera
-- entrega» solo en la pantalla: habría dos fuentes de verdad (una columna que
-- no es la suma de nada) y la primera corrección la habría puesto en cero.
-- Idempotente: correrla otra vez no crea nada (solo cubre productos contados
-- sin ninguna línea, y después del backfill no queda ninguno).
--
-- POR QUÉ HAY `drop constraint`. Postgres no deja cambiar la expresión de un
-- CHECK: para admitir `LOC-` y 'recibido_parcial' hay que reemplazar los CHECK
-- en línea de la 0340 (`imports_code_check`, `imports_status_check`,
-- `import_events_status_check`), igual que la 0339. Se buscan por su
-- definición (solo el CHECK de la serie `IMP-` y el de la lista de estados) y
-- se cambian por los nuevos, con nombre, dentro de un bloque que solo corre si
-- el nuevo todavía no existe. No se borra ninguna tabla, columna ni dato; el
-- único otro `drop` es `alter column unit_cost_usd drop not null` (como la
-- 0342), dentro del `alter table`.
--
-- QUIÉN LEE Y ESCRIBE. Como en la 0340: solo el servidor (service_role),
-- después de comprobar el permiso. Las tablas nuevas tienen RLS encendida, SIN
-- políticas y sin privilegios para anon ni authenticated. El historial sigue
-- append-only y sin cambios (las entregas dejan hechos `recepcion`).
--
-- EL ORDEN. Antes del código: el código nuevo lee `kind`, `courtesy_qty`,
-- `unit_cost_currency` y las tablas de entregas. El código anterior sigue
-- funcionando con la migración puesta (crea importaciones `IMP-`, productos en
-- USD y escribe la recepción en `import_items`); por eso el código nuevo debe
-- salir enseguida: una recepción guardada con el código anterior DESPUÉS de la
-- migración no queda como entrega (volver a correr la 0343 la cubre si el
-- producto no tenía ninguna entrega).
-- ============================================================================

-- ── El tipo de compra y su serie de código ─────────────────────────────────
alter table public.imports
  add column if not exists kind text not null default 'importacion'
    constraint imports_kind_ck check (kind in ('importacion', 'local'));

alter table public.imports
  add column if not exists proforma_number text
    constraint imports_proforma_number_len check (proforma_number is null or char_length(btrim(proforma_number)) between 1 and 80);

comment on column public.imports.proforma_number is
  'Compras (MOM §45.15, 0343): el código de la proforma invoice. Con tracking_number (guía de envío) y platform_order (orden de Alibaba), los códigos de trazabilidad de una importación.';

comment on column public.imports.kind is
  'Compras (MOM §45.12, 0343): importacion (base USD, código IMP-) o local (laboratorio o maquila, base soles, código LOC-). No cambia después de crearla.';

do $imports$
declare
  r record;
begin
  -- La serie del código, por tipo.
  if not exists (
    select 1 from pg_constraint where conname = 'imports_code_kind_ck' and conrelid = 'public.imports'::regclass
  ) then
    for r in
      select conname from pg_constraint
       where conrelid = 'public.imports'::regclass and contype = 'c'
         and pg_get_constraintdef(oid) like '%^IMP-%' and conname <> 'imports_code_kind_ck'
    loop
      execute format('alter table public.imports drop constraint %I', r.conname);
    end loop;
    alter table public.imports add constraint imports_code_kind_ck check (
      (kind = 'importacion' and code ~ '^IMP-[0-9]{4}-[0-9]{3,}$')
      or (kind = 'local' and code ~ '^LOC-[0-9]{4}-[0-9]{3,}$'));
  end if;

  -- Los estados, con «Recibido parcial».
  if not exists (
    select 1 from pg_constraint where conname = 'imports_status_ck' and conrelid = 'public.imports'::regclass
  ) then
    for r in
      select conname from pg_constraint
       where conrelid = 'public.imports'::regclass and contype = 'c'
         and pg_get_constraintdef(oid) like '%en_camino_bodega%' and conname <> 'imports_status_ck'
    loop
      execute format('alter table public.imports drop constraint %I', r.conname);
    end loop;
    alter table public.imports add constraint imports_status_ck check (status in (
      'cotizacion', 'pagado', 'en_produccion', 'en_transito', 'en_aduana',
      'en_camino_bodega', 'recibido_parcial', 'recibido', 'ingresado', 'cerrado', 'cancelado'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'import_events_status_ck' and conrelid = 'public.import_events'::regclass
  ) then
    for r in
      select conname from pg_constraint
       where conrelid = 'public.import_events'::regclass and contype = 'c'
         and pg_get_constraintdef(oid) like '%en_camino_bodega%' and conname <> 'import_events_status_ck'
    loop
      execute format('alter table public.import_events drop constraint %I', r.conname);
    end loop;
    alter table public.import_events add constraint import_events_status_ck check (status is null or status in (
      'cotizacion', 'pagado', 'en_produccion', 'en_transito', 'en_aduana',
      'en_camino_bodega', 'recibido_parcial', 'recibido', 'ingresado', 'cerrado', 'cancelado'));
  end if;
end
$imports$;

-- ── Productos: costo en soles y cortesía ───────────────────────────────────
alter table public.import_items
  add column if not exists unit_cost_currency text not null default 'USD'
    constraint import_items_unit_cost_currency_ck check (unit_cost_currency in ('USD', 'PEN'));

alter table public.import_items
  add column if not exists unit_cost_pen numeric(14, 4)
    constraint import_items_unit_cost_pen_ck check (unit_cost_pen is null or unit_cost_pen >= 0);

-- Un producto en soles no tiene costo en USD (sigue el CHECK `unit_cost_usd >= 0`).
alter table public.import_items alter column unit_cost_usd drop not null;

alter table public.import_items
  add column if not exists courtesy_qty integer not null default 0
    constraint import_items_courtesy_qty_ck check (courtesy_qty between 0 and 10000000);

do $items$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'import_items_unit_cost_ck' and conrelid = 'public.import_items'::regclass
  ) then
    alter table public.import_items add constraint import_items_unit_cost_ck check (
      (unit_cost_currency = 'USD' and unit_cost_usd is not null and unit_cost_pen is null)
      or (unit_cost_currency = 'PEN' and unit_cost_pen is not null and unit_cost_usd is null));
  end if;
end
$items$;

comment on column public.import_items.unit_cost_currency is
  'Compras (MOM §45.12, 0343): la moneda del costo por unidad. USD en una importación; PEN en una compra local.';
comment on column public.import_items.unit_cost_usd is
  'Compras (MOM §45): el costo del proveedor por unidad en USD. Nulo si el producto es en soles (compra local).';
comment on column public.import_items.unit_cost_pen is
  'Compras (MOM §45.12, 0343): el costo por unidad en soles de una compra local. Nulo si el producto es en USD.';
comment on column public.import_items.courtesy_qty is
  'Compras (MOM §45.13, 0343): unidades de cortesía (gratis). Esperadas = qty + courtesy_qty; no suben ningún monto.';
comment on column public.import_items.received_qty is
  'Compras (MOM §45.14, 0343): Σ recibidas de sus entregas (import_delivery_lines), mantenida por trigger. Nulo = sin ninguna entrega.';

-- ── Costos: el tratamiento del IGV ──────────────────────────────────────────
alter table public.import_costs
  add column if not exists igv_treatment text not null default 'neto'
    constraint import_costs_igv_treatment_ck check (igv_treatment in ('neto', 'con_igv', 'inafecto'));

comment on column public.import_costs.igv_treatment is
  'Compras (MOM §45.3, 0343): neto (el monto entra tal cual), con_igv (entra gross_amount ÷ 1,18; = includes_igv) o inafecto (entra tal cual y no lleva IGV).';

create or replace function public.import_costs_igv_treatment_fill()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  -- El código anterior a la 0343 solo marca `includes_igv`.
  if new.includes_igv and new.igv_treatment = 'neto' then
    new.igv_treatment := 'con_igv';
  end if;
  return new;
end
$fn$;

revoke all on function public.import_costs_igv_treatment_fill() from public, anon, authenticated;

create or replace trigger import_costs_igv_treatment_fill
  before insert or update on public.import_costs
  for each row execute function public.import_costs_igv_treatment_fill();

do $costs$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'import_costs_igv_treatment_matches_ck' and conrelid = 'public.import_costs'::regclass
  ) then
    -- Backfill (idempotente): lo marcado «Incluye IGV» es 'con_igv'; lo demás queda 'neto'.
    update public.import_costs set igv_treatment = 'con_igv' where includes_igv and igv_treatment <> 'con_igv';
    alter table public.import_costs add constraint import_costs_igv_treatment_matches_ck
      check ((igv_treatment = 'con_igv') = includes_igv);
  end if;
end
$costs$;

-- ── Entregas ───────────────────────────────────────────────────────────────
create table if not exists public.import_deliveries (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  import_id     uuid not null,
  -- El día de Lima en que llegó (lo escribe la app; hoy o antes).
  delivered_on  date not null,
  note          text check (note is null or char_length(note) <= 500),
  by_user       uuid references auth.users(id) on delete set null,
  -- La recepción de antes de la 0343, pasada a una entrega por el backfill.
  legacy        boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint import_deliveries_import_fk foreign key (import_id, org_id)
    references public.imports (id, org_id) on delete cascade,
  constraint import_deliveries_id_import_uniq unique (id, import_id)
);

comment on table public.import_deliveries is
  'Compras (MOM §45.14, 0343): cada entrega de una compra (fecha de Lima, quién, nota). Sus fotos son import_documents de tipo photo con delivery_id. Solo service_role.';

create index if not exists import_deliveries_import_idx on public.import_deliveries (import_id, delivered_on);

create or replace trigger import_deliveries_touch before update on public.import_deliveries
  for each row execute function public.touch_updated_at();

create table if not exists public.import_delivery_lines (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  import_id    uuid not null,
  delivery_id  uuid not null,
  item_id      uuid not null,
  received     integer not null check (received between 0 and 10000000),
  damaged      integer not null default 0 check (damaged between 0 and 10000000),
  note         text check (note is null or char_length(note) <= 300),
  created_at   timestamptz not null default now(),
  constraint import_delivery_lines_import_fk foreign key (import_id, org_id)
    references public.imports (id, org_id) on delete cascade,
  -- La entrega y el producto son de la MISMA importación.
  constraint import_delivery_lines_delivery_fk foreign key (delivery_id, import_id)
    references public.import_deliveries (id, import_id) on delete cascade,
  constraint import_delivery_lines_item_fk foreign key (item_id, import_id)
    references public.import_items (id, import_id),
  constraint import_delivery_lines_damaged_le_received check (damaged <= received),
  constraint import_delivery_lines_one_per_item unique (delivery_id, item_id)
);

comment on table public.import_delivery_lines is
  'Compras (MOM §45.14, 0343): por entrega y producto, recibidas, dañadas y nota. Σ por producto = import_items.received_qty / damaged_qty (trigger import_delivery_lines_sync). Solo service_role.';

create index if not exists import_delivery_lines_item_idx on public.import_delivery_lines (item_id);
create index if not exists import_delivery_lines_import_idx on public.import_delivery_lines (import_id);

-- ── Las fotos de cada entrega ──────────────────────────────────────────────
alter table public.import_documents add column if not exists delivery_id uuid;

do $docs$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'import_documents_delivery_fk' and conrelid = 'public.import_documents'::regclass
  ) then
    alter table public.import_documents add constraint import_documents_delivery_fk foreign key (delivery_id, import_id)
      references public.import_deliveries (id, import_id) on delete set null (delivery_id);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'import_documents_delivery_photo_ck' and conrelid = 'public.import_documents'::regclass
  ) then
    alter table public.import_documents add constraint import_documents_delivery_photo_ck
      check (delivery_id is null or kind = 'photo');
  end if;
end
$docs$;

create index if not exists import_documents_delivery_idx on public.import_documents (delivery_id) where delivery_id is not null;

comment on column public.import_documents.delivery_id is
  'Compras (MOM §45.14, 0343): la entrega de la que es foto (solo kind = photo). Quitar la entrega deja la foto en Documentos.';

-- ── Backfill: la recepción de antes, como una entrega (ver la cabecera) ────
insert into public.import_deliveries (org_id, import_id, delivered_on, note, by_user, legacy, created_at, updated_at)
select i.org_id,
       i.id,
       coalesce(i.arrived_on, (max(it.received_at) at time zone 'America/Lima')::date, (i.updated_at at time zone 'America/Lima')::date),
       'Recepción registrada antes de las entregas parciales (0343).',
       (array_agg(it.received_by order by it.received_at desc nulls last))[1],
       true,
       coalesce(max(it.received_at), i.updated_at),
       coalesce(max(it.received_at), i.updated_at)
  from public.imports i
  join public.import_items it on it.import_id = i.id and it.received_qty is not null
 where not exists (select 1 from public.import_delivery_lines l where l.item_id = it.id)
   and not exists (select 1 from public.import_deliveries d where d.import_id = i.id and d.legacy)
 group by i.org_id, i.id, i.arrived_on, i.updated_at;

insert into public.import_delivery_lines (org_id, import_id, delivery_id, item_id, received, damaged, note, created_at)
select it.org_id, it.import_id, d.id, it.id, it.received_qty, coalesce(it.damaged_qty, 0), it.reception_note, d.created_at
  from public.import_items it
  join lateral (
    select d.id, d.created_at from public.import_deliveries d
     where d.import_id = it.import_id and d.legacy
     order by d.created_at
     limit 1
  ) d on true
 where it.received_qty is not null
   and not exists (select 1 from public.import_delivery_lines l where l.item_id = it.id);

-- ── Los totales de cada producto = Σ sus entregas ──────────────────────────
create or replace function public.import_delivery_lines_sync()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_item uuid;
begin
  foreach v_item in array array_remove(array[
    case when tg_op in ('UPDATE', 'DELETE') then old.item_id end,
    case when tg_op in ('INSERT', 'UPDATE') then new.item_id end], null)
  loop
    -- Primero el candado de la fila del producto: una entrega que se guarda a
    -- la vez espera y, en su propia sentencia, ya suma la que se guardó antes.
    perform 1 from public.import_items where id = v_item for update;
    update public.import_items i
       set received_qty   = agg.received,
           damaged_qty    = agg.damaged,
           reception_note = agg.note,
           received_at    = agg.at,
           received_by    = agg.by_user
      from (
        select sum(l.received)::integer as received,
               sum(l.damaged)::integer as damaged,
               left(string_agg(nullif(btrim(l.note), ''), ' · ' order by d.delivered_on, d.created_at), 300) as note,
               max(d.created_at) as at,
               (array_agg(d.by_user order by d.delivered_on desc, d.created_at desc))[1] as by_user
          from public.import_delivery_lines l
          join public.import_deliveries d on d.id = l.delivery_id
         where l.item_id = v_item
      ) agg
     where i.id = v_item;
  end loop;
  return null;
end
$fn$;

comment on function public.import_delivery_lines_sync() is
  'Compras (MOM §45.14, 0343): deja received_qty, damaged_qty, reception_note, received_at y received_by de cada producto como la suma de sus entregas (nulos sin ninguna), en la misma transacción.';

revoke all on function public.import_delivery_lines_sync() from public, anon, authenticated;

create or replace trigger import_delivery_lines_sync
  after insert or update or delete on public.import_delivery_lines
  for each row execute function public.import_delivery_lines_sync();

-- ── Solo el servidor (como en la 0340) ─────────────────────────────────────
alter table public.import_deliveries     enable row level security;
alter table public.import_delivery_lines enable row level security;
revoke all on public.import_deliveries, public.import_delivery_lines from anon, authenticated;
grant all privileges on public.import_deliveries, public.import_delivery_lines to service_role;

alter table public.imports          enable row level security;
alter table public.import_items     enable row level security;
alter table public.import_documents enable row level security;
alter table public.import_costs     enable row level security;
revoke all on public.imports, public.import_items, public.import_documents, public.import_costs from anon, authenticated;
grant all privileges on public.imports, public.import_items, public.import_documents, public.import_costs to service_role;
