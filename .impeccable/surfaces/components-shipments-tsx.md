---
version: 1
slug: "components-shipments-tsx"
primary_target: "components/shipments.tsx"
related_targets: ["app/dashboard/envios/page.tsx", "app/dashboard/envios/loading.tsx", "components/facet-pill.tsx", "components/direct-fenix-guide-modal.tsx", "components/swayp-novelty-modal.tsx", "components/order-link-picker.tsx"]
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

---

# Repro Provincia (cajón de la guía) — segundo cambio

Scope: el cajón de la guía (`ShipmentDrawer`, `/dashboard/envios?open=<id>`) con todo lo que lleva dentro —cabecera fija, aviso de borrador sin registrar, reserva, ficha de a quién se llama, novedad Swayp, reenvío de una guía anulada y llamadas de recuperación, resultado del courier Swayp, formulario de llamada con la elección de ruta, destino (con su editor) y pedido (con `OrderLinkPicker` y los productos), guía Swayp a mano, historial desde el origen con sus notas editables y el aviso de la última acción—; el modal «Resolver novedad de Swayp» que abre, y el modal «Guía Swayp directa» de la cabecera del tablero. Mode: Operate.
Audience: la asesora de reprogramación con la clienta al teléfono; quien audita guías cerradas.
Job: leer en segundos a quién se llama y qué decide la llamada (motivo anterior, destino, intentos, ruta posible), registrar el resultado con su consecuencia a la vista y pasar a la siguiente guía sin volver a la tabla.
Constraints: toda la lógica del cajón se conserva —reserva y solo lectura, `fieldset` que se deshabilita, borrador que avisa al salir, recarga atenuada de la misma guía, `key` por guía, segundos clics que nombran la guía o el pedido en lo que cierra la venta, reglas de fecha futura y de número Swayp, codbar, motivos de bloqueo en texto visible con `aria-describedby`, foco al aviso, `useDialogKeys`— y los textos de negocio. Las pruebas que solo fijaban el aspecto anterior se actualizan con la misma intención. 44 px con puntero táctil.
Decisions (05-10-2026, Frankz): «vamos con el cajón de la guía»; alcance «Cajón y sus modales»; forma «Como la ficha» (hoja de unos 640 px sobre el lienzo, cabecera fija blanca con guía, chapa, cliente · teléfono, Llamar y Siguiente, cada bloque en su tarjeta de sección, la acción del momento con el borde azul); resultado de la llamada como «Opciones a la vista» (tarjetas de opción de un toque con su consecuencia; lo que cierra la venta en rojo, con su segundo clic). En la revisión final: la tarjeta de arriba se titula «Cliente y destino» y no «A quién llamas», porque también la leen quienes registran lo que informó el courier en una guía en ruta, donde no se llama; el resultado del courier también son tarjetas de opción, y en el modal de novedad «Devolver al remitente» va en rojo con segundo clic.

## Direction contract (cajón)

THESIS: the guide drawer as the same Stripe detail sheet as the ficha del pedido: a sticky white head that answers who and what state, then section cards on the slate canvas in task order — who you are calling, the one action that is due now (blue-ringed), destination and order, history. Refuses the uppercase eyebrows, the tinted borders per section, the dropdown of outcomes and the rounded-xl stacks.

OWN-WORLD: DESIGN.md operations world — `SECTION_CARD` with `SectionHead` and `CARD_ZONE` hairline zones, figures frame on `wash`, option tiles with a 2 px brand ring when chosen (consequence copy in 13 px, the ones that close the sale in `crit-fg`), Badge tone pairs, `Banner` for notices, `FIELD` inputs, `OpsButton` with one primary per card and `danger` for what closes the sale.

STORY: The asesora presses Enter on a row; the sheet opens on the guide with the client and phone in the head; she reads the previous outcome and destination in the first card, taps an outcome tile, picks the date, types what the client said, registers, and presses «Siguiente» to land on the next guide.

FIRST VIEWPORT: the sticky head (guide code, state chip, client · phone with copy, Llamar, Siguiente, close), the reservation line, the «Cliente y destino» card with motivo, destino and the four figures, and the top of the action card with its outcome tiles.

FORM: Stripe Dashboard detail sheet (category canon), pinned by the user («como la ficha»); no roll and no seed key; accent translated to Kapta blue.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict and DESIGN.md.
