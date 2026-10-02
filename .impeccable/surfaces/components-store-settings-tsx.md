---
version: 1
slug: "components-store-settings-tsx"
primary_target: "components/store-settings.tsx"
related_targets: ["app/dashboard/[storeId]/settings/page.tsx","components/settings-ui.tsx"]
---

# Ajustes de tienda

Scope: toda la pantalla `/dashboard/[storeId]/settings` (componente `StoreSettings`). Mode: Operate.
Audience: owner o admin de la organización, en escritorio, configurando una tienda (Kenku, Aurela) o volviendo a tocar un ajuste concreto (un webhook, una plantilla, un interruptor).
Job: encontrar el ajuste en segundos, entender su estado antes de tocarlo y guardar solo lo que cambió.
Constraints: conservar cada campo, su `name`, su acción de servidor, sus pruebas (`test/store-settings-wiring.test.ts`, `test/copy-to-clipboard.test.ts`) y los textos de ayuda; el servidor solo parchea los campos que llegan (`buildStoreUpdate`), así que partir el formulario no borra nada.
Decisions (02-10-2026, Frankz): estilo Stripe Dashboard en el mundo de operación de DESIGN.md; página única con índice lateral fijo; «Guardar» por tarjeta.

## Direction contract

THESIS: Ajustes como la página de configuración de Stripe: un índice fijo que es el mapa de la tienda y tarjetas que se guardan solas. Rechaza el formulario único de 25 bloques del mismo peso con un solo «Guardar» a 3.000 px del campo tocado.

OWN-WORLD: El mundo de operación de DESIGN.md sin cambios: lienzo slate-50, tarjetas blancas de 8 px con anillo `line` y sombra de control, hairlines entre filas, tinta ink-900/700/500, azul Kapta solo en el «Guardar», el interruptor encendido, el ítem activo del índice y los enlaces; chapas de 4 px para el estado de cada conexión y automatización; avisos en el lavado del tono; sans del sistema, título de 28 px.

STORY: El admin ve el índice agrupado (General, Conexiones, Mensajes automáticos, Cobranza, Operación, Sistema), salta a la sección, lee su chapa de estado, cambia lo que necesita y guarda esa tarjeta; la tarjeta dice si hay cambios sin guardar y confirma el guardado ahí mismo.

FIRST VIEWPORT: Título «Ajustes» con la tienda y el dominio debajo y «Volver al panel» a la derecha; a la izquierda el índice pegajoso de 13 rem con el ítem visible marcado; a la derecha el grupo General: «Tienda» (nombre, estado, moneda, zona horaria, prefijo) con su pie de «Guardar», y debajo «Confirmación».

FORM: Página de ajustes de Stripe Dashboard (canon de la categoría), fijada por el usuario en palabras; sin tirada ni seed key.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
