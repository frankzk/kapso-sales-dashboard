# Auditoría de rutas y backend — 2026-09-25

Este anexo conserva el inventario y diagnóstico del código inicial. Las
correcciones posteriores y las mediciones consolidadas están en
[el informe principal](audit-2026-09-25.md).

## Alcance y evidencia

Inspección estática del checkout con HEAD `24eb9fe`, enfocada en módulos fuera de Master de Pedidos, sus lecturas, APIs y trabajos programados. Los números de línea describen el código inspeccionado; pueden desplazarse con cambios posteriores. Se leyó `AGENTS.md`. Este informe no cambia la aplicación, los estados operativos, permisos ni el MOM.

**No se midieron tiempos de producción, TTFB, bytes reales, planes de ejecución ni filas examinadas por PostgreSQL en este subanálisis.** Las cotas de filas y llamadas siguientes salen del código, no de un HAR ni de logs. Las afirmaciones sobre crecimiento son análisis estructural, no una extrapolación de milisegundos. Los comentarios del repositorio que mencionan incidentes/mediciones históricas no constituyen mediciones nuevas.

Variables: `N` = histórico total de la tienda/organización; `R` = filas del rango elegido; `A` = cola activa; `S` = tiendas; `U` = usuarios; `P` = filas de página. Una consulta con `LIMIT P` acota su respuesta, pero no demuestra que su trabajo sea O(P): hay que revisar filtros, orden, conteos, índices y RLS. Un índice B-tree implica normalmente una búsqueda logarítmica más la página; no se promete coste matemáticamente constante.

Los conteos de llamadas indicados son **lecturas servidor → Supabase/API**, antes de autenticación, layout, fallback de compatibilidad y posibles reintentos. Las páginas Next.js App Router usan Server Components y acciones servidor; abrir una página no equivale a que el navegador haga una llamada REST por cada lectura DB. El número de requests del navegador requiere una captura autenticada.

## Arquitectura relevante

Flujo interactivo: navegación/RSC o Server Action → permisos/tiendas accesibles → `createServerSupabase()` con sesión y RLS → PostgREST/RPC → procesamiento TypeScript → serialización RSC/props → tabla/gráfico. `lib/db.ts:14` crea clientes de sesión; `lib/db.ts:45` conserva un cliente administrativo por proceso. Algunas lecturas administrativas autorizadas usan service-role; no deben servir para certificar rendimiento bajo RLS.

Los webhooks y crons usan clientes administrativos, consultan proveedores y mantienen tablas/proyecciones. Su trabajo fuera de la petición de pantalla es correcto, pero comparten capacidad DB con las lecturas interactivas. Vercel está configurado en `gru1` (`vercel.json`); no se verificó la región ni el tamaño de la base.

## Inventario principal

