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

## Un motorizado sin app, con la ruta ya en Kapta (foto de su hoja)

Es el caso de Alexis desde el 01/10/2026: Despacho armó su caja, oficina la
cotejó y él la recibió, así que la ruta existe y está «En reparto», pero nadie
reporta las paradas desde el teléfono. Llega una foto de su hoja por día
(columnas Ítem · Proveedor · Cliente · Distrito · F. pago · Recaudado ·
Ganancia mot. · Observación, con el pedido en Observación). Los pasos 1 a 3 de
arriba no sirven aquí: crean rutas y cajas que ya existen.

**Desde el 08/10/2026 se hace en Kapta, no con SQL** (MOM §29.7): Grupo GF
Courier → Rutas → la ruta del motorizado → «Reparto y liquidación» →
**Cargar hoja**. Se suben las capturas del día, Kapta las lee y propone fila
por fila; quien liquida revisa (lo que no se entiende, lo cruzado por nombre,
los cobros parciales) y pulsa **Aplicar**. Los reprogramados que él conserva
pasan solos a la ruta del día (`gf_carry_over`, 0234). Para el día en que solo
salió con reprogramados y no tiene ruta, se abre cualquier ruta suya y se
cambia «Día de la hoja». Después, igual que siempre: comprobar efectivo y
ganancia, terminar la ruta y aprobar el pago.

Lo que sigue es el respaldo a mano, para cuando la lectura falla o hay que
corregir algo que la pantalla no permite.

1. **Transcribe y cuadra.** Pasa cada fila a una tabla y suma «Recaudado» y
   «Ganancia»: tienen que dar el TOTAL COBRADO de la foto al céntimo antes de
   seguir. Ojo con la fecha de la cabecera (la del 01/10 decía 28/02/2025):
   manda la ruta cuyos pedidos coinciden.
2. **Cruza con la ruta del día** (`delivery_routes` del motorizado y fecha,
   `delivery_stops` con su pedido). Tres grupos: paradas pendientes que la hoja
   explica, paradas ya reportadas (no se tocan) y filas que no están en la caja.
   Estas últimas **no se cargan**: §29.5 exige el cotejo. Se le pasan a quien
   liquida con su nota (otro motorizado las tiene, salieron de nuevo otro día,
   no existen en Kapta). Dos excepciones (§29.7): un pedido de una carga de ese
   día que nunca se recibió, si quien liquida decide incluirlo (se inserta la
   parada con `dispatch_manifest_id` de esa carga, sin marcar cotejos, y la
   carga se cancela vacía desde «Reparto y liquidación»), y el reprogramado
   de un día anterior que él conservó, que primero se pasa a esta ruta (ver
   «Los reprogramados que él conserva», abajo).
3. **Reporta las pendientes en una transacción** que replique
   `writeStopReport` (`lib/stop-report.ts`), con el vocabulario de §29.7:
   - `delivery_stops`: estado, método y monto (solo si entregado), motivo (solo
     si no entregado), nota «Cuaderno de X del dd/mm (punto N): …»,
     `written_status` (lo escrito), `written_status_code` (código de Reparto
     propio), `written_payment`, `reported_at = now()`,
     `pickup_confirmed` del ítem de la caja y **`reported_by = null`**: es la
     marca de «cargada desde el cuaderno», y lo que la exime de foto.
   - `delivery_stop_events` con `actor` = quien pidió la carga.
   - `order_events` `stop_reported` con el mismo actor, `source = 'reparto'`,
     `courier = 'propio'` y `payload.origen = 'cuaderno'`.
   - Antes de escribir, un `do $$` que aborte si las filas no caen exactamente
     en N paradas pendientes de una ruta en curso. Ensaya primero terminando
     en un `raise exception` que imprima los conteos: deshace todo.
