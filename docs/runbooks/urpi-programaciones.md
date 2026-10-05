# Programaciones mensuales de Urpi

La pantalla `/dashboard/urpi` conserva lo enviado a Urpi. No infiere entrega,
custodia, cobro ni liquidación a partir de las pestañas de programación.

## Instalación

1. Aplicar `db/migrations/0215_urpi_programming.sql` y
   `db/migrations/0216_urpi_auto_sync.sql` antes de desplegar.
2. Registrar el enlace y mes. Por defecto se registra para Kenku y Aurela a la
   vez (libro mixto): se crea una fuente por tienda con el prefijo de
   `stores.order_prefix` (KP, AUR); no se escribe a mano. Una tienda sin prefijo
   o con un prefijo que se solape con otro no se registra. La separación por
   tienda permite aplicar la misma autorización de lectura que el Master.
3. Cargar el libro mensual completo `.xlsx` descargado de Google Sheets o
   configurar la lectura de Google descrita abajo. En un libro mixto basta con
   hacerlo una vez desde cualquiera de sus tiendas: «Actualizar desde Google» y
   «Cargar Excel del mes» leen el libro una vez y guardan Kenku y Aurela, cada
   una con su versión. Si una falla (o el usuario no tiene `sheets.edit` en
   ella), la otra se guarda igual y el aviso dice qué pasó con cada tienda.

El registro exige `sheets.manage` y la importación `sheets.edit`, evaluados en
la organización de la tienda. La lectura usa `auth_store_ids()` mediante RLS.

## Lectura de Google

El conector de Google Drive de una conversación de Codex no entrega credenciales
a Kapta. La aplicación necesita una conexión propia:

1. Habilitar Sheets API en un proyecto de Google Cloud y una cuenta de servicio.
2. Configurar `URPI_GOOGLE_CLIENT_EMAIL` y `URPI_GOOGLE_PRIVATE_KEY` solo en el
   servidor. La clave puede contener saltos de línea reales o `\n`.
3. Compartir los archivos mensuales específicos como **lector** con esa cuenta.
   No requiere acceso a todo Drive ni delegación de dominio.
4. Pulsar **Actualizar desde Google**. La conexión usa exclusivamente el scope
   `spreadsheets.readonly`, descubre pestañas por metadata y lee rangos acotados
   A:O del mes solicitado. No modifica el archivo de Urpi.

También se puede ejecutar la lectura con el botón, además del proceso periódico
descrito abajo. Si no hay credenciales, la pantalla explica que la conexión está
pendiente y mantiene habilitada la carga de Excel. AppSheet no está integrado.

## Lectura automática

- Endpoint `/api/cron/urpi-programming`, programado cada 15 minutos, todos los
  días. Requiere `Authorization: Bearer <CRON_SECRET>`; no admite secreto en URL.
- Vercel lo ejecuta en producción. Previews se omiten; sin credenciales de Google
  tampoco se consulta la base. `URPI_AUTO_SYNC_ENABLED=false` permite pausarlo.
- Consulta únicamente fuentes ya registradas del mes anterior, actual y siguiente
  según `America/Lima`. Cada nuevo archivo mensual debe registrarse y compartirse
  como lector con la cuenta de integración. Meses antiguos: actualización manual.
- Procesa hasta 12 fuentes por ciclo, empezando por el intento más antiguo.
  Con más fuentes o respuestas lentas, algunas pasan al siguiente ciclo. Un libro
  Kenku/Aurela se descarga una sola vez por ejecución y se separa por prefijo.
- Reserva de 6 minutos por fuente e intervalo mínimo de 10 minutos entre intentos;
  la reserva caduca si se interrumpe la función. Solo su propietario puede liberarla.
  El lector tiene 60 segundos por libro y el barrido deja de tomar fuentes tras
  180 segundos, dentro de los 300 segundos máximos del endpoint.
- Reutiliza las versiones inmutables: sin cambios no hay otra versión; una lectura
  fallida no vacía ni reemplaza datos. Guarda actor nulo para la ejecución de sistema.
  La hora original de lectura se conserva aunque se reutilice para otra tienda,
  evitando sobrescribir una importación manual posterior con datos anteriores.
- La pantalla muestra último intento, última lectura automática correcta y errores.
  Un fallo devuelve HTTP 503 para observabilidad y se reintenta en el siguiente ciclo.
  Los logs y respuestas del cron no incluyen filas, destinatarios ni credenciales.
- No es una automatización de este chat: funciona en el servidor aun con Kapta cerrado.

## Integridad

- Snapshot mensual inmutable por cambio, con usuario, origen y hora. Reimportar
  el mismo contenido actual no crea otra versión.
- El RPC guarda snapshot y puntero actual en una transacción y serializa las
  lecturas concurrentes. Una solicitud iniciada antes de la última aceptada
  no puede reemplazarla.
- Una lectura con pestañas faltantes frente a la anterior se rechaza. Fechas
  contradictorias y duplicados se señalan; las filas anteriores permanecen
  disponibles desde el historial.
- No se crean pedidos Shopify, salidas, intentos de reparto ni movimientos de
  dinero. Un pedido no encontrado queda sin vincular.
- El prefijo y código completo se cruzan dentro de una única tienda. Varias
  coincidencias quedan a revisión; no se cruza por nombre o teléfono.
- El conteo y monto mostrado son de **programaciones**, no ventas únicas: un
  pedido presente en dos días figura en ambas fechas. Los duplicados de una
  misma fecha se marcan.
