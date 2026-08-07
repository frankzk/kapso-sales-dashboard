-- Recupera las devoluciones que el importador de Excel venía descartando.
--
-- QUÉ PASABA. El importador clasificaba por resultado para la clienta y solo
-- reconocía dos desenlaces: ENTREGADO o "pendiente". El estado de despacho no
-- se leía, así que una guía DEVUELTO / RETURNED entraba como pendiente y su
-- pedido nunca llegaba a `devuelto` — que es la entrada a Reproprovincia
-- (MOM §10-§11). El dato SÍ estaba en el reporte; solo no se miraba.
--
-- El parseo ya quedó arreglado (lib/aliclik-import.ts), pero eso solo actúa
-- sobre importaciones futuras. Las guías ya ingestadas siguen en pendiente.
-- Esta migración las sella releyendo la fila cruda que se guardó en
-- `import_rows.raw`, igual que hizo 0039 con la provincia.
--
-- QUÉ NO TOCA:
--   * Las guías ya entregadas. ENTREGADO gana sobre el despacho y un terminal
--     no se reabre; el reporte arrastra ruido en las columnas de despacho.
--   * Las transferidas a otro courier: marcarlas devueltas se contradiría.
--   * Un `returned_at` que ya exista (lo puso el camino por API). La devolución
--     se sella una sola vez.
--
-- DESPUÉS DE APLICARLA hay que recalcular el Master, que es una tabla
-- persistida y no se entera sola:
--
--   pnpm exec tsx scripts/backfill-mom.ts
--
-- Es idempotente: reconstruye `order_master` desde las guías.

with ultima_fila as (
  -- La lectura más reciente de cada guía. Una guía se reimporta varias veces y
  -- solo manda la última: `created_at` es la recencia real del lote, no
  -- `row_index`, que es la posición dentro del fichero.
  select distinct on (ir.shipment_id)
         ir.shipment_id,
         ir.created_at,
         coalesce(
           nullif(btrim(ir.raw ->> 'ÚLTIMO ESTADO DESPACHO'), ''),
           nullif(btrim(ir.raw ->> 'ESTADO DESPACHO'), '')
         ) as despacho,
         -- "FECHA DESPACHO" viene en DD/MM/YYYY. to_date con un valor ilegible
         -- reventaría la migración entera, así que solo se convierte lo que
         -- encaja en el formato; el resto queda null y no sella despacho.
         case
           when btrim(ir.raw ->> 'FECHA DESPACHO') ~ '^\d{1,2}/\d{1,2}/\d{4}$'
             then to_date(btrim(ir.raw ->> 'FECHA DESPACHO'), 'DD/MM/YYYY')::timestamptz
           else null
         end as fecha_despacho
  from import_rows ir
  where ir.shipment_id is not null
  order by ir.shipment_id, ir.created_at desc, ir.id desc
),
devueltas as (
  -- Solo la devolución CONSUMADA. TO_RETURN / "POR DEVOLVER" es un paquete que
  -- todavía viaja de vuelta: sigue vivo y el equipo lo puede interceptar.
  select shipment_id, created_at, fecha_despacho
  from ultima_fila
  where upper(despacho) in ('RETURNED', 'DEVUELTO')
)
update shipments s
   set returned_at      = coalesce(s.returned_at, s.last_report_at, d.created_at),
       delivery_status  = 'anulado',
       status_category  = 'closed',
       custody_state    = 'devuelto',
       -- Un paquete devuelto SALIÓ: no puede volver si nunca se despachó.
       -- `resolveOrderState` exige esa evidencia para dar por probada la
       -- devolución, y el importador nunca la escribía. Sin esto el sello no
       -- sirve de nada: el pedido no llega a `devuelto`.
       dispatched_at    = coalesce(s.dispatched_at, d.fecha_despacho)
  from devueltas d
 where s.id = d.shipment_id
   and s.courier = 'aliclik'
   and s.delivery_status not in ('entregado', 'transferido');
