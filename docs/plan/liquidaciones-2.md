# Liquidaciones 2 — plan de iteraciones

Versión 1 · 16-09-2026 · rama `delivery-lima`

Liquidaciones 2 reemplaza el Google Sheet «MASTER KEY 2.0 Grupo GF SAC» con
hojas configurables dentro de Kapta. La especificación funcional vive en el MOM
(`docs/mom/master-pedidos-v1.md`, §30); este documento es el plan de trabajo y
el registro de lo que se encontró al analizar el Excel y cruzarlo con la base.

## 1. Qué es el Excel

Un Master de pedidos hecho a mano, con 28 hojas en cinco capas:

| Capa | Hojas | Qué hacen | En Kapta |
| --- | --- | --- | --- |
| Fuente cruda | Flow Aurela, Flow Kenku, Flow * Anulados, Motivos de Anulación | Export de pedidos de Shopify. Las de «Anulados» las alimenta Shopify Flow al anular | `orders`, `order_master`, `cancelled_at`, `cancel_reason` |
| Reparto propio | Duglas, Gera, Roy, Yhoni, Yukio, Marcos | Una fila por punto de ruta con estado, efectivo, a cobrar y método de pago; totales con SUMIFS | Rutas y liquidaciones de motorizado (casi sin uso) |
| Courier externo | Alexis, Urpi, Fenix Lima, Aliclik Lima, Aliclick, Dropi, ShalomOlva | Reportes por guía. Cuatro son IMPORTRANGE de otros Sheets | `shipments` con las APIs de Aliclik, Shalom, Tanders y Swayp |
| Consolidado | Revisar Aurela, Revisar Kenku | Una fila por pedido, zona por distrito, una columna por repartidor con E/T/0, resolver de Estatus | `order_master` con su recálculo |
| Indicadores | MasterKey, OCTUBRE, KPI LIMA, COPIA MK | Ventas contra meta, tasas por zona y día, efectividad por motorizado, estado de resultados | Parcial |
| Catálogos | Clasificación Lima y Provincias, Clasificación Provincia | Distrito → zona; cobertura por ciudad | `peru_districts`, cobertura COD |

Peso: Revisar Aurela tiene 8.390 filas y 259 mil fórmulas; Revisar Kenku 6.393
y 185 mil. Ese es el motivo de que el Sheet ya no escale.

Decisiones tomadas con la operación (16-09-2026):

- **Alexis y Urpi son couriers externos**, no motorizados propios, aunque en el
  Excel tengan hoja de puntos.
- `plataformas` es un resto de la plantilla original (logos de couriers
  colombianos); solo aportaba el mes → fecha. No se migra.
- Las hojas de anulados no se migran: Kapta ya recibe la anulación de Shopify.
  Motivo y categoría de anulación, que se escribían a mano, quedan como
  columnas manuales si el motivo de Shopify no alcanza.
- Hojas vacías o referencias muertas, fuera de alcance: Revisar Bienestar,
  Anulados Aurela/Kenku, Flow Bienestar Anulados, Envios, Ptos Kast, Felix,
  Chumy, Yoel, Anthony, Fenix Drop, Gasto Ads *, Provincia, prov.
- **El archivo analizado está recortado.** Para poder descargarlo se borraron
  meses enteros de varias hojas. Los saltos grandes entre meses en una hoja son
  eso, no ausencia de operación. Cuando una iteración necesite la historia
  completa, se pide la hoja original (ver §5).

## 2. Cruce contra la base de Kapta (16-09-2026)

Cobertura de los códigos de pedido del Excel en Kapta, sobre el archivo recortado:

| Hoja | Códigos únicos | En Kapta | Nota |
| --- | --- | --- | --- |
| Revisar Kenku | 6.385 | 100 % | Cubre agosto y septiembre 2026 |
| Revisar Aurela | 8.387 | 51 % | Kapta tiene Aurela solo desde junio 2026 |
| Duglas / Urpi | 328 / 945 | 81 % / 80 % | Faltan los anteriores a junio 2026 |
| Alexis / Roy / Yhoni | 6.047 / 4.727 / 3.737 | 40 % / 39 % / 43 % | Ídem, con más historia |
| Gera / Yukio / Marcos | 592 / 1.042 / 320 | 6 % / 11 % / 0 % | Actividad anterior a junio 2026 |
| Fenix Lima | 6.699 | 12 % | Ninguno con envío Fenix en Kapta |

