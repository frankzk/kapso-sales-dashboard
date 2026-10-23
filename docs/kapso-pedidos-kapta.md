# Pedidos del bot de Kapso por Kapta — contrato HTTP

Para quien edita el workflow de Kapso de **Kenku Perú** y **Aurela**. Regla de
negocio: MOM §38.13 (`docs/mom/master-pedidos-v1.md`).

**Qué cambia.** Hoy el bot crea sus pedidos directamente en Shopify (Admin API).
Shopify cierra las dos tiendas el **lunes 27-10-2026 a las 19:00 de Lima** (peor
caso) y los pedidos nuevos pasan a WooCommerce. Decisión del owner (plan D5): el
bot **no** habla con WooCommerce; le pide el pedido a Kapta, y Kapta lo crea con
el mismo camino que «Generar pedido» de las asesoras: WooCommerce tiene que
guardar exactamente el precio que manda el bot antes de que el pedido sea real
(el precio en sí lo decide el bot: sección 8), el pedido lleva las marcas del
bot (`kapso`, `whatsapp` y la conversación) y entra al Master, gana el lead y
cuenta en los rollups del bot como siempre.

**Hasta que la tienda esté en WooCommerce** (Ajustes → WooCommerce → «Crear los
pedidos nuevos en»), el bot sigue con su acción de Shopify de hoy. Kapta contesta
`409 wrong_platform` y **no crea nada** (sección 7).

---

## 1. La llamada

```
POST https://<Kapta>/api/internal/orders/<storeId>
Authorization: Bearer <secreto del bot de esa tienda>
Content-Type: application/json
```

- **La dirección y el secreto salen de Ajustes de cada tienda**, sección «Bot de
  Kapso → pedidos por Kapta». Una dirección y un secreto por tienda: Kenku y
  Aurela tienen los suyos. El secreto se muestra **una sola vez** al generarlo;
  Kapta guarda solo su huella (sha256) y no puede volver a mostrarlo. Si se
  pierde, se genera otro (el anterior deja de servir en ese instante).
- En Kapso, guardarlos como secrets de la función que llama (por ejemplo
  `KAPTA_ORDERS_URL` y `KAPTA_ORDERS_SECRET`), igual que `STORE_WEBHOOK_URL` y
  `STORE_WEBHOOK_SECRET` (docs/kapso-functions/README.md): los secrets son por
  función.
- **Tiempo de espera de la acción: 60 s o más.** Kapta contesta normalmente en
  3-8 s; con WooCommerce lento, antes de los 60 s (la venta termina a los 42 s de
  empezada la llamada).
- El cuerpo, como mucho 16 KB (`413 body_too_large` si pasa).
- No usar `CRON_SECRET` ni el secreto de los webhooks de Kapso: no sirven aquí.

## 2. El cuerpo

Nombres de campo en inglés, en `snake_case`. **Estricto**: un campo que no está
en la tabla es un error (`invalid_body`), para que un nombre mal escrito
(`referencia` en vez de `reference`) no se pierda en silencio. Los números van
como números JSON y los textos como texto.

