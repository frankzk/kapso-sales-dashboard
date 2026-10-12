---
version: 1
slug: "components-productivity-tsx"
primary_target: "components/productivity.tsx"
related_targets: ["components/productivity-table.tsx","app/dashboard/productividad/page.tsx","components/ops-ui.tsx"]
---

# Productividad

Scope: la página `/dashboard/productividad` (`ProductivityBoard` y `ProductivityTable`): cabecera, periodo, tienda y fuente, las cifras del equipo, la tabla por asesora (actividad por hora, horas y ritmo, leads, llamadas, 1ª gestión, % cierre, tendencia de 7 días, cerrados por tienda, ingresos), las asesoras en línea sin actividad y el detalle de una asesora con sus leads. También «Mi productividad», la vista de una vendedora. Mode: Operate.
Audience: dirección y supervisoras de venta que miran el día o el mes del equipo; cada vendedora que mira lo suyo.
Job: saber en segundos quién está trabajando y a qué ritmo, quién cierra y cuánto entra, comparado con el periodo anterior; abrir a una asesora para ver qué leads trabajó, de qué fuente y tipo, y dónde no cierra.
Constraints: el modo solo no recibe nada del equipo (el filtrado es del servidor y se conserva); la semántica de las cifras no cambia (ritmo mínimo 6 leads/h, horas muertas dentro de la jornada real, 1ª gestión verde ≤30 min y roja >4 h, el pedido se acredita al último toque, presencia cada 45 s); la URL sigue siendo `from`/`to`, `mes`, `store`, `src`. Sin emojis. Sin desplazamiento horizontal; 44 px con puntero táctil.
Decisions (12-10-2026, Frankz): «Tabla + panel de asesora» (cifras del equipo arriba, filtros, la tabla compacta por asesora; tocar una asesora abre un panel lateral con sus leads, su cierre por tipo y su tendencia, sin empujar las demás filas); «Una pantalla, como hoy» (desde 1280 px la página no baja: la tabla se desplaza por dentro con su cabecera pegajosa; en el teléfono la página baja); «Periodo en chips, resto en píldoras» (Hoy, Ayer, 7 d, 30 d, 90 d · Este mes, el anterior, Otro mes en chips; Tienda y Fuente como las píldoras del Master, que cierran al elegir).

## Direction contract

THESIS: A team scoreboard you can read across one row: effort on the left, efficiency in the middle, result on the right, one advisor per row and the detail one tap away in a side panel. Refuses the old board's table that overflowed its card, the emoji source chips, the uppercase truncated KPI labels, the nested mobile cards and the paragraph-long legend.

OWN-WORLD: the operations world of DESIGN.md as the Master and Repro Provincia wear it: 28 px title with its context, period choice chips, ChoicePills for store and source, the team figures in one framed strip of cells on hairlines, one work card with the compact two-line table (tabular figures, ok/warn/crit text tones, the activity strip in brand / warn / crit / wash cells) and the SidePanel for the advisor.

STORY: The supervisor opens Productividad, reads today's calls, leads, closes and revenue against yesterday, scans the activity strips for dead hours, spots who cierra poco or deja enfriar los leads, opens her panel and sees which leads and fuentes; a vendedora sees only her own row and her own panel.

FIRST VIEWPORT: title and period line; the period chips with Tienda and Fuente pills on one row; the six team figures in one strip; the work card with its legend line and every advisor row visible at 1440 × 900 without page scroll.

FORM: the Stripe list page the Master and Repro Provincia already use (the committed world), pinned by the user's three answers; no roll and no seed key.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
