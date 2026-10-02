-- Programación enviada a Urpi, independiente de entregas, rutas y liquidación.
create table if not exists public.urpi_programming_sources (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  spreadsheet_id text not null check (spreadsheet_id ~ '^[a-zA-Z0-9_-]{20,100}$'),
  month text not null check (month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  order_prefix text not null check (order_prefix ~ '^[A-Z]{1,12}$'),
  name text not null,
  current_snapshot_id uuid,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  unique (store_id, spreadsheet_id, month)
);

create table if not exists public.urpi_programming_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.urpi_programming_sources(id),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  origin text not null check (origin in ('google', 'excel')),
  filename text,
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  row_count integer not null check (row_count between 0 and 10000),
  linked_count integer not null check (linked_count between 0 and row_count),
  payload jsonb not null check (jsonb_typeof(payload->'rows') = 'array' and jsonb_typeof(payload->'tabs') = 'array'),
  unique (source_id, id)
);
create index if not exists urpi_snapshots_source_created on public.urpi_programming_snapshots(source_id, created_at desc);
create index if not exists urpi_sources_store_month on public.urpi_programming_sources(store_id, month desc);

-- Pointer can only reference a snapshot belonging to this same source.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'urpi_sources_current_snapshot_fk') then
    alter table public.urpi_programming_sources add constraint urpi_sources_current_snapshot_fk
      foreign key (id, current_snapshot_id) references public.urpi_programming_snapshots(source_id, id);
  end if;
end $$;

alter table public.urpi_programming_sources enable row level security;
alter table public.urpi_programming_snapshots enable row level security;
revoke all on public.urpi_programming_sources, public.urpi_programming_snapshots from anon, authenticated;
grant select on public.urpi_programming_sources, public.urpi_programming_snapshots to authenticated;
grant all on public.urpi_programming_sources, public.urpi_programming_snapshots to service_role;
drop policy if exists urpi_sources_read on public.urpi_programming_sources;
create policy urpi_sources_read on public.urpi_programming_sources for select to authenticated
  using (store_id in (select public.auth_store_ids()));
drop policy if exists urpi_snapshots_read on public.urpi_programming_snapshots;
create policy urpi_snapshots_read on public.urpi_programming_snapshots for select to authenticated
  using (exists (select 1 from public.urpi_programming_sources s where s.id = source_id and s.store_id in (select public.auth_store_ids())));

-- Atomic snapshot + current pointer. No mutation of orders/shipments/master.
-- Only server service role may call, after store + org permission checks.
create or replace function public.save_urpi_programming_snapshot(
  p_source_id uuid, p_actor uuid, p_started_at timestamptz, p_digest text,
  p_payload jsonb, p_origin text, p_filename text
) returns boolean language plpgsql security invoker set search_path = public as $$
declare
  s public.urpi_programming_sources;
  previous_digest text;
  previous_payload jsonb;
  new_id uuid;
  count_rows integer;
  count_linked integer;
begin
  select * into strict s from public.urpi_programming_sources where id = p_source_id for update;
  if s.last_checked_at is not null and p_started_at < s.last_checked_at then
    raise exception 'newer_import';
  end if;
  if jsonb_typeof(p_payload->'rows') is distinct from 'array'
     or jsonb_typeof(p_payload->'tabs') is distinct from 'array' then raise exception 'invalid_payload'; end if;
  count_rows := jsonb_array_length(p_payload->'rows');
  if count_rows > 10000 then raise exception 'too_many_rows'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_payload->'rows') r
    where coalesce(r->>'orderCode','') !~ ('^' || s.order_prefix || '[0-9]+$')
      or (r->>'orderId' is not null and not exists (
        select 1 from public.orders o where o.id::text = r->>'orderId' and o.store_id = s.store_id
      ))
  ) then raise exception 'invalid_order_scope'; end if;
  select count(*) into count_linked from jsonb_array_elements(p_payload->'rows') r where r->>'orderId' is not null;
  select digest, payload into previous_digest, previous_payload from public.urpi_programming_snapshots where id = s.current_snapshot_id;
  if previous_payload is not null and exists (
    select 1 from jsonb_array_elements(previous_payload->'tabs') old_tab
    where not exists (select 1 from jsonb_array_elements(p_payload->'tabs') new_tab where new_tab->>'title' = old_tab->>'title')
  ) then raise exception 'missing_tabs'; end if;
  if previous_digest = p_digest then
    update public.urpi_programming_sources set last_checked_at = p_started_at where id = s.id;
    return false;
  end if;
  insert into public.urpi_programming_snapshots(source_id, created_by, origin, filename, digest, row_count, linked_count, payload)
    values(s.id, p_actor, p_origin, p_filename, p_digest, count_rows, count_linked, p_payload) returning id into new_id;
  update public.urpi_programming_sources set current_snapshot_id = new_id, last_checked_at = p_started_at where id = s.id;
  return true;
end $$;
revoke all on function public.save_urpi_programming_snapshot(uuid,uuid,timestamptz,text,jsonb,text,text) from public, anon, authenticated;
grant execute on function public.save_urpi_programming_snapshot(uuid,uuid,timestamptz,text,jsonb,text,text) to service_role;
