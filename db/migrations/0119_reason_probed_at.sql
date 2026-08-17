-- ============================================================================
-- 0119_reason_probed_at.sql — cuándo le preguntamos a la API por el motivo.
--
-- EL MOTIVO DEL COURIER ES LO QUE APLICA EL MOM §11. La regla —«si la clienta
-- vio el producto y aun así lo rechazó, normalmente no reenviar»— se evalúa
-- contra `reported_status` y `non_delivery_reason` (lib/return-recovery.ts,
-- `wasRefusedInPerson`). Cuando las dos columnas están vacías, la regla NO
-- excluye: pasa. Y pasar significa que la guía entra a la cola de recuperación,
-- desde donde sale un mensaje que le pide un adelanto a la clienta.
--
-- O sea que la ausencia del dato se estaba leyendo como «nunca vio el
-- producto», que es justo lo contrario de lo que dice: no se sabe.
--
-- CUÁNTAS. De las 130 devoluciones candidatas de los últimos 30 días, 100 no
-- tienen motivo alguno. Son guías `anulado` importadas del Excel del 20-07, con
-- `api_report_at` en nulo: nunca pasaron por la API. El barrido por fechas no
-- las alcanza (se cayeron del rango) y el segundo pase tampoco (a una anulada le
-- da tres semanas de silencio). El motivo existe en Aliclik; nadie se lo había
-- preguntado.
--
-- Esta columna es el registro de haberlo preguntado. Sin ella la pasada volvería
-- a consultar las mismas guías cada veinte minutos para siempre: una guía sin
-- motivo que la API tampoco explica es indistinguible de una que nunca se
-- consultó. No se reutiliza `api_report_at` para esto, aunque parezca el mismo
-- dato: ese sello significa «lectura fresca de API» y con él
-- `reconcileReportedDeliveryStatus` BLOQUEA que un Excel posterior cambie el
-- estado de la guía. Estamparlo para anotar un sondeo silenciaría los reportes.
-- ============================================================================
alter table shipments
  add column if not exists reason_probed_at timestamptz;

comment on column shipments.reason_probed_at is
  'Última vez que se le preguntó a la API del courier por el motivo de una devolución que no lo traía. Solo evita repreguntar en bucle: no dice que el motivo se haya encontrado.';

-- Una sola forma de decir «no consta». `aliclikStatusLabel` une tres campos de
-- la API y devolvía cadena vacía cuando los tres venían vacíos, así que la
-- columna tenía dos representaciones del mismo vacío y cualquier consulta que
-- preguntara `is null` se dejaba 5 guías fuera sin avisar. El origen queda
-- cerrado en lib/aliclik-track.ts (`reportedStatusPatch`, que ya no escribe la
-- columna si no hay nada que escribir); esto limpia lo que quedó.
update shipments set reported_status = null where btrim(reported_status) = '';
update shipments set non_delivery_reason = null where btrim(non_delivery_reason) = '';

-- Las que se van a consultar: devueltas, sin motivo y dentro de la ventana de
-- recuperación. El índice parcial es diminuto (son ~100 filas de 3.818) y es
-- exactamente la consulta que corre cada veinte minutos.
create index if not exists shipments_reason_probe_idx
  on shipments (returned_at desc)
  where returned_at is not null
    and reported_status is null
    and non_delivery_reason is null;
