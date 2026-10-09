---
name: Kapta
description: Mundo de operación de Kapta. El lenguaje del panel de Stripe con el azul Kapta, para operar pedidos y despacho.
colors:
  brand-600: "#1f5fe0"
  brand-700: "#1b4fbd"
  brand-500: "#2f74ff"
  brand-50: "#eef6ff"
  brand-100: "#d9eaff"
  ink-900: "#1a1b25"
  ink-700: "#414552"
  ink-600: "#545969"
  ink-500: "#687385"
  ink-300: "#a3acba"
  line-strong: "#d5dbe1"
  line: "#ebeef1"
  wash: "#f6f8fa"
  white: "#ffffff"
  slate-50: "#f8fafc"
  ok-bg: "#d7f7c2"
  ok-fg: "#006908"
  ok-wash: "#effbea"
  info-bg: "#cff5f6"
  info-fg: "#0055bc"
  info-wash: "#eefafb"
  warn-bg: "#fcedb9"
  warn-fg: "#a82c00"
  warn-wash: "#fef8e4"
  crit-bg: "#ffe7f2"
  crit-fg: "#b3063d"
  crit-wash: "#fff3f8"
  urgent: "#df1b41"
typography:
  headline:
    fontFamily: "ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: "36px"
    letterSpacing: "-0.01em"
  figure:
    fontFamily: "ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "28px"
    fontFeature: "'tnum'"
  title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: "20px"
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  body-sm:
    fontFamily: "ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.5
  label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: "16px"
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  full: "9999px"
spacing:
  "0.5": "2px"
  "1.5": "6px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "8": "32px"
components:
  button-primary:
    backgroundColor: "{colors.brand-600}"
    textColor: "{colors.white}"
    typography: "{typography.title}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.brand-700}"
  button-secondary:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink-700}"
    typography: "{typography.title}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "{colors.wash}"
    textColor: "{colors.ink-900}"
  button-ghost:
    textColor: "{colors.ink-600}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "{colors.wash}"
    textColor: "{colors.ink-900}"
  button-danger:
    backgroundColor: "{colors.white}"
    textColor: "{colors.crit-fg}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  button-danger-hover:
    backgroundColor: "{colors.crit-wash}"
  field:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink-900}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  badge-neutral:
    backgroundColor: "{colors.line}"
    textColor: "{colors.ink-600}"
    rounded: "{rounded.sm}"
    padding: "0 6px"
    height: "20px"
  badge-ok:
    backgroundColor: "{colors.ok-bg}"
    textColor: "{colors.ok-fg}"
    rounded: "{rounded.sm}"
    height: "20px"
  badge-info:
    backgroundColor: "{colors.info-bg}"
    textColor: "{colors.info-fg}"
    rounded: "{rounded.sm}"
    height: "20px"
  badge-warn:
    backgroundColor: "{colors.warn-bg}"
    textColor: "{colors.warn-fg}"
    rounded: "{rounded.sm}"
    height: "20px"
  badge-crit:
    backgroundColor: "{colors.crit-bg}"
    textColor: "{colors.crit-fg}"
    rounded: "{rounded.sm}"
    height: "20px"
  badge-urgent:
    backgroundColor: "{colors.urgent}"
    textColor: "{colors.white}"
    rounded: "{rounded.sm}"
    height: "20px"
  badge-brand:
    backgroundColor: "{colors.brand-50}"
    textColor: "{colors.brand-700}"
    rounded: "{rounded.sm}"
    height: "20px"
  filter-pill:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink-600}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.full}"
    padding: "0 12px 0 8px"
    height: "32px"
  filter-pill-active:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink-700}"
    rounded: "{rounded.full}"
    height: "32px"
  status-card:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink-900}"
    typography: "{typography.figure}"
    rounded: "{rounded.lg}"
    padding: "10px 14px"
  status-card-active:
    textColor: "{colors.brand-700}"
  tab:
    textColor: "{colors.ink-500}"
    typography: "{typography.title}"
    height: "48px"
  tab-active:
    textColor: "{colors.brand-700}"
  segmented-track:
    backgroundColor: "{colors.wash}"
    rounded: "{rounded.lg}"
    padding: "2px"
  segmented-option-active:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink-900}"
    rounded: "{rounded.md}"
    height: "36px"
  card:
    backgroundColor: "{colors.white}"
    rounded: "{rounded.lg}"
  sheet:
    backgroundColor: "{colors.white}"
    rounded: "{rounded.lg}"
    padding: "16px"
  switch:
    backgroundColor: "{colors.white}"
    rounded: "{rounded.full}"
    height: "20px"
    width: "36px"
  switch-on:
    backgroundColor: "{colors.brand-600}"
  index-item:
    textColor: "{colors.ink-600}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  index-item-active:
    backgroundColor: "{colors.brand-50}"
    textColor: "{colors.brand-700}"
  master-row-selected:
    backgroundColor: "{colors.brand-50}"
  master-row-open:
    backgroundColor: "{colors.brand-100}"
    textColor: "{colors.brand-700}"
  bulk-bar:
    backgroundColor: "{colors.white}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
  banner-warn:
    backgroundColor: "{colors.warn-wash}"
    textColor: "{colors.ink-700}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
---

# Design System: Kapta

## Overview

**Creative North Star: "La Mesa de Despacho"**

Kapta se opera como una mesa de trabajo limpia: superficies blancas sobre un lienzo pizarra muy claro, líneas finas en lugar de cajas pesadas y un solo azul que dice dónde actuar. El mundo de operación toma el lenguaje del panel de Stripe (página de lista con cifras que filtran, tabla que es el trabajo, excepciones esperando al borde) y lo traduce al azul Kapta. La densidad es de escritorio con ratón, pero todo control se agranda a objetivo de dedo cuando el puntero es táctil, porque el mismo supervisor trabaja de pie en almacén con un lector o un celular.

La personalidad es clara, rápida y confiable: tinta azulada en tres pasos para jerarquía, chapas de estado de 4 px que siempre llevan texto, sombras cortas que apenas despegan los controles del papel. Nada decora; todo lo que tiene color significa algo. El movimiento se limita a transiciones de estado de 150 ms y a decir que algo carga o entra (el esqueleto en `wash`, la barra de subida de una foto, la ficha de `/reparto` que entra desde la derecha en el teléfono); lo que se desplaza se apaga con movimiento reducido.

