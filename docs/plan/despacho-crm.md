# Despacho de Grupo GF Courier: auditoría de clics y rediseño

Fecha: 19-09-2026 · rama `delivery-lima`. Complementa el MOM §29 (§29.13 es la
regla que sale de aquí) y `docs/plan/liquidaciones-2.md`.

## 1. Auditoría del flujo anterior

Recorrido de un pedido de Lima desde «disponible» hasta «en poder del
motorizado» y hasta «entregado», contado sobre las pantallas tal como estaban
(commit `4d2ad7b`). Un «clic» es un toque o un escaneo; «pantalla» es una URL
distinta.

| Paso | Pantalla | Clics | Quién |
| --- | --- | --- | --- |
| Entrar a Grupo GF Courier | `/dashboard/courier` (Pedidos disponibles) | 1 | Supervisor |
| Marcar el pedido | misma | 1 por pedido | Supervisor |
| Elegir motorizado | misma (desplegable) | 2 | Supervisor |
| «Tomar y asignar» | misma | 1 | Supervisor |
| Variante «Tomar sin asignar» | misma → pestaña Pedidos tomados → marcar → motorizado → «Asignar» | +5 | Supervisor |
| Ir a Rutas | pestaña Rutas · Cajas y cotejos | 1 | Supervisor |
| Abrir la caja | `/dashboard/courier/rutas?manifiesto=…` | 1 | Supervisor |
| Paso «Verificar caja» | misma (pasos 1-2-3) | 1 | Supervisor |
| Cotejo de oficina | misma: cámara (1) + un escaneo por paquete | 1 + N | Supervisor |
| Recibir la carga | `/reparto`, bloque «Recibir mi carga» arriba de la ruta: cámara (1) + un escaneo por paquete | 1 + N | Motorizado |
| «No lo recojo» | no existía: el motorizado tenía que llamar y el supervisor retirar desde la caja con motivo | — | — |
| Reportar una parada | `/reparto`: abrir parada (1), estado (1-2), método (1), foto (2), guardar (1) | 6-7 | Motorizado |
| Cerrar la ruta | Rutas · Reparto y cierre diario | 2-3 | Coordinador |

Totales para un pedido: **9-10 clics en 3 pantallas** hasta que el motorizado lo
recibe (14-15 si se tomó sin asignar), sin contar la ruta de vuelta para
corregir una caja. Y tres huecos de trazabilidad:

- El motorizado no podía decir «este no lo recojo»: la caja se cerraba al 100 %
  o no se cerraba, y el supervisor tenía que retirar el paquete desde otra
  pantalla, con motivo tecleado.
- Mover un paquete de un motorizado a otro era retirar + volver a Tomados +
  asignar: tres pantallas y sin evento que dijera «pasó de Roy a Yhoni».
- El mismo gesto (escanear / tomar foto) vivía en tres componentes distintos
  (`DispatchScanner`+`DispatchCamera` en la mesa, `GfRiderReceipt` en el
  teléfono, `PhotoField` en la parada) y cada uno decidía por su cuenta qué
  acción llamar.

## 2. Rediseño

Dos pasos para el supervisor, uno para el motorizado, y un gesto único que
decide el evento por el contexto desde el que se abre.

| Paso | Pantalla | Clics | Quién |
| --- | --- | --- | --- |
| Asignar y cotejar (vía principal, modo escaneo) | `/dashboard/courier` · «Despacho del día»: elegir motorizado (1) + un escaneo por paquete. Cada QR toma el pedido, lo pone en la caja del día y lo deja cotejado por oficina en el mismo gesto; corte 11:30 y límite de efectivo van dentro. Variante «escanear primero»: los QR esperan en una bandeja y se asignan todos al elegir motorizado | 1 + N | Supervisor |
| Asignar desde la lista (vía secundaria, plegada) | misma pantalla: marcar pedidos (1 c/u) + «Asignar a Roy» (1) | 1 + N | Supervisor |
| Cotejar lo que faltara | misma pantalla, columna derecha: abrir la caja de Roy (1) + un escaneo por paquete. Quitar o mover a otro motorizado desde la misma fila | 1 + N | Supervisor |
| Recibir | `/reparto` abre solo en «Recibir mi caja» mientras la carga esté cotejada y no recibida: un escaneo por paquete; «No lo recojo» + motivo (2) cuando aplica | N | Motorizado |
| Reasignar lo no recogido | «Despacho del día», aviso «N no recogidos por Roy» → «Reasignar a…» (2) | 2 | Supervisor |
| Reportar | `/reparto` (sin cambios de clics; la foto usa el gesto único) | 6-7 | Motorizado |

Un pedido pasa de **3 pantallas y 9-10 clics a 1 pantalla y 1 clic + 1
escaneo** para el supervisor (elegir motorizado una vez, escanear cada
paquete); el motorizado deja de ver la ruta hasta que aceptó su caja.

## 3. Qué cambia en datos y código

