-- 0111 — Marca de la última lectura de la API, para que mande sobre el Excel.
--
-- `last_report_at` no servía para esto: lo escriben LAS DOS vías —el barrido de
-- la API (lib/aliclik-track.ts) y la importación del Excel (lib/report-ingest.ts)—
-- así que mirándolo no se puede saber quién habló último. Esta columna la escribe
-- solo la API, y es la que decide si el reporte importado puede cambiar el
-- estado de entrega (`reconcileReportedDeliveryStatus`, lib/shipments.ts).
--
-- Arranca en NULL a propósito: nadie hereda propiedad retroactiva. La primera
-- lectura de API de cada guía la sella, y a partir de ahí manda ella mientras la
-- lectura siga fresca (API_OWNERSHIP_DAYS). Antes de eso, y también cuando la
-- lectura envejece, sigue rigiendo la precedencia monotónica de siempre.

alter table shipments add column if not exists api_report_at timestamptz;

comment on column shipments.api_report_at is
  'Última vez que la API de Aliclik reportó esta guía. Solo la escribe la vía API; mientras sea reciente, un reporte importado no puede cambiar delivery_status.';
