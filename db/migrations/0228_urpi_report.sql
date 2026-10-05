-- 0228_urpi_report.sql — resultados de entrega que reporta Urpi (MOM §30.11).
--
-- Urpi exporta desde su AppSheet una fila por INTENTO, con su número de fila
-- («_RowNumber») como identidad y «Row number relacionado» apuntando al intento
-- anterior. No trae código de pedido: Kapta lo vincula por teléfono y fecha
-- (lib/urpi-report-link.ts) y deja a revisión lo que no es único.
--
-- Qué guarda y qué no:
--   * Cada fila de Urpi tal como llegó (data), y una VERSIÓN por cada cambio:
--     reimportar el mismo contenido no duplica nada y nunca se borra historial.
--   * El vínculo con el pedido. Uno elegido a mano no lo pisa ninguna lectura.
--   * No crea salidas, no cambia estados ni mueve dinero. La entrega se aplica
--     al Master aparte, por la única puerta (lib/master-door.ts).
-- Kenku y Aurela comparten organización y libro de Urpi: la fila es de la
-- organización y queda en su tienda al vincularse.

create table if not exists public.urpi_report_imports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  filename text,
  row_count integer not null default 0 check (row_count between 0 and 20000),
  new_count integer not null default 0,
  changed_count integer not null default 0
);
create index if not exists urpi_report_imports_org_created on public.urpi_report_imports(org_id, created_at desc);

create table if not exists public.urpi_report_rows (
  org_id uuid not null references public.organizations(id),
  urpi_row integer not null check (urpi_row > 0),
  previous_row integer check (previous_row is null or previous_row > 0),
  report_date date,
  result_code text not null check (result_code in ('entregado','reprogramado','cancelado','programado','en_coordinacion','sin_resultado','otro')),
  phone text check (phone is null or phone ~ '^9[0-9]{8}$'),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  order_id uuid references public.orders(id),
  store_id uuid references public.stores(id),
  link_status text not null check (link_status in ('vinculado','varios','sin_pedido','sin_telefono')),
  link_method text check (link_method in ('telefono','cadena','manual')),
  candidate_order_ids uuid[] not null default '{}',
  linked_by uuid references auth.users(id),
  linked_at timestamptz,
  first_import_id uuid not null references public.urpi_report_imports(id),
  last_import_id uuid not null references public.urpi_report_imports(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, urpi_row),
  check ((order_id is null) = (store_id is null)),
  check ((link_status = 'vinculado') = (order_id is not null))
);
create index if not exists urpi_report_rows_order on public.urpi_report_rows(order_id) where order_id is not null;
create index if not exists urpi_report_rows_previous on public.urpi_report_rows(org_id, previous_row) where previous_row is not null;
create index if not exists urpi_report_rows_result on public.urpi_report_rows(org_id, result_code, report_date desc);

create table if not exists public.urpi_report_row_versions (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  urpi_row integer not null,
  import_id uuid not null references public.urpi_report_imports(id),
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (org_id, urpi_row) references public.urpi_report_rows(org_id, urpi_row)
);
create index if not exists urpi_report_versions_row on public.urpi_report_row_versions(org_id, urpi_row, created_at);

alter table public.urpi_report_imports enable row level security;
alter table public.urpi_report_rows enable row level security;
alter table public.urpi_report_row_versions enable row level security;
revoke all on public.urpi_report_imports, public.urpi_report_rows, public.urpi_report_row_versions from anon, authenticated;
grant select on public.urpi_report_imports, public.urpi_report_rows, public.urpi_report_row_versions to authenticated;
grant all on public.urpi_report_imports, public.urpi_report_rows, public.urpi_report_row_versions to service_role;

-- Una fila vinculada se lee con la tienda; una sin vincular, con la organización
-- (todavía no se sabe de qué tienda es y alguien tiene que elegir el pedido).
drop policy if exists urpi_report_imports_read on public.urpi_report_imports;
create policy urpi_report_imports_read on public.urpi_report_imports for select to authenticated
  using (org_id in (select public.auth_org_ids()));
drop policy if exists urpi_report_rows_read on public.urpi_report_rows;
create policy urpi_report_rows_read on public.urpi_report_rows for select to authenticated
  using (org_id in (select public.auth_org_ids())
    and (store_id is null or store_id in (select public.auth_store_ids())));
drop policy if exists urpi_report_versions_read on public.urpi_report_row_versions;
create policy urpi_report_versions_read on public.urpi_report_row_versions for select to authenticated
  using (exists (select 1 from public.urpi_report_rows r
    where r.org_id = urpi_report_row_versions.org_id and r.urpi_row = urpi_report_row_versions.urpi_row
      and r.org_id in (select public.auth_org_ids())
      and (r.store_id is null or r.store_id in (select public.auth_store_ids()))));

-- El pedido vinculado debe ser de una tienda de la misma organización.
create or replace function public.urpi_report_order_in_org(p_org_id uuid, p_order_id uuid, p_store_id uuid)
returns boolean language sql stable security invoker set search_path = public as $$
  select p_order_id is null or exists (
    select 1 from public.orders o join public.stores s on s.id = o.store_id
     where o.id = p_order_id and o.store_id = p_store_id and s.org_id = p_org_id)
$$;

