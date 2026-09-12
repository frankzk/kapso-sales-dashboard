---
target: components/shipments.tsx
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
target_identity: "file:/home/user/kapso-sales-dashboard/components/shipments.tsx"
target_fingerprint: "sha256:4bbcefcd22bd3ca2c919a71d5e8950039fbd87e37f29ba250da0766c8776d146"
target_path: /home/user/kapso-sales-dashboard/components/shipments.tsx
timestamp: 2026-09-12T20-47-20Z
slug: components-shipments-tsx
---
Method: dual-agent (A: revisión de diseño · B: detector mecánico). Sin navegador.

## Puntaje — Envíos, tercera corrida: 28/40 (22 → 25 → 28), banda Good

| # | Heurística | Pts | Hallazgo clave |
|---|---|---|---|
| 1 | Visibilidad del estado | 4 | «Mostrando X de Y» dentro de `hidden md:flex`: invisible en teléfono. |
| 2 | Lenguaje del mundo real | 3 | `legend` «Gestión» contiene un `select` «Gestión:» cuyas opciones son rutas. |
| 3 | Control y libertad | 3 | Falta «Anterior» junto a «Siguiente →». |
| 4 | Consistencia | 2 | `text-red-600` vs rose; `7`/`3` cableados; UTC vs Lima en la misma fila; seis secciones con el mismo chrome. |
| 5 | Prevención de errores | 3 | P0: «Cliente confirma» acepta fecha pasada. |
| 6 | Reconocimiento vs. recuerdo | 3 | «Sin contactar hoy» / «Nunca contactadas» sin diferenciar. |
| 7 | Flexibilidad y eficiencia | 2 | Cero atajos de teclado, cero lote. |
| 8 | Minimalismo | 2 | 11 columnas, 10 filtros, 9 acentos. |
| 9 | Diagnóstico de errores | 3 | `error.message` crudo de Supabase al pie. |
| 10 | Ayuda | 3 | Comentario promete `aria-describedby`; no existe. |

## Veredicto de especificidad

Autorada para este producto: badge de dos mitades, «Ruta sugerida» precalculada, copy que distingue los dos caminos del mismo botón, conflicto courier-vs-Shopify, ventana de 200 con cifras medidas, «Siguiente →».

Detector: 0 hallazgos, VERIFICADO que no es fallo silencioso (sobre `components app` da 7 hallazgos). Pero en TSX el motor solo aplica regex y un canario con hex/onClick-en-div/botón-sin-nombre/tamaño-arbitrario no se detecta: evidencia débil. Los greps son la evidencia: 0 tamaños arbitrarios, 0 hex, 0 slate-400, 0 sombras, foco global + 44 px táctil, tabla memoizada.

Corrección a A: `text-rose-600` es 4,7:1 y `text-red-600` 4,8:1 sobre blanco — los dos pasan AA. Queda la inconsistencia de paleta, no el contraste.

Señal nueva (B): `ShipmentDrawer` con 37 `useState`; bloques de llamada duplicados («Registrar o programar llamada» ×2, «Nota de la llamada» ×3).

## Problemas prioritarios

[P0] «Cliente confirma» acepta fecha pasada: `min` solo para «programar», `requiredDateMissing` solo exige existencia, el servidor tampoco valida futuro. Emite una guía Swayp fechada ayer con ese número estampado.
[P1] La tarea actual no domina el cajón: seis secciones con chrome idéntico; el formulario de llamada tras datos + destino + ítems de Shopify.
[P1] Sin atajos de teclado ni lote.
[P2] `error.message` crudo de Supabase al pie; `loadReprogramData()` sin `catch`.
[P2] Reserva vencida: la nota queda atrapada en un textarea inerte y el mensaje no dice que la copie.

## Banderas por persona

Alex: sin atajos ni lote; orden y filtros no viajan en la URL (un enlace abre otra cola); «Mostrar todas» pinta 4.000 filas.
Sam: `aria-describedby` prometido y ausente; `ChecklistFilter` sin Escape, `role` ni retorno de foco; el gráfico de 8 semanas solo habla por `title`; «Mostrando X de Y» sin región viva.
Riley: un clic en la fila reclama la guía 10 minutos (seleccionar un teléfono la bloquea); vacío con filtros en teléfono sin «Limpiar filtros» y con el contador oculto; F5 pierde el borrador; «Tomada» envejece entre refrescos; `guide_code` con `whitespace-nowrap` desborda en el historial.

## Observaciones menores

`7`/`3` cableados en las métricas. «Repro Provincia» vs «Reproprovincia». UTC y Lima en la misma fila. «Hoy por asesora» recorta el email con `split("@")[0]`: dos homónimas quedan idénticas. Tres botones en la `fieldset` deshabilitada sin estilo `disabled:`.

## Preguntas

1. Si «Siguiente →» es el ciclo real, ¿para qué 11 columnas ordenables?
2. Diez filtros y 3.089 filas que el cliente tira: ¿cuáles se usan dos veces al día?
3. ¿Por qué el borrador es estado de React y no un dato del servidor por guía y asesora?