4. **El Master.** Fuera de la app nadie llama a `recomputeOrderMasterSafe`.
   Marca esas filas como de versión vieja y el cron `master-reconcile` (cada
   10 minutos) las recalcula:
   `update order_master set macro_version = 'cuaderno-recalcular' where order_id in (…)`.
   Tocar solo `shipments.updated_at` no sirve: su trigger lo ignora.
5. **Comprueba**: la ruta sin pendientes, el efectivo igual a la hoja menos lo
   que quedó fuera, y el Master con los entregados en «Por cerrar» y el resto
   en «Por reprogramar Lima». Terminar la ruta y aprobar el pago siguen siendo
   de quien liquida, desde «Reparto y liquidación».

**Los reprogramados que él conserva** (§29.7, desde el 07/10/2026; desde el
08/10 lo hace «Cargar hoja», o a mano `select gf_carry_over(<rider_id>,
'<día>', array[<shipment_id>…]::uuid[], '<user_id>')`): antes de
reportar el día N, pasa a su ruta del día N los «Reprogramado» del día
anterior que la hoja del día N trae (o del día que la hoja nombró:
«LUNES»…). Va día por día y en transacciones separadas —pasar, reportar,
pasar lo que siguió reprogramado—, porque la etapa del Master lee la señal
más reciente del motorizado y dos eventos con la misma hora no se ordenan.
Por cada paquete, en una sola transacción:

- Sale de la caja anterior con `gf.withdraw = on`: `removed_at`, `removed_by`
  y el motivo «Reprogramado (…): Alexis se quedó con el paquete y sale en su
  ruta del dd/mm, ya cotejado (cuaderno).»; `dispatch_events` `carried_over`
  en esa caja (con `to_route_date`) y `order_events` `package_removed` un
  segundo antes de `now()`.
- Entra en la carga que devuelve `gf_dispatch_load(org, motorizado, día,
  actor)` —una adicional si las del día ya están en custodia; si el día no
  tenía ruta, la abre— con `office_checked_*` y `pickup_checked_*` de quien
  carga, y sus `package_added`, `office_checked` y `pickup_checked`.
- `finalize_dispatch_manifest(carga, actor)` la pasa a custodia y crea las
  paradas pendientes; luego se reportan como el paso 3.

No pases el anulado en Shopify ni lo que la hoja del día siguiente no trae, y
no uses una carga que Despacho está armando (si `gf_dispatch_load` devuelve
una carga sin custodia, espera a que la reciba). SQL que se usó el
07/10/2026 (una transacción por día; cambia la lista y el actor):

