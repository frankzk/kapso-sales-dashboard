# Estados de despacho de Shalom (API de rastreo)

Base de conocimiento de los estados que devuelve `api.shalom-api-peru.com` al
rastrear un envío, cómo se traducen a los estados del Master de Pedidos, y qué
hay que saber antes de construir algo sobre ellos.

Para el resto de la integración (crear guías, anular, rótulos, credenciales) ver
`DEPLOY.md` §5o.

---

## Los siete hitos

El objeto `status` trae **siempre las siete claves**. No hay un catálogo que
consultar ni estados que aparezcan con el tiempo: la lista es cerrada.

Los hitos que todavía no ocurrieron llegan en **`null`**, y eso es lo normal en
un envío en curso — **no es un error**.

| Hito | Qué significa |
|---|---|
| `registrado` | La orden se registró en el sistema de Shalom. |
| `origen` | Recibido físicamente en la agencia de origen. |
| `transito` | En viaje entre agencias. |
| `demora` | Incidencia que retrasó el envío. Normalmente `null`. |
| `destino` | Llegó a la agencia de destino. |
| `entregado` | Entregado al destinatario. |
| `reparto` | Salió a reparto a domicilio. `null` si la entrega es en agencia. |

Cada hito trae **un solo campo `fecha`**, con formato `YYYY-MM-DD HH:MM:SS` —
la hora va dentro, no hay campo `hora` aparte.

`transito` es el único con datos extra: `cargueros[]` (todos los transportistas
que movieron el paquete) y `carguero` (el último). Esos ids son el `cap_id` que
pide la Guía de Remisión del Transportista.

---

## Cómo se traducen a nuestros estados

En `lib/shalom/tracking.ts`, puro y testeado (`test/shalom-tracking.test.ts`).

| Hito de Shalom | `delivery_status` | `pickup_state` |
|---|---|---|
| solo `registrado`, o ninguno | `pendiente` | `pendiente_de_envio` |
| `origen` | `pendiente` | `registrado_en_agencia` |
| `transito` | `en_ruta` | `en_transito` |
| `destino` | `pendiente` | `disponible_para_recojo` |
| `reparto` | `en_ruta` | `en_reparto` |
| `entregado` | `entregado` | `recogido` |
| `demora` | *no cambia el estado* | marca `delayed` aparte |

### Dos decisiones que no son obvias

**Gana el hito más avanzado, no el último con fecha.** Un envío entregado sigue
trayendo `registrado` con su fecha: leer los hitos como banderas independientes
mostraría siempre el estado más atrasado. Se leen como una escalera.

**`destino` no es «entregado».** Llegar a la agencia de destino deja la guía
**viva** (`pendiente`), esperando a que el cliente vaya a recogerla. Es lo
correcto para la operación con clave de recojo, y coincide con el criterio que ya
usaba el adaptador de reportes de agencia.

**`reparto` gana a `destino`**, porque solo puede ocurrir después.

---

## Los dos modos de la API

| | Qué pide | Qué devuelve |
|---|---|---|
| **Estado** | solo `X-API-Key` | `status` (los 7 hitos). `detailed: false` |
| **Detallado** | además credenciales de Shalom Pro | añade `order`. `detailed: true` |

**El modo estado no necesita credenciales de Shalom Pro.** Eso es lo que hace
viable el cron: sin login de ~90 s, sin sesión que renovar, y **una sola llamada
cubre guías de cualquier tienda a la vez**.

Si las credenciales fallan, la respuesta **degrada al modo estado** en vez de
romper. El campo `detailed` dice qué esperar.

> ⚠️ **El modo detallado sirve de poco.** Desde julio de 2026 Shalom dejó de
> enviar `origen`, `destino`, `remitente`, `destinatario` y `comprobante` dentro
> de `order`: llegan **vacíos** (en cero, para no romper el shape de quien ya los
> leía). **No construir nada sobre esos campos.** De `order` sí llegan los
> identificadores, las fechas, `contenido`, `monto`, `tipo_pago`, `estado_pago` y
> los flags (`entregado`, `reparto`, `aereo`).
>
> Por eso nuestro cron **no pide el modo detallado**: el estado sale entero de
> `status`.

