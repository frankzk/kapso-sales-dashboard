# Conversaciones de WhatsApp (Chatby) dentro de Kapta

> Copia del documento que el equipo de la tienda escribió para Kapta (26-10-2026).
> Cómo quedó en Kapta: MOM §25, punto 5 (la pestaña «Chatby»), y DEPLOY.md 5q.1. Lo único
> que Kapta hizo distinto: el `user_ns` no se guarda (se busca por el celular cada
> vez, con un minuto de caché), para no guardar nada que venga de Chatby.

Oct 26, 2026 · @Frankz Kastner

Pedimos que Kapta muestre, en la ficha de cada pedido, la conversación de WhatsApp de la clienta con el bot de confirmación (Chatby), solo para leer, y un botón para abrirla en Chatby. Sirve para Kenku Perú y Aurela, que usan el mismo bot y el mismo número. Lo marcado «verificado» se probó el 25-10-2026 contra la API real.

## Contexto

Hoy el equipo tiene que salir de Kapta e ir a Chatby para ver qué se le dijo a la clienta.

- **Chatby** (`app.chatby.io`) es la plataforma del bot de WhatsApp que confirma los pedidos contra entrega. Bot: «Aurela Kenku BOT».
- Con cada pedido contra entrega de la web, Chatby manda una plantilla de WhatsApp con el pedido. La clienta responde, a veces la atiende una persona del equipo, y al final confirma o anula.
- Al confirmar o anular, Chatby deja en el pedido de WooCommerce la nota «Etiqueta «CONFIRMADO» agregada por la integración (API de pedidos tipo Shopify).» (o «ANULADO»). Esa nota ya les llega con el pedido.
- Lo que falta es ver la conversación: qué se le mandó, qué respondió y si WhatsApp dio un error.

## Qué pedimos

Un panel «WhatsApp (Chatby)» en la ficha del pedido, solo para leer.

1. Los **últimos 20 mensajes** de esa clienta, del más viejo (arriba) al más nuevo (abajo):
   - globos distintos para **cliente**, **bot** y **persona del equipo**;
   - las **notas internas** del equipo, marcadas como internas (no las vio la clienta);
   - las plantillas, con su texto y su nombre;
   - los errores de WhatsApp, en rojo (p. ej. «no entregado»);
   - fecha y hora en **America/Lima**.
2. Un botón **«Abrir en Chatby»** que lleva a esa conversación.
3. **Solo lectura:** Kapta no manda mensajes ni cambia nada en Chatby.
4. **A pedido:** se consulta cuando alguien abre el pedido, no en segundo plano para todos los clientes.

No entra en este pedido: responder desde Kapta, ni copiar el historial completo a Kapta.

## La API y la clave

Se usa la API oficial de Chatby, con dos consultas `GET` y una clave que va solo en el servidor de Kapta.

