-- 0099 — «Pago requerido pendiente» deja de ser subetapa y pasa a ser motivo.
--
-- Competía con «Volver a contactar» por el mismo pedido: una Agencia sin abono
-- validado se mostraba como pago pendiente hasta que alguien agendaba el
-- próximo contacto, y ahí saltaba a «Volver a contactar» sin que el pago
-- hubiera cambiado. Ahora la subetapa describe la gestión de la llamada y el
-- abono viaja en `macro_reasons`.
--
-- `macro_substage` es texto libre sin check: la subetapa la calcula
-- `resolveOrderMacroStage` en TypeScript y se escribe en cada recálculo. Esta
-- migración solo adelanta la conversión de las filas ya materializadas, que si
-- no quedarían contadas bajo una subetapa que la interfaz ya no ofrece —
-- pedidos invisibles en Por confirmar hasta su próximo barrido.
--
-- El destino es `por_confirmar` y no `volver_a_contactar` porque el código
-- anterior evaluaba el seguimiento ANTES del pago: una fila con este valor es,
-- por construcción, un pedido con contacto registrado y sin próximo contacto
-- pactado.

-- `recomputed_at` no se toca: nadie recalculó desde la fuente, solo se movió la
-- etiqueta. Marcarlo mentiría sobre la frescura de la fila.

update order_master
   set macro_substage = 'por_confirmar',
       macro_reasons = case
         when macro_reasons @> array['pago_requerido_pendiente'] then macro_reasons
         -- El tipo explícito no es adorno: sin él Postgres resuelve el literal
         -- como text[] y falla con «malformed array literal».
         else macro_reasons || 'pago_requerido_pendiente'::text
       end
 where macro_substage = 'pago_requerido_pendiente';
