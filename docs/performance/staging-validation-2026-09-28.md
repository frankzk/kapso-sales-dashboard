# Validación en Supabase de pruebas

## Estado y versión

La concurrencia corregida y la integración Auth/PostgREST/aplicación pasaron los
casos descritos abajo. **Producción no se modificó ni se desplegó.** Antes de
promover quedan CI del PR, revisión y preparación de la migración productiva
con índices concurrentes, respaldo, ventana y control de integridad de DEPLOY.md.

- Base integrada: `aa87ce0`, esquema productivo 0201. Producción e integración
  ya estaban alineadas al comprobarlas nuevamente.
- Candidata: `0202_master_read_scaling.sql`. La anterior candidata 0198 fue
  renumerada porque otra funcionalidad publicó 0198–0201 durante las pruebas.
  El SQL ejecutable de los contadores no cambió con la renumeración.
- Supabase: `kapso-sales-staging`, organización `Kapso pruebas`, Free/Nano,
  São Paulo, referencia `zuloxsrfcwhefedgfcnb`, PostgreSQL 17.6,
  `max_prepared_transactions=0`.
- Aplicación: compilación de producción ejecutada localmente en el puerto 3100.
  Solo claves de staging en archivos locales ignorados por Git. Sin tokens de
  Shopify, courier, pagos, correo o WhatsApp; sin activar cron ni enviar mensajes.
- 23 usuarios ficticios en Auth real, dos tiendas y 420 pedidos ficticios.
  No se ejecutó `test_prelude.sql` contra Supabase.

## Resultados comprobados

| Control | Resultado |
| --- | --- |
| Pruebas de la versión integrada | 5.189 pruebas, 323 archivos, compilación correcta |
| PostgreSQL 16 real, esquema completo 0202 | Migraciones, RLS, tests operativos, cambio de rol en una conexión, preflight, reversión/reinstalación y bundle correctos |
| Guardas de publicación | 13 controles correctos, incluyendo fallos deliberados de permisos, índices y contadores |
| Roles Supabase | Administrador: 420; usuario de tienda A: 210; sin acceso: 0; motorizado: 1 |
| Motorizado | Dos rutas históricas con el mismo pedido producen un solo pedido y un solo conteo |
| Paginación real PostgREST | 100/100/100/100/20 y regreso exacto, incluyendo fechas iguales, microsegundos y nulas |
| Conteos y opciones | Coinciden con lectura independiente de todas las filas autorizadas para cada rol |
| Navegador | Inicio de sesión, 100 filas, siguiente sin duplicados, anterior exacto, filtro tienda+región, detalle, comentario y autor en historial |
| Cambio durante navegación | Aviso visible en página 2 sin abandonar esa página; «Volver al inicio» vuelve a página 1 y conserva los filtros |
| Pedido con varias salidas | Dos salidas y dos QR distintos conservados tras dos recálculos; un solo pedido en Master |
| Exportación HTTP real | 420 completos, 140 tienda+región, 140 etapa+subetapa, búsqueda vacía, 210 para usuario limitado, selección de 6 y aislamiento de 3 |
| Aplicación con sesión limitada | Solicitar ambas tiendas o IDs de la otra tienda no amplía el acceso; usuario sin tiendas obtiene 403 al exportar |
| Concurrencia Supabase | Dos rondas de 1/5/20 usuarios: 208 ingestiones+proyecciones y 208 eventos por versión; sin errores ni diferencias de integridad |
| Reintentos de fuente | Tres repeticiones mantienen un pedido y una proyección |
| Reversión Supabase | Aplicación detenida; lectura y escritura correctas; reinstalación conserva los mismos 420 IDs y 417 eventos |
| Esquema actual integrado | Concurrencia normal/adversa local repetida, 6.360 intentos, cero fallos; roles/páginas/conteos PostgREST repetidos en 0202 |

La exportación de selección tenía un fallo previo: un error en un lote posterior
devolvía silenciosamente lo ya leído. Se corrigió para rechazar la descarga
completa y se añadió una prueba con 501 IDs y fallo deliberado del segundo lote.

## Tiempos y alcance de las mediciones

Supabase Free desde esta máquina, recorrido real de escritura del pedido y
`recomputeOrderMaster` por HTTP (no solo el INSERT). Cada escenario tuvo dos
rondas; para 20 usuarios hubo 80 observaciones por ronda y versión.

