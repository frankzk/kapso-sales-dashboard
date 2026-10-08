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

Mismo formato que la automatización que ya corre en producción (validado con
clientes reales). Ambas de categoría **Marketing**, idioma **es**, con
**header de imagen** (el banner del producto/marca) y **4 variables** de
cuerpo que el dashboard llena solo:

| Variable | Contenido | Ejemplo |
|---|---|---|
| `{{1}}` | Nombre del cliente | `Wilfredo` |
| `{{2}}` | Producto(s) x cantidad | `Set de Pelador de Verduras + Abridor Premium x 1` |
| `{{3}}` | Precio total | `S/.99.00` |
| `{{4}}` | Dirección registrada | `Condominio Orquideas Del Sol, B-5, Cuzco` |

Si al carrito le falta alguno de los 4 datos, ese lead se omite sin gastar el
toque (Meta rechaza variables vacías) y se reintenta cuando el sync los traiga.

### Plantilla 1 — `carrito_abandonado_1` (se envía ~3h después)

> 👋 ¡Hola {{1}}! ¿Cómo te va? Te saludamos desde **Aurela**.
>
> 📦 Vemos que tienes *{{2}}* olvidado en tu carrito por un precio de *{{3}}*
> para pagar *CONTRA ENTREGA*.
>
> Dirección Registrada: {{4}}.
>
> _No dejes pasar esta oportunidad 😕 ¡Aprovecha antes de que se agote! 🔥_
>
> *CONFIRMA AHORA TU PEDIDO* y te lo enviamos hoy mismo.

Botones (quick reply): `CONFIRMA TU PEDIDO` · `MODIFICAR DIRECCION`

### Plantilla 2 — `carrito_abandonado_2` (se envía ~24h después)

> 👋 ¡Hola {{1}}! Te saludamos de nuevo desde **Aurela**.
>
> 📦 Tu *{{2}}* sigue reservado por *{{3}}* para pagar *CONTRA ENTREGA* — es
> nuestro último recordatorio.
>
> Dirección Registrada: {{4}}.
>
> _Stock limitado 😱 Confirma hoy y no te quedes sin el tuyo 🔥_
>
> *CONFIRMA AHORA TU PEDIDO* y sale en el próximo despacho.

Botones (quick reply): `CONFIRMA TU PEDIDO` · `MODIFICAR DIRECCION`

Notas:
- Crear el par **por tienda** ("desde Aurela" / "desde Kenku Peru" es texto
  fijo del cuerpo — cada tienda configura sus propias plantillas en Ajustes).
- **Corrección (07-10-2026):** las plantillas que corren desde el 20-07-2026
  son **solo texto**: el envío nunca mandó cabecera, y una plantilla con
  cabecera de imagen exige la imagen en cada envío. La imagen de muestra que
  pide Meta al crear la plantilla es solo para la revisión: **la imagen SÍ
  puede variar por producto**, porque se manda en cada mensaje. Ver «Prueba:
  mensaje 1 con la foto del producto».
- Los botones quick-reply no llevan variables; el cuerpo solo las 4 indicadas.
- Meta revisa las plantillas (horas a ~1 día). Evita MAYÚSCULAS en exceso
  fuera de las frases clave y signos repetidos (!!!).
- Cuando estén **aprobadas**, pon su nombre exacto e idioma en
  Ajustes → "Secuencia de carritos abandonados" y habilita el envío.

## Prueba: mensaje 1 con la foto del producto (0233, 07-10-2026)

**Por qué.** Del 20-07 al 07-10-2026 se enviaron 14.483 mensajes a 9.072
carritos y el 19,2 % terminó en pedido en 7 días (15 % tras el mensaje 1, 7 %
tras el 2). Todos fueron iguales, así que no hay con qué comparar si una foto
sube el cierre: hay que probarlo.

**Cómo funciona.**
- Solo el **mensaje 1** (el que más convierte). El mensaje 2 sale igual para
  todos.
- Entran los carritos cuyo producto tiene foto en el espejo de catálogo
  (`shopify_product_images`). Los carritos COD llegan **sin `product_id`**, así
  que la foto se busca por el **título** del primer producto (casa en el 99 %).
  Sin foto ⇒ fuera de la prueba, y eso se decide ANTES del sorteo.
- **Sorteo 50/50 por carrito** con un hash del `draft_order_gid`
  (`lib/cart-image-test.ts`): el mismo carrito cae siempre en el mismo grupo.
  «imagen» recibe la plantilla con cabecera de imagen y la foto de SU producto;
  «control», la de siempre. Mismo texto y mismas horas: la foto es lo único
  distinto.
- Meta solo acepta **JPG o PNG** en la cabecera y el 45 % de las fotos de
  Shopify son WebP: la foto va por `/api/wa-image/<tienda>/<producto>.jpg`, que
  la convierte a JPG de 800 px. La ruta recibe tienda y producto, no una URL:
  solo entrega fotos del catálogo de `cdn.shopify.com`.
- Si la plantilla con imagen falla (nombre mal escrito, no aprobada), el cliente
  recibe la de siempre en la misma corrida y ese carrito queda fuera de la
  prueba; el intento fallido queda en `cart_seq_sends`.
- Cada envío guarda su grupo en `cart_seq_sends.variant` (`imagen`, `control`
  o null = fuera de la prueba) y la foto en `image_url`.

**Cómo se lee.** En Ajustes → «Secuencia de carritos abandonados», debajo del
formulario: carritos, compraron (pedido no anulado en los 7 días siguientes al
mensaje 1), tasa, y quién cerró (bot · asistido · asesora, la regla de
«Atribución de ventas»), contados desde que se encendió la prueba
(`stores.cart_seq_image_test_started_at`, `cart_image_test_results`). Con
menos de 300 carritos por grupo no concluye; después, una diferencia cuenta
solo con p < 0,05. A ~110 carritos/día, detectar +5 puntos (15 % → 20 %) toma
2–3 semanas; +3 puntos, ~6.

**Para encenderla.**
1. En WhatsApp Manager, por tienda: `carrito_abandonado_1_img`, copia exacta de
   `carrito_abandonado_1` (mismo texto, 4 variables, mismos botones) con
   **cabecera de tipo imagen**. Meta pide una imagen de muestra: cualquiera
   del producto sirve.
2. Cuando esté aprobada: Ajustes → «Secuencia de carritos abandonados» → nombre
   e idioma de la plantilla con imagen, y encender «Prueba: mensaje 1 con la
   foto del producto».
3. Revisar en el historial de un lead del grupo «imagen» que diga «enviada con
   la foto del producto» y que el mensaje llegó con la foto.

## Spec del workflow en Kapso ("si acepta → subir el pedido")

El bot debe cerrar el ciclo cuando el cliente responde a cualquiera de las dos
plantillas. Configurar en el workflow del bot (por tienda):

1. **Disparador**: mensaje entrante cuyo contexto es la respuesta a las
   plantillas `carrito_abandonado_1/2` (o cualquier inbound de un contacto con
   carrito abierto). Con el quick reply `CONFIRMA TU PEDIDO` la intención es
   explícita; con texto libre, clasificar intención de compra como ya hace el
   flujo normal.

1b. **Quick reply `MODIFICAR DIRECCION`**: pedir la nueva dirección/distrito/
   referencia, actualizarla en el draft (`draftOrderUpdate` → shippingAddress)
   y recién entonces ofrecer confirmar. El sync del dashboard refresca la
   dirección del lead solo.

2. **Si acepta** (quick reply `CONFIRMA TU PEDIDO` o intención afirmativa):
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
