-- 0174_olva_tracking.sql — el número con el que Olva conoce el envío, y su
-- último estado rastreado.
--
-- EL HUECO. La salida de Olva se crea desde el drawer (§4, §12) y nace con un
-- `guide_code` INTERNO de Kapta: el número de tracking que Olva emite
-- («2552504-26») no se guardaba en ninguna parte. Llegaba por correo a una
-- persona y se quedaba ahí. Sin él no hay nada que consultar, y el estado de
-- agencia se marcaba a mano cuando alguien se acordaba — Olva devuelve el
-- paquete a los SEIS días de llegar a destino, no a los 28 de Shalom.
--
-- POR QUÉ COLUMNAS PROPIAS Y NO `guide_code`. El `guide_code` de una salida
-- manual es lo que va impreso en el rótulo y en el QR que el almacén escanea;
-- cambiarlo al enterarse del tracking desligaría la caja de su etiqueta. El
-- tracking de Olva es otro identificador, del courier, igual que
-- `shalom_codigo` lo es de Shalom (0061): se guarda al lado, no encima.
--
-- `emision` son los dos dígitos del año que Olva pide junto al número: el
-- mismo número se repite entre años, así que solos no identifican nada.

alter table shipments
  add column if not exists olva_tracking text,
  add column if not exists olva_emision  text,
  -- El último `nombre_estado_tracking` tal como lo dijo Olva («DESPACHADO»,
  -- «CONFIRMACION EN TIENDA»). Se guarda crudo porque la traducción a
  -- `pickup_state` es con pérdida y porque los estados que Kapta todavía no
  -- conoce tienen que poder verse para añadirlos.
  add column if not exists olva_status   text,
  -- El bloque `general` de la última respuesta, para auditar sin volver a
  -- preguntar.
  add column if not exists olva_raw      jsonb;

-- El mismo tracking no puede colgar de dos salidas: es la regla que ya rige
-- para las guías de Shalom vinculadas a mano (§12). Parcial: la inmensa
-- mayoría de las filas no son de Olva y no tienen tracking.
create unique index if not exists shipments_olva_tracking_uidx
  on shipments (olva_emision, olva_tracking)
  where olva_tracking is not null;

-- El cron busca las salidas de Olva con tracking y vivas; sin esto recorre
-- la tabla entera cada media hora.
create index if not exists shipments_olva_live_idx
  on shipments (courier, delivery_status)
  where olva_tracking is not null;
