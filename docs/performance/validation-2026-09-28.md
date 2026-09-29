# Validación del Master — 28 de septiembre de 2026

**No aprobado para producción.** Se corrigió la concurrencia y se amplió la
verificación sobre el código actual, pero falta la validación completa con
Supabase Auth, PostgREST y la aplicación. También falta aprobar el costo de
escritura observado bajo carga. No se ejecutaron migraciones en producción.

## Versión y corrección

- Base: `origin/main` `c886febd96a057a1367d77ce4e1115c7bc86e4f8`, esquema 0197.
- Rama local: `codex/master-concurrency-20260928`.
- Candidata: `db/migrations/0198_master_read_scaling.sql`. La 0157 del repositorio
  actual pertenece a otro cambio; los informes del 25/09 describen una propuesta
  anterior que nunca debe sustituir esa migración publicada.
- Los contadores compartidos se sustituyeron por partes firmadas por conexión
  PostgreSQL. Las vistas suman esas partes dentro de la misma transacción y
  respetan los permisos del lector. No hay actualización diferida ni reintentos
  que escondan fallos de escritura.
- Requiere PostgreSQL 16+ y transacciones preparadas deshabilitadas. El arranque
  de la migración y el control de publicación comprueban ambos requisitos.
- Se conservaron los cambios recientes del Master, el filtro de días de gestión,
  los enlaces al detalle y la visibilidad parcial de pedidos de los motorizados.
- Las pruebas reales en PostgreSQL 16 detectaron dos problemas adicionales:
  evaluación de permisos de una función exclusiva del motorizado desde el rol
  de servicio, y reutilización de resultados de filtros al cambiar roles en una
  conexión. Se corrigieron mediante funciones PL/pgSQL con permisos del invocador
  y una rama exclusiva para el motorizado. La regresión prueba varios roles en
  una sola conexión y también en un único mensaje del protocolo.

## Evidencia terminada

| Verificación | Resultado |
| --- | --- |
| Suite de aplicación | 320 archivos, 5,111 pruebas pasan |
| Compilación Next.js | Pasa; sin copiar credenciales de producción |
| Esquema completo y pruebas de integridad aisladas | Pasan |
| Instalación, permisos, detección de daño y reversión | 13 comprobaciones pasan en PGlite |
| PostgreSQL 16 real: pruebas SQL operativas, permisos, reversión y bundle | Pasa; informe `master-postgres-smoke-2026-09-28.json` |
| UPSERT mixto dirigido, dos conexiones | Ambas confirman, cero deadlocks; informe `master-mixed-upsert-current-pg16-2026-09-28.json` |
| Carga simultánea con 50,000 pedidos | 21,000 intentos entre ambas versiones; cero fallos y diferencias |
| Carga simultánea con 200,000 pedidos | 21,000 intentos entre ambas versiones; cero fallos y diferencias |
| Carga simultánea con 1,000,000 pedidos, revisión final | 21,000 intentos entre ambas versiones; cero fallos y diferencias, incluidas las lecturas simultáneas y el escenario adverso |

Los ensayos de 50k y 200k contienen dos rondas, 1/5/20 escritores, lectores
simultáneos con rol de servicio y de usuario, seis operaciones de escritura y
rollback deliberado. Incluyen un escenario adverso con varias sentencias por
transacción. Un rollback deliberado es un resultado esperado, no una alta
confirmada. Cada JSON conserva el hash exacto de la migración ensayada.
Estos dos informes preceden al último ajuste de las funciones de lectura y
deben distinguirse de la validación final de esa revisión.

Informes: `master-concurrency-current-50k-pg16.json` y
`master-concurrency-current-200k-pg16.json`. Los servidores locales se apagan al
terminar y conservan sus directorios de datos y logs. Los pedidos son ficticios.

La corrida final está en `master-concurrency-current-1m-pg16.json`, con su hash
de migración y cierre correcto del servidor. Contiene 20,800 intentos normales y
200 del escenario adverso; todos sus controles de integridad pasan.

Las pruebas SQL reales incluyen los casos del proceso de integración para hojas
de motorizados, Master, cobertura, historial inmutable, ventas, cola de leads,
despacho, recepción y cargas GF, devolución a oficina y evidencia de pagos.
El ejecutor adicional no sustituye la comparación específica TS/SQL de rollups
que realiza `scripts/verify-db.sh` en CI.