**Alcance actual (03-10-2026).** Este mundo es la dirección aprobada para todo el producto, pero hoy está en producción en la cabecera y las pestañas de Grupo GF Courier, en «Despacho del día» (tarjetas de estado, QR, lista, cajas, devoluciones y hojas), donde se estrenó el 29-09-2026, y, desde el mismo día, en Rutas (también en `/dashboard/courier/rutas`) y Tarifario, en los dos paneles laterales que abre Rutas —la caja y «Reparto y liquidación» (cierre, resumen, tabla de paradas y pago del motorizado)— en la estación «Almacén» (`/dashboard/pedidos/almacen`: escáner de armado, «Por empacar» como un marco con una celda por operación cuyo lavado dice si está en cero, cerca del corte o vencida, la cola por armar como listas con hairlines y las detenidas en ámbar con su chapa, y «Armados hoy»), en «Devoluciones» (`/dashboard/pedidos/devoluciones`, Tanders y Shalom desde el 03-10-2026: el mismo escáner con la guía de retorno de Shalom como campo opcional, y un cuadre por courier en un marco de cifras —«Faltan» de Tanders en lavado crítico si hay algo que reclamar, «Por recibir» de Shalom en ámbar, porque esa caja hay que ir a buscarla— con las listas de pendientes y recibidas) y en la mesa «Entregas a couriers» (`/dashboard/pedidos/despacho`: cifras del día, rutas recientes, destino elegido, paquetes sin ruta, «¿Quién recoge?» y «Nueva ruta»). Desde el 30-09-2026 también está en la pantalla del motorizado (`/reparto`, la misma que abre Coordinación para reportar por él): la lista de paradas con «Añadir un punto», la ficha de la parada con su reporte, la hoja de WhatsApp, los campos de evidencia y la cámara dentro de la página. Desde el 02-10-2026 también está en Ajustes de la tienda (`/dashboard/[storeId]/settings`): el índice lateral, los grupos y secciones con su chapa de estado, y las tarjetas que se guardan cada una por su cuenta, en Tiendas (`/dashboard/stores`): la lista de tiendas con su chapa de estado y las anomalías de ingesta, cuya fila abre su ejemplo, y en el tablero del Master de Pedidos (`/dashboard/pedidos`): las siete tarjetas de macroetapa, las subetapas y la fecha pactada en chips, los filtros en píldoras, la tabla compacta y la barra de acciones en lote. Desde el 03-10-2026 también la ficha del pedido que abre el Master (y el resto del panel): cabecera fija, pestañas, situación y recorrido, próxima acción, gestión de confirmación, mesas de ruta y de cierre, salidas y guías, gestión manual, ubicación, productos y actividad, con sus secciones en tarjetas sobre el lienzo y el índice de la pestaña bajo las pestañas, y el cobro con la credencial de Shalom; dentro de ella, los modales de guía siguen con el aspecto anterior hasta su propio cambio. Desde el 05-10-2026 también los paneles de Aliclik de la ficha —crear la guía, la retención por posible duplicado (que la gestión de confirmación también muestra) y «Comprobar si Aliclik llega» del bloque de Agencia—; el cajón de Leads enseña el de crear guía igual, en su propia tarjeta. Desde el 05-10-2026 también la cabecera y las pestañas subrayadas de «Cotejar Olva» (`/dashboard/olva`) y su pestaña «Correos de Olva» (`?vista=correos`): tarjetas de estado que filtran, una tarjeta de trabajo con los correos por día sobre bandas `wash`, cada fila con hora, tracking en monoespaciada, destinatario, la chapa del resultado con su frase y el pedido como enlace en `brand-700` (o «Vincular» con su campo de 32 px); es una sola columna en el teléfono, dos (a quién iba / qué pasó) desde `lg` y tabla de cinco columnas desde `xl`. El cuerpo de «Cotejo del portal» sigue con el aspecto anterior hasta su propio cambio. Desde el mismo día también el tablero de Repro Provincia (`/dashboard/envios`): las seis vistas en tarjetas de cifra, la ruta en chips, los filtros en píldoras (compartidas con el Master en `components/facet-pill.tsx`), la tabla compacta y su lista, el resumen plegable y el detalle de reprogramaciones; y, desde el mismo día, el cajón de la guía (`/dashboard/envios?open=<id>`) con sus modales «Resolver novedad de Swayp» y «Guía Swayp directa» y el selector de pedido (`OrderLinkPicker`, que también se ve así en la revisión de importación y en la cola de recuperación de devoluciones). Los tres pasos de la caja (`DispatchBoxPanel`) se ven igual en la mesa y en el panel; en la mesa la sección lleva la sombra de tarjeta porque está sobre el lienzo. Excepción consciente: bajo 1024 px las filas del Tarifario se vuelven tarjetas con el módulo compartido `components/courier-mobile.module.css`, que también usan las vistas anteriores y no se tocó; la tarjeta exterior se quita ahí para no anidar tarjetas. El resto de la aplicación (las partes de `components/routes.tsx` que el panel no muestra —añadir paradas y reintentos—; en `/reparto`, «Recibir mi caja» y el escáner de QR de «Confirmar todos» y «Lo llevo», montado sin `look="ops"`, y su cámara; las vistas anteriores del courier, los modales de guía de la ficha del pedido, Liquidaciones y demás) sigue con el aspecto anterior: Tailwind `slate-*`, `brand-600` como acento, radios `rounded-xl`/`rounded-2xl` y `shadow-xl`. Ese aspecto es deriva preexistente, no una segunda norma: las superficies nuevas o rediseñadas usan este documento. No hay esquema oscuro; el producto declara `color-scheme: light`. La única superficie oscura es el visor de la cámara, negro como en la cámara del teléfono.

**Key Characteristics:**
- Superficies blancas con líneas finas (`line`) sobre el lienzo `slate-50`.
- Tinta azulada en pasos (`ink-900` / `ink-700` / `ink-500`) en lugar de grises neutros.
- Azul Kapta solo para acción principal, selección, pestaña activa y enlaces.
- Chapas de estado de 4 px en pares fondo/texto; avisos sobre el lavado del mismo tono.
- Controles de 6 px con sombra corta; tarjetas y hojas de 8 px; píldoras redondas.
- Sans del sistema, título de 28 px en negrita, cuerpo de 14 px, cifras tabulares.
- Una sola familia de iconos de trazo.

## Colors

Una paleta fría y contenida: tinta azulada, hairlines casi invisibles, un azul de acción y cuatro tonos de estado que nunca aparecen sin texto.

### Primary
- **Azul Kapta** (`brand-600`): la acción principal de cada zona (Asignar, Programar, Escanear), la línea de 2 px bajo la pestaña activa, el borde de 2 px de la tarjeta de estado elegida, los iconos del modo activo, las casillas y el interruptor encendido.
- **Azul Kapta profundo** (`brand-700`): hover del botón principal, texto de enlaces («Ver actividad», «Arreglar en Tarifario»), texto de la pestaña activa, el valor dentro de una píldora de filtro y la cifra de una tarjeta elegida.
- **Azul de foco** (`brand-500`): el contorno de foco visible de todo el producto (2 px con 2 px de separación) y el anillo interior de 2 px de los campos enfocados.
- **Velo azul firme** (`brand-100`): solo la fila del Master cuya ficha está abierta (al 70 %), para que «lo que estoy mirando» no se confunda con «lo que elegí».
- **Velo azul** (`brand-50`): fondo de filas marcadas (al 60 %), chips y opciones de elección encendidos, el ítem activo del índice de Ajustes y la chapa `brand` (contador de la pestaña activa y «Siguiente», la próxima parada del motorizado).

### Neutral
- **Tinta** (`ink-900`): títulos, nombres de pedido, cifras y todo lo que se lee primero.
- **Tinta media** (`ink-700`): texto de controles secundarios, etiquetas de campo, texto de avisos.
- **Tinta de apoyo** (`ink-600`): encabezados de tabla, etiquetas de tarjetas de estado, texto de la chapa neutra y del botón fantasma.
- **Tinta tenue** (`ink-500`): contexto, metadatos, marcadores de posición, iconos en reposo y pestañas inactivas.
- **Tinta de borde activo** (`ink-300`): el anillo o borde de una píldora o chip al pasar el puntero.
- **Línea fuerte** (`line-strong`): el anillo de 1 px de campos, botones secundarios y píldoras; el borde discontinuo de la píldora vacía.
- **Línea** (`line`): hairlines entre filas, bajo las pestañas y alrededor de tarjetas; también el fondo de la chapa neutra.
- **Lavado** (`wash`): hover de filas y botones, pista del control segmentado, barra de acciones masivas, campos deshabilitados.
- **Superficie** (`white`): tarjetas, tablas, hojas, controles.
- **Lienzo** (`slate-50`): el fondo de la página, heredado del armazón del panel; el blanco se lee sobre él sin necesidad de sombra fuerte.

