-- 0100 — La cobertura COD se decide por COORDENADA, no solo por nombre.
--
-- EL PROBLEMA. `order_coverage_for` probaba cobertura COD casando el nombre del
-- distrito del pedido contra `cost_tariffs`. Pero el nombre no es de fiar:
-- Shopify guarda "Puerto Maldonado" (la ciudad) y Aliclik factura "Tambopata"
-- (el distrito). Nunca casan, y 130 pedidos de Puerto Maldonado —con cobertura
-- COD real (18,50, 161 envíos)— caían a "agencia", mandando al cliente a
-- recoger cuando se le podía entregar en la puerta. El mismo choque afecta a
-- Coronel Portillo (Pucallpa), San Román (Juliaca) y otras capitales.
--
-- LA IDEA. Aliclik resuelve la ubicación por lat/lng, no por texto. Nosotros
-- tenemos coordenada en el 99,6% de los pedidos. Así que además del match por
-- nombre, se comprueba si el pedido cae CERCA de un punto donde Aliclik ya
-- entregó COD. Validado con datos: los casos cubiertos están a <2 km de un
-- punto COD; los que son de verdad agencia (Huanta, Nazca, Camaná), a >20 km.
-- El hueco es tan limpio que un umbral de 10 km no se equivoca.
--
-- SIN PostGIS. La base solo tiene pg_trgm, así que la distancia va con haversine
-- a mano y un pre-filtro por caja (lat/lng ± grados) que el índice sí aprovecha.

-- ---------------------------------------------------------------------------
-- 1. El mapa de puntos COD: dónde Aliclik ya entregó a domicilio.
-- ---------------------------------------------------------------------------
create table if not exists aliclik_cod_points (
  org_id uuid not null,
  lat double precision not null,
  lng double precision not null,
  primary key (org_id, lat, lng)
);

-- El pre-filtro por caja filtra por (org_id, lat) y luego acota lng; este índice
-- lo cubre. Los puntos están redondeados a ~1,1 km (2 decimales), así que la
-- tabla es pequeña y la búsqueda toca un puñado de filas por pedido.
create index if not exists aliclik_cod_points_org_lat_lng
  on aliclik_cod_points (org_id, lat, lng);