## Rendimiento: aún no aprobar

Con 50k y 20 escritores, primera ronda, las medianas de lecturas con rol de
servicio pasaron de 70.3 a 1.3 ms para la página, de 46.1 a 1.2 ms para conteos y
de 241.6 a 1.7 ms para valores de filtros. Son tiempos SQL locales bajo esa
carga, no tiempos de pantalla ni promesas para Supabase.

El lector autenticado de este ensayo solicita las dos tiendas aunque solo tiene
acceso a una: es una comprobación adversa de permisos. Su lectura de página
todavía crece con el historial. La aplicación obtiene primero las tiendas
autorizadas, pero se debe medir su consulta real con ese rol y comprobar el plan
antes de aprobar la escalabilidad. No extrapolar los tiempos del rol de servicio
a la experiencia del usuario ni ocultar esta diferencia.

La escritura necesita más evaluación: en el estrés corto de 50k, el p95 global
pasó de 57.2 a 155.1 ms. En 200k ese estrés pasó de 66.0 a 63.9 ms, pero varias
rondas normales empeoraron más del 20%. El entorno compartido y las muestras
cortas introducen variación; no se descartan las regresiones porque otras
rondas sean mejores. El criterio de publicación de `DEPLOY.md` sigue vigente.

Con un millón y 20 escritores, el p95 global de escritura fue 93.5→92.9 ms en
la primera ronda y 88.5→92.4 ms en la segunda. Sin embargo, el p95 de ingestión
individual pasó de 4.36→6.85 ms y de 4.08→7.80 ms respectivamente. Esta diferencia
no queda aprobada por el buen p95 global. El escenario adverso fue 60.0→55.5 ms.
En la primera ronda, las medianas del rol de servicio fueron 192.9→1.46 ms para
la página, 196.7→0.43 ms para conteos y 1558.2→1.46 ms para valores de filtros.
La página del lector autenticado adverso fue 437.3→400.0 ms y sigue pendiente
la comprobación del plan de la consulta real con solo tiendas autorizadas.

Pendiente: tiempos de ingestión y acciones **de extremo a extremo**, comportamiento
de la aplicación y mediciones repetidas en un entorno comparable. El umbral
del 20% de `DEPLOY.md` se aplica a ese recorrido completo; los tiempos SQL por
sí solos no lo aprueban ni permiten asegurar cómo será la pantalla. El plan
gratuito permite validar integración; no
representa la capacidad ni los límites de almacenamiento de producción.

## Entorno de pruebas

Se creó la organización **Kapso pruebas**, plan Free, por elección del usuario.
Quedó preparado **kapso-sales-staging**, región São Paulo. La creación de la base
está pendiente del paso de contraseña que completa el usuario en el navegador.
No se creó el proyecto adicional de US$10/mes de la organización productiva.

El panel de la organización productiva muestra una advertencia de cuota y posible
restricción desde el 08/10/2026. Este trabajo no modificó su facturación.

## Límites que siguen abiertos

- Se mantienen **100 filas por pantalla**. El cambio está en cómo se consultan,
  cuentan y recorren los pedidos, no en reducir la cantidad visible.
- Los conteos exactos con filtros arbitrarios aún dependen de las coincidencias;
  los enlaces antiguos de página numérica siguen usando OFFSET.
- Los valores históricos distintos de filtros pueden acumular partes que se
  cancelan. Deben medirse y compactarse durante una reinstalación controlada;
  no se promete costo constante para una cantidad ilimitada de valores distintos.
- La exportación conserva su tope previo de 20,000 y aviso de truncamiento.
- Navegar una cola que cambia no equivale a una foto congelada: un pedido puede
  entrar o salir de un filtro por una acción legítima. Hay que comprobar la
  navegación completa con datos estables y, por separado, el aviso de cambios
  y regreso al inicio durante actividad concurrente.
- Las ramas remotas de integración y producción ya estaban divergidas. Antes de
  publicar se debe completar el flujo de `AGENTS.md`: PR a integración y avance
  de producción por fast-forward. No se ha hecho merge ni despliegue.

Los siguientes casos están descritos en `staging-plan-2026-09-28.md`.
