-- 0079 — La cobertura se decide por REGIÓN, no por provincia.
--
-- Qué estaba mal en la 0078:
--
--   1. Perú tiene DOS subdivisiones llamadas Lima y Shopify manda su nombre
--      completo: "Lima (provincia)" (PE-LMA, = Lima Metropolitana) y
--      "Lima (departamento)" (PE-LIM, = Huaral, Cañete, Yauyos, Barranca…).
--      `coverage_norm` las deja en 'lima provincia' y 'lima departamento', y la
--      regla exigía region = 'lima' exacto: NINGÚN pedido de Lima podía salir
--      clasificado como Lima. Un pedido Lima (provincia) / Lima / San Isidro
--      terminaba en "Provincia COD".
--
--   2. Exigir las tres columnas mandaba a "Por revisar" pedidos que ya se
--      sabían: Shopify Perú solo entrega distrito (city) y departamento
--      (province). La provincia del ubigeo se completa desde `peru_districts`,
--      que está sembrada solo con lo que dejaron los Excels de Aliclik, así que
--      para media Lima Metropolitana está vacía → Pueblo Libre y Chorrillos con
--      región "Lima (provincia)" quedaban Por revisar.
--
--   3. `peru_districts` tiene el nombre del distrito como clave primaria, pero
--      en Perú los nombres se repiten entre departamentos: Independencia existe
--      en Lima, en Huaraz (Áncash) y en Pisco (Ica). El backfill se queda con
--      la provincia más frecuente, así que a un pedido de Independencia con
--      región "Lima (provincia)" le pegaba provincia "Huaraz" y lo clasificaba
--      Provincia COD contradiciendo su propia región.
--
-- Regla nueva, en orden de fiabilidad: región → provincia → distrito. La
-- provincia deja de ser requisito; solo desempata cuando la región dice "Lima"
-- a secas. "Por revisar" queda para lo que de verdad no se puede ubicar: sin
-- región utilizable y sin distrito.

-- Clasifica la región respecto de Lima:
--   'metropolitana' | 'callao' | 'departamento' | 'lima' (ambigua) | null
create or replace function lima_region_kind(p_region text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when coverage_norm(p_region) = '' then null
    when coverage_norm(p_region) in ('cal', 'pe cal') then 'callao'
    when coverage_norm(p_region) in ('lma', 'pe lma') then 'metropolitana'
    when coverage_norm(p_region) in ('lim', 'pe lim') then 'departamento'
    when coverage_norm(p_region) like '%callao%' then 'callao'
    when coverage_norm(p_region) not like '%lima%' then null
    when coverage_norm(p_region) like '%provincia%'
      or coverage_norm(p_region) like '%metropolitan%' then 'metropolitana'
    when coverage_norm(p_region) like '%departamento%'
      or coverage_norm(p_region) like '%depto%'
      or coverage_norm(p_region) like '%dpto%'
      or coverage_norm(p_region) like '%region%' then 'departamento'
    else 'lima'
  end;
$$;

create or replace function is_lima_metropolitana(
  p_region text,
  p_province text,
  p_district text
)
returns boolean
language plpgsql
immutable
parallel safe
as $$
declare
  v_kind text := lima_region_kind(p_region);
  v_province text := coverage_norm(p_province);
  v_district text := coverage_norm(p_district);
  v_in_lima boolean;
begin
  if v_kind in ('metropolitana', 'callao') then
    return true;
  end if;
  if v_kind = 'departamento' then
    return false;
  end if;

  v_in_lima := v_district = any(array[
    -- Lima Metropolitana (43 distritos)
    'ancon','ate','barranco','brena','carabayllo','chaclacayo','chorrillos',
    'cieneguilla','comas','el agustino','independencia','jesus maria',
    'la molina','la victoria','lima','lince','los olivos','lurigancho','lurigancho chosica',
    'lurin','magdalena del mar','miraflores','pachacamac','pucusana',
    'pueblo libre','puente piedra','punta hermosa','punta negra','rimac',
    'san bartolo','san borja','san isidro','san juan de lurigancho',
    'san juan de miraflores','san luis','san martin de porres','san miguel',
    'santa anita','santa maria del mar','santa rosa','santiago de surco',
    'surquillo','villa el salvador','villa maria del triunfo',
    -- Callao (7 distritos)
    'bellavista','callao','carmen de la legua reynoso','la perla','la punta',
    'mi peru','ventanilla'
  ]);

  -- Región "Lima" a secas: el distrito desempata entre la metropolitana y el
  -- resto del departamento.
  if v_kind = 'lima' then
    return v_in_lima;
  end if;

  -- Región de otro departamento: no es Lima aunque el distrito se llame igual
  -- que uno de Lima (Independencia/Huaraz, La Victoria/Chiclayo…).
  if coverage_norm(p_region) <> '' then
    return false;
  end if;

  -- Sin región: la provincia manda si es concluyente.
  if (v_province in ('lima', 'lima metropolitana') or v_province like '%callao%') and v_in_lima then
    return true;
  end if;

  -- Último recurso: un distrito cuyo nombre NO se repita en otro departamento.
  return v_in_lima and v_district <> all(array[
    'bellavista','independencia','la victoria','miraflores','pueblo libre',
    'san luis','san miguel','santa rosa'
  ]);
end;
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
  if is_lima_metropolitana(p_region, p_province, p_district) then
    return 'lima';
  end if;

  -- Sin distrito no hay a dónde despachar ni tarifa que consultar.
  if v_district = '' then
    return 'por_revisar';
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

revoke all on function lima_region_kind(text) from public, anon, authenticated;
revoke all on function is_lima_metropolitana(text, text, text) from public, anon, authenticated;
revoke all on function order_coverage_for(uuid, text, text, text, date)
  from public, anon, authenticated;
grant execute on function lima_region_kind(text) to service_role;
grant execute on function is_lima_metropolitana(text, text, text) to service_role;
grant execute on function order_coverage_for(uuid, text, text, text, date)
  to service_role;

-- Reclasifica todo lo ya materializado con la regla nueva.
select refresh_order_coverage(null);