---

## Endpoints

| Endpoint | Para qué |
|---|---|
| `GET /v1/tracking?numero=…&codigo=…` | Una guía. **`numero` y `codigo` van juntos**, o `ose_id` solo |
| `POST /v1/tracking/batch` | **Hasta 50 guías por llamada.** Lo que usa el cron |
| `GET /v1/tracking/{ose_id}/events` | Solo el `status`, si ya tienes el `ose_id` |
| `GET /v1/tracking/{ose_id}/grt?cap_id=…` | Enlace a la Guía de Remisión |
| `GET /v1/tracking/{ose_id}/voucher` | **Fuera de servicio**: responde 404 siempre |

### Sobre los identificadores

> **`numero` y `codigo` VAN JUNTOS. Ninguno de los dos sirve solo.**
>
> Comprobado contra la API el 03/08/2026, con la guía `90484321` / `WWCP`:
>
> | Se manda | Contesta |
> |---|---|
> | solo `numero` | `422 Ingrese un código de orden` |
> | solo `codigo` | `422 Ingrese un número de orden` |
> | solo `ose_id` | **funciona** |
>
> Los dos errores se reclaman el uno al otro, pero **por separado cada uno
> parece decir «esa guía no existe»** — y esa lectura equivocada tuvo las 93
> guías sin rastrear desde el primer día, con el cron corriendo cada media hora
> y rechazando el 100 %.

- **`numero`** — la guía, 8 a 10 dígitos (ej. `89980799`). Es lo que guardamos
  como `guide_code`. **Nunca va solo.**
- **`codigo`** — alfanumérico de 4 (ej. `77PH`). Guardado en `shalom_codigo`.
  **Por sí solo no resuelve el estado**: hay que usarlo junto al `numero`, o con
  credenciales de Shalom Pro. Deja de ser un adorno del rótulo: **sin él no hay
  rastreo**, así que una guía vinculada a mano sin código no se puede seguir.
- **`ose_id`** — id interno. No se puede averiguar; lo devuelve `POST /v1/orders`
  y lo guardamos en `shalom_ose_id`. Es el handle para eventos, comprobante y GRT.

### El batch, en detalle

- **`custom_id`** es una etiqueta libre que devuelven **verbatim**. Le mandamos
  el id del envío, así que el resultado se correlaciona sin adivinar.
- **Los errores son por item, no por batch**: una guía inexistente vuelve con
  `ok: false` y su error, y el HTTP sigue siendo **200**. Solo da 400 si el
  envelope está malformado (JSON inválido, `items` vacío, o más de 50).
- El orden de `results` **se conserva**.

Por eso el llamador **itera resultados** en vez de confiar en que la ausencia de
excepción signifique que todo salió bien.

---

## Cupo

**60 requests/minuto por API key**, confirmado por la cabecera
`X-RateLimit-Limit`.

Lo que engaña es el `remaining`: la primera llamada de una sonda recién arrancada
ya mostraba **14 disponibles**, no 59. No es que el techo sea más bajo — es que
**la API key es una sola para todas las tiendas** (es de la cuenta de Kapso), así
que el contador refleja lo que gasta *todo el mundo* a la vez.

Consecuencias prácticas: el cupo que ves no es tuyo, puede estar casi agotado sin
que hayas hecho nada, y conviene vigilar la cabecera a medida que entren más
tiendas. Agotarlo devuelve un error **parecido al de una key vencida**, que es un
síntoma muy confundible.

---

## Cómo consultarlo a mano

Con la API key en la variable de entorno. **No hacen falta** las credenciales de
Shalom Pro.

Una guía:

```powershell
curl.exe -s -H "X-API-Key: $env:SHALOM_API_KEY" `
  "https://api.shalom-api-peru.com/v1/tracking?numero=89980799&codigo=77PH"
```

Varias de golpe (hasta 50):

```powershell
# Cada item necesita numero + codigo, o bien ose_id a secas.
$body = @{ items = @(
  @{ custom_id = "a"; numero = "89980799"; codigo = "77PH" }
) } | ConvertTo-Json -Depth 4
curl.exe -s -X POST -H "X-API-Key: $env:SHALOM_API_KEY" `
  -H "content-type: application/json" -d $body `
  "https://api.shalom-api-peru.com/v1/tracking/batch"
