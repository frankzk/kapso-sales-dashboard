# No ofrecer «Pago contra entrega» a la lista de pago adelantado

> **Retirado (owner, 09-11-2026, MOM §41.7). No hace falta construir esto.** Las altas que el equipo agrega a mano en la
> «Lista negra» de Kapta van ahora dentro del envío diario de la lista automática (`docs/kapta/pago-solo-online.md`,
> COD Core 0.10.45): un solo canal. Kapta sigue contestando `/prepago` por compatibilidad, pero no es el camino.

05-11-2026 · pedido de Kapta al equipo de COD Core (Aurela y Kenku) · MOM §41

Kapta tiene una **«Lista de pago adelantado»** (la lista negra): celulares que ya rechazaron un pedido en la puerta o no lo recogieron en la agencia, más los que el equipo agrega a mano. Decisión del owner: **esos clientes pagan el total por adelantado; no se les ofrece contra entrega.**

El formulario de COD Core en la ficha del producto es la entrada más grande de pedidos contra entrega (≈ 55 % de los pedidos, y el 62 % de los pedidos repetidos de clientes con un fallo previo) y crea el pedido fuera del checkout de WooCommerce, así que el filtro de pasarelas del checkout no lo alcanza. Pedimos que **antes de ofrecer «Pago contra entrega», el formulario le pregunte a Kapta por el celular que escribió la clienta.**

## Antes que nada: solo desde el servidor

**Solo desde el servidor.** La firma y la llamada a Kapta se hacen en PHP, en el servidor de WordPress (`wp_remote_post`). El secreto **nunca** llega al navegador: no va en el JavaScript del formulario, ni en un `data-` del HTML, ni en una respuesta de AJAX. Es el mismo secreto de los webhooks de pedidos de WooCommerce y de los formularios abandonados: con él, cualquiera que lea el código de la página podría fabricar pedidos y formularios abandonados en Kapta, y consultar la lista por cualquier celular.

Para preguntar «al salir del campo», el formulario llama a un endpoint **propio de COD Core** (`admin-ajax.php` o una ruta REST de WordPress, con su nonce). Ese endpoint, en PHP, firma y llama a Kapta y le devuelve al navegador solo `true` o `false`. Y pregunta como mucho **3 celulares distintos por visitante cada 10 minutos** (por sesión o por IP); pasado eso contesta `false` sin preguntar: esconder «Pago contra entrega» le dice a quien mira que ese número rechazó un pedido, y no puede servir para recorrer números. Kapta lo frena igual en «Por confirmar» y en la guía.

## Qué hacer

1. Cuando la clienta termina de escribir el celular (al salir del campo, o justo antes de enviar el formulario), el formulario le pregunta al endpoint de COD Core de arriba, que llama a Kapta desde el servidor.
2. Si Kapta responde `{"prepay_required": true}`:
   - no mostrar ni aceptar «Pago contra entrega»;
   - mostrar: *«Para este número el pago contra entrega no está disponible: paga el total en línea (tarjeta o Yape) para completar tu pedido.»*;
   - mandar a la clienta al checkout de la tienda con el carrito armado, donde paga con Flow («Tarjeta o Yape»).
3. Si responde `{"prepay_required": false}`, seguir como siempre.
4. **Falla abierto.** Si Kapta no responde en 3 segundos, responde otro código o algo que no se entiende, seguir como siempre (contra entrega). Kapta frena ese pedido igual en «Por confirmar» y no le crea guía hasta que pague el total: una caída de Kapta no puede dejar a la tienda sin vender.
5. Volver a preguntar en el servidor al crear el pedido (no confiar en lo que contestó el endpoint al navegador): un formulario se puede mandar a mano.
6. Se puede guardar la respuesta 10 minutos por celular, con un hash **salado** del número, nunca el número ni su hash a secas (un móvil de 9 dígitos se adivina en segundos a partir de un SHA-256 sin sal). Como el mu-plugin: `substr( hash( 'sha256', $celular . '|' . $secreto ), 0, 32 )` (o con `wp_salt()`).
7. Preguntar una sola vez por celular en cada pedido de página, y si Kapta no contesta, dejar de preguntar un minuto (un transient «Kapta caído»): que Kapta esté lento no puede hacer esperar 3 s a cada visita.

## A dónde

Una dirección por tienda. Es la de los webhooks de WooCommerce de la tienda terminada en `/prepago`:

