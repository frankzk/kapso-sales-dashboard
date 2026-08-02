-- 0098 — La nota del pedido de Shopify, como columna.
--
-- POR QUÉ. La nota es donde el asesor escribe las instrucciones reales del
-- pedido: «enviar con Tanders», «antes de la 1 y 30», «llamar al llegar». Va
-- impresa en el rótulo, junto al QR, porque quien arma la caja no la tenía en
-- ninguna parte del papel — había que abrir Shopify para enterarse. Hoy la traen
-- 700 de cada 1.430 pedidos de la semana, así que no es un caso marginal.
--
-- POR QUÉ GENERADA Y NO UNA COLUMNA NORMAL. El dato ya está en `raw`, el JSON
-- crudo de Shopify que se guarda en cada sincronización. Una columna generada:
--
--   * cubre los 11.579 pedidos ya cargados sin backfill ni script aparte;
--   * no puede desincronizarse de `raw`, porque la calcula la base;
--   * no obliga a tocar el mapeo ni el upsert de la ingesta, que es el camino
--     por el que entra CADA pedido — un cambio ahí se paga en riesgo.
--
-- Se lee como una columna más (`select ... , shopify_note`), sin depender de la
-- sintaxis JSON de PostgREST, que no se puede probar desde el entorno de
-- desarrollo y fallaría recién en producción tumbando la impresión entera.

alter table orders
  add column if not exists shopify_note text
  generated always as (nullif(btrim(raw ->> 'note'), '')) stored;

comment on column orders.shopify_note is
  'Nota del pedido en Shopify (raw->>note), ya recortada; NULL si viene vacía. '
  'Se imprime en el rótulo junto al QR.';