| Campo | Tipo | Obligatorio | Regla |
| --- | --- | --- | --- |
| `request_id` | texto | sí | Un uuid (o de 8 a 64 letras, dígitos, `-`, `_`). **Uno por pedido, el mismo en cada reintento de ese pedido** (sección 5). |
| `conversation_id` | texto | sí | El id de la conversación de Kapso (hasta 128, sin espacios). Es la marca que gana el lead. |
| `phone` | texto | sí | El celular peruano de la clienta: 9 dígitos que empiezan por 9, con o sin `51`, `+51`, espacios o guiones. |
| `customer_name` | texto | sí | Nombre y apellido (hasta 120). La primera palabra es el nombre y el resto el apellido. |
| `address1` | texto | sí | Calle y número (hasta 200). Para una agencia, la agencia u oficina (por ejemplo «Agencia Shalom Av. Arequipa 123»). |
| `reference` | texto | no | La referencia (hasta 200). |
| `district` | texto | sí | El distrito (hasta 100). |
| `department` | texto | sí | El departamento como lo dice el bot: «Lima», «Callao», «Arequipa», «Lima (departamento)» para Huaral, Cañete, Barranca… Uno que no se reconoce es un error. |
| `items` | lista | sí | De 1 a 20 productos (abajo). |
| `items[].sku` | texto | sí | El SKU del producto o **de la variación** (la talla, el color): el mismo que en Shopify. Nunca el SKU del producto «padre» de uno con variaciones. |
| `items[].quantity` | entero | sí | De 1 a 99. |
| `items[].unit_price` | número | sí | El precio unitario **pactado** en soles, con hasta 2 decimales. `0` es un regalo. Nunca negativo. |
| `items[].name` | texto | no | Solo para los mensajes de error («EggMixer»). El producto lo decide el SKU. |
| `discount` | objeto | no | `{"kind": "fixed", "value": 10}` (soles) o `{"kind": "percent", "value": 10}` (hasta 100): un descuento para todo el pedido, como en «Generar pedido». |
| `shipping_mode` | texto | no | Cómo se entrega, como lo contesta `check-coverage` (`shippingMode`): `contraentrega` (o `cod`) o `agencia` (o `agency`). Sin él, contraentrega. Es el `shipping_mode` que el bot escribe hoy en Shopify: decide «Contraentrega» o «Agencia» en el Master, los rollups y la hoja. |
| `tags` | lista | no | Las etiquetas que el bot pone hoy en Shopify además del canal: `["promo-whatsapp"]`, `["stock-por-validar"]` o las dos. Ninguna otra. |
| `note` | texto | no | Nota del pedido (hasta 500). |
| `cart_draft_gid` | texto | no | Solo si el pedido **cierra un carrito** de las plantillas `carrito_abandonado_*`: el id del borrador (`gid://shopify/DraftOrder/…`, el mismo que usa hoy el bot). Ver sección 6. |

Reglas del pedido: el pago es contraentrega en WooCommerce (se cobra al
entregar o al recoger), sin cobro de envío, y el total (productos − descuento)
tiene que ser mayor que 0: un pedido solo de regalos no se crea.

**Agencia (Shalom, Olva).** Kapta todavía no registra el adelanto: el pedido
entra con su total entero. `check-coverage` pide el voucher antes de confirmar
(`requiresVoucherBeforeConfirmation`) y contesta `shouldCreateOrder: false`.
Hasta que el owner decida (sección 9): si el bot crea un pedido de agencia, lo
hace **solo con el voucher recibido**, con `shipping_mode: "agencia"`, y dice
el pago en `note` («Adelanto S/30 Yape, voucher recibido; saldo al recoger en
la agencia»; Olva: «Pago completo Yape, voucher recibido»). Si no, deriva como
hoy.

Ejemplo (datos inventados):

```json
{
  "request_id": "6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
  "conversation_id": "conv_01JB2X7Q8PRUEBA",
  "phone": "999000111",
  "customer_name": "María Prueba Quispe",
  "address1": "Av. Ejemplo 123, dpto. 401",
  "reference": "Frente al parque",
  "district": "Santiago de Surco",
  "department": "Lima",
  "items": [
    { "sku": "EGG-1", "quantity": 1, "unit_price": 89.0, "name": "EggMixer" },
    { "sku": "PAPEL-1", "quantity": 1, "unit_price": 0, "name": "Papel para freidora (regalo)" }
  ],
  "shipping_mode": "contraentrega",
  "tags": ["promo-whatsapp"],
  "note": "Llamar antes de llegar"
}
```

## 3. La respuesta cuando sale bien

`200`:

```json
{ "ok": true, "order": { "name": "#KP200123", "id": "wc-kp-123", "total": 89, "currency": "PEN" } }
```

- `order.name` es el número que se le dice a la clienta (`#KP2…` en Kenku,
  `#AUR9…` en Aurela). `total` es el total del pedido.
- Si ese pedido ya estaba creado (el mismo `request_id`, o el mismo pedido
  pedido dos veces: sección 5), la respuesta es la misma, con `"replay": true`:
  **no se creó otro**. El bot confirma igual.

Mensaje sugerido a la clienta, contraentrega (el de hoy, con el número de Kapta):

```
{Nombre} listo, tu pedido {order.name} ha sido reservado con éxito.
✅ {Producto} x {cantidad}
💰 Total: S/ {order.total} — pagas al recibir
📍 Entrega: {dirección}
Te avisaremos cuando salga a reparto. ¡Gracias por tu compra! 🙌
```

Agencia: **nunca «pagas al recibir»**; el saldo que dice `check-coverage`:

