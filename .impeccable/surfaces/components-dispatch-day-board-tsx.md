---
version: 1
slug: "components-dispatch-day-board-tsx"
primary_target: "components/dispatch-day-board.tsx"
related_targets: ["components/grupo-gf-courier.tsx"]
---

# Despacho del día (Grupo GF Courier)

Scope: cabecera y pestañas de Grupo GF Courier y toda la pestaña Despacho del día (métricas, QR, lista, cajas, devoluciones, hojas). Segunda etapa (29-09-2026, pedida por Frankz: «haz lo mismo con Rutas y Tarifario»): Rutas y Tarifario heredan este mundo sin cambiarlo. Tercera etapa (29-09-2026, pedida por Frankz: «haz lo mismo con los paneles laterales»): la caja y «Reparto y liquidación» que abre Rutas, con la pieza `SidePanel`. Cuarta etapa (29-09-2026, «haz lo mismo con la mesa de almacén»): `/dashboard/pedidos/despacho`; el destino elegido usa el lenguaje de la selección (velo y anillo azul) porque es lo que no se puede confundir al asignar. Quinta etapa (29-09-2026, Frankz aclaró que «mesa de almacén» era `/dashboard/pedidos/almacen`): la estación Almacén. Mode: Operate.
Audience: supervisor de despacho de Grupo GF, de pie en almacén o en escritorio, con lector de QR o celular.
Job: decidir quién sale y asignarle paquetes; dejar en cero «Nunca salieron»; atender lo programado hoy.
Constraints: conservar funciones, textos, reglas y pruebas; objetivos de 44–48 px con puntero táctil; sin scroll horizontal en tareas del teléfono.
Decisions (29-09-2026, Frankz): estilo Stripe Dashboard con el azul Kapta como acento; alcance Despacho + cabecera.

## Direction contract

THESIS: Despacho del día as a Stripe-grade list page: the counts are the navigation, the table is the work, everything else stays quiet. Refuses the stack of equal-weight colored tiles, chips and strips that competes above the task.

OWN-WORLD: White surfaces with #EBEEF1 hairlines on the slate canvas; ink #1A1B25 / #414552 / #687385; Kapta blue #1F5FE0 only for the primary action, selection, active tab and links; 4px status badges (green #D7F7C2/#006908, cyan #CFF5F6/#0055BC, amber #FCEDB9/#A82C00, pink #FFE7F2/#B3063D, gray #EBEEF1/#545969); 6px controls with soft offset shadows; dashed «+» filter pills that turn solid with their value; 8px status cards with a 2px blue edge when selected; system sans, 28px bold title, 14px body, tabular figures; one stroke icon family.

STORY: The supervisor sees what is left (por asignar, nunca salieron, programados hoy), picks who goes out and assigns by QR or from the list; exceptions (devoluciones, sin condiciones, por reprogramar) wait at the edge until needed.

FIRST VIEWPORT: Title and underline tabs; one line with the day button, the day summary and three attention pills; six status cards (the apartados); the work card with the rider select beside a three-way segmented control; below it the scan field or the list toolbar (search, filter pills, bulk bar) and the table.

FORM: Stripe Dashboard list page (the category canon), pinned by the user in words; no roll and no seed key; accent translated to Kapta blue at the user's request.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
