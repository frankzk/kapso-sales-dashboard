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

**Un pedido que ya existe no se vuelve a crear.** Cuando la clienta llega desde
la página de gracias de la web («deseo confirmar mi pedido KP200001…»), el bot
**consulta** ese pedido en Kapta en vez de cotizar y crear otro: sección 10
(desde el 25-10-2026, con la tienda en Shopify o en WooCommerce).

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

**Agencia (Shalom, Olva): el bot no crea el pedido (decisión del owner,
23-10-2026).** Cuando `check-coverage` contesta agencia, el bot **deriva a una
asesora** (handoff de la sección 4, con el voucher si la clienta ya lo mandó) y
la asesora genera el pedido desde Leads con el adelanto. Si igual llega
`shipping_mode: "agencia"`, Kapta contesta `agency_needs_advisor` sin crear
nada.

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
| `agency_needs_advisor` | 422 | no | El pedido es para recoger en agencia: el bot no lo crea (owner, 23-10-2026). Kapta no creó nada. | Derivar a una asesora (con el voucher si ya llegó). |
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

## 8. Los precios los decide el bot (como hoy en Shopify; decisión del owner)

Kapta comprueba que WooCommerce guarde **exactamente** el precio que manda el
bot (si no, `price_mismatch` y el pedido se borra), pero **no** lo compara con
el catálogo: cualquier `unit_price` de 0 o más se acepta, un regalo puede ser
cualquier producto a S/ 0 y un descuento puede llegar al 100 % menos un
céntimo. Es la regla del formulario de «Generar pedido», pensada para una
asesora con sesión; aquí el que llama es un agente que conversa con la
clienta. **El owner decidió (23-10-2026) dejarlo como hoy en Shopify: sin
piso de precios en Kapta.** Por eso las instrucciones del agente tienen que
fijar los precios del catálogo y de las promociones vigentes y **no** aceptar
precios que diga la clienta («la asesora me lo dejó en…»): eso se deriva. Un
piso (código `price_not_allowed`) queda para después del corte.

## 9. Pendiente del owner

- **Decidido el 23-10-2026:** sin piso de precios por ahora (sección 8), y los
  pedidos de agencia se derivan siempre a una asesora (sección 2).
- **Después del corte:** un piso de precios (precio de catálogo menos un
  descuento máximo por tienda, lista de regalos, el precio de la copia del
  carrito con `cart_draft_gid`), con el código `price_not_allowed`.

## 10. Consultar un pedido que ya existe (25-10-2026)

**El caso (24-10-2026).** El checkout de la web (WooCommerce, plugin «COD Core»)
termina en una página de gracias con un botón de WhatsApp que abre el chat con
el bot con el texto ya escrito: «… deseo confirmar mi pedido KP200001 y pagaré
S/ 599.60 en casa», más los productos y la dirección. **Ese pedido ya existe**:
la clienta lo hizo en la web. El bot no lo sabía: lo volvió a cotizar con sus
precios (S/ 665) y ofreció «Confirmar pedido», que habría creado un **segundo
pedido** de la misma clienta, a otro precio. El arreglo es la regla de abajo
(10.1), que se edita en Kapso; Kapta pone la consulta (10.2 a 10.6). Regla de
negocio: MOM §38.13, «Consultar un pedido que ya existe».

### 10.1 La regla del workflow

Cuando el mensaje de la clienta coincide con

```
/deseo confirmar mi pedido\s*#?\s*((?:KP|AUR)\d+)/i
```

(el grupo 1 es el número: `KP200001`, `AUR900001`, `kp200001`), el bot:

1. **No cotiza, no muestra un resumen con sus precios y no crea ningún pedido**
   (ni «Crear pedido en Kapta» ni la acción de Shopify). El pedido ya está
   hecho.
2. **Consulta el pedido en Kapta** (10.2) con ese número y el `phone_number` de
   **la conversación**, nunca un celular escrito en el mensaje. Si la
   conversación no tiene `phone_number` (la clienta usa un nombre de usuario de
   WhatsApp), no consulta: deriva (paso 5).
