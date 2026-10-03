---
version: 1
slug: "components-orders-master-tsx"
primary_target: "components/orders-master.tsx"
related_targets: ["components/order-master-shared.tsx", "app/dashboard/pedidos/loading.tsx"]
---

# Master de Pedidos (tablero)

Scope: el tablero de `/dashboard/pedidos` — cabecera, búsqueda, tira de agencia, macroetapas, subetapas y fecha pactada, filtros, tabla, paginador, exportación y barra de acciones en lote. La ficha del pedido (`order-drawer.tsx`) queda fuera: va en un cambio aparte. Mode: Operate.
Audience: el equipo de operación (confirmación, almacén, seguimiento, cierre) en escritorio la mayor parte del día; supervisores que lo abren desde el teléfono.
Job: localizar y priorizar pedidos (quién, dónde, en qué macroetapa y desde cuándo, MOM §25), abrir la ficha del que toca y actuar en lote sobre una tanda.
Constraints: conservar lógica, filtros en la URL, contadores con filtros (MOM §6), paginador con total en todas las vistas, el ciclo de recontacto dentro de «Más filtros» (§6.1), «Próximo contacto» distinguiendo fecha pactada de ciclo automático, y los tonos de macroetapa del MOM (§25: ámbar confirmación, celeste preparación, índigo despacho, cian seguimiento, naranja cierre, verde completado, gris consulta). Ningún dato sale de la tabla sin estar en la ficha. Sin scroll horizontal; 44 px con puntero táctil.
Decisions (02-10-2026, Frankz): «Ahora vamos con Master de Pedidos … haz tu mejor trabajo!» dentro del mundo ya fijado con «diseñarlo con estilo Stripe» (Ajustes, 02-10-2026; Despacho, 29-09-2026); «Tablero ahora, ficha después»; tabla «Compacta, sin scroll» con celdas agrupadas; macroetapas como «Tarjetas de cifra» con subetapas en chips debajo.

## Direction contract

THESIS: The Master as a Stripe-grade list page: seven count cards are the navigation, a dense two-line table is the work, filters are dashed pills that turn solid, and nothing scrolls sideways. Refuses the dark segmented bar with numbered circles, uppercase eyebrows, emoji icons and the 17-column frozen table.

OWN-WORLD: the committed operations world of DESIGN.md — white cards with #EBEEF1 hairlines on the slate canvas, ink #1A1B25 / #414552 / #687385, Kapta blue #1F5FE0 only for selection, the open row, links and the primary bulk action; 4px chapas; 6px controls; 8px status cards with a 2px blue edge when chosen. The one sanctioned exception is the MOM macroetapa hue, carried by the stage chapa and a 8px marker in each count card so the cards double as the legend of the table.

STORY: The operator lands on Todos, reads the six stages as counts, taps the one they work, narrows by subetapa or fecha pactada, filters by courier or destino, scans rows (pedido, cliente, destino, courier, etapa, movimiento), opens one, or marks a tanda and prints its rótulos from the floating bar.

FIRST VIEWPORT: title with the two station links and the search; the agency line with its three attention pills; seven count cards; the subetapa chips; the filter pills; the work card header (total, Excel, pager) and the first rows.

FORM: Stripe Dashboard list page (category canon), pinned by the user in words («estilo Stripe»); no roll and no seed key; accent translated to Kapta blue.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict and DESIGN.md.
