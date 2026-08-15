-- ============================================================================
-- 0117_aliclik_api_updated_at.sql — separar los dos relojes que la guarda
-- monotónica del barrido estaba comparando entre sí.
--
-- QUÉ SE ROMPIÓ. El barrido descarta un snapshot de Aliclik más viejo que lo
-- último que aplicamos, y para saberlo comparaba el `updatedAt` de la API contra
-- `last_report_at`. Pero `last_report_at` lo escriben LAS DOS vías, y el Excel
-- lo pone en la hora de la SUBIDA. Son dos relojes que miden cosas distintas:
-- uno, cuándo se movió el pedido en Aliclik; el otro, cuándo miramos nosotros.
--
-- El efecto: cada reporte importado dejaba `last_report_at = ahora` en TODAS las
-- guías del archivo, y desde ese instante el barrido las daba por rezagadas y no
-- volvía a tocarlas hasta que Aliclik moviera el pedido. La vía automática se
-- apagaba justo sobre las guías que más se miran.
--
-- El caso que lo destapó: AUR5X387229962523 (Chimbote) llevaba desde el 14-08
-- sin que la API la releyera —su `api_report_at` congelado— mientras Aliclik la
-- reportaba `NOT_RESPOND` en cada pasada. Con la guarda callada, el NO CONTESTA
-- nunca la devolvió a la cola de llamadas y la guía se encaminaba a volver a
-- Lima con el flete a cargo nuestro.
--
-- SIN BACKFILL, A PROPÓSITO. No sabemos qué `updatedAt` vio cada lectura pasada,
-- y rellenar desde `last_report_at` reproduciría exactamente el bloqueo que esto
-- viene a quitar. En NULL la guarda no aplica: la primera pasada escribe el
-- valor y a partir de ahí protege. Se cura sola en un barrido.
-- ============================================================================

alter table shipments
  add column if not exists api_updated_at timestamptz;

comment on column shipments.api_updated_at is
  'El `updatedAt` de Aliclik tal como lo vio la última lectura de la API. Guarda monotónica del barrido. A diferencia de last_report_at, el Excel NO lo escribe: por eso importar un reporte ya no deja ciega a la API.';
