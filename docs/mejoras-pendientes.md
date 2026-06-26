# Mejoras pendientes (backlog)

> Ideas validadas con el equipo, **documentadas para implementar más adelante**.
> Por ahora se prioriza validar la feature de carritos abandonados en producción.

---

## 1. Chat de WhatsApp embebido en el drawer

Ver el plan detallado en [`chat-drawer-plan.md`](./chat-drawer-plan.md): leer la
conversación de Kapso y responder desde el drawer, multitienda, sync en vivo,
ventanas de 24h + plantillas.

---

## 2. "Cerrar venta" estructurada (selector de productos reales)

**Problema detectado.** El cierre manual — "Cerrar venta · contraentrega"
(`CloseSaleForm` → `closeSale` en `app/dashboard/leads/actions.ts`) — es **texto
libre**: monto, producto y distrito arbitrarios, sin validar contra el catálogo.
Se puede registrar cualquier producto a cualquier precio.

> ⚠️ Importante: esto **NO** aplica al botón de carritos **"Generar pedido"**
> (`recoverCart`), que completa el borrador real de Releasit con producto, precio
> y dirección reales. El freeform es solo el cierre **manual** (leads sin carrito).

**Objetivo.** Que el cierre manual se parezca a la pantalla nativa de Shopify
("Create order" → "Seleccionar productos"): productos reales del catálogo, con
**stock y precio reales**.

**Diseño propuesto.**
- **Selector de productos** que busca en el catálogo de Shopify (Admin API; el
  token ya tiene `read_products`) y muestra **título · stock disponible · precio
  real**. El asesor elige producto(s) + cantidad y el **monto se calcula solo**.
  - *Bonus:* el stock visible apoya el estado "Sin stock" — se ve la
    disponibilidad real al momento de cerrar.
- **Distrito como lista** estructurada (distritos de Lima/Perú), no texto libre.
- **Ocultar "Cerrar venta" cuando el lead ya tiene carrito** → ahí debe usarse
  "Generar pedido" (datos reales del borrador). Evita los dos botones a la vez.
- **Dos niveles** (elegir al construir):
  - **(a) Form estructurado:** productos/precio reales + distrito, guardado en
    nuestra BD como hoy (orden manual `tag:kapso` + `venta_manual`). Menor esfuerzo.
  - **(b) Pedido real en Shopify:** crear un draft order / orden real con esos
    line items + cliente + dirección, como la UI nativa. Más completo, vive en
    Shopify (y lo levanta el sync de órdenes/borradores).

**Archivos.** nuevo server action de búsqueda de productos (`shopifyGraphQL` en
`lib/shopify.ts`), `components/leads.tsx` (`CloseSaleForm` → picker),
`app/dashboard/leads/actions.ts` (`closeSale` con line items reales / crear draft).

**Reuso.** `shopifyGraphQL`, `getStoreCreds`, el patrón de `recoverCart`/`closeSale`.
