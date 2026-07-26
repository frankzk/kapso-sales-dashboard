-- ============================================================================
-- 0050_costs.sql — módulo de Costos (§17).
--
-- Sección propia, no una pestaña dentro de Ajustes: la especificación anticipa
-- que crecerá hacia una sección financiera más amplia.
--
-- Lo que decide toda la forma de estas tablas es la VIGENCIA. Una tarifa no es
-- un número, es un número con fecha de inicio: si mañana sube el costo de
-- reparto en Huancayo, los pedidos de la semana pasada tienen que seguir
-- costando lo que costaron. Por eso nada se edita en su sitio — se cierra la
-- tarifa vigente y se abre otra.
--
-- La resolución (qué tarifa aplica a un pedido concreto) es pura y vive en
-- lib/costs.ts, con un orden de especificidad de distrito → provincia → región →
-- courier → tienda.
--
-- Escritura para administradores de la organización, siguiendo el patrón de
-- fenix_stock (0025) — es la única forma de tabla que el dashboard edita
-- directamente bajo RLS en vez de por service role.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Costos logísticos
-- ----------------------------------------------------------------------------

create table if not exists cost_tariffs (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  -- Ámbito. Cuanto más campos rellenos, más específica es la tarifa y antes gana.
  -- Todos nulos = tarifa general de la organización.
  store_id       uuid references stores(id) on delete cascade,
  courier        text,
  region         text,
  province       text,
  district       text,
  concept        text not null check (concept in (
                   'primer_intento',
                   'intento_adicional',
                   'envio_agencia',
                   'devolucion',
                   'especial'
                 )),
  amount         numeric(12, 2) not null,
  currency       text not null default 'PEN',
  -- Vigencia. `effective_to` nulo = sigue vigente.
  effective_from date not null default current_date,
  effective_to   date,
  note           text,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- Una tarifa que termina antes de empezar sería invisible y silenciosa.
  constraint cost_tariffs_period_valid check (effective_to is null or effective_to >= effective_from)
);

create index if not exists cost_tariffs_lookup_idx
  on cost_tariffs(org_id, concept, effective_from desc);
create index if not exists cost_tariffs_store_idx on cost_tariffs(store_id);
-- Búsqueda por ámbito geográfico, que es como se consulta en la práctica.
create index if not exists cost_tariffs_geo_idx on cost_tariffs(org_id, district, province, region);

-- ----------------------------------------------------------------------------
-- Costos de producto
-- ----------------------------------------------------------------------------

create table if not exists product_costs (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  store_id       uuid references stores(id) on delete cascade,
  sku            text not null,
  product_name   text,
  supplier       text,
  batch          text,
  unit_cost      numeric(12, 2) not null,
  currency       text not null default 'PEN',
  effective_from date not null default current_date,
  effective_to   date,
  note           text,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint product_costs_period_valid check (effective_to is null or effective_to >= effective_from)
);

create index if not exists product_costs_lookup_idx
  on product_costs(org_id, sku, effective_from desc);

-- ----------------------------------------------------------------------------
-- Costos adicionales (empaque, materiales, preparación, comisiones…)
-- ----------------------------------------------------------------------------

create table if not exists additional_costs (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  store_id       uuid references stores(id) on delete cascade,
  concept        text not null,          -- empaque | materiales | preparacion | comision | otro
  label          text,
  amount         numeric(12, 2) not null,
  currency       text not null default 'PEN',
  -- 'pedido' = importe fijo por pedido; 'porcentaje' = % sobre el total.
  basis          text not null default 'pedido' check (basis in ('pedido', 'porcentaje')),
  effective_from date not null default current_date,
  effective_to   date,
  note           text,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint additional_costs_period_valid check (effective_to is null or effective_to >= effective_from)
);

create index if not exists additional_costs_lookup_idx
  on additional_costs(org_id, concept, effective_from desc);

-- ----------------------------------------------------------------------------
-- RLS: lectura para quien pertenece a la organización; escritura solo admins.
-- Mismo patrón que fenix_stock (0025).
-- ----------------------------------------------------------------------------

alter table cost_tariffs     enable row level security;
alter table product_costs    enable row level security;
alter table additional_costs enable row level security;

drop policy if exists cost_tariffs_select on cost_tariffs;
create policy cost_tariffs_select on cost_tariffs for select to authenticated
  using (org_id in (select auth_org_ids()));
drop policy if exists cost_tariffs_write on cost_tariffs;
create policy cost_tariffs_write on cost_tariffs for all to authenticated
  using (org_id in (select auth_admin_org_ids()))
  with check (org_id in (select auth_admin_org_ids()));

drop policy if exists product_costs_select on product_costs;
create policy product_costs_select on product_costs for select to authenticated
  using (org_id in (select auth_org_ids()));
drop policy if exists product_costs_write on product_costs;
create policy product_costs_write on product_costs for all to authenticated
  using (org_id in (select auth_admin_org_ids()))
  with check (org_id in (select auth_admin_org_ids()));

drop policy if exists additional_costs_select on additional_costs;
create policy additional_costs_select on additional_costs for select to authenticated
  using (org_id in (select auth_org_ids()));
drop policy if exists additional_costs_write on additional_costs;
create policy additional_costs_write on additional_costs for all to authenticated
  using (org_id in (select auth_admin_org_ids()))
  with check (org_id in (select auth_admin_org_ids()));

grant select on cost_tariffs, product_costs, additional_costs to authenticated;
grant insert, update, delete on cost_tariffs, product_costs, additional_costs to authenticated;
grant all privileges on cost_tariffs, product_costs, additional_costs to service_role;

drop trigger if exists cost_tariffs_touch on cost_tariffs;
create trigger cost_tariffs_touch before update on cost_tariffs
  for each row execute function public.touch_updated_at();
drop trigger if exists product_costs_touch on product_costs;
create trigger product_costs_touch before update on product_costs
  for each row execute function public.touch_updated_at();
drop trigger if exists additional_costs_touch on additional_costs;
create trigger additional_costs_touch before update on additional_costs
  for each row execute function public.touch_updated_at();

comment on column cost_tariffs.effective_from is
  'Inicio de vigencia. Cambiar una tarifa NO edita la fila: se cierra la vigente y se abre otra, para que los cálculos históricos no se muevan.';
