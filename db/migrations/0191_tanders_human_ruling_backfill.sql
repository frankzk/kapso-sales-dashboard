-- ============================================================================
-- 0191_tanders_human_ruling_backfill.sql — que la firma humana ya puesta mueva
-- también la guía.
--
-- EL FALLO (medido el 24-09-2026). De 124 cobros que una persona validó en
-- «Validar pagos», 49 se quedaron con la guía Tanders en `en_ruta` y el pedido
-- «En curso · En tránsito», pese a que Tanders los daba por entregados
-- (`reported_status = DELIVERED`) y alguien había firmado que el dinero llegó.
--
-- La guía solo pasaba a `entregado` con el veredicto del MODELO, y esos 49 eran
-- justo los que el modelo había rechazado (45) o no había podido leer (4) — los
-- que más necesitaban la mirada humana. La persona los aprobaba, se emitía el
-- cierre de liquidación… y el pedido no podía usarlo, porque para el Master
-- nunca se había entregado.
--
-- Dos de ellos (#KP126103 y #AUR175608) tampoco tienen el cierre: se validaron
-- el 14-09 a las 00:10, antes de que el PR #599 enlazara la validación con el cierre.
--
-- ESTO APLICA LA MISMA REGLA QUE `guidePatchForHumanRuling`
-- (lib/tanders/collection-payment.ts), que es la que usan desde ahora las
-- acciones de «Validar pagos». Si cambia una, cambia la otra.
--
-- NO recalcula el Master: tocar la guía sube su `updated_at`, y eso basta para
-- que `order_master_stale` (0123) la ponga en la cola del barrido del Master,
-- que corre cada diez minutos. Es la forma canónica de avisar de un cambio.
-- ============================================================================

-- 1) La guía sigue a la firma. Solo las que Tanders da por entregadas: validar
--    el dinero no es ver el paquete llegar, y nunca se afirma una entrega que el
--    courier no acredita. `revisado` = una persona corrigió al lector; se deja
--    `validado` donde los dos estaban de acuerdo, que es la cifra que interesa
--    al auditar.
update shipments s
set payment_check_state = case
      when s.payment_check_state = 'validado' then 'validado'
      else 'revisado'
    end,
    delivery_status = 'entregado',
    status_category = 'delivered'
from order_payments op
where op.order_id = s.order_id
  and op.kind = 'cobro_courier'
  and op.validation_status = 'validado'
  and op.validated_by is not null
  and s.courier = 'tanders'
  and s.delivery_status <> 'entregado'
  and upper(trim(coalesce(s.reported_status, ''))) = 'DELIVERED'
  -- La guía cuyo comprobante se revisó, si la ficha lo dice; si el pedido salió
  -- dos veces con Tanders, no se toca la otra.
  and (op.vision->>'guide_code' is null or op.vision->>'guide_code' = s.guide_code);

-- 2) El cierre que faltaba en los validados antes del PR #599. Se fecha y se firma
--    con la validación original: es la misma decisión, escrita tarde.
insert into order_events (store_id, order_id, kind, actor, source, note, occurred_at)
select op.store_id,
       op.order_id,
       'liquidation_closed',
       op.validated_by,
       'manual',
       'Cobro del courier validado: el dinero de este pedido está confirmado. '
         || '(Cierre escrito por 0191: la validación es anterior a su enlace con el cierre, PR #599.)',
       op.validated_at
from order_payments op
where op.kind = 'cobro_courier'
  and op.validation_status = 'validado'
  and op.validated_by is not null
  and not exists (
    select 1 from order_events e
    where e.order_id = op.order_id and e.kind = 'liquidation_closed'
  );