3. **Si Kapta lo encuentra** (`200`) y no está anulado (`cancelled: false`) ni
   cerrado (`master.stage` distinto de `finalizado`), le confirma **ese pedido**
   con lo que dice Kapta: `order.name`, los productos (`items`), **el total de
   Kapta** (`order.total`) y la dirección (`delivery`). **Nunca el monto, los
   productos ni la dirección que vienen en el mensaje**: la clienta puede editar
   el texto antes de mandarlo. El cobro, por `payment` (10.4): `contraentrega`
   (y `delivery.mode` distinto de `agencia`) → «pagas al recibir»; `pagado` →
   «ya está pagado»; `null` → no decir cómo se paga (si pregunta, derivar).
   Y **marca la conversación como «pedido ya creado»** (por ejemplo, las
   variables `pedido_ya_creado = true` y `pedido_numero = order.name`): ningún
   paso posterior de esa conversación ofrece «Confirmar pedido» ni crea otro
   pedido para lo mismo. Si la clienta quiere cambiar algo (dirección,
   productos, cantidades) o dice otro monto, deriva: el bot no edita pedidos.
4. **Si Kapta contesta `not_found`** (`404`): espera `retry_after_seconds`
   (10 s) y consulta **una sola vez más**. El pedido puede no haber llegado
   todavía: el webhook de WooCommerce tarda unos segundos, y el WooCommerce de
   Kenku todavía no está conectado a Kapta. Mientras tanto, a la clienta: «Un
   momento, estoy buscando tu pedido 🙏».
5. **Si sigue `not_found`**, o el pedido está anulado o cerrado, o hubo
   cualquier otro error (10.5): **deriva a una asesora** con el handoff de la
   sección 4, sin cotizar ni crear nada. El `reason`: `pedido de la web por
   revisar: <número> · <code>` (`not_found`, `cancelled`, `finalizado`, o el
   código del error), y en `context_summary` el mensaje de la clienta tal cual
   (lo que dice que pidió, el monto y la dirección que escribió): la asesora lo
   busca en el Master o en WooCommerce antes de generar nada. A la clienta:

   ```
   Gracias 🙌 Una asesora va a revisar tu pedido {número} en unos minutos por aquí mismo.
   ```

   **Nunca** «ese pedido no existe» ni «ese pedido no es tuyo»: Kapta no dice
   cuál de las dos es (10.3).

Mensaje sugerido cuando lo encuentra (contraentrega a domicilio):

```
¡Listo! Tu pedido {order.name} ya está registrado ✅
✅ {items[].title} {items[].variant} x {items[].quantity}
💰 Total: S/ {order.total} — pagas al recibir
📍 Entrega: {delivery.address1}, {delivery.district}
Te avisaremos cuando salga a reparto. ¡Gracias por tu compra! 🙌
```

`order.total` con dos decimales (`599.6` → `S/ 599.60`). Con `pagado`: «💰
Total: S/ {order.total} — ya está pagado». Con `payment: null`: «💰 Total: S/
{order.total}», sin decir cómo se paga. Con `delivery.mode: "agencia"`: nunca
«pagas al recibir»; confirma el número y los productos y deriva para el
adelanto y la agencia.

### 10.2 La llamada

```
POST https://<Kapta>/api/internal/orders/<storeId>/lookup
Authorization: Bearer <secreto del bot de esa tienda>
Content-Type: application/json
```

- **La dirección es la de crear más `/lookup`** y **el secreto es el mismo**
  (sección 1; Ajustes → «Bot de Kapso → pedidos por Kapta» muestra las dos
  direcciones). En Kapso, como secrets de la función que consulta (por ejemplo
  `KAPTA_ORDERS_URL` y `KAPTA_ORDERS_SECRET`; la consulta va a
  `KAPTA_ORDERS_URL + "/lookup"`). Sin secreto generado en Ajustes contesta 401:
  en Aurela, cuyo bot crea sus pedidos directo en WooCommerce (MOM §38.5), hay
  que generarlo igual para consultar.
- **Funciona con la tienda en Shopify o en WooCommerce**: contesta con lo que
  Kapta tiene, sin mirar la plataforma.
- **Solo lectura.** No crea ni cambia nada, no llama a WooCommerce ni a Shopify
  y no usa `request_id`: repetirla no tiene ningún efecto.
- **POST y no GET**: el celular va en el cuerpo, nunca en la dirección (que
  queda en los registros).
- Tiempo de espera de la acción: **20 s**. Lo normal es menos de un segundo.
- El cuerpo, como mucho 2 KB (`413 body_too_large` si pasa).

