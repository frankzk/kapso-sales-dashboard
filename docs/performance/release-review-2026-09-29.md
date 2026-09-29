# Revisión de impacto antes del despliegue

Estado de esta revisión inicial: **NO DESPLEGAR**. Revisión del PR #730, cabeza `983f0d0`.
Actualización posterior del mismo día: se incorporó `6d2cbf4`, se resolvieron los
conflictos, Master pasó a 0203 y se repitieron las pruebas sobre la integración.
El guard ahora verifica automáticamente orden y predicado exactos de índices.
Ver `night-release-2026-09-29.md` para el estado vigente, evidencia y respaldo
pendiente. Los hallazgos siguientes se conservan como registro de la revisión inicial.
No se ejecutó SQL ni se modificó la aplicación en producción durante esta revisión.

## Qué cambia en la base

La propuesta no mueve pedidos a otro servidor ni cambia sus reglas de negocio.
Sí añade dos tablas de contadores derivados, dos vistas, tres triggers de
mantenimiento, funciones e índices. La aplicación nueva consulta esos objetos;
publicar solamente el código dejaría una dependencia sin instalar.

El instalador toma un bloqueo de escritura de `order_master` mientras construye
los contadores históricos y activa los triggers. Las escrituras de usuarios y
sincronizaciones pueden esperar, incluso aunque no haya personas conectadas.
Una reinstalación o reversión también puede bloquear lecturas brevemente.

El instalador limita la espera por un bloqueo a 5 segundos y cada sentencia a
60 segundos. **No es una garantía de que toda la intervención dure 60 segundos**:
hay varias sentencias, creación previa de índices y verificación posterior.
No se ha medido la duración real sobre la base productiva.

## Hallazgo nuevo de compatibilidad

Al consultar GitHub, integración está en `5ff4767`, producción en `6d2cbf4` y el
PR aparece con conflictos (`DIRTY`). Se publicó
`0202_swayp_inventory_sessions.sql`, mientras el borrador también reserva 0202
para Master. Se debe integrar el estado vigente, asignar el siguiente número
libre a Master, regenerar los bundles y repetir los controles correspondientes.
No aplicar manualmente ninguno de los archivos del borrador como atajo.

Las pruebas y CI aprobados corresponden al candidato sobre `aa87ce0`; conservan
su valor como evidencia de esa versión, pero no validan una integración futura.
Los archivos principales del Master no cambiaron entre esa base y el main
consultado; sí cambió la cadena de migraciones y el proyecto incluye otros cambios.

## Ventana recomendada

Mientras el equipo trabaja, continuar con revisión local y pruebas aisladas.
Aplicar la instalación en una ventana de baja actividad, preferentemente por la
noche si efectivamente bajan tanto el uso humano como las sincronizaciones.
No hay hora programada ni autorización inferida para ejecutar por la noche.

Antes de esa ventana: resolver el conflicto, verificar respaldo recuperable y
versión anterior de la aplicación, comprobar requisitos e índices exactos.
Los scripts comprueban existencia, tabla, validez y disponibilidad de índices;
su definición exacta todavía requiere la comprobación explícita de DEPLOY.md.
Preparar índices concurrentes también consume recursos y no se ejecutó aquí.

En la ventana: controlar actividad y sincronizaciones, aplicar el instalador
con sus límites, comprobar integridad, publicar por el flujo de integración/main
y verificar lectura, guardado e ingestión. Ante un timeout o fallo de integridad,
detener la promoción e investigar; no ampliar límites ni repetir ciegamente.
La reversión del código por sí sola no desactiva los triggers de la base.

También se detectó un comentario antiguo en `lib/orders-master-access.ts` que
todavía menciona 0198; debe actualizarse al número definitivo al integrar.