- `dispatch_manifest_items.pickup_declined_at / _reason / _by` (0174): el
  motorizado rechaza un paquete de su caja. El rechazo lo retira de la carga
  (`removed_at` con motivo «No recogido por X: …») para que la custodia pase con
  los aceptados y el paquete quede libre para otra ruta; la solicitud
  logística vuelve a `accepted` con observación. RPC `gf_rider_decline`.
- `logistics_providers.rider_pickup_mode` (0177, reemplaza el booleano de
  0175): `exigir` (verifica su caja antes de la ruta), `confirmar` (producción:
  asignar entrega la custodia y crea paradas «por confirmar»; el motorizado
  dice «Lo llevo» con `gf_rider_confirm_pickup` o «No lo llevo» con
  `gf_rider_decline`, que en custodia borra la parada pendiente y devuelve el
  paquete a «por asignar»; el supervisor quita o mueve lo no confirmado con
  `gf_supervisor_withdraw`; al entregar sin confirmar queda
  `delivery_stops.pickup_confirmed = false` y el evento
  `delivered_unconfirmed_pickup`) y `ninguno` (basta con asignar). Decisión
  pura modo × parada en `riderStopDecision` (`lib/grupo-gf-courier.ts`).
- Una carga por motorizado y día en `confirmar` y `ninguno` (0176):
  `gf_dispatch_load_open` + `gf_add_item_in_custody`; el efectivo previsto y el
  límite se calculan sobre la ruta completa del día.
- `dispatch_route_reassigned` (order_events): mover un paquete de la caja de
  un motorizado a la de otro en el mismo día, con origen y destino.
- `scanAssignToRider` (courier/actions): un QR = tomar + asignar + cotejar,
  reutilizando `takeGroupGfCourierOrders`, `assignGroupGfCourierRoute` y
  `scanManifestItem`. La bandeja «escanear primero» y los contadores de la
  lista viva son puros (`lib/dispatch-scan-tray.ts`).
- `components/scan-action.tsx` + `lib/scan-action.ts`: el gesto único.
  `context` decide acción y evento: `supervisor_asignacion` →
  `logistics_request_accepted` + `dispatch_route_assigned` +
  `office_checked`; `oficina_cotejo` → `office_checked`;
  `motorizado_recepcion` → `pickup_checked` / `pickup_declined`;
  `motorizado_entrega` → foto de la parada; `supervisor_retiro` → `package_removed`.
- Pestaña «Despacho del día» (`components/dispatch-day-board.tsx`) sobre las
  acciones que ya existían: `takeAndAssignGroupGfCourierOrders`,
  `assignGroupGfCourierRoute`, `scanManifestItem`, `removeManifestItem`, y la
  nueva `moveManifestItem`.
- La pestaña «Actividad» del Master etiqueta los hitos del despacho en español
  (tomado, asignado, cotejado, recibido, no recogido, reasignado, retirado) y
  `/dashboard/courier` enlaza «Ver actividad» por pedido.

## 4. Despacho absorbe «Pedidos disponibles» y «Pedidos tomados» (19-09-2026)

Las dos pestañas salen de la barra (quedan como «vista anterior» bajo el botón
«⋯ Más vistas», con el mismo `?tab=` y una nota arriba) porque lo único que
aportaban ya vive en Despacho del día:

- **Fila de «Desde la lista»**: teléfono y fecha de creación en la línea
  secundaria («51962820897 · creado 19/09»); el buscador acepta teléfono
  (solo dígitos, con o sin prefijo) además de pedido, cliente y distrito.
- **«2.º intento»**: chapa en la fila cuando el pedido tuvo una salida previa
  (`hasPriorDispatch`, ahora también en los tomados), con tooltip «Ya salió
  antes y volvió; decide con eso», y filtro.
- **Excluidos**: «· N sin condiciones» junto al contador abre un panel con la
  lista y el motivo de cada uno (tarifa faltante / distrito inválido /
  servicio pausado / ya en caja / sin salida armable) y enlace al Tarifario.
  `loadCourierOperations` expone `blocked[]` además de `blockedCount`.
- **Picker de filtros**: un botón «Filtros · n» (popover en escritorio, hoja
  inferior en móvil) con tienda, distrito, solo 2.º intento, solo armados,
  solo tomados sin caja y fecha de creación (hoy / ayer / 7 días / todo);
  chips con × bajo el buscador; cambiar un filtro vuelve a la primera tanda.
  Filtrado puro en `filterQueue` (`lib/dispatch-day.ts`).
- **Tiles de métricas** encima de Asignar: una por filtro con su cantidad
  (Por asignar, Tomados sin caja, Armados, 2.º intento, Sin condiciones y, con
  cajas, Por armar, Listos para cotejo, Sin confirmar). Tocarla abre la lista
  o las cajas con ese filtro; volver a tocar lo quita. Misma fuente de verdad
  que el picker (`toggleQueueTile`, `toggleBoxTile`).
- **Segmentos de «Pedidos tomados» en Cajas de hoy**: cada caja muestra la
  cadena «N paq. · armados · cotejados · confirmados» (+ «no rec.»), cada
  paquete lleva su chapa (por armar / armado / cotejado / confirmado / no lo
  llevó, `packageStage`) y un filtro rápido Todos · Por armar · Listos para
  cotejo · Sin confirmar (`filterBoxItems`). «Sin ruta» sigue en la lista como
  «tomado · sin caja» y su filtro.

