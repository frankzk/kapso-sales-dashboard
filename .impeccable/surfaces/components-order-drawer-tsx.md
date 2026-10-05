---
version: 1
slug: "components-order-drawer-tsx"
primary_target: "components/order-drawer.tsx"
related_targets: ["components/order-route-desk.tsx", "components/order-closure-desk.tsx", "components/order-line-items.tsx", "components/voice-agent-panel.tsx", "components/order-master-shared.tsx", "components/pickup-key-panel.tsx", "components/ops-ui.tsx"]
---

# Ficha del pedido

Scope: la ficha que abre el Master (y `order-drawer-host.tsx` en el resto del panel): velo y hoja, cabecera fija, pestañas Operar / Información / Actividad, situación y recorrido, próxima acción, gestión de confirmación (antes de llamar, historial del cliente, agente de voz, descartar la recuperación), mesa de ruta, salidas y guías (tracking de Olva, anular), mesa de cierre, gestión manual, pedido y cliente, ubicación y cobertura, productos y actividad. Desde el 03-10-2026 también el panel de cobro y clave (`pickup-key-panel.tsx`). Fuera, para un PR siguiente: los paneles de Aliclik y los modales de guía (Shalom, Tanders, Swayp, salida manual); aquí solo se viste su marco. Mode: Operate.
Audience: el equipo de operación en escritorio (confirmación, almacén, seguimiento, cierre, finanzas) con la ficha abierta sobre la tabla del Master; a veces desde el teléfono.
Job: saber dónde está el pedido, qué toca hacer ahora y hacerlo sin salir de la ficha; consultar el cliente, la ubicación y los productos; auditar lo ocurrido.
Constraints: MOM §25 entero — la cabecera conserva siempre pedido, estado comercial, monto, tienda, cliente y llamar/WhatsApp; las pestañas `Operar`, `Información` y `Actividad`; la próxima acción tiene título, explicación y acceso directo; el orden de decisión de Operar (dónde está, qué toca, qué la bloquea, cómo se ejecuta, qué falta cerrar); el color refuerza y nunca es la única señal, con los tonos de macroetapa del MOM. Conservar toda la lógica, textos de negocio y pruebas. Sin scroll horizontal; 44 px con puntero táctil.
Decisions (03-10-2026, Frankz): «ahora la ficha del pedido con impeccable», tras el Master («Tablero ahora, ficha después»); alcance «Ficha + mesas, pagos después». Después, «las secciones no quedan tan notorias»: de las opciones A (tarjetas), B (índice) y C (plegar), eligió «A + B», con el cobro rediseñado en el mismo trabajo.

## Direction contract

THESIS: The order as a Stripe payment-detail page in a side sheet: a fixed header that always says which order, its state, amount, client and how to reach them; underlined tabs; one next action stated plainly with one button; every desk below as a titled white card on the canvas (header over a hairline, inner zones on edge-to-edge hairlines, never a card inside a card), with an index of the tab's sections pinned under the tabs. Refuses the uppercase eyebrows, tinted cards per section, glyph arrows and emoji, and black buttons of the old drawer.

OWN-WORLD: the operations world of DESIGN.md — sheet with popover shadow over an ink veil, white header over the slate-50 canvas, section cards with control shadow and 16 px titles, 4 px chapas, 6 px controls, Kapta blue only for the primary action of each zone, the active tab, focus and links; wash for quiet frames; the MOM macroetapa hue on the stage chapa and the current step of the journey.

STORY: The operator opens a row; the header names the order and its state; Operar says where it stands, the next action and its button; the desk for that action sits right below; Información answers who, where and what; Actividad proves what happened.

FIRST VIEWPORT: header (order, state, amount, coverage, store · created · client · phone, Llamar, WhatsApp, close) and tabs; situación with the six-step journey; the next action card; the top of its desk.

FORM: Stripe Dashboard detail page in a side sheet (category canon), pinned by the user in words («estilo Stripe»); no roll and no seed key; accent translated to Kapta blue.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict and DESIGN.md.

---

# Paneles de Aliclik de la ficha

Scope: lo que la ficha dibuja dentro de su tarjeta «Aliclik» y la retención por duplicado: `components/aliclik-guide-panel.tsx` (crear guía: ubicación y cotización, revisión del pedido, del monto a cobrar, del recojo y de dónde cae el pin, transportadora y creación; vincular una guía ya creada en el portal), `components/aliclik-duplicate-panel.tsx` (también en la gestión de confirmación) y `components/aliclik-coverage-probe.tsx` (el bloque de Agencia que pregunta si Aliclik llega). El panel de crear guía también vive en el cajón de Leads, que conserva su aspecto anterior: allí se ve en su propia tarjeta. Mode: Operate.
Audience: la asesora de confirmación con el pedido confirmado; quien despacha Provincia COD.
Job: emitir la guía Aliclik correcta sin sorpresas —sobre el pedido correcto, por el monto correcto, al pin correcto y por la transportadora elegida—, ver antes de pulsar lo que la bloquea y por qué, y vincular la guía si ya se creó en el portal.
Constraints: toda la lógica se conserva —cotizar antes de crear, reintento acotado mientras Shopify devuelve la dirección, `busy` separado para cotizar y crear, aviso al cerrar mientras se crea, monto esperado que el servidor recalcula, compuertas de riesgo (§8), del veto y del duplicado (§8.3), del pin sin respaldo (§10) y de la escritura desactivada— y los textos de negocio. MOM §8, §8.3, §10 y §10.2. Sin glifos ni emoji. 44 px con puntero táctil.
Decisions (05-10-2026, Frankz): «vamos con los paneles de Aliclik de la ficha»; alcance «Los tres paneles» (también cambia en Leads); forma «Pasos como el cobro» (discos numerados con la línea entre pasos; los bloqueos como avisos antes de los pasos); detalle «Opciones y vincular al pie» (cada transportadora es una tarjeta-opción con su precio, la más barata elegida; «Vincular una guía ya creada» plegado al pie de la tarjeta).

## Direction contract (Aliclik)

THESIS: Creating an Aliclik guide is an irreversible write with money on it, so the card reads like the cobro: three numbered steps that end in one blue button, and everything that can stop the write said above the steps before anyone presses. Refuses the card inside the card, the sky-blue accordion on top, the ⚠ glyphs, the radio list and the error said twice.

OWN-WORLD: the ficha's section card on the canvas; `SectionHead` with the API health as a chapa; blockers as `Banner` (crit for duplicate and pin, warn for payment risk and Sunday pickup); the cobro's step discs and line; the figures frame for order and amount on `wash`; `OptionTile` per transportadora with the price tabular at the right; the fold at the bottom as an edge-to-edge zone.

STORY: The operator sees whether Aliclik is up and whether anything blocks the guide; pastes the pin if missing and quotes; reads which order, how much the door collects, when they pick it up and where the pin lands; picks the transportadora and creates.

FIRST VIEWPORT: the card head «Crear guía en Aliclik» with its health chapa and help; any blocker banners; step 1 with the location field and «Cotizar envío» as the card's primary until there is a quote.

FORM: the cobro's stepper inside a Stripe detail section (the ficha's committed world), pinned by the user in words («Pasos como el cobro»); no roll and no seed key.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