-- Reconstruye el mapa desde las guías Aliclik con coordenada que son COD:
-- o bien tuvieron una cotización COD (quoted_delivery_cost), o bien su distrito
-- tiene una tarifa COD viva. Se redondea a 2 decimales para deduplicar por zona.
create or replace function refresh_aliclik_cod_points(p_org_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from aliclik_cod_points p
  where p_org_id is null or p.org_id = p_org_id;

  insert into aliclik_cod_points (org_id, lat, lng)
  select distinct
    st.org_id,
    round(s.latitude::numeric, 2)::double precision,
    round(s.longitude::numeric, 2)::double precision
  from shipments s
  join stores st on st.id = s.store_id
  where s.latitude is not null
    and s.longitude is not null
    and coverage_norm(s.courier) like '%ali%'
    and (p_org_id is null or st.org_id = p_org_id)
    and (
      s.quoted_delivery_cost is not null
      or exists (
        select 1
        from cost_tariffs t
        where t.org_id = st.org_id
          and t.concept = 'primer_intento'
          and coverage_norm(t.courier) not in ('shalom', 'olva', 'olva courier')
          and t.district is not null
          and (t.effective_to is null or t.effective_to >= current_date)
          and coverage_norm(t.district) = coverage_norm(s.district)
      )
    )
  on conflict do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ¿Hay algún punto COD a menos de p_km de (p_lat, p_lng)?
-- Caja de bounding primero (barata, indexada), haversine después (exacta).
create or replace function aliclik_cod_point_near(
  p_org_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_km double precision
)
returns boolean
language sql
stable
parallel safe
set search_path = public
as $$
  select case
    when p_org_id is null or p_lat is null or p_lng is null or abs(p_lat) >= 89 then false
    else exists (
      select 1
      from aliclik_cod_points p
      where p.org_id = p_org_id
        and p.lat between p_lat - (p_km / 111.0) and p_lat + (p_km / 111.0)
        and p.lng between p_lng - (p_km / (111.0 * cos(radians(p_lat))))
                      and p_lng + (p_km / (111.0 * cos(radians(p_lat))))
        and 6371.0 * acos(least(1.0, greatest(-1.0,
              sin(radians(p_lat)) * sin(radians(p.lat)) +
              cos(radians(p_lat)) * cos(radians(p.lat)) * cos(radians(p.lng - p_lng))
            ))) <= p_km
    )
  end;
$$;

-- ---------------------------------------------------------------------------
-- 2. La clasificación, ahora con coordenada.
-- ---------------------------------------------------------------------------
create or replace function order_coverage_for(
  p_store_id uuid,
  p_region text,
  p_province text,
  p_district text,
  p_lat double precision,
  p_lng double precision,
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
  -- Regla comercial explícita. Gana incluso a una tarifa o a un punto cercano.
  if v_province = 'canete' or v_district = 'canete' or v_district like '% canete' then
    return 'agencia';
  end if;

  if is_lima_metropolitana(p_region, p_province, p_district) then
    return 'lima';
  end if;

  select org_id into v_org_id from stores where id = p_store_id;

  -- COD por nombre: la tarifa casa por región/provincia/distrito.
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

  -- COD por coordenada: cae cerca de donde Aliclik ya entregó COD. Resuelve el
  -- choque de nombres (Puerto Maldonado ≡ Tambopata) sin listas que mantener.
  -- Funciona incluso sin distrito legible, porque la coordenada no lo necesita.
  if aliclik_cod_point_near(v_org_id, p_lat, p_lng, 10.0) then
    return 'provincia_cod';
  end if;

  -- Sin distrito ni coordenada útil no hay a dónde despachar ni cómo ubicarlo.
  if v_district = '' then
    return 'por_revisar';
  end if;

  return 'agencia';
end;
$$;

-- La firma vieja (sin coordenada) queda como envoltorio: cualquier llamador
-- externo sigue funcionando, solo que sin el desempate por cercanía.
create or replace function order_coverage_for(
  p_store_id uuid,
  p_region text,
  p_province text,
  p_district text,
  p_day date default current_date
)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select order_coverage_for(
    p_store_id, p_region, p_province, p_district,
    null::double precision, null::double precision, p_day
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Recalculo y trigger pasan la coordenada.
-- ---------------------------------------------------------------------------
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
    om.store_id, om.region, om.province, om.district,
    om.latitude, om.longitude, current_date
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

create or replace function order_master_set_coverage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Igual que antes, se evita recalcular si nada relevante cambió — pero ahora
  -- la COORDENADA también cuenta: corregir el pin puede cambiar la cobertura.
  if tg_op = 'UPDATE'
    and new.store_id is not distinct from old.store_id
    and new.region   is not distinct from old.region
    and new.province is not distinct from old.province
    and new.district is not distinct from old.district
    and new.latitude  is not distinct from old.latitude
    and new.longitude is not distinct from old.longitude
    and new.coverage is not distinct from old.coverage
  then
    return new;
  end if;

  new.coverage := order_coverage_for(
    new.store_id, new.region, new.province, new.district,
    new.latitude, new.longitude, current_date
  );
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Permisos.
-- ---------------------------------------------------------------------------
revoke all on function refresh_aliclik_cod_points(uuid) from public, anon, authenticated;
revoke all on function aliclik_cod_point_near(uuid, double precision, double precision, double precision)
  from public, anon, authenticated;
revoke all on function order_coverage_for(uuid, text, text, text, double precision, double precision, date)
  from public, anon, authenticated;
grant execute on function refresh_aliclik_cod_points(uuid) to service_role;
grant execute on function aliclik_cod_point_near(uuid, double precision, double precision, double precision)
  to service_role;
grant execute on function order_coverage_for(uuid, text, text, text, double precision, double precision, date)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. Construir el mapa y reclasificar todo.
-- ---------------------------------------------------------------------------
select refresh_aliclik_cod_points(null);
select refresh_order_coverage(null);