Montos: el «Monto» de Revisar coincide con el total de Shopify en 4.261 de
4.263 (Aurela) y 6.371 de 6.372 (Kenku). El «A cobrar» de los repartidores
coincide entre 97 % y 99 %; las diferencias más frecuentes son 99, 89 y 149
soles, es decir, un producto entero de más o de menos.

Estatus, el hallazgo grande:

- De 4.764 pedidos que los repartidores marcaron entregados y existen en Kapta,
  **ninguno** figura entregado por repartidor en Kapta (`delivered_courier`
  nulo, cero intentos, «sin confirmar» 2.897 y «asignado a courier» 1.630).
  Rutas: 2 rutas y 1 parada en toda la base; 3 liquidaciones cargadas.
- Al revés, 2.563 pedidos «Pendiente» en el Excel están entregados en Kapta
  (Aliclik 1.698, Shalom 473, Tanders 170): Provincia llega por API y las hojas
  IMPORTRANGE del Excel no se estaban actualizando.
- 77 pedidos entregados por el repartidor y anulados en Shopify.

Conclusión: **Lima vive en la hoja, Provincia vive en Kapta.** Liquidaciones 2
importa la historia de Lima desde el Excel y toma Provincia de Kapta.

Entidades: existen los motorizados Roy, Yhoni, Duglas y Yukio; no existen Gera
ni Marcos. Alexis y Urpi son couriers (Urpi ya está en el catálogo de couriers;
Alexis hay que darlo de alta). Couriers en Kapta: Aliclik 7.232 envíos, Shalom
1.141, Fenix/Swayp 657, Tanders 470, «por definir» 3.298.

Observaciones: no existía una entidad que explique una diferencia entre un
valor externo y el de Kapta. Las correcciones de liquidación (0093) solo cubren
monto y comisión dentro de un lote; las bitácoras no explican nada. De ahí
`sheet_observations` (0168).

## 3. Modelo

- **Dominio**: el grupo que define el contrato (clave de fila, vocabulario de
  estados y equivalencia con Kapta, plantilla de columnas). Seis: Pedidos,
  Catálogos, Reparto propio, Courier externo, Consolidado, Indicadores.
- **Hoja**: instancia del dominio (Roy, Aliclik Lima, Revisar Aurela). Hereda la
  plantilla; puede añadir columnas manuales; no rompe el contrato.
- **Columna**: `campo` (del pedido, solo lectura), `manual`, `lookup` (busca en
  otra hoja), `derivada` (regla con nombre). No hay motor de fórmulas.
- **Estados**: lista cerrada por dominio; cada uno equivale a un estado
  operativo de Kapta y declara su efecto (informa, entrega, devolución,
  cancelación del courier). Los alias por hoja traducen lo que llega. Lo
  desconocido no se adivina.
- **Observación de cuadre**: valor externo, valor Kapta, diferencia, motivo del
  catálogo, nota, estado. Resolver exige motivo.
- **Historial**: cada celda manual deja rastro append-only.

## 4. Iteraciones

1. **Cimientos** (esta rama). Migración 0168, dominios y estados sembrados,
   Catálogo de zonas con los 979 distritos del Excel, hojas Pedidos y
   Consolidado por tienda, grid virtualizado con configuración de columnas,
   edición de celdas manuales con historial, panel de estados y alias, panel de
   observaciones. El Consolidado ya resuelve Estatus con lo que Kapta sabe
   (Provincia cubierta desde el día uno). Permisos `sheets.edit` y
   `sheets.manage`. Pruebas del vocabulario, el resolver y el motor.