-- Un lote de filas, atómico: fila nueva → fila + versión; contenido distinto →
-- versión + fila; vínculo distinto → vínculo, salvo que sea manual. Solo el
-- servidor lo llama, después de comprobar el permiso del usuario.
create or replace function public.save_urpi_report_batch(p_org_id uuid, p_import_id uuid, p_rows jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  r record;
  cur public.urpi_report_rows;
  n_new integer := 0;
  n_changed integer := 0;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 1000 then raise exception 'invalid_batch'; end if;
  perform 1 from public.urpi_report_imports where id = p_import_id and org_id = p_org_id;
  if not found then raise exception 'invalid_import'; end if;
  for r in select * from jsonb_to_recordset(p_rows) as x(
    urpi_row integer, previous_row integer, report_date date, result_code text, phone text, data jsonb, digest text,
    order_id uuid, store_id uuid, link_status text, link_method text, candidate_order_ids uuid[])
  loop
    if not public.urpi_report_order_in_org(p_org_id, r.order_id, r.store_id) then raise exception 'invalid_order_scope'; end if;
    select * into cur from public.urpi_report_rows where org_id = p_org_id and urpi_row = r.urpi_row for update;
    if not found then
      insert into public.urpi_report_rows(org_id, urpi_row, previous_row, report_date, result_code, phone, data, digest,
        order_id, store_id, link_status, link_method, candidate_order_ids, linked_at, first_import_id, last_import_id)
      values (p_org_id, r.urpi_row, r.previous_row, r.report_date, r.result_code, r.phone, r.data, r.digest,
        r.order_id, r.store_id, r.link_status, r.link_method, coalesce(r.candidate_order_ids, '{}'),
        case when r.order_id is not null then now() end, p_import_id, p_import_id);
      insert into public.urpi_report_row_versions(org_id, urpi_row, import_id, digest, data)
        values (p_org_id, r.urpi_row, p_import_id, r.digest, r.data);
      n_new := n_new + 1;
      continue;
    end if;
    if cur.digest is distinct from r.digest then
      insert into public.urpi_report_row_versions(org_id, urpi_row, import_id, digest, data)
        values (p_org_id, r.urpi_row, p_import_id, r.digest, r.data);
      update public.urpi_report_rows set previous_row = r.previous_row, report_date = r.report_date,
          result_code = r.result_code, phone = r.phone, data = r.data, digest = r.digest,
          last_import_id = p_import_id, updated_at = now()
        where org_id = p_org_id and urpi_row = r.urpi_row;
      n_changed := n_changed + 1;
    end if;
    if cur.link_method is distinct from 'manual' and (cur.order_id is distinct from r.order_id
        or cur.link_status is distinct from r.link_status or cur.link_method is distinct from r.link_method
        or cur.candidate_order_ids is distinct from coalesce(r.candidate_order_ids, '{}')) then
      update public.urpi_report_rows set order_id = r.order_id, store_id = r.store_id, link_status = r.link_status,
          link_method = r.link_method, candidate_order_ids = coalesce(r.candidate_order_ids, '{}'),
          linked_by = null, linked_at = case when r.order_id is distinct from cur.order_id then
            case when r.order_id is not null then now() end else cur.linked_at end,
          updated_at = now()
        where org_id = p_org_id and urpi_row = r.urpi_row;
    end if;
  end loop;
  update public.urpi_report_imports set new_count = new_count + n_new, changed_count = changed_count + n_changed
    where id = p_import_id;
  return jsonb_build_object('new', n_new, 'changed', n_changed);
end $$;

-- Vínculo elegido a mano: toda la cadena de intentos (hacia atrás y hacia
-- delante) es el mismo pedido. Pasa a manual y ninguna lectura lo cambia.
create or replace function public.link_urpi_report_chain(p_org_id uuid, p_urpi_row integer, p_order_id uuid, p_store_id uuid, p_actor uuid)
returns integer language plpgsql security invoker set search_path = public as $$
declare
  root integer;
  touched integer;
begin
  if p_order_id is null or not public.urpi_report_order_in_org(p_org_id, p_order_id, p_store_id) then raise exception 'invalid_order_scope'; end if;
  perform 1 from public.urpi_report_rows where org_id = p_org_id and urpi_row = p_urpi_row;
  if not found then raise exception 'row_not_found'; end if;
  with recursive up(urpi_row, previous_row, depth) as (
    select urpi_row, previous_row, 0 from public.urpi_report_rows where org_id = p_org_id and urpi_row = p_urpi_row
    union all
    select r.urpi_row, r.previous_row, up.depth + 1 from public.urpi_report_rows r
      join up on r.org_id = p_org_id and r.urpi_row = up.previous_row where up.depth < 100
  )
  select urpi_row into root from up order by depth desc limit 1;
  with recursive chain(urpi_row, depth) as (
    select root, 0
    union all
    select r.urpi_row, chain.depth + 1 from public.urpi_report_rows r
      join chain on r.org_id = p_org_id and r.previous_row = chain.urpi_row where chain.depth < 100
  )
  update public.urpi_report_rows t set order_id = p_order_id, store_id = p_store_id, link_status = 'vinculado',
      link_method = 'manual', candidate_order_ids = '{}', linked_by = p_actor, linked_at = now(), updated_at = now()
    from chain where t.org_id = p_org_id and t.urpi_row = chain.urpi_row;
  get diagnostics touched = row_count;
  return touched;
end $$;

revoke all on function public.urpi_report_order_in_org(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.save_urpi_report_batch(uuid,uuid,jsonb) from public, anon, authenticated;
revoke all on function public.link_urpi_report_chain(uuid,integer,uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.urpi_report_order_in_org(uuid,uuid,uuid) to service_role;
grant execute on function public.save_urpi_report_batch(uuid,uuid,jsonb) to service_role;
grant execute on function public.link_urpi_report_chain(uuid,integer,uuid,uuid,uuid) to service_role;
