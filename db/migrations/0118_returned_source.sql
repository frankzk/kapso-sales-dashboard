-- ============================================================================
-- 0118_returned_source.sql — quién dio por devuelta la guía.
--
-- `returned_at` es el sello que abre la cola de recuperación (MOM §11.1): en
-- cuanto tiene fecha, el pedido pasa a `devuelto` y la clienta entra en la lista
-- de gente a la que se le va a pedir dinero por adelantado para reenviar. Ese
-- sello lo pueden escribir cuatro manos distintas:
--
--   aliclik_api      la lectura de la API (lib/aliclik-track.ts, y el enlace
--                    manual contra Aliclik desde el Master)
--   aliclik_report   el Excel del courier (lib/aliclik-ingest.ts)
--   <courier>_report el reporte de otro courier (lib/report-ingest.ts)
--   manual           una persona, recibiendo el paquete en el almacén
--
-- Hasta ahora las cuatro se veían IGUAL en pantalla. Una guía sellada a mano —
-- porque el paquete estaba físicamente sobre la mesa y Aliclik nunca lo reportó—
-- aparecía como «anulado · devuelta» sin nada que la distinguiera de una con
-- constancia del courier. Eso importa justo acá y no en otros campos: sobre este
-- dato se manda un mensaje que pide un adelanto, y si el sello estaba mal puesto
-- se le pide plata a alguien cuyo paquete sigue en ruta.
--
-- La columna es el mismo trato que ya se le da a las entregas con
-- `delivered_source` (0026): el hecho se guarda CON su procedencia, no a secas.
-- `returned_by` completa el par para el caso manual — el resto de acciones de
-- persona del MOM (ready_by, custody_transferred_by, 0086) ya guardan actor.
--
-- Backfill. Las 341 guías selladas hasta hoy se reparten con una regla que no
-- inventa nada: si el sello llegó DESPUÉS del último reporte del courier, no hay
-- constancia detrás y es manual (son exactamente 3, las que se sellaron a mano
-- el 10-08 para destrabar la cola); el resto coincide con un reporte y queda
-- como `aliclik_report`. Para esas filas antiguas no se puede separar API de
-- Excel —ambas vías escriben `last_report_at` en el mismo movimiento— y no hace
-- falta: las dos son constancia del courier, que es la distinción por la que
-- existe esta columna.
-- ============================================================================
alter table shipments
  add column if not exists returned_source text,
  add column if not exists returned_by uuid references auth.users(id) on delete set null;

comment on column shipments.returned_source is
  'Procedencia del sello de devolución: aliclik_api | aliclik_report | <courier>_report | manual. NULL = guía sin devolver (o sellada antes de 0118 sin rastro). Se escribe JUNTO a returned_at y no se pisa mientras el sello siga en pie.';

comment on column shipments.returned_by is
  'Quién marcó la devolución cuando returned_source = manual. NULL para las que reportó el courier.';

update shipments
   set returned_source = case
         -- Sello posterior al último reporte: nadie lo reportó, lo puso una
         -- persona. El minuto de holgura es para no confundir el sello que la
         -- propia importación escribe en el mismo movimiento.
         when last_report_at is null then 'manual'
         when returned_at > last_report_at + interval '1 minute' then 'manual'
         else courier || '_report'
       end
 where returned_at is not null
   and returned_source is null;
