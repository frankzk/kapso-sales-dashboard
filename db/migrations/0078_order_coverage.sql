-- 0078 — Clasificación operativa de cobertura en el Master de Pedidos.
--
-- Lima significa únicamente Lima Metropolitana y Callao. Las provincias del
-- departamento de Lima (Huaral, Cañete, Barranca, etc.) siguen la misma regla
-- que el resto del país: Provincia COD si una tarifa vigente demuestra
-- cobertura contraentrega; Agencia en caso contrario.

alter table order_master
  add column if not exists coverage text;

alter table order_master drop constraint if exists order_master_coverage_check;
alter table order_master
  add constraint order_master_coverage_check
  check (coverage in ('lima', 'provincia_cod', 'agencia', 'por_revisar'));

create index if not exists order_master_store_coverage_idx
  on order_master(store_id, coverage);

create or replace function coverage_norm(value text)
returns text
language sql
immutable
parallel safe
as $$
  select trim(regexp_replace(
    translate(lower(coalesce(value, '')), 'áéíóúüñ', 'aeiouun'),
    '[^a-z0-9]+', ' ', 'g'
  ));
$$;

create or replace function order_coverage_for(
  p_store_id uuid,
  p_region text,
  p_province text,
  p_district text,
  p_day date default current_date
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_region text := coverage_norm(p_region);
  v_province text := coverage_norm(p_province);
  v_district text := coverage_norm(p_district);
begin
  if v_region = '' or v_province = '' or v_district = '' then
    return 'por_revisar';
  end if;

  if (
    v_region = 'lima'
    and v_province = any(array['lima', 'lima metropolitana'])
    and v_district = any(array[
      'ancon','ate','barranco','brena','carabayllo','chaclacayo','chorrillos',
      'cieneguilla','comas','el agustino','independencia','jesus maria',
      'la molina','la victoria','lima','lince','los olivos','lurigancho','lurigancho chosica',
      'lurin','magdalena del mar','miraflores','pachacamac','pucusana',
      'pueblo libre','puente piedra','punta hermosa','punta negra','rimac',
      'san bartolo','san borja','san isidro','san juan de lurigancho',
      'san juan de miraflores','san luis','san martin de porres','san miguel',
      'santa anita','santa maria del mar','santa rosa','santiago de surco',
      'surquillo','villa el salvador','villa maria del triunfo'
    ])
  ) or (
    (v_region like '%callao%' or v_province like '%callao%')
    and v_district = any(array[
      'bellavista','callao','carmen de la legua reynoso','la perla','la punta',
      'mi peru','ventanilla'
    ])
  ) then
    return 'lima';
  end if;

  select org_id into v_org_id from stores where id = p_store_id;

  if exists (
    select 1
    from cost_tariffs t
    where t.org_id = v_org_id
      and t.concept = 'primer_intento'
      and t.courier is not null
      and coverage_norm(t.courier) not in ('shalom', 'olva', 'olva courier')
      and (t.region is not null or t.province is not null or t.district is not null)
      and t.effective_from <= p_day
      and (t.effective_to is null or t.effective_to >= p_day)
      and (t.store_id is null or t.store_id = p_store_id)
      and (t.region is null or coverage_norm(t.region) = v_region)
      and (t.province is null or coverage_norm(t.province) = v_province)
      and (t.district is null or coverage_norm(t.district) = v_district)
  ) then
    return 'provincia_cod';
  end if;

  return 'agencia';
end;
$$;

create or replace function refresh_order_coverage(p_org_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update order_master om
  set coverage = order_coverage_for(
    om.store_id, om.region, om.province, om.district, current_date
  )
  where p_org_id is null
     or exists (
       select 1 from stores s
       where s.id = om.store_id and s.org_id = p_org_id
     );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function order_coverage_for(uuid, text, text, text, date)
  from public, anon, authenticated;
revoke all on function refresh_order_coverage(uuid)
  from public, anon, authenticated;
grant execute on function order_coverage_for(uuid, text, text, text, date)
  to service_role;
grant execute on function refresh_order_coverage(uuid)
  to service_role;

-- Autocompletado conservador: solo tienda + teléfono con un único antecedente
-- geográfico y al menos dos pedidos coincidentes, o una corrección manual.
with eligible as (
  select
    store_id,
    customer_phone,
    min(region) as region,
    min(province) as province,
    min(district) as district
  from order_master
  where customer_phone is not null
    and region is not null
    and province is not null
    and district is not null
  group by store_id, customer_phone
  having count(distinct (
    coverage_norm(region) || '|' ||
    coverage_norm(province) || '|' ||
    coverage_norm(district)
  )) = 1
  and (count(*) >= 2 or bool_or(geo_source = 'manual'))
)
update order_master om
set
  region = coalesce(om.region, e.region),
  province = coalesce(om.province, e.province),
  district = coalesce(om.district, e.district),
  geo_source = case
    when om.region is null or om.province is null or om.district is null
      then 'history'
    else om.geo_source
  end
from eligible e
where om.store_id = e.store_id
  and om.customer_phone = e.customer_phone
  and (om.region is null or om.province is null or om.district is null);

select refresh_order_coverage(null);

-- Facetas del Master, ahora también con cobertura.
create or replace function master_facets(p_store_ids uuid[])
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'operational', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct operational_status as v
        from order_master where store_id = any(p_store_ids) and operational_status is not null
      ) q
    ), '[]'::jsonb),
    'courier', coalesce((
      select jsonb_agg(v order by v) from (
        select current_courier as v from order_master
        where store_id = any(p_store_ids) and current_courier is not null
        union
        select last_courier as v from order_master
        where store_id = any(p_store_ids) and last_courier is not null
      ) q
    ), '[]'::jsonb),
    'region', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct region as v from order_master
        where store_id = any(p_store_ids) and region is not null
      ) q
    ), '[]'::jsonb),
    'province', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct province as v from order_master
        where store_id = any(p_store_ids) and province is not null
      ) q
    ), '[]'::jsonb),
    'district', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct district as v from order_master
        where store_id = any(p_store_ids) and district is not null
      ) q
    ), '[]'::jsonb),
    'coverage', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct coverage as v from order_master
        where store_id = any(p_store_ids) and coverage is not null
      ) q
    ), '[]'::jsonb),
    'pickup', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct pickup_state as v from order_master
        where store_id = any(p_store_ids) and pickup_state is not null
      ) q
    ), '[]'::jsonb)
  );
$$;

grant execute on function master_facets(uuid[]) to authenticated;
