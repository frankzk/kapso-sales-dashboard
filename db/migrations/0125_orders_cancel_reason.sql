-- ============================================================================
-- 0125_orders_cancel_reason.sql — por qué se anuló el pedido, según Shopify.
--
-- EL HUECO. Se ingería `cancelled_at` pero nunca `cancelReason`, así que un
-- pedido anulado decía CUÁNDO murió y no POR QUÉ. Medido en Cajamarca sobre 90
-- días: de 421 pedidos, 140 se anularon sin llegar a generar guía —un tercio de
-- la región, más que las 50 devoluciones— y de esos 135 sin un solo evento en la
-- aplicación. Se anularon en Shopify, tardando 198 horas de media: ocho días de
-- gestión persiguiendo un pedido que acaba muriendo por un motivo que no
-- guardábamos.
--
-- Esa ceguera cambia decisiones. «Restringir el pago contra entrega» ataca las
-- devoluciones y no toca a los 140; para saber si el problema es el cliente que
-- se arrepiente, el stock que faltó o un pago rechazado, hace falta el motivo.
--
-- LOS VALORES los pone Shopify: customer, declined, fraud, inventory, staff,
-- other. Se guardan EN MINÚSCULA venga de donde venga — el REST los manda así y
-- GraphQL en mayúscula (`CUSTOMER`), y dos grafías del mismo motivo obligarían a
-- que cada consulta se acordara de normalizar. Se normaliza una vez, al entrar.
--
-- SIN `check` A PROPÓSITO. Es un vocabulario de Shopify, no nuestro: el día que
-- añadan un valor, una restricción aquí rompería la ingesta entera de pedidos
-- por un dato que solo sirve para analizar. Lo que no se puede clasificar se lee
-- igual de bien como texto.
--
-- HISTÓRICO. Esta columna se llena hacia adelante. Los pedidos ya sincronizados
-- se quedan en NULL: Shopify sí tiene el dato, pero recuperarlo exige volver a
-- pedir cada pedido uno a uno, y no vale el gasto de cuota para una analítica.
-- Los 140 de Cajamarca siguen ciegos; los siguientes, no.
-- ============================================================================

alter table orders add column if not exists cancel_reason text;

comment on column orders.cancel_reason is
  'Motivo de anulación según Shopify (customer | declined | fraud | inventory | staff | other), en minúscula. NULL si no está anulado, o si se sincronizó antes de la 0125.';

-- Solo interesa sobre los anulados, que son una minoría: el índice parcial
-- responde «¿por qué se cae esta región?» sin pesar sobre el resto de la tabla.
create index if not exists orders_cancel_reason_idx
  on orders (cancel_reason)
  where cancel_reason is not null;
