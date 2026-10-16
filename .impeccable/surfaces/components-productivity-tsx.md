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
Decisiones de la construcción (12-10-2026, no son respuestas de Frankz): la columna «Fuentes» (chips con emojis) sale de la tabla y vive en el panel, con su nombre; el corte por tienda queda en la tabla, bajo «Cerrados», porque su cero es la señal de barril roto. Las cifras del equipo no filtran, así que van en un marco de cifras y no en tarjetas de estado. La hora muerta lleva su «0» en rojo para no perderse junto al gris de fuera de jornada. El ritmo va en tinta (ámbar por debajo del mínimo), no en azul.
Decisions (12-10-2026, Frankz) — semana: con asesoras en remoto, saber que cumplen su horario y sus 48 h. «Solo activas (ya existe)» (las horas son las activas que ya calcula la página; no se registra presencia); «Meta y horario por asesora» (meta semanal, días y horario opcional por persona, editables en Equipo › Horarios; con horario se marcan llegadas tarde y salidas antes); «Columna y panel» (columna «Semana» con la semana en curso contra la meta y su barra; en el panel, la semana día por día; siempre la semana en curso, sea cual sea el periodo).
Decisiones de la construcción — semana (12-10-2026, no son respuestas de Frankz): la semana cuenta también las gestiones de envíos (Repro), así que puede no sumar lo mismo que «Horas» del periodo; la meta se reparte por igual entre los días de trabajo; lo esperado incluye hoy la fracción transcurrida del horario (sin horario, hoy no cuenta hasta que termina); «atrasada» pasa de 1 h por debajo; 10 minutos de gracia para llegar y salir, y la salida solo se juzga en días pasados; quien no tiene horario usa 48 h de lunes a sábado sin juzgar llegadas; todas las vendedoras (y quien tiene horario) sin actividad en el periodo salen como filas quietas para que la ausencia se vea; la columna se llama «Esta semana» porque no sigue al periodo elegido; el atraso se escribe «Atraso 1.7 h» para no leerse como lo que falta para la meta; sin horario, lo esperado es «hasta ayer». No es una regla de pedidos, así que el MOM no cambia.
Decisión (12-10-2026, Frankz) — franja de varios días: el promedio por hora de 7 días no se entendía; «si es 7 días, mostrar 7 cuadraditos, y si es todo el mes, por semana o por día si recién empieza», y poder ver cuántas horas trabajó cada día.
Decisiones de la construcción — franja de varios días (12-10-2026, no son respuestas de Frankz): cada celda dice horas trabajadas (no leads), en el tono de su parte de la meta; hasta 14 días va por día y más allá por semana de lunes a domingo; el panel suma la zona «Por día» (o «Por semana» pasados 31 días) antes de «Esta semana», y la franja por hora queda en el panel como promedio por día; las horas cuentan leads y envíos como la semana, aunque «Horas» siga contando solo leads.

## Direction contract

THESIS: A team scoreboard you can read across one row: effort on the left, efficiency in the middle, result on the right, one advisor per row and the detail one tap away in a side panel. Refuses the old board's table that overflowed its card, the emoji source chips, the uppercase truncated KPI labels, the nested mobile cards and the paragraph-long legend.

OWN-WORLD: the operations world of DESIGN.md as the Master and Repro Provincia wear it: 28 px title with its context, period choice chips, ChoicePills for store and source, the team figures in one framed strip of cells on hairlines, one work card with the compact two-line table (tabular figures, ok/warn/crit text tones, the activity strip in brand / warn / crit / wash cells) and the SidePanel for the advisor.

STORY: The supervisor opens Productividad, reads today's calls, leads, closes and revenue against yesterday, scans the activity strips for dead hours, spots who cierra poco or deja enfriar los leads, opens her panel and sees which leads and fuentes; a vendedora sees only her own row and her own panel.

FIRST VIEWPORT: title and period line; the period chips with Tienda and Fuente pills on one row; the six team figures in one strip; the work card with its legend line and every advisor row visible at 1440 × 900 without page scroll.

FORM: the Stripe list page the Master and Repro Provincia already use (the committed world), pinned by the user's three answers; no roll and no seed key.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
