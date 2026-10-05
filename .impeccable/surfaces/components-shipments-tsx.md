---
version: 1
slug: "components-shipments-tsx"
primary_target: "components/shipments.tsx"
related_targets: ["app/dashboard/envios/page.tsx", "app/dashboard/envios/loading.tsx", "components/facet-pill.tsx"]
---

# Repro Provincia (tablero)

Scope: el tablero de `/dashboard/envios` — cabecera, búsqueda, acciones (Importar reporte, Guía Swayp directa, Stock Swayp, el automático Aliclik → Swayp), el resumen plegable (reprogramaciones, hoy por asesora, agentes de voz y su detalle), las seis vistas, la ruta sugerida de Pendiente, los filtros, la tarjeta de trabajo (conteo, atajos, Excel Swayp, ventana de filas) y la tabla de guías con su lista de teléfono. El cajón de la guía (`ShipmentDrawer`, unas 2.000 líneas) queda fuera: va en un cambio aparte. Mode: Operate.
Audience: las asesoras de reprogramación de provincia, que trabajan la cola de Pendiente durante el día en escritorio, con teclado (j / k / Enter / n), y a veces desde el celular para llamar; dirección y supervisión, que leen el resumen.
Job: saber cuántas guías hay en cada estado, acotar la cola (tienda, cobertura, departamento, distrito, programación, ruta, Swayp, gestión de hoy) y abrir la siguiente guía a llamar con lo que decide la llamada a la vista: cómo terminó el intento anterior (MOM §11.7), dónde está, si Aliclik todavía la acepta o hace falta Swayp, cuándo se gestionó y cuándo se reprograma.
Constraints: conservar toda la lógica de la cola (orden en el tablero, sucesora de «Siguiente», reserva y «Tomada», atajos, `?open=` por replaceState, ventana de 200 filas sobre el conjunto entero, filtros del cliente en `clientFilters` con su valor por defecto por vista, cobertura que abre en «todo menos Lima», aviso al quitar la provincia), los textos de negocio y las pruebas que encarnan reglas; las que solo fijaban el aspecto anterior se actualizan con la misma intención. Sin scroll horizontal; 44 px con puntero táctil.
Decisions (05-10-2026, Frankz): «vamos con la mejora de esta interfaz /impeccable», tras el Master y la ficha; «Tablero ahora, cajón después»; las vistas como «Tarjetas de cifra»; tabla «Compacta, sin scroll»; el título pasa a «Repro Provincia», como en el menú.

## Direction contract

THESIS: Repro Provincia as the same Stripe list page as the Master: six count cards are the navigation, the route verdict of Pendiente sits under them as choice chips, filters are dashed pills that turn solid, and the call queue is a dense two-line table that fits the screen. Refuses the slate fieldsets «Alcance» and «Gestión», the colored courier chips, rounded-xl panels and the 11-column table that scrolled sideways.

OWN-WORLD: the committed operations world of DESIGN.md — white cards with `line` hairlines on the slate canvas, ink in three steps, Kapta blue only for the chosen card or chip, the cursor row, links and focus; 4 px chapas in tone pairs for state (pendiente warn, en ruta info, entregada ok, cerrada neutral, transferida neutral) and for the route verdict (Aliclik disponible ok, Swayp requerido warn); 6 px controls; status cards with a 2 px blue edge when chosen.

STORY: The asesora lands on Pendiente with «Sin contactar hoy» on, reads how many need Aliclik and how many Swayp, narrows by tienda or departamento, walks the queue with j / k, reads the previous outcome, destination and last contact in the row, opens one with Enter, and comes back to the next.

FIRST VIEWPORT: title «Repro Provincia» with its context line, the search and the four actions; the folded summary line; six count cards; the route chips (Pendiente); the filter pills; the work card header (count of the queue, shortcuts, Excel Swayp in En ruta) and the first rows.

FORM: Stripe Dashboard list page (category canon), pinned by the user in words («estilo Stripe», «como el Master»); no roll and no seed key; accent translated to Kapta blue.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict and DESIGN.md.
