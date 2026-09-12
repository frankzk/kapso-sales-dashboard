---
target: components/shipments.tsx
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/home/user/kapso-sales-dashboard/components/shipments.tsx"
target_fingerprint: "sha256:66da608779aa8e3a620849835692cef868a17507a92267025bf85f0c261f97c3"
target_path: /home/user/kapso-sales-dashboard/components/shipments.tsx
timestamp: 2026-09-12T14-38-32Z
slug: components-shipments-tsx
---
Method: dual-agent (A: revisión de diseño · B: detector mecánico). Sin inspección en navegador: sin .env ni dev server en el sandbox.

## Puntaje de salud de diseño — Envíos (components/shipments.tsx)

| # | Heurística | Puntos | Problema clave |
|---|---|---|---|
| 1 | Visibilidad del estado | 2 | El aviso de éxito se borra solo: `run()` lo fija (l.1289) y `refresh()` reejecuta el efecto que hace `setMsg(null)` (l.1238, deps l.1259). |
| 2 | Coincidencia con el mundo real | 3 | Vocabulario operativo correcto; pero el `h1` dice «Repro Provincia» (l.522) y `attemptLabel` devuelve «Ingestión» para 0 intentos. |
| 3 | Control y libertad | 2 | El cajón (l.1412) no cierra con Escape; «Descartar la recuperación» (l.1975) es terminal sin confirmación ni deshacer. |
| 4 | Consistencia | 2 | Cinco colores de botón primario (brand, rose, orange, emerald, violet); «Cerrar» texto vs «✕»; filtros se resetean al cambiar de pestaña (l.311–322). |
| 5 | Prevención de errores | 3 | «Qué sucederá» (l.2070) ejemplar; pero `nextDate` compartido entre «Programar llamada» (l.2288) y «Generar guía Fenix (manual)» (l.2350). |
| 6 | Reconocimiento vs. recuerdo | 3 | Regla de 8 caracteres mínimos para descartar (l.1963) no se muestra. |
| 7 | Flexibilidad y eficiencia | 1 | Cero atajos, sin siguiente/anterior en el cajón, sin acciones masivas, `<tr onClick>` (l.936) sin teclado, sin deep-link. |
| 8 | Estética y minimalismo | 1 | Métricas de 30 días y scoreboard por asesora (l.565–567) encima de la cola; 11 columnas; 10 filtros (l.614–823); siete tintas de sección en el cajón. |
| 9 | Recuperación de errores | 2 | l.1784 pinta error y aviso igual: gris `bg-slate-50`, sin `role="alert"`. |
| 10 | Ayuda y documentación | 3 | Tooltips en «Por recuperar» (l.762) y cabeceras de «Hoy por asesora»; pie explicativo del modal. |
| **Total** | | **22/40** | **Aceptable** |

## Veredicto de especificidad

Arquitectura autoral, piel intercambiable. De Kapta: badge de dos mitades (`subState`, l.191–202), columna «Ruta sugerida» (l.1063–1101), franja «Reservado para ti» (l.1455–1485), historial por linaje (l.2447–2455), botón cuyo texto es la precondición faltante (l.2316–2330). Genérico: `rounded-xl` + `slate` + una tinta por sección (sky, teal, indigo, rose, amber, orange, violet) y emojis como iconografía.

Detector: 1 hallazgo, falso positivo (`text-slate-500 on bg-emerald-600`, l.674: rama `disabled:` cruzada con fondo habilitado). Greps: 28 líneas `text-[10px]`, 19 `text-[11px]`; 2 de 35 controles con estilo de foco; 10 familias de color, 9 en badges; 11 `title=` como única explicación. A y B coinciden: `<tr onClick>` sin teclado (l.936), «✕» sin `aria-label` (l.536, l.2985), backdrops `div onClick` sin rol (l.1412, l.2977).

## Impresión general

La lógica de negocio está muy bien llevada a la interfaz; falla el envoltorio: la cola no es lo primero, el cajón trata cada sección como protagonista, y la retroalimentación (éxito, error, foco, teclado) es la parte más débil. Mayor oportunidad: que quien marca teléfonos abra Envíos y vea su cola, su siguiente guía y una sola acción primaria.

