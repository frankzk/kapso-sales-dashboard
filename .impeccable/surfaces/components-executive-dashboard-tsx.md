---
version: 1
slug: "components-executive-dashboard-tsx"
primary_target: "components/executive-dashboard.tsx"
related_targets: ["app/dashboard/page.tsx","app/dashboard/[storeId]/page.tsx","components/mom-owner-summary.tsx","components/controls.tsx","components/campaign-table.tsx","components/sales-attribution.tsx","components/charts.tsx"]
---

# Consolidado

Scope: la portada `/dashboard` («Consolidado», la primera entrada del menú para owner y admin) y el mismo tablero por tienda (`/dashboard/[storeId]`), que comparten `ExecutiveDashboard`: cabecera y periodo, el resumen operativo del MOM (excepciones e indicadores), las cifras comerciales del periodo y todos los módulos de análisis (ventas por día, por tienda o patrón de horas, fuente y cierre, BOT vs asesoras, anuncios de Meta, tendencia por anuncio, carritos, embudo, por qué no compraron, impacto perdido, números de WhatsApp, productos, desglose de negocio, salud del embudo, integridad de conversión, salud operativa de Kapso) y las exportaciones CSV. Mode: Operate.
Audience: el owner y los admins, cada mañana y varias veces al día; desde computadora sobre todo.
Job: saber en segundos qué necesita acción (excepciones del MOM, cada una abre su cola) y cómo va el negocio en el periodo contra el anterior; encontrar el módulo que se ve mal y auditarlo sin perder el tablero.
Constraints: los cálculos no cambian (lib/metrics, la atribución obligatoria, los indicadores del MOM con numerador y denominador); los periodos del MOM son fijos (Hoy, Ayer, 7 días, mes actual y anterior) y no siguen al periodo elegido; la URL sigue siendo `from`/`to` y la tienda cambia de ruta; la tabla de anuncios conserva su edición de producto anunciado, orden, filtro por producto y detalle por anuncio; sin emojis; sin desplazamiento horizontal de la página; 44 px con puntero táctil.
Decisions (13-10-2026, Frankz): «Resumen + paneles» (una pantalla de mando: arriba las excepciones del MOM y el marco de cifras; abajo una rejilla con cada módulo resumido en su cifra y un mini-gráfico, y tocarlo abre un panel lateral con el módulo completo); «Todos visibles» (los módulos técnicos —integridad de conversión, salud operativa de Kapso, salud del embudo, tendencia por anuncio, números de WhatsApp— siguen a la vista en la rejilla, rediseñados igual); «Chips + fechas libres» (Hoy, Ayer, 7, 30 y 90 días, Este mes, el mes anterior y «Otro mes…» en chips, más «Desde / hasta»; la tienda en una píldora).
Roll: degradado (el servicio no respondió), sin retadores; se presentaron las estructuras 4, 5 y 7 de la lista propia.

## Direction contract

THESIS: A command center the owner reads in one sweep: what needs action (MOM exceptions that open their queue), how the period went (one figure frame against the previous period), and every analysis reduced to its single number and a glyph-sized chart; the full module opens in a side panel on demand. Refuses the old wall of seventeen equal-weight cards with colored icon chips, emoji titles and competing charts.

OWN-WORLD: the operations world of DESIGN.md as Productividad wears it: 28 px title with its context line, period chips plus Desde/Hasta and a store ChoicePill, MOM exceptions as status cards with tone washes, the commercial figures and the MOM indicators as framed strips of cells on hairlines, the module grid as framed cells on hairlines grouped by question under 12 px labels, tabular figures in ink with ok/warn/crit text tones, glyph charts in ink and brand only as data, SidePanel per module.

STORY: The owner opens Kapta, sees four exception counts and clicks the one above zero, comes back, reads revenue, orders, conversion and ticket against last period, scans the grid for the cell that looks wrong (ROAS down, carts waiting, one loss reason dominating), opens it, audits in the panel, closes it, and the board is still there.

FIRST VIEWPORT: at 1440 × 900: title and the stores line; the «Operación» card with the four MOM exception cells (washed in `crit` when something waits) and the five MOM indicators with their own fixed-period chips; then «Ventas del periodo» with its range line, the period chips, Desde/Hasta and the Tienda pill placed next to what they filter (the MOM periods do not follow them); the five-cell commercial figure frame; the first group of module cells starting above the fold. (Reordered during the build, 13-10-2026: the period controls moved below the MOM card because the MOM ignores the chosen period.)

FORM: «Resumen + paneles», position 4 of my ordered list of seven grounded structures (dealt lead of a degraded roll), seed key 5cd147bd.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