```
{Nombre} listo, tu pedido {order.name} ha sido reservado con éxito.
✅ {Producto} x {cantidad}
💰 Total: S/ {order.total} — adelanto recibido; el saldo lo pagas al recoger en {agencia}
Te avisaremos cuando salga. ¡Gracias por tu compra! 🙌
```

## 4. Los errores

Cuerpo de un error:

```json
{ "ok": false, "code": "price_mismatch", "message": "…", "retryable": false }
```

- `code` es **estable**: el workflow decide por él. `message` es para quien lee
  los registros de Kapso (en castellano, sin datos de la clienta); **no se le lee
  a la clienta**.
- `retryable: true` quiere decir que reintentar **con el mismo `request_id`**
  puede salir bien. Reintentar con el mismo `request_id` es siempre seguro:
  nunca crea un segundo pedido.
- `retry_after_seconds` (y la cabecera `Retry-After`): cuánto esperar antes del
  siguiente intento (de 5 a 15 s).
- `invalid_body` trae además `errors`: cada problema, por campo.
- `order_left_open` (solo a veces): el número de un pedido de este intento que
  quedó en WooCommerce **sin confirmar** (no se pudo borrar o anular, o quedó a
  medias). Va en el motivo del handoff (abajo). Kapta además deja la constancia
  en el lead y lo sube a «⚡ Atender ahora».

| `code` | HTTP | ¿Reintentar? | Qué pasó | Qué hace el bot |
| --- | --- | --- | --- | --- |
| `unauthorized` | 401 | no | Falta el secreto, o no es el de esa tienda (o se cambió en Ajustes). | Derivar a una asesora y avisar al equipo: es configuración. |
| `body_too_large` | 413 | no | El cuerpo pasa de 16 KB. | Derivar y avisar al equipo: es un error del workflow. |
| `invalid_body` | 400 | no | Faltan datos o no sirven (`errors`). | Si falta un dato de la clienta (celular, dirección, distrito), pedírselo y volver a llamar con un `request_id` **nuevo**. Si es un error del workflow, derivar. |
| `wrong_platform` | 409 | no | La tienda todavía crea sus pedidos en Shopify. Kapta no creó nada. | Antes del corte: seguir con la acción de Shopify de hoy. Después del corte no debería pasar: derivar y avisar. |
| `store_inactive` | 409 | no | La tienda está pausada en Kapta. | Derivar a una asesora. |
| `rate_limited` | 429 | sí | Más de 20 pedidos nuevos del bot en un minuto en la tienda (un bucle). | Reintentar (regla de abajo); si no sale, derivar y avisar. |
| `duplicate_in_progress` | 409 | sí | Otra llamada con el mismo `request_id` (o con exactamente el mismo pedido) lo está creando, o WooCommerce no contestó y Kapta espera a que termine. | **No derivar**: seguir reintentando con el mismo `request_id` (regla de abajo). Recibirá el pedido (`replay`) o un error que dice qué hacer. |
| `conflict` | 409 | no | Ese `request_id` ya se usó con **otros** datos (y quizá ya creó un pedido, que viene en `order`), o el mismo pedido con otro `request_id` quedó a medias. No se creó nada nuevo. | No reintentar. Derivar a una asesora con el motivo de abajo. Es un error del workflow: un pedido distinto lleva otro `request_id`. |
| `expired` | 409 | no | Ese `request_id` empezó hace más de 90 minutos y no terminó: Kapta ya no puede asegurar que no exista su pedido, así que no crea otro. | Derivar con el motivo de abajo: la asesora revisa WooCommerce antes de generar. |
| `sku_not_found` | 422 | no | Un SKU no existe en WooCommerce, es de otro producto, o es el del producto «padre» y no el de la variación. El pedido no quedó (salvo `order_left_open`). | Derivar: «una asesora confirma tu pedido en unos minutos». Avisar al equipo del SKU. |
| `price_mismatch` | 422 | no | WooCommerce guardó otro precio que el mandado (o cobra envío, impuestos o un cargo). El pedido se borró (salvo `order_left_open`). | Derivar. No ofrecer otro precio. |
| `order_mismatch` | 422 | no | WooCommerce guardó otra cosa (otra cantidad, una línea de menos). El pedido se borró (salvo `order_left_open`). | Derivar. |
| `woocommerce_unavailable` | 503 | sí | WooCommerce no contestó, o no confirmó a tiempo. Si un pedido quedó a medias o WooCommerce pudo crearlo sin contestar, Kapta lo retoma en el reintento. | Reintentar (regla de abajo). |
| `store_unavailable` | 503 | sí | Kapta no pudo leer la tienda, o su base no contestó a tiempo. | Reintentar (regla de abajo). |
| `migration_missing` | 503 | no | Falta preparar la base de Kapta (0277). | Derivar y avisar al equipo. |
| `internal_error` | 500 | sí | Error de Kapta. | Reintentar (regla de abajo). |
| (sin respuesta) | — | sí | Se cortó la red o se acabó el tiempo de la acción: **el pedido puede haberse creado**. | Reintentar con el **mismo** `request_id` (nunca uno nuevo): si se creó, vuelve el mismo pedido. |

