---
target: components/shipments.tsx
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 3
target_identity: "file:/home/user/kapso-sales-dashboard/components/shipments.tsx"
target_fingerprint: "sha256:e35b5ca807304ac7bf10c1aed5cedf85dd1082272d47264dbf319d2e1255149e"
target_path: /home/user/kapso-sales-dashboard/components/shipments.tsx
timestamp: 2026-09-14T02-00-38Z
slug: components-shipments-tsx
---
Method: dual-agent (A: design review · B: detector + grep evidence).

## Design Health Score

| # | Heurística | Puntaje | Problema clave |
|---|---|---|---|
| 1 | Visibilidad del estado | 3 | La cola nunca se refresca sola; «Tomada» no expira sin re-render |
| 2 | Sistema ↔ mundo real | 2 | Cola COD sin monto a cobrar ni motivo del fallo anterior; «Llamadas 7/7» cuenta por llamada, el MOM dice por día |
| 3 | Control y libertad | 3 | Escape inerte mientras haya texto |
| 4 | Consistencia | 2 | Tres listas de reseteo divergentes; una fecha con cuatro nombres; dos renderizadores de fila |
| 5 | Prevención de errores | 2 | La segunda puerta que acuña guías acepta fecha pasada, cliente y servidor |
| 6 | Reconocer antes que recordar | 2 | La ventana Aliclik y la fecha que se compara están en pantallas distintas; atajos solo en comentarios |
| 7 | Flexibilidad y eficiencia | 3 | Atajos invisibles; «Siguiente» no es la siguiente |
| 8 | Estética y minimalismo | 2 | Once filtros; dos contadores «X de Y» con denominadores distintos |
| 9 | Recuperación de errores | 3 | El botón deshabilitado es el único portador del motivo; búsqueda sin `catch` |
| 10 | Ayuda y documentación | 2 | Explica consecuencias, no explica las reglas que bloquean |
| **Total** | | **24/40** | **Aceptable** |

La caída de 28 a 24 es afinamiento de la revisión, no regresión: `git log -S` confirma que los dos P0 son viejos (#524 y anterior a #591).

## Veredicto de especificidad

Partido. El contenido no se podría trasplantar (ruta sugerida, horarios por distrito, aviso del séptimo intento leyendo `MAX_INTENTOS`). La forma es una tabla con cajón: la elegida cuando el objeto es una fila. Acá el objeto es una llamada. `reported_status` —lo que el MOM §11 llama «donde vive el motivo»— está en la fila, tipado, usado por `recoveryOutcome`, y NUNCA se renderiza.

## Escaneo determinista

Detector: exit 0, `[]`. El canario con cinco violaciones deliberadas dio 0/5 en `.tsx`; el control sobre `components app` dio 7 hallazgos. El motor en TSX corre tres reglas de string. El limpio es negativo verdadero solo para esas tres.

Medido y sano: 0 hex crudos, 0 `text-[`, 0 `shadow-[`, un solo valor de `tracking`, cuatro pasos de tamaño, un token bajo 500 en texto (glifo `aria-hidden`).

Sin navegador: cero capturas, cero ratios medidos.

## Problemas prioritarios

### [P0] «Por recuperar» es un filtro invisible, inborrable, que vacía las otras pestañas
`:474` sin guarda de vista mientras sus dos vecinas la tienen. `setSoloPorRecuperar(false)` no existe fuera del checkbox: falta en los tres reseteos y en la condición que dibuja «Limpiar filtros». Pero `activeFilters` sí lo cuenta. Marcas en Pendiente → vas a En ruta → lista vacía, «Filtros (1)», sin botón de limpiar. Salida: recargar.

### [P0] La puerta manual acuña guías Swayp con fecha de ayer
`:3297` sin `min`, `:3341` sin la fecha en el `disabled`, `actions.ts:1436` sin validar. Misma función `rescheduleGuideCode`. Es la ruta que el cajón abre a la fuerza cuando no hay número de pedido. El MOM §11.6 afirma que se valida en los dos lados: es verdad solo para `confirma`.

### [P1] La fila no lleva lo que decide la siguiente acción
Faltan motivo anterior, última nota y monto. La columna decisiva es la última, fuera de pantalla a 1.280–1.440 px.

### [P1] Accesibilidad
`order-*` invierte Tab contra la presentación (el comentario nombra la causa como beneficio); el motivo del bloqueo vive dentro de un botón `disabled` no enfocable; `j`/`k` mueven un anillo CSS sin mover foco ni anunciar; los atajos no tienen afordance.

### [P1] Abrir cualquier guía la bloquea 10 minutos, incluso en pestañas de solo lectura
El efecto de reserva no mira `delivery_status` ni `view`.

## Comentarios que mienten sobre el código
1. El `/3` que `lib/shipments.ts:209` dice haber de-duplicado sigue cableado en `:1599`, `:1606`, `:193-194`, y en `actions.ts:587`/`:862`.
2. `DISCARD_REASON_MIN = 8` existe y el componente no lo importa (cuatro literales).
3. El comentario de «Siguiente» (`:550-563`) es falso para toda fila menos la primera.

## Discrepancia con el MOM pendiente de decisión
MOM `:1851` cuenta los siete por día; `lib/shipments.ts:700` hace `attempts + 1` por llamada.

## Banderas por persona
Alex: atajos sin documentar, «Siguiente» al tope, teléfono inerte, dos contadores con denominadores distintos.
Sam: Tab pasa por el editor de dirección antes del formulario; motivo del bloqueo no enfocable; Escape no cierra tras escribir; nombre accesible del diálogo es un código crudo.
Akemi: bloquea guías al auditar; «Hoy por asesora» etiqueta con `name.split("@")[0]`; el modal mezcla tres ventanas de tiempo.

## Observaciones menores
Una fecha con cuatro nombres; tres nombres para el módulo; fechas sin año; «(antes Fénix)» como mobiliario permanente; «Limpiar filtros» sube el contador; un filtro borra otro en silencio; búsqueda sin `catch`; la tarjeta de teléfono no muestra Pedido ni Tienda ni tiene orden; ocho de diez `title=` son único portador; `<fieldset>` sin `<legend>`; tres inputs sin etiqueta; «Swayp requerido» ≈ 4,49:1 calculado; `ReprogramStrip` devuelve null con histórico 0; `ShipmentDrawer` con 1.766 líneas y 28 `useState`.
