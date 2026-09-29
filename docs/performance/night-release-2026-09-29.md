# Preparación de la ventana nocturna — Master de Pedidos

Estado al 29-09-2026: **NO PROMOVER TODAVÍA**. Código integrado y pruebas
aisladas aprobadas; falta cerrar el respaldo recuperable de producción y las
comprobaciones de la ventana. No hay despliegue ni ejecución nocturna programados.

## Alcance y versión

Base de producción revisada: `6d2cbf4f94c6a65f7967d1d93cd97a1636ffa6e4`.
Integración revisada: `5ff4767115c78d7f8e0a311a257d99154451f40c`.
PR: https://github.com/frankzk/kapso-sales-dashboard/pull/730.

La migración candidata es `db/migrations/0203_master_read_scaling.sql`, después
de la 0202 publicada de Swayp. SHA-256:
`d53c2a6dd7c70cdddc2f2a9a279a96ab6bc06d63e98df64c4fd4fac5767e17c6`.
El SQL ejecutable de contadores es el mismo que el candidato anterior; cambió
su número para conservar intacta la cadena publicada. Nunca aplicar el antiguo
0202 de Master ni volver a ejecutar el bundle completo sobre producción.

Se conservan 100 pedidos visibles por página. Cambian la lectura, paginación y
los contadores derivados. Sí existe una migración de esquema: añade índices,
contadores, vistas y triggers; no traslada pedidos ni borra el historial.
Los pedidos, eventos y salidas físicas mantienen sus identidades y reglas.

## Evidencia comprobada

| Validación | Resultado y alcance |
| --- | --- |
| Aplicación integrada | 5.209 pruebas en 324 archivos; tipos y compilación aprobados |
| Cadena SQL | 203 piezas; PostgreSQL 16 real, permisos, operaciones, reversión y bundle aprobados |
| Guardas de publicación | 15 comprobaciones; incluyen índices con orden/predicado incorrectos, permisos y contadores dañados |
| Preservación PG17 | 113 tablas existentes, 137 funciones ajenas al cambio, 38 triggers y 133 políticas conservados al instalar, revertir y reinstalar |
| Fallos durante instalación | Error antes del commit revierte todo; un escritor bloqueante impide instalar y su cambio confirmado se conserva |
| Recuperación sintética | Un archivo pg_dump se restauró en otra base vacía PG17 y se verificó su contenido |
| Supabase de pruebas | Actualización a 0203 conservó huellas de 111 tablas, 420 pedidos, 417 eventos y 2 salidas físicas |
| Paginación y permisos | 100/100/100/100/20, navegación de regreso, conteos/filtros exactos y roles verificados |
| Aplicación HTTP | Exportación completa/filtrada/seleccionada, acceso por rol, página y comentario aprobados |
| Reconciliación real | Dos pasadas de 420 proyecciones: 840 escrituras, cero fallos; eventos e identidades de salidas conservados |
| Concurrencia SQL actual | 6.360 intentos sobre 50.000 pedidos, cero fallos y conteos consistentes |
| Automatizaciones | Los 18 horarios y el código de cron/webhooks/ingestión/reconciliación/backup son idénticos a la base de producción revisada |

Informes reproducibles: `validation-current-2026-09-29.json`,
`master-preservation-2026-09-29.json`, `master-postgres-smoke-2026-09-29.json`,
`master-release-guards-2026-09-29.json`, `master-concurrency-0203-2026-09-29.json`,
`master-staging-0203-read-2026-09-29.json`, `master-staging-http-2026-09-29.json`,
`master-staging-reconcile-2026-09-29.json` y `automation-preservation-2026-09-29.json`.

Estas pruebas no certifican riesgo cero ni todos los proveedores externos:
las pruebas usan pedidos sintéticos y no envían mensajes, cobran pagos ni
solicitan despachos reales. El primer intento HTTP tuvo acceso de red denegado
por el entorno local; la repetición con red habilitada aprobó todos los controles.

En la carga SQL corta, el p95 con 20 escritores subió 23,9% y 13,3% en dos
rondas; en la carga adversa con 5 escritores subió 56,7%. No ocultar ese costo.
Las pruebas previas de ingestión completa en Supabase dieron +13,4% y +0,9%
con 20 sesiones. Son cargas distintas: la integridad aprobada no demuestra
capacidad ilimitada ni permite ignorar una regresión sostenida en producción.
Los conteos exactos filtrados aún recorren coincidencias; enlaces antiguos con
número de página usan OFFSET. La cardinalidad de filtros históricos también
puede crecer. No afirmar que toda consulta es constante con un millón de pedidos.

## Respaldo y recuperación: pendiente real

Producción `pmihklgtbyuurpkrxtoz`: PostgreSQL 17.6,
`max_prepared_transactions=0`. El panel mostró un respaldo físico diario de
29-09-2026 08:36:13 UTC (03:36:13 Lima). PITR no está habilitado. Ese respaldo
no contiene el trabajo posterior a su hora y no sustituye una copia reciente.
El cron propio respalda únicamente leads, lead_calls y shipment_calls.

La conexión al pooler llegó al servidor, pero rechazó la contraseña de PostgreSQL
guardada localmente. No hay todavía un respaldo lógico completo de producción
validado. No restablecer credenciales durante la operación para resolver esto.
Corregir la contraseña existente en `.env.release.local`, que está excluido de
Git; no compartirla por chat ni colocarla en comandos o informes.

Preparado: `node scripts/backup-master-release.mjs --check` verifica únicamente
requisitos locales, **no autentica**. `--backup` conecta en modo de solo lectura,
genera un archivo privado, inspecciona su contenido y guarda tamaños/huellas
en `.release-backups/`. Un fallo deja `complete:false`. Incluso un archivo
completo mantiene `restoreVerified:false` hasta ensayar su recuperación.
No publicar estos archivos ni datos de clientes en Git.

