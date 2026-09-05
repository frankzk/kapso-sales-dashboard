-- ============================================================================
-- 0135_courier_lima_districts_from_master.sql
-- La matriz de Grupo GF Courier usa los distritos que realmente aparecen en
-- pedidos clasificados con coverage = 'lima', no el catálogo geográfico
-- parcial acumulado por reportes de courier.
--
-- El campo district del histórico contiene alias y, en filas antiguas,
-- referencias completas. Por eso nunca se copia en crudo: se resuelve con la
-- misma verdad canónica que clasifica la cobertura (`resolve_lima_district`).
-- Lurigancho–Chosica se muestra como una sola tarifa: Lurigancho.
-- ============================================================================

-- La tarifa conserva FK hacia peru_districts. Sembramos los nombres canónicos
-- para que cualquier distrito válido que aparezca mañana pueda configurarse sin
-- depender de que antes haya llegado en un Excel de Aliclik.
insert into peru_districts (
  district_key,
  district,
  province,
  department,
  source
)
select
  d.district_key,
  initcap(d.district_key),
  case
    when d.district_key = any(array[
      'bellavista','callao','carmen de la legua reynoso','la perla','la punta',
      'mi peru','ventanilla'
    ]) then 'Callao'
    else 'Lima'
  end,
  'Lima',
  'manual'
from unnest(lima_districts()) as d(district_key)
on conflict (district_key) do nothing;

create or replace function courier_lima_districts(p_org_id uuid)
returns table (
  district_key text,
  district text,
  province text,
  department text,
  order_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with resolved as (
    select
      case
        when resolve_lima_district(om.district, true) = 'lurigancho chosica'
          then 'lurigancho'
        else resolve_lima_district(om.district, true)
      end as district_key
    from order_master om
    join stores s on s.id = om.store_id
    where s.org_id = p_org_id
      and om.coverage = 'lima'
  ), counted as (
    select r.district_key, count(*)::bigint as order_count
    from resolved r
    where r.district_key is not null
    group by r.district_key
  )
  select
    c.district_key,
    case c.district_key
      when 'ancon' then 'Ancón'
      when 'brena' then 'Breña'
      when 'carmen de la legua reynoso' then 'Carmen de la Legua Reynoso'
      when 'el agustino' then 'El Agustino'
      when 'jesus maria' then 'Jesús María'
      when 'la molina' then 'La Molina'
      when 'la perla' then 'La Perla'
      when 'la punta' then 'La Punta'
      when 'la victoria' then 'La Victoria'
      when 'los olivos' then 'Los Olivos'
      when 'lurin' then 'Lurín'
      when 'magdalena del mar' then 'Magdalena del Mar'
      when 'mi peru' then 'Mi Perú'
      when 'pachacamac' then 'Pachacámac'
      when 'rimac' then 'Rímac'
      when 'san juan de lurigancho' then 'San Juan de Lurigancho'
      when 'san juan de miraflores' then 'San Juan de Miraflores'
      when 'san martin de porres' then 'San Martín de Porres'
      when 'santa maria del mar' then 'Santa María del Mar'
      when 'santiago de surco' then 'Santiago de Surco'
      when 'villa maria del triunfo' then 'Villa María del Triunfo'
      else initcap(c.district_key)
    end as district,
    p.province,
    p.department,
    c.order_count
  from counted c
  join peru_districts p on p.district_key = c.district_key
  order by p.district;
$$;

comment on function courier_lima_districts(uuid) is
  'Distritos canónicos presentes en pedidos coverage=lima de una organización, con alias resueltos y frecuencia histórica.';

revoke all on function courier_lima_districts(uuid) from public, anon, authenticated;
grant execute on function courier_lima_districts(uuid) to service_role;
