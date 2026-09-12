---
target: components/shipments.tsx
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
target_identity: "file:/home/user/kapso-sales-dashboard/components/shipments.tsx"
target_fingerprint: "sha256:93885b76689f3f17e4a5c38630f8ad7e193d5896d8092f7718cfd50a0d77ed88"
target_path: /home/user/kapso-sales-dashboard/components/shipments.tsx
timestamp: 2026-09-12T16-08-17Z
slug: components-shipments-tsx
---
Method: dual-agent (A: revisión de diseño · B: detector mecánico). Sin inspección en navegador.

## Puntaje de salud de diseño — Envíos, segunda corrida

| # | Heurística | Puntos | Problema clave |
|---|---|---|---|
| 1 | Visibilidad del estado | 3 | Tras cada acción `refresh()` hace `setDetail(null)` (l.1586–1589, 1630): el cajón pasa a «Cargando…» y el formulario recién enviado desaparece. |
| 2 | Coincidencia con el mundo real | 3 | «Swayp (antes Fénix)» repetido en tres bloques; «Repro Provincia» vs «Reproprovincia» conviven por decisión. |
| 3 | Control y libertad | 2 | «Cliente cancela / anula» terminal sin segundo paso (l.129, 2768–2798); clic en el fondo (l.1757) borra la nota escrita. |
| 4 | Consistencia | 2 | Dos secciones «Registrar o programar llamada» (l.2281, 2608) con reglas distintas; chips de tienda con semántica inversa; Swayp naranja vs cielo (l.3357). |
| 5 | Prevención de errores | 3 | El «No contesta» tras el Intento 7 anula la guía (`shipments.ts` l.679) sin aviso pese a «Llamadas 6 / 7» (l.1888). |
| 6 | Reconocimiento vs. recuerdo | 3 | «Solo sin contactar hoy» / «Solo sin contactar» (l.892, 901); cuatro palabras para una idea. |
| 7 | Flexibilidad y eficiencia | 2 | Sin atajos, sin «siguiente guía», sin lote; `openId` no va a la URL (l.493–496). |
| 8 | Estética y minimalismo | 2 | Hasta siete secciones apiladas con el mismo peso; once filtros en una fila (l.729–936). |
| 9 | Recuperación de errores | 2 | `feedback` en l.2151 encima de todos los formularios; en error el scroll queda abajo y el alert fuera de pantalla. |
| 10 | Ayuda y documentación | 3 | «Por recuperar» explica su regla solo en `title` (l.875). |
| **Total** | | **25/40** | **Aceptable** (antes 22/40) |

## Veredicto de especificidad

Autorado para este producto: badge de dos mitades, «Ruta sugerida», reserva con latido, «Qué sucederá», API vs código local. Piel Tailwind neutra: en modo Operar, el orden correcto.

Detector: 0 hallazgos. Greps: 0 tamaños arbitrarios, 0 `shadow-[`, 0 `text-slate-400`, 0 emojis en JSX, 45 botones sin icon-only sin nombre, tabla memoizada con ventana de 200, foco global. Queda: 8 `title=` como única explicación (l.781, 875, 2865, 3345, 3379–3382, 3578), dos overlays `div onClick` sin rol (l.1757, 3489). Corrección a A: `text-rose-600` sobre blanco es 4,7:1 (pasa); deshabilitado con `opacity-50` exento.

## Impresión general

De 22 a 25. Subió lo trabajado (retroalimentación, accesibilidad básica, tipografía, color, jerarquía de la cola). Sigue bajo lo que ningún pase tocaba: el cajón como flujo de trabajo. Mayor oportunidad: registrar y pasar a la siguiente sin perder nada.

## Lo que funciona

1. Consecuencia antes de la acción en cuatro sitios (`aliclikDecisionCopy`, «Qué sucederá», API vs Excel, botones-instrucción).
2. Reserva colaborativa legible (l.1454–1519, 1823–1853), `fieldset disabled` incluye historial.
3. Descartar bien resuelto (l.2302–2379): patrón a copiar en «Cliente cancela».

## Problemas prioritarios

[P0] «Cliente cancela / anula» sin confirmación (l.129, 2768–2798). Fix: patrón del descarte, segundo paso que nombre guía y pedido, nota obligatoria. Comando: /impeccable harden.
[P1] El último intento anula en silencio (`shipments.ts` l.679; cajón l.1888). Fix: aviso ámbar y botón «Registrar y anular». Comando: /impeccable clarify.
[P1] Error fuera de pantalla y éxito que borra el formulario (l.2151; `refresh()`). Fix: aviso junto al formulario con `scrollIntoView` y foco; detalle anterior atenuado hasta el nuevo. Comando: /impeccable harden.
[P1] Diálogo sin trampa de foco y clic fuera que descarta borradores (l.1757, 1526–1539). Fix: trampa de foco; confirmar cierre con borrador. Comando: /impeccable harden.
[P2] El ciclo termina en la misma guía: sin «Siguiente», sin J/K, sin `openId` en URL, fila sin `claimed_by`. Comando: /impeccable shape.

## Banderas por persona

Alex: sin atajos ni «siguiente»; filtros se pierden al cambiar de pestaña (l.350–361); «Mostrar todas» sin aviso; sin lote.
Sam: diálogo sin trampa de foco; pestañas sin `aria-current`; chips y botones de ruta sin `aria-pressed`; `ChecklistFilter` sin `aria-expanded`.
Riley: vacío de filtros sin «Limpiar filtros» inline (l.968); `HistoryCallItem.save` sin `try/catch` (l.3031–3043); tras F5 el cajón no reabre.

## Observaciones menores

- Comentario obsoleto en `Field` (l.3132). «Cerrar» textual vs icono. Excel `fenix_programacion_…xlsx` (l.585). «Próximo intento» también para «cancela» (l.2749). «↗» textual (l.2001).

## Preguntas para pensar

1. Si es una cola, ¿por qué cada ciclo termina en la misma guía?
2. ¿Por qué descartar merece dos pasos y «Cliente cancela» no?
3. De once columnas y once filtros, ¿cuáles tres mira una asesora antes de marcar?
