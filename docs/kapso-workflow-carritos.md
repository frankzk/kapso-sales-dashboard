# Workflow de Kapso — recuperación de carritos (plantillas del dashboard)

Cómo adaptar el workflow del bot para que entienda las respuestas a las
plantillas `carrito_abandonado_1/2` que envía el dashboard, y suba el pedido
cuando el cliente acepta. Tres piezas: (A) el bloque de conocimiento que se
pega en las instrucciones del agente, (B) las acciones/herramientas que el
workflow necesita tener, (C) cómo se cierra el ciclo con el dashboard.

---

## A) Conocimiento para el agente (pegar en las instrucciones del bot)

Pega este bloque (ajusta el nombre de la tienda) en el system prompt /
knowledge del workflow:

```
## Recuperación de carritos abandonados

El sistema envía automáticamente hasta 2 recordatorios de WhatsApp (plantillas
"carrito_abandonado_1" y "carrito_abandonado_2") a clientes que llenaron el
formulario de pedido contra entrega pero no lo completaron. El mensaje que el
cliente recibió incluye: su nombre, el producto y cantidad, el precio total y
la dirección que registró, con dos botones: "CONFIRMA TU PEDIDO" y
"MODIFICAR DIRECCION".

Cuando un cliente responde a uno de estos recordatorios (por botón o texto),
tu trabajo es cerrar el pedido con la MENOR fricción posible. El pedido YA
EXISTE como borrador (draft) en Shopify con todos sus datos — no pidas de
nuevo lo que ya está registrado.

### Si toca "CONFIRMA TU PEDIDO" o expresa intención clara de comprar
("sí", "lo quiero", "confirmo", "está bien", etc.):
1. NO vuelvas a preguntar producto, precio ni dirección. Ya los tiene el
   borrador. Solo si el cliente menciona un cambio, actualízalo primero.
2. Completa el borrador de pedido en Shopify (acción "completar draft") con
   pago pendiente (es contra entrega).
3. Confirma en un solo mensaje, con este formato:
   "{Nombre} listo, tu pedido ha sido reservado con éxito.
    ✅ {Producto} x {cantidad}
    💰 Total: {precio} — pagas al recibir
    📍 Entrega: {dirección}
    Te avisaremos cuando salga a reparto. ¡Gracias por tu compra! 🙌"
4. No ofrezcas productos adicionales en este paso (no frenar la conversión).

### Si toca "MODIFICAR DIRECCION":
1. Pregunta SOLO la dirección nueva: dirección exacta, distrito/ciudad y una
   referencia. Una pregunta, no un interrogatorio.
2. Actualiza la dirección del borrador en Shopify (acción "actualizar draft").
3. Confirma la dirección nueva y ofrece confirmar el pedido:
   "Perfecto, actualicé tu dirección a: {dirección nueva}. ¿Confirmamos tu
    pedido de {producto} por {precio} contra entrega?"
4. Si acepta → sigue el flujo de "CONFIRMA TU PEDIDO".

### Si pregunta algo del producto (dudas, precio, envío):
Responde la duda con la información del catálogo, y cierra SIEMPRE ofreciendo
confirmar el pedido pendiente. No lo trates como cliente nuevo: ya tiene un
carrito armado.

### Si rechaza ("ya no lo quiero", "no me interesa"):
Agradece cordialmente y despídete. NO insistas, NO ofrezcas descuentos salvo
que esté autorizado, y NO completes el borrador. El sistema no le volverá a
escribir por este carrito.

### Reglas duras:
- NUNCA crees un pedido nuevo desde cero si existe un borrador: complétalo.
  Crear otro pedido duplica la venta y el stock.
- Si el borrador ya fue completado (el cliente confirmó antes por otro
  canal), no lo dupliques: infórmale que su pedido ya está registrado con su
  número, y resuelve lo que necesite.
- Si el cliente pide hablar con una persona, deriva a asesora (handoff).
```

---

## B) Acciones que el workflow necesita (configuración técnica)

El bot ya sabe generar pedidos en Shopify (lo hace hoy con ventas del chat).
Para carritos hay que darle DOS acciones sobre el borrador existente, ambas
contra la Admin GraphQL API de Shopify (token de la tienda con scope
`write_draft_orders` — el mismo que usa "Generar pedido" del dashboard):

### 1. Completar el borrador (la venta)

```graphql
mutation CompletarCarrito($id: ID!) {
  draftOrderComplete(id: $id, paymentPending: true) {
    draftOrder { id order { id name } }
    userErrors { field message }
  }
}
```

