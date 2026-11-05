# Propuesta: coordenada por dirección (Google), solo cuando es exacta

02-11-2026 · propuesta de Kapta. **Decisiones A, B y C tomadas por el owner el 02-11-2026** (ver «Decisiones del owner»). Hoy solo está construido **el piloto de medición**; la coordenada todavía no se guarda ni se usa en ningún pedido.

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
   - Se comparan con la misma normalización de nombres de siempre: `departmentKey` (`lib/peru-departamentos.ts`) para el departamento, y `normalizeCoverageLabel` + `resolveLimaDistrict` (`lib/order-coverage.ts`) para el distrito, con Cusco/Cuzco iguales como en el pin respaldado. Los alias de Lima («Surco», «Cercado de Lima») solo valen en Lima.
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
- **En la guía automática por Chatby** (decisión A, aprobada el 02-11-2026): solo con `ROOFTOP` y siempre después de la de WhatsApp, y solo cuando el piloto cumpla el criterio B.

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

1. **Muestra:** los pedidos de WooCommerce de los últimos 7 días que ya tienen coordenada puesta por una persona (hasta 400, el cupo diario; ver «Cómo correr el piloto»).
2. **Medición:** se geocodifican sus direcciones (hasta 400 consultas, gratis) y se compara contra la coordenada real.
3. **Qué se mide:**
   - cuántos pasan el candado;
   - a qué distancia queda el punto de Google del de la asesora: la mediana y cuántos a más de 300 m y a más de 1 km;
   - Lima y Provincia por separado.
4. **Criterio para encender** (decisión B del owner, 02-11-2026): al menos el 90 % de los que pasan el candado a 300 m o menos del punto real.

Si el piloto sale mal, no se enciende y el resultado queda escrito.

## Lo que tiene que hacer el owner

1. Crear un proyecto en Google Cloud y activar **Geocoding API** con facturación. Google pide tarjeta aunque no se pase de lo gratis.
2. **Restringir la clave** solo a Geocoding API, poner la cuota **«v3 requests per day» en 400** y un **tope o alerta de gasto** (US$ 20).
3. Guardar la clave en Vercel como `GOOGLE_GEOCODING_API_KEY`. **No pegarla en el chat.**

## Decisiones del owner (02-11-2026)

- **A. Sí.** La guía automática por Chatby puede usar la coordenada por dirección, **solo con `ROOFTOP`** y **solo después** de la ubicación de WhatsApp (si la clienta mandó su pin, manda el pin).
- **B. Sí.** Se enciende solo si **al menos el 90 % de los puntos que pasan el candado quedan a 300 m o menos** del pin real.
- **C. Lima y Provincia COD.** El piloto mide las dos coberturas, por separado.

Mientras el piloto no diga que se cumple B, nada de esto cambia un pedido: el MOM no se toca hasta implementar la coordenada de verdad.

## Qué API de Google

La **Geocoding API clásica**, la que Google llama «v3»: `https://maps.googleapis.com/maps/api/geocode/json`. **No** los endpoints v4 (`GeocodeAddress`).

- El candado depende de dos campos de la respuesta v3: `geometry.location_type` y `partial_match`.
- El owner limita en Google Cloud la cuota **«v3 requests per day» a 400**. Por eso el piloto toma como mucho 400 pedidos (no 450): una pasada cabe entera en el cupo del día. Si Google contesta `OVER_QUERY_LIMIT` (por ejemplo, una segunda pasada el mismo día), el piloto deja de consultar y lo que faltó sale como «No se consultó (cupo diario de Google)».
- Si algún día se pasa a la v4, hay que revisar el candado: esos dos campos no vienen igual.

## Cómo correr el piloto

1. El owner guarda `GOOGLE_GEOCODING_API_KEY` en Vercel (Production; ver `DEPLOY.md`, 02-11-2026). Sin la clave, la sección dice «Falta GOOGLE_GEOCODING_API_KEY en Vercel» y no se llama a Google.
2. En **Ajustes de la tienda → Conexiones → «Coordenada por dirección (piloto)»**, con «Administrar tiendas» (owner/admin), aprieta **«Medir con los pedidos que ya tienen ubicación»**.
3. Kapta toma los pedidos de WooCommerce (`orders.raw ? 'woo'`) de los **últimos 7 días**, con cobertura Lima o Provincia COD y con `order_master.latitude`/`longitude` (el pin que puso la asesora al crear la guía): los más recientes primero, **hasta 400**, alternando Lima y Provincia. Desde el 05-11-2026 deja fuera los pins que son el punto de Google del propio pedido (los guardó una guía automática creada con la ubicación por dirección).
4. Geocodifica cada dirección (a Google va solo calle, distrito, provincia y departamento, con `region=pe` y `components=country:PE`; un celular escrito en la dirección se quita), aplica el candado y mide la distancia del punto aceptado al pin.
5. **No escribe nada** en la base y enseña **solo cuentas**: ni direcciones, ni nombres, ni celulares, ni números de pedido, tampoco en el registro.