### Estados
- **Correcto** (`ok-bg` / `ok-fg`, lavado `ok-wash`): entregado, verificado, operación completada.
- **Información** (`info-bg` / `info-fg`, lavado `info-wash`): en curso, ayudas contextuales.
- **Atención** (`warn-bg` / `warn-fg`, lavado `warn-wash`): motivos de bloqueo, programados para otro día, contadores de excepción mayores que cero.
- **Crítico** (`crit-bg` / `crit-fg`, lavado `crit-wash`): errores y acciones destructivas.
- **Urgente** (`urgent`): la única chapa sólida con texto blanco, reservada para lo que no puede esperar.
- **Macroetapas del MOM** (excepción consciente): la macroetapa de un pedido lleva el tono que fija el MOM (§25 de `docs/mom/master-pedidos-v1.md`): ámbar para confirmación, celeste para preparación, índigo para despacho, cian para seguimiento, naranja para cierre, verde para completado y gris para consulta. Va en chapa de 4 px con el par `*-100` / `*-800` de Tailwind (`MacroStageBadge`) y, en las tarjetas de macroetapa, como un cuadro de 8 px en `*-500` delante de la etiqueta (`MacroStageDot`), que hace de leyenda de la tabla. Son tonos de una regla de negocio, no estados de este sistema: no se usan para nada más.
- **Cobertura** (excepción consciente, 09-10-2026): la cobertura del pedido es una clasificación y no un estado, así que no usa los pares `ok`/`warn`/`crit` —un «Agencia» en ámbar se leería como un problema— ni los matices de las macroetapas, que van en la misma fila. Lleva un tinte suave de un matiz propio: fondo `*-50`, anillo interior `*-200` y texto `*-800` de Tailwind, Lima en violeta, Provincia COD en verde azulado (`teal`) y Agencia en fucsia (`CoverageBadge`, en `components/coverage-badge.tsx`). Queda más callado que la chapa de etapa (`*-100` / `*-800`), que sigue siendo lo más fuerte de la fila. «Por revisar» es la única con el par `warn`, porque pide que alguien actúe. El texto dice siempre la cobertura: el color ayuda a escanear, no la sustituye.

### Named Rules
**The Azul con Oficio Rule.** El azul Kapta solo marca acción principal, selección, pestaña activa, foco y enlaces. Nunca es un fondo de sección, un adorno ni un color de estado.

**The Tono Emparejado Rule.** Un estado siempre es un par fondo/texto del mismo tono (`*-bg` con `*-fg`) con palabras dentro; un aviso usa el lavado del tono (`*-wash`) con icono y título en `*-fg` y el cuerpo en tinta. El color nunca es la única señal.

**The Resultado en su Tono Rule.** Elegir un resultado es declarar un estado: la opción encendida toma el par de su tono con anillo de 2 px en `*-fg`, icono y palabra (Entregado en `ok`, No entregado en `crit`). Elegir entre opciones que no son estados (método de pago, motivo, cuenta) es selección y va en azul: `brand-50`, texto `brand-700` y anillo de 2 px en `brand-600`.

## Typography

**Display Font:** ninguna fuente web; la sans del sistema (`ui-sans-serif, system-ui, sans-serif`)
**Body Font:** la misma sans del sistema
**Label/Mono Font:** `ui-monospace` solo para códigos QR y de paquete

**Character:** La sans nativa de cada plataforma es deliberada en una herramienta de operación: carga al instante, se lee como el sistema operativo y deja que la jerarquía la hagan el peso y la tinta, no la fuente.

### Hierarchy
- **Headline** (700, 28px, 36px, -0.01em): el título de la página («Grupo GF Courier»), uno por pantalla y sin antetítulo encima.
- **Figure** (600, 20px, 28px, tabular): la cifra de una tarjeta de estado.
- **Title** (600, 14px, 20px): títulos de tarjeta y de hoja, pestañas en escritorio, botones, nombres de pedido.
- **Body** (400, 14px, 20px): celdas de tabla, campos, texto de avisos.
- **Body-sm** (500 o 400, 13px): resumen del día, etiquetas de campo y de tarjeta, píldoras, pestañas en el teléfono, metadatos.
- **Label** (600, 12px, 16px): encabezados de tabla; las chapas usan 12 px en peso 500.
- **Code** (400, 11–12px, mono): códigos QR y de paquete dentro de listas.

**Escala de calle.** Dentro de `.rider-scale` (la pantalla del motorizado) el texto sube un 30 % y el diseño no: 12 → 15,6 px, 14 → 18,2 px, 16 → 20,8 px y 18 → 23,4 px. En la ficha, el monto (por cobrar o cobrado) es la cifra más grande de la pantalla (28 px en peso 700, tabular).

### Named Rules
**The Cifras Tabulares Rule.** Toda cantidad, monto y fecha va en cifras tabulares y con el formato `es-PE`, para que las columnas y los contadores no bailen al cambiar.

**The Título Solo Rule.** El título de 28 px no lleva antetítulo, eyebrow ni kicker; el contexto va en una línea de 14 px en `ink-500` debajo.

## Layout

Página de lista al estilo de Stripe dentro del armazón del panel (márgenes de 16 px en el teléfono, 20 px desde `sm`, 32 px desde `lg`; 24 px arriba). El orden vertical es fijo: título y pestañas subrayadas; una línea con el botón del día, el resumen del día y las píldoras de excepción; la fila de tarjetas de estado; la tarjeta de trabajo; debajo, la herramienta activa (campo de escaneo o barra de herramientas con buscador, píldoras de filtro, barra de acciones y tabla). Los bloques se separan 16 px; dentro de una tarjeta, 16 px de relleno y 12 px entre grupos; los controles de una fila, 8 px.

Las tarjetas de estado forman una grilla de 2 columnas en el teléfono, 3 desde `sm` (640 px) y 7 desde `xl` (1280 px), con «Programados para mañana» junto a «Programados hoy». La tabla de escritorio tiene columnas de ancho fijo para lo corto y flexibles para pedido, cliente y estado, cabecera pegajosa con hairline inferior y un máximo de 60vh con desplazamiento propio; bajo `sm` la misma fila se convierte en tarjeta de lista, sin desplazamiento horizontal. Las pestañas pasan de una grilla de cuatro celdas en el teléfono a una fila con 24 px entre pestañas en `lg`.

Con puntero táctil (`pointer: coarse`) todo botón, selector y campo sube a 44 px mínimo; con ratón, el escritorio conserva la densidad de 32–36 px. La decisión se toma por método de entrada, no por ancho de pantalla.

