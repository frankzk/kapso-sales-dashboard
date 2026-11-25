-- ============================================================================
-- 0355_resend_marketing.sql — Correo de marketing con Resend
-- (owner, 25-11-2026: «arma la sincronización con Resend»; MOM §46).
--
-- Kapta guarda el historial de Shopify de Aurela y Kenku (clientes, pedidos y
-- carritos). De ahí salen los clientes que aceptaron publicidad en Shopify
-- (`accepts_marketing = 'subscribed'`), por tienda y por su última compra. Kapta
-- los sube a Resend en importaciones por segmento; las campañas se arman y se
-- envían en Resend.
--
-- 1. `resend_settings`: por organización, la clave de Resend cifrada (como las
--    demás claves: `encrypt` de lib/crypto.ts) y los ids que Kapta creó allá
--    (un tema por tienda, un segmento por tienda y tramo). Solo el servidor la
--    lee: la clave nunca llega al navegador.
-- 2. `resend_imports`: cada importación pedida a Resend, con su estado.
-- 3. `resend_marketing_counts`, `resend_marketing_contacts` y
--    `resend_marketing_export`: lectura de los contactos (solo service_role).
--    Excluyen los dados de baja en la tienda y los dominios que se pasan (mal
--    escritos: «gimail.com», «gmil.com»…). Dos índices nuevos sobre el
--    historial de Shopify para que contar no recorra los 320.000 pedidos.
--
-- Aditiva: tablas nuevas y funciones de solo lectura; no toca filas existentes.
-- Sin ella, la página «Correo · Resend» dice «Falta la migración 0355».
-- ============================================================================

create table if not exists public.resend_settings (
  org_id      uuid primary key references public.organizations(id) on delete cascade,
  api_key_enc text,
  key_hint    text,
  topics      jsonb not null default '{}'::jsonb,
  segments    jsonb not null default '{}'::jsonb,
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);
comment on table public.resend_settings is
  'Correo · Resend (0355, MOM §46): clave cifrada por organización y los ids de temas (por tienda) y segmentos (tienda:tramo) creados en Resend. Solo servidor.';

