# Módulo «Compras»: especificación funcional y técnica

> **Para qué sirve este documento.** Describe, a partir del código real, cómo funciona la sección **Compras** del panel de Miranova (importaciones, proveedores, reportes, compras a laboratorios, traslados entre bodegas y seguimiento de guías), para poder replicarla en otro sistema. Está pensado para que el dueño se lo entregue a un desarrollador o a otro asistente de IA.
>
> **Fuente.** Repositorio `miranova-system`, commit `a3772bc` (13 nov 2026). Todas las rutas de archivo son relativas a la raíz del repositorio. Cuando algo no está claro en el código, se dice explícitamente.
>
> **Stack del original.** Next.js 16 (App Router, Server Actions), React 19, Supabase (Postgres + Storage), desplegado en Vercel. Interfaz en español. Los montos de importaciones van en **USD**.

---

## Índice

1. [Resumen](#1-resumen)
2. [Conceptos y glosario](#2-conceptos-y-glosario)
3. [Flujos de punta a punta](#3-flujos-de-punta-a-punta)
4. [Pantallas](#4-pantallas)
5. [Modelo de datos](#5-modelo-de-datos)
6. [Reglas de negocio y cálculos](#6-reglas-de-negocio-y-cálculos)
7. [Integraciones](#7-integraciones)
8. [Permisos y seguridad](#8-permisos-y-seguridad)
9. [Tareas automáticas](#9-tareas-automáticas)
10. [Qué es específico de Miranova y qué adaptar para Perú](#10-qué-es-específico-de-miranova-y-qué-adaptar-para-perú)
11. [Orden sugerido para construirlo](#11-orden-sugerido-para-construirlo)
12. [Apéndice A: archivos del módulo](#12-apéndice-a-archivos-del-módulo)
13. [Apéndice B: inconsistencias y puntos abiertos detectados](#13-apéndice-b-inconsistencias-y-puntos-abiertos-detectados)

---

## 1. Resumen

### 1.1 Qué problema resuelve

Miranova es un proveedor de dropshipping que vende en varios países de Centroamérica a través de la plataforma **Drop** (soydrop.com), donde cada país es una "cuenta" con su propio catálogo e inventario. La mercadería llega de dos formas:

- **Importada** (sobre todo de China): se compra a un proveedor, se paga, viaja con una paquetera (DHL, FedEx, UPS u otra), pasa aduana y llega a la bodega del operador logístico (Boxful) del país; luego se ingresa al inventario de Drop.
- **Local / maquila**: se compra a laboratorios en Guatemala (en quetzales) y se reparte entre las cuentas de varios países.

Después hay que **trasladar** parte de la mercadería de una bodega a otra (por ejemplo, de Guatemala a Honduras o El Salvador).

La sección **Compras** (ruta `/imports`) junta todo eso: qué se compró, cuánto costó realmente cada unidad puesta en bodega (costo aterrizado), qué se pagó, dónde va el envío, qué llegó bien y qué no, y cuándo entró al inventario de la plataforma.

### 1.2 Las piezas

| Pieza | Ruta | Qué hace |
|---|---|---|
| Importaciones | `/imports`, `/imports/[id]` | Registro de cada compra al exterior: proveedor, país destino, productos, costos repartidos, pagos, documentos, guía, estados, aviso a la bodega, recepción, enlace con el catálogo de Drop. |
| Proveedores | `/imports/suppliers` | Directorio de proveedores con estadísticas (cuánto tardan, a tiempo, faltantes y dañadas, cuánto se les compró). |
| Reportes | `/imports/reports` | Dinero en camino, compras por mes, historial del costo por unidad de cada producto, ranking de proveedores. Solo con permiso Dinero. |
| Laboratorios | `/imports/labs` | Compras locales a laboratorios (en quetzales) y su reparto de unidades entre cuentas. |
| Traslados | `/imports/transfers`, `/imports/transfers/[id]` | Envíos de varios productos entre bodegas, con manifiesto, llegada por bodega, merma y dañadas; "Por enviar" calcula lo pendiente de mandar. |
| Bodegas | `/imports/transfers/bodegas` | Puntos de origen y destino de los traslados. |
| Seguimiento de guías | (dentro de Importaciones) | Consulta automática a DHL, FedEx, UPS (APIs oficiales) o 17TRACK; guarda estado, última novedad, lugar y llegada estimada; calcula "dónde va". |
| Lectura de facturas con IA | (dentro de Importaciones) | Lee una factura, proforma o packing list (PDF o foto) con un modelo de Anthropic y propone productos y cargos para agregar. |
| Enlace con inventario | (Inventario y sincronización) | Las líneas pagadas cuentan como "en camino" en Inventario; los productos nuevos se enlazan solos al aparecer en Drop; la importación pasa sola a "Ingresado en Drop" cuando Drop registra la entrada. |
| Resumen diario | correo | Importaciones atrasadas, que llegan esta semana, sin avisar a la bodega y sin novedades. |
| Excel | `/api/export/imports/[id]`, `/api/export/labs` | Descarga de una importación o de la lista de laboratorios. |

---

## 2. Conceptos y glosario

Solo los conceptos que existen en el código.

| Término | Qué es en el sistema |
|---|---|
| **Importación** | Una compra al exterior con destino a **un** país. Código `IMP-AAAA-NNN`. Tabla `imports`. |
| **Línea / producto de la importación** | Un producto con cantidad, costo unitario del proveedor (USD), peso por unidad opcional y precio de venta opcional. Puede estar **enlazado** a un producto del catálogo de Drop del país destino o ser **nuevo** (sin enlazar). Tabla `import_items`. |
| **Producto nuevo** | Línea sin `product_external_id`. Se enlaza sola cuando aparece en el catálogo de Drop del país (por SKU o nombre), o a mano con "Enlazar". |
| **Cotización** | Estado inicial (`quote`): todavía no se compró. No cuenta como compra en reportes ni como "en camino" en Inventario. |
| **Proforma invoice** | Documento tipo `proforma`: cotización formal del proveedor. Privado (solo con Dinero). |
| **Factura comercial** | Documento tipo `invoice`. Es parte del checklist mínimo. La puede ver también el usuario "solo ver" (la bodega la necesita para la aduana). |
| **Packing list** | Documento tipo `packing`. La IA también lo puede leer. |
| **Comprobante de pago** | Documento tipo `payment`. Privado (solo con Dinero). Se puede adjuntar a un pago. |
| **Guía (AWB / BL)** | Documento tipo `tracking`, o el número de guía escrito en la importación. Parte del checklist mínimo. |
| **Aduana (DUA / póliza)** | Documento tipo `customs`. |
| **Pago** | Registro de dinero pagado (USD), fecha, método y comprobante opcional. Tabla `import_payments`. |
| **Costo** | Gasto adicional de la importación (envío, importación/aduana, adicional) en USD, con una regla de **reparto** entre las líneas. Tabla `import_costs`. |
| **Costo final por unidad (costo aterrizado / landed cost)** | (Costo del proveedor + parte de cada costo repartido) ÷ unidades buenas. Ver §6.4. |
| **Reparto (prorrateo)** | Cómo se divide un costo entre líneas: por valor, por unidades, por peso o todo a un producto. |
| **Recepción** | Lo que la bodega contó al llegar: recibidas, dañadas y nota por línea. |
| **Unidades buenas** | Recibidas − dañadas (si se contó); si no se contó, las pedidas. |
| **Aviso a la bodega / reportada** | Marca de que ya se avisó a la bodega del país (Boxful) que viene la importación. Se arma un mensaje para WhatsApp. |
| **Ingresado en Drop** | Estado `in_drop`: la mercadería ya está en el inventario de Drop. Puede ponerse a mano o automáticamente. |
| **Entrada de mercadería** | Movimiento de stock de Drop con razón `STOCK_REQUEST`, `INITIAL_STOCK` o `MANUAL` y unidades > 0. Sirve para detectar la llegada. |
| **Seguimiento automático** | Consulta periódica a la paquetera (DHL/FedEx/UPS) o a 17TRACK. Guarda `track_*` en la importación. |
| **Novedad** | Evento del historial que cuenta como movimiento del envío: cambios de estado, notas y eventos de la paquetera. Agregar productos, documentos, costos o pagos **no** es novedad. |
| **"Dónde va"** | Fase calculada a partir del lugar de la última novedad: en origen, en tránsito (país), en destino o entregado. |
| **Compra a laboratorio** | Compra local (Guatemala, en quetzales) con cantidad solicitada, cortesía y reparto por cuenta. Tabla `lab_purchases`. |
| **Cortesía** | Unidades extra que el laboratorio regala: llegan pero no se cobran. |
| **Reparto por cuenta (labs)** | Unidades asignadas a cada cuenta destino (por ejemplo `miranova_hn`), en un JSON. |
| **Traslado** | Envío de varios productos juntos desde una bodega de origen hacia un país; cada producto va a una bodega de ese país. Código `TR-AAAA-NNN`. Tabla `transfers`. |
| **Punto / bodega** | Lugar de origen y/o destino de traslados. Tabla `transfer_points`. |
| **Manifiesto** | Documento tipo `manifest` del traslado y/o su número (`reference`). Se marca "Falta" si no se subió. |
| **Llegada (de traslado)** | Registro por bodega de destino: fecha, quién, y por producto recibidas, dañadas y nota. |
| **Merma** | En traslados: enviadas − recibidas (mínimo 0). |
| **Importado / Maquilado** | Clase de un producto trasladado (`import` / `maquila`). Cada bodega declara qué recibe. |
| **Por enviar** | Lo repartido a otros países en Solicitudes (pedidos de tiendas) y en Laboratorios, menos lo que ya salió en traslados, menos lo "dado por enviado". |
| **Clave de reparto (`source`)** | Identificador de un reparto pendiente: `req:<solicitud>:<producto normalizado>:<país>` o `lab:<compra>:<cuenta>`. |
| **Dinero (permiso)** | Permiso que habilita ver y cargar montos (costos, precios, pagos, documentos con montos). |

---

## 3. Flujos de punta a punta

### 3.1 Importación, como la vive el usuario

1. **Crear la importación** (botón "Nueva importación", panel lateral). Datos: proveedor guardado (o crearlo ahí mismo con nombre, origen y WhatsApp), origen, n.º de orden de la plataforma (Alibaba u otra), país destino, transporte (courier, aéreo, marítimo, terrestre), empresa que lo lleva (paquetera), número de guía, fecha del pedido (por defecto hoy) y llegada estimada. Queda en **Cotización** con código `IMP-AAAA-NNN` y lleva al detalle.
2. **Agregar productos** ("Agregar producto"), de tres formas:
   - del **catálogo de Drop del país destino** (queda enlazado);
   - de **Drop de otro país** (queda como producto nuevo con nombre, SKU propio y foto; se enlaza solo cuando aparezca en el país destino);
   - **producto nuevo** a mano (nombre, SKU opcional, foto opcional).
   Con permiso Dinero se cargan también costo por unidad (USD) y precio de venta (USD, si no se toma de Drop).
   - Alternativa: subir la factura/proforma/packing list y usar **"Leer con IA"**: propone las líneas (con producto de Drop sugerido si coincide por SKU o nombre) y los cargos; el usuario indica el tipo de cambio si la factura no está en USD, revisa, desmarca y agrega.
3. **Documentos**: subir proforma, factura comercial, comprobantes, guía, packing list, aduana, fotos u otros (PDF, JPG, PNG, WEBP o XLSX, hasta 25 MB). La lista muestra un **checklist** mínimo: factura comercial y tracking.
4. **Pagos** (con Dinero): registrar cada pago (monto USD, fecha, método, nota, comprobante opcional). El resumen muestra "Pagado" y "Falta pagar".
5. **Costos** (con Dinero): agregar flete, aranceles/impuestos/agente, inspección, etc., cada uno con su reparto. El costo final por unidad se recalcula al instante.
6. **Estado**: el usuario avanza el estado a mano (Pagado/anticipo → En producción → Listo para enviar → En tránsito → En aduana → Liberado → En camino a bodega…), con nota opcional. Cada cambio queda en el historial.
7. **Envío con guía**: con número de guía, el sistema lo consulta solo cada 3 horas (o con "Actualizar ahora"): estado de la paquetera, última novedad, lugar, llegada estimada por la paquetera y "dónde va". Las novedades nuevas entran al historial.
8. **Aviso a la bodega**: cuando falta 3 días o menos para la llegada estimada (o ya pasó) y no se avisó, aparece la alerta "Avisar". El usuario copia el mensaje (o abre WhatsApp con el texto), lo manda a la bodega y marca **"Reportada"**.
9. **Recepción en bodega**: al llegar, se anota por producto cuántas llegaron, cuántas dañadas y una nota; se pueden subir fotos de la recepción. Al guardar, si la importación estaba en camino pasa a **Recibido** y se anota la fecha de llegada. El costo por unidad pasa a calcularse sobre las unidades buenas.
10. **Enlace con productos y stock**: mientras está pagada y no entró a Drop, cada línea enlazada cuenta como "en camino" en Inventario. Los productos nuevos se enlazan solos cuando aparecen en el catálogo de Drop del país. Cuando Drop registra la entrada de mercadería de **todas** las líneas (y ninguna queda sin enlazar), la importación pasa sola a **Ingresado en Drop**.
11. **Cierre**: el usuario la pasa a **Cerrado** cuando terminó. También puede **cancelarla** o **eliminarla** (escribiendo ELIMINAR).
12. **Costos finales**: el detalle muestra por línea costo del proveedor, costo final por unidad (con desglose), precio de venta, margen y ganancia; en total, costo total, costo promedio por unidad buena, ganancia esperada y qué parte de las unidades hay que vender para recuperar lo invertido. Todo se puede bajar en Excel.

### 3.2 Compra a laboratorio

1. "Nueva compra": producto (con sugerencias del catálogo), laboratorio, estado (Solicitado por defecto), fecha de solicitud (hoy por defecto, no futura), fecha de traslado y de llegada a Drop (opcionales), n.º de cajas, cantidad solicitada, cortesía, **reparto por cuenta** (8 cuentas fijas), precio por unidad en quetzales y tipo de cambio Q por USD (estos dos solo con Dinero; se sugiere el tipo de cambio de Drop Guatemala), notas.
2. En la lista se cambia el estado rápido (Solicitado → En proceso → En tránsito → Llegó a bodega). Al pasar a "Llegó a bodega" sin fecha de llegada, se anota hoy.
3. Lo repartido a cuentas de otros países aparece en **Traslados → Por enviar**.
4. No hay documentos, pagos ni historial para laboratorios; tampoco se enlaza con el stock de Drop.

### 3.3 Traslado entre bodegas

**Camino A, manual:**
1. "Nuevo traslado": bodega de origen, país destino, quién lo lleva, n.º de manifiesto o guía, fecha de salida (solo si ya salió), llegada estimada, notas. Con fecha de salida queda **En camino**; sin ella, **Preparando**.
2. "Agregar producto": del catálogo (de cualquier país) o escrito a mano; clase (importado/maquilado); bodega de destino del país; cantidad. Si el producto de Drop tiene variantes (color, talla), se pide la cantidad por variante (cuadrícula color × talla) y se crea una línea por variante.
3. "Marcar como enviado": fecha de salida (obligatoria, no futura), llegada estimada, transportista y manifiesto. Necesita al menos un producto. Pasa a **En camino**.
4. Subir el **manifiesto** (y fotos u otros documentos).
5. "Registrar llegada" en cada bodega de destino: fecha y, por producto, recibidas (obligatorio, 0 si no llegó ninguna), dañadas y nota. Cuando **todas** las bodegas de destino tienen su llegada, el traslado pasa a **Llegó**. La llegada se puede corregir después.
6. Se puede **cancelar** (no cuenta como enviado y lo repartido vuelve a "Por enviar") o **reabrir**; se puede **eliminar** solo si no tiene llegadas.

**Camino B, desde "Por enviar":**
1. En la pestaña "Por enviar" se ven, por país, los repartos pendientes (de Solicitudes y de Laboratorios) con repartido, enviado y falta.
2. "Armar traslado" para un país: se marcan las filas, cantidad (no más de lo que falta), clase y bodega de cada una, origen (se sugiere uno) y quién lo lleva. Se crea un traslado **Preparando** con esas líneas, cada una con su clave de reparto (`source`), y se sigue como en el camino A desde el paso 3.
3. Un reparto que se mandó por fuera o ya no se manda se puede **"Quitar de por enviar"** (queda "dado por enviado").

---

## 4. Pantallas

Todas las pantallas de Compras llevan una sub-navegación (`components/imports-subnav.tsx`): Importaciones · Laboratorios · Traslados · Proveedores · Reportes. Con "Compras (solo ver)" solo aparecen Importaciones y Traslados; Reportes solo aparece con Dinero y permiso completo. En el menú principal la sección se llama **Compras** y aparece con `imports` o `imports_view` (`components/app-frame.tsx:22`).

### 4.1 Lista de importaciones — `/imports`

Archivo: `app/(app)/imports/page.tsx`. Permiso: `imports` o `imports_view`.

- **Encabezado**: n.º de activas; con Dinero, "USD en camino" (suma del costo total de las activas); con permiso completo, "N sin avisar a la bodega"; "N atrasadas"; "N sin novedades".
- **Pestañas** (parámetro `v`): Activas (por defecto), Recibidas (recibido, ingresado en Drop, cerrado), Canceladas, Todas. Cada una con su conteo.
- **Filtros**: país destino (chips, si hay más de uno usado; parámetro `c`) y proveedor (parámetro `s`, se llega desde Proveedores).
- **Tabla**: código, proveedor y n.º de orden, checklist (factura comercial, tracking), hasta 3 productos con miniatura; destino; estado (con "dónde va" y "sin novedades hace N días"); unidades y n.º de productos; llegada (o "Llegó …", en rojo si atrasada); guía con enlace de seguimiento y estado de la paquetera; bodega ("Reportada" / "Avisar" / —); con Dinero: costo total y pagado ("falta …").
- **Acción**: "Nueva importación" (solo permiso completo).

### 4.2 Detalle de importación — `/imports/[id]`

Archivo: `app/(app)/imports/[id]/page.tsx`. Permiso: `imports` o `imports_view` (solo ver: se ve todo igual pero sin botones).

- **Encabezado**: código y estado; proveedor (y enlace a su WhatsApp, solo permiso completo); origen → país destino; transporte. Acciones: **Excel** (todos) y, solo con permiso completo, **Editar datos** y **Eliminar**.
- **Métricas**: Productos (unidades y buenas al recibir). Con Dinero: Costo total (y promedio por unidad buena), Ganancia esperada (y % de unidades para recuperar la inversión), Pagado (y falta pagar). Sin Dinero: Llegada, Guía, Bodega.
- **Estado y seguimiento**: transporte, guía (enlace), n.º de orden, fechas, peso, notas; alerta "sin novedades hace N días"; aviso "Drop ya registró la entrada de todos los productos…"; caja de **seguimiento automático** (estado de la paquetera, "dónde va", última novedad con hora, llegada estimada por la paquetera frente a la escrita a mano, error, con qué servicio se consulta y cuándo se revisó, botón "Actualizar ahora"); formulario de **estado** con nota.
- **Aviso a la bodega** (solo permiso completo): alerta si corresponde, botones "Copiar mensaje", "Abrir WhatsApp", "Marcar como reportada" / "Quitar marca", y quién/cuándo la reportó.
- **Productos**: foto, nombre, SKU, etiqueta "Nuevo", peso; cantidad y lo que llegó; estado frente a Drop ("En Drop" con unidades y fecha, o "marcada a mano"; "En camino" / "Atrasada" — cuenta en Inventario; "Sin enlazar" con botón **Enlazar**; "Al pagarla, cuenta en Inventario"). Con Dinero: costo proveedor, costo final por unidad (con desglose en el título), precio de venta ("escrito a mano" o "de Drop"), margen (USD y %, "margen bajo") y total. Acciones por línea: Editar, Quitar. Notas del cálculo (p. ej., "Faltan pesos…").
- **Recepción en bodega**: resumen pedidas / llegaron / faltan / dañadas / buenas, líneas con diferencias, "falta contar N", quién y cuándo contó, fotos. Botón "Registrar/Editar recepción" (formulario con "Llenar con lo pedido", que usa lo que registró Drop si ya se vio la entrada) y subida de fotos de recepción.
- **Costos** (solo Dinero): suma por tipo, lista con tipo, nombre, reparto y monto; formulario para agregar.
- **Pagos** (solo Dinero): lista con fecha, método, nota, comprobante; formulario para agregar.
- **Documentos**: agrupados por tipo; enlace para ver, descargar, "Leer con IA" (si aplica) y borrar. Selector de tipo + subida múltiple (hasta 10 archivos por vez).
- **Historial**: línea de tiempo de eventos (los de tipo `money` solo con Dinero).

### 4.3 Proveedores — `/imports/suppliers`

Archivo: `app/(app)/imports/suppliers/page.tsx`. Permiso: `imports`.

- Tabla: nombre, origen, condiciones de pago; contacto, WhatsApp, correo; n.º de importaciones (enlace a la lista filtrada) y fecha de la última; "Tarda" (días promedio) y "a tiempo %" (rojo si < 70 %); "Faltantes y dañadas" % (rojo si ≥ 3 %); con Dinero, "Comprado" (USD); "Le compras" (top 3 productos por unidades).
- Acciones: Nuevo proveedor, Editar, Borrar (solo si no tiene importaciones).

### 4.4 Reportes — `/imports/reports`

Archivo: `app/(app)/imports/reports/page.tsx`. Permiso: `imports` **y** `money`.

- Métricas: Dinero en camino (y unidades), Pagado de lo que viene (y falta pagar), Comprado en 12 meses, Este mes (comprado y pagado).
- Comprado por mes (barras de 12 meses), En camino por país, tabla de los últimos 6 meses con movimiento.
- Costo por unidad de cada producto: último, anterior, cambio % (rojo si sube > 2 %, verde si baja > 2 %), historial por importación.
- Ranking de proveedores por monto comprado.

### 4.5 Laboratorios — `/imports/labs`

Archivo: `app/(app)/imports/labs/page.tsx`. Permiso: `imports`.

- Encabezado: n.º en curso, unidades, monto en quetzales (con Dinero).
- Pestañas: En curso (solicitado, en proceso, en tránsito), Llegaron a bodega, Todas. Búsqueda por producto, laboratorio o notas.
- Tabla: producto, laboratorio, cajas, notas; estado (selector que guarda al cambiar); fechas (solicitud, traslado, llegada a Drop); cantidad (total = solicitada + cortesía); reparto por cuenta y "faltan N" por repartir; con Dinero, monto Q, monto USD y precio unitario.
- Acciones: Nueva compra, Editar, Borrar; **Descargar Excel** (requiere además permiso Exportar), con los filtros aplicados.

### 4.6 Traslados — `/imports/transfers`

Archivo: `app/(app)/imports/transfers/page.tsx`. Permiso: `imports` o `imports_view`.

- Encabezado: n.º en camino, "N con la llegada vencida", unidades por enviar. Acciones (solo permiso completo): Bodegas, Nuevo traslado.
- Dos secciones (parámetro `s`):
  - **En ruta**: *Cuadro de rutas* (por origen → bodega de destino: preparando, en camino, próxima llegada y vencidos, llegados en los últimos 30 días con merma y dañadas) y la lista con filtros por estado (En camino por defecto, Llegaron, Cancelados, Todos) y por país.
  - **Por enviar**: traslados *Preparando* y (solo permiso completo) *Repartos por enviar* agrupados por país, con "Armar traslado" y "Quitar de por enviar".
- Lista: código, transportista y manifiesto, productos; ruta y bodegas (✓ las que ya llegaron); estado ("llegó a N de M", merma/dañadas); unidades enviadas y recibidas; salió; llega ("vencida"); manifiesto "Subido" / "Falta".

### 4.7 Detalle de traslado — `/imports/transfers/[id]`

Archivo: `app/(app)/imports/transfers/[id]/page.tsx`. Permiso: `imports` o `imports_view`.

- Encabezado: estado, "Llegada vencida", origen → país, transportista, manifiesto. Acciones: Marcar como enviado (si Preparando), Editar datos, Cancelar/Reabrir (si no llegó), Eliminar (si no tiene llegadas).
- Métricas: salieron (unidades, productos, bodegas), salió, llegada estimada o llegó, llegaron (merma, dañadas o "Completo, sin daños").
- Un panel por **bodega de destino**: estado de su llegada, botón Registrar/Corregir llegada, tabla por producto (salieron, llegaron, dañadas, merma, buenas), editar/quitar líneas mientras la bodega no registre llegada.
- Agregar producto (si el traslado no está cerrado y queda alguna bodega sin llegada).
- Manifiesto y documentos; historial.

### 4.8 Bodegas — `/imports/transfers/bodegas`

Archivo: `app/(app)/imports/transfers/bodegas/page.tsx`. Permiso: `imports`.

Tabla de bodegas: nombre, ciudad, país, si es origen y/o destino, qué recibe como destino, a qué cuentas abastece. Crear y editar; no se borran, se marcan "Ya no se usa".

### 4.9 Rutas de API del módulo

| Ruta | Permiso | Qué hace |
|---|---|---|
| `GET /api/imports/doc/[id]` (`?dl=1`) | `imports` o `imports_view`; proforma y comprobante, además `money` | Redirige (302) a un enlace firmado de Storage de 600 s. |
| `GET /api/imports/item/[id]` | `imports` o `imports_view` | Foto subida de un producto nuevo; enlace firmado de 3600 s (cache privado 3000 s). |
| `GET /api/transfers/doc/[id]` (`?dl=1`) | `imports` o `imports_view` | Documento de traslado; enlace firmado de 600 s. |
| `GET /api/export/imports/[id]` | `imports` o `imports_view` | Excel de una importación (hojas Resumen, Productos y, con Dinero, Costos y Pagos). |
| `GET /api/export/labs?v=&q=` | `imports` **y** `export` | Excel de laboratorios con los filtros de la página. |

---

## 5. Modelo de datos

Postgres (Supabase). Todas las tablas tienen RLS activado **sin políticas**: solo el backend con la clave de servicio accede (ver §8). Ningún trigger: `updated_at` lo pone el código de la aplicación.

### 5.1 `imports` — importación

Migraciones: `0035_imports.sql`, `0037_import_suppliers.sql`, `0038_import_tracking.sql`, `0039_imports_proforma_order_events.sql`, `20261113155800_import_track_location.sql`.

| Columna | Tipo | Para qué |
|---|---|---|
| `id` | uuid PK | |
| `code` | text, not null, **unique** | `IMP-2026-001`. |
| `supplier` | text | Nombre del proveedor (copia, para listas e historial). |
| `supplier_id` | uuid → `import_suppliers` (on delete set null) | Proveedor guardado. Índice `imports_supplier_idx`. |
| `order_ref` | text | N.º de orden en Alibaba u otra plataforma. |
| `origin` | text | País o ciudad de origen ("China, Yiwu"). Se usa para "dónde va". |
| `dest_country` | text, not null | Código ISO de 2 letras (sin CHECK en la base; se valida en la app). |
| `status` | text, not null, default `'quote'` | Ver ciclo de vida §5.10 (sin CHECK en la base). |
| `ordered_at`, `eta`, `arrived_at` | date | Pedido, llegada estimada (escrita a mano), llegada real. |
| `transport` | text, not null, default `'courier'` | `courier`, `air`, `sea`, `land` (sin CHECK). |
| `carrier` | text | Paquetera ("DHL", "FedEx"…). Decide qué API se usa. |
| `tracking_number` | text | Número de guía. |
| `tracking_url` | text | Enlace manual si la paquetera no es conocida. |
| `weight_kg` | numeric, CHECK ≥ 0 | Peso total (informativo). |
| `reported_at`, `reported_by` | timestamptz, uuid → `app_users` | Aviso a la bodega. |
| `notes` | text | |
| `created_by`, `created_at`, `updated_at` | | |
| `track_registered` | text | Número de guía al que corresponde lo guardado (si cambia la guía, se reinicia). |
| `track_status`, `track_sub_status` | text | Estado en vocabulario de 17TRACK (`InTransit`, `Delivered`…) y subestado/código original. |
| `track_event`, `track_event_at` | text, timestamptz | Última novedad ("texto · lugar") y su hora. |
| `track_location` | text | Lugar de la última novedad, tal como lo manda la paquetera. |
| `track_eta` | date | Llegada estimada por la paquetera (no pisa `eta`). |
| `track_checked_at`, `track_error` | timestamptz, text | Última consulta y error. |

Índices: `imports_status_idx (status, created_at desc)`.

### 5.2 `import_items` — productos de la importación

Migraciones: `0035`, `0036_imports_reception.sql`.

| Columna | Tipo | Para qué |
|---|---|---|
| `id` | uuid PK | |
| `import_id` | uuid → `imports` (on delete cascade) | |
| `account_id` | uuid → `accounts` (set null) | Cuenta de Drop del producto enlazado. |
| `product_external_id` | text | Id del producto en Drop. **null = producto nuevo**. |
| `name` | text not null | |
| `sku` | text | |
| `image_url` | text | Foto del catálogo de Drop. |
| `photo_path` | text | Foto subida (producto nuevo), en el bucket `import-files`. |
| `qty` | integer not null, CHECK > 0 | Unidades pedidas. |
| `unit_cost` | numeric not null default 0, CHECK ≥ 0 | Costo del proveedor por unidad, USD. |
| `unit_weight_kg` | numeric, CHECK ≥ 0 | Para el reparto por peso. |
| `sale_price_usd` | numeric, CHECK ≥ 0 | Precio de venta esperado, si no se toma de Drop. |
| `position` | integer default 0 | Orden. |
| `received_qty` | integer, CHECK ≥ 0 | **null = todavía no se contó**. |
| `damaged_qty` | integer not null default 0, CHECK ≥ 0 | |
| `received_note`, `received_at`, `received_by` | text, timestamptz, uuid | |

Restricción `import_items_damaged_le_received`: `received_qty is null or damaged_qty <= received_qty`. Índices: `(import_id, position)`; `(account_id, product_external_id) where product_external_id is not null` (para que Inventario encuentre lo que viene).

### 5.3 `import_costs` — costos a repartir

| Columna | Tipo | Para qué |
|---|---|---|
| `id`, `import_id` (cascade) | | |
| `kind` | text, CHECK in (`shipping`, `import`, `other`) | Envío · Importación (aranceles, impuestos, agente, almacenaje en aduana) · Adicional. |
| `label` | text not null | Nombre ("Flete DHL"). |
| `amount` | numeric not null, CHECK ≥ 0 | USD (la app exige > 0). |
| `allocation` | text default `'value'`, CHECK in (`value`, `units`, `weight`, `item`) | Regla de reparto. |
| `item_id` | uuid → `import_items` (**on delete cascade**) | Solo con `allocation = 'item'`. |

### 5.4 `import_documents` — documentos

| Columna | Tipo | Para qué |
|---|---|---|
| `id`, `import_id` (cascade) | | |
| `kind` | text, CHECK in (`invoice`, `proforma`, `payment`, `tracking`, `packing`, `customs`, `photo`, `other`) | `proforma` se agregó en 0039. |
| `storage_path` | text not null **unique** | `<importId>/docs/<uuid>.<ext>`. |
| `filename`, `content_type` (not null), `size_bytes`, `uploaded_by`, `created_at` | | Tipo y tamaño se toman de Storage, no del navegador. |

### 5.5 `import_payments` — pagos

| Columna | Tipo | Para qué |
|---|---|---|
| `id`, `import_id` (cascade) | | |
| `paid_at` | date not null | |
| `amount` | numeric not null, CHECK > 0 | USD. |
| `method` | text not null | Uno de: Alibaba, Transferencia, Tarjeta, PayPal, Alipay, Western Union, Efectivo, Otro (`lib/imports.ts:94`). |
| `note` | text | |
| `document_id` | uuid → `import_documents` (set null) | Comprobante. |
| `created_by`, `created_at` | | |

### 5.6 `import_events` — historial

| Columna | Tipo | Para qué |
|---|---|---|
| `id`, `import_id` (cascade) | | |
| `status` | text | Estado nuevo; null para otros hechos. |
| `note` | text | |
| `by_user` | uuid → `app_users` | null = automático (sincronización, paquetera). |
| `at` | timestamptz default now() | Para eventos de la paquetera, la hora del evento. |
| `kind` | text not null default `'status'` (sin CHECK) | `status` (estados, notas, aviso, recepción) · `tracking` (paquetera) · `activity` (productos, documentos, datos) · `money` (costos, pagos, documentos con montos; solo se muestra con Dinero). |

Índice `(import_id, at desc)`. Solo `status` y `tracking` (o kind nulo) cuentan como **novedad** (`lib/imports.ts:131`).

### 5.7 `import_suppliers` — proveedores

Migración `0037`. Columnas: `id`, `name` (not null), `origin`, `contact`, `whatsapp`, `email`, `payment_terms`, `notes`, `created_by`, `created_at`, `updated_at`. **Índice único** `lower(name)`. La migración también convirtió los proveedores escritos a mano en proveedores guardados (tomando el origen más usado) y enlazó las importaciones existentes.

### 5.8 `lab_purchases` — compras a laboratorios

Migración `0046_lab_purchases.sql`.

| Columna | Tipo | Para qué |
|---|---|---|
| `id` | uuid PK | |
| `product` | text not null | Nombre libre (no enlazado a Drop). |
| `lab_name` | text | |
| `status` | text not null default `'requested'`, CHECK in (`requested`, `in_progress`, `transit`, `arrived`) | |
| `requested_at` | date not null, default = hoy en `America/Tegucigalpa` | |
| `shipped_at`, `arrived_at` | date | Traslado y llegada (a Drop, según la etiqueta de la UI). |
| `boxes` | integer, CHECK ≥ 0 | |
| `qty_requested` | integer not null, CHECK > 0 | |
| `qty_courtesy` | integer not null default 0, CHECK ≥ 0 | |
| `distribution` | jsonb not null default `{}` | `{"miranova_gt": 500, "mireva_hn": 200}`. |
| `unit_price_gtq` | numeric(14,4), CHECK ≥ 0 | |
| `fx_gtq_per_usd` | numeric(10,4), CHECK > 0 | |
| `notes`, `created_by`, `created_at`, `updated_at` | | |

Índice `(requested_at desc, created_at desc)`.

### 5.9 Traslados

Migraciones `20261113020518_transfers.sql` y `20261113030450_transfer_variants.sql`.

**`transfer_points` (bodegas)**

| Columna | Tipo | Para qué |
|---|---|---|
| `id` | uuid PK | |
| `code` | text not null unique, CHECK `^[a-z0-9_]{2,40}$` | Se genera del nombre y país (`bodega_central_hn`). |
| `name` | text not null, CHECK largo 1–80 | |
| `country` | text not null, CHECK `^[A-Z]{2}$` | |
| `city` | text | |
| `goods` | text default `'both'`, CHECK in (`import`, `maquila`, `both`) | Qué recibe como destino. |
| `is_origin`, `is_destination` | boolean | |
| `accounts` | text[] default `{}` | Cuentas de los repartos de Laboratorios que abastece. |
| `active` | boolean default true | Se desactiva en vez de borrar. |
| `position` | integer default 0 | Orden. |

La migración siembra 7 bodegas iniciales (Guatemala, Honduras, El Salvador y Costa Rica; dos de ellas de maquila) — son datos del negocio, ver §10.

**`transfers`**

| Columna | Tipo | Para qué |
|---|---|---|
| `id` | uuid PK | |
| `code` | text not null unique | `TR-2026-001`. |
| `origin_id` | uuid → `transfer_points` | Bodega de origen. |
| `dest_country` | text, CHECK `^[A-Z]{2}$` | |
| `carrier` | text | Quién lo lleva. |
| `reference` | text | N.º de manifiesto o guía. |
| `status` | text default `'preparing'`, CHECK in (`preparing`, `transit`, `arrived`, `cancelled`) | |
| `shipped_at`, `eta` | date | |
| `notes`, `created_by`, `created_at`, `updated_at` | | |

Índice `(status, created_at desc)`.

**`transfer_items`**

| Columna | Tipo | Para qué |
|---|---|---|
| `id`, `transfer_id` (cascade) | | |
| `dest_id` | uuid → `transfer_points` | Bodega de destino de esta línea. |
| `kind` | text default `'import'`, CHECK in (`import`, `maquila`) | |
| `name` | text, CHECK largo 1–200 | |
| `sku`, `account_id` (→ `accounts`, set null), `product_external_id`, `image_url` | | Si salió del catálogo de Drop. |
| `variant` | text, CHECK largo 1–80 | "Negro / XL". |
| `variant_id` | text, CHECK largo 1–80 | Id de la variante en Drop. |
| `qty` | integer, CHECK > 0 | |
| `source` | text | Clave de reparto (Por enviar) o null. Índice parcial. |
| `received_qty` | integer, CHECK ≥ 0 | null = no llegó todavía. |
| `damaged_qty` | integer default 0 | CHECK `received_qty is null or damaged_qty <= received_qty`. |
| `received_note`, `position`, `created_at` | | |

**`transfer_arrivals`**: PK (`transfer_id`, `dest_id`); `arrived_at` date not null; `note`; `received_by`; `created_at`. Una llegada por bodega de destino (se corrige con upsert).

**`transfer_documents`**: `id`, `transfer_id` (cascade), `kind` CHECK in (`manifest`, `photo`, `other`) default `manifest`, `storage_path` unique (`<transferId>/<uuid>.<ext>`), `filename`, `content_type`, `size_bytes`, `uploaded_by`, `created_at`.

**`transfer_events`**: `id`, `transfer_id` (cascade), `note` not null, `by_user`, `at`. Sin tipos (a diferencia de importaciones).

**`transfer_settled`**: PK `source`; `note`; `by_user`; `at`. Repartos dados por enviados sin traslado.

### 5.10 Ciclos de vida (estados)

**Importación** (`lib/imports.ts:5-18`). El usuario puede elegir **cualquier** estado en cualquier momento (no hay transiciones prohibidas); solo hay dos pasos automáticos.

| Id | Etiqueta | Grupos |
|---|---|---|
| `quote` | Cotización | activa · seguida en paquetera |
| `paid` | Pagado / anticipo | activa · en camino (INBOUND) · seguida |
| `production` | En producción | activa · INBOUND · seguida |
| `ready` | Listo para enviar | activa · INBOUND · seguida |
| `transit` | En tránsito | activa · INBOUND · seguida · viajando |
| `customs` | En aduana | activa · INBOUND · seguida · viajando |
| `released` | Liberado | activa · INBOUND · seguida · viajando |
| `to_warehouse` | En camino a bodega | activa · INBOUND · seguida · viajando |
| `received` | Recibido | llegó (ARRIVED) · INBOUND |
| `in_drop` | Ingresado en Drop | llegó · IN_DROP |
| `closed` | Cerrado | llegó · IN_DROP |
| `cancelled` | Cancelada | — |

- *Activa* = ni llegó ni cancelada. *Seguida* (`TRACKED_STATUSES`) = se consulta la guía aunque diga Cotización. *INBOUND* = cuenta en Inventario como en camino. *Viajando* (`IN_MOTION`) = se avisa si pasa 7 días sin novedades.
- Automático 1: al guardar la recepción, si estaba activa y no era cotización → `received` (`app/(app)/imports/actions.ts:298-299`).
- Automático 2: en la sincronización, si estaba en INBOUND y todas las líneas entraron a Drop → `in_drop` (`lib/imports-data.ts:388-418`).
- Al pasar a `received` o `in_drop` sin `arrived_at`, se anota la fecha de hoy.

**Traslado** (`lib/transfers.ts:9-14`): `preparing` (Preparando) → `transit` (En camino) → `arrived` (Llegó); `cancelled` (Cancelado) desde preparando o en camino. Reabrir: si tenía fecha de salida vuelve a en camino/llegó según las llegadas; si no, a preparando. `arrived` se calcula solo cuando cada bodega de destino con productos tiene su llegada.

**Compra a laboratorio** (`lib/lab-purchases.ts:4-9`): `requested` (Solicitado) → `in_progress` (En proceso) → `transit` (En tránsito) → `arrived` (Llegó a bodega). Libre, sin restricciones de orden.

**Estado de la paquetera** (vocabulario de 17TRACK, `lib/tracking17.ts:10-20`): `NotFound` (Sin información todavía), `InfoReceived` (Guía creada), `InTransit`, `Expired` (Sin movimiento), `AvailableForPickup` (Lista para retirar), `OutForDelivery` (En reparto), `DeliveryFailure` (Entrega fallida), `Delivered` (Entregada), `Exception` (Con problemas). Requieren atención: `Exception`, `DeliveryFailure`, `Expired`. **El estado de la paquetera no cambia el estado de la importación**: solo se muestra.

### 5.11 Almacenamiento de archivos

| Bucket | Público | Límite | Tipos permitidos | Rutas |
|---|---|---|---|---|
| `import-files` | No | 26 214 400 bytes (25 MB) | PDF, JPEG, PNG, WEBP, XLSX | `<importId>/docs/<uuid>.<ext>` (documentos) y `<importId>/items/<uuid>.<ext>` (fotos de productos nuevos) |
| `transfer-files` | No | 25 MB | mismos | `<transferId>/<uuid>.<ext>` |

Cómo se protegen: los buckets son privados; nadie recibe una URL permanente. Ver §8.4.

### 5.12 Tablas de otras partes del sistema que usa el módulo

| Tabla | Qué usa Compras |
|---|---|
| `accounts` | `id`, `name`, `country`, `currency`, `enabled`, `catalog_only`, `platform`, `timezone`: qué cuentas de Drop hay por país. |
| `products` | `account_id`, `external_id`, `name`, `sku`, `code` (código público de Drop), `image_url`, `price`, `raw` (JSON original: `raw->>sku` y `raw.variants`). |
| `account_fx` | `account_id`, `currency`, `usd_rate` (USD por 1 unidad de moneda local) para pasar precios a USD y sugerir el tipo de cambio de quetzales. |
| `stock_movements` | `account_id`, `product_external_id`, `units`, `reason`, `occurred_at`: para detectar la entrada a Drop. |
| `restock_orders`, `product_lead_times` | Inventario: los pedidos de reposición se mezclan con las líneas de importación. |
| `store_requests`, `store_request_items` (`country_quantities`) | Solicitudes de tiendas: alimentan "Por enviar". |
| `app_users` | Nombres en historial; permisos. |
| `app_settings` (clave `integrations`) | Claves cifradas de paqueteras y de Anthropic. |

---

## 6. Reglas de negocio y cálculos

### 6.1 Códigos

- Importación: `IMP-<año>-<NNN>` con 3 dígitos, el siguiente del año (`lib/imports.ts:272-276`). Traslado: `TR-<año>-<NNN>` (`lib/transfers.ts:104-108`).
- El siguiente = máximo número existente con ese prefijo + 1. Si dos se crean a la vez y choca el índice único, se reintenta hasta 3 veces (`app/(app)/imports/actions.ts:113-123`, `app/(app)/imports/transfers/actions.ts:56-68`).
- El año sale de `new Date().getFullYear()` en el servidor (hora del servidor, no la local).

### 6.2 Validaciones de la importación

`headerFields` en `app/(app)/imports/actions.ts:64-103`:

- País destino: debe estar en la lista de países del sistema (`lib/countries.ts`, 15 países incluido Perú).
- Transporte: `courier`, `air`, `sea` o `land`.
- Fechas: formato `AAAA-MM-DD` válido (pedido, llegada estimada; en edición también la de llegada).
- Enlace de seguimiento: debe empezar con `http://` o `https://`.
- Peso ≥ 0. Proveedor: si se envía, debe existir.
- Largos máximos: n.º de orden 60 (espacios colapsados), origen 80, paquetera 60, guía 80, enlace 500, notas 2000.

Productos (`itemNumbers`, líneas 182-197): cantidad entera de 1 a 10 000 000; peso por unidad ≥ 0; con Dinero, costo por unidad ≥ 0 (vacío = 0) y precio de venta ≥ 0 o vacío. Sin Dinero esos dos campos no se leen ni se modifican.

- Producto del catálogo: la cuenta del producto debe ser del país destino.
- Producto de otro país: la cuenta **no** debe ser del país destino; se guarda como nuevo, y el SKU solo si es el SKU propio del producto (ver §6.9).
- Producto nuevo: nombre obligatorio (≤ 200), SKU ≤ 80, foto opcional (solo JPG, PNG, WEBP; se verifica en Storage y, si no sirve, se borra).

Estado (`setImportStatus`, líneas 145-162): nota ≤ 500; si el estado es el mismo y no hay nota → error "Ya está en ese estado".

Eliminar: hay que escribir `ELIMINAR`; si tiene costos, pagos o documentos con montos, solo puede alguien con Dinero (líneas 516-540). Se borran en cascada productos, costos, documentos, pagos y eventos, y luego los archivos.

### 6.3 Costo final por unidad (costo aterrizado)

`landedCosts` en `lib/imports.ts:206-254`. Todo en USD.

```
Para cada línea i:
  producto_i = qty_i × unit_cost_i
  envío_i = importación_i = adicional_i = 0

Para cada costo c (monto A > 0, tipo k, reparto r):
  si r = item y su producto ya no existe → se reparte por valor (y se avisa)
  base_i =
    r = value  → qty_i × unit_cost_i
    r = units  → qty_i
    r = weight → qty_i × unit_weight_kg_i
    r = item   → 1 si i es el producto elegido; 0 si no
  si ninguna base_i > 0 → base_i = qty_i  (se avisa: "Faltan pesos…" o "Sin precios cargados…")
  parte_i = A × base_i / Σ base
  k_i += parte_i            (k = envío, importación o adicional)

total_i   = producto_i + envío_i + importación_i + adicional_i
buenas_i  = contada ? max(0, recibidas_i − dañadas_i) : qty_i
divisor_i = buenas_i > 0 ? buenas_i : (qty_i > 0 ? qty_i : 1)
costo_unitario_i = total_i / divisor_i
desglose por unidad = cada componente / divisor_i
```

Puntos clave:

- **Los costos se reparten sobre lo pedido** (se pagó y se envió todo), pero el **costo por unidad se calcula sobre las unidades buenas**: lo que faltó o llegó dañado lo pagan las que sí se pueden vender (comentario en líneas 240-241).
- Si una línea no tiene ninguna unidad buena, se avisa ("su costo es pérdida") y se muestra sobre lo pedido.
- Nada se pierde ni se duplica: Σ total_i = Σ producto + Σ costos.
- No hay redondeo en el cálculo; se redondea a 2 decimales solo al mostrar y en el Excel.

Ejemplo (de `lib/imports.test.ts`): A = 100 u. × 2 USD, 0,5 kg; B = 50 u. × 12 USD, 0,2 kg. Costos: importación 80 por valor (A 20, B 60), envío 120 por peso (A 100, B 20), adicional 30 por unidades (A 20, B 10), adicional 25 a B. Costo unitario A = (200+20+100+20)/100 = **3,40**; B = (600+60+20+35)/50 = **14,30**.

Por defecto, en el formulario manual un costo nuevo es Envío + Por unidades; en el servidor, si no llega el reparto, es "Por valor". Los cargos leídos con IA van: envío → por unidades; el resto → por valor (`lib/invoice.ts:43`).

### 6.4 Margen, ganancia y recuperación

`lib/imports.ts:257-269`:

- `LOW_MARGIN = 0.2` (20 %).
- Margen por unidad = precio de venta − costo unitario; % = margen / precio; total = margen × unidades buenas; **margen bajo** si % < 20 %. (También calcula `breakEven = ⌈costo × unidades / precio⌉`, pero la UI no lo muestra.)
- Precio de venta de cada línea (`salePrices`, `lib/imports-data.ts:307-324`): el escrito a mano (`sale_price_usd`); si no hay y la línea está enlazada, el `price` del producto en Drop pasado a USD con `account_fx.usd_rate` (si la cuenta no está en USD y no hay tasa, queda sin precio).
- Ganancia esperada = Σ margen total de las líneas; solo se muestra si **todas** las líneas tienen precio > 0.
- Recuperación = costo total ÷ ingreso esperado (Σ precio × unidades buenas): "Recuperas lo invertido al vender el X % de las unidades" (se muestra con tope 999 %).
- Costo promedio = costo total ÷ unidades buenas totales.
- "Falta pagar" = costo total − pagado, si es mayor a 0,005.

### 6.5 Monedas y conversiones

- Importaciones: **todo en USD** (costos del proveedor, costos, pagos, precios). No hay columna de moneda.
- Lectura con IA: si la factura no está en USD, el usuario escribe "1 USD = X <moneda>". Precio unitario USD = (precio unitario, o total ÷ cantidad) ÷ X, **redondeado a 4 decimales** (`lib/invoice.ts:36-40`). Cargos USD = monto ÷ X, **redondeado a 2 decimales**. Las cantidades se redondean a entero.
- Precio de Drop a USD: `monto × usd_rate` (`lib/wallet.ts:78-81`).
- Laboratorios: en quetzales. Monto Q = **redondeo a 2 decimales** de (precio unitario × cantidad solicitada) — la cortesía no se cobra; monto USD = redondeo a 2 decimales de (monto Q ÷ tipo de cambio) (`lib/lab-purchases.ts:55-62`).
- Tipo de cambio sugerido para laboratorios: el de la cuenta de Guatemala, `round2(1 / usd_rate)` de la primera fila de `account_fx` en GTQ; si no hay, **7,75** (`lib/lab-purchases-data.ts:40-44`).

### 6.6 Recepción

`saveReception` (`app/(app)/imports/actions.ts:261-302`) y `receptionSummary` (`lib/imports.ts:308-323`):

- Campos por línea: `recv_<id>`, `dmg_<id>`, `note_<id>` (nota ≤ 300). Vacío = sin contar.
- Enteros de 0 a 1 000 000; no se pueden anotar dañadas sin recibidas; dañadas ≤ recibidas; al menos una línea contada.
- Resumen: pedidas, recibidas, dañadas, faltan = Σ max(0, pedidas − recibidas), sobran = Σ max(0, recibidas − pedidas), buenas (con la regla de §6.3), completa si todas las líneas están contadas.
- Se registra en el historial "Recepción: X de Y u. · faltan … · sobran … · N dañadas · N sin contar".

### 6.7 Alertas

| Alerta | Regla | Archivo |
|---|---|---|
| **Atrasada** | Activa, no cotización, con `eta` < hoy. *(En la fila de la lista y en el detalle se usa una versión que sí incluye cotizaciones; ver §13.)* | `lib/imports.ts:38-39` |
| **Sin novedades** | Estado viajando (en tránsito, aduana, liberado, en camino a bodega) y la última novedad tiene ≥ 7 días: `días = ⌊(hoy 23:59:59 UTC − última) / 1 día⌋`. `STALE_DAYS = 7`. | `lib/imports.ts:35, 42-46` |
| **Avisar a la bodega** | No reportada, activa, con `eta`, y `eta − hoy ≤ 3 días` (incluye vencidas). | `lib/imports.ts:279-283` |
| **Checklist** | Factura comercial = hay documento `invoice`. Tracking = hay número de guía o documento `tracking`. | `lib/imports.ts:121-127` |
| **Problema en la paquetera** | `track_status` en Exception, DeliveryFailure o Expired. | `lib/tracking17.ts:23` |
| **Traslado vencido** | En camino con `eta` < hoy. | `lib/transfers.ts:212` |

Mensaje para la bodega (`whatsappMessage`, `lib/imports.ts:286-303`): saludo con el país, código y proveedor en negrita, "Guía: <paquetera> <número>", enlace de seguimiento, llegada estimada en formato DD/MM/AAAA, lista de productos "• <cantidad> × <nombre> (SKU …)" con el total de unidades, y pedido de confirmar cuántas llegaron. Se abre con `https://wa.me/?text=<mensaje>` (sin número fijo).

### 6.8 Enlace de seguimiento público

`trackingUrl` (`lib/imports.ts:57-73`): si hay enlace manual que empieza con http(s), ese; si no, con número de guía, la página pública de la paquetera según su nombre (DHL, FedEx, UPS, USPS, Aramex — comparación exacta sin mayúsculas); cualquier otra, `https://t.17track.net/es#nums=<número>`.

### 6.9 Cómo se enlazan los productos

- **Coincidencia de un producto nuevo** (`matchNewProduct`, `lib/imports.ts:405-415`):
  1. Si la línea tiene SKU: se buscan productos del catálogo cuyo `sku` o `code` (sin mayúsculas, sin espacios al borde) sea igual. Si hay exactamente uno → ese. Si hay varios → ninguno (no se intenta por nombre). Si no hay → se pasa al nombre.
  2. Por nombre normalizado (sin tildes, minúsculas, todo lo que no es letra o número → espacio): debe tener **al menos 6 caracteres** y coincidir con **exactamente un** producto.
- **SKU propio** (`isOwnSku`, `lib/imports-data.ts:249-250`): el SKU guardado es del producto solo si coincide con `raw->>sku` que manda Drop; si no, es el de su primera variante ("talla-1"), que se repite entre productos y no sirve para reconocer ni enlazar.
- **Productos de otros países** (`foreignOnly`, `lib/imports.ts:423-443`): los del catálogo de otros países que no están en el del destino ni por SKU propio/código ni por nombre (≥ 6 caracteres); uno por SKU (o por nombre), con la lista de otras cuentas donde también está.
- **Enlace automático** (`linkNewProducts`, `lib/imports-data.ts:424-457`): en cada sincronización del catálogo de una cuenta, para importaciones al país de esa cuenta en cotización o INBOUND, las líneas sin enlazar se comparan con el catálogo de la cuenta (paginado de a 1000, hasta 20 000). Si coincide, se guarda `account_id`, `product_external_id` y la foto de Drop (si no tenía foto propia), y se registra en el historial (tipo `activity`).
- **Enlace manual** (`linkImportItem`): el producto debe ser del país destino.
- La lectura con IA sugiere el producto con la misma regla de coincidencia, contra el catálogo del país destino.

### 6.10 "En camino" en Inventario y detección de la llegada a Drop

- `importOrders` (`lib/imports.ts:343-367`): cada línea **enlazada** de una importación en INBOUND (pagada hasta recibida) o IN_DROP se convierte en un "pedido de reposición" con:
  - unidades = unidades buenas;
  - fecha del pedido = `ordered_at` (o `created_at`); las fechas sin hora se toman a mediodía UTC para que no caigan el día anterior en Centroamérica;
  - `eta` de la importación;
  - `min_units = ⌈unidades × 0,5⌉` (`DROP_MATCH_SHARE = 0.5`);
  - `declared_at`: si ya está en IN_DROP, `arrived_at ?? updated_at ?? ordered_at ?? created_at`.
- Inventario carga las importaciones en INBOUND y las IN_DROP de los últimos 180 días (`lib/inventory-data.ts:63-88`).
- `trackOrders` (`lib/inventory.ts:201-222`): las **entradas de mercadería** de Drop (movimientos con razón `STOCK_REQUEST`, `INITIAL_STOCK` o `MANUAL` y unidades > 0, `lib/inventory-data.ts:91-115`) se recorren de la más vieja a la más nueva; cada pedido (del más viejo al más nuevo) toma la primera entrada no usada que sea **posterior a la fecha del pedido**, de **al menos `min_units`** y, si ya se declaró ingresada, no más de **10 días después** de `declared_at`. Cada entrada cierra un solo pedido. Si no hay entrada pero está declarada → "llegó" en `declared_at` (se muestra "marcada a mano"). Si no, "en camino" o "atrasada" si `eta` < hoy.
- `dropState` / `allInDrop` (`lib/imports.ts:376-398`): la importación está completa en Drop cuando **todas** sus líneas están enlazadas, "en Drop" y la entrada se **vio** de verdad en los movimientos (no solo declarada).
- `advanceImports` (`lib/imports-data.ts:388-418`): en la sincronización de cada cuenta, las importaciones en INBOUND completas en Drop pasan a `in_drop` (con `arrived_at` = el existente o la fecha de la última entrada) y se registra "Drop registró la entrada de N u." (usuario nulo). La actualización filtra otra vez por estado INBOUND para no pisar cambios concurrentes.
- `productsToWatch` (`lib/imports-data.ts:370-382`): productos de importaciones INBOUND que están en aduana, liberadas, en camino a bodega o recibidas, **o** con `eta` dentro de 5 días; sus movimientos de stock se revisan primero en la sincronización.

### 6.11 "Dónde va" el envío

`lib/track-place.ts`:

1. **Leer el lugar** (`parsePlace`, línea 44): se separa por comas; el país se busca de derecha a izquierda (nombre en inglés o español, o código ISO conocido). Si la primera parte tiene " - " (estilo DHL "SHENZHEN - CHINA MAINLAND"), la ciudad es lo de antes del guion (sin "HUB") y el país lo de después. La ciudad se muestra en Tipo Título.
2. **Países de origen** (`originCountries`, línea 63): el país de la primera parte de `imports.origin`; si es China, también cuenta Hong Kong.
3. **Fase** (`trackPlace`, línea 74), en este orden:
   - estado `Delivered` → "Entregado";
   - sin estado ni lugar → nada;
   - país = país destino → "En <país> (destino)";
   - país ∈ países de origen → "En <país> (origen)";
   - sin país y estado `InfoReceived` → "Por recoger en origen";
   - si no → "En tránsito · <país>" o "En tránsito".
4. Solo se muestra si lo guardado corresponde a la guía actual (`track_registered = tracking_number`) y la importación está activa.

Tabla de países reconocidos: `lib/track-place.ts:12-28` (incluye PERU → PE).

### 6.12 Seguimiento automático

`lib/imports-tracking.ts`:

- **Qué se consulta**: importaciones con número de guía en `TRACKED_STATUSES` (cotización hasta en camino a bodega) cuya última consulta tenga más de **3 horas** (`EVERY_MS`), de la más atrasada en consultarse a la más reciente.
- **Con quién** (`trackingProvider`, `lib/carrier-tracking.ts:47-51`): si el nombre de la paquetera es DHL (`\bdhl\b`), FedEx (`\bfed\s?ex\b`) o UPS (`\bups\b`) y hay clave de esa paquetera → su API oficial; si no → 17TRACK, si hay clave; si no → nada.
- **Tope por vuelta**: DHL 6, FedEx 20, UPS 20, 17TRACK 40 (`PER_RUN_OF`). Con DHL se espera 5,5 s entre consultas.
- **Guía nueva o cambiada**: se borran los `track_*` anteriores. En 17TRACK se registra primero (`register`); "ya registrada" cuenta como éxito; si falla, se guarda el error.
- **Qué se guarda** (`save`, líneas 29-45): estado, subestado, última novedad ("texto · lugar"), hora, lugar, llegada estimada, hora de consulta; error en null.
- **Novedades al historial** (`newEvents`, `lib/tracking17.ts:103-106`): la primera vez solo la última; después, las posteriores a la última guardada, hasta 10, en orden cronológico. Nota: "<paquetera>: <texto> (<lugar>)", tipo `tracking`, `at` = hora del evento.
- **Errores**: guía no encontrada → `track_error` con mensaje y se sigue; clave inválida o límite → error del servicio, se marca en las importaciones pendientes de esa vuelta y los otros servicios siguen.
- **"Actualizar ahora"**: misma función, solo esa importación y sin esperar las 3 horas.
- La llegada estimada de la paquetera se muestra junto a la escrita a mano, **no la reemplaza**.

### 6.13 Documentos y archivos

`lib/imports.ts:96-163`:

- Tipos: Proforma invoice, Factura comercial, Comprobante de pago, Guía (AWB/BL), Packing list, Aduana (DUA/póliza), Foto, Otro.
- **`MONEY_DOCS`** = proforma, factura, comprobante: subirlos, borrarlos o leerlos con IA requiere Dinero; sus eventos van como `money`.
- **`PRIVATE_DOCS`** = proforma, comprobante: además, **verlos** requiere Dinero. La factura comercial la ve todo Compras.
- Archivos: PDF, JPG, PNG, WEBP, XLSX; máximo **25 MB**; las fotos (de productos nuevos y de recepción) solo JPG/PNG/WEBP. Si el navegador no informa el tipo, se deduce de la extensión.
- La IA lee solo PDF, JPG, PNG, WEBP de hasta **20 MB**, y no los de tipo Foto.
- Traslados: tipos `manifest`, `photo`, `other`, mismos formatos y tamaño.

### 6.14 Laboratorios

`cleanLabPurchase` (`lib/lab-purchases.ts:87-158`):

- Producto obligatorio (≤ 160); laboratorio ≤ 120; notas ≤ 2000.
- Cantidades enteras (se acepta "1,500"); máximo 10 000 000; solicitada > 0; cortesía ≥ 0; cajas opcional.
- Reparto: 8 cuentas fijas (`LAB_DESTINATIONS`: Miranova GT, Miranova HN, Mireva HN, Miranova SV, Miranova CR, Mireva CR, Dropi GT, Dropi CR); **lo repartido no puede superar solicitada + cortesía**. Lo que falta repartir se muestra.
- Fechas: solicitud vacía = hoy; no puede ser futura; traslado ≥ solicitud; llegada ≥ traslado (o ≥ solicitud). Si el estado es "Llegó a bodega" sin fecha, se toma hoy (o la de solicitud si fuera posterior).
- Con Dinero: precio unitario (acepta prefijo "Q" y comas) y tipo de cambio > 0. Sin Dinero no se leen y, al editar, **no se tocan** los guardados.

### 6.15 Traslados

`lib/transfers.ts` y `app/(app)/imports/transfers/actions.ts`:

- **Cabecera** (`cleanHeader`, línea 390): el origen debe ser una bodega marcada como origen; el país destino debe tener al menos una bodega de destino activa distinta del origen (así se permiten traslados dentro de un mismo país); fechas válidas; llegada estimada ≥ salida. Transportista ≤ 60, referencia ≤ 80, notas ≤ 2000.
- **Crear**: la fecha de salida no puede ser futura; con fecha → `transit`, sin fecha → `preparing`.
- **Editar**: no se puede cambiar el país si ya tiene productos; ningún producto puede ir a la bodega de origen; si ya salió, la fecha de salida es obligatoria; si estaba preparando y se pone fecha de salida, pasa a en camino.
- **Enviar**: solo desde preparando; al menos un producto; salida obligatoria y no futura; llegada ≥ salida.
- **Líneas** (`cleanLine`, línea 463): clase `import`/`maquila`; nombre ≤ 200; bodega de destino activa del país y distinta del origen; cantidad entera de 1 a 1 000 000. Solo se pueden agregar, editar o quitar si el traslado no está cancelado ni llegó y esa bodega no registró llegada.
- **Variantes** (`productVariants`, `variantGrid`): de `products.raw.variants` (sin las borradas o inactivas). Si todas tienen los mismos dos atributos, se arma una cuadrícula (la talla en columnas, en orden XXS…5XL o numérico). Una línea por variante con cantidad; el SKU es el de la variante (o el del producto).
- **Llegada** (`registerArrival`, línea 263; `cleanArrival`, línea 218): solo en camino o ya llegado (para corregir); fecha obligatoria, no futura, ≥ salida; recibidas obligatorias por línea (0 permitido), dañadas ≤ recibidas, nota ≤ 300 por línea y ≤ 500 general. Tras guardar se recalcula el estado (`statusAfterArrivals`).
- **Totales** (`totals`, línea 167): enviadas, recibidas, dañadas, **merma = Σ max(0, enviadas − recibidas)** de lo contado, buenas = recibidas − dañadas.
- **Cancelar**: no si ya llegó. **Eliminar**: escribir ELIMINAR y sin llegadas.
- **Origen sugerido** (`defaultOrigin`, línea 149): entre los orígenes activos de Guatemala (`HUB_COUNTRY = "GT"`), para importados el primero que no sea solo de maquila; para maquilados el de maquila, salvo hacia El Salvador (`CONSOLIDATED_COUNTRIES = ["SV"]`), donde todo sale del primero. **Destino sugerido**: la primera bodega del país que recibe esa clase.
- **Bodegas** (`cleanPoint`, `pointCode`): nombre ≤ 80, país ISO, ciudad ≤ 60, origen y/o destino (al menos uno), cuentas solo de la lista de Laboratorios; código `<nombre normalizado>_<país>` (con `_2`, `_3` si se repite); posición = máxima + 10.
- **Cuadro de rutas** (`routeSummary`, línea 250): por (origen, bodega destino), sin cancelados: preparando (traslados, unidades), en camino sin llegada a esa bodega (traslados, unidades, próxima llegada, vencidos) y llegados en los **últimos 30 días** (enviadas, recibidas, dañadas, merma).

### 6.16 "Por enviar"

`pendingToSend` (`lib/transfers.ts:325-373`):

- **De Solicitudes**: solo las abiertas (estado `pending` o `in_progress`). Por producto (normalizado; si se repite en la misma solicitud, se suma) y por país: las cantidades de `country_quantities`; si no hay reparto y la solicitud tiene un solo país, va toda a ese país. Clase "importado"; la bodega se elige al armar. Clave `req:<solicitud>:<producto>:<país>`.
- **De Laboratorios**: cada cuenta del reparto con unidades > 0 se asigna a la bodega de destino activa cuya lista de cuentas la incluye. Clase "maquilado"; bodega fija. Clave `lab:<compra>:<cuenta>`. Se incluyen compras en **cualquier** estado.
- **Se excluye** lo de Guatemala (el país central ya tiene la mercadería) y lo "dado por enviado".
- **Pendiente** = repartido − enviado, donde enviado = Σ cantidades de líneas con esa clave en traslados no cancelados (`sentBySource`). Solo filas con pendiente > 0.
- **Armar traslado** (`buildTransfer`, línea 371): las filas elegidas deben seguir pendientes; cantidad ≤ pendiente; crea el traslado en preparando y sus líneas (sin enlace al catálogo); si fallan las líneas, borra el traslado.
- **Dar por enviado** (`settlePending`, línea 406): la clave debe tener la forma `^(req|lab):[^\s]{1,300}$`.

### 6.17 Reportes y estadísticas

`lib/import-reports.ts` (todo en USD; **no cuentan cotizaciones ni canceladas** como compras):

- **Proveedor** (`supplierStats`, línea 50): importaciones (todas), compradas, última (fecha del pedido de cualquiera), unidades y monto comprado (costo total aterrizado de las compradas), **tarda** = promedio de días entre pedido (o creación) y llegada de las que llegaron (solo diferencias ≥ 0), **a tiempo** = % de las que llegaron con `arrived_at ≤ eta` (entre las que tenían eta), **faltantes y dañadas** = (Σ max(0, pedidas − recibidas) + Σ dañadas) ÷ Σ pedidas en líneas contadas; top 5 productos por unidades.
- **Dinero en camino** (`moneyInTransit`, línea 82): importaciones activas no cotización: costo total, unidades, pagado, falta pagar, por país.
- **Por mes** (`monthlySpend`, línea 112): comprado = costo total de las importaciones según el **mes del pedido**; pagado = pagos según el **mes del pago** (sin pagos de canceladas). Últimos 12 meses.
- **Costo por unidad** (`unitCostHistory`, línea 138): por producto (mismo producto de Drop, o mismo nombre normalizado si es nuevo), un punto por importación comprada con unidades buenas > 0; cambio = último ÷ anterior − 1.

### 6.18 Fechas, zonas horarias y redondeos

- "Hoy" se calcula con `todayIn()` en `America/Tegucigalpa` por defecto (`lib/format.ts:1, 77`); la sincronización usa la zona de cada cuenta.
- Fechas sin hora se manejan como `AAAA-MM-DD`; para mostrar se fijan a mediodía UTC (para que no cambie el día).
- Las horas del historial se muestran en `America/Tegucigalpa` con formato `es-HN`.
- Redondeos: costo unitario de factura IA 4 decimales; cargos IA 2 decimales; montos de laboratorio 2 decimales; tipo de cambio sugerido 2 decimales; Excel 2 decimales (margen % a 1 decimal). El costo aterrizado no se redondea internamente.

---

## 7. Integraciones

### 7.1 Paqueteras

Las claves se leen con `integrationKey(name)` (`lib/integrations.ts:45-48`): primero la guardada en el panel (tabla `app_settings`, clave `integrations`, **cifrada con `ENCRYPTION_KEY`**), si no, la variable de entorno. Solo el dueño las cambia en Ajustes → Integraciones, donde además hay un botón para probar una guía.

| Servicio | Nombre interno → variable de entorno | Endpoint | Autenticación | Límites y notas |
|---|---|---|---|---|
| **DHL** (Shipment Tracking – Unified) | `dhl` → `DHL_API_KEY` | `GET https://api-eu.dhl.com/track/shipments?trackingNumber=<n>&language=es` | Encabezado `DHL-API-Key` | Plan gratis: 250 consultas/día y una cada 5 s (el código espera 5,5 s; máx. 6 por vuelta). 404 = sin información; 429 = límite. |
| **FedEx** (Track API) | `fedex_id` → `FEDEX_API_KEY`, `fedex_secret` → `FEDEX_SECRET_KEY` | `POST https://apis.fedex.com/oauth/token` (client_credentials) y `POST https://apis.fedex.com/track/v1/trackingnumbers` con `includeDetailedScans: true` | OAuth → `Authorization: Bearer` (un token por vuelta) | Máx. 20 por vuelta. |
| **UPS** (Tracking API) | `ups_id` → `UPS_CLIENT_ID`, `ups_secret` → `UPS_CLIENT_SECRET` | `POST https://onlinetools.ups.com/security/v1/oauth/token` (Basic id:secret) y `GET https://onlinetools.ups.com/api/track/v1/details/<n>?locale=es_US&returnSignature=false&returnMilestones=false&returnPOD=false` | OAuth → Bearer; encabezados `transId` (uuid) y `transactionSrc` | Máx. 20 por vuelta. Fechas GMT si vienen; si no, la local como UTC. |
| **17TRACK** (API v2.2) | `track17` → `TRACK17_API_KEY` | `POST https://api.17track.net/track/v2.2/register` y `.../gettrackinfo` con `[{"number": …}]` | Encabezado `17token` | Lotes de 40; `code ≠ 0` = error. Cualquier paquetera. |

Todas las llamadas tienen timeout de 20 s y `cache: no-store`. Los números de guía se limpian (sin espacios ni guiones, en mayúsculas) para DHL, FedEx y UPS. Con `MIRANOVA_FIXTURES=1` cada cliente responde un ejemplo fijo sin salir a internet (útil para pruebas: guías que terminan en `0000` = entregadas; que empiezan con `BAD` = no existen).

**Traducción de estados al vocabulario de 17TRACK** (para que el resto del sistema sea igual con cualquier fuente):

| Fuente | Regla |
|---|---|
| DHL (`lib/tracking-dhl.ts:20-35`) | `delivered` → Delivered; `failure` → DeliveryFailure si el texto habla de entrega, si no Exception; `pre-transit` → InfoReceived; `transit` → OutForDelivery / AvailableForPickup según el texto, si no InTransit; otro → NotFound. Sin ETA si está entregada. |
| FedEx (`lib/tracking-fedex.ts:14-39`) | DL → Delivered; OD → OutForDelivery; HL, HP → AvailableForPickup; DE → DeliveryFailure; SE, CA, RS, CD, DY → Exception; OC, IN → InfoReceived; vacío → NotFound; otro → AvailableForPickup si el texto lo dice, si no InTransit. |
| UPS (`lib/tracking-ups.ts:16-36`) | D → Delivered; O → OutForDelivery; X → DeliveryFailure/Exception según texto; RS → Exception; M, MV → InfoReceived; vacío → NotFound; otro → OutForDelivery / AvailableForPickup según texto, si no InTransit. ETA: fechas tipo RDD, SDD o EDD. |
| 17TRACK (`lib/tracking17.ts:49-71`) | Se usa `latest_status.status` tal cual; eventos de todos los `providers`; ETA de `time_metrics.estimated_delivery_date` (`to` o `from`). |

### 7.2 Lectura de documentos con IA

- **Proveedor y modelo**: Anthropic, SDK `@anthropic-ai/sdk`, el modelo configurado en `lib/invoice-ai.ts:10`, `max_tokens` 16 000, esfuerzo `medium`, salida estructurada validada con un esquema **zod** (`betaZodOutputFormat`), beta `server-side-fallback-2026-07-01` con `fallbacks: "default"` (si el modelo declina, la API reintenta con otro), timeout 120 s, 2 reintentos. Clave: `anthropic` → `ANTHROPIC_API_KEY` (en el panel debe empezar con `sk-ant-`).
- **Entrada**: el archivo del bucket en base64, como `document` (PDF) o `image` (JPG/PNG/WEBP).
- **Instrucciones** (`SYSTEM`, líneas 37-42): leer facturas, proformas y packing lists; una línea por producto con unidades totales (si viene por cajas, cajas × unidades por caja) y precio por unidad en la moneda de la factura; los cargos que no son productos (flete, envío, seguro, aranceles, comisión bancaria, embalaje) van aparte; traducir al español sin inventar; usar null si un dato no aparece.
- **Qué extrae** (esquema, líneas 12-35): proveedor, n.º y fecha de factura, moneda ISO 4217, líneas (descripción, SKU, cantidad, precio unitario, total de línea), cargos (nombre, tipo shipping/import/other, monto), total, notas.
- **Validación y control**:
  - Respuesta con `stop_reason` "refusal" o "max_tokens", o sin salida válida → mensaje de error; errores de clave, límite, solicitud inválida o de conexión → mensajes claros.
  - **No guarda nada**: devuelve una propuesta. Se quitan líneas sin descripción o con cantidad ≤ 0, y se sugiere el producto de Drop del país destino (§6.9).
  - Sin Dinero, la propuesta llega **sin precios ni cargos** (se borran en el servidor).
  - El usuario revisa en pantalla (tipo de cambio, cantidades, precios, si enlaza o no, qué incluye) y confirma. `addInvoiceLines` vuelve a validar: máximo 200 líneas y 20 cargos, cantidades enteras > 0 y ≤ 1 000 000, costos ≥ 0, el enlace solo si la cuenta es del país destino (y se toman nombre, SKU y foto de Drop), cargos con monto > 0. Avisa si la importación ya tenía productos (se agregan aparte).
  - Se registra en el historial "Factura leída con IA (<archivo>): N productos y M costos".

### 7.3 Conexión con la plataforma de ventas (Drop)

El módulo **no** escribe en Drop. Lee lo que la sincronización general ya guardó:

- **Catálogo** (`products`): para elegir productos, sugerir con IA, enlazar productos nuevos y tomar el precio de venta.
- **Movimientos de stock** (`stock_movements`): para detectar la entrada a Drop y avanzar la importación.
- **Tasas** (`account_fx`): para convertir precios a USD y sugerir el tipo de cambio de quetzales.
- **Inventario**: las líneas de importación pagadas aparecen como pedidos "en camino" en Productos → Inventario (con enlace "Ver importación"), cuentan para el plan de reposición y para medir cuánto tarda en llegar un producto.

### 7.4 Otras

- **WhatsApp**: solo enlaces `wa.me` (mensaje prellenado para la bodega; WhatsApp del proveedor). No hay API.
- **Correo**: el resumen diario se envía con el sistema de correo general del panel (destinatarios de Ajustes → Correo o `RESTOCK_DIGEST_TO`).
- **Excel**: generado en el servidor con `lib/xlsx.ts`.
- `lib/boxful-document*.ts` **no** se usa en Compras (es de Conciliación bancaria).

---

## 8. Permisos y seguridad

### 8.1 Permisos

Definidos en `lib/permissions.ts:11-15`. El dueño (`is_owner`) puede todo. `imports` y `imports_view` son excluyentes (si se marca el completo, se quita "solo ver"). "Dinero" se suma a cualquiera de los dos.

| Acción | Compras (`imports`) | Compras solo ver (`imports_view`) | Requiere además |
|---|---|---|---|
| Ver lista y detalle de importaciones, traslados y sus documentos | Sí | Sí | — |
| Crear/editar importación, productos, estado, recepción, aviso a bodega, enlazar, actualizar seguimiento | Sí | No | — |
| Ver costos, precios, márgenes, pagos, "en camino" en USD, eventos de dinero | Con Dinero | Con Dinero (solo lectura) | `money` |
| Agregar/quitar costos y pagos | Con Dinero | No | `money` |
| Subir, borrar o leer con IA factura, proforma, comprobante | Con Dinero | No | `money` |
| Ver/descargar factura comercial | Sí | Sí | — |
| Ver/descargar proforma y comprobante | Con Dinero | Con Dinero | `money` |
| Leer con IA otros documentos (guía, packing, aduana, otro) | Sí | No | — |
| Eliminar importación | Sí (con costos, pagos o documentos con montos: solo con Dinero) | No | — |
| Excel de una importación | Sí | Sí | montos con `money` |
| Laboratorios (ver y editar) | Sí | No | precio y tipo de cambio con `money` |
| Excel de laboratorios | Con Exportar | No | `export` |
| Proveedores | Sí | No | "Comprado" con `money` |
| Reportes | Con Dinero | No | `money` |
| Traslados: crear, editar, enviar, llegada, documentos, armar desde Por enviar, dar por enviado | Sí | No | — |
| Ver "Repartos por enviar" | Sí | No | — |
| Bodegas | Sí | No | — |
| Claves de integraciones | Solo el dueño | | |

"Compras (solo ver)" está pensado para el personal de la bodega (ver importaciones y traslados con sus documentos, incluida la factura comercial para la aduana, sin montos salvo que tenga Dinero).

### 8.2 Validaciones en el servidor

- **Cada** página, acción del servidor y ruta de API verifica permisos por su cuenta (`lib/auth.ts`): `requirePermission` / `requireAnyPermission` en páginas, `authorizeAction` en acciones, `authorizeRoute` (todos los permisos) / `authorizeRouteAny` (alguno) en APIs. El layout no protege por sí solo.
- Todos los ids se validan con expresión regular de UUID antes de consultar.
- Los montos y cantidades se vuelven a validar en el servidor aunque el formulario ya lo haga; sin Dinero, los campos de dinero **se ignoran** (no basta con ocultarlos).
- Archivos: el servidor decide la ruta (`<id>/<carpeta>/<uuid>.<ext>`), verifica con expresión regular que la ruta registrada pertenezca a esa importación/traslado, y toma tipo y tamaño **reales** de Storage; si no cumplen, borra el archivo.
- Un comprobante adjunto a un pago debe ser de la misma importación; un costo "a un producto" debe apuntar a una línea de la misma importación.

### 8.3 Base de datos

- RLS activado en todas las tablas, **sin políticas**: con la clave pública no se puede leer ni escribir nada. El backend usa `SUPABASE_SERVICE_ROLE_KEY` (o `SUPABASE_SECRET_KEY`) con `SUPABASE_URL` (`lib/supabase.ts`), solo en el servidor (`server-only`).

### 8.4 Archivos

- Buckets privados con límite de tamaño y tipos permitidos.
- **Subida**: el navegador pide permiso a una acción del servidor (`startImportUpload` / `startTransferUpload`), que valida permiso, tipo de documento (los de Dinero solo con Dinero) y archivo, y devuelve un **enlace firmado de subida** a una ruta generada por el servidor; el navegador sube directo a Storage (`PUT`, sin sobrescribir); luego otra acción registra el documento.
- **Lectura**: siempre por una ruta de API que revisa el permiso (y `PRIVATE_DOCS`) y responde **302** a un enlace firmado de 10 minutos (fotos de productos: 1 hora), con `Cache-Control: private, no-store` y `Referrer-Policy: no-referrer`. Con `?dl=1` se descarga con el nombre original saneado.

### 8.5 Claves

- Claves de paqueteras y de IA cifradas en la base con `ENCRYPTION_KEY` (que vive solo en el entorno de Vercel); la pantalla de Ajustes solo muestra de dónde viene la clave y sus últimos 4 caracteres.
- Las tareas programadas se autentican con `Authorization: Bearer <CRON_SECRET>`.

---

## 9. Tareas automáticas

Definidas en `vercel.json`:

| Tarea | Cuándo | Qué hace para Compras |
|---|---|---|
| `GET /api/cron/sync` | Cada 10 minutos (`*/10 * * * *`), máximo 300 s de ejecución, presupuesto de 240 s para todas las cuentas (`lib/sync.ts:29`) | Por cada cuenta activa: (1) sincroniza el catálogo de productos y luego **`linkNewProducts`** (enlaza productos nuevos de importaciones a ese país); (2) sincroniza movimientos de stock — 20 productos por vez, de esos primero hasta 5 de **`productsToWatch`** que no se revisaron en los últimos 30 minutos (`lib/sync.ts:31-33, 629`) — y luego **`advanceImports`** (pasa a "Ingresado en Drop"). Al final, si queda tiempo, **`refreshTracking`** (cada importación cada 3 h, con los topes por servicio). |
| `GET /api/cron/restock-digest` | Diario a las 12:45 UTC (`45 12 * * *`; 6:45 a. m. en Centroamérica) | Arma y envía el correo "Qué pedir hoy", que incluye las secciones de importaciones: atrasadas, que llegan esta semana (0–7 días), sin avisar a la bodega y que viajan sin novedades 7+ días (`lib/restock-digest.ts:60-106`, `importsDigest` en `lib/imports.ts:454-463`). Solo considera activas que no son cotización. Si no hay nada, no se envía. |

No hay tareas para laboratorios ni para traslados (todo es manual). No hay limpieza de archivos huérfanos en Storage.

---

## 10. Qué es específico de Miranova y qué adaptar para Perú

### 10.1 Específico del negocio actual (está fijo en el código)

| Qué | Dónde | Para Perú |
|---|---|---|
| Plataforma de ventas **Drop** (catálogo, variantes en `raw.variants`, SKU en `raw->>sku`, código público `code`, razones de movimiento `STOCK_REQUEST`/`INITIAL_STOCK`/`MANUAL`) | `lib/imports-data.ts`, `lib/inventory-data.ts`, `lib/transfers.ts` | Reemplazar por la plataforma que use (catálogo, stock, movimientos). Si no da movimientos de stock con razón, la detección automática de "Ingresado" no se puede replicar: dejarlo manual o basarlo en la recepción. |
| Estado "Ingresado en Drop" y textos "Drop" | `lib/imports.ts:15`, varias pantallas | Renombrar ("Ingresado al inventario"). |
| Operador logístico **Boxful** (aviso a la bodega, "Boxful · país", permiso solo ver pensado para ellos) | `app/(app)/imports/[id]/page.tsx:218`, `lib/permissions.ts:12` | Su bodega/operador en Perú; ajustar el mensaje de aviso. |
| Zona horaria `America/Tegucigalpa` y formato `es-HN` | `lib/format.ts:1`, default de `lab_purchases.requested_at`, páginas | `America/Lima`, `es-PE`. |
| Importaciones en USD | todo el módulo | Probablemente igual (las compras al exterior suelen ser en USD). Si quiere ver costos en soles, agregar conversión con tipo de cambio por importación (hoy no existe). |
| Laboratorios en **quetzales** (GTQ), tipo de cambio sugerido de Drop Guatemala, respaldo 7,75 | `lib/lab-purchases*.ts`, migración 0046 | Generalizar a "moneda local" (PEN) con tipo de cambio PEN por USD. |
| 8 cuentas fijas de reparto (Miranova/Mireva/Dropi por país) | `LAB_DESTINATIONS`, `lib/lab-purchases.ts:15-24` | Reemplazar por una tabla configurable de cuentas/canales. |
| País central **Guatemala** (`HUB_COUNTRY`) y El Salvador consolidado (`CONSOLIDATED_COUNTRIES`) | `lib/transfers.ts:40, 43` | Si todo está en Perú, el "centro" sería la bodega principal (p. ej., Lima) y los traslados serían entre bodegas/ciudades; replantear la regla "lo repartido al país central no necesita traslado" (hoy es por país, no por bodega). |
| Bodegas sembradas en la migración | `20261113020518_transfers.sql:117-125` | Cargar las propias. |
| Solicitudes de tiendas como fuente de "Por enviar" | `lib/transfers.ts:339-358` | Solo si tiene un módulo equivalente. |
| Métodos de pago (Alibaba, Alipay, Western Union…) | `lib/imports.ts:94` | Ajustar la lista a los que use. |
| Tipos de documento: "Aduana (DUA / póliza)" | `lib/imports.ts:102` | En Perú el nombre del documento aduanero es otro (posiblemente DAM, Declaración Aduanera de Mercancías; **verificar** con su agente de aduanas). |
| Paqueteras con página pública (DHL, FedEx, UPS, USPS, Aramex) | `lib/imports.ts:57-63` | Igual para internacionales. Para transportistas locales peruanos, **verificar** si 17TRACK los cubre o si tienen API. |
| Países reconocidos en "dónde va" | `lib/track-place.ts:12-28` | Ya incluye Perú (`PE`); agregar los de origen/tránsito que aparezcan en sus guías. |
| Modelo de IA y beta | `lib/invoice-ai.ts` | Cualquier modelo con visión y salida estructurada sirve; mantener la regla de "propuesta revisada por una persona, sin guardar automáticamente". |

### 10.2 Cosas a verificar para Perú (no se infieren del código)

- **Costos de importación**: qué aranceles, impuestos y cargos aplican, y **si algún impuesto pagado en aduana es recuperable como crédito fiscal**. Si lo es, quizá no debería sumarse al costo aterrizado (hoy todo lo que es "Importación" se suma). Verificar con contador y agente de aduanas.
- **Documentos obligatorios** para el desaduanaje y su nombre local (la entidad es SUNAT; verificar requisitos).
- **Factura comercial para la bodega**: confirmar si el operador logístico necesita verla (hoy por eso no es privada).
- **Comprobantes locales** (facturas/boletas electrónicas de compras locales a laboratorios): hoy Laboratorios no guarda documentos; si en Perú hacen falta, agregar documentos a esa sección.

---

## 11. Orden sugerido para construirlo

Cada fase deja algo usable. Se indican tablas y pantallas mínimas.

**Fase 0 — Base.** Usuarios con permisos (`compras`, `compras_ver`, `dinero`, `exportar`), lista de países, catálogo de productos por cuenta/canal y tasas de cambio. Almacenamiento privado de archivos con enlaces firmados.

**Fase 1 — Importaciones (MVP).**
- Tablas: `imports` (sin `track_*`), `import_items` (sin recepción), `import_events`, `import_documents`, bucket privado.
- Pantallas: lista (pestañas Activas/Recibidas/Canceladas/Todas, filtro por país), detalle con cabecera, estado + nota, productos (catálogo o nuevo con foto), documentos, historial.
- Reglas: código `IMP-AAAA-NNN`, 12 estados, checklist (factura + tracking), enlace de seguimiento público.

**Fase 2 — Dinero.**
- Tablas: `import_costs`, `import_payments`.
- Costo aterrizado con los 4 repartos y avisos (§6.3), margen y ganancia (§6.4), pagado/falta pagar, documentos con montos y privados (`MONEY_DOCS`, `PRIVATE_DOCS`), eventos `money`.
- Excel de la importación.

**Fase 3 — Recepción y alertas.**
- Columnas de recepción en `import_items`; costo sobre unidades buenas.
- Aviso a la bodega (mensaje WhatsApp, marca "reportada"), alertas atrasada / sin novedades / avisar.
- Permiso "solo ver" para la bodega.

**Fase 4 — Proveedores y reportes.**
- `import_suppliers` y alta rápida desde la importación; estadísticas por proveedor; reportes (en camino, por mes, historial del costo por unidad).

**Fase 5 — Seguimiento automático.**
- Columnas `track_*`; empezar con **17TRACK** (una sola clave cubre todas las paqueteras) y luego agregar APIs oficiales; tarea programada cada X minutos que consulte cada guía cada 3 h; novedades al historial; "dónde va".

**Fase 6 — Conexión con el inventario de la plataforma.**
- Líneas pagadas como "en camino" en inventario; enlace automático de productos nuevos (SKU propio o nombre ≥ 6 letras, coincidencia única); paso automático a "Ingresado" con entradas de stock ≥ 50 % de lo esperado. Requiere que la plataforma entregue catálogo y movimientos de stock.

**Fase 7 — Lectura de facturas con IA.**
- Esquema de extracción, tipo de cambio en pantalla, revisión humana, sin precios para quien no tiene Dinero.

**Fase 8 — Compras locales (laboratorios/maquila).**
- `lab_purchases` con moneda local configurable y reparto por cuenta configurable (no fijo), Excel.

**Fase 9 — Traslados.**
- `transfer_points`, `transfers`, `transfer_items`, `transfer_arrivals`, `transfer_documents`, `transfer_events`; manifiesto; llegada por bodega; merma; cuadro de rutas.
- Después: variantes del catálogo, "Por enviar" (`transfer_settled`) a partir de los repartos.

**Fase 10 — Resumen diario por correo** con las alertas de importaciones.

---

## 12. Apéndice A: archivos del módulo

**Páginas y acciones**

| Archivo | Qué hace |
|---|---|
| `app/(app)/imports/page.tsx` | Lista de importaciones con pestañas, filtros, alertas y checklist. |
| `app/(app)/imports/[id]/page.tsx` | Detalle de una importación (todas las secciones). |
| `app/(app)/imports/actions.ts` | Acciones del servidor de importaciones: crear, editar, estado, aviso, productos, recepción, enlazar, costos, pagos, archivos, eliminar, actualizar seguimiento, leer y agregar factura con IA. |
| `app/(app)/imports/imports.css` | Estilos de la sección (también los usan otras páginas). |
| `app/(app)/imports/suppliers/page.tsx` | Directorio de proveedores con estadísticas. |
| `app/(app)/imports/suppliers/actions.ts` | Crear (también rápido), editar (propaga el nombre) y borrar proveedores. |
| `app/(app)/imports/reports/page.tsx` | Reportes (requiere Dinero). |
| `app/(app)/imports/labs/page.tsx` | Lista de compras a laboratorios. |
| `app/(app)/imports/labs/actions.ts` | Guardar, cambiar estado y borrar compras a laboratorios. |
| `app/(app)/imports/labs/labs.css` | Estilos de Laboratorios. |
| `app/(app)/imports/transfers/page.tsx` | Traslados: En ruta (cuadro y lista) y Por enviar. |
| `app/(app)/imports/transfers/[id]/page.tsx` | Detalle de un traslado por bodega de destino. |
| `app/(app)/imports/transfers/bodegas/page.tsx` | Administración de bodegas. |
| `app/(app)/imports/transfers/actions.ts` | Acciones de traslados: crear, editar, enviar, cancelar, eliminar, líneas, variantes, llegada, documentos, armar desde Por enviar, dar por enviado, bodegas. |
| `app/(app)/imports/transfers/transfers.css` | Estilos de Traslados. |

**Rutas de API**

| Archivo | Qué hace |
|---|---|
| `app/api/imports/doc/[id]/route.ts` | Documento de importación → enlace firmado (revisa `PRIVATE_DOCS`). |
| `app/api/imports/item/[id]/route.ts` | Foto de producto nuevo → enlace firmado. |
| `app/api/transfers/doc/[id]/route.ts` | Documento de traslado → enlace firmado. |
| `app/api/export/imports/[id]/route.ts` | Excel de una importación. |
| `app/api/export/labs/route.ts` | Excel de laboratorios. |
| `app/api/cron/sync/route.ts` | Tarea cada 10 min (sincronización general, incluye enlace, avance y seguimiento). |
| `app/api/cron/restock-digest/route.ts` | Tarea diaria del correo (incluye importaciones). |
| `app/api/dev-storage/[...path]/route.ts` | Solo desarrollo local: imita Storage para `import-files` y `transfer-files`. |

**Componentes**

| Archivo | Qué hace |
|---|---|
| `components/import-forms.tsx` | Formularios de importaciones: cabecera, proveedor rápido, estado, aviso a bodega, selector de catálogo, productos, enlazar, recepción, costos, pagos, subida de documentos, eliminar. |
| `components/invoice-reader.tsx` | Panel "Leer con IA": muestra la propuesta, tipo de cambio, edición y confirmación. |
| `components/supplier-forms.tsx` | Formulario de proveedor y borrar. |
| `components/lab-forms.tsx` | Formulario de compra a laboratorio, selector de estado y borrar. |
| `components/transfer-forms.tsx` | Formularios de traslados: nuevo/editar, enviar, líneas con variantes, llegada, documentos, armar desde Por enviar, dar por enviado, bodegas. |
| `components/imports-subnav.tsx` | Sub-navegación de Compras según permisos. |
| `components/app-frame.tsx` (línea 22) | Entrada "Compras" en el menú. |

**Librerías**

| Archivo | Qué hace |
|---|---|
| `lib/imports.ts` | Reglas puras de importaciones: estados, catálogos, costo aterrizado, margen, código, alertas, mensaje, recepción, "en camino" para inventario, enlace de productos, resumen diario. |
| `lib/imports-data.ts` | Lectura de la base de importaciones, catálogo, precios, estado frente a Drop, `linkNewProducts`, `advanceImports`, `productsToWatch`, archivos del bucket. |
| `lib/imports-tracking.ts` | Orquesta el seguimiento automático (qué guías, con qué servicio, qué se guarda). |
| `lib/carrier-tracking.ts` | Detecta la paquetera, lee las claves y elige el cliente. |
| `lib/tracking17.ts` / `lib/tracking17-client.ts` | 17TRACK: lectura de respuestas / llamadas. |
| `lib/tracking-dhl.ts` / `lib/tracking-dhl-client.ts` | DHL: lectura y traducción de estados / llamada. |
| `lib/tracking-fedex.ts` / `lib/tracking-fedex-client.ts` | FedEx: ídem. |
| `lib/tracking-ups.ts` / `lib/tracking-ups-client.ts` | UPS: ídem. |
| `lib/track-json.ts` | Ayudas para leer JSON de paqueteras con cuidado (fechas, limpiar número). |
| `lib/track-place.ts` | "Dónde va": lugar → país y ciudad → fase. |
| `lib/import-reports.ts` | Estadísticas de proveedores y reportes. |
| `lib/invoice.ts` / `lib/invoice-ai.ts` | Factura → propuesta (puro) / lectura con Anthropic. |
| `lib/lab-purchases.ts` / `lib/lab-purchases-data.ts` | Laboratorios: reglas y validación / lectura y tipo de cambio sugerido. |
| `lib/transfers.ts` / `lib/transfers-data.ts` | Traslados: reglas, rutas, Por enviar, variantes, validación / lectura y archivos. |
| `lib/permissions.ts` | Permisos `imports`, `imports_view`, `money`, `export`; `importsAccess`. |
| `lib/auth.ts` | Verificación de sesión y permisos en páginas, acciones y APIs. |
| `lib/integrations.ts` | Claves de servicios (panel cifrado o variables de entorno). |
| `lib/inventory.ts` / `lib/inventory-data.ts` | `trackOrders` (detección de llegada) y carga de pedidos + líneas de importación + entradas de stock. |
| `lib/sync.ts` | Sincronización general que llama a enlace, avance y seguimiento. |
| `lib/restock-digest.ts` / `lib/restock-digest-send.ts` | Correo diario (incluye importaciones). |
| `lib/store-requests.ts` | Solicitudes de tiendas (repartos por país usados en Por enviar). |
| `lib/wallet.ts` (`toUsd`), `lib/countries.ts`, `lib/format.ts`, `lib/xlsx.ts` | Conversión a USD, países, fechas, Excel. |
| `lib/mixed-costs.test.ts` | **No es de Compras**: prueba el módulo de Rentabilidad (`lib/profit.ts`), que tiene su propio costo de traslado por unidad. |
| `lib/boxful-document*.ts` | **No es de Compras**: Conciliación bancaria. |

**Pruebas** (`npm test`, `node --test`): `lib/imports.test.ts`, `lib/import-reports.test.ts`, `lib/invoice.test.ts`, `lib/lab-purchases.test.ts`, `lib/transfers.test.ts`, `lib/track-place.test.ts`, `lib/tracking17.test.ts`, `lib/tracking-dhl.test.ts`, `lib/tracking-carriers.test.ts` (FedEx/UPS), `lib/access.test.ts` (permisos).

**Migraciones**: `supabase/migrations/0035_imports.sql`, `0036_imports_reception.sql`, `0037_import_suppliers.sql`, `0038_import_tracking.sql`, `0039_imports_proforma_order_events.sql`, `0046_lab_purchases.sql`, `20261113020518_transfers.sql`, `20261113030450_transfer_variants.sql`, `20261113155800_import_track_location.sql`. Relacionadas: `0044_store_requests.sql` (da el permiso Solicitudes a quien tiene Compras), `0047_store_request_items.sql` y `20261029150617_request_country_quantities.sql` (repartos por país).

---

## 13. Apéndice B: inconsistencias y puntos abiertos detectados

Para que quien lo replique decida si copiarlos o corregirlos.

1. **"Atrasada" se calcula de dos maneras.** `isLate` excluye cotizaciones (se usa en el conteo del encabezado y en el correo), pero la fila de la lista y el detalle usan `isActive && eta < hoy`, que sí incluye cotizaciones (`app/(app)/imports/page.tsx:136`, `[id]/page.tsx:90`). Una cotización con fecha vencida se ve "atrasada" en la fila pero no suma en el encabezado.
2. **"Avisar a la bodega" incluye cotizaciones** en la lista y el detalle (`needsReport` usa `isActive`), mientras que el correo diario las excluye.
3. **Fecha de llegada automática en UTC.** Al pasar a Recibido/Ingresado o al guardar la recepción, `arrived_at` se toma de `new Date().toISOString().slice(0, 10)` (fecha UTC), no de la fecha local; de noche en Centroamérica puede quedar con el día siguiente (`actions.ts:157, 299`). Lo mismo con el año del código.
4. **Quitar un producto borra sus costos "a un producto" sin dejar rastro.** `import_costs.item_id` tiene `on delete cascade`, así que el costo desaparece (sin evento `money`), aunque quien quite el producto no tenga Dinero. El aviso de `landedCosts` "costo asignado a un producto que ya no está" casi nunca se da por eso.
5. **El servidor no valida que la bodega acepte la clase de producto** en traslados: `cleanLine` busca destinos sin filtrar por `goods`; solo el formulario lo filtra.
6. **Laboratorios: estado "Llegó a bodega" pero la fecha se llama "Llegada a Drop"**, y no hay enlace con el stock de Drop que la confirme.
7. **"Por enviar" toma compras a laboratorio en cualquier estado** (también "Solicitado"); las solicitudes siempre se marcan como "importado", aunque la solicitud sea de maquila.
8. **`importsAccess()`** existe en `lib/permissions.ts:43` pero solo se usa en pruebas; las páginas usan `can()` directamente.
9. **`breakEven`** se calcula en `marginOf` pero no se muestra en ninguna pantalla.
10. **Comentarios desactualizados**: "Actualizar ahora" dice "a DHL directo si es DHL, si no a 17TRACK" pero también usa FedEx y UPS (`actions.ts:542`); `TrackRefreshForm` dice "(17TRACK)"; en `lib/imports.ts:27-29` hay un comentario huérfano sobre INBOUND encima de `TRACKED_STATUSES`.
11. **Sin CHECK en la base** para `imports.status`, `imports.transport`, `imports.dest_country` ni `import_events.kind`: solo los valida la aplicación. `import_costs.amount` permite 0 en la base, la app exige > 0.
12. **Enlace automático con varias cuentas por país**: `linkNewProducts` enlaza con la primera cuenta del país cuya sincronización encuentre coincidencia; si un país tiene varias cuentas con el mismo producto, el resultado depende del orden de sincronización.
13. **El seguimiento puede saltarse vueltas**: corre al final de la sincronización solo si sobra tiempo del presupuesto de 240 s.
14. **Archivos huérfanos**: si alguien pide el enlace de subida y no registra el documento, el archivo queda en el bucket (no hay limpieza).
15. **Sin historial ni documentos en Laboratorios**, y sus cambios no se registran en ningún lado (a diferencia de importaciones y traslados).
16. **Estado de la paquetera "Entregada" no cambia el estado de la importación**: es intencional según el código, pero conviene decidirlo explícitamente al replicar.
17. **Sin paginación**: la lista de importaciones y el cálculo de "última novedad" leen todas las filas de `imports` e `import_events`; traslados tienen topes fijos (2000 traslados, 50 000 líneas).