Herramientas portables PostgreSQL 17.11 obtenidas de la página oficial de EDB:
https://www.enterprisedb.com/download-postgresql-binaries. El ensayo sintético
no prueba la recuperación del futuro respaldo productivo. El volcado completo
contiene objetos internos de Supabase; ensayar su recuperación en un entorno
compatible separado y comprobar tablas, permisos y relaciones antes de darlo
por recuperable. El contenido de archivos de Storage y las variables secretas
de Vercel son respaldos separados; esta migración no los modifica.

**Revertir esta mejora no requiere restaurar una copia antigua de la base.**
Restaurarla sobre producción borraría el trabajo posterior al respaldo. La
reversión preparada desactiva los contadores nuevos y conserva los pedidos y
eventos que hayan entrado entretanto. Recuperación de desastre es otro proceso,
con restauración aislada, reconciliación de cambios posteriores y decisión explícita.

## Secuencia para el operador, únicamente en la ventana acordada

1. Actualizar referencias remotas. Verificar que el commit aprobado, la base,
   la siguiente numeración SQL y los hashes siguen vigentes; cualquier cambio
   nuevo exige revisar su impacto. CI de esa versión debe estar aprobado.
   Registrar el despliegue anterior de Vercel y su commit, y comprobar cómo
   promoverlo de nuevo. Mantener variables, claves de cifrado e integraciones.
2. Confirmar baja actividad humana **y de sincronizaciones**. Los 18 crons
   siguen habilitados; no desactivar trabajos ni borrar colas. Observar bloqueos,
   errores, retrasos de ingestión y latencias de lectura/escritura antes de tocar
   la base. Resolver o posponer si ya hay una incidencia.
3. Obtener una copia reciente y comprobar su manifiesto y procedimiento de
   recuperación. Registrar hora y punto consistente. Si falta respaldo o acceso,
   posponer la instalación. El trabajo entre la copia y el cambio debe conservarse
   mediante la reversión específica; la copia no garantiza por sí sola pérdida cero.
4. Con conexión administrativa verificada al proyecto correcto, ejecutar
   `scripts/sql/master_read_scaling_prepare_indexes.sql` con `psql -X` y
   `ON_ERROR_STOP=1`, **sin** `BEGIN` ni `--single-transaction`. Prepara cuatro
   índices concurrentes y valida su definición exacta. En la revisión diurna
   faltaban los cuatro. Ante índice inválido, timeout o presión de recursos,
   detenerse e investigar; no subir límites ni eliminar índices a ciegas.
5. Ejecutar `scripts/sql/master_read_scaling_install.sql` con `psql -X` y
   `ON_ERROR_STOP=1`. Su transacción limita espera por bloqueos a 5 segundos
   y cada sentencia a 60 segundos. La primera instalación bloquea escrituras
   mientras llena los contadores; una reinstalación puede bloquear lecturas.
   Los límites son por sentencia, no duración máxima de toda la intervención.
6. Antes de publicar, ejecutar `scripts/sql/master_read_scaling_preflight.sql`
   con el mismo administrador y `ON_ERROR_STOP=1`. Es una comparación completa
   de conteos/filtros, índices, triggers y permisos en una instantánea de solo
   lectura. Exige éxito completo. No ejecutar los smokes de datos sintéticos
   ni `master_staging_upgrade_0203.sql` en producción.
7. Seguir AGENTS.md: PR a `claude/youthful-babbage-atjexn`, merge a integración,
   después avance de `main` exclusivamente por fast-forward; verificar que
   Vercel despliegue ese commit con destino production. Instalar SQL primero.
   Ningún preview conectado a producción debe servir código nuevo antes del SQL.
8. Revisar con usuarios/roles autorizados: 100 filas, siguiente/anterior,
   filtros/conteos, detalle y salidas físicas, exportación acotada, nuevos pedidos
   recibidos e historial. Para validar escrituras, observar una operación real
   autorizada y su evento; no inventar pedidos ni pagos de prueba en producción.
   Confirmar ingestión, reconciliación y ejecución de los crons en sus registros.
   No activar manualmente proveedores que envíen mensajes, cobren o despachen.
9. Comparar errores, retrasos, bloqueos y p95 con la línea base durante una ventana
   comparable y al siguiente período de actividad. Si hay pérdida/duplicación
   aparente, permisos incorrectos, fallos nuevos o regresión sostenida de escritura
   >20%, detener la promoción o revertir e investigar. Conservar evidencias sin PII.

## Reversión ensayada

Ante un timeout del instalador, su transacción revierte; conservar la aplicación
anterior y revisar bloqueadores. Los índices ya construidos pueden permanecer.
Si la instalación confirmó pero el preflight falla, no publicar la aplicación.

Si hace falta retirar la mejora, primero restaurar la versión anterior de la
aplicación y drenar todas las instancias/previews que lean los nuevos contadores.
Luego ejecutar `scripts/sql/master_read_scaling_rollback.sql` con `psql -X`
y `ON_ERROR_STOP=1`. Espera por bloqueo: 5 segundos; límite por sentencia:
30 segundos. No elimina pedidos, eventos, tablas ni índices. Los contadores
derivados dejan de actualizarse; para reactivar, ejecutar el instalador y
preflight, que reconstruyen su contenido antes de volver a servir el código nuevo.

No usar restauración completa del backup como reversión rutinaria. No resetear
claves, editar horarios, truncar tablas ni reproducir webhooks masivamente.

## Aviso operativo separado

El panel de Supabase advierte exceso de cuota y posibles restricciones desde
el 08-10-2026 si sigue sin resolverse. No se modificó facturación ni plan.
Debe revisarse independientemente de esta mejora.
