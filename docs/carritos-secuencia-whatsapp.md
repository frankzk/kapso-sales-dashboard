# Secuencia de WhatsApp para carritos abandonados

Dos plantillas aprobadas por Meta que se envían solas a los carritos COD
abandonados (formulario Releasit de Shopify), ancladas a la **creación del
carrito**: por defecto **+3 horas** y **+24 horas** (configurables por tienda
en Ajustes, igual que la ventana horaria de envío, default 8am–9pm hora local).
Aplica a Kenku Peru y Aurela por separado — cada tienda activa la suya.

## Cómo funciona (lado dashboard — ya implementado)

- Corre dentro del cron de sync (cada 5 min), como el drip de seguimiento.
- **Solo-envío**: nunca cambia `status`/`category`/`next_followup_at` del lead.
  Por eso corre **en paralelo** con la gestión de las asesoras, el reencolado a
  "sin llamar" y las olas de atención, sin cruzarse con ninguno.
- **Se detiene sola** cuando: el lead ya tiene pedido o quedó **ganado**; lo
  marcaron **perdido** (cancelado, ya compró en otro lado, lista negra, número
  inválido…); el carrito se **completó o borró** en Shopify; o el cliente
  **respondió** después de dejar el carrito (ahí lo toma el bot o la asesora).
- Un **carrito nuevo** (otro draft) reinicia la secuencia — es una nueva compra.
- Máximo 2 toques por carrito; espaciado mínimo de 1h entre toques; tope de 25
  envíos por tienda por corrida; si Meta devuelve un tope de mensajería, el
  lote se corta sin castigar a los leads.
- Cada envío queda en el historial del lead (`lead_calls`) y en la tabla de
  auditoría `cart_seq_sends` (sirve para medir recuperación: ¿pedido después
  de `sent_at`?).
- El envío sale por el número de WhatsApp por el que escribió el cliente
  (multinúmero), con fallback al número default de la tienda.

**Nada se envía hasta que actives el toggle en Ajustes** y pongas los nombres
de las plantillas ya aprobadas.

## Plantillas a crear en Meta (Kapso → WhatsApp Manager)

Ambas de categoría **Marketing**, idioma **es**, con dos variables de cuerpo:
`{{1}}` = nombre del cliente, `{{2}}` = producto(s) del carrito. Textos
sugeridos (ajústalos al tono de cada marca):

### Plantilla 1 — `carrito_abandonado_1` (se envía ~3h después)

> Hola {{1}} 👋 Vimos que dejaste tu pedido de *{{2}}* a un paso de
> completarse. ¿Te ayudo a terminarlo? Pagas **al recibir** (contraentrega) y
> el envío es gratis en la mayoría de zonas. Respóndeme *SÍ* y lo confirmamos
> de una vez ✅

Botones sugeridos (quick reply): `Sí, confirmar pedido` · `Tengo una duda`

### Plantilla 2 — `carrito_abandonado_2` (se envía ~24h después)

> Hola {{1}}, tu pedido de *{{2}}* sigue reservado 😊 Es el último recordatorio
> que te enviamos. Si quieres recibirlo pagando **al recibir**, respóndeme
> *SÍ* y lo dejamos confirmado hoy mismo. Si ya no lo deseas, no hay problema
> — gracias por visitarnos 🙏

Botones sugeridos (quick reply): `Sí, confirmar pedido` · `Ya no lo quiero`

Notas de aprobación:
- Meta revisa las plantillas (horas a ~1 día). Evita MAYÚSCULAS excesivas y
  signos repetidos (!!!) que suelen rechazarse.
- Los botones quick-reply no llevan variables; el cuerpo solo las 2 indicadas.
- Cuando estén **aprobadas**, pon su nombre exacto e idioma en
  Ajustes → "Secuencia de carritos abandonados" y habilita el envío.

## Spec del workflow en Kapso ("si acepta → subir el pedido")

El bot debe cerrar el ciclo cuando el cliente responde a cualquiera de las dos
plantillas. Configurar en el workflow del bot (por tienda):

1. **Disparador**: mensaje entrante cuyo contexto es la respuesta a las
   plantillas `carrito_abandonado_1/2` (o cualquier inbound de un contacto con
   carrito abierto). Con el quick reply `Sí, confirmar pedido` la intención es
   explícita; con texto libre, clasificar intención de compra como ya hace el
   flujo normal.

2. **Si acepta** (quick reply "Sí" o intención afirmativa):
   - Confirmar/completar los datos de entrega si falta algo (dirección,
     distrito, referencia) — el draft ya los trae del formulario COD.
   - **Completar el draft order en Shopify** (mutation
     `draftOrderComplete(id, paymentPending: true)`) — el mismo draft del
     carrito; NO crear una orden nueva desde cero, para no duplicar.
     `paymentPending: true` es clave: es contraentrega, la orden debe quedar
     "pendiente de pago".
   - Nada más que hacer en el dashboard: el webhook de Shopify ya existente
     (`draft_orders/update` + `orders/create`) detecta el draft completado,
     marca el lead **Ganado** (`pedido_generado`), etiqueta la orden
     `kapso + cod_recuperado` para que cuente en ingresos, y la secuencia se
     detiene sola (el carrito dejó de estar abierto).

3. **Si duda o pregunta**: derivar al flujo normal del bot (o handoff a
   asesora). El inbound del cliente ya detuvo la secuencia automáticamente.

4. **Si rechaza** ("Ya no lo quiero"): opcionalmente responder cortésmente y
   NO completar el draft. La secuencia no vuelve a escribirle (el toque 2 solo
   sale si no hubo respuesta). La asesora puede marcarlo perdido en el
   dashboard si corresponde.

Requisito de permisos: el token de Shopify de cada tienda necesita
`write_draft_orders` (el mismo scope que ya usa "Generar pedido" del drawer).

## Verificación end-to-end (cuando las plantillas estén aprobadas)

1. En Ajustes de la tienda: habilitar la secuencia con horas cortas de prueba
   (p.ej. mensaje 1 = 1h) y las plantillas aprobadas.
2. Dejar un carrito de prueba en el formulario COD con tu número.
3. Esperar el cron (+la hora configurada, dentro del horario): llega la
   plantilla 1; en el lead del dashboard aparece "📤 Carrito: plantilla …
   enviada (toque 1/2)".
4. Responder "SÍ" → el bot completa el draft → el lead pasa a Ganado y en
   `cart_seq_sends` queda el registro para atribución.
5. Con otro carrito, no responder: a las +24h llega la plantilla 2 y después
   no llega nada más (tope).
