-- ============================================================================
-- 0327_order_master_lima_provinces_agencia.sql — las provincias de Lima fuera
-- de la capital quedan como «agencia» en la cobertura GUARDADA del Master
-- (MOM §19.0.4; owner, 09-11-2026: «huaral es de cobertura Agencia, para que
-- corrijas en el filtro»).
--
-- POR QUÉ. La fila del Master ya decía «Agencia» para Huaral, Barranca, Cañete…
-- (la guarda de lectura `withRuntimeCoverage`), pero el filtro «Cobertura» y
-- los conteos leen `order_master.coverage`, que escribe el trigger
-- `order_master_set_coverage` (0083) con `order_coverage_for`. Esa función no
-- conoce la regla (solo Cañete), así que #KP204248 (Huaral) quedaba en «lima»
-- y otros en «provincia_cod». Corregir la columna a mano no sirve: el trigger
-- la recalcula en cada guardado.
--
-- QUÉ CAMBIA.
--   * `is_non_metro_lima_location(province, district)`: la misma regla que
--     `isNonMetroLimaLocation` (lib/order-coverage.ts): las nueve provincias
--     (Barranca, Cajatambo, Cañete, Canta, Huaral, Huarochirí, Huaura, Oyón,
--     Yauyos) por provincia o por distrito, también como palabra suelta del
--     distrito, salvo que la dirección sea del Callao («Curva canta Callao»).
--   * El trigger del Master: si la regla se cumple, «agencia»; si no, lo de
--     siempre (`order_coverage_for`).
--   * Recalcula las filas del Master que hoy no están en «agencia» y cumplen
--     la regla (107 el 09-11-2026).
--
-- LO QUE NO CAMBIA. `order_coverage_for` (la usan leads, Aliclik y otras
-- pantallas) queda igual: solo cambia lo que se guarda en el Master, lo mismo
-- que ya se veía en la fila. Correrla otra vez no cambia nada.
-- ============================================================================

create or replace function public.is_non_metro_lima_location(p_province text, p_district text)
returns boolean
language plpgsql
immutable
parallel safe
set search_path to 'public'
as $$
declare
  v_set constant text[] := array['barranca', 'cajatambo', 'canete', 'canta', 'huaral', 'huarochiri', 'huaura', 'oyon', 'yauyos'];
  v_province text := coverage_norm(p_province);
  v_district text := coverage_norm(p_district);
  v_words text[] := string_to_array(coverage_norm(p_district), ' ');
begin
  if v_province = any (v_set) then return true; end if;
  if v_province = 'canete' or v_district = 'canete' or v_district like '% canete%' then return true; end if;
  if v_district = any (v_set) then return true; end if;
  -- Una palabra suelta del distrito no basta si la dirección es del Callao.
  if v_province = 'callao' or 'callao' = any (v_words) then return false; end if;
  return coalesce(v_words && v_set, false);
end;
$$;

comment on function public.is_non_metro_lima_location(text, text) is
  'Provincias del departamento de Lima fuera de la metropolitana (van por agencia). Espejo de isNonMetroLimaLocation (lib/order-coverage.ts).';

create or replace function public.order_master_set_coverage()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
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

  -- (0327) Las provincias de Lima fuera de la capital van por agencia.
  if is_non_metro_lima_location(new.province, new.district) then
    new.coverage := 'agencia';
    return new;
  end if;

  new.coverage := order_coverage_for(
    new.store_id, new.region, new.province, new.district,
    new.latitude, new.longitude, current_date
  );
  return new;
end;
$$;

-- Las filas que ya estaban guardadas con la cobertura vieja.
update public.order_master
   set coverage = 'agencia'
 where coverage is distinct from 'agencia'
   and is_non_metro_lima_location(province, district);
