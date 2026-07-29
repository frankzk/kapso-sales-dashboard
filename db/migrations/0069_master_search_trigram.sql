-- 0069 — Buscar en el Master deja de escanear la tabla entera.
--
-- La búsqueda usa `ilike '%texto%'`: con el comodín al principio NINGÚN índice
-- corriente sirve, así que Postgres leía las 10.000 filas y descartaba 10.327
-- para devolver 11. Medido: 42 ms de escaneo, en cada tecla.
--
-- Los índices de trigramas sí indexan subcadenas —parten cada texto en grupos de
-- tres letras—, que es justo lo que hace falta para un "contiene". La misma
-- consulta pasó a 0,46 ms, y ahora el coste ya no crece con cada pedido nuevo.
-- Necesitan al menos 3 caracteres para aprovecharse.

create extension if not exists pg_trgm;

create index if not exists order_master_search_name_idx
  on order_master using gin (order_name gin_trgm_ops);
create index if not exists order_master_search_customer_idx
  on order_master using gin (customer_name gin_trgm_ops);
create index if not exists order_master_search_phone_idx
  on order_master using gin (customer_phone gin_trgm_ops);
create index if not exists order_master_search_guide_idx
  on order_master using gin (guide_code gin_trgm_ops);

analyze order_master;