El cuerpo, **estricto** como el de crear: un campo que no está en la tabla es un
error (`invalid_body`). El monto que escribió la clienta no se manda: no sirve.

| Campo | Tipo | Obligatorio | Regla |
| --- | --- | --- | --- |
| `order_name` | texto | sí | El número que escribió la clienta: `KP200001`, `#KP200001`, `kp200001`, `#kp 200001`… Con o sin `#`, en cualquier caja: letras (el prefijo de la tienda) y dígitos. |
| `phone` | texto | sí | El `phone_number` de la conversación de Kapso (`51999000111`), con o sin `51`, `+51`, espacios o guiones. **Nunca uno escrito en el mensaje.** |

Ejemplo (datos inventados):

```json
{ "order_name": "KP200001", "phone": "51999000111" }
```

### 10.3 La privacidad: solo el pedido de ese celular

Cualquiera puede escribirle al bot «deseo confirmar mi pedido KP200001». Por
eso Kapta busca el pedido **por su número y por el celular de la conversación a
la vez, en la misma consulta**: solo lo devuelve si el celular del pedido
(`orders.customer_phone`: el que la clienta dejó en el checkout, de facturación
o de envío, normalizado) es el de la conversación, con o sin `51`.

**Con otro celular la respuesta es exactamente la de un número que no existe**:
`404 not_found`, con el mismo cuerpo. No es solo cortesía: Kapta nunca lee el
pedido de otro celular, así que tampoco sabe cuál de las dos es. Un código
aparte («existe, pero es de otro celular») le confirmaría a quien escribe que
ese número de pedido existe, y al workflow no le sirve de nada: en los dos casos
hace lo mismo (una consulta más y, si sigue igual, una asesora).

- El celular de la **guía** del courier no cuenta: es el de quien recibe (lo
  puede escribir el equipo para el courier), no prueba que la conversación sea
  de la clienta. Un pedido sin celular propio no se devuelve.
- Si la clienta dejó en la web otro celular que el de su WhatsApp (el de un
  familiar, uno con un dígito de más), el bot no lo encuentra y la asesora lo
  resuelve. Es el lado seguro.
- La respuesta no trae el nombre, el celular, la referencia ni los precios por
  línea: lo justo para confirmar el pedido.

### 10.4 La respuesta cuando lo encuentra

`200`:

```json
{
  "ok": true,
  "order": {
    "name": "#KP200001",
    "platform": "woocommerce",
    "created_at": "2026-10-24T21:14:03Z",
    "total": 599.6,
    "currency": "PEN",
    "payment": "contraentrega",
    "cancelled": false,
    "delivery": { "mode": null, "district": "Santiago de Surco", "address1": "Av. Ejemplo 123" },
    "items": [
      { "title": "Zapatilla Urbana", "variant": "38 / Negro", "quantity": 2 },
      { "title": "Medias deportivas", "variant": null, "quantity": 1 }
    ],
    "master": { "stage": "por_confirmar", "stage_label": "Por confirmar", "substage": "sin_llamar", "substage_label": "Sin llamar" }
  }
}
```

Cada campo (estables: el workflow decide por ellos):