**La regla de los reintentos** (todo código con `retryable: true`, y la falta de
respuesta): esperar `retry_after_seconds` (10 s si no viene) y volver a llamar
con el **mismo** `request_id` y el **mismo** cuerpo, **durante 3 minutos
desde el primer intento**. Mientras la respuesta sea `duplicate_in_progress`,
**no derivar**: Kapta nunca tiene un pedido en curso más de 2 minutos, y en
esos 3 la respuesta pasa a ser el pedido (`replay`) o un error que dice qué
hacer. `rate_limited`, `store_unavailable`, `internal_error` y
`woocommerce_unavailable` se reintentan igual. Mientras tanto, a la clienta:
«Estamos confirmando tu pedido, un momento 🙏». Pasados los 3 minutos sin
pedido, derivar con el motivo de abajo.

**Derivar a una asesora** es el handoff que ya existe (`notify-team` →
`postStoreHandoff`, docs/kapso-functions/README.md): `event:
"workflow.execution.handoff"`, con `reason` y `context_summary` con lo que
pidió la clienta (productos, cantidades, precio pactado, dirección). La
conversación aparece en «⚡ Atender ahora» y la asesora genera el pedido desde
Leads. El `reason`:

- siempre `pedido no creado: <code> · request_id <request_id>`;
- si hubo algún reintento, falta de respuesta, `conflict` o `expired`, además:
  `· puede existir el pedido kapso-<request_id>: revisar WooCommerce antes de
  generar`;
- si vino `order_left_open`, además: `· quedó <order_left_open> en
  WooCommerce: revisar antes de generar`.

(En WooCommerce el pedido del bot lleva `kapta_request_id = kapso-<request_id>`;
en Leads, «Generar pedido» avisa si la clienta ya tiene un pedido vivo con los
mismos productos.) A la clienta:

```
Gracias {Nombre} 🙌 Una asesora va a confirmar tu pedido en unos minutos por aquí mismo.
```

**Nunca** crear el pedido en Shopify después de un error de Kapta (salvo
`wrong_platform`, antes del corte): con la tienda en WooCommerce sería un
pedido en una tienda que cierra, o un segundo pedido.

## 5. El `request_id`

- El bot lo genera (un uuid v4) **cuando la clienta confirma** el pedido y lo
  guarda en las variables de la conversación. **No** lo genera la función que
  llama a Kapta en cada llamada: así un reintento lleva el mismo.
- Es el **mismo en cada reintento** de ese pedido (sin respuesta,
  `duplicate_in_progress`, `woocommerce_unavailable`…). Así Kapta nunca crea dos
  pedidos, aunque Kapso reintente solo y en paralelo: la base de Kapta tiene un
  candado por (tienda, `request_id`).
- Un pedido **distinto** (la clienta cambió algo, o pide otro después) lleva un
  `request_id` **nuevo**. Mandar el mismo `request_id` con otros datos es
  `conflict`.
- **El mismo pedido con otro `request_id`** (exactamente la misma conversación,
  celular, dirección, productos, cantidades, precios, entrega, etiquetas y nota)
  dentro de **10 minutos** es el mismo pedido pedido dos veces (la herramienta
  llamada dos veces): Kapta devuelve el primero (`replay`) y no crea otro. Si
  la clienta de verdad quiere un segundo pedido idéntico en esos 10 minutos, lo
  genera una asesora. Dos llamadas **simultáneas** con ids distintos y el mismo
  pedido no se frenan así: por eso el id se genera una sola vez.
- En WooCommerce el pedido lleva `kapta_request_id = kapso-<request_id>`.

## 6. Carritos abandonados

