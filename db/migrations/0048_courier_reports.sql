-- ============================================================================
-- 0048_courier_reports.sql — cada carga de información como un reporte
-- independiente, sea del courier que sea (§6).
--
-- `import_batches` (0024) ya registraba las cargas del Excel de Aliclik. En vez
-- de crear una tabla paralela, se generaliza: mismo registro, más metadatos, y
-- `kind`/`courier` distinguen la fuente. Así la cola de revisión manual que ya
-- existe (`import_rows.match_status = 'review'`, UI en components/import-review)
-- sirve para todos los couriers sin reescribir nada.
--
-- Novedad importante: **los reportes originales se conservan** (§19.8). Hasta
-- ahora el Excel se parseaba en memoria y se descartaba; `file_path` apunta al
-- archivo tal cual en el bucket privado `courier-reports`.
-- ============================================================================

alter table import_batches
  -- Courier o fuente del reporte: aliclik | fenix | shalom | olva | manual | api
  add column if not exists courier            text,
  -- Fecha a la que se refiere el reporte (distinta de la fecha de carga).
  add column if not exists report_date        date,
  -- Ruta del archivo original en el bucket privado `courier-reports`.
  add column if not exists file_path          text,
  add column if not exists file_type          text,
  add column if not exists file_sha256        text,
  -- Contadores que pide la especificación, además de los de 0024
  -- (row_count = registros procesados, matched_count, unmatched_count).
  add column if not exists found_count        integer not null default 0,
  add column if not exists updated_count      integer not null default 0,
  add column if not exists unrecognized_count integer not null default 0,
  -- Errores e inconsistencias detectadas, para poder revisarlas después.
  add column if not exists errors             jsonb not null default '[]'::jsonb;

comment on column import_batches.courier is
  'Courier o fuente del reporte. Determina qué adaptador lo parseó (lib/couriers).';
comment on column import_batches.file_path is
  'Archivo original en el bucket privado `courier-reports`. Se conserva por auditoría.';
comment on column import_batches.found_count is
  'Registros del reporte que se pudieron vincular a un pedido.';
comment on column import_batches.updated_count is
  'Pedidos cuyo estado cambió efectivamente con este reporte.';

create index if not exists import_batches_courier_idx
  on import_batches(store_id, courier, created_at desc);
-- El mismo archivo cargado dos veces es casi siempre un error del operador; el
-- índice permite avisarlo sin bloquear (una re-carga deliberada es legítima:
-- reconcileDeliveryStatus solo avanza el estado, nunca lo retrocede).
create index if not exists import_batches_sha_idx
  on import_batches(file_sha256) where file_sha256 is not null;

-- Los lotes existentes son todos de Aliclik.
update import_batches
   set courier = coalesce(courier, case when kind = 'aliclik_delivery' then 'aliclik' end)
 where courier is null;