La pantalla del motorizado (`/reparto`) es una columna de teléfono de 448 px como máximo sobre el lienzo, con cabecera blanca pegajosa; desde `lg` es una grilla de dos columnas, la lista de 448 px y la ficha a su lado. En el teléfono la ficha cubre la lista, «atrás» la cierra y el desplazamiento es solo suyo; su cabecera arriba y «Guardar» abajo quedan fijos, al alcance del pulgar y con el margen del área segura.

### Named Rules
**The Cifras Navegan Rule.** Las tarjetas de estado son filtros, no adornos: cada una abre su parte de la lista, y la elegida lleva el borde azul. Si una cifra no filtra nada, no va en tarjeta.

**The Escala de Calle Rule.** En `/reparto` crece el texto, no el sistema: colores, radios, anillos y sombras son los mismos, pero ningún objetivo baja de 48 px —tampoco los enlaces de texto como «Copiar» o «Waze»— y en la ficha los gestos (Ir · WhatsApp · Llamar, Entregado / No entregado) miden 56 px.

## Elevation & Depth

Sistema casi plano. La profundidad la dan los anillos de 1 px (`line`, `line-strong`) y el contraste del blanco sobre el lienzo; las sombras son cortas y con desplazamiento vertical, del lenguaje de Stripe, y solo tres.

### Shadow Vocabulary
- **Control** (`box-shadow: 0 1px 1px rgb(0 0 0 / 0.07), 0 2px 5px rgb(60 66 87 / 0.07)`): botones secundarios, campos, píldoras con valor, tarjetas de estado, la tarjeta de trabajo, la opción activa del control segmentado.
- **Principal** (`box-shadow: 0 1px 1px rgb(0 0 0 / 0.12), 0 2px 5px rgb(31 95 224 / 0.2)`): solo el botón principal; la sombra lleva un velo del azul.
- **Popover** (`box-shadow: 0 0 0 1px rgb(64 68 82 / 0.08), 0 5px 15px rgb(0 0 0 / 0.1), 0 15px 35px rgb(48 49 61 / 0.08)`): hojas de filtro, menús («Más vistas») y cualquier capa que flota sobre la página.

### Named Rules
**The Sombra Corta Rule.** Lo que está en la página lleva como mucho la sombra de control; solo lo que flota encima lleva la de popover. Nada de `shadow-xl` ni sombras difusas grandes.

## Shapes

Cuatro radios y ninguno más: 4 px para chapas y casillas, 6 px para botones, campos y opciones internas, 8 px para tarjetas, hojas, avisos y la pista del control segmentado, y redondo completo para píldoras de filtro, píldoras de excepción y chips de elección. Los bordes son anillos interiores de 1 px; la selección sube el anillo a 2 px en `brand-600`. El borde discontinuo significa «vacío o disponible»: la píldora de filtro sin valor y el hueco de casilla de una fila que solo se sigue. La línea de la pestaña activa es una barra de 2 px sin radio.

### Named Rules
**The Cuatro Radios Rule.** 4, 6, 8 o redondo. `rounded-xl` y `rounded-2xl` pertenecen al aspecto anterior y no entran en superficies del mundo de operación.

## Components

### Buttons
Firmes y discretos: se distinguen por relleno y sombra, no por tamaño.
- **Shape:** esquinas suaves (6px); alturas de 32, 36 y 44 px (`sm`, `md`, `lg`); icono de 16 px con 6–8 px de separación; texto en peso 600.
- **Primary:** azul Kapta con texto blanco y la sombra principal; uno por zona de trabajo.
- **Hover / Focus:** el principal oscurece a `brand-700`; secundario y fantasma pasan a `wash` con texto `ink-900`; transición de fondo, color y sombra en 150 ms; foco con el contorno azul global.
- **Secondary:** blanco, texto `ink-700`, anillo `line-strong` y sombra de control. Es la variante por defecto.
- **Ghost:** sin fondo ni anillo, texto `ink-600`; para «Quitar filtros», «Cancelar», «Volver a hoy».
- **Danger:** blanco con texto `crit-fg` y hover `crit-wash`; nunca un rojo sólido.
- **Disabled:** 50 % de opacidad y cursor de no permitido.

### Chips
- **Chapa (Badge):** 20 px de alto, 4 px de radio, 12 px en peso 500, par de tono (`neutral`, `info`, `ok`, `warn`, `crit`, `urgent`, `brand`). Si el texto es largo, parte en líneas en vez de cortarse.
- **Píldora de filtro:** vacía es discontinua (`line-strong`) con «+» y la etiqueta en `ink-600`; con valor pasa a sólida con sombra de control, una «x» para quitarla, un separador de 1 px y el valor en `brand-700`. Un filtro de sí/no se enciende con el mismo toque.
- **Píldora de excepción:** blanca y redonda con icono, etiqueta y una chapa de contador (`warn` si hay algo, `neutral` en cero); activa sube a anillo azul de 2 px.
- **Chapa de cobertura:** la misma chapa de 20 px con el tinte de su operación (ver «Estados → Cobertura»): Master, ficha y excepciones por distrito en Ajustes.
- **Chip de elección:** redondo, 32 px; encendido en `brand-50` con anillo azul de 2 px; en cero, deshabilitado al 40 %.

### Cards / Containers
- **Corner Style:** 8px.
- **Background:** blanco sobre el lienzo `slate-50`.
- **Shadow Strategy:** sombra de control más anillo `line`; nada anidado dentro de otra tarjeta con sombra.
- **Border:** anillo de 1 px en `line`; las secciones internas se separan con hairlines `line`, no con tarjetas.
- **Internal Padding:** 16px; las tarjetas de estado usan 10px × 14px.
- **Tarjeta de sección** (`SECTION_CARD`, la ficha del pedido): blanca con anillo `line` y sombra de control, 16 px de relleno (20 px desde `sm`) y 16 px entre tarjetas (24 px desde `sm`). Arriba, `SectionHead`: título de 16 px peso 600 con su chapa, la ayuda en 13 px `ink-500` y a la derecha lo que no guarda nada, sobre una hairline que cruza la tarjeta entera. Dentro, cada bloque es una zona (`CARD_ZONE`) sobre otra hairline de borde a borde, y las listas son filas con hairlines de borde a borde: un marco dentro de la tarjeta sería una tarjeta dentro de otra. Dos excepciones conscientes: las tarjetas-opción, lo que se elige con un toque (las modalidades de la mesa de ruta, las acciones de la mesa de cierre), que llevan su propio anillo porque son controles y no contenedores; y el marco de cifras, que es un dato con celdas, no una caja de contenido.

### Tarjeta-opción (OptionTile)
Lo que se elige con un toque y tiene consecuencia (el resultado de una llamada, una ruta, una transportadora, la resolución de un duplicado): botón de 8 px con relleno 10 × 12 px, título de 14 px peso 600 y debajo, en 13 px `ink-600`, lo que va a pasar; apagada, primero el porqué en `warn-fg` cuando es un bloqueo (una transportadora que no llega). En reposo, blanca con anillo interior `line-strong`; elegida, `brand-50` con anillo azul de 2 px, título en `brand-700` y `aria-pressed`; en `crit-fg` lo que no se deshace. Admite una chapa junto al título («Más barata», «Express») y, a la derecha, la cifra que se compara (el precio, tabular). Apagada atenúa solo la fila del título: el porqué se sigue leyendo. El contenido empieza arriba aunque la rejilla estire la fila.