- **Dirección base:** `https://app.chatby.io/api`. Documentación oficial (OpenAPI): [app.chatby.io/api-docs](https://app.chatby.io/api-docs).
- **Autenticación:** cabecera `Authorization: Bearer <clave>`.
- **La clave es del bot**, no de la cuenta. Se la pasa el owner por un canal privado, nunca por un chat ni un correo sin cifrar.
- **Una clave solo para Kapta:** en Chatby, *Settings → API*, una clave nueva llamada «KAPTA» con el permiso «Manage Flow». Así se puede revocar sin cortar Make, que usa otra.
- **Chatby no tiene claves de solo lectura:** con esa clave se podrían mandar mensajes. Kapta solo debe llamar a los dos `GET` de abajo.
- **La clave va solo en el servidor de Kapta**, nunca en el navegador ni en el código que baja al navegador.

## Paso 1: encontrar a la clienta por su celular

Con el celular del pedido se obtiene el `user_ns`, el id de la clienta en Chatby.

```http
GET https://app.chatby.io/api/subscribers?phone=%2B51987654321&limit=5
Authorization: Bearer <clave>
Accept: application/json
```

- **El celular va en formato internacional, con el `+` codificado como `%2B`.** Verificado: `+51…` la encuentra; `51…` o los 9 dígitos solos devuelven 0 resultados.
- Los pedidos de la web ya traen el celular así (`billing.phone` = `+51987654321`). Para otros orígenes, normalicen: solo dígitos; 9 dígitos que empiezan con 9 → `+51` delante; 11 dígitos que empiezan con 51 → `+` delante.
- Respuesta: `{"data": [ { "user_ns": "f99885u…", "name": "…", "phone": "+51…", "last_message_at": "…", … } ]}`.
- **Usen solo** `user_ns`, `name`, `phone` y `last_message_at`. Descarten lo demás sin guardarlo (ver «Lo que no deben mostrar ni guardar»).
- **0 resultados:** «Esta clienta no tiene conversación en Chatby». **Más de uno** (raro): el de `last_message_at` más reciente.
- El `user_ns` de un celular no cambia: lo pueden guardar junto al cliente.

## Paso 2: traer los mensajes

Con el `user_ns` se piden los últimos 20 mensajes, con los del bot y las notas internas.

```http
GET https://app.chatby.io/api/subscriber/chat-messages?user_ns=<user_ns>&limit=20&include_bot=1&include_note=1
Authorization: Bearer <clave>
Accept: application/json
```

- **`include_bot=1` es obligatorio** para ver las plantillas y respuestas del bot; sin él solo salen los mensajes de personas.
- `include_note=1` trae las notas internas del equipo. `include_system=1` agrega eventos internos («Tag added…», «Mark as open»): no lo recomendamos, es ruido.
- `limit`: de 1 a 100. `start_time` y `end_time` (unix, segundos) solo aceptan fechas **del último mes**.
- **Vienen del más nuevo al más viejo** (verificado): inviertan el orden para mostrarlos.
- Campos de cada mensaje (verificado): `id`, `mid`, `type`, `msg_type`, `content`, `payload`, `sender_id`, `agent_id`, `username`, `ts`, `user_ns`. `ts` es la fecha en unix (segundos): muéstrenla en America/Lima.

| `type` | Quién | Cómo mostrarlo |
| --- | --- | --- |
| `in` | La clienta | Globo de la clienta |
| `out` | El bot (plantillas y mensajes automáticos) | Globo del bot |
| `agent` | Una persona del equipo, desde Chatby | Globo del equipo, con `username` si viene |
| `note` | Nota interna del equipo | Aparte, como nota interna |
| `system` | Eventos internos (solo con `include_system=1`) | No mostrar |

| `msg_type` | Qué mostrar |
| --- | --- |
| `text` | `content` |
| `wa_template` | El texto que leyó la clienta está en `payload.body` (si no viene, `content`, que dice «ES \<nombre>»); el nombre, en `payload.name`. Verificado: el `payload` trae `name`, `category`, `language`, `header`, `body`, `footer` y `text`. |
| `postback` | La clienta tocó un botón: `payload.title` (p. ej. «Confirmar Dirección») |
| `image`, `audio`, `video`, `file` | El tipo de archivo y, si el `payload` trae una dirección, el enlace (no verificado: no había archivos en la conversación de prueba) |
| `error` | Error de WhatsApp: `content` (p. ej. «This message was not delivered…»), en rojo |
| otro | `content`, o el tipo entre corchetes |

## Ejemplo y botón «Abrir en Chatby»

Así llega una respuesta y así se vería en Kapta (datos inventados).

```json
{
  "data": [
    { "id": 905, "type": "in",  "msg_type": "postback", "content": "Confirmar Dirección",
      "payload": { "title": "Confirmar Dirección" }, "ts": 1792952580, "user_ns": "f99885u1000000001" },
    { "id": 904, "type": "note", "msg_type": "text", "content": "PEDIDO CONFIRMADO",
      "payload": { "text": "PEDIDO CONFIRMADO" }, "ts": 1792952574, "user_ns": "f99885u1000000001" },
    { "id": 903, "type": "out", "msg_type": "wa_template", "content": "ES nuevo_pedido_cobertura_lima",
      "payload": { "name": "nuevo_pedido_cobertura_lima", "category": "MARKETING", "language": "es",
                   "body": "¡Hola Ana Pérez! Te saluda … de Kenku. Hemos recibido tu pedido #KP200123. …" },
      "ts": 1792951020, "user_ns": "f99885u1000000001" }
  ]
}
```

```text
25-10 12:57  Bot (plantilla nuevo_pedido_cobertura_lima)
             ¡Hola Ana Pérez! Te saluda … de Kenku. Hemos recibido tu pedido #KP200123. …
25-10 13:22  Nota interna: PEDIDO CONFIRMADO
25-10 13:23  Cliente: [botón] Confirmar Dirección
                                                         [ Abrir en Chatby ]
```

- **Botón «Abrir en Chatby»:** `https://app.chatby.io/inbox/<user_ns>` (verificado: es el enlace que usa el propio panel).
- Pide iniciar sesión en Chatby: sirve para quien tenga usuario ahí.

## Lo que no deben mostrar ni guardar

Las respuestas de Chatby traen datos que no deben salir de la consulta.

- **Los campos del contacto (`user_fields`).** Vienen en `/subscribers` y en `/subscriber/get-info` (52 campos), y **algunos traen claves de las tiendas**: verificado que «\[chatby\] ConexionTienda» trae la clave de la API de pedidos de una tienda. No los muestren, no los guarden y no escriban en sus registros (logs) las respuestas completas.
- **Las conversaciones tienen datos personales** (nombre, dirección, celular). Que solo las vea quien ya puede ver ese pedido en Kapta. No las copien a otra base de datos; si necesitan caché, que dure minutos.
- **Las notas internas**, solo para el equipo.

## Las dos marcas, rendimiento y errores

Un mismo celular puede tener mensajes de Kenku y de Aurela, y la consulta no debe trabar la ficha del pedido.

- **Marcas:** Kenku Perú y Aurela comparten el bot y el número de WhatsApp. Las plantillas dicen la marca («Te saluda … de Kenku», «… de Aurela») y el número de pedido (`#KP…`, `#AUR…`). Muestren todo; si quieren, resalten los mensajes cercanos a la fecha del pedido.
- Los bots de otros países (Kenku España, México y Chile) son otros, con otras claves. No entran en este pedido.
- **Límites:** la documentación de Chatby no los dice. Sugerencia: una consulta al abrir el pedido, caché de 60 segundos por `user_ns` y un tiempo máximo de 5 segundos.
- **Si falla:** «No se pudo cargar la conversación de Chatby», con el botón «Abrir en Chatby» si ya tienen el `user_ns`, sin bloquear el resto de la ficha.
- **Errores de la API:** HTTP 400 con `{"message": "…"}`; 401 si la clave está mal o fue revocada.
- El bot tenía 6.385 conversaciones el 25-10: no sincronicen todas.
- No comprobamos si leer por la API marca el chat como leído en Chatby (no debería). Si el equipo ve chats marcados como leídos sin haberlos abierto, avísennos.

## Opcional, cómo probarlo y lista de entrega

Se prueba con el celular de alguien del equipo que ya recibió una plantilla de confirmación.

**Opcional:** para no buscar por celular, la tienda puede guardar en cada pedido de WooCommerce un campo `chatby_user_ns` (en `meta_data` de la API REST). Hoy Chatby ya deja el `user_ns` en el pedido cuando lo lee, pero no como campo propio. Si lo quieren, avísennos y lo agregamos.

**Cómo probarlo:**

1. El owner crea la clave «KAPTA» y se la pasa por un canal privado.
2. En su entorno de prueba, abran un pedido con ese celular. Paso 1 → debe salir un `user_ns`; paso 2 → los mensajes.
3. Revisen: plantillas con su texto, respuestas de la clienta, notas internas aparte, horas de Lima, del más viejo al más nuevo, y que «Abrir en Chatby» abre esa conversación.
4. Revisen que en sus registros no quedó la respuesta completa de la API ni la clave.

**Lista de entrega:**

- [ ] Clave «KAPTA» solo en el servidor
- [ ] Paso 1: celular `+51…` → `user_ns`, guardado junto al cliente
- [ ] Paso 2: 20 mensajes con `include_bot=1&include_note=1`, invertidos, en hora de Lima
- [ ] Globos por `type`; plantillas con `payload.body`; botones; errores en rojo; notas internas aparte
- [ ] Botón `https://app.chatby.io/inbox/<user_ns>`
- [ ] Sin `user_fields`, sin guardar conversaciones, sin la clave en registros
- [ ] Caché de 60 s, tiempo máximo de 5 s y mensaje si falla
