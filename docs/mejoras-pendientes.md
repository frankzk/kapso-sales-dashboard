# Mejoras pendientes (backlog)

> Ideas validadas con el equipo, **documentadas para implementar más adelante**.
> Por ahora se prioriza validar la feature de carritos abandonados en producción.

---

## 1. Chat de WhatsApp embebido en el drawer

Ver el plan detallado en [`chat-drawer-plan.md`](./chat-drawer-plan.md): leer la
conversación de Kapso y responder desde el drawer, multitienda, sync en vivo,
ventanas de 24h + plantillas.

---

## 2. Formulario final de pedido (unificado, editable y validado)

**Requisito.** Todo pedido que sube a Shopify debe ir **con los datos completos y
correctos** — tanto al **completar un carrito abandonado** como al **registrar una
venta nueva** (del chat/llamada). Hoy ninguno de los dos garantiza eso:

- **"Generar pedido"** (`recoverCart`) **completa el borrador tal cual**, sin paso
  de revisión. Si el carrito de Releasit trae la **dirección incompleta** o algún
  dato malo, generaría el pedido **con datos malos**. ⚠️
- **"Cerrar venta"** (`closeSale`) es **texto libre**: producto/precio/distrito
  arbitrarios, sin validar contra el catálogo.

**Objetivo.** Un **único formulario final de pedido**, con campos completos,
**editables y validados**, que sirva para los dos casos:

- **Carrito abandonado:** se **pre-llena** con los datos del borrador de Releasit
  (productos, precio, cliente, teléfono, dirección, distrito) y el asesor
  **completa/corrige** lo que falte **antes** de generar.
- **Venta nueva (chat/llamada):** el mismo formulario, en blanco.

**Campos + validación.**
- **Productos:** selector del catálogo real de Shopify (título · **stock** ·
  **precio real**) + cantidad → monto calculado. (El stock visible apoya el estado
  "Sin stock".)
- **Cliente:** nombre, teléfono.
- **Dirección completa:** dirección, **distrito**, provincia/región, referencia —
  **obligatorios**. No se puede generar el pedido con la dirección incompleta.
- Bloquear "Generar pedido" hasta que los campos obligatorios estén completos.

**Al confirmar.**
- **Carrito:** actualizar el borrador en Shopify con los datos corregidos
  (`draftOrderUpdate`) y luego completarlo (`draftOrderComplete`) → orden correcta.
- **Venta nueva:** crear el borrador/orden con los datos ingresados.

**Esto reemplaza** el botón directo "Generar pedido" (`RecoverCartButton`) y el
form libre "Cerrar venta" (`CloseSaleForm`) por **un solo flujo** con datos
validados. (Antes "Ocultar Cerrar venta cuando hay carrito" — ya no aplica: es el
mismo formulario.)

**Archivos.** `lib/shopify.ts` (`draftOrderUpdate` + búsqueda de productos),
`components/leads.tsx` (formulario unificado en el drawer),
`app/dashboard/leads/actions.ts` (`recoverCart`/`closeSale` → un flujo validado).

**Reuso.** `shopifyGraphQL`, `getStoreCreds`, `completeDraftOrder`, el patrón de
`recoverCart`/`closeSale`.

**Nota de riesgo (mientras tanto).** Hasta construir esto, "Generar pedido"
completa el borrador **tal cual** → usarlo solo en carritos con datos completos.