### Pasos (Step)
Un registro en varios pasos dentro de una tarjeta (el cobro, la guía de Aliclik): una lista ordenada con un disco de 24 px por paso —su número en `ink-600` sobre blanco con anillo `line-strong`, o `ink-900` con visto al estar hecho— y una línea de 1 px que baja al siguiente, `line-strong` o `ink-500` si el paso ya está hecho. Título de 14 px peso 600 con su estado en chapa, la ayuda en 13 px `ink-500` y lo suyo debajo, sangrado tras el disco. El lector oye «Paso n» y «(hecho)».

### Inputs / Fields
- **Style:** 36 px (40 px para el selector de motorizado), blanco, anillo interior `line-strong`, sombra de control, 6px, texto 14 px en `ink-900`, marcador en `ink-500`. En el escáner compacto el campo sube a 48 px en el teléfono con texto de 16 px.
- **Focus:** el anillo pasa a 2 px en `brand-500`, sin contorno exterior.
- **Error / Disabled:** deshabilitado sobre `wash` con texto `ink-500`; los errores se dicen en un aviso `crit`, no pintando el campo.
- **Casilla:** nativa, 16 px, `accent-color` en `brand-600`.
- **Otro tamaño:** `FIELD` trae 36 px a todo el ancho; para un campo de 32 px o de ancho fijo se parte de `FIELD_BOX` y se ponen alto, ancho y relleno. `cn` solo junta clases y en el CSS `h-9` va detrás de `h-8` y `w-full` detrás de `w-44`, así que sumarlos a `FIELD` no cambia nada.

### Navigation
- **Pestañas subrayadas:** texto en peso 600 (13 px en el teléfono, 14 px desde `lg`), `ink-500` en reposo y `ink-900` al pasar; la activa en `brand-700` con barra de 2 px en `brand-600` sobre la hairline `line` del contenedor; objetivo mínimo de 48 px. El contador va como chapa (`brand` en la activa, `neutral` en las demás); en el teléfono solo la activa muestra su número, como texto.
- **Más vistas:** las vistas anteriores viven en un menú «Más vistas» (icono de tres puntos, 48 px) al final de las pestañas, con sombra de popover.

### Control segmentado
La forma de asignar (QR, lista, cajas) es una pista `wash` de 8px con 2px de relleno; la opción activa es una pieza blanca de 6px con sombra de control y anillo `line`, su icono en `brand-600`. En el teléfono cada opción muestra su etiqueta corta.

### Hojas y popovers
Hoja `look="ops"`: blanca, 8px, sombra de popover, 16px de relleno, título de 14 px en peso 600 y un botón de cierre de 28 px con icono de trazo. En escritorio se ancla bajo su botón (360 px de ancho, acotada a la pantalla); bajo 640 px es una hoja inferior. Escape y un clic fuera la cierran.

### Panel lateral (SidePanel)
Velo `ink-900` al 30 % sin desenfoque; hoja blanca a la derecha con la sombra de popover y el ancho que pide quien la abre (760 px la caja, 960 px el reparto). La ficha del pedido no es un `SidePanel`: lleva el lienzo dentro y sus secciones en tarjetas (ver «Ficha del pedido»). Cabecera pegajosa con hairline inferior: nombre en 18 px peso 600, la chapa de situación a su lado y el contexto (día, carga) en 13 px `ink-500` debajo; cierre de 32 px con icono de trazo. Cuerpo con 16 px de margen en el teléfono y 24 px desde `sm`. Dentro, las secciones se separan con hairlines o marcos `line` sin sombra; el resumen de cifras es un solo marco con hairlines entre celdas, y el saldo va sobre `wash`. La carga es un esqueleto en `wash`.

### Interruptor (Switch)
Lo que se enciende y se apaga en un ajuste: una pista redonda de 36 × 20 px. Apagado, la pista es blanca con un anillo de 1 px en `ink-500` y el botón de 14 px es `ink-500` (4,8:1 sobre blanco: una pista gris clara se queda en 1,4:1 y no cumple el contraste de componentes); encendido, la pista y su anillo pasan a `brand-600`, el botón se vuelve blanco con sombra de control y se corre 16 px en 150 ms (sin movimiento con movimiento reducido). Desde `sm` lleva a la izquierda su estado en palabras, 13 px («Encendido» en `ink-900`, «Apagado» en `ink-500`, o el par que diga ese ajuste: «Automático / A mano», «Sí / No»); en el teléfono basta la posición, y el lector oye el estado del `role="switch"`. Va en una fila (`ToggleRow`): título de 14 px en peso 600 y su explicación en 13 px `ink-500` a la izquierda (ligada al interruptor con `aria-describedby`), el interruptor a la derecha, y debajo los avisos que lo acompañan. Detrás viaja un oculto con «false» para que apagar también se guarde. Reemplaza al selector «Habilitado / Deshabilitado».

### Página de ajustes
La configuración de Stripe en este mundo. Título de 28 px «Ajustes» con la tienda y el dominio debajo, y «Volver al panel» como botón secundario a la derecha. Desde `xl` (1280 px), un índice pegajoso de 13 rem a la izquierda: los grupos en 12 px peso 600 `ink-500` y sus secciones como ítems de 28 px en 13 px `ink-600`; el que se está leyendo (la sección que cruza la franja del 15 al 35 % de la ventana) va en `brand-50` con texto `brand-700` en peso 600, y el índice tiene su propio desplazamiento en ventanas bajas. Por debajo de `xl`, un selector «Ir a» pegajoso arriba, sobre el lienzo con hairline inferior, que sigue la misma sección. Cada grupo es un título de 20 px peso 600 con hairline debajo; cada sección, un título de 16 px peso 600 con su chapa de estado («Conectada», «Activo», «Sin token», «Apagado»), su explicación en 14 px `ink-500` a 68 caracteres como mucho y, a la derecha, las acciones que no guardan nada (Probar conexión, Sincronizar) como botones secundarios pequeños. Debajo, tarjetas: filas con hairlines, campos en rejilla de dos o tres columnas, credenciales con chapa «Configurado» o «Sin configurar» y el campo vacío («Déjalo en blanco para conservarlo»), URLs en una línea monoespaciada sobre `wash` con «Copiar», y un pie con hairline donde vive el «Guardar» principal de esa tarjeta y, a su izquierda, «Cambios sin guardar», «Guardado» en `ok-fg` o el error en `crit-fg`; con error, lo escrito se queda en la tarjeta. Ninguna otra acción de la tarjeta es botón de envío, para que Enter siempre guarde. Las acciones de un clic (Sincronizar ahora, Re-registrar webhooks) son filas con título, ayuda y botón secundario. Las listas (plantillas, cuentas, escalera, excepciones) son filas con hairlines y su alta va en la misma tarjeta, separada por otra hairline; vacías, dicen qué significa estar vacías.