- `$id` = el GID del borrador (`gid://shopify/DraftOrder/…`).
- `paymentPending: true` es OBLIGATORIO: es contra entrega; sin esto Shopify
  marca la orden como pagada.
- La respuesta trae `order.name` (ej. `#AUR174466`) — úsalo en el mensaje de
  confirmación al cliente.

### 2. Actualizar la dirección (antes de completar, si la cambió)

```graphql
mutation ActualizarDireccion($id: ID!, $input: DraftOrderInput!) {
  draftOrderUpdate(id: $id, input: $input) {
    draftOrder { id }
    userErrors { field message }
  }
}
```

con `$input`:

```json
{
  "shippingAddress": {
    "address1": "<dirección nueva>",
    "address2": "<referencia>",
    "city": "<distrito>",
    "country": "Peru"
  }
}
```

### ¿De dónde saca el bot el GID del borrador?

Opciones, de mejor a peor:
1. **Metadato del contacto/conversación**: si el workflow puede guardar
   variables por contacto, el disparador de la plantilla puede registrar el
   gid (el dashboard lo tiene en `leads.draft_order_gid`).
2. **Búsqueda por teléfono**: consulta a Shopify los draft orders `open` del
   teléfono del chat y toma el más reciente:
   `draftOrders(first: 1, query: "status:open", reverse: true)` filtrando por
   el teléfono en la respuesta, o vía la API del dashboard si prefieren
   centralizarlo.
3. **Pedido nuevo como último recurso**: si no se puede resolver el borrador,
   crear la orden con el flujo actual del bot. Funciona (el dashboard igual
   marca el lead como Ganado por el webhook de la orden), pero deja el
   borrador abierto en Shopify — evitarlo cuando se pueda.

### Reconocer que la respuesta viene de la plantilla

Los botones quick-reply llegan como mensaje entrante con el TEXTO del botón
(`CONFIRMA TU PEDIDO` / `MODIFICAR DIRECCION`) y, según la configuración, un
payload con el nombre de la plantilla. Regla práctica para el trigger del
workflow: **botón con ese texto O cualquier inbound de un contacto con
borrador `open`** → entra a este flujo de recuperación.

---

## C) Cómo se cierra el ciclo con el dashboard (ya funciona, no hay que hacer nada)

Cuando el bot completa el borrador:

1. Shopify dispara los webhooks `draft_orders/update` y `orders/create` que
   el dashboard ya escucha.
2. El dashboard marca el lead como **Ganado** (`pedido_generado`), etiqueta
   la orden `kapso + cod_recuperado` (cuenta en ingresos y en Productividad)
   y la secuencia de carritos se detiene sola (el borrador dejó de estar
   `open`).
3. El envío queda auditado en `cart_seq_sends`, así después se puede medir
   cuántos carritos recuperó la secuencia (¿pedido después de `sent_at`?).

Además, apenas el cliente RESPONDE (aunque no confirme), el próximo sync
detecta el inbound y la secuencia ya no le envía el segundo toque — la
conversación queda en manos del bot/asesora. No hay nada que configurar para
esto.

---

## Checklist de activación (por tienda)

1. ☐ Migración 0040 aplicada en Supabase (ver query abajo).
2. ☐ Plantillas `carrito_abandonado_1/2` **APROBADAS** en Meta (no basta
   crearlas — el estado debe ser "Aprobada" en WhatsApp Manager).
3. ☐ Workflow de Kapso con el conocimiento (A) y las acciones (B).
4. ☐ **Apagar la automatización externa de carritos de esa tienda** (si
   sigue prendida, el cliente recibe mensajes duplicados de dos sistemas).
5. ☐ Ajustes → "Secuencia de carritos abandonados": habilitar + nombres
   exactos de plantilla + idioma (`es`) + horas.
6. ☐ Prueba E2E con un carrito propio (pasos en
   `docs/carritos-secuencia-whatsapp.md`).

Verificación rápida de la migración (Supabase SQL Editor):

```sql
select name, cart_seq_enabled, cart_seq_template_1_name, cart_seq_template_2_name,
       cart_seq_hours_1, cart_seq_hours_2, cart_seq_hour_start, cart_seq_hour_end
from stores;
```

- Si da error "column does not exist" → falta aplicar la 0040.
- Si responde → migración OK, y de paso ves qué tienda tiene la secuencia
  habilitada y con qué plantillas.
