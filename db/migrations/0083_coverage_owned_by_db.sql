-- 0083 — La cobertura la decide la BASE, no el build que esté desplegado.
--
-- Por qué: `order_master.coverage` la escribía solo la aplicación
-- (`classifyOrderCoverage` en lib/order-coverage.ts) y la pasada del Master
-- reescribe la tabla entera cada vez. Eso deja la columna a merced de QUÉ build
-- está sirviendo producción: un deploy desde una rama vieja —hecho con
-- `vercel --prod` desde la CLI, sin pasar por main ni por CI— vuelve a la regla
-- anterior a la 0079, que exigía las tres columnas:
--
--     if (!location.region || !location.province || !location.district)
--       return "por_revisar";
--
-- Shopify Perú no manda la provincia (solo distrito y departamento), así que con
-- esa regla TODO pedido cuya provincia esté vacía cae en "Por revisar": Arequipa
-- / Camaná, La Libertad / Huamachuco y Lima (provincia) / Chorrillos por igual.
-- Ha pasado dos veces, y las dos la base tenía la clasificación correcta
-- mientras la columna materializada decía lo contrario.
--
-- Arreglo: `order_coverage_for` ya es la definición canónica y vive aquí, así
-- que la columna pasa a ser derivada de verdad. Un trigger la recalcula en cada
-- insert/update y descarta el valor que mande la aplicación. La pasada del
-- Master sigue enviando su `coverage` —no hace falta cambiarla— pero ya no puede
-- corromper la columna, venga del build que venga.
--
-- No sustituye a desactivar los deploys de CLI a producción; es la red debajo.

create or replace function order_master_set_coverage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Sin cambios en la geografía ni en la cobertura no hay nada que recalcular:
  -- la pasada del Master reescribe las ~10k filas cada vez y `order_coverage_for`
  -- cuesta ~0,3 ms por fila. Si la aplicación manda una cobertura distinta a la
  -- guardada, sí se recalcula: es justo el caso que esta migración ataja.
  if tg_op = 'UPDATE'
    and new.store_id is not distinct from old.store_id
    and new.region   is not distinct from old.region
    and new.province is not distinct from old.province
    and new.district is not distinct from old.district
    and new.coverage is not distinct from old.coverage
  then
    return new;
  end if;

  new.coverage := order_coverage_for(
    new.store_id, new.region, new.province, new.district, current_date
  );
  return new;
end;
$$;

drop trigger if exists order_master_coverage on order_master;
create trigger order_master_coverage
  before insert or update on order_master
  for each row
  execute function order_master_set_coverage();

revoke all on function order_master_set_coverage() from public, anon, authenticated;

-- Repara lo que el build viejo dejó escrito.
select refresh_order_coverage(null);