## Lo que funciona

1. Badge de dos mitades (l.191–202) con `RECOVERY_LABEL` compartido con el Master.
2. El botón como validación (l.2316–2330).
3. Consecuencia antes de actuar: «Qué sucederá» (l.2068–2080), reapertura, Swayp vs código local (l.2251–2264).

## Problemas prioritarios

[P1] El éxito desaparece. l.1238 borra `msg` en cada recarga; l.1289 lo fija; `refresh()` sube `reloadKey` (l.1259). Fix: resetear `msg` solo cuando cambia `shipmentId`; mantener el aviso hasta la siguiente acción. Comando: /impeccable harden.

[P1] Error y aviso indistinguibles. l.1784 un solo `<p>` gris. Fix: `run()` guarda `{kind, text}`; rose + `role="alert"` para error, emerald + `role="status"` para aviso. Comando: /impeccable harden.

[P1] Fila y cajón inaccesibles. `<tr onClick>` sin `tabIndex`/`onKeyDown` (l.936); cajón sin `role="dialog"`, `aria-modal`, foco inicial, trampa de foco ni Escape (l.1412–1416); 2/35 con foco visible; «✕» sin nombre (l.536, l.2985). Fix: botón en la celda «Guía»; `role="dialog"` + Escape + retorno de foco; `focus-visible:ring-2` en el primitivo. Comando: /impeccable audit.

[P2] La cola no es lo primero, y el cajón es un arcoíris. `ReprogramStrip` y `TodayByAgentPanel` (l.565–567) encima de la tabla; 10 filtros; siete tintas de sección. Fix: métricas colapsadas o en pestaña «Resumen»; tarjetas neutras `slate-200`; color solo por severidad; un accent para la acción primaria. Comando: /impeccable layout, luego /impeccable quieter.

[P2] Dos formularios conviven y uno es terminal sin freno. `nextDate` compartido (l.2288, l.2350); «Descartar la recuperación» (l.1960–1976) sin confirmar y con la regla de 8 caracteres oculta. Fix: estado propio; manual colapsado tras «Ingresar guía manualmente»; segundo clic «Confirmar descarte de #pedido»; «mínimo 8 caracteres» junto al textarea. Comando: /impeccable distill y /impeccable clarify.

## Banderas por persona

Alex: sin «siguiente guía» desde el cajón; `go()` (l.413) resetea filtros; `setOpenId` no escribe la URL; sin Enter/Escape.
Sam: `<tr onClick>` (l.936); cajón sin rol (l.1412); `<select>` sin `<label>` (l.1906, l.2165); textarea solo placeholder (l.2294); `text-slate-400` (≈2,97:1) en `text-xs`/`text-[10px]` (l.617, l.961, l.2651); `text-[9px]` (l.2480).
Riley: `loadShipmentDetail(...).then` sin `catch` (l.1227) → «Cargando…» eterno; F5 no libera la reserva; `fenixExportError` solo en `en_ruta` (l.825). Vacíos correctos (l.590, l.845, l.2506, l.2786).

## Observaciones menores

- Historial (l.2403) fuera del `<fieldset disabled>` (l.1487–2401).
- «Etapa 1 completada» (l.2010) vs «Paso 1 · elegir ruta» (l.2180).
- «Fénix» con tilde (l.743–745, l.2865) vs «Fenix».
- Strip «Reprogramados en Kapso»: nombre viejo.
- `title=` como única explicación en cabeceras «Hoy por asesora» (l.2793–2796).

## Preguntas para pensar

1. ¿Por qué una cola de llamadas abre con métricas de 30 días y un scoreboard por asesora?
2. Si «Ruta sugerida» ya decidió, ¿por qué el agente vuelve a elegir en «Paso 1 · elegir ruta»?
3. ¿Por qué existe «Entregado (Fenix)» como disposición de llamada (l.99) si «Registrar resultado del courier» ya cierra la guía?