### Master de Pedidos (tablero)
La lista de Stripe aplicada al centro de la operación. Título de 28 px con su contexto debajo; a la derecha, desde 1400 px, la búsqueda (320 px, icono de lupa, borrar con «x», el aviso de mínimo de caracteres debajo y «/» como atajo desde cualquier parte del tablero) y las estaciones (Almacén, Entregas a couriers) como botones secundarios con icono; más angosto, bajan bajo el título. Debajo, la línea de agencia: «Envíos por agencia» con las cifras que se leen (pendientes de envío, en tránsito) y, al borde, tres píldoras de excepción que filtran (Disponibles para recojo, Próximos a vencer, Retorno iniciado). Las macroetapas son siete tarjetas de estado (Todos y las seis del MOM, con su cuadro de tono) en 2, 4 o 7 columnas; la elegida lleva el borde azul. Bajo ellas, «Subetapa» y, en Por confirmar, «Fecha pactada» como chips de elección con su cifra. Los filtros son píldoras con una hoja anclada de casillas (con buscador si pasan de ocho opciones y la cifra de cada una en Gestión), encabezadas por «Todas las tiendas», «Todos los couriers»… sobre una hairline: marcada mientras no hay filtro, que es cuando el Master enseña todo; marcarla quita el filtro y elegir una opción la desmarca; «Más filtros» abre un marco blanco con los rangos de fecha, la modalidad, las señales y, en Por confirmar, el ciclo de recontacto, y cuenta en su píldora los que están puestos. Bajo 640 px las píldoras esperan detrás de una sola, «Filtros», con el número de las puestas; tocarla las despliega en su sitio. La tarjeta de trabajo lleva el total («2.976 pedidos · se muestran 100 · los más recientes primero»), «Descargar Excel» con icono y el paginador arriba y abajo.
- **Tabla compacta:** desde 1280 px, tabla fija sin desplazamiento horizontal y celdas de dos renglones (14 px en `ink-900` arriba, 13 px en `ink-500` abajo): Pedido (botón que abre la ficha; creación y tienda), Cliente (teléfono), Destino (distrito; chapa de cobertura con provincia y región), Courier (intentos y, si son más de uno, couriers en `warn-fg`), Etapa (chapa de macroetapa con su antigüedad; subetapa), en Por confirmar Gestión y Próximo contacto (el ciclo automático y la primera llamada dicen que lo son), y Movimiento. Cabecera pegajosa en blanco con hairlines arriba y abajo. Fila en reposo blanca con hover `wash`, marcada en `brand-50` al 60 %, la de la ficha abierta en `brand-100` al 70 % con el pedido en `brand-700` y el texto de apoyo subido a `ink-600` (en `ink-500` quedaba en 4,2:1). Mientras llega otra página la tabla baja al 60 % de opacidad.
- **Por debajo de 1280 px** (excepción al corte de 640 px: la tabla no cabe al lado de la barra lateral), cada fila es una ficha corta en rejilla: casilla, pedido y movimiento arriba, y debajo cliente, destino, etapa y courier en un renglón cada uno con sus partes separadas por «·»; la casilla de la página va sobre la lista.
- **Barra de acciones en lote:** flotante y pegajosa al pie, blanca con sombra de popover y anillo `line` (la selección sobrevive a páginas y búsquedas, así que la barra no puede vivir en una tabla concreta): cuántos hay, «Descargar rótulos (PDF)» como principal, el resto secundarios y «Ver selección» y «Limpiar» fantasmas. Los formularios de «Forzar courier…» y «Registrar estado…» se abren debajo, separados por una hairline; el aviso de congelar va en `Banner` de atención y en su propia fila.

### Repro Provincia (tablero)
La misma lista de Stripe que el Master, para la cola de reprogramación de provincia (`/dashboard/envios`). Título de 28 px «Repro Provincia» con su contexto debajo; debajo, en una fila, la búsqueda (256 px, global sobre las seis vistas, «/» la enfoca y Escape la borra) y las cuatro acciones: «Importar reporte» como principal, «Guía Swayp directa», «Stock Swayp» y «Automático Aliclik → Swayp» (la flecha dibujada) como secundarios con icono; al lado del título no caben. En el teléfono la búsqueda va a todo el ancho y las acciones en una rejilla de 2 × 2 («Automático» a secas). Debajo, el resumen plegable: una tarjeta cuya línea («Resumen» y lo que trae, con chevrón) abre tres paneles sobre hairlines —«Reprogramados en Kapta» en cinco cifras de 20 px (los varados en `warn-fg`) con «Ver detalle», «Hoy por asesora» y «Agentes de voz» como tablas de cifras a la derecha con hairlines de borde a borde y su leyenda a la vista, y los rangos como chips de elección—. Las seis vistas son tarjetas de estado en 2, 3 o 6 columnas; la elegida lleva el borde azul. Bajo ellas, en Pendiente, «Ruta» como chips con su cifra (Todas, Aliclik disponible, Swayp requerido): la primera pregunta de la cola; en En ruta y Entregado, «Reprogramado por». Los filtros son las píldoras del Master: Tienda, Cobertura (abre en «Todo menos Lima» y lo dice así), Departamento, Distrito, Programación (hoja con Hoy, Mañana y el día), Swayp (una opción, que cierra al elegir) y los interruptores Sin contactar hoy, Nunca contactadas, Por recuperar (su regla se lee al encenderlo) y Sin pedido vinculado, con `aria-pressed`; «Limpiar filtros» fantasma cuando algo se aparta de como abre la vista, y también en la lista vacía. Bajo 768 px esperan detrás de «Filtros», que cuenta las píldoras puestas, también las que la vista trae encendidas. La tarjeta de trabajo lleva el tamaño de la cola en una región viva, los atajos j / k / Enter / n en teclas y, en En ruta, «Descargar Excel Swayp».
- **Tabla compacta:** desde 1280 px, tabla fija sin desplazamiento horizontal y celdas de dos renglones: Guía (código monoespaciado que abre; chapa neutra Swayp o Directa, pedido y tienda), Cliente (celular), Destino (el distrito; debajo, la ciudad o el departamento si no lo repiten —cede primero si no cabe— y la disponibilidad Swayp en `ok-fg`, `warn-fg` o `crit-fg`), Motivo anterior (dos líneas; en `crit-fg` si vio el producto), Estado (chapa por categoría: pendiente `warn`, en ruta `info`, entregada `ok`, cerrada y transferida neutras; debajo, entera, la segunda mitad del MOM), Ruta en Pendiente y en la búsqueda (chapa `ok` «Aliclik disponible» o `warn` «Swayp requerido» y el porqué en un renglón), Gestión (fecha; «hace N d», en `warn-fg` desde 7, o «Tomada» en `warn-fg`) y Programación (fecha; la fecha Aliclik debajo). Los encabezados ordenan con una flecha dibujada; donde la celda trae dos datos ordenables, el segundo va debajo como en la celda («Guía» sobre «Pedido», «Programación» sobre «Aliclik»). Fila con hover `wash`, la del cursor de teclado en `brand-50`, la recién actualizada en `ok-wash` con «Actualizado». La fila con una llamada del agente de voz en curso va primera, en `info-wash`, con su chapa bajo la guía («Llamando · Agente» en el par `ok` con el punto que late, quieto con movimiento reducido; «Marcando» en `info`) y el tiempo corriendo; sobre la cola, en Pendiente, la línea «Agente de voz» en `wash` siempre dice algo: a quién llama (y, si los filtros esconden ese pedido, «Buscarlo» en `brand-700`) o «Sin llamada en curso» con su punto `ink-300`, la última llamada con su resultado y hace cuánto, y la próxima pasada («Automático apagado» si no hay), en tramos que no se parten y sin «·». Los anchos salen del texto real (la chapa «Aliclik disponible», «Reproprovincia», «Sin gestión», el encabezado «Programación»); cede el cliente, que se recorta con su nombre en el `title`. Ningún renglón empieza por «·».
- **Por debajo de 1280 px** la cola es una lista: a la izquierda la guía con su pedido y tienda, la clienta y el destino; a la derecha (desde 640 px; debajo en el teléfono) el estado entero en su chapa, el motivo, la ruta con su porqué en un renglón y programación · última gestión; «Llamar» con `tel:` arriba a la derecha.
- **Detalle de reprogramaciones:** diálogo blanco de 576 px con sombra de popover y cabecera fija; rangos en chips, cifras en una caja con hairlines, las ocho semanas en barras (`line-strong` y lo entregado en `ok-fg`) con su tabla plegada, y los cortes por tienda y por asesora en filas. Las cifras van en es-PE en todo el tablero.

