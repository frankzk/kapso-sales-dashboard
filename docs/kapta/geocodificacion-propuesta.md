# Propuesta: coordenada por dirección (Google), solo cuando es exacta

02-11-2026 · propuesta de Kapta para decisión del owner. **No está implementada.**

## El problema

Antes, con Shopify, casi todos los pedidos tenían coordenada porque Shopify convertía la dirección escrita en coordenadas. Kapta las usaba en la ficha, en el Master y para cotizar Aliclik. WooCommerce no lo hace.

| Período | Pedidos con coordenada |
|---|---|
| 21–24 oct (Shopify) | 99 % |
| 27–31 oct (WooCommerce) | 33–38 % |
| 1 nov | 23 % |

En los últimos 5 días, 445 pedidos de WooCommerce tienen coordenada, y los 445 tienen guía Aliclik. Lo más probable es que la puso la asesora al crear la guía. Ningún pedido trae la ubicación del formulario de COD Core (`_cod_ubicacion`, ver `cod-core-ubicacion.md`): esa pantalla todavía no existe.

Sin coordenada:
- no hay guía automática;
- la asesora tiene que pedir la ubicación o buscarla a mano.

Las 14 primeras confirmaciones por Chatby se quedaron sin guía por eso.

## Qué se propone

Convertir la dirección del pedido en coordenadas con la API de geocodificación de Google, como hacía Shopify. La diferencia está en el candado: **solo se acepta el punto si Google lo da por exacto y cae en el distrito del pedido**. Si no, el pedido sigue como hoy.

### El candado (las cuatro condiciones a la vez)

1. **Precisión exacta.** `location_type` debe ser `ROOFTOP` (el edificio) o `RANGE_INTERPOLATED` (el número en la cuadra).
   - No sirven `GEOMETRIC_CENTER` (el centro de una calle o zona) ni `APPROXIMATE` (el distrito o la ciudad). Es lo que Google devuelve para «Mz B Lt 22», un caserío o una dirección que no encuentra.
2. **Coincidencia completa.** Si Google marca `partial_match`, no vale: entendió otra cosa de lo escrito.
3. **El destino del pedido.** El distrito y el departamento que devuelve Google tienen que ser los del Master.
   - Se comparan con la misma normalización de nombres de siempre (`lib/ubigeo.ts`).
   - Si no coinciden, el punto se descarta aunque sea «exacto».
4. **Dentro del Perú.** Es la misma regla que ya se usa para la ubicación de WhatsApp.

Después del candado sigue la puerta de siempre: la del **pin respaldado** de Aliclik (`lib/pin-corroborado.ts`, §10). Si el pedido contradice el pin, no hay guía.

### Qué se manda a Google

Solo la dirección:
- calle y número;
- distrito, provincia y departamento.

Nunca el nombre, el celular ni el pedido.

### Dónde entra y en qué orden

La coordenada se toma de la primera fuente que exista:

1. La que confirma la clienta en COD Core (`_cod_ubicacion`), cuando la tienda la tenga.
2. La que mandó por WhatsApp (Chatby).
3. **La de la dirección, si pasó el candado.** Es la nueva.
4. Si no hay ninguna, la asesora como hoy.

Cómo se usa la nueva:
- **Se guarda aparte, no como la coordenada del pedido.** Lleva su origen («por dirección, Google») y su precisión. Así nunca se confunde con una ubicación que dio la clienta.
- **En el panel de Aliclik se propone como la de WhatsApp.** El panel muestra «Ubicación por dirección (Google), exacta al número: Usar esta ubicación · Ver en el mapa». La asesora la ve y la usa con un clic.
- **En la guía automática por Chatby, solo si el owner lo aprueba** (decisión A). Mi recomendación es usarla solo con `ROOFTOP` y siempre después de la de WhatsApp.

### Cuándo se consulta

No se geocodifica todo pedido que entra. Se consulta solo cuando hace falta la coordenada:
- al abrir el panel de Aliclik de un pedido sin coordenada;
- en la guía automática.

El resultado se guarda, así que cada pedido cuesta, como mucho, una consulta. Si se edita la dirección, se vuelve a consultar.

## Costo

Precios de Google para la geocodificación. Son los que dan los comparadores de 2026; hay que confirmarlos en la página de Google antes de encenderla.

| Uso al mes | Precio |
|---|---|
| Hasta 10.000 consultas | Gratis |
| De 10.000 a 100.000 | US$ 5 por cada 1.000 |
| Más de 100.000 | US$ 4 por cada 1.000 |

Con el volumen de hoy (unos 240–300 pedidos por día):
- Se consultarían solo los que no traen coordenada: entre 4.000 y 7.000 al mes. **US$ 0.**
- Con reintentos por direcciones editadas: unos 12.000. **Unos US$ 10.**
- Se pone un tope de gasto en Google Cloud (por ejemplo US$ 20 al mes). Si se alcanza, la API deja de responder y Kapta sigue como hoy.

## Piloto antes de encenderla

Antes de mostrarla a las asesoras o usarla en guías se mide, sin tocar ningún pedido.

1. **Muestra:** los 445 pedidos de WooCommerce de los últimos días que ya tienen coordenada puesta por una persona.
2. **Medición:** se geocodifican sus direcciones (unas 445 consultas, gratis) y se compara contra la coordenada real.
3. **Qué se mide:**
   - cuántos pasan el candado;
   - a qué distancia queda el punto de Google del de la asesora: la mediana y cuántos a más de 300 m y a más de 1 km;
   - Lima y Provincia por separado.
4. **Criterio para encender** (propuesta, lo fija el owner): al menos el 90 % de los que pasan el candado a menos de 300 m del punto real.

Si el piloto sale mal, no se enciende y el resultado queda escrito.

## Lo que tiene que hacer el owner

1. Crear un proyecto en Google Cloud y activar **Geocoding API** con facturación. Google pide tarjeta aunque no se pase de lo gratis.
2. **Restringir la clave** solo a Geocoding API y poner un **tope o alerta de gasto** (US$ 20).
3. Guardar la clave en Vercel como `GOOGLE_GEOCODING_API_KEY`. **No pegarla en el chat.**

## Decisiones pendientes

- **A.** ¿La guía automática por Chatby puede usar la coordenada por dirección? Recomendación: sí, solo con `ROOFTOP` y después de la de WhatsApp.
- **B.** ¿El criterio del piloto: el 90 % a menos de 300 m?
- **C.** ¿Lima también, o solo Provincia COD? En Lima la mayoría va por GF y no pide coordenada a Aliclik, aunque la ficha y el mapa la usan.

## Riesgos

- **Una dirección bien escrita pero de otra casa** (la clienta escribió mal el número). Pasa el candado y el paquete va a la puerta equivocada del mismo barrio. Con Shopify pasaba lo mismo; el piloto mide cuánto.
- **Cobertura baja en Provincia.** En pueblos y asentamientos Google casi nunca da `ROOFTOP`, así que muchos pedidos seguirán sin coordenada. Por eso la pantalla de COD Core sigue siendo lo más exacto, y conviene empujarla igual.
- **Cambios de precio de Google.** El tope de gasto lo contiene.

Si se aprueba, el MOM (§38, «De dónde sale ahora») y las pruebas se actualizan con la implementación.