- Google exporta pestañas como `01/10/26` a Excel con el nombre `011026`.
  El lector restaura esa fecha para mantener la identidad entre ambos orígenes.
  Las fórmulas sin resultado almacenado no se ejecutan: se usa la fecha de la
  pestaña y se señala «Fecha tomada de la pestaña» para revisión.

## Reprogramación confirmada por operación (01/10/2026)

En Urpi, «Reprogramado» significa el día siguiente de lunes a sábado. Viernes
pasa a sábado y sábado a lunes. La fecha base es la del reporte de Urpi, nunca
la de importación. No se excluyen feriados porque no se indicó esa excepción.
`nextUrpiDeliveryDate` implementa esta regla, con pruebas de cambio de mes/año.
Se aplicará al integrar reportes; esta pantalla no convierte programaciones
en reportes de entrega ni cambia fechas por sí sola.

## Resultados de entrega (reporte de Urpi)

`/dashboard/urpi?vista=resultados` (pestaña «Resultados de entrega»). MOM §30.11.

1. Aplicar `db/migrations/0228_urpi_report.sql` **antes** de desplegar el código
   que la usa (DEPLOY.md: desplegar no aplica migraciones).
2. En la plataforma de Urpi, «Reporte del mes – detallado» → **Exportar**. Sale
   un `.csv` («AppSheet.ViewData…») con una fila por intento.
3. Pulsar **Cargar reporte de Urpi** y elegir ese archivo. Se puede cargar el
   export completo cada día: lo ya guardado no se reescribe, solo entra lo nuevo
   o cambiado, y cada cambio deja versión.
4. Revisar las listas:
   - **Entregados por marcar**: seleccionar y «Marcar entregados». Exige
     `master.edit`. Pasa por `lib/master-door.ts` como la liquidación.
   - **Cancelados por Urpi** y **Reprogramados**: para Seguimiento Lima; no
     cambian el Master.
   - **Por vincular**: elegir el pedido de la lista o escribir su código. Se
     vincula toda la cadena de intentos y queda como manual.
   - **Observaciones**: Urpi dice entregado y Kapta lo tiene anulado o devuelto.

El vínculo es por teléfono (el reporte no trae código de pedido): un único
pedido de Kenku o Aurela con ese teléfono creado en los 45 días previos al envío.
Con varios, decide una persona. Si Urpi añade algún día el código de pedido a su
export, conviene usarlo y retirar el cruce por teléfono.

Verificación: `npm test -- test/urpi-report.test.ts test/urpi-report-link.test.ts test/urpi-report-import.test.ts`
y, en un Postgres desechable, `bash scripts/verify-urpi-report.sh` (RLS por
tienda y organización, versiones por cambio, vínculo manual que ninguna lectura
pisa, pedidos solo de la misma organización). Nunca contra Supabase.

Validación con datos reales (05/10/2026): el export de Urpi del 04/10 (2307
intentos, febrero–octubre) se lee completo: 1086 reprogramados, 686 cancelados,
513 entregados, 22 sin resultado o programados, 0 estados desconocidos; 1072
reintentos encadenados sin ninguno huérfano. Contra Kapta, solo con conteos: de
los 422 intentos de septiembre y octubre, 395 tienen un único pedido por
teléfono. De los pedidos que Urpi dio por entregados en ese periodo, 38 seguían
«en proceso» en Kapta, 22 entregados y 6 anulados.

## Verificación

`npm test -- test/urpi-programming.test.ts test/urpi-programming-access.test.ts test/urpi-register-source.test.ts test/urpi-book-import.test.ts test/urpi-google-sheets.test.ts test/urpi-excel.test.ts`
y `npm run typecheck`.
Para el proceso periódico: `npm test -- test/urpi-auto-sync.test.ts test/urpi-auto-route.test.ts`.

La prueba de SQL requiere el runtime PostgreSQL local aislado:
`node scripts/verify-urpi-programming.mjs <ruta-a-local-postgres-runtime.mjs>`.
Comprueba RLS, escritura solo de servidor, snapshots idempotentes y atómicos,
aislamiento por tienda y rechazo de lecturas atrasadas. Nunca usa DATABASE_URL.

### Resultado de la validación local (01/10/2026)

- 63 pruebas de lector, permisos, fechas, cron y navegación relacionadas; 26 checks
  sobre PostgreSQL local aislado. TypeScript sin errores.
- Lectura de las 53 pestañas reales de septiembre y octubre: 208 programaciones
  con código en esa lectura, y una fila sin código señalada para revisión.
- Excel real de octubre: 27 pestañas, 6 programaciones KP y 1 AUR; fechas
  recuperadas de las pestañas cuando la fórmula exportada carece de caché válido.
- Componente verificado en una página temporal local con datos anonimizados:
  búsqueda, filtro por fecha, totales y selector de archivo de ejemplo.
  La página temporal se eliminó; no forma parte del módulo.
- La compilación completa en el preview de Vercel terminó correctamente el
  02/10/2026. Los fallos locales de compilación no se reprodujeron en Vercel;
  el entorno local usa una unión de `node_modules` fuera de la raíz que
  Turbopack rechaza.

Las migraciones 0215 y 0216 se aplicaron en producción el 02/10/2026. Se verificaron
RLS, lectura por usuarios autenticados y escritura/RPC solo de servidor. No se
importaron datos en producción. La lectura de Google dentro de Kapta sigue
pendiente de las credenciales y acceso descritos.