## 5. La ficha del pedido se abre en el sitio (19-09-2026)

«Ver actividad» en la cola y en las cajas, el número de pedido en la lista y en
los excluidos, y los enlaces equivalentes de Rutas, Grupo GF Courier,
Validación de pagos, Liquidaciones y Liquidaciones 2 ya no mandan al Master:
abren la misma ficha encima de la pantalla actual (`?ficha=<pedido>`, MOM
§25.1). El drawer salió de `orders-master.tsx` a `components/order-drawer.tsx`
y lo monta una vez `app/dashboard/layout.tsx` (`order-drawer-host.tsx`) con los
permisos del Master. La ficha lleva «Abrir en Master de Pedidos» para quien
necesite la tabla. Cerrar conserva pestaña, motorizado y filtros de Despacho.

Además, el popover «Filtros» de «Desde la lista» recorta en horizontal y sus
`<select>` van a ancho completo: antes tomaban el ancho de su opción más larga
y se salían del panel por la derecha.

## 6. Rutas: una sola lista y la caja al lado (19-09-2026)

Sergio pidió que las dos subpestañas de «Rutas» (Cajas y cotejos · Reparto y
cierre diario) fueran una sola lista agrupada por fecha, con filtro por
motorizado y por fecha, y que al pulsar una fila se abriera la caja del
motorizado a la derecha, como la ficha del pedido, con sus tres pasos.

Qué cambió (MOM §29.14):

- `lib/courier-route-ledger.ts`: `getCourierRouteLedger` arma la fila por
  ruta (`delivery_routes`) con su caja (`dispatch_manifests`), cuentas de la
  caja, paradas reportadas, efectivo previsto y estado de liquidación;
  `ledgerSituation` decide un solo estado por fila.
- `components/courier-routes-ledger.tsx`: la lista con cabeceras de fecha
  pegajosas y el picker de filtros compartido (`components/filter-sheet.tsx`,
  sacado de Despacho del día). `?dia=` y `?motorizado=` viven en la URL.
- `components/courier-box-drawer.tsx` + `lib/courier-box-href.ts`: el panel
  lateral (`?caja=` / `?ruta=`), que carga por `loadCourierBox` y monta
  `DispatchBoxPanel`, los tres pasos extraídos de `dispatch-workspace.tsx`
  (Almacén sigue usando el mismo componente dentro de su mesa).
- `app/dashboard/courier/rutas/page.tsx` ya no es «Verificar y recibir»: es
  la misma lista para quien no administra el courier, y redirige a la pestaña
  para quien sí. `app/dashboard/courier/reparto/page.tsx` sin `id` va a la
  lista; con `id` enseña solo el reparto y cierre (`RoutesBoard detailOnly`).
  `components/courier-route-nav.tsx` desapareció.
- Tests: `test/courier-box-drawer.test.ts` (href, situación, estructura) y
  ajustes en `courier-navigation` y `dispatch-mobile`.

Límite conocido: el panel enseña la última carga de la ruta; si un día hay
dos cargas para el mismo motorizado, la anterior se abre desde la mesa de
despacho de Almacén o desde el enlace antiguo `?caja=<carga>`.

## 7. El detalle de la parada, al lado de la lista (19-09-2026)

Sergio, 19-09-2026: «en lugar de que el detalle salga abajo puede salir en
el lado derecho como el detalle del pedido, pero no en el lado derecho de
toda la web, sería en el lado derecho del contenedor de toda esa lista. Esto
porque el motorizado normalmente abrirá la web desde móvil».

- `components/rider-route.tsx`: `StopCard` es solo la fila (nombre, pedido,
  monto, estado, y la barra «Lo llevo / No lo llevo»). El detalle vive en
  `StopPanel`: cabecera fija con «←», cliente, pedido y monto; cuerpo con
  scroll propio (dirección, mapa, llamar, reporte). En el teléfono el panel es
  `fixed` centrado con el ancho del contenedor (`max-w-md`), no de toda la
  web, y bloquea el scroll del cuerpo; desde `lg` el contenedor pasa a
  `max-w-3xl` con dos columnas (lista de 28 rem y panel pegajoso a la
  derecha). Sin parada abierta, la columna derecha solo dice qué hacer.
- La parada abierta es `?parada=<stopId>`: abrir hace `pushState` (así
  «atrás» cierra) y cerrar `replaceState` conservando el resto de la query,
  como la ficha del pedido. Guardar o confirmar cierra el panel y refresca la
  lista con `router.refresh()` diferido. Un id que ya no está en la ruta se
  ignora.
- Nada cambia en acciones ni datos: mismo `reportStop`, mismo vocabulario,
  mismo «Lo llevo». La barra «Lo llevo» sigue en la fila y, solo en el
  teléfono, también arriba del panel para no volver a la lista a confirmar.
- Tests: `test/rider-stop-panel.test.ts` (estructura del panel y de la URL).

