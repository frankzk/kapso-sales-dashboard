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