| Campo | Tipo | Qué es |
| --- | --- | --- |
| `name` | texto | El número del pedido en Kapta, con `#` (`#KP200001`, `#AUR900001`). El que se le dice a la clienta. |
| `platform` | texto | De dónde vino el pedido: `woocommerce` o `shopify`. |
| `created_at` | texto o null | Cuándo se hizo (ISO 8601, UTC). |
| `total` | número o null | El total que Kapta tiene **hoy** (`orders.total_amount`, que se actualiza con cada cambio del pedido en la tienda). **El único monto que el bot dice.** null: la tienda no lo mandó; derivar. |
| `currency` | texto o null | `PEN`. |
| `payment` | texto o null | Cómo se paga, derivado de lo que Kapta guarda (MOM §38.4): `contraentrega` = la pasarela es contraentrega (`payment_gateway = cod`) y no hay ningún pago cargado: paga el total al recibir. `pagado` = cobrado del todo (la pasarela confirmada del checkout, o constancias que cubren el total). `null` = no se sabe (otra pasarela, o ninguna) o hay un pago a medias (un adelanto): no decir cómo se paga. |
| `cancelled` | sí/no | Anulado en la tienda o en Kapta. `true`: no confirmar; derivar. |
| `delivery.mode` | texto o null | `contraentrega` (a domicilio), `agencia` (recoge en agencia) o null (el pedido no lo dice: los de la web suelen venir así). |
| `delivery.district` | texto o null | El distrito vigente: el del Master (con la corrección del equipo, si la hubo) o, si el pedido acaba de llegar, el del pedido. |
| `delivery.address1` | texto o null | La dirección vigente (calle y número), igual. |
| `items[].title` | texto | El producto. |
| `items[].variant` | texto o null | La variante (talla, color), si tiene. |
| `items[].quantity` | entero | Las unidades. |
| `master` | objeto o null | El estado del pedido en el Master de Kapta. null si el pedido acaba de llegar y su fila del Master todavía no está (confirmar igual). |
| `master.stage` | texto | La macroetapa: `por_confirmar`, `preparacion`, `por_despachar`, `en_curso`, `por_cerrar` o `finalizado`. `finalizado`: no confirmar; derivar. |
| `master.stage_label` | texto | Su nombre en pantalla («Por confirmar», «Preparación»…). |
| `master.substage` | texto | La subetapa (`sin_llamar`, `por_confirmar`, `entregado_cerrado`…). |
| `master.substage_label` | texto | Su nombre en pantalla («Sin llamar», «Entregado y cerrado»…). |

**Sin precios por línea, a propósito**: el bot no tiene con qué volver a sumar
ni cotizar. El monto es `total`.

### 10.5 Los errores

El mismo cuerpo que al crear (sección 4): `{ "ok": false, "code", "message",
"retryable", "retry_after_seconds"?, "errors"? }`. `message` es para los
registros de Kapso; **no se le lee a la clienta**.

| `code` | HTTP | ¿Reintentar? | Qué pasó | Qué hace el bot |
| --- | --- | --- | --- | --- |
| `unauthorized` | 401 | no | Falta el secreto, o no es el de esa tienda (o se cambió o se desactivó en Ajustes). | Derivar y avisar al equipo: es configuración. |
| `body_too_large` | 413 | no | El cuerpo pasa de 2 KB. | Derivar y avisar al equipo: es un error del workflow. |
| `invalid_body` | 400 | no | Falta el número o el celular, no sirven, o va un campo de más (`errors`). | Derivar. Si es un error del workflow, avisar al equipo. |
| `not_found` | 404 | sí | Kapta no tiene un pedido con ese número **para ese celular**: no llegó todavía, no existe, o es de otro celular (la misma respuesta, 10.3). | Esperar 10 s y consultar **una vez más**; si sigue, derivar (10.1, paso 5). Nunca cotizar ni crear otro. |
| `store_unavailable` | 503 | sí | La base de Kapta no contestó o falló. | Consultar una vez más a los `retry_after_seconds`; si sigue, derivar. |
| `migration_missing` | 503 | no | Falta preparar la base de Kapta (0277). | Derivar y avisar al equipo. |
| `internal_error` | 500 | sí | Error de Kapta. | Consultar una vez más; si sigue, derivar. |
| (sin respuesta) | — | sí | Se cortó la red o se acabó el tiempo de la acción. | Consultar una vez más; si sigue, derivar. |

**La regla de los reintentos de la consulta** es distinta de la de crear
(sección 4): con `retryable: true`, o sin respuesta, **una sola** consulta más,
a los `retry_after_seconds` (10 s; también en la cabecera `Retry-After`). Si
tampoco sale, derivar a una asesora. Consultar no crea nada, así que no hay
`request_id` ni candado que cuidar; lo que se cuida es que la clienta no espere
de más.

### 10.6 Probarla

Con el secreto ya generado (sección 7, paso 2), llamar a mano a la consulta con
un pedido real de la tienda y **su** celular: `200` con el pedido. Con otro
celular, o con un número que no existe: `404 not_found`, el mismo cuerpo en los
dos. `401` es el secreto; `400`, el cuerpo (`errors` dice qué). En los registros
de Vercel, `[bot-orders-lookup]` es una línea por consulta (la tienda, el
número consultado, `outcome`, `status`, `ms`), sin el celular ni la dirección.
