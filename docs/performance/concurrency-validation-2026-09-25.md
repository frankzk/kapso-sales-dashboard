# Validación de escrituras simultáneas del Master

Se compara la versión anterior (migraciones hasta 0156) con la optimizada
(0157) usando dos copias idénticas de pedidos ficticios. Ninguna prueba local
lee `.env.local`, recibe una URL remota ni se conecta a producción.

## Resultado local: no aprobar publicación todavía

La ejecución del 25/09/2026 terminó en PostgreSQL 18.4 real y el servidor local
quedó apagado. [Informe completo](master-concurrency-2026-09-25.json).

- Carga normal: **20.800 intentos** entre ambas versiones, dos rondas y niveles
  1/5/20 escritores. Cero fallos; altas/eventos confirmados, rollback, resúmenes,
  RPC y permisos pasaron las comprobaciones. Incluye UPSERT de 200 filas
  **existentes** por sentencia, no lotes mixtos de altas y actualizaciones.
- Estrés con varias sentencias Master en una transacción: versión anterior
  **0 fallos/100 intentos**; versión nueva **12 bloqueos mutuos/100 intentos**
  (`40P01`). PostgreSQL abortó esas operaciones; no se reintentaron. La fuente y
  los contadores de las operaciones confirmadas conservaron la integridad.
  Esto no equivale a que todos los intentos se aplicaron correctamente.
- Hay contención incluso en la carga normal: con 20 escritores se observaron
  hasta 19 esperando locks en la versión nueva. El throughput bajó un 13–17%
  en estas rondas; algunas operaciones individuales empeoraron aunque el p95
  global de la mezcla disminuyó.

| 20 escritores, carga normal | Anterior, ronda 1 / 2 | Nueva, ronda 1 / 2 |
|---|---:|---:|
| Transacciones confirmadas por segundo | 628 / 752 | 548 / 621 |
| p95 alta + proyección, ms | 5,24 / 7,54 | 53,50 / 46,29 |
| p95 cambio de etapa, ms | 8,01 / 8,47 | 64,50 / 40,30 |

Son dos ráfagas breves en un equipo Windows, con carga y lectores sintéticos.
No son una previsión del rendimiento productivo ni una prueba estadística de
capacidad. **Sí bastan para detectar que la propuesta actual necesita trabajo
antes de aprobarse**. El p95 agregado no debe ocultar regresiones de altas o
acciones individuales. No se avanzó automáticamente a 200k/1M tras este fallo.

Una segunda [prueba dirigida](master-mixed-upsert-2026-09-25.json) reprodujo el
problema con **una única sentencia UPSERT del Master por escritor**, mezclando
altas y actualizaciones en dos tiendas y usando pedidos distintos: antes
confirmaron ambos escritores; después confirmó uno y el otro sufrió un
deadlock. La integridad de las operaciones confirmadas volvió a pasar.

Esta prueba añade únicamente en la base ficticia un trigger de coordinación
que pausa a ambos escritores entre el mantenimiento UPDATE e INSERT. Fuerza
un intercalado permitido, sin modificar la migración productiva, y demuestra
la posibilidad del conflicto; **no mide su frecuencia natural ni su latencia
productiva**. La implementación ordena locks por evento de trigger, pero el
UPSERT mixto vuelve a adquirir locks de etapas después de los de facetas del
evento anterior. El lote normal del benchmark sólo actualiza filas existentes
y no cubría esta variante. La prueba es reproducible con:

```powershell
node scripts/verify-master-mixed-upsert.mjs
```

El escenario adverso de varias sentencias y este intercalado forzado no deben
presentarse como si fueran una medición del webhook habitual de la aplicación.

## Prueba reproducible de base de datos

```powershell
# Dependencias de prueba, fuera del package.json de la aplicación.
npm install --prefix ../.performance-tools --ignore-scripts --no-audit --no-fund @embedded-postgres/windows-x64@18.4.0-beta.17 pg@8.23.0
node scripts/verify-master-concurrency.mjs
```