### Cajón de la guía (Repro Provincia)
La ficha del pedido a la medida de una llamada: hoja de 640 px a la derecha, velo `ink-900` al 20 % para que la fila siga leyéndose detrás, sombra de popover, foco dentro al abrir (la hoja no dibuja anillo: no es un control) y, por dentro, el lienzo `slate-50` con las secciones en tarjetas de sección separadas 16 px (24 px desde `sm`). Cabecera fija y blanca con hairline inferior: la guía en monoespaciada de 18 px peso 600, la chapa del courier y la del estado con su segunda mitad del MOM y «desde» la fecha en 13 px `ink-500`; debajo, cliente · teléfono con «Copiar»; a la derecha «Llamar» (`tel:`), WhatsApp (solo icono), «Siguiente» con flecha (atajo `n`) y el cierre. En el teléfono la cabecera es una rejilla: el cierre arriba a la derecha y las tres acciones en su propia fila, «Llamar» con su etiqueta. Bajo ellas, la reserva en una línea con su punto (`ok-fg` tuya, `warn-fg` de otra persona, `ink-300` que late en solo lectura, quieto con movimiento reducido) y, si se sale con texto sin registrar, un aviso `warn` con «Seguir aquí» y «Descartar» en `danger`. Los avisos de las acciones viven en un pie fijo blanco con hairline: error en `crit-wash`, hecho en `ok-wash`, con su icono, y reciben el foco.
- **Cliente y destino:** la primera tarjeta, la que se lee mientras suena el teléfono: cómo terminó el intento anterior (en `crit-fg` si vio el producto, con la advertencia del MOM), distrito y departamento, la ciudad Swayp solo si no repite el distrito, el producto declarado y el marco de cifras de cuatro celdas sobre `wash` (Intentos Aliclik, Fecha Aliclik, Llamadas, Swayp en su tono). La novedad Swayp es un aviso `crit` con «Resolver novedad» como principal.
- **La acción del momento:** la única tarjeta con anillo azul de 2 px (la llamada en Pendiente, el resultado del courier en En ruta, la llamada de recuperación en una anulada). Lo que se decide son tarjetas-opción (`OptionTile`): título de 14 px peso 600 y debajo, en 13 px `ink-600`, lo que va a pasar («Suma un intento: van 2 de 7», «La guía quedará Anulada y saldrá de la gestión activa»); elegida en `brand-50` con anillo azul de 2 px; en `crit-fg` lo que cierra la venta, que se registra con un segundo clic en `danger` que nombra la guía y el pedido. El resultado del courier son las cinco salidas del reporte en dos columnas. La ruta (Aliclik o Swayp) es otra zona con sus tarjetas-opción y la excepción manual como casilla sobre `wash`; las notas de la operación van en `wash` y los bloqueos en texto visible junto al botón, en `warn-fg`, nombrados con `aria-describedby`. Al anular no se pide fecha.
- **Reenvío de una anulada:** su tarjeta con la chapa `info` «Reproprovincia» (o `warn` «Excepción auditada»); si Swayp no puede emitir la guía (sin stock, sin cobertura o sin vínculo de codbar), el aviso se lee en la tarjeta antes de tocar nada y «Reenviar» se apaga.
- **Destino, pedido e historial:** destino con «Modificar destino» fantasma a la derecha y las coordenadas en monoespaciada; pedido con su número en el título, el selector para vincularlo y los productos en filas con miniatura de 44 px y el importe tabular; «Historial desde el origen» con una zona por guía (original, reprogramación N; chapa `brand` «Vista actual»; «Transferida a una nueva guía Swayp» entre una y otra) y las gestiones en filas con fecha tabular a la derecha y «Editar» fantasma.
- **Modales:** «Resolver novedad de Swayp» (512 px, centrado) y «Guía Swayp directa» (576 px, anclado arriba porque sus resultados crecen hacia abajo) son diálogos blancos de 8 px con sombra de popover, velo `ink-900` al 30 %, cabecera con título de 18 px y cierre de trazo, foco al abrir y Escape que cierra solo el modal. La novedad elige su acción en tarjetas-opción; «Devolver al remitente», que no se deshace, va en `crit-fg` y pide un segundo clic. La guía directa busca el pedido, muestra sus cifras en un marco sobre `wash`, los productos con su vínculo Swayp (sin vínculo con icono en `crit-fg`) y los bloqueos en avisos. El selector de pedido es una búsqueda con lupa y una lista de filas con hairlines; el mismo teléfono en chapa `ok`, otro en `warn`, y la mejor coincidencia en un aviso `ok` con «Confirmar vínculo».