- Kenku: `https://<Kapta>/api/webhooks/woocommerce/dcab8bf5-23ec-49f5-8e20-f75a8f978297/prepago`
- Aurela: `https://<Kapta>/api/webhooks/woocommerce/4c6522f9-c775-4be3-95b0-160a3c16d27a/prepago`

## La firma

La **misma de los formularios abandonados** (`docs/kapta/cod-core-abandonados.md`), con el **mismo secreto de los webhooks de pedidos de WooCommerce** que ya apuntan a Kapta. No hay un secreto nuevo.

- `POST`, `Content-Type: application/json`.
- Cuerpo: `{"phone": "<celular tal como lo escribió>", "timestamp": <segundos unix de ahora>}`.
- Cabecera `X-Kapta-Signature`: el HMAC-SHA256 del **cuerpo crudo** con el secreto, en base64.
- Cabecera `X-Kapta-Timestamp`: el **mismo** `timestamp` del cuerpo. Kapta rechaza (401) si no coinciden o si está a más de 5 minutos de su reloj: así una llamada capturada no sirve después. Como el `timestamp` va dentro del cuerpo firmado, no se puede cambiar sin romper la firma.

En PHP (en el servidor; nunca en el navegador):

```php
$secreto   = '<secreto de los webhooks de WooCommerce que van a Kapta>';
$timestamp = time();
$cuerpo    = wp_json_encode( array( 'phone' => $celular, 'timestamp' => $timestamp ) );
$firma     = base64_encode( hash_hmac( 'sha256', $cuerpo, $secreto, true ) );

$respuesta = wp_remote_post( $url_kapta_prepago, array(
	'timeout'     => 3,
	'redirection' => 0,
	'headers'     => array(
		'Content-Type'      => 'application/json',
		'X-Kapta-Signature' => $firma,
		'X-Kapta-Timestamp' => (string) $timestamp,
	),
	'body'        => $cuerpo,
) );

$prepago = false; // falla abierto
if ( ! is_wp_error( $respuesta ) && wp_remote_retrieve_response_code( $respuesta ) === 200 ) {
	$datos   = json_decode( wp_remote_retrieve_body( $respuesta ), true );
	$prepago = is_array( $datos ) && ( $datos['prepay_required'] ?? null ) === true;
}
```

Con curl, para probar:

```bash
TS=$(date +%s)
BODY="{\"phone\":\"987654321\",\"timestamp\":$TS}"
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRETO" -binary | base64)
curl -s -X POST "$URL" -H 'Content-Type: application/json' \
  -H "X-Kapta-Signature: $SIG" -H "X-Kapta-Timestamp: $TS" -d "$BODY"
# {"prepay_required":false}
```

El celular vale con o sin `+51`, con espacios o guiones. Un número que no es un móvil peruano responde `false`.

## Las respuestas

| Código | Cuerpo | Qué hace COD Core |
|---|---|---|
| 200 | `{"prepay_required": true}` | Esconder contra entrega y mandar a pagar en línea |
| 200 | `{"prepay_required": false}` | Seguir como siempre |
| 400 | `{"error": "…"}` | Cuerpo sin `phone` o que no es JSON: seguir como siempre y revisar el código |
| 401 | `{"error": "…"}` | La firma o el sello no cuadran (o la tienda no tiene el secreto): seguir como siempre y revisar el secreto y el reloj del servidor |
| 404 | `{"error": "tienda desconocida"}` | Revisar la dirección |
| 409 | `{"error": "…"}` | La tienda no está activa en WooCommerce en Kapta: seguir como siempre |
| 503 | `{"error": "…"}` | Kapta no pudo leer la lista ahora: seguir como siempre |

Kapta **nunca** devuelve el motivo, los pedidos ni ningún otro dato de la clienta: solo sí o no.

## Lo que hace Kapta

- La lista es por organización: Kenku y Aurela comparten la suya.
- Aunque el formulario ofrezca contra entrega (por ejemplo, si Kapta no respondió), Kapta no confirma ese pedido contra entrega ni le crea guía con cobro: la asesora lo ve en la ficha («Lista de pago adelantado: este cliente paga el total por adelantado») y le envía el link de pago del total.
- El checkout de WooCommerce de la tienda usa el mu-plugin `docs/kapta/wordpress/kapta-prepago.php`, que hace lo mismo con los métodos de pago del checkout.
