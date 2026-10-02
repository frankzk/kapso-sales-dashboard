---
name: Kapta
description: Mundo de operación de Kapta. El lenguaje del panel de Stripe con el azul Kapta, para operar pedidos y despacho.
colors:
  brand-600: "#1f5fe0"
  brand-700: "#1b4fbd"
  brand-500: "#2f74ff"
  brand-50: "#eef6ff"
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

**Alcance actual (02-10-2026).** Este mundo es la dirección aprobada para todo el producto, pero hoy está en producción en la cabecera y las pestañas de Grupo GF Courier, en «Despacho del día» (tarjetas de estado, QR, lista, cajas, devoluciones y hojas), donde se estrenó el 29-09-2026, y, desde el mismo día, en Rutas (también en `/dashboard/courier/rutas`) y Tarifario, en los dos paneles laterales que abre Rutas —la caja y «Reparto y liquidación» (cierre, resumen, tabla de paradas y pago del motorizado)— en la estación «Almacén» (`/dashboard/pedidos/almacen`: escáner de armado, «Por empacar» como un marco con una celda por operación cuyo lavado dice si está en cero, cerca del corte o vencida, la cola por armar como listas con hairlines y las detenidas en ámbar con su chapa, y «Armados hoy»), en «Devoluciones de Tanders» (`/dashboard/pedidos/devoluciones`: el mismo escáner, el cuadre en un marco de cifras con «Faltan» en lavado crítico si hay algo que reclamar, y las listas de faltantes y recibidas) y en la mesa «Entregas a couriers» (`/dashboard/pedidos/despacho`: cifras del día, rutas recientes, destino elegido, paquetes sin ruta, «¿Quién recoge?» y «Nueva ruta»). Desde el 30-09-2026 también está en la pantalla del motorizado (`/reparto`, la misma que abre Coordinación para reportar por él): la lista de paradas con «Añadir un punto», la ficha de la parada con su reporte, la hoja de WhatsApp, los campos de evidencia y la cámara dentro de la página. Desde el 02-10-2026 también está en Ajustes de la tienda (`/dashboard/[storeId]/settings`): el índice lateral, los grupos y secciones con su chapa de estado, y las tarjetas que se guardan cada una por su cuenta, y en Tiendas (`/dashboard/stores`): la lista de tiendas con su chapa de estado y las anomalías de ingesta, cuya fila abre su ejemplo. Los tres pasos de la caja (`DispatchBoxPanel`) se ven igual en la mesa y en el panel; en la mesa la sección lleva la sombra de tarjeta porque está sobre el lienzo. Excepción consciente: bajo 1024 px las filas del Tarifario se vuelven tarjetas con el módulo compartido `components/courier-mobile.module.css`, que también usan las vistas anteriores y no se tocó; la tarjeta exterior se quita ahí para no anidar tarjetas. El resto de la aplicación (las partes de `components/routes.tsx` que el panel no muestra —añadir paradas y reintentos—; en `/reparto`, «Recibir mi caja» y el escáner de QR de «Confirmar todos» y «Lo llevo», montado sin `look="ops"`, y su cámara; las vistas anteriores del courier, el Master de Pedidos, Envíos, Liquidaciones y demás) sigue con el aspecto anterior: Tailwind `slate-*`, `brand-600` como acento, radios `rounded-xl`/`rounded-2xl` y `shadow-xl`. Ese aspecto es deriva preexistente, no una segunda norma: las superficies nuevas o rediseñadas usan este documento. No hay esquema oscuro; el producto declara `color-scheme: light`. La única superficie oscura es el visor de la cámara, negro como en la cámara del teléfono.

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
- **Chip de elección:** redondo, 32 px; encendido en `brand-50` con anillo azul de 2 px; en cero, deshabilitado al 40 %.

### Cards / Containers
- **Corner Style:** 8px.
- **Background:** blanco sobre el lienzo `slate-50`.
- **Shadow Strategy:** sombra de control más anillo `line`; nada anidado dentro de otra tarjeta con sombra.
- **Border:** anillo de 1 px en `line`; las secciones internas se separan con hairlines `line`, no con tarjetas.
- **Internal Padding:** 16px; las tarjetas de estado usan 10px × 14px.

### Inputs / Fields
- **Style:** 36 px (40 px para el selector de motorizado), blanco, anillo interior `line-strong`, sombra de control, 6px, texto 14 px en `ink-900`, marcador en `ink-500`. En el escáner compacto el campo sube a 48 px en el teléfono con texto de 16 px.
- **Focus:** el anillo pasa a 2 px en `brand-500`, sin contorno exterior.
- **Error / Disabled:** deshabilitado sobre `wash` con texto `ink-500`; los errores se dicen en un aviso `crit`, no pintando el campo.
- **Casilla:** nativa, 16 px, `accent-color` en `brand-600`.

