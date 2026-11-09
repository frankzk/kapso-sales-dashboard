-- Smoke 0327: las provincias de Lima fuera de la capital = agencia en el Master.
do $$
begin
  assert is_non_metro_lima_location('huaral', 'Huaral'), 'Huaral por provincia';
  assert is_non_metro_lima_location('Lima (provincia)', 'Barranca'), 'Barranca por distrito';
  assert is_non_metro_lima_location('Lima', 'San Antonio- Huarochirí'), 'Huarochirí como palabra del distrito';
  assert is_non_metro_lima_location('Cañete', 'San Vicente de Cañete'), 'Cañete';
  assert is_non_metro_lima_location(null, 'Oyón'), 'Oyón sin provincia';
  assert not is_non_metro_lima_location('Callao', 'Curva canta Callao'), 'Callao no es Canta';
  assert not is_non_metro_lima_location('Lima', 'Miraflores'), 'Miraflores es Lima';
  assert not is_non_metro_lima_location('Arequipa', 'Paucarpata'), 'Arequipa no';
  assert not is_non_metro_lima_location(null, null), 'vacío';
  assert exists (
    select 1 from pg_proc where proname = 'order_master_set_coverage'
      and pg_get_functiondef(oid) like '%is_non_metro_lima_location(new.province, new.district)%'
  ), 'el trigger del Master usa la regla';
end
$$;