El runtime usa PostgreSQL real con procesos/conexiones independientes,
escucha únicamente en `127.0.0.1`, crea un clúster nuevo por ejecución y lo
apaga al finalizar. Conserva datos ficticios y logs para investigar fallos en
`../.performance-tools/pg-runs`. No instala un servicio de Windows. En este
equipo el token restringido del sandbox impide `initdb`; la ejecución local
requiere el permiso de procesos correspondiente, sin cambiar la conexión.
Los binarios proceden de [embedded-postgres](https://github.com/leinelissen/embedded-postgres).

La configuración inicial usa 50.000 pedidos, dos tiendas, dos rondas de
1/5/20 escritores y dos lectores simultáneos. Se alterna el orden de ejecución
anterior/nueva para reducir el sesgo de caché. Todos los escritores esperan
una barrera y tienen un PID de PostgreSQL distinto.

La carga combina altas, proyecciones por UPSERT, cambios de estado, lotes de
proyección y transacciones que revierten deliberadamente. Muchos pedidos
comparten los mismos contadores, para provocar contención donde realmente
puede aparecer. Una fase adicional ejecuta varias mutaciones del Master en
una misma transacción; se identifica por separado como estrés adverso.

Después de cada fase se comprueba:

- Pedidos y proyecciones coinciden con las altas confirmadas; no hay huérfanos.
- Los eventos confirmados coinciden con lo esperado; los datos de operaciones
  revertidas no permanecen.
- Cada contador de etapa y referencia de faceta coincide exactamente con una
  recomputación de la fuente en una instantánea consistente.
- Los RPC conservan sus resultados y los permisos por tienda funcionan para
  servicio, usuario de una tienda y usuario sin acceso.
- Todos los escritores completaron sus iteraciones; cualquier SQLSTATE,
  bloqueo mutuo, timeout o error de lectura queda visible. No se reintentan
  fallos silenciosamente para hacer pasar la prueba.

El informe JSON incluye p50/p95 de transacciones SQL, rendimiento, observaciones
de bloqueos, errores y verificaciones. Son mediciones locales del cliente SQL,
no tiempos HTTP ni la capacidad de Supabase/Vercel. Las conexiones de escritura
usan el rol de servicio; los lectores prueban roles de servicio y autenticado.
`auth.uid()` se simula con el preámbulo de pruebas, sin utilizar Supabase Auth.

Para repetir con otras escalas, conservando informes separados:

```powershell
node scripts/verify-master-concurrency.mjs --size=200000 --output=docs/performance/master-concurrency-200k.json
node scripts/verify-master-concurrency.mjs --size=1000000 --output=docs/performance/master-concurrency-1m.json
```

No se avanza automáticamente a más volumen si la primera escala descubre un
fallo. Los resultados de lectura 50k/200k/1M ya existentes no sustituyen esta
prueba de escritura concurrente.

## Validación completa en staging

Esta segunda capa requiere un proyecto Supabase de pruebas y una instancia de
la aplicación conectada a él. Deben utilizarse cuentas, tiendas, secretos de
webhook y pedidos de prueba; las integraciones externas deben tener destinos
de prueba o estar sustituidas por respuestas controladas para evitar envíos,
mensajes o cobros reales. No se copian las credenciales de tiendas productivas.

1. Preparar dos entornos equivalentes con la versión anterior/nueva, misma
   región, capacidad y distribución de datos. Repetir 50k/200k/1M y tiendas
   desiguales; registrar capacidad y configuración reales.
2. Ejecutar sesiones autenticadas con permisos distintos. Mientras consultan
   100 pedidos, filtran, avanzan/retroceden y abren detalles, generar cambios
   mediante las acciones reales de la aplicación.
3. En paralelo enviar webhooks Shopify firmados con el secreto de la tienda
   ficticia, volver a entregar los mismos eventos y ejecutar sincronización
   contra el origen de prueba. Incluir lotes de 200 proyecciones, cambios
   coincidentes sobre un pedido y respuestas demoradas/fallidas del proveedor.
4. Registrar por identificador sintético: evento recibido, pedido persistido,
   proyección actualizada y dato visible. Verificar que todo evento aceptado
   llega a su estado esperado, que la redelivery no duplica pedidos y que los
   fallos quedan recuperables/visibles; un HTTP 200 por sí solo no demuestra
   que terminó la proyección.
5. Medir p50/p95 de la acción completa, errores, locks, backlog y retraso entre
   fuente y Master con la misma tasa de llegadas. Mantener cada nivel al menos
   10 minutos y repetirlo: una ráfaga corta local no certifica carga sostenida.
6. Ejecutar el control de integridad read-only al drenar las escrituras,
   verificar permisos con autenticación real y ensayar reversión/reinstalación
   únicamente sobre staging, según `DEPLOY.md`.

La prueba de paginación debe distinguir una lista estable de una cola que
cambia: en la lista estable se exige visitar exactamente todos los IDs. En una
cola viva, cambiar fecha/estado/filtro puede mover un pedido a una parte ya
recorrida; se comprueba el aviso de actualización y que «Volver al inicio» lo
encuentra. No se promete una instantánea congelada que la aplicación no ofrece.

## Condición para publicar

Cero diferencias de integridad y permisos, ninguna escritura nueva fallida sin
recuperación y ninguna acumulación sostenida de sincronización. El presupuesto
inicial documentado detiene la publicación si el p95 de escritura **completa**
empeora sostenidamente más de 20% frente al mismo escenario anterior. Ese
umbral no se aplica automáticamente a microtiempos de SQL local ni sustituye
un presupuesto operativo acordado. Una regresión SQL local es una señal para
investigar antes de promover, aunque las lecturas sean más rápidas.

La prueba local no ejecuta los handlers de webhooks, autenticación real,
proveedores externos, navegador, red ni el cron completo. La validación de
staging sigue siendo necesaria para aprobar la publicación.
