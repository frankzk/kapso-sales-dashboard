# Confirmar la ubicación de entrega en el formulario de COD Core

26-10-2026 · pedido de Kapta al equipo de la tienda (Aurela y Kenku)

Pedimos que, después de «Realizar pedido» y antes del primer upsell, la clienta confirme **dónde le entregamos** con un toque, y que esa ubicación quede guardada en el pedido de WooCommerce. Kapta ya la lee: no hay que coordinar nada más.

## Por qué

Shopify convertía la dirección en coordenadas y Kapta cotizaba Aliclik con ellas. WooCommerce no lo hace y el formulario no guarda ninguna. Hoy cada pedido de la web llega sin coordenada (p. ej. #AUR900024) y la asesora tiene que pedirla o buscarla a mano antes de crear la guía. Aliclik la exige, y el pin decide a dónde va el paquete.

## Dónde y cómo (lo más sencillo)

- **Cuándo:** justo después de crear el pedido y antes del primer upsell. El pedido ya existe, así que si la clienta cierra la página no se pierde nada.
- **Una sola pantalla, opcional:**
  - Título: «¿Dónde te entregamos?». Debajo, la dirección que escribió, para que confirme que es la misma.
  - Botón principal: **«Estoy en esa dirección: usar mi ubicación»** (geolocalización del navegador).
  - Botón secundario: **«Marcar en el mapa»**: un pin que se arrastra, con el mapa centrado en su distrito (ya lo tienen en `_cod_territorio`). Sirve si está en otro lugar o si el navegador no da la ubicación.
  - Enlace discreto: **«Ahora no»**, que sigue al upsell. Nunca bloquear la venta ni el upsell.
- **Por qué los dos botones:** la ubicación del teléfono es dónde está ella ahora, no siempre dónde recibe (puede pedir desde el trabajo). Por eso el botón dice «Estoy en esa dirección».
- **El navegador de Facebook o Instagram** a veces no da la ubicación, sobre todo en iPhone. El pin en el mapa cubre ese caso.
- **Mapa:** Leaflet con OpenStreetMap basta (gratis, sin clave). Google Maps también sirve si ya lo tienen.
- **Precisión:** si el GPS dice más de 200 m de margen, pedirle que ajuste el pin.

## Qué guardar (el contrato con Kapta)

En el pedido de WooCommerce, en `meta_data`, la clave **`_cod_ubicacion`**:

```json
{ "lat": -11.99123, "lng": -77.07051, "precision_m": 15, "fuente": "gps", "confirmado": 1793030500 }
```

- `lat`, `lng`: números en grados decimales (obligatorios).
- `precision_m`: el margen del GPS en metros (si es `gps`).
- `fuente`: `"gps"` (usó su ubicación) o `"mapa"` (movió el pin).
- `confirmado`: unix en segundos.

Guardar el pedido después de escribirla (`$order->save()`), para que salga el webhook `order.updated`: Kapta lo recibe y pone la coordenada en el pedido. Si la clienta dice «Ahora no», no se escribe nada.

## Lo que hace Kapta

- Lee `_cod_ubicacion` al recibir el pedido o su actualización y la usa como hacía con la de Shopify: ficha, Master y cotización de Aliclik. Solo si cae en el Perú.
- Mientras tanto, si la clienta mandó su ubicación por WhatsApp al bot de Chatby, el panel de Aliclik la propone con un clic.

## Cómo probarlo

1. Hacer un pedido de prueba en la web, tocar «usar mi ubicación» y seguir al upsell.
2. En WooCommerce, el pedido debe tener `_cod_ubicacion`.
3. En Kapta, la ficha del pedido debe decir «El pedido ya tiene coordenada» en el panel de Aliclik.
4. Repetir con «Marcar en el mapa» y con «Ahora no» (este último sin `_cod_ubicacion`).

## Lista de entrega

- [ ] Pantalla «¿Dónde te entregamos?» entre «Realizar pedido» y el primer upsell, con «Ahora no»
- [ ] «Estoy en esa dirección: usar mi ubicación» y «Marcar en el mapa» (centrado en el distrito)
- [ ] `_cod_ubicacion` con `lat`, `lng`, `precision_m`, `fuente`, `confirmado`, y `$order->save()`
- [ ] Probado dentro del navegador de Facebook/Instagram, en Android y en iPhone
