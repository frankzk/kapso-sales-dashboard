-- ============================================================================
-- 0065_mom_phase3_routing.sql — Activación del motor de modalidades del MOM.
--
-- Los pedidos históricos de Shopify no siempre traen `shipping_mode`. Si su
-- geografía es conocida y no corresponde a Lima/Callao, la operación normal es
-- Provincia COD. Agencia continúa siendo explícita: la determina shipping_mode
-- o una salida Shalom/Olva al siguiente recálculo.
-- ============================================================================

update order_master
   set macro_operation = 'provincia_cod',
       macro_version = 'mom-v1',
       updated_at = now()
 where coalesce(macro_operation, 'desconocida') = 'desconocida'
   and nullif(trim(concat_ws(' ', region, province)), '') is not null
   and lower(concat_ws(' ', region, province)) !~ '(^|[^a-z])(lima|callao)([^a-z]|$)';

comment on column shipments.created_via is
  'Origen técnico de la salida: integraciones existentes, fenix_directo o mom_manual_route.';