Qué se ve, por cobertura (Lima, Provincia COD y el total):
- la muestra, cuántos pasan el candado (y cuántos con `ROOFTOP`);
- la mediana de la distancia al pin, el % a 300 m o menos y el % a más de 1 km;
- el % a 300 m o menos **solo con `ROOFTOP`**, que es lo que usaría la guía automática (decisión A);
- si se cumple el criterio B;
- por qué no pasaron los demás (sin calle, sin resultado, no exacta, coincidencia parcial, otro departamento, otro distrito, fuera del Perú, error de la API, sin tiempo, sin cupo).

Con menos de 30 puntos que pasan en una cobertura, la pantalla avisa que el porcentaje todavía no dice mucho; el criterio B no cambia.

**Tiempo.** Corre dentro del botón: 5 consultas a la vez, como mucho 6 s cada una, y a los 38 s no empieza ninguna más, así que la pasada termina antes de unos 50 s. Lo que quedó sin consultar sale como «No se llegó a consultar (tiempo)». Con 400 consultas a la velocidad normal de Google (unas décimas de segundo) alcanza de sobra.

**Dónde está.** Lo puro (la petición, el candado, la distancia y la cuenta) en `lib/geocode-google.ts`; la pasada en `lib/geocode-google-server.ts`; el botón en `app/dashboard/[storeId]/settings/geocode-actions.ts` y `components/store-settings.tsx`; las pruebas en `test/geocode-google.test.ts`.

El resultado del piloto se escribe aquí cuando se corra, salga bien o mal.

## Riesgos

- **Una dirección bien escrita pero de otra casa** (la clienta escribió mal el número). Pasa el candado y el paquete va a la puerta equivocada del mismo barrio. Con Shopify pasaba lo mismo; el piloto mide cuánto.
- **Cobertura baja en Provincia.** En pueblos y asentamientos Google casi nunca da `ROOFTOP`, así que muchos pedidos seguirán sin coordenada. Por eso la pantalla de COD Core sigue siendo lo más exacto, y conviene empujarla igual.
- **Cambios de precio de Google.** El tope de gasto lo contiene.

Cuando se implemente (después de un piloto que cumpla B), el MOM (§38, «De dónde sale ahora») y las pruebas se actualizan con la implementación.

## Resultado de Kenku y prueba con los confirmados por Chatby (02-11-2026)

Primera pasada, en Kenku: 400 pedidos (84 de Lima y 316 de Provincia COD).
- Pasan el candado **74 (18,5 %)**.
- De esos, el **83,8 %** queda a 300 m o menos del pin (mediana: 21 m) y el **12,2 %** a más de 1 km.
- **No cumple el criterio B.** Solo con ROOFTOP, Provincia COD llega al 92,7 %, pero son 41 puntos.

En la misma sección hay ahora un segundo botón, **«Probar con estos pedidos»**:
- Toma los pedidos que esperan la ubicación de la clienta: los confirmados por Chatby sin guía y los que siguen en Por confirmar con `sin_ubicacion`.
- Dice, pedido por pedido, si pasarían el candado y por qué no.
- Para los que pasan, da el punto en el mapa para que una persona lo mire.
- No hay pin con qué comparar: es solo para ver cuántos tendrían coordenada.
- No escribe nada.

## Encendido para la guía automática de Provincia COD (02-11-2026)

El owner pidió encenderla para Provincia COD. Queda dentro de las decisiones A y B:
- **Precisión:** solo el edificio (`ROOFTOP`). Provincia COD dio 92,7 % a 300 m o menos en el piloto de Kenku.
- **Orden:** siempre después de la ubicación de WhatsApp.
- **Caché:** una consulta por pedido y dirección (`order_geocodes`, 0301).
- **Interruptor:** `chatby_auto_settings.geocode_enabled`.

No se usa en el panel de la asesora. En Lima solo la usa el reintento Aliclik automático, con su propia medición (ver abajo). Ver MOM §6.1 y §38.

## Reintentos Aliclik automáticos de Lima: medición de Lima y switch (05-11-2026)