### Ficha del pedido
La página de detalle de Stripe en una hoja lateral (880 px). Velo `ink-900` al 20 % para que la fila resaltada del Master se siga leyendo detrás; hoja con sombra de popover que recibe el foco al abrir y lo devuelve al cerrar, y por dentro el lienzo `slate-50` con las secciones en tarjetas de sección. Cabecera fija y blanca con hairline inferior: el pedido en 18 px peso 600, el enlace a Shopify como icono, la chapa del estado comercial (con candado si está fijado a mano), el monto en peso 600 y la chapa de cobertura; debajo, en 13 px `ink-500`, tienda · creado el · cliente · teléfono con «Copiar» (en el teléfono, el cliente entero en su propia línea y debajo tienda · teléfono, sin la fecha, que está en Información; en escritorio, si no cabe, se recorta el cliente y nunca el teléfono); a la derecha «Llamar», «WhatsApp» y «Master de Pedidos» como secundarios pequeños (solo icono en el teléfono) y el cierre. Los avisos de las acciones (error en `crit`, hecho en `ok`) viven dentro de la cabecera fija con su «x». Pestañas subrayadas Operar / Información / Actividad (48 px, flechas, Inicio y Fin; la de Actividad con su cifra en chapa).
- **Índice de la pestaña:** bajo las pestañas, en la cabecera fija y sobre su hairline, una fila con las secciones de la pestaña abierta en el orden en que se ven (no el del DOM: el cobro sube o baja con `order-*`), botones de 28 px (44 px con puntero táctil) en 13 px peso 500 `ink-600`; la que se está leyendo —la última cuya tarjeta pasó bajo la cabecera, y la última al llegar al fondo— va en `brand-50` con texto `brand-700` y `aria-current="location"`. Un toque la lleva bajo la cabecera (la hoja mide su cabecera en `--ficha-head`, que también usan los saltos de la próxima acción) y le pasa el foco. En el teléfono se desplaza de lado, mantiene la actual a la vista y se desvanece por la derecha mientras quede índice. Con una sola sección no se dibuja.
- **Operar:** «Situación» con la chapa de macroetapa, la subetapa y los motivos en chapas de atención en su cabecera y la antigüedad como ayuda; debajo, el recorrido de seis pasos (hechos en disco `ink-900` con visto, el actual con el par de su macroetapa y anillo de 2 px de su tono, los siguientes en blanco). La próxima acción es la única tarjeta de sección con anillo azul de 2 px —excepción consciente al azul reservado: el usuario la eligió así en la maqueta de las secciones en tarjetas— y pasa a `warn-wash` con anillo `warn-bg` si algo la frena: título de 16 px con su chapa de contexto, explicación y un único botón principal con chevrón; el motorizado de Grupo GF, si lo hay, va en una zona de esa misma tarjeta. Debajo, cada mesa es una tarjeta de sección: gestión de confirmación (días como chapas, avisos de fecha pactada o ciclo, «Antes de llamar» como zona con el historial del cliente en filas de borde a borde, el intento en otra zona con su botón y el agente de voz en otra), mesa de ruta (una tarjeta-opción por modalidad; la sugerida con anillo azul de 2 px y botón principal, las de aviso en `warn-wash`, las bloqueadas en `wash`; las que casi no se usan —Axel y Urpi— plegadas al pie en «Otros couriers», una franja de borde a borde sobre hairline con chevrón que se abre sola si alguna tiene una salida viva; la de Aliclik, mientras se puede tomar y antes de la primera guía, lleva la entrega estimada —ver «Entrega estimada de Aliclik»—), cobro, salidas y guías (filas de borde a borde: courier, códigos en monoespaciada, chapa de estado y los papeles como enlaces con flecha; la credencial de Shalom en su zona), mesa de cierre (las acciones como tarjetas-opción con el lenguaje de la selección; las que no se deshacen, en `crit-fg`; el formulario en su zona) y gestión manual (registrar estado y comentario en zonas, y «Devoluciones y correcciones avanzadas» plegado en la última franja, de borde a borde).
- **Cobro:** título y chapa de estado del cobro (`warn` si falta el adelanto, `info` mientras hay algo por validar, `ok` pagado, `crit` posible duplicado, neutra si es opcional y no hay pago); el resumen es el marco de cifras (Validado de total, Cargado y Saldo por cargar sobre `wash`, en filas de etiqueta y monto bajo 448 px de tarjeta, y cada monto sin partirse) con la barra de lo validado en `ok-fg` sobre `line-strong` y la línea del adelanto mínimo. Los comprobantes son filas con su chapa de revisión, la cuenta receptora en `ok-fg`, `warn-fg` o `crit-fg` con icono, «Validar» como principal pequeño, el mensaje que se enviará como desplegable con chevrón y la miniatura a la derecha («Ampliar»). «Registrar un pago» es una zona con tres pasos en vertical: disco de 24 px con su número (o `ink-900` con visto al estar hecho, como el recorrido), título de 14 px con su estado en chapa («Opcional», «Guardado», «Ya en la guía», «Imagen cargada», «Leído», el saldo por cargar) y una línea que baja al siguiente paso. La cuenta receptora leída son dos columnas sobre `wash` separadas por una hairline, con el estado en el disco y en el color del texto. Con la imagen elegida y una tarjeta de 672 px o más (`@container`, no la ventana), el comprobante queda en una columna de 240 px a la derecha, fijo bajo la cabecera mientras se baja por los campos; si no cabe, va dentro del paso 2. Un solo principal a la vez: «Leer y rellenar» hasta leer, después «Registrar». Pagado en el checkout, la tarjeta dice «Cobro» con la chapa `ok` «Pagado por web». El texto secundario sobre `wash` o un lavado de tono va en `ink-600`.
- **Aliclik:** «Crear guía en Aliclik» con la salud de su API como chapa en la cabecera (`ok` operativo, `warn` si crear falla, `crit` si cotizar falla, neutra sin monitoreo; con `warn` o `crit` su explicación se lee además en un aviso). Lo que para la escritura va en avisos antes de los pasos: el riesgo de pago (`warn`, con la justificación de la excepción) y la retención por posible duplicado (`crit`, que pasa a `ok` resuelta; el otro pedido como enlace con su guía en monoespaciada y la resolución en tarjetas-opción con la consecuencia del §8.3). Detrás de ellos, y solo con entrega baja, el aviso `warn` de la entrega estimada («Pedido de 5 días · Aliclik entrega ~27 %», el dato en «de cada 10», qué hacer y de qué guías sale): informa, no para la escritura. Después, tres pasos: «Ubicación y cotización» (el campo de la coordenada con su ejemplo en la ayuda; «Cotizar envío» es el principal hasta que hay cotización y luego secundario; el pin que el pedido no respalda es el único bloqueo dentro de un paso, porque es la respuesta de la cotización), «Revisa antes de crear» (el pedido en monoespaciada y lo que se cobra en la puerta en un marco de cifras sobre `wash`, con la nota del redondeo al pie; recojo, dónde ubica Aliclik el pin, lo que teníamos y el almacén en filas con hairlines, en `warn-fg` el domingo y el pin que no coincide, que además llevan su aviso; los avisos de la cotización en líneas `warn-fg` con su icono) y «Transportadora y creación» (una tarjeta-opción por transportadora con el precio a la derecha, la más barata elegida con su chapa, la nota para el courier y, al pie, «Crear guía en Aliclik» con el motivo por el que está apagado en `warn-fg` a su lado, o lo irreversible en `ink-500`; mientras crea, un aviso `info` pide no cerrar). «Vincular una guía ya creada en Aliclik» es una franja plegada al pie de la tarjeta, de borde a borde, con chevrón. Los botones dentro de un aviso son secundarios: el azul de la tarjeta es cotizar o crear. Las rejillas miran el ancho del panel (`@container`), porque en Leads vive en media columna. El bloque de Agencia lleva «Revisar ubicación y cobertura» fantasma a la derecha de su cabecera y «Comprobar si Aliclik llega» como secundario; si llega, un aviso `ok` con «Marcar … como Provincia COD».
- **Entrega estimada de Aliclik** (`components/aliclik-outlook.tsx`, 09-10-2026): un recuadro sin anillo dentro de la tarjeta de Aliclik (`wash`, o blanco si la tarjeta está en `warn-wash`), como el de la salida que bloquea. Arriba «Entrega estimada» (12 px peso 600) con la chapa del nivel —«Baja» en `warn`, «Muy baja» en `crit`; sin chapa si es normal—, los días del pedido debajo y, a la derecha, la cifra en 20 px peso 600 tabular en el tono del nivel (`ink-900`, `warn-fg`, `crit-fg`). Debajo, la escalera: cuatro columnas (Hoy, 1 d, 2 d, 3+ d) con una barra de 32 px como máximo, proporcional desde cero, sobre una hairline `line-strong`; la del pedido en el tono de su nivel y las demás en `line-strong`, con el porcentaje y el tramo debajo (el del pedido en peso 600 y `aria-current`). Cierra con qué hacer (13 px `ink-700`: «Que salga hoy: mañana bajaría a 55 %», «Antes de crear la guía, confirma…», «Créala solo si el cliente contesta hoy…») y de qué guías sale (12 px `ink-600`). Es un dato de la tienda, no del pedido: con menos de 30 guías en un tramo usa las de todas las tiendas y lo dice; sin muestra, no se dibuja.
