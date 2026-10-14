---
version: 1
slug: "components-leads-tsx"
primary_target: "components/leads.tsx"
related_targets: ["components/leads-drawer.tsx","components/leads-next.tsx","app/dashboard/leads/page.tsx","app/dashboard/leads/actions.ts","lib/leads.ts","components/ops-ui.tsx"]
---

# Leads

Scope: la página `/dashboard/leads` (`LeadsBoard`): cabecera, el «Tablero de hoy» (sin tocar), los chips de cola, segmento y cobertura, «Más filtros», el siguiente lead de cada vendedora, la cola, la ficha del lead (`LeadDrawer`), «Venta por teléfono» (`components/venta-telefonica.tsx`) y Anuncios (`/dashboard/leads/anuncios`, `components/ad-products.tsx`). Mode: Operate.
Audience: las vendedoras que llaman la cola todo el día en computadora; la supervisión que la mira.
Job: saber a quién llamar ahora, llamarlo, dejar el resultado y pasar al siguiente sin perder el lugar; filtrar la cola por segmento y cobertura viendo cuántos hay en cada uno.
Constraints: el «Tablero de hoy» (`LeadsInsightsPanel`) no se toca; el orden de la cola es «lo que más cierra» (`sortLeadsByPriorityScoped`, medido) o «Más recientes», nunca por reloj a escondidas; la reserva sigue siendo de 10 minutos y como mucho 2 por vendedora; los contadores siguen la jerarquía de facetas (`facetItems`); la cola no sabe nada del experimento; sin emojis; sin desplazamiento horizontal.
Decisions (14-10-2026, Frankz): dispositivo «Computadora»; tablero «no tocarlo»; chat «Estilo Kapta»; tras tres tandas, «A combinado con G» → **J · Siguiente a lo ancho**: los chips en máximo 2 filas, siempre visibles y con su contador (cola Sin llamar / En seguimiento; Atender ahora, Yape / Shalom, Seguimientos, Ganados, Perdidos; segmento y cobertura con todas sus opciones); el siguiente lead con más aire y **siempre uno distinto por asesora**; la reserva del siguiente **cuenta como una de sus 2**; la cola es **una sola lista siempre**, en el orden medido, con la edad en cada fila (agrupar por edad bajaba los carritos viejos debajo de los fríos recientes).
Aprobaciones con imagen (14-10-2026, Frankz; las imágenes no se versionan, viven en `.impeccable/mocks/leads/`): la estructura J (`j-siguiente-ancho.png`); la ficha del lead, mostrada en la primera tanda y nunca objetada (`ficha.png`); «Venta por teléfono» = «B · Panel lateral» (`real/venta-b-panel.png`); Anuncios = «Sí, así» (`real/anuncios-lista.png`, `real/anuncios-panel.png`), con «Declarar» que abre un panel con el producto sugerido ya escrito y nunca aplicado solo.
Decisiones de la construcción (14-10-2026, no son respuestas de Frankz): para caber en 2 filas, los chips «Todos» de segmento y cobertura salen (volver a tocar el chip activo lo quita), Edad, Ventana, Fuente, Producto, Número y «Última interacción» van a «Más filtros», y el orden va a la cabecera de la cola; el siguiente solo aparece a quien tiene el rol `vendedora`, en «Sin llamar», sin búsqueda, y es el primero de la cola filtrada que nadie más tiene; saltarlo lo suelta y no se le vuelve a ofrecer en esa pestaña; abrir otro lead de la cola suelta el siguiente antes de reservar el otro; la reserva se renueva sola mientras la pestaña está a la vista.
Corrección (14-10-2026, Frankz, ya en producción): «el desplegable de más filtros no está». Se había puesto en la cabecera de la cola, junto a «Orden», y nadie lo encontraba; vuelve al final de la primera fila de chips, a la derecha, como en J. Donde no cabe al lado de los chips baja a su propia línea antes que tapar un chip. Ese mismo día: «la búsqueda llévamela a la altura de las filas de los chips»; baja de la cabecera de la página al final de la primera fila, a la izquierda de «Más filtros», con la altura de los chips, y bajan juntas cuando no caben.
La tarjeta del siguiente lead (14-10-2026, Frankz, sobre tres propuestas en imagen: «opción A me parece genial, pero aún no uso el botón de WhatsApp ni de llamar; sería más darle prioridad a qué producto está preguntando, a si tiene un historial de pedidos pasados, en general mayor información del cliente o de la consulta, y la columna del medio se ve buena para registrar la gestión»; aprobó la imagen ajustada con «Sí, y a producción»): tres columnas —el cliente y lo que pregunta (foto del catálogo, unidades, pedidos antes, llamadas, WhatsApp, entrega, origen), registrar la gestión, y el chat que se desplaza dentro del alto—; llamar, WhatsApp y copiar quedan como iconos callados junto al nombre. Las imágenes viven en `.impeccable/mocks/leads/bloque/` (a, b, c, d y e).

## Direction contract

THESIS: A calling desk: the one lead that is yours to call now, wide and complete, above the measured queue. Everything to call, read the chat and leave the result is in the card; the queue below is for looking ahead. Refuses the old board's emoji chips and source glyphs, the 3 px colored side stripes, the uppercase column labels, the grey segmented tracks and the filter panel that hid half the counts.

OWN-WORLD: the operations world of DESIGN.md as the Master and Productividad wear it: 28 px title with its context line and the actions on the right; ChoiceChips and AttentionPills with counts on two rows; FilterPill «Más filtros» closing the first chip row on the right (as in J), opening a popover of the rarer facets; «Orden» in the queue card header; one white card for the next lead (identity, facts, buttons, result, chat in a wash column); one work card for the queue with its title row, column labels in 12 px ink-600, two-line rows and tabular figures; Badge for segment, cart amount and «Tomado · nombre»; the ficha as a SidePanel.

STORY: Lucía opens Leads and her next lead is already hers: María, carrito de S/ 129, hora dorada, reservada 10 minutos. She reads the chat, calls, marks «Casi cierra · hoy 18:00», saves, and the card is already Jorge. If she needs another lead from the queue she opens it and the reserved one goes back for Rosa.

FIRST VIEWPORT: header and the untouched board; the two chip rows; the next lead card with its call button above the fold at 1440 × 900 once the board is collapsed; the queue title row starts below.

FORM: the user pinned the structure over three dealt hands (seed key 12cf33f9, degraded, plus two re-rolls); this build follows the pinned J, not a roll.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and the MOM paragraph for the reserved next lead.