**El problema.** La simulación de «Reintentos Aliclik» del 05-11-2026 dio 1 de 19 «Habría creado» y 18 «Este pedido no tiene coordenada». Desde WooCommerce, en Lima solo un 10–20 % de los pedidos trae coordenada (en Shopify era el 99 %), y Aliclik la exige. Lima nunca se midió sola: en el piloto de Kenku fueron 84 de 400.

**Qué se hizo** (MOM §9.5, entrega 3, y §40; migración 0308):
- **«Sin ubicación: falta la coordenada».** Un reintento sin coordenada usable ya no es «No se pudo crear»: se reintenta, no cuenta para el tope, no avisa por Telegram, no deja hecho de fallo y sigue en la bandeja hasta que una persona pone la ubicación de la clienta en la ficha del pedido («Corregir ubicación»; «Aprobar» de Repro Lima no tiene dónde pegarla) y lo aprueba.
- **Medir Lima por separado** (decisión C). En **Automatizaciones → Reintentos Aliclik en Lima → Ubicación por dirección**, el botón **«Medir la ubicación por dirección en Lima»**:
  - toma solo Lima, entre todas las tiendas activas de la organización, con la regla del piloto (WooCommerce, últimos 7 días, con el pin de una persona, los más recientes primero);
  - **deja fuera los pins que puso Google**: la guía creada con la ubicación por dirección guarda el punto y el Master lo toma como pin del pedido. Un pedido cuyo pin está a 5 m o menos de su punto bueno en `order_geocodes` (y no es una corrección a mano) no entra: compararlo con Google daría 0 m y la medición se confirmaría sola;
  - consulta **como mucho 150** direcciones **por día de Lima**, sumando las mediciones guardadas de hoy: el cupo de 400 por día lo comparte con la guía automática de Chatby;
  - guarda **solo la cuenta** en `geocode_pilot_runs` (`coverage = 'lima'`): muestra, los que pasan el candado, los ROOFTOP, la mediana, el % a 300 m o menos (en total y solo con ROOFTOP), el % a más de 1 km, si eso cumple B y por qué no pasaron los demás. Ni direcciones, ni nombres, ni celulares, ni números de pedido.
- **El interruptor «Usar la ubicación por dirección (Google) si el pedido no tiene»** (`lima_retry_auto_settings.geocode_enabled`, nace apagado). **Solo se enciende** con la clave en Vercel y si la última medición de Lima cumple B con el edificio: al menos el **90 % de los puntos ROOFTOP a 300 m o menos** del pin real, con **al menos 30 puntos ROOFTOP** (decisiones A y B; con menos, el porcentaje no dice nada). Apagar se puede siempre. Si una medición nueva deja de cumplir B, la pasada deja de usar Google aunque el interruptor siga encendido.
- **Cómo la usa la pasada.** Solo para pedidos de Lima **sin** coordenada, en Simulación, Activo y «Simular ahora». Una consulta por pedido y dirección (caché `order_geocodes`). Solo vale el edificio. La misma coordenada va a la cotización y a la creación, como en Chatby, y el log dice «ubicación por dirección (Google, edificio)». Si Google responde que se acabó el cupo, no se le pregunta más en esa pasada. Si el pedido no respalda el punto de Google (el pin respaldado de Aliclik), queda «Sin ubicación» para una persona: no se escribe la excepción ni se saca el pedido de la cadena. Si un reintento anterior ya creó una guía con el punto de Google, el Master lo muestra como pin del pedido, pero el reintento siguiente lo sigue tratando como Google (con el interruptor y la medición, la nota del log y «Sin ubicación» si el pedido no lo respalda). El `?dry=1` del cron no busca en Google; «Simular ahora» del panel sí.

**Dónde está.** Lo puro (la cuenta de Lima, el criterio con el edificio) en `lib/geocode-google.ts` (`geocodeLimaRunSummary`, `geocodeLimaGate`); la medición en `lib/geocode-google-server.ts` (`runGeocodeLimaMeasure`); la pasada en `lib/lima-retry-auto-server.ts`; el núcleo en `lib/lima-retry-approve.ts`; el panel en `components/automations-panel.tsx` y `app/dashboard/automatizaciones/actions.ts`. Pruebas: `test/geocode-google.test.ts`, `test/lima-retry-auto.test.ts`, `test/lima-retry-approve.test.ts` y `test/lima-retry-geocode-actions.test.ts`.

El resultado de la primera medición de Lima se escribe aquí cuando se corra, salga bien o mal.