### Navigation
- **Pestañas subrayadas:** texto en peso 600 (13 px en el teléfono, 14 px desde `lg`), `ink-500` en reposo y `ink-900` al pasar; la activa en `brand-700` con barra de 2 px en `brand-600` sobre la hairline `line` del contenedor; objetivo mínimo de 48 px. El contador va como chapa (`brand` en la activa, `neutral` en las demás); en el teléfono solo la activa muestra su número, como texto.
- **Más vistas:** las vistas anteriores viven en un menú «Más vistas» (icono de tres puntos, 48 px) al final de las pestañas, con sombra de popover.

### Control segmentado
La forma de asignar (QR, lista, cajas) es una pista `wash` de 8px con 2px de relleno; la opción activa es una pieza blanca de 6px con sombra de control y anillo `line`, su icono en `brand-600`. En el teléfono cada opción muestra su etiqueta corta.

### Hojas y popovers
Hoja `look="ops"`: blanca, 8px, sombra de popover, 16px de relleno, título de 14 px en peso 600 y un botón de cierre de 28 px con icono de trazo. En escritorio se ancla bajo su botón (360 px de ancho, acotada a la pantalla); bajo 640 px es una hoja inferior. Escape y un clic fuera la cierran.

### Panel lateral (SidePanel)
Velo `ink-900` al 30 % sin desenfoque; hoja blanca a la derecha con la sombra de popover y el ancho que pide quien la abre (760 px la caja, 960 px el reparto). Cabecera pegajosa con hairline inferior: nombre en 18 px peso 600, la chapa de situación a su lado y el contexto (día, carga) en 13 px `ink-500` debajo; cierre de 32 px con icono de trazo. Cuerpo con 16 px de margen en el teléfono y 24 px desde `sm`. Dentro, las secciones se separan con hairlines o marcos `line` sin sombra; el resumen de cifras es un solo marco con hairlines entre celdas, y el saldo va sobre `wash`. La carga es un esqueleto en `wash`.

### Interruptor (Switch)
Lo que se enciende y se apaga en un ajuste: una pista redonda de 36 × 20 px. Apagado, la pista es blanca con un anillo de 1 px en `ink-500` y el botón de 14 px es `ink-500` (4,8:1 sobre blanco: una pista gris clara se queda en 1,4:1 y no cumple el contraste de componentes); encendido, la pista y su anillo pasan a `brand-600`, el botón se vuelve blanco con sombra de control y se corre 16 px en 150 ms (sin movimiento con movimiento reducido). Desde `sm` lleva a la izquierda su estado en palabras, 13 px («Encendido» en `ink-900`, «Apagado» en `ink-500`, o el par que diga ese ajuste: «Automático / A mano», «Sí / No»); en el teléfono basta la posición, y el lector oye el estado del `role="switch"`. Va en una fila (`ToggleRow`): título de 14 px en peso 600 y su explicación en 13 px `ink-500` a la izquierda (ligada al interruptor con `aria-describedby`), el interruptor a la derecha, y debajo los avisos que lo acompañan. Detrás viaja un oculto con «false» para que apagar también se guarde. Reemplaza al selector «Habilitado / Deshabilitado».

### Página de ajustes
La configuración de Stripe en este mundo. Título de 28 px «Ajustes» con la tienda y el dominio debajo, y «Volver al panel» como botón secundario a la derecha. Desde `xl` (1280 px), un índice pegajoso de 13 rem a la izquierda: los grupos en 12 px peso 600 `ink-500` y sus secciones como ítems de 28 px en 13 px `ink-600`; el que se está leyendo (la sección que cruza la franja del 15 al 35 % de la ventana) va en `brand-50` con texto `brand-700` en peso 600, y el índice tiene su propio desplazamiento en ventanas bajas. Por debajo de `xl`, un selector «Ir a» pegajoso arriba, sobre el lienzo con hairline inferior, que sigue la misma sección. Cada grupo es un título de 20 px peso 600 con hairline debajo; cada sección, un título de 16 px peso 600 con su chapa de estado («Conectada», «Activo», «Sin token», «Apagado»), su explicación en 14 px `ink-500` a 68 caracteres como mucho y, a la derecha, las acciones que no guardan nada (Probar conexión, Sincronizar) como botones secundarios pequeños. Debajo, tarjetas: filas con hairlines, campos en rejilla de dos o tres columnas, credenciales con chapa «Configurado» o «Sin configurar» y el campo vacío («Déjalo en blanco para conservarlo»), URLs en una línea monoespaciada sobre `wash` con «Copiar», y un pie con hairline donde vive el «Guardar» principal de esa tarjeta y, a su izquierda, «Cambios sin guardar», «Guardado» en `ok-fg` o el error en `crit-fg`; con error, lo escrito se queda en la tarjeta. Ninguna otra acción de la tarjeta es botón de envío, para que Enter siempre guarde. Las acciones de un clic (Sincronizar ahora, Re-registrar webhooks) son filas con título, ayuda y botón secundario. Las listas (plantillas, cuentas, escalera, excepciones) son filas con hairlines y su alta va en la misma tarjeta, separada por otra hairline; vacías, dicen qué significa estar vacías.

### Avisos (Banner)
Fondo en el lavado del tono, icono de 16 px y título en `*-fg`, cuerpo en `ink-700`, 8px de radio, 12px × 16px de relleno.