```

---

## Vía aérea

**Se elige al crear la guía**, no eligiendo otra agencia. En el panel de Shalom
la misma sucursal aparece dos veces en el desplegable —«AV JOSE A. QUIÑONES» y
«… - AEREO»— pero la API devuelve **una sola agencia** con un campo `aereo: true`.
Lo que decide la vía es un flag del pedido: `aereo` en el cuerpo de
`POST /v1/orders`.

Cada agencia trae además dos listas que la búsqueda ya devolvía y que conviene
mirar antes de ofrecer la opción:

| Campo | Qué es |
|---|---|
| `aereo` | La agencia tiene servicio aéreo. **No** dice desde dónde. |
| `origenes_aereos[]` | Ids de agencias de origen **con vuelo hasta ella**. |
| `destinos_aereos[]` | Lo simétrico, hacia dónde vuela. |
| `reparto_habilitado` | `false` → solo recojo en agencia, sin entrega a domicilio. |

`aereo: true` **no** garantiza que haya vuelo desde nuestra agencia de origen:
eso lo dice `origenes_aereos`. En el modal la casilla solo aparece si la agencia
vuela, y se bloquea si nuestro origen no está en esa lista — marcarla ahí sería
pedir una vía que no existe. Si Shalom no devuelve las listas, se deja elegir y
no se afirma nada: impedirlo por falta de dato bloquearía un envío legítimo.

> ⚠️ **La cotización puede no reflejar el recargo.** `POST /v1/tariff/calculate`
> no acepta el flag `aereo` en su cuerpo documentado, así que el precio que se ve
> antes de crear puede no incluirlo. El modal lo avisa cuando la casilla está
> marcada.

**Ejemplo real.** Iquitos no tiene acceso por carretera y sus seis agencias son
`aereo: true`. La de *AV JOSE A. QUIÑONES* (San Juan Bautista) es la **594**, y
en sus `origenes_aereos` figura la **587** (AV Bolívar, Pueblo Libre), así que
esa ruta es viable. Tiene `reparto_habilitado: false` —solo recojo— y horario de
lunes a viernes. La **460** (Jr. Bolognesi) es la principal de Iquitos y sí tiene
reparto a domicilio.

## El cron que lo aplica

`/api/cron/shalom-reconcile`, cada 30 min (`vercel.json`).

- Solo consulta guías **vivas** y **creadas por API** (con `shalom_ose_id`). Las
  terminales dejan de preguntarse: no gastan cupo a cambio de nada.
- **Solo escribe cuando el estado cambia de verdad.** Sin esa comparación, cada
  pasada tocaría cada fila, ensuciaría el `updated_at` que el Master usa para
  ordenar por movimiento, y llenaría la línea de tiempo de eventos idénticos.
- Techo de 20 batches (1.000 guías) por pasada, porque el cupo es compartido.

Forzarlo a mano:

```powershell
curl.exe -s -H "Authorization: Bearer $env:CRON_SECRET" `
  "https://kapso-sales-dashboard.vercel.app/api/cron/shalom-reconcile"
```

Devuelve `{ scanned, applied, failed }`.

> **Si `scanned` es 0 pero hay guías vivas**, o si `last_report_at` sigue en
> `null` en todas las filas de `shipments` con `courier='shalom'`, el cron no está
> corriendo. En el plan Hobby de Vercel los crons corren **una vez al día**: la
> cadencia de 30 min necesita Pro.

---

## Por qué no hay webhook

Shalom **no ofrece webhook**. Y la vía de entrada que existe en el panel —subir
su reporte Excel— **nunca se usó para Shalom** en esta operación: comprobado en
la base, 0 guías de Shalom ingeridas por reporte frente a ~3.000 de Aliclik.

Sin cron, las guías creadas por API se quedaban congeladas en el estado con el
que nacían, y el Master decía «pendiente» indefinidamente — que no es un dato,
es un vacío disfrazado. De ahí que el rastreo sea la única fuente de estados.
