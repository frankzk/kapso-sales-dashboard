-- ============================================================================
-- 0134_group_gf_courier_foundation.sql
-- Fundación multi-tienda para Grupo GF Courier (MOM §29).
--
-- Esta migración NO mueve rutas ni inventario existentes. Introduce identidades
-- estables y tablas con vigencia para que la transición desde "motorizados
-- propios" sea incremental y auditable:
--
--   operador → contrato con tienda → tarifa/fee vigente
--                         └────────→ bolsa de inventario opcional
--
-- `delivery_routes` y `dispatch_manifests` se conservan hasta que una migración
-- posterior pueda vincularlos sin duplicar custodia ni perder historia.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Operador logístico. `org_id` es la organización que lo administra en Kapta;
-- no es una tienda y no crea pedidos Shopify ficticios.
-- ----------------------------------------------------------------------------

create table if not exists logistics_providers (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organizations(id) on delete cascade,
  code                  text not null,
  name                  text not null,
  legal_name            text,
  status                text not null default 'active'
    check (status in ('active', 'suspended', 'inactive')),
  coverage_note         text,
  same_day_cutoff       time not null default time '11:30',
  cash_warning_amount   numeric(12, 2) not null default 4000
    check (cash_warning_amount >= 0),
  cash_limit_amount     numeric(12, 2) not null default 5000
    check (cash_limit_amount > 0),
  currency              text not null default 'PEN',
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (length(trim(code)) > 0),
  check (length(trim(name)) > 0),
  check (cash_warning_amount <= cash_limit_amount)
);

create unique index if not exists logistics_providers_org_code_idx
  on logistics_providers(org_id, lower(trim(code)));

drop trigger if exists logistics_providers_touch on logistics_providers;
create trigger logistics_providers_touch before update on logistics_providers
  for each row execute function public.touch_updated_at();

comment on table logistics_providers is
  'Operadores logísticos administrados en Kapta. Grupo GF Courier vive aquí; no es una tienda Shopify.';

-- ----------------------------------------------------------------------------
-- Contrato entre operador y cliente. `store_id` nulo permite un cliente que
-- entra por API/Excel y todavía no tiene Shopify conectado. Si se informa, la
-- aplicación debe comprobar que la tienda pertenece a `client_org_id`.
-- ----------------------------------------------------------------------------

create table if not exists logistics_service_agreements (
  id                    uuid primary key default gen_random_uuid(),
  provider_id           uuid not null references logistics_providers(id) on delete cascade,
  client_org_id         uuid not null references organizations(id) on delete cascade,
  store_id              uuid references stores(id) on delete cascade,
  client_label          text not null,
  status                text not null default 'active'
    check (status in ('draft', 'active', 'suspended', 'ended')),
  assignment_mode       text not null default 'direct'
    check (assignment_mode in ('direct', 'request_acceptance')),
  settlement_frequency  text not null default 'daily'
    check (settlement_frequency in ('daily')),
  same_day_cutoff       time,
  coverage_note         text,
  effective_from        date not null default current_date,
  effective_to          date,
  note                  text,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (length(trim(client_label)) > 0),
  check (effective_to is null or effective_to >= effective_from)
);

create index if not exists logistics_agreements_provider_idx
  on logistics_service_agreements(provider_id, status, effective_from desc);
create index if not exists logistics_agreements_client_idx
  on logistics_service_agreements(client_org_id, store_id, status);
create unique index if not exists logistics_agreements_store_period_idx
  on logistics_service_agreements(
    provider_id,
    client_org_id,
    coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid),
    effective_from
  );

drop trigger if exists logistics_service_agreements_touch on logistics_service_agreements;
create trigger logistics_service_agreements_touch
  before update on logistics_service_agreements
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- Matriz configurable por distrito. Una fila contiene las dos columnas que la
-- operación edita junta: entrega y rechazo. Nulo en agreement_id = tarifa
-- general; informada = excepción contractual que gana sobre la general.
-- ----------------------------------------------------------------------------

create table if not exists logistics_district_tariffs (
  id                    uuid primary key default gen_random_uuid(),
  provider_id           uuid not null references logistics_providers(id) on delete cascade,
  agreement_id          uuid references logistics_service_agreements(id) on delete cascade,
  district_key          text not null references peru_districts(district_key) on delete restrict,
  zone                  text,
  delivery_amount       numeric(12, 2) not null check (delivery_amount >= 0),
  rejection_amount      numeric(12, 2) not null check (rejection_amount >= 0),
  includes_igv          boolean not null default true,
  currency              text not null default 'PEN',
  effective_from        date not null default current_date,
  effective_to          date,
  status                text not null default 'active'
    check (status in ('active', 'inactive')),
  note                  text,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);

