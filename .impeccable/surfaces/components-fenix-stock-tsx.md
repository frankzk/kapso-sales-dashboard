---
version: 1
slug: "components-fenix-stock-tsx"
primary_target: "components/fenix-stock.tsx"
related_targets: ["app/dashboard/envios/stock/page.tsx", "lib/fenix-demand.ts", "components/ops-ui.tsx"]
---

# Stock Swayp

Scope: la página `/dashboard/envios/stock` que se abre desde «Stock Swayp» en Repro Provincia (`FenixStockEditor`): cabecera, la demanda de las guías pendientes contra el stock de cada bodega, el inventario con su kardex («Movimientos»), y las herramientas de administrador —sync por API (leer y aplicar), importar el Excel de Swayp, carga a mano y las bodegas configuradas—. Mode: Operate.
Audience: quien prepara lo que hay que mandar a cada bodega de Swayp (operación de Repro Provincia); el administrador que mantiene el stock alineado con Swayp.
Job: ver en segundos qué producto falta en qué ciudad y cuántas unidades, consultar si una bodega tiene un producto y su historial, y —administrador— traer el conteo de Swayp cuando el sync diario no basta.
Constraints: MOM §11.1 «De dónde sale el stock», «El mismo conteo, leído por API», «Stock sin control de cantidad (Lima)»: el conteo de Swayp es la fuente y la carga a mano el parche; leer no escribe y aplicar vuelve a leer; el sync diario y sus ciudades retenidas se ven; Lima y Callao no cuentan unidades (∞); todo cambio pasa por el kardex. Se conserva la lógica y los textos de negocio. Sin desplazamiento horizontal; 44 px con puntero táctil.
Decisions (10-10-2026, Frankz): «esta sección mejorar el UX»; estructura «Una tabla con vistas» (demanda y stock en una sola tabla con tarjetas de cifra que filtran, chips de ciudad y búsqueda); nombre «Stock Swayp» (como el botón y el MOM; la ruta no cambia); herramientas de administrador «Al pie, en una tarjeta» con el estado del sync diario visible arriba.
Decisiones de la construcción (10-10-2026, no son respuestas de Frankz): las vistas son «Por reponer» (falta para guías pendientes; abre aquí), «Sin stock» (en 0 en su bodega, con o sin pedidos; la palabra de la respuesta y del MOM) e «Inventario» (todo; no «Todo el inventario», que a 390 px se parte con las tres tarjetas en fila). Para que «Sin stock» no choque, la tabla no pone chapa a un producto en 0 sin pedidos: el 0 ya se lee en su columna. La línea del sync la ven todos (la arma el servidor); el enlace a las ciudades retenidas, solo el administrador. El título de la tarjeta del pie es «Sincronizar stock desde Swayp», como el MOM. Eliminar un renglón pide un segundo clic en la fila: antes borraba con uno. «/» enfoca la búsqueda, como en Repro Provincia.

## Direction contract

THESIS: A restock worklist, not an inventory dump: the page opens on what is missing in which warehouse and by how many units, with the full inventory one filter away in the same table, and the plumbing that feeds the numbers (sync, Excel, manual entry) parked at the foot. Refuses the two near-identical tables, the admin forms wedged between them, the dark chips, the ⚠ and ✕ glyphs and the uppercase eyebrow.

OWN-WORLD: the operations world of DESIGN.md as Repro Provincia's board wears it: 28 px title with its context line, status cards that filter with the blue border on the chosen one, choice chips for the city, a search field with its icon, one work card with the compact table (tabular figures, crit/warn/ok chapas), and section cards with zones on hairlines for the admin tools.

STORY: The operator opens Stock Swayp, reads how fresh the numbers are, sees «Por reponer» with units and cities, narrows to a city, and knows what to send; to answer «¿hay esto en Juliaca?» they switch to Inventario and search; an admin scrolls to «Sincronizar stock desde Swayp» to read and apply.

FIRST VIEWPORT: title «Stock Swayp» with its context and the sync line; «Recalcular elegibilidad» and back to Repro Provincia at the right; three status cards; the city chips and search; the work card header with the count and the first rows of «Por reponer».

FORM: the Stripe list page the board already uses (the committed world), pinned by the user's choice «Una tabla con vistas»; no roll and no seed key.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
