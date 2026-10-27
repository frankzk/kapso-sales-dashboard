# Mandar los formularios abandonados de COD Core a Kapta

27-10-2026 · pedido de Kapta al equipo de la tienda (Aurela y Kenku)

COD Core ya guarda en «Formularios abandonados» a quien escribió su celular y no terminó el pedido en 30 minutos, y lo pasa a «Recuperados» cuando ese celular compra. Pedimos que **cada formulario que entra a una de esas dos listas se mande por POST a Kapta**. Kapta lo pone en Leads como un carrito abandonado, igual que los borradores de Shopify: la asesora lo ve en la cola con el producto, el monto y la dirección, y «Generar pedido» lo convierte en un pedido de WooCommerce con esos productos.

La columna «Webhook» de la pantalla es el lugar natural para mostrar si Kapta lo recibió.

## A dónde

Una dirección por tienda. Está en Kapta → Ajustes → WooCommerce → «Formularios abandonados de COD Core»:

- Kenku: `https://<Kapta>/api/webhooks/woocommerce/dcab8bf5-23ec-49f5-8e20-f75a8f978297/abandonados`
- Aurela: `https://<Kapta>/api/webhooks/woocommerce/4c6522f9-c775-4be3-95b0-160a3c16d27a/abandonados`

Es la dirección de los webhooks de pedidos de WooCommerce de la tienda, terminada en `/abandonados`.

## La firma

Va con el **mismo secreto de los webhooks de pedidos de WooCommerce** que ya apuntan a Kapta. No hay un secreto nuevo.

- Cabecera `X-Kapta-Signature`: el HMAC-SHA256 del cuerpo crudo con ese secreto, en base64. Es el mismo algoritmo que WooCommerce usa en `X-WC-Webhook-Signature`.
- En PHP: `base64_encode( hash_hmac( 'sha256', $cuerpo, $secreto, true ) )`, sobre el mismo texto que se manda.
- **Lo más sencillo:** que COD Core tome la dirección y el secreto del webhook de WooCommerce que ya entrega a Kapta. Es el que tiene una dirección de entrega que termina en `/api/webhooks/woocommerce/<id>`. Su dirección más `/abandonados`, y su `get_secret()`. Así no hay nada que copiar a mano, y si se cambia el secreto en Kapta, se cambia en un solo lugar.
- Si no, dos campos en los ajustes de COD Core («Dirección de Kapta» y «Secreto»). El secreto se ve en WooCommerce → Ajustes → Avanzado → Webhooks, en cualquiera de los que van a Kapta.

## Qué mandar

`Content-Type: application/json`. Un formulario por POST:

```json
{
  "evento": "abandonado",
  "id": 812,
  "creado": "2026-10-26T15:02:11-05:00",
  "actualizado": "2026-10-26T15:32:11-05:00",
  "cliente": { "nombre": "Karina Flores", "celular": "964668948", "email": null },
  "lugar": {
    "distrito": "Los Olivos",
    "provincia": "Lima",
    "departamento": "Lima",
    "direccion": "MZ B LT 22",
    "referencia": "frente al parque"
  },
  "productos": [
    { "producto_id": 4512, "variacion_id": 4519, "sku": "KP-ZAP-38", "nombre": "Zapatilla Urban", "variante": "38 / Negro", "cantidad": 1, "precio": 79.0 }
  ],
  "total": 79.0,
  "moneda": "PEN",
  "pedido_id": null,
  "enlace": "https://kenku.pe/wp-admin/admin.php?page=…"
}
```

- `evento`: `"abandonado"` cuando entra a «Formularios abandonados». `"recuperado"` cuando pasa a «Recuperados», con `pedido_id`, el id del pedido de WooCommerce que lo recuperó.
- `id`: el id del formulario en COD Core (entero, único en el sitio). **Obligatorio.** Es la llave: mandar el mismo `id` otra vez actualiza el mismo carrito, no crea otro.
- `cliente.celular`: obligatorio. Vale con o sin `+51` y con espacios.
- `creado`: cuándo escribió el celular, no cuándo pasó a abandonado. ISO 8601 con zona, o unix en segundos. Sin zona se toma como hora de Lima.
- `lugar`: lo que escribió. Lo que no haya, `null`.
- `productos`: lo que dejó en el formulario. El `sku` es lo más importante: con él «Generar pedido» crea la línea en WooCommerce. `precio` es el unitario, después de la oferta que vio.
- `total`: lo que iba a pagar. Sin él, Kapta suma los productos.
- `enlace` (opcional): la pantalla del formulario en wp-admin. La ficha del lead lo abre con «Ver en COD Core».

## Las respuestas

| Código | Qué significa | Qué hace COD Core |
|---|---|---|
| 200 | Recibido (también un reenvío) | Marcar «Enviado» |
| 401 | La firma no cuadra, o la tienda no tiene guardado el secreto | Mostrar el error; reenviar no lo arregla hasta corregir el secreto |
| 404 | La dirección no es de una tienda de Kapta | Revisar la dirección |
| 422 | El formulario no se puede usar (sin `id`, sin celular, evento desconocido) | Mostrar el `error`; no reenviar |
| 503 | Kapta no pudo guardarlo ahora | Reintentar más tarde (p. ej. a los 5, 30 y 120 minutos) |

El cuerpo de la respuesta es JSON: `{ "ok": true, "evento": "abandonado", "id": "812" }`, o `{ "ok": false, "error": "…" }`.

## Lo que hace Kapta

- **Abandonado:** lo guarda como carrito de WooCommerce y crea el lead «Carrito» en la cola. Si el celular ya tiene un lead, no le pisa la gestión; si estaba ganado o perdido, lo reabre con las mismas reglas que un carrito de Shopify. Sale también en «Carritos anteriores» de la ficha.
- **Recuperado:** el carrito queda completado y el lead sale de la cola con el pedido que nombra `pedido_id`. Si ese pedido todavía no llegó a Kapta, sale cuando llegue un pedido del mismo celular con un producto del carrito.
- Un «abandonado» que llegue después del «recuperado» del mismo `id` no lo vuelve a abrir.
- El borrado de los 30 días de COD Core no se manda: en Kapta el carrito queda como historia.

## Los que ya están en la pantalla

Al activar el envío, **mandar una vez los que ya están** en «Formularios abandonados», y los de «Recuperados» como `recuperado`. Como el `id` es la llave, se pueden mandar todos sin miedo a duplicar. Los abandonados de más de 2 días entran como historia en «Carritos anteriores». Los de menos de 2 días también entran a la cola.

## Cómo probarlo

1. Llenar el formulario en la web con un celular de prueba y cerrar sin pedir.
2. A los 30 minutos, en «Formularios abandonados», la columna «Webhook» debe decir que Kapta lo recibió (200).
3. En Kapta → Leads, buscar el celular: «Formulario abandonado #F…» con el producto y el monto.
4. Hacer el pedido con ese celular. COD Core lo pasa a «Recuperados» y lo manda como `recuperado`: el lead sale de la cola con el pedido.

## Lista de entrega

- [ ] POST a `…/abandonados` al entrar a «Formularios abandonados» (`abandonado`) y a «Recuperados» (`recuperado`, con `pedido_id`)
- [ ] Firma `X-Kapta-Signature` con el secreto del webhook de WooCommerce que ya va a Kapta
- [ ] La respuesta en la columna «Webhook», y reintento solo con 503
- [ ] Mandar una vez los que ya están en las dos listas