create index if not exists logistics_tariffs_lookup_idx
  on logistics_district_tariffs(provider_id, district_key, effective_from desc);
create index if not exists logistics_tariffs_agreement_idx
  on logistics_district_tariffs(agreement_id, district_key, effective_from desc)
  where agreement_id is not null;
create unique index if not exists logistics_tariffs_scope_period_idx
  on logistics_district_tariffs(
    provider_id,
    coalesce(agreement_id, '00000000-0000-0000-0000-000000000000'::uuid),
    district_key,
    effective_from
  );

drop trigger if exists logistics_district_tariffs_touch on logistics_district_tariffs;
create trigger logistics_district_tariffs_touch
  before update on logistics_district_tariffs
  for each row execute function public.touch_updated_at();

comment on table logistics_district_tariffs is
  'Tarifa incluida IGV por distrito. La excepción del contrato gana sobre la general; los cambios abren vigencia nueva.';

-- ----------------------------------------------------------------------------
-- Reglas porcentuales con vigencia. La primera regla acordada es la comisión
-- Yape de Grupo GF: 3.5 % del importe efectivamente recibido por Yape.
-- ----------------------------------------------------------------------------

create table if not exists logistics_fee_rules (
  id                    uuid primary key default gen_random_uuid(),
  provider_id           uuid not null references logistics_providers(id) on delete cascade,
  agreement_id          uuid references logistics_service_agreements(id) on delete cascade,
  kind                  text not null check (kind in ('yape_commission')),
  percentage            numeric(7, 4) not null default 3.5
    check (percentage >= 0 and percentage <= 100),
  effective_from        date not null default current_date,
  effective_to          date,
  status                text not null default 'active'
    check (status in ('active', 'inactive')),
  note                  text,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);

create index if not exists logistics_fee_rules_lookup_idx
  on logistics_fee_rules(provider_id, kind, effective_from desc);
create unique index if not exists logistics_fee_rules_scope_period_idx
  on logistics_fee_rules(
    provider_id,
    coalesce(agreement_id, '00000000-0000-0000-0000-000000000000'::uuid),
    kind,
    effective_from
  );

drop trigger if exists logistics_fee_rules_touch on logistics_fee_rules;
create trigger logistics_fee_rules_touch before update on logistics_fee_rules
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- Inventario futuro. La bolsa existe desde ahora para no volver a cambiar la
-- identidad, pero `strict_control = false` y todas las referencias futuras
-- serán anulables: no bloquea Aurela/Kenku ni obliga a migrar existencias.
-- ----------------------------------------------------------------------------

create table if not exists inventory_pools (
  id                    uuid primary key default gen_random_uuid(),
  custodian_provider_id uuid not null references logistics_providers(id) on delete cascade,
  owner_org_id          uuid references organizations(id) on delete set null,
  code                  text not null,
  name                  text not null,
  owner_label           text,
  strict_control        boolean not null default false,
  status                text not null default 'active'
    check (status in ('active', 'suspended', 'inactive')),
  note                  text,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (length(trim(code)) > 0),
  check (length(trim(name)) > 0)
);

create unique index if not exists inventory_pools_provider_code_idx
  on inventory_pools(custodian_provider_id, lower(trim(code)));

create table if not exists inventory_pool_store_access (
  pool_id               uuid not null references inventory_pools(id) on delete cascade,
  store_id              uuid not null references stores(id) on delete cascade,
  active                boolean not null default true,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  primary key (pool_id, store_id)
);

drop trigger if exists inventory_pools_touch on inventory_pools;
create trigger inventory_pools_touch before update on inventory_pools
  for each row execute function public.touch_updated_at();

comment on column inventory_pools.strict_control is
  'False = la bolsa documenta propiedad/acceso sin exigir saldo ni reservas; permite activar inventario en una fase posterior.';

-- ----------------------------------------------------------------------------
-- RLS. El catálogo de operadores contiene solo identidad comercial y es visible
-- a usuarios autenticados. Contratos, precios y bolsas quedan limitados al
-- operador administrador o al cliente explícitamente relacionado.
-- ----------------------------------------------------------------------------

alter table logistics_providers          enable row level security;
alter table logistics_service_agreements enable row level security;
alter table logistics_district_tariffs   enable row level security;
alter table logistics_fee_rules          enable row level security;
alter table inventory_pools              enable row level security;
alter table inventory_pool_store_access  enable row level security;

drop policy if exists logistics_providers_select on logistics_providers;
create policy logistics_providers_select on logistics_providers
  for select to authenticated using (true);
drop policy if exists logistics_providers_write on logistics_providers;
create policy logistics_providers_write on logistics_providers
  for all to authenticated
  using (org_id in (select auth_admin_org_ids()))
  with check (org_id in (select auth_admin_org_ids()));