### Iconos
Una sola familia de trazo: rejilla de 24, trazo de 1,8, extremos y uniones redondeados, `currentColor`. 16 px dentro de botones y controles, 14 px en píldoras, 20 px por defecto. En `/reparto` suben un paso: 20 px en botones y 24 px en los gestos de la ficha, su flecha de volver y la cámara; los enlaces de texto siguen en 16 px. Las marcas ajenas se dibujan con el mismo trazo (WhatsApp es un globo con auricular), nunca con su logo.

### Pantalla del motorizado
La mesa a escala de calle: las mismas piezas, más grandes y pocas.
- **Lista:** tarjetas de parada con el número de orden en un disco de 28 px (`ink-900` por entregar, `line` ya reportada) y el monto tabular a la derecha; la próxima lleva la chapa «Siguiente».
- **Gestos de la parada:** Ir · WhatsApp · Llamar, como fila de 48 px con hairlines bajo cada tarjeta por entregar y como tres botones secundarios de 56 px (icono de 24 px sobre la etiqueta) en la ficha. Sin número o sin dirección, el gesto se apaga y su etiqueta dice por qué («Sin celular»).
- **«Guardar»:** barra pegajosa al pie con hairline superior; el botón principal ocupa todo el ancho (52 px) y dice qué guarda («Guardar entrega», «Guardar no entrega», «Corregir»). Encima, lo que falta en `ink-600` y «Completar» en `brand-700`, que lleva al campo y le da el foco. «Guardar» no se apaga por lo que falta: solo mientras guarda o sin saldo legible.
- **Evidencia:** un marco blanco de 8 px con anillo `line` y sombra de control: cuadro de 56 px (icono en `wash`, la miniatura subida o la foto guardada en `ok-wash`), etiqueta, estado («Obligatoria», «Subiendo…», «Lista» en `ok-fg`) y «Cámara» y «Galería» como botones secundarios de 48 px. Mientras sube, una barra de 4 px recorre su pista `line`; un fallo es un aviso `crit` con título y «Reintentar la subida».
- **Cámara:** dentro de la página, a pantalla completa y en negro (`#000`), con título y controles en blanco: cierre de 48 px, «Galería» y «Linterna» como icono sobre etiqueta y un disparador redondo de 72 px. Es la única superficie oscura del mundo; si la cámara no abre, lo dice una tarjeta blanca con sombra de popover y título en `crit-fg`.
- **Hoja de WhatsApp:** la hoja inferior a escala de calle: velo `ink-900` al 30 %, blanca con 8 px arriba y sombra de popover (centrada desde `lg`) y cierre de 48 px; cada mensaje es una tarjeta secundaria con icono, nombre y el texto que se abrirá en WhatsApp.

## Do's and Don'ts

### Do:
- **Do** reservar `brand-600` para la acción principal, la selección, la pestaña activa y el foco; los enlaces van en `brand-700`.
- **Do** escribir cada estado con palabras dentro de una chapa de par de tono (`ok`, `info`, `warn`, `crit`, `neutral`, `urgent`).
- **Do** usar solo los radios 4, 6, 8 px y redondo completo, y solo las sombras de control, principal y popover.
- **Do** poner todas las cantidades, montos y fechas en cifras tabulares con formato `es-PE`.
- **Do** convertir las filas de tabla en tarjetas de lista bajo 640 px, sin desplazamiento horizontal en el teléfono.
- **Do** dejar que el puntero táctil suba los controles a 44 px y mantener 48 px en pestañas y escáner; en `/reparto`, 48 px como mínimo y 56 px en los gestos de la ficha.
- **Do** construir superficies nuevas con `OpsButton`, `Badge`, `FilterPill`, `StatusCard`, `AttentionPill`, `Banner`, `FIELD`, `CHECKBOX` y `Sheet look="ops"`; las de configuración, con las piezas de `components/settings-ui.tsx` (`SettingsIndex`, `SettingsGroup`, `SettingsSection`, `Field`, `ToggleRow`, `HourRange`, `CodeLine`).
- **Do** usar un interruptor para lo que se enciende y se apaga, nunca un selector «Habilitado / Deshabilitado».

### Don't:
- **Don't** usar `slate-*` (fuera del lienzo `slate-50`), `rounded-xl`, `rounded-2xl` ni `shadow-xl` en superficies del mundo de operación; son del aspecto anterior.
- **Don't** poner antetítulos, eyebrows ni kickers sobre el título de la página.
- **Don't** apilar mosaicos de color, chips y franjas del mismo peso por encima de la tarea; las excepciones esperan en píldoras al borde.
- **Don't** usar el color como única señal de estado, ni un rojo sólido para acciones destructivas.
- **Don't** anidar tarjetas con sombra dentro de tarjetas; separa secciones con hairlines `line`.
- **Don't** añadir movimiento decorativo, degradados ni tema oscuro parcial (el visor negro de la cámara es la única excepción); el movimiento es de estado (150 ms) o dice que algo carga o entra, y lo que se desplaza se apaga con movimiento reducido.
- **Don't** mezclar otra familia de iconos ni glifos de texto en lugar de iconos de trazo.
