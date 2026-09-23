# Cargar el cuaderno de un motorizado en Rutas (conciliación con el spreadsheet)

Cuando llega el cuaderno de reparto en Google Sheets (o el Excel «MASTER KEY
2.0») y hay que ponerlo en Kapta, son **tres pasos**, siempre en este orden.
Saltarse el tercero deja las rutas «sin caja»: en Grupo GF Courier → Rutas la
fila sale con guiones en armados/cotejados/recibidos y el panel de la caja
abre en «Agregar pedidos» vacío, aunque las paradas existan (pasó el
19-09-2026 con los días 16 al 19 de Roy y Yhoni).

## 1. La hoja (Liquidaciones 2)

Convierte cada bloque del cuaderno (fila `Fecha`, fila `Motorizado:`, fila de
cabecera y filas `Punto NN`) en `matrix_<Nombre>.json`: un array de filas,
cada fila un array de celdas en el orden del cuaderno (Punto · Vendedor ·
Cliente · # de Pedido · A cobrar (estado) · Efectivo · A cobrar (monto) ·
Método de pago · Observación 1 · Observación 2 · Fecha). Luego:

```bash
pnpm tsx scripts/import-reparto.ts <org_id> <dir-con-matrices> Roy Yhoni
```

Es idempotente por `fecha##pedido`: filas nuevas se crean, las existentes se
actualizan y una fila editada a mano no se pisa. No borra filas que no vengan
en la matriz, así que se puede importar solo los días que faltan. Lo que no
cruza queda en «A revisión» de la hoja: estado sin equivalente, método fuera
de lista, pedido sin número en Kapta (KAST, LENI STORE…).

## 2. Las paradas (Rutas)

```bash
pnpm tsx scripts/backfill-stops-from-sheets.ts <org_id> [--dry-run] Roy Yhoni
```

Por cada fila con pedido y sin parada crea (o reutiliza) la ruta del
motorizado ese día y su parada con el resultado y el cobro del cuaderno, y
ata la fila a la parada. Días pasados nacen cerrados; el día de hoy, si ya
tiene ruta abierta, recibe las paradas en ella.

## 3. La caja (Despacho)

```bash
pnpm tsx scripts/backfill-boxes-from-routes.ts <org_id> --actor <user_id> --desde YYYY-MM-DD [--dry-run] Roy Yhoni
```

Crea la caja de cada ruta con un ítem por parada, cotejado por oficina y
recibido por el motorizado a la hora del reporte, y pasa la custodia de la
salida al motorizado. Con esto la fila de Rutas cuenta armados/cotejados/
recibidos y el panel de la caja abre en «Recibir carga» con sus paquetes.

**Paquetes que salen varios días** («MAÑANA», «NO RESPONDE» y luego
entregado): el sistema admite un paquete activo en una sola caja a la vez, así
que el script se salta los que siguen activos en la caja de un día anterior y
lo avisa. La regla es: si ese día anterior la parada **no** quedó entregada, el
ítem se retira de aquella caja al final de ese día (`removed_at` = 23:59 de
ese día, motivo «Volvió al almacén…», con el pase `gf.withdraw = on` porque la
caja está en custodia) y se vuelve a correr el paso 3. La lista de Rutas cuenta
los ítems que estaban en la caja *ese día*, no solo los activos hoy, así que el
día anterior no pierde su paquete. SQL que se usó el 19-09-2026:

```sql
begin;
select set_config('gf.withdraw', 'on', true);
with repetidos as (
  select i.id item_id, m.route_date dia_anterior
    from dispatch_manifest_items i
    join dispatch_manifests m on m.id=i.manifest_id and m.courier='propio' and m.state<>'cancelled'
    join shipments sh on sh.id=i.shipment_id
    join delivery_stops s_prev on s_prev.route_id=m.delivery_route_id and s_prev.order_id=sh.order_id
    join delivery_stops s_next on s_next.order_id=sh.order_id and s_next.route_id<>m.delivery_route_id
    join delivery_routes r_next on r_next.id=s_next.route_id and r_next.route_date > m.route_date
   where i.removed_at is null and s_prev.status <> 'entregado'
)
update dispatch_manifest_items i
   set removed_at = (rep.dia_anterior::timestamp + interval '23 hours 59 minutes') at time zone 'America/Lima',
       removed_by = '<user_id>', removal_reason = 'Volvió al almacén: ese día no se entregó y salió de nuevo otro día (cuaderno)'
  from (select distinct on (item_id) item_id, dia_anterior from repetidos order by item_id) rep
 where i.id = rep.item_id;
select set_config('gf.withdraw', 'off', true);
commit;
```

## 4. El Master

Nada de lo anterior toca el Master. Las entregas cruzan por la puerta única
(`lib/master-door.ts`): desde Liquidaciones 2 con «Aplicar al Master» tras
aceptar las observaciones de monto, o en bloque con
`scripts/apply-cuaderno-history-to-master.ts` (deja `master_backfill_log`,
reversible con `scripts/rollback-master-backfill.ts`).

## Antes de importar

- Si ese día hubo pruebas en Despacho del día con pedidos que no salieron,
  deshazlas antes: retira los paquetes de la caja («Quitar»), y si el cierre de
  ruta ya sincronizó filas a la hoja, bórralas; si no, el paso 2 vuelve a crear
  esas paradas como entregadas.
- Un pedido con adicional de pago aprobado no se puede borrar de la ruta: el
  historial de ganancia es inmutable.
