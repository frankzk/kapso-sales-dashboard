-- 0108 — `created_via` para las salidas de Shalom: la vía normal no se marcaba.
--
-- POR QUÉ. `shipments.created_via` está documentada como "origen técnico de la
-- salida", y para Shalom no distinguía nada: las 185 guías Shalom en producción
-- tenían `created_via` nulo, exactamente igual que una guía importada del
-- reporte Excel. Al mirar la columna, la conclusión inmediata era que el flujo
-- del drawer no se había usado nunca — y es falso: las registraron cuatro
-- personas identificadas, cada una con su evento `guide_created` y su actor.
--
-- CAUSA. Hay DOS vías en el drawer y solo la rara marcaba su origen. La de
-- contingencia (copiar a mano una guía ya emitida en pro.shalom.pe) escribía
-- `created_via = 'shalom_pro_manual'` desde que nació. La vía normal —crear la
-- guía por `POST /v1/orders`— nunca escribió la columna. El caso frecuente era
-- justo el que no dejaba rastro, así que el campo solo podía decir "esta salida
-- es una excepción" y jamás "esta salida es lo habitual".
--
-- EL BACKFILL NO ADIVINA. Solo toca filas con la huella inequívoca de la vía
-- API: `shalom_ose_id` presente (el identificador interno lo devuelve la API al
-- crear la orden; el reporte Excel no lo trae) y `shalom_raw` sin la clave
-- `source` (que es la marca que escribe la vía de contingencia). Al escribir
-- esta migración las 185 filas cumplen las dos condiciones, ninguna tiene
-- `source_batch_id` —o sea, ninguna vino de una importación— y las 185 tienen
-- su evento `guide_created` con actor. Una guía futura importada del reporte no
-- traería `shalom_ose_id` y por eso quedaría fuera.
--
-- Es idempotente: al filtrar por `created_via is null` no reescribe nada que ya
-- tenga origen, así que correrla dos veces no cambia el resultado.

update shipments
   set created_via = 'shalom_pro_api'
 where courier = 'shalom'
   and created_via is null
   and shalom_ose_id is not null
   and shalom_raw->>'source' is null;

comment on column shipments.created_via is
  'Origen técnico de la salida: integraciones existentes, fenix_directo, '
  'mom_manual_route, shalom_pro_api (guía emitida por la API de Shalom) o '
  'shalom_pro_manual (guía ya emitida en pro.shalom.pe y copiada a mano). '
  'Nulo = la salida entró por importación de reporte, no se creó desde Kapta.';