| Sección | Entrada / funciones | Lecturas y cotas estáticas | Dependencia e incidencia | Prioridad y evidencia |
|---|---|---|---|---|
| Consolidado `/dashboard` | `app/dashboard/page.tsx`; `getOrders`, `getConversations`, `getLeadsForDashboard`, `getCampaignLeadsForDashboard`, `getWebAdOrders`, rollups, atribución | Hasta 50 páginas de 1.000 por lector y rango; campañas por tienda; contexto por lotes de 250/300/500. KPIs no consumen solamente rollups. | O(R) de transferencia y procesamiento, offsets crecientes; rango corto no exige todo N si el índice temporal funciona. Rango amplio puede acabar truncado por topes. | **P1**. `lib/access.ts:193`, `:209`, `:244`, `:298`, `:341`, `:628`; atribución posterior a cargas en `app/dashboard/page.tsx:152`. |
| Panel de tienda `/dashboard/[storeId]` | Misma familia `lib/access.ts` para una tienda | Pedidos/conversaciones/leads por rango y métricas relacionadas; reduce S, no cambia patrón de drenado | O(R), no independiente del volumen del rango | **P1** por el mismo mecanismo. `app/dashboard/[storeId]/page.tsx`; `lib/access.ts:195`. |
| Leads `/dashboard/leads` | `getStoreLeads(scope, view, leadsViewLimit(view))` | Por llamar: primera página + COUNT exacto y hasta 19 páginas adicionales simultáneas; cap 20.000. Otras vistas: 200. Después nombres de anuncios, números y declaraciones por IDs | O(A) de payload/procesamiento; el cap no es paginación UX. Gráficos y facetas locales dependen de recibir todo A | **P1**. `lib/leads-access.ts:38`, `:119`, `:193–219`; orquestación `app/dashboard/leads/page.tsx:121–138`. |
| Conteos/sondeo de Leads | `getLeadQueueSnapshot`, RPC `lead_queue_counts` | S RPC; cada una calcula siete conteos, COUNT total y MAX(updated_at) de todos los leads de esa tienda. Fallback: siete COUNT | **O(N)** aun con pocos leads visibles. Consulta repetida por sondeo; menos viajes que siete queries no significa trabajo constante | **P1**. `lib/leads-access.ts:429–465`; SQL `db/migrations/0059_lead_queue_counts.sql:82–99`; sondeo `components/leads.tsx:903`. |
| Validar pagos `/dashboard/pagos` | `getPaymentReviewBoard` | 3 listas ×80 +3 COUNT, después contexto de ≤240 order IDs por batches. Cuentas de cobro se esperan antes | Listas acotadas; conteos de pendientes/observados y sort dependen del backlog. Validado está acotado al día | **P2**. `lib/payment-review-access.ts:17`, `:111`, `:117–160`, `:174–194`. |
| Repro Provincia `/dashboard/envios` | `getShipmentCounts`, `getStoreShipments`, `getReprogramStats`, `getReproTodayByAgent` | Lista hasta 5×1.000 guías, luego recuperación, última gestión, stock Fénix y contactos; 6 COUNT de categorías; stats históricas independientes | Listado O(A) o estado histórico elegido. Enriquecimiento se paga por todas las filas, no sólo visibles. Conteos incluyen entregados/cerrados históricos | **P1**. `lib/shipments-access.ts:561–625`, `:660–684`; página `app/dashboard/envios/page.tsx:44–48`. |
| Estadísticas Repro | `getReprogramStats` → `buildReprogramRows` | Hasta 20 páginas Fénix +20 páginas Aliclik, sin fechas; después 3 familias de batches secuenciales de 300 para agentes/hijos | **O(N de reprogramaciones)** por apertura, hasta cap. Puede añadir más de 200 consultas por batches al alcanzar ambas cotas | **P1**. `lib/shipments-access.ts:1003`, `:1051–1133`. |
| Revisión importación `/dashboard/envios/import` | `getReviewShipments` | 1 lista ≤1.000 + enriquecimiento Fénix. Consulta todas las tiendas accesibles aunque selector resuelva una tienda para importación | Respuesta acotada; ordenar backlog sin índice apropiado sigue costando. No cursor de resultados | **P2**. `lib/shipments-access.ts:690–705`; `app/dashboard/envios/import/page.tsx:25`. |
| Recuperar devueltos `/dashboard/envios/recuperacion` | `loadRecoveryView` | Credenciales/config y 1 query de guías, ventana `2 × maxDays`, máximo 300 | Acotado temporalmente; no debe crecer con histórico fuera de ventana con índice adecuado. Elegibilidad se filtra después del LIMIT; puede omitir candidatos tras 300 | **P2**. `app/dashboard/envios/recuperacion/actions.ts:75–96`. |
| Catálogo `/dashboard/envios/aliclik` | `loadCatalogView`, `loadShopifySkuDetails`, `loadAllAliclikSkus` | API Shopify activa, luego hasta 50×1.000 pedidos de 365 días con line_items y dos proyecciones JSON raw; descarga catálogo Aliclik por páginas, máximo 50k; dos mapas | **O(R de 365 días)** para abrir catálogo de pocos productos; API externa en camino crítico. Mapas de pantalla no paginados pueden quedar bajo cap PostgREST | **P1**. `app/dashboard/envios/aliclik/actions.ts:190–201`; `lib/aliclik-catalog.ts:836–852`, `:915–927`. |
| Stock Fénix `/dashboard/envios/stock` | Query `fenix_stock`, pendientes, pedidos por IDs | Stocks y pendientes sin paginar; luego lotes secuenciales de 300 pedidos para line_items | O(A), demanda potencialmente incompleta si PostgREST limita la consulta de pendientes | **P2**. `app/dashboard/envios/stock/page.tsx:13`, `:36–55`. |
| Producto por anuncio `/dashboard/leads/anuncios` | `getAdsParaAsignar`, `getHandlesConocidos` | 1 query de hasta 5.000 leads nuevos + agrupación Node; 1 query de hasta 3.000 textos `%/products/%`; contexto por anuncio en batches 200 | O(A), selección/truncamiento puede distorsionar conteos y catálogo. LIKE con comodín inicial no se resuelve con B-tree de texto simple | **P2**. `lib/ad-products-access.ts:76–115`, `:153–169`. |
| Productividad `/dashboard/productividad` | `getProductivityBoard` | 7 ramas iniciales (actual/anterior/eventos/presencia/prefijo/leads/ventas); calls/ventas hasta 40k; otras familias hasta 20k. Páginas de 1k en ventanas de 4 | O(R), con contexto/agrupación Node y payload de detalles. Retornar parcial en error/cap puede dar métricas incompletas | **P1** con gran volumen/rango. `lib/productivity.ts:195–224`, `:665–690`, `:950–1024`, `:1094–1116`. |
| Tiendas `/dashboard/stores` | `getAccessibleStores`, `getAnomalyReport` | Tiendas y anomalías agregadas de últimos 7 días | Sin dependencia directa relevante de pedidos N; crece con S y tipos de anomalía | Bajo/**P2**. `app/dashboard/stores/page.tsx:13–18`; `lib/leads-access.ts:519–535`. |
| Ajustes `/dashboard/[storeId]/settings` | Reads stores, sync_state, ops_snapshots, webhook_events, templates, cobertura | 7 ramas principales; último snapshot 1; últimos webhooks 30; **COUNT exacto de todos los webhooks** de tienda | Dependencia N de eventos por contador, aunque sólo muestre 30. `stores.*` se queda servidor, revisar cuidadosamente serialización sensible en cualquier cambio | **P2**. `app/dashboard/[storeId]/settings/page.tsx:83–111`. |
| Costos `/dashboard/costos` | `loadCosts`, `loadShopifyProducts` → RPC `org_shopify_products` | 3 lecturas de historial tarifas/productos/adicionales; 1 RPC explota JSON line_items de todos los pedidos de organización, DISTINCT y GROUP BY | **O(N)** aun con pocos productos visibles; sort/agregación de histórico cada apertura | **P1**. `app/dashboard/costos/actions.ts:299–335`; `db/migrations/0094_org_shopify_products.sql:28–55`. |
| Grupo GF Courier `/dashboard/courier` | `loadCourierConfig`, `courier_lima_districts`, `loadCourierOperations` | RPC histórico de distritos + configuración; operaciones: ≤300 pedidos con COUNT, ≤300 solicitudes, riders y contexto. Guías de admisión limitadas a 2.000 | **O(N Lima)** por normalizar/contar todos los distritos en RPC. Listado operativo acotado, contexto susceptible a límites de respuesta | **P1**. `app/dashboard/courier/actions.ts:278–323`, `:582`; SQL `db/migrations/0135_courier_lima_districts_from_master.sql:51–66`. |
| Equipo `/dashboard/team` | Queries membresías/tiendas/riders/permisos/access; `auth.admin.listUsers` | 4 lecturas paralelas + access; después hasta 20 llamadas seriales de 200 usuarios, de todo el proyecto | O(U global), independiente de pedidos; sólo interesan miembros de organización | **P2**. `app/dashboard/team/page.tsx:55–85`. |
| Liquidaciones `/dashboard/liquidaciones` | `getSettlements`, `getRiders`; detalle/tarifas sólo con id abierto | Lista ≤200. Detalle: settlement, líneas y batches de 200 master IDs | Buena carga bajo demanda; coste detalle proporcional a líneas, no todo histórico de pedidos | **P2**. `lib/settlements-access.ts:68–124`; `app/dashboard/liquidaciones/page.tsx:46–53`. |
| Rutas `/dashboard/rutas` | `getRoutes`, `getRiders`; detalle/assignable/retry sólo al abrir | Lista ≤60; asignables ≤300; retry candidates hasta 2.000 stops y contexto en lotes | Buena separación de listado/detalle. Historial por teléfono de candidatos puede crecer; límites sin cursor requieren revisar completitud | **P2**. `lib/routes-access.ts:73–118`, `:194–245`, `:276–372`; `app/dashboard/rutas/page.tsx:54–64`. |
| Reparto `/reparto` | User → rider → 30 routes → detail | Secuencia necesaria de alcance, luego stops y batches master de ruta elegida | Acotado a rutas y sus paradas; no enumera todos los pedidos | Bajo/**P2**. `app/reparto/page.tsx:27–52`; `lib/routes-access.ts:89–118`. |
| Almacén / Despacho | `getWarehouseStationData`, `getDispatchWorkspaceData` | Despacho: manifests ≤100 abiertos +20 cerrados, cola ≤400, items y batches de guías 200. Almacén tiene límite explícito de pedidos y cola guías ≤200 | Evita todo histórico pero carga contexto de múltiples manifiestos a la vez; verificar row caps de items | **P2**. `lib/dispatch-access.ts:94–150`, `:230–278`. |
| Cobros Tanders | `/dashboard/pedidos/cobros-tanders` | Página inicial sólo valida permisos y monta `TandersCobros`; operaciones costosas dependen de acciones posteriores | No inferir coste de revisión/modelo a partir de carga inicial | Inventariado, no medido. `app/dashboard/pedidos/cobros-tanders/page.tsx:14–20`. |

`/dashboard/pedidos` y sus detalles se auditan en el informe específico del Master. Las cotas de 1.000 mencionadas por el código corresponden al límite asumido de PostgREST; no se leyó la configuración viva `db-max-rows`. `.limit(5000)` no demuestra que se reciban 5.000 si el servidor recorta a 1.000.

## APIs y trabajos programados

No se invocaron crons, webhooks, imports, exportadores ni acciones operativas como prueba: varios escriben estado o contactan proveedores, aun cuando usan GET. Inventario de frecuencias desde `vercel.json`, no validación de ejecuciones reales.

| Entrada | Frecuencia / cota estática | Dependencia y riesgo | Evidencia |
|---|---|---|---|
| `/api/export` GET | Bajo demanda; orders hasta 100 páginas ×1.000 por rango; rollups como alternativa | Junta todas las filas y CSV en memoria; offsets y cap 100k. Errores de página cortan el bucle sin informe explícito de parcialidad | `app/api/export/route.ts:53–73` |
| `/api/export/pedidos` GET/POST | Bajo demanda; CHUNK 1.000, máximo 20.000, `maxDuration=120` | Exportación legítimamente proporcional a selección; no debería compartir diseño con página interactiva. GET llama lector de página repetidamente; comprobar que no repita COUNT/materializaciones innecesarias | `app/api/export/pedidos/route.ts:38–48`, `:75–93`, `:118–123` |
| `/api/export/fenix-programacion` POST | Máximo 5.000 guías, hasta 150 reparaciones dirección, `maxDuration=60` | Puede consultar Shopify y actualizar raw al reparar direcciones; no es un read-only inocuo. Batches externos limitados, coste proporcional a selección | `app/api/export/fenix-programacion/route.ts:20–24`, `:134–151`, `:194–205` |
| `/api/cron/sync` | Cada 5 min; tiendas en serie; `maxDuration=300` | Ingestión incremental por cursor y varias fuentes; loops hasta 50 páginas para Shopify/fuentes. Puede competir con lecturas. Master reconciler ya separado | `app/api/cron/sync/route.ts:44–57`; `lib/ingest.ts:859–1047` |
| `/api/cron/master-reconcile` | Cada 10 min; presupuesto 240s compartido entre tiendas | Lector candidatos/recompute por lotes; separación del sync y budget evitan starvation, pero revisar coste SQL `order_master_stale` con histórico | `app/api/cron/master-reconcile/route.ts:45`, `:95–127`; `lib/order-master.ts:1540–1671` |
| `/api/cron/aliclik-reconcile` | Cada 20 min; últimos 14 días, hasta 50 páginas externas de 100; presupuesto 230s | Acotado por ventana/tiempo, registra incompletitud. Coste de actividad reciente; aplicación por guía y secuencia por tienda aún consumen tiempo | `app/api/cron/aliclik-reconcile/route.ts:57–72`, `:402–487`, `:522–534` |
| `/api/cron/aliclik-close` | Minutos 10/30/50; presupuesto 230s | Seguimiento/cierre separado de reconciliación; pool y probes limitados. No agregarlo de vuelta a apertura de pantalla | `app/api/cron/aliclik-close/route.ts:110`, `:315`, `:444`, `:507–519` |
| `/api/cron/shalom-reconcile` | Cada 30 min; máximo 1.000, batches 50 | Backlog activo acotado, no todo N devuelto; confirmar fairness y planes de selección | `app/api/cron/shalom-reconcile/route.ts:44–50`, `:100–117` |
| Tanders status/payments | Status cada hora; payments cada 2h; 60 por ejecución | Presupuesto de backlog limitado; pagos tiene ventana lookback y consultas/modelo por guía. Métricas de retraso de cola necesarias | `lib/tanders/status-sweep.ts:37`, `:94`; `lib/tanders/payment-sweep.ts:42`, `:169–194` |
| `/api/cron/aliclik-catalog` | Diario | Sync por tienda en serie; comparte lectura de SKUs derivados de pedidos que actualmente puede drenar 50k | `app/api/cron/aliclik-catalog/route.ts:51`; `lib/aliclik-catalog.ts:553`, `:824–874` |
| Tarifas / Meta insights / coverage-push | Diario / diario / 5 horarios diarios | Procesos de agregación/proveedor acotados por rangos/lotes. Mantener fuera de pantalla; medir tiempos y filas por fase | `app/api/cron/aliclik-tariffs/route.ts:130–173`; `app/api/cron/meta-insights/route.ts:49–67`; `app/api/cron/coverage-push/route.ts:76–84` |
| Health Aliclik / resumen Telegram | Cada 5 min / diario | Health de proveedor registra latencia; resumen puede enviar mensajes. No ejecutar sólo para medir latencia de una página | `app/api/cron/aliclik-health/route.ts:117`; `app/api/cron/telegram-summary/route.ts` |
| `/api/cron/backup` | Diario | **Histórico completo** leads/calls, hasta 100k por tabla; filas+CSV+Blob en memoria. Paginación por OFFSET pese a comentario “keyset-stable”. A >100k backup nativo parcial (sí marca truncated) | `lib/backup.ts:23–31`, `:91–120`, `:156–165` |
| Crons de reparación manual | fix-phone-links, fix-delivery-dates, link-orphans, relink-by-code, reprocess-vouchers, shalom-probe | Existen rutas con escrituras/calls y límites; no todas están programadas en vercel.json. No tratarlas como endpoints seguros de benchmark | `app/api/cron/aliclik-fix-phone-links/route.ts:73–79`; `aliclik-fix-delivery-dates/route.ts:57–62`; `aliclik-link-orphans/route.ts:60–65`; `aliclik-relink-by-code/route.ts:65–71` |
| Webhooks Shopify/Flow/Kapso/Chatby/Meta/Swayp/Aliclik | Por evento; handlers esperan processors antes de responder | Medir ack y fases externas/recompute bajo bursts; si se difiere, primero cola durable/idempotente y preservación de orden de eventos. No basta fire-and-forget | `app/api/webhooks/shopify/[storeId]/route.ts:16`; `flow/[storeId]/route.ts:41`; `kapso/[storeId]/route.ts:38`; `chatby/route.ts:36`; `meta-social/route.ts:92`; `swayp/route.ts:26`; `aliclik/[storeId]/route.ts:70` |
| Media, vouchers, etiquetas, fotos e imports | Bajo demanda: `/api/leads/[leadId]/media`, payments voucher, shalom label/ticket/rotulo, pedidos rotulos, reparto foto, import courier/aliclik, settlements upload | Identificados por árbol de rutas; no analizados en profundidad ni medidos en este subanálisis. Revisar bytes, proxy/streaming y memoria de parseo antes de declarar cobertura completa | Archivos `app/api/**/route.ts` correspondientes |
| `/api/health` / `/api/performance` | Health JSON sin DB; performance autenticado ≤4KB | Health no prueba DB ni readiness de página. Performance registra métricas cliente sanitizadas | `app/api/health/route.ts:7–13`; `app/api/performance/route.ts:4–28` |

## Hallazgos prioritarios y correcciones

No se declara un P0 medido: no hubo medición viva suficiente para atribuir indisponibilidad. Los P1 son cuellos estructurales con evidencia de código.

1. **Eliminar recorridos históricos del camino interactivo.** Costos necesita dimensión SKU; Courier necesita distrito canónico y resumen por organización; Leads necesita contadores y versión de cola incrementales; Repro necesita resumen por día/asesor. Consultas de catálogos/configuración deben depender del tamaño del catálogo, no del número de pedidos. Mantener Shopify como fuente de productos/pedidos y conservar evidencia histórica; una dimensión local es una proyección, no una nueva fuente operativa.
2. **Paginar realmente Leads/Repro.** Filtros y facetas pasan al servidor, la página devuelve P+1 y cursor estable; contexto sólo de IDs visibles. Sustituir el cap por un límite menor sin mover facetas/gráficos rompería funcionalidad. Los conteos deben separarse del listado y seguir la misma semántica.
3. **Agregación de analytics en DB o resúmenes incrementales.** Consolidado/Productividad no deberían transferir cada evento para pintar series/KPIs. Reservar detalle al drilldown. La ventana temporal debe tener índices y estrategia explícita para grandes rangos.
4. **Exportación y backup masivos fuera del request interactivo.** Cursor/checkpoint, salida por partes/stream y archivo de resultado; declarar límites/incompletitud. A 1M no se debe presentar un archivo truncado como “todo”.
5. **Evitar N+1 y waterfalls evitables.** Equipo enumera auth global en serie; sustituir por perfiles asociados a miembros. Repro trae batches repetidos sobre histórico; corregir el modelo primero. Cuentas de pagos pueden prepararse en paralelo con sus seis consultas independientes. Los joins por IDs en lotes son mejores que N+1 individual, pero 60–200 batches seriales siguen siendo un waterfall.

### COUNT exacto, paginación y “todos los datos”

- `HEAD` elimina el cuerpo de respuesta, no el coste del COUNT. Una única RPC que agrupa todos los históricos sigue O(N), aunque ahorre viajes. El comentario `lib/leads-access.ts:198` que lo califica de “gratis” no describe su coste DB.
- Bajar 20 filas y contar 1M al mismo tiempo puede mantener lenta la pantalla de 20. Cursor sin conteo o resumen actualizado fuera del request resuelve una parte distinta del problema.
- `range(offset, offset+size)` no es keyset. El coste de páginas profundas puede crecer con el offset, y offsets de distintas peticiones pueden desplazar filas cuando se insertan/actualizan datos. Orden estable con desempate es necesario, pero no elimina desplazamiento por concurrencia.
- Descargar todo “para filtrar localmente” convierte la apertura, serialización, memoria y CPU del navegador en función de N/A. Virtualizar DOM sólo arregla render; no corrige descarga, COUNT ni queries.
- Copiar todo al navegador/offline tampoco resuelve escalabilidad y añade stale data/invalidación de permisos. Si se diseña offline, cachear sólo páginas autorizadas con caducidad y revalidar operaciones sensibles en servidor.
- Los límites duros deben informar truncamiento; varias rutas devuelven parcial en error. No sustituir exactitud operativa por optimizaciones silenciosas.

### Índices candidatos, sujetos a EXPLAIN

No se aplicó ningún índice desde esta auditoría de rutas. Un índice no convierte agregaciones globales en O(1).

| Tabla / índice candidato | Query específica | Motivo y validación |
|---|---|---|
| `order_payments(store_id, validation_status, paid_at DESC NULLS LAST, registered_at DESC)` o variante parcial para estados pendientes/observados | Carriles de `lib/payment-review-access.ts:120–134` | El índice actual `(store_id,validation_status)` (`0049_yape_payments.sql:87`) no cubre el orden; comparar plan para múltiples estados/tiendas antes de elegir compuesto vs parcial. |
| `order_payments(store_id, validated_at DESC) WHERE validation_status='validado'` | Validado hoy `lib/payment-review-access.ts:136–143` y conteo diario | Acota por tienda/tiempo y orden del único estado; verificar selectividad/uso real, tamaño y coste de escrituras. |
| `shipments(store_id, status_category, updated_at DESC, id DESC)` o parcial compatible con exclusiones courier | Vistas no-pendiente `lib/shipments-access.ts:576–587` | Índices iniciales separan categoría y followup; ordenar y filtrar en el mismo acceso puede reducir sort. Ajustar consulta a desempate ID y predicado exacto. Pendiente usa otro orden y requiere plan propio. |
| Índice parcial `leads` por cola ya existente | `por_llamar` | **No duplicar**: `0059_lead_queue_counts.sql:40–42` define `(store_id,needs_attention DESC,last_interaction_at DESC,id) WHERE category IN ('open','hot')`. El problema principal restante es leer toda A y contar toda N. |
| `shipments` por returned_at | Recuperación `actions.ts:83–89` | Revisar primero índices `0047_shipment_gestion.sql:65` y `0112_return_recovery.sql:76`; no añadir duplicado sin comparar predicados con consulta real. |

### Caché e invalidación

Catálogos de productos/SKU, distritos, configuración courier y tarifas pueden tener caché por tienda/organización y versión, invalidada por sync o edición autorizada. Las vigencias de costos siguen conservándose. Una caché global sin scope de permisos puede filtrar datos entre organizaciones. Para contadores se necesita frescura declarada y reconciliación periódica; aplicar TTL a una consulta O(N) reduce frecuencia, pero no elimina el coste del refresh ni la estampida. Operaciones de pago/estado/disponibilidad revalidan su verdad al guardar, aunque la vista venga cacheada.

## Instrumentación disponible y propuesta

Existente: `lib/performance-metrics.ts:1–7` permite navegación, apertura de lead, guardado de llamada, primer paint de chat y envío WhatsApp. `lib/client-performance.ts:35–45` elimina IDs/querystring. `/api/performance` autentica y registra duración, contexto limitado y commit abreviado en logs; no persiste un histograma propio.

Límites encontrados:

- Navegación termina al cambiar `pathname` en `components/dashboard-shell.tsx:37–40`. Una ruta con Suspense puede haber llegado al skeleton y todavía no tener tabla. Agregar marca “datos visibles” dentro del contenido final.
- `lib/client-performance.ts:86–87` ignora cambios entre rutas sanitizadas iguales: filtros, subrutas y paginación no quedan desglosados.
- No se encontró instrumentación general de auth, DB, procesamiento, serialización, bytes, LCP/INP o filas devueltas/examinadas. Latencia de proveedor Aliclik es otra métrica, no latencia del panel.
- El repositorio comenta cifras históricas (por ejemplo `lib/leads-live-refresh.ts:3–9`); deben tratarse como contexto histórico hasta consultar evidencia conservada.

Agregar spans servidor por nombre estático de operación, request id opaco, duración, número de filas, número de queries y categoría de cache hit. Nunca loguear cookies, bearer tokens, teléfonos, nombres, SQL con literales, payloads ni URLs firmadas. Devolver `Server-Timing` cuando sea viable. Separar tiempo crítico de wall-clock de suma de queries paralelas: sumar duraciones concurrentes no equivale al tiempo total.

Para producción, obtener p50/p95 por ruta y commit, cold/warm, prefetch/no prefetch, misma tienda y filtros. Captura de red autenticada sólo con metadatos sanitizados; no guardar HAR con credenciales. Revisar `pg_stat_statements` de forma agregada y planes con parámetros sintéticos/equivalentes autorizados. `EXPLAIN (ANALYZE, BUFFERS)` ejecuta la consulta: usar sólo SELECT conocidos en sesión read-only, timeout y baja concurrencia.

## Runtime local y experimento 50k / 200k / 1M

Comprobaciones locales de este subanálisis:

- `Get-Command` no encontró `psql`, `postgres`, `pg_ctl`, `docker` ni `podman` en PATH.
- No existen las ubicaciones estándar acotadas consultadas: `C:\Program Files\PostgreSQL`, `C:\Program Files\Docker`, `C:\Program Files\Podman`, `C:\Users\Pc\scoop\apps\postgresql`, `C:\Users\Pc\AppData\Local\Programs\PostgreSQL`.
- El workspace no contiene `node_modules/@electric-sql` ni `node_modules/pglite` al revisar. No se buscaron credenciales ni se recorrió todo el disco.
- Existe `wsl.exe`, pero `wsl --list --quiet` devolvió ayuda de instalación con exit 1; no se demostró una distribución utilizable. No se instaló ni modificó WSL.

Alternativa simple verificada con documentación oficial: **PGlite**, PostgreSQL compilado a WASM para Node, admite `new PGlite()` en memoria o directorio local. Se puede instalar `@electric-sql/pglite` en una carpeta de pruebas aislada, sin tocar package/lock de aplicación, y ejecutar fixtures SQL sintéticos sin credenciales ni conexión a Supabase. Fuente: [documentación oficial de inicio](https://pglite.dev/docs/) y [descripción de PGlite](https://pglite.dev/docs/about). La comprobación inicial anterior ocurrió antes de la instalación aislada realizada durante el trabajo coordinado.

Diseño mínimo del experimento:

1. Crear esquema reducido con las mismas columnas/índices usados por la consulta y datos sintéticos deterministas. Mantener **los mismos 20 pedidos recientes/activos** y añadir sólo históricos cerrados hasta 50k, 200k y 1M.
2. Ejecutar ANALYZE en cada escala. Comparar listado sin COUNT, COUNT exacto, consulta de resumen, OFFSET profundo y cursor; filtros frecuentes y cero resultados. Registrar planes, buffers/filas examinadas y filas devueltas, además de p50/p95 repetidos tras warmup.
3. Ejecutar una segunda prueba donde crece también A/R, para distinguir histórico irrelevante de trabajo legítimo del rango/cola. Evitar fixtures donde el predicado descarte todo por un artificio de datos.
4. PGlite sirve para comparar estructura y corrección SQL; **no certifica latencia de Supabase, RLS, red, discos, concurrencia o Vercel**. Validar posteriormente con Postgres/Supabase aislado equivalente y sesión de usuario.
5. El criterio no es “mismo número exacto de ms”, sino que página de 20 no examine/transfiera/procese N ni haga un COUNT/sort global obligatorio. Latencias y bytes reales antes/después permanecen pendientes hasta ejecutar el escenario.

### Verificación SQL aislada ejecutada

Después del inventario se creó `scripts/verify-master-scaling.mjs`. Usa PGlite 0.5.8 instalado en `../.performance-tools`, PostgreSQL en memoria, extensiones `pgcrypto`/`pg_trgm`, `test_prelude.sql`, todas las migraciones reales 0001–0157 y policies inmediatamente después de 0003. No carga `.env`, credenciales, datos reales ni acepta URL de base de producción.

Se ejecutó `node scripts/verify-master-scaling.mjs --smoke`: **PASS** para cadena completa y `scripts/sql/master_read_scaling_smoke.sql`, incluyendo mutaciones multirow, upsert, cambio de tienda, update irrelevante sin reescritura, backfill/reaplicación, rollback, eliminación/cascade y aislamiento RLS. El proceso informó 1.573 ms de duración total local; esa cifra es tiempo de verificación de esquema+smoke, **no tiempo de pantalla, consulta de negocio o benchmark de volumen**.

El runner exporta `createMigratedDatabase(through)` y `applySqlFile(pg,file)` para experimentos separados: `through=156` permite cargar una base anterior real y aplicar luego 0157 al mismo fixture. Cierra la base al terminar. Los errores imprimen sólo código, archivo y mensaje acotado, nunca SQL completo.

## Estado de validación

| Evidencia | Estado |
|---|---|
| Lectores/rutas/SQL identificados con cotas y líneas | Completado por inspección estática |
| Diferencia entre N histórico, R temporal y A activo | Documentada |
| Índices de producción y planes reales | No comprobados |
| Requests/bytes/TTFB de usuario autenticado | No medidos en este subanálisis |
| Benchmarks 50k/200k/1M | Ejecutados posteriormente en el trabajo coordinado; resultados y límites en `master-scaling-benchmark-2026-09-25.json` y el informe principal |
| Cadena SQL real + smoke 0157 en PGlite aislado | PASS; es evidencia de corrección SQL/RLS, no latencia de producción |
| Cambios de aplicación o DB hechos por este subanálisis | Ninguno |
| Revisión exhaustiva de media/imports y cada mutación operativa | Pendiente; entradas inventariadas |