```sql
begin;
create or replace function pg_temp.arrastrar(p_al date, p_items jsonb) returns int language plpgsql as $f$
declare
  v_actor uuid := '<user_id>';
  v_rider uuid := '<rider_id>';
  v_load uuid; r record; v_n int := 0; v_reason text;
begin
  for r in
    select x.pedido, x.motivo, o.id order_id, sh.id shipment_id, sh.store_id ship_store, sh.guide_code,
           i.id item_id, i.store_id item_store, m.id old_manifest, m.org_id, m.route_date old_date, s.id old_stop
      from jsonb_to_recordset(p_items) as x(pedido text, desde date, motivo text)
      join orders o on o.name = x.pedido and o.cancelled_at is null
      join shipments sh on sh.order_id = o.id
      join dispatch_manifest_items i on i.shipment_id = sh.id and i.removed_at is null
      join dispatch_manifests m on m.id = i.manifest_id and m.rider_id = v_rider and m.courier = 'propio'
           and m.state = 'in_custody' and m.route_date = x.desde and m.route_date < p_al
      join delivery_stops s on s.dispatch_manifest_id = m.id and s.shipment_id = sh.id
           and s.status = 'no_entregado' and s.outcome_reason = 'reprogramado'
  loop
    if exists (select 1 from delivery_routes dr join delivery_stops ds on ds.route_id = dr.id
                where dr.rider_id = v_rider and dr.route_date = p_al and ds.order_id = r.order_id) then
      raise exception '% ya tiene parada en la ruta del %', r.pedido, p_al;
    end if;
    if v_load is null then v_load := public.gf_dispatch_load(r.org_id, v_rider, p_al, v_actor); end if;
    v_reason := 'Reprogramado (' || r.motivo || '): Alexis se quedó con el paquete y sale en su ruta del '
             || to_char(p_al, 'DD/MM') || ', ya cotejado (cuaderno).';
    perform set_config('gf.withdraw', 'on', true);
    update dispatch_manifest_items set removed_at = clock_timestamp(), removed_by = v_actor, removal_reason = left(v_reason, 300)
     where id = r.item_id;
    perform set_config('gf.withdraw', 'off', true);
    insert into dispatch_events(org_id, manifest_id, shipment_id, actor, kind, payload)
    values (r.org_id, r.old_manifest, r.shipment_id, v_actor, 'carried_over',
            jsonb_build_object('stop_id', r.old_stop, 'to_route_date', p_al, 'to_manifest_id', v_load, 'reason', v_reason, 'origen', 'cuaderno'));
    insert into order_events(store_id, order_id, kind, occurred_at, actor, source, courier, guide_code, shipment_id, reason, note, payload)
    values (r.ship_store, r.order_id, 'package_removed', now() - interval '1 second', v_actor, 'dispatch', 'propio',
            r.guide_code, r.shipment_id, 'reprogramado', v_reason,
            jsonb_build_object('manifest_id', r.old_manifest, 'rider_id', v_rider, 'route_date', r.old_date,
                               'carried_over', true, 'to_route_date', p_al, 'to_manifest_id', v_load, 'origen', 'cuaderno'));
    insert into dispatch_manifest_items(manifest_id, shipment_id, store_id, added_by,
      office_checked_at, office_checked_by, pickup_checked_at, pickup_checked_by)
    values (v_load, r.shipment_id, r.item_store, v_actor, clock_timestamp(), v_actor, clock_timestamp(), v_actor);
    insert into dispatch_events(org_id, manifest_id, shipment_id, actor, kind, payload) values
      (r.org_id, v_load, r.shipment_id, v_actor, 'package_added',
       jsonb_build_object('source', 'grupo_gf_courier', 'riderId', v_rider, 'carried_from_manifest', r.old_manifest,
                          'carried_from_date', r.old_date, 'note', v_reason, 'origen', 'cuaderno')),
      (r.org_id, v_load, r.shipment_id, v_actor, 'office_checked', jsonb_build_object('carried_over', true)),
      (r.org_id, v_load, r.shipment_id, v_actor, 'pickup_checked', jsonb_build_object('carried_over', true));
    v_n := v_n + 1;
  end loop;
  if v_n <> jsonb_array_length(p_items) then
    raise exception 'Se esperaban % paquetes para el % y se encontraron %', jsonb_array_length(p_items), p_al, v_n;
  end if;
  perform public.finalize_dispatch_manifest(v_load, v_actor);
  update order_master set macro_version = 'cuaderno-recalcular'
   where order_id in (select o.id from jsonb_to_recordset(p_items) as x(pedido text) join orders o on o.name = x.pedido);
  return v_n;
end $f$;
select pg_temp.arrastrar('2026-10-02', '[{"pedido": "#KP138029", "desde": "2026-10-01", "motivo": "REPRO del 01/10"}]'::jsonb);
commit;
```

La ganancia que trae la hoja la calcula Kapta con su tarifa personal
(`rider_pay_rates`). Si no coincide, la tarifa se registra con
`rider_pay_save_rate` (nueva versión, con motivo); no se corrige a mano.

## Antes de importar

- Si ese día hubo pruebas en Despacho del día con pedidos que no salieron,
  deshazlas antes: retira los paquetes de la caja («Quitar»), y si el cierre de
  ruta ya sincronizó filas a la hoja, bórralas; si no, el paso 2 vuelve a crear
  esas paradas como entregadas.
- Un pedido con adicional de pago aprobado no se puede borrar de la ruta: el
  historial de ganancia es inmutable.