create table if not exists public.resend_imports (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  store_id         uuid not null references public.stores(id) on delete cascade,
  bucket           text not null,
  resend_import_id text,
  rows             integer not null default 0,
  excluded         integer not null default 0,
  status           text not null default 'enviada',
  detail           text,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
alter table public.resend_imports drop constraint if exists resend_imports_bucket_check;
alter table public.resend_imports add constraint resend_imports_bucket_check
  check (bucket in ('6m', '12m', 'todos'));
alter table public.resend_imports drop constraint if exists resend_imports_status_check;
alter table public.resend_imports add constraint resend_imports_status_check
  check (status in ('enviada', 'procesando', 'completada', 'fallida'));
create index if not exists resend_imports_org_idx on public.resend_imports (org_id, created_at desc);
comment on table public.resend_imports is
  'Correo · Resend (0355): cada importación de contactos pedida a Resend (tienda y tramo), con su estado.';

alter table public.resend_settings enable row level security;
alter table public.resend_imports enable row level security;

-- La configuración tiene la clave cifrada: nadie la lee desde el navegador.
revoke all on public.resend_settings from anon, authenticated;
grant all on public.resend_settings to service_role;

drop policy if exists resend_imports_read on public.resend_imports;
create policy resend_imports_read on public.resend_imports
  for select to authenticated using (org_id in (select auth_org_ids()));
revoke all on public.resend_imports from anon, authenticated;
grant select on public.resend_imports to authenticated;
grant all on public.resend_imports to service_role;

-- Índices para leer rápido por tienda y correo (sin ellos, contar era un
-- recorrido entero de 320.000 pedidos: 5,6 s). El de pedidos lleva `email` para
-- que la lectura salga del índice solo, sin tocar las filas (con la tabla fría,
-- 5 s → menos de 1 s).
drop index if exists public.shopify_history_orders_store_email_idx;
drop index if exists public.shopify_history_orders_store_email_inc_idx;
create index if not exists shopify_history_orders_store_email_recent_idx
  on public.shopify_history_orders (store_id, (lower(trim(email))), created_at) include (email)
  where email is not null;
create index if not exists shopify_history_customers_store_marketing_idx
  on public.shopify_history_customers (store_id, accepts_marketing);

-- Los contactos que aceptaron publicidad en una tienda, con su último pedido y
-- cuántos pedidos tiene ahí. Cuenta todo pedido, también el cancelado: para el
-- correo lo que importa es que el cliente pidió hace poco con ese correo (con
-- los cancelados fuera, Kenku bajaba de 11.532 a 7.972 en 12 meses). Un correo
-- dado de baja en la tienda no sale.
create or replace function public.resend_marketing_contacts(p_store uuid, p_exclude_domains text[] default '{}')
returns table(email text, first_name text, last_name text, last_order_at timestamptz, orders integer)
language sql stable security invoker set search_path=public,pg_temp as $$
  with subs as (
    select distinct on (lower(trim(c.email)))
      lower(trim(c.email)) as email,
      nullif(trim(c.first_name), '') as first_name,
      nullif(trim(c.last_name), '') as last_name
    from shopify_history_customers c
    where c.store_id = p_store
      and c.accepts_marketing = 'subscribed'
      and c.email ~* '^[^@\s,;<>]+@[^@\s,;<>]+\.[a-z]{2,}$'
      and split_part(lower(trim(c.email)), '@', 2) <> all(coalesce(p_exclude_domains, '{}'))
    order by lower(trim(c.email)), c.imported_at desc nulls last
  ), bajas as (
    select distinct lower(trim(u.email)) as email
    from shopify_history_customers u
    where u.store_id = p_store and u.accepts_marketing = 'unsubscribed' and u.email is not null
  ), ord as (
    select lower(trim(o.email)) as email, max(o.created_at) as last_order_at, count(*)::integer as orders
    from shopify_history_orders o
    where o.store_id = p_store and o.email is not null
    group by 1
  )
  select s.email, s.first_name, s.last_name, ord.last_order_at, coalesce(ord.orders, 0)
  from subs s
  left join ord on ord.email = s.email
  where not exists (select 1 from bajas b where b.email = s.email)
  order by s.email
$$;

-- Cuántos hay por tienda de la organización: los que pidieron en 6 y 12 meses,
-- y todos los que aceptan publicidad.
create or replace function public.resend_marketing_counts(p_org uuid, p_exclude_domains text[] default '{}')
returns table(store_id uuid, store_name text, total bigint, last_6m bigint, last_12m bigint)
language sql stable security invoker set search_path=public,pg_temp as $$
  select s.id, s.name,
    count(*)::bigint,
    count(*) filter (where c.last_order_at > now() - interval '6 months')::bigint,
    count(*) filter (where c.last_order_at > now() - interval '12 months')::bigint
  from stores s
  cross join lateral public.resend_marketing_contacts(s.id, p_exclude_domains) c
  where s.org_id = p_org
  group by s.id, s.name
  order by s.name
$$;

-- Los contactos de un tramo en una sola respuesta (jsonb, sin el tope de filas
-- de la API): los que pidieron en los últimos `p_months` meses, o todos con
-- null. Kapta arma el CSV.
create or replace function public.resend_marketing_export(p_store uuid, p_months integer default null, p_exclude_domains text[] default '{}')
returns jsonb
language sql stable security invoker set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'email', c.email, 'first_name', c.first_name, 'last_name', c.last_name,
    'last_order_at', c.last_order_at, 'orders', c.orders) order by c.email), '[]'::jsonb)
  from public.resend_marketing_contacts(p_store, p_exclude_domains) c
  where p_months is null or c.last_order_at > now() - make_interval(months => p_months)
$$;

revoke all on function public.resend_marketing_contacts(uuid, text[]) from public, anon, authenticated;
revoke all on function public.resend_marketing_export(uuid, integer, text[]) from public, anon, authenticated;
grant execute on function public.resend_marketing_export(uuid, integer, text[]) to service_role;
revoke all on function public.resend_marketing_counts(uuid, text[]) from public, anon, authenticated;
grant execute on function public.resend_marketing_contacts(uuid, text[]) to service_role;
grant execute on function public.resend_marketing_counts(uuid, text[]) to service_role;
