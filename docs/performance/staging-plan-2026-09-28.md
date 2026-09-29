# Validación de integración pendiente

Destino autorizado: proyecto gratuito `kapso-sales-staging`, organización
`Kapso pruebas`, São Paulo. Confirmar su identificador una vez creado. Nunca
usar el proyecto productivo `pmihklgtbyuurpkrxtoz` como destino de fixtures.

## Preparación

1. Instalar el esquema completo en la base nueva. **No ejecutar
   `scripts/sql/test_prelude.sql` en Supabase:** reemplaza Auth por una simulación
   exclusiva de las bases locales. Conservar el Auth administrado de Supabase.
2. Configurar una instancia local de la aplicación con las claves de ese proyecto
   de pruebas. No copiar `.env.local` productivo, webhooks, cron ni credenciales
   de Shopify, couriers, pagos, WhatsApp o correo de producción.
3. Crear datos ficticios: dos tiendas y perfiles de administrador, usuario con
   acceso a una tienda, usuario sin acceso y motorizado con un pedido asignado
   en dos rutas históricas. Usar el API de Auth para usuarios reales de prueba.
4. Preparar más de 300 pedidos, fechas iguales y nulas, varias etapas, regiones,
   couriers, pedidos sin lead y con varias salidas. Guardar el conjunto esperado
   de identificadores para comparar navegación, filtros y exportaciones.
5. Tomar referencia de la versión anterior con los mismos datos y condiciones;
   aplicar la candidata y pasar el control de integridad antes de comparar.

## Casos y aceptación

| Caso | Evidencia requerida |
| --- | --- |
| Inicio de sesión y aislamiento | Cada usuario ve solo sus tiendas/pedidos; el usuario sin acceso recibe cero resultados |
| RPC, vistas y rol de servicio | Conteos y opciones coinciden con consultas independientes de los pedidos autorizados |
| Motorizado | Un pedido en dos rutas cuenta una vez; no obtiene totales de toda la tienda |
| Navegación estable de 100 filas | Recorrer siguiente/anterior devuelve todos los IDs esperados una sola vez, incluyendo empates y fechas nulas |
| Filtros y gestión | Combinaciones de tienda, etapa, subetapa, gestión, courier y ubicación conservan resultados y conteos |
| Detalle y enlace directo | Abrir/cerrar y enlaces guardados mantienen identidad, datos e historial completos |
| Actividad simultánea | 1/5/20 sesiones con altas simuladas, proyección y acciones permitidas; sin errores no recuperados ni pérdida de eventos |
| Cambios mientras se navega | Refresco al volver a la pestaña, aviso en páginas posteriores y regreso al inicio; sin consultas superpuestas |
| Reintentos de sincronización | Repetir el mismo evento conserva idempotencia; no duplica pedido ni movimiento |
| Exportación | Mismos filtros y selección; límite existente y aviso de truncamiento explícitos |
| Reversión | Volver a la aplicación anterior, revertir los nuevos triggers/RPC y comprobar lectura/escritura; reinstalar y cotejar |

Registrar por operación p50/p95, errores, espera por bloqueos, pedidos recibidos
y proyectados, e IDs/eventos esperados contra confirmados. No promediar operaciones
rápidas para esconder una regresión de ingestión. Cero diferencias de integridad
y cero nuevos errores sin recuperar son obligatorios. El umbral de regresión de
escritura de `DEPLOY.md` también debe pasar antes de publicar.

Las pruebas de 50k/200k/1M de historial se hacen localmente con PostgreSQL real.
El plan gratuito no se debe llenar a costa de su límite ni usar como sustituto
de una medición de capacidad productiva. No conectar las integraciones reales
ni enviar mensajes o pagos durante estas validaciones.
