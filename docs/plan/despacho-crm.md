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
| Asignar | `/dashboard/courier` · «Despacho del día», columna izquierda: marcar pedidos (1 c/u) + «Asignar a Roy» (1). Tomar y asignar es una sola acción; fecha y límite de efectivo van dentro | 1 + N | Supervisor |
| Cotejar | misma pantalla, columna derecha: abrir la caja de Roy (1) + un escaneo por paquete. Quitar o mover a otro motorizado desde la misma fila | 1 + N | Supervisor |
| Recibir | `/reparto` abre solo en «Recibir mi caja» mientras la carga esté cotejada y no recibida: un escaneo por paquete; «No lo recojo» + motivo (2) cuando aplica | N | Motorizado |
| Reasignar lo no recogido | «Despacho del día», aviso «N no recogidos por Roy» → «Reasignar a…» (2) | 2 | Supervisor |
| Reportar | `/reparto` (sin cambios de clics; la foto usa el gesto único) | 6-7 | Motorizado |

Un pedido pasa de **3 pantallas y 9-10 clics a 1 pantalla y 2 + N clics** para
el supervisor; el motorizado deja de ver la ruta hasta que aceptó su caja.

## 3. Qué cambia en datos y código

- `dispatch_manifest_items.pickup_declined_at / _reason / _by` (0174): el
  motorizado rechaza un paquete de su caja. El rechazo lo retira de la carga
  (`removed_at` con motivo «No recogido por X: …») para que la custodia pase con
  los aceptados y el paquete quede libre para otra ruta; la solicitud
  logística vuelve a `accepted` con observación. RPC `gf_rider_decline`.
- `dispatch_route_reassigned` (order_events): mover un paquete de la caja de
  un motorizado a la de otro en el mismo día, con origen y destino.
- `components/scan-action.tsx` + `lib/scan-action.ts`: el gesto único.
  `context` decide acción y evento: `oficina_cotejo` → `office_checked`;
  `motorizado_recepcion` → `pickup_checked` / `pickup_declined`;
  `motorizado_entrega` → foto de la parada; `supervisor_retiro` → `package_removed`.
- Pestaña «Despacho del día» (`components/dispatch-day-board.tsx`) sobre las
  acciones que ya existían: `takeAndAssignGroupGfCourierOrders`,
  `assignGroupGfCourierRoute`, `scanManifestItem`, `removeManifestItem`, y la
  nueva `moveManifestItem`.
- La pestaña «Actividad» del Master etiqueta los hitos del despacho en español
  (tomado, asignado, cotejado, recibido, no recogido, reasignado, retirado) y
  `/dashboard/courier` enlaza «Ver actividad» por pedido.