| Usuarios | p95 antes, rondas 1/2 | p95 después, rondas 1/2 |
| --- | --- | --- |
| 1 | 4.641 / 3.378 ms | 3.211 / 3.170 ms |
| 5 | 3.971 / 3.740 ms | 3.561 / 3.436 ms |
| 20 | 3.375 / 3.377 ms | 3.829 / 3.408 ms |

En el escenario de 20 usuarios, las variaciones fueron +13,4% y +0,9%; no hubo
regresión sostenida mayor al 20% en este recorrido medido. No sustituye una
prueba de capacidad con tráfico de proveedores, tamaño real de payloads o una
medición del retraso de ingestión productivo. La primera ronda también incluyó
actividad de navegador; no atribuir cada diferencia exclusivamente al trigger.

Las medidas iniciales se tomaron con esquema 0197 y la candidata aún llamada
0198. Tras integrar 0198–0201 se repitieron las pruebas SQL completas,
concurrencia local y lecturas/HTTP de staging. El ensayo breve adverso local
actual conserva una regresión p95 (37→65 ms); se documenta y no se presenta como
una mejora de capacidad bajo transacciones adversas.

El seguimiento local sobre 50k, 200k y 1M aclaró la lectura autenticada que antes
parecía lineal: el ensayo anterior solicitaba también una tienda no autorizada.
Con el alcance de tiendas que usa la aplicación, la consulta de 101 filas con
usuario limitado tardó aproximadamente 0,4–0,6 ms en caliente tanto al inicio
como en una página profunda. A 1M, conteos ~0,9 ms y opciones ~1 ms. Son tiempos
SQL locales, no tiempos de pantalla. Los planes de 50k/200k conservan el hash de
una revisión anterior; el de 1M corresponde al SQL final antes de renumerar.

## Límites y condiciones de publicación

- Se mantienen 100 filas. No hay promesa de una fotografía inmutable si otros
  usuarios cambian legítimamente los filtros de un pedido mientras se navega.
- Los conteos exactos de filtros arbitrarios siguen dependiendo del número de
  coincidencias. Las URLs antiguas numéricas siguen usando OFFSET. No afirmar
  costo constante para todas las combinaciones ni para valores de faceta ilimitados.
- El límite existente de exportación de 20.000 filas y aviso explícito permanece.
- El navegador de Codex no notificó el evento de descarga al pulsar el botón;
  el endpoint real sí generó Excel válido y se cotejaron sus filas con ExcelJS.
  El guardado final del archivo desde ese navegador no se da por comprobado.
- El aviso/refresco y regreso al inicio se comprobaron en el navegador; la
  supresión de consultas ocultas/superpuestas tiene cobertura automatizada.
  No se recorrió cada combinación de courier y gestión ni se conectaron las
  integraciones externas reales del equipo.
- En la instalación vacía se detectó `aliclik_cod_points` sin RLS en el esquema
  publicado. Solo en staging se habilitó RLS y se revocó acceso directo a
  anon/authenticated; se mantuvo el acceso controlado del servidor. No se cambió
  producción por este hallazgo ajeno a los contadores.
- No aplicar 0202 sin los cuatro índices válidos, requisitos PG, respaldo,
  ventana y preflight. La primera construcción de resúmenes toma un bloqueo de
  escritura; el plan gratuito no prueba cuánto tardará en la base productiva.

## Evidencia reproducible

- `master-staging-before-2026-09-28.json`, `master-staging-after-2026-09-28.json`.
- `master-staging-0202-read-2026-09-28.json`, `master-staging-http-2026-09-28.json`.
- `master-staging-rollback-2026-09-28.json` conserva los IDs ficticios cotejados.
- `master-staging-outputs-2026-09-28.json` conserva las identidades de las salidas.
- `master-concurrency-0202-current.json`, `master-postgres-smoke-2026-09-28.json`.
- `master-authorized-plans-2026-09-28.json` y los informes históricos 50k/200k/1M.
- Scripts `seed-master-staging.ts`, `verify-master-staging.ts`,
  `verify-master-staging-http.ts` y `verify-master-staging-rollback.ts` rechazan
  cualquier destino distinto de `zuloxsrfcwhefedgfcnb`.

Las claves y contraseñas no forman parte de estos informes ni del repositorio.