2. **Reparto propio** (hecho el 16-09-2026). Una hoja por motorizado: Roy,
   Yhoni, Duglas y Yukio desde la ficha de Kapta, y Gera y Marcos como
   históricas. Columnas del Excel más «En Kapta», «Reprogramar para»,
   «Estado escrito», «Método escrito» y «Revisión». Lector de bloques por
   fecha (`lib/sheets/reparto-import.ts`), importación por archivo desde la
   pantalla (`/api/sheets/import`) y por script (`scripts/import-reparto.ts`),
   alta de filas a mano, barra de totales del mes, y el aporte E/T/D al
   Consolidado con la columna «Aportes». Historia importada: 13.843 puntos en
   737 rutas. Los estados LO DEJA, DESARMAR, DICE QUE RECIBIÓ y REPETIDO ya
   están definidos (MOM §30.7), «OK» es pagado por Shopify y «VENDE MÁS» es
   una app de cobro por link. Pendiente de la operación: los métodos de pago
   YAPE/PLIN GCC y FP. La foto queda para la iteración 4, junto con
   las observaciones automáticas.
3. **Courier externo** (parcial, 16-09-2026). Hechos Alexis y Urpi: hojas
   con formato «cuaderno» (`config.layout`), las mismas columnas y el mismo
   lector que Reparto propio, pero con el vocabulario y la liquidación del
   courier. Historia importada desde el Excel. Alexis **no está** en el
   catálogo de couriers del Master (`lib/couriers/catalog.ts`): darlo de alta
   es una decisión del Master, no de estas hojas. Pendiente, a la espera de
   archivos: Swayp Lima, Aliclik Lima, Aliclik provincia, Dropi, Shalom, Olva,
   Axel y Tanders con formato «reporte» por guía y mapeo de columnas por hoja;
   hacia adelante se llenan desde `shipments`.
4. **Cierre por pedido** (hecho el 17-09-2026, MOM §30.8). Observaciones
   automáticas al importar y al editar (monto que difiere en más de S/ 0,50;
   pedido anulado o devuelto en Kapta), columnas «Estado en Kapta» y «Monto
   Kapta» en el cuaderno, «A cobrar» en ámbar cuando no cuadra, mini-formulario
   de motivo en la fila al editar un monto, aplicar al Master fila a fila o por
   periodo por la misma puerta que Liquidaciones (`status_override`, fuente
   `liquidacion`), y foto del cuaderno con la visión de Liquidaciones. Una fila
   con observación abierta no cruza al Master hasta que quien liquida acepta el
   motivo. Fuera: no hay camino de devolución al Master desde una hoja (no
   existe en Kapta; se cuenta y se deja).
   **Pendiente, iteración aparte:** la interfaz del motorizado para explicar
   una diferencia. El dato que llenará es `sheet_observations.reason_code` y
   `note` de la fila; Liquidaciones 2 ya lo lee, lo muestra y lo acepta.
5. **Indicadores.** KPI Lima (tasas por zona y día, semana pasada, 15 días,
   por mes), efectividad por repartidor y mes, ventas contra meta. El estado de
   resultados queda al final porque depende de Gasto Ads y Provincia.
6. **Cierre.** Exportar a Excel con las mismas cabeceras, pruebas de
   permisos, documentación final.

## 5. Archivos que hay que pedir

Iteración 2: ya recibido (archivo del 16-09-2026 con las hojas de reparto
completas; los huecos de meses que quedan son reales, confirmado por la
operación).

Para la iteración 3: hojas Alexis, URPI y Fenix Lima del Sheet original, más
las fuentes de los IMPORTRANGE:

| Documento | Hoja y rango | Alimenta |
| --- | --- | --- |
| `1fZosWdOvfDZBGlPxq32CUl6GIhNutKS6ou88ZTgurrw` | 'Aliclik Lima'!A1:Z | Aliclik Lima |
| `1EeZmpRCj7vSRXkU6vb2xL3VKIpq_4O7l1qXrrCfe4PA` | Aliclick!A1:U · 'Shalom/Olva'!A1:U · Dropi!A:R | Aliclick, ShalomOlva, Dropi |
| mismo | Provincia (C y U) · 'Suma prov' (C8:E13) | Estado de resultados |
| `1JDJOisx1acerm5Ew6OD703XZiqHmvW7J9VCyjQKDMlU` | 'AURELA/KENKO'!A11:S400 | Fenix Lima |

Para la iteración 5: Gasto Ads Aurela y Gasto Ads Kenku Perú, si existen.