drop policy if exists logistics_agreements_select on logistics_service_agreements;
create policy logistics_agreements_select on logistics_service_agreements
  for select to authenticated using (
    client_org_id in (select auth_org_ids())
    or provider_id in (
      select id from logistics_providers where org_id in (select auth_org_ids())
    )
  );
drop policy if exists logistics_agreements_write on logistics_service_agreements;
create policy logistics_agreements_write on logistics_service_agreements
  for all to authenticated
  using (provider_id in (
    select id from logistics_providers where org_id in (select auth_admin_org_ids())
  ))
  with check (provider_id in (
    select id from logistics_providers where org_id in (select auth_admin_org_ids())
  ));

drop policy if exists logistics_tariffs_select on logistics_district_tariffs;
create policy logistics_tariffs_select on logistics_district_tariffs
  for select to authenticated using (
    provider_id in (
      select id from logistics_providers where org_id in (select auth_org_ids())
    )
    or agreement_id in (
      select id from logistics_service_agreements where client_org_id in (select auth_org_ids())
    )
    or (
      agreement_id is null
      and provider_id in (
        select provider_id
          from logistics_service_agreements
         where client_org_id in (select auth_org_ids())
           and status = 'active'
      )
    )
  );
drop policy if exists logistics_tariffs_write on logistics_district_tariffs;
create policy logistics_tariffs_write on logistics_district_tariffs
  for all to authenticated
  using (provider_id in (
    select id from logistics_providers where org_id in (select auth_admin_org_ids())
  ))
  with check (provider_id in (
    select id from logistics_providers where org_id in (select auth_admin_org_ids())
  ));

drop policy if exists logistics_fee_rules_select on logistics_fee_rules;
create policy logistics_fee_rules_select on logistics_fee_rules
  for select to authenticated using (
    provider_id in (
      select id from logistics_providers where org_id in (select auth_org_ids())
    )
    or agreement_id in (
      select id from logistics_service_agreements where client_org_id in (select auth_org_ids())
    )
    or (
      agreement_id is null
      and provider_id in (
        select provider_id
          from logistics_service_agreements
         where client_org_id in (select auth_org_ids())
           and status = 'active'
      )
    )
  );
drop policy if exists logistics_fee_rules_write on logistics_fee_rules;
create policy logistics_fee_rules_write on logistics_fee_rules
  for all to authenticated
  using (provider_id in (
    select id from logistics_providers where org_id in (select auth_admin_org_ids())
  ))
  with check (provider_id in (
    select id from logistics_providers where org_id in (select auth_admin_org_ids())
  ));

drop policy if exists inventory_pools_select on inventory_pools;
create policy inventory_pools_select on inventory_pools
  for select to authenticated using (
    owner_org_id in (select auth_org_ids())
    or custodian_provider_id in (
      select id from logistics_providers where org_id in (select auth_org_ids())
    )
  );
drop policy if exists inventory_pools_write on inventory_pools;
create policy inventory_pools_write on inventory_pools
  for all to authenticated
  using (custodian_provider_id in (
    select id from logistics_providers where org_id in (select auth_admin_org_ids())
  ))
  with check (custodian_provider_id in (
    select id from logistics_providers where org_id in (select auth_admin_org_ids())
  ));

drop policy if exists inventory_pool_store_access_select on inventory_pool_store_access;
create policy inventory_pool_store_access_select on inventory_pool_store_access
  for select to authenticated using (
    store_id in (select auth_store_ids())
    or pool_id in (
      select p.id
        from inventory_pools p
        join logistics_providers lp on lp.id = p.custodian_provider_id
       where lp.org_id in (select auth_org_ids())
    )
  );
drop policy if exists inventory_pool_store_access_write on inventory_pool_store_access;
create policy inventory_pool_store_access_write on inventory_pool_store_access
  for all to authenticated
  using (pool_id in (
    select p.id
      from inventory_pools p
      join logistics_providers lp on lp.id = p.custodian_provider_id
     where lp.org_id in (select auth_admin_org_ids())
  ))
  with check (pool_id in (
    select p.id
      from inventory_pools p
      join logistics_providers lp on lp.id = p.custodian_provider_id
     where lp.org_id in (select auth_admin_org_ids())
  ));

grant select on logistics_providers, logistics_service_agreements,
  logistics_district_tariffs, logistics_fee_rules, inventory_pools,
  inventory_pool_store_access to authenticated;
grant insert, update on logistics_providers, logistics_service_agreements,
  logistics_district_tariffs, logistics_fee_rules, inventory_pools,
  inventory_pool_store_access to authenticated;
grant all privileges on logistics_providers, logistics_service_agreements,
  logistics_district_tariffs, logistics_fee_rules, inventory_pools,
  inventory_pool_store_access to service_role;