Desde el corte, una clienta que contesta a `carrito_abandonado_1/2` con la
tienda en WooCommerce **no se cierra completando el borrador de Shopify**
(`draftOrderComplete`): Shopify ya no es la tienda. El bot pide el pedido a
Kapta como uno nuevo, con los productos (SKU), cantidades y precios del carrito
y la dirección confirmada, y con `cart_draft_gid` = el id del borrador. Kapta:

- crea el pedido en WooCommerce con las marcas del bot (`kapso`, `whatsapp`):
  cuenta como **Bot de Kapso** en el canal de cierre (§17.3), no como «Web»
  ni como el bot de carritos externo («BOT + CARRITO RECUPERADO»);
- deja como completado el carrito **del lead de esa clienta** (su celular o su
  conversación): deja de verse «Carrito abandonado» y la secuencia no le
  escribe más. Un `cart_draft_gid` que no es de esa clienta no cierra nada.

Ojo: en Shopify `draftOrderComplete` cobraba los precios guardados en el
borrador; aquí cobra los que manda el bot. Mandar **los precios del carrito**,
no otros (sección 8).

Después del cierre el bot ya no puede leer el borrador en Shopify. Si no tiene
los SKU y precios del carrito (de las variables de la plantilla o de la
conversación), deriva a una asesora: ella lo genera desde Leads con el carrito
prellenado desde la copia de Kapta.

## 7. El plan del corte

1. **Antes del 27-10** (Kapta): la migración 0277 aplicada y el código
   desplegado (DEPLOY.md, entrada del 23-10-2026). Nada cambia para el bot.
2. **Ensayo, opcional, antes del corte**: generar el secreto en Ajustes, armar
   en Kapso la acción nueva «Crear pedido en Kapta» **sin conectarla al flujo**
   y llamarla a mano con un pedido de prueba. Con la tienda todavía en Shopify
   la respuesta correcta es `409 wrong_platform` (la dirección, el secreto y el
   cuerpo están bien; no se creó nada). `401` es el secreto; `400`, el cuerpo
   (`errors` dice qué).
3. **El 27-10, después de que el owner pase la tienda a WooCommerce** (Ajustes →
   WooCommerce → «Crear los pedidos nuevos en» → WooCommerce):
   1. en Ajustes → «Bot de Kapso → pedidos por Kapta», **generar el secreto**
      (si no se generó en el ensayo) y pegarlo en Kapso;
   2. en el workflow, **cambiar la acción que crea el pedido**: de la de Shopify
      a «Crear pedido en Kapta», con la regla de reintentos de la sección 4. Lo
      mismo en la recuperación de carritos (sección 6);
   3. mirar de cerca el primer pedido del bot: `#KP2…`/`#AUR9…` en WooCommerce
      en «Procesando», con `kapta_channel = kapso`, y en el Master con las
      etiquetas `kapso`, `whatsapp` y su modo de entrega.
4. **Marcha atrás**: mientras Shopify viva, volver a apuntar la acción a Shopify
   (y la tienda a Shopify en Ajustes). Para cortar al bot en seco: «Desactivar»
   en Ajustes (contesta 401 y el bot deriva).

## 8. Los precios los decide el bot (riesgo aceptado, pendiente del owner)

Kapta comprueba que WooCommerce guarde **exactamente** el precio que manda el
bot (si no, `price_mismatch` y el pedido se borra), pero **no** lo compara con
el catálogo: cualquier `unit_price` de 0 o más se acepta, un regalo puede ser
cualquier producto a S/ 0 y un descuento puede llegar al 100 % menos un
céntimo. Es la regla del formulario de «Generar pedido», pensada para una
asesora con sesión; aquí el que llama es un agente que conversa con la
clienta. Hasta que el owner decida un piso (sección 9), las instrucciones del
agente tienen que fijar los precios del catálogo y de las promociones vigentes
y **no** aceptar precios que diga la clienta («la asesora me lo dejó en…»):
eso se deriva.

## 9. Pendiente del owner

- **Piso de precios** (sección 8): ¿se rechaza un precio por debajo del catálogo
  menos un descuento máximo por tienda, y un precio 0 fuera de una lista de
  regalos? Con un `cart_draft_gid`, ¿se exige que los precios sean los de la
  copia del carrito en Kapta? Con la decisión, Kapta contestaría un código nuevo
  (`price_not_allowed`) y el bot derivaría.
- **Los pedidos de agencia** (sección 2): ¿los crea el bot (con el voucher ya
  recibido y el adelanto en la nota), o se derivan siempre a una asesora? ¿Se
  registra el adelanto en Kapta?
