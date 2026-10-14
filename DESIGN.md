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

**Alcance actual (03-10-2026).** Este mundo es la dirección aprobada para todo el producto, pero hoy está en producción en la cabecera y las pestañas de Grupo GF Courier, en «Despacho del día» (tarjetas de estado, QR, lista, cajas, devoluciones y hojas), donde se estrenó el 29-09-2026, y, desde el mismo día, en Rutas (también en `/dashboard/courier/rutas`) y Tarifario, en los dos paneles laterales que abre Rutas —la caja y «Reparto y liquidación» (cierre, resumen, tabla de paradas y pago del motorizado)— en la estación «Almacén» (`/dashboard/pedidos/almacen`: escáner de armado, «Por empacar» como un marco con una celda por operación cuyo lavado dice si está en cero, cerca del corte o vencida, la cola por armar como listas con hairlines y las detenidas en ámbar con su chapa, y «Armados hoy», y desde el 13-10-2026, debajo de la estación, «Reintentos por salir»: una tarjeta aparte con «Hoy» y «Mañana» en dos zonas (mientras llega la lista, las dos zonas con su título y el esqueleto en `wash`), la cifra en la chapa del título y enlazada desde la cabecera, listas con hairlines por apartado, la acción de la caja en chapa con su tono y la bandeja), en «Devoluciones» (`/dashboard/pedidos/devoluciones`, Tanders y Shalom desde el 03-10-2026: el mismo escáner con la guía de retorno de Shalom como campo opcional, y un cuadre por courier en un marco de cifras —«Faltan» de Tanders en lavado crítico si hay algo que reclamar, «Por recibir» de Shalom en ámbar, porque esa caja hay que ir a buscarla— con las listas de pendientes y recibidas) y en la mesa «Entregas a couriers» (`/dashboard/pedidos/despacho`: cifras del día, rutas recientes, destino elegido, paquetes sin ruta, «¿Quién recoge?» y «Nueva ruta»). Desde el 30-09-2026 también está en la pantalla del motorizado (`/reparto`, la misma que abre Coordinación para reportar por él): la lista de paradas con «Añadir un punto», la ficha de la parada con su reporte, la hoja de WhatsApp, los campos de evidencia y la cámara dentro de la página. Desde el 02-10-2026 también está en Ajustes de la tienda (`/dashboard/[storeId]/settings`): el índice lateral, los grupos y secciones con su chapa de estado, y las tarjetas que se guardan cada una por su cuenta, en Tiendas (`/dashboard/stores`): la lista de tiendas con su chapa de estado y las anomalías de ingesta, cuya fila abre su ejemplo, y en el tablero del Master de Pedidos (`/dashboard/pedidos`): las siete tarjetas de macroetapa, las subetapas y la fecha pactada en chips, los filtros en píldoras, la tabla compacta y la barra de acciones en lote. Desde el 03-10-2026 también la ficha del pedido que abre el Master (y el resto del panel): cabecera fija, pestañas, situación y recorrido, próxima acción, gestión de confirmación, mesas de ruta y de cierre, salidas y guías, gestión manual, ubicación, productos y actividad, con sus secciones en tarjetas sobre el lienzo y el índice de la pestaña bajo las pestañas, y el cobro con la credencial de Shalom; dentro de ella, los modales de guía siguen con el aspecto anterior hasta su propio cambio. Desde el 05-10-2026 también los paneles de Aliclik de la ficha —crear la guía, la retención por posible duplicado (que la gestión de confirmación también muestra) y «Comprobar si Aliclik llega» del bloque de Agencia—; el cajón de Leads enseña el de crear guía igual, en su propia tarjeta. Desde el 05-10-2026 también la cabecera y las pestañas subrayadas de «Cotejar Olva» (`/dashboard/olva`) y su pestaña «Correos de Olva» (`?vista=correos`): tarjetas de estado que filtran, una tarjeta de trabajo con los correos por día sobre bandas `wash`, cada fila con hora, tracking en monoespaciada, destinatario, la chapa del resultado con su frase y el pedido como enlace en `brand-700` (o «Vincular» con su campo de 32 px); es una sola columna en el teléfono, dos (a quién iba / qué pasó) desde `lg` y tabla de cinco columnas desde `xl`. El cuerpo de «Cotejo del portal» sigue con el aspecto anterior hasta su propio cambio. Desde el mismo día también el tablero de Repro Provincia (`/dashboard/envios`): las seis vistas en tarjetas de cifra, la ruta en chips, los filtros en píldoras (compartidas con el Master en `components/facet-pill.tsx`), la tabla compacta y su lista, el resumen plegable y el detalle de reprogramaciones; y, desde el mismo día, el cajón de la guía (`/dashboard/envios?open=<id>`) con sus modales «Resolver novedad de Swayp» y «Guía Swayp directa» y el selector de pedido (`OrderLinkPicker`, que también se ve así en la revisión de importación y en la cola de recuperación de devoluciones). Desde el 10-10-2026 también «Stock Swayp» (`/dashboard/envios/stock`, antes «Stock Fenix por ciudad»): tres vistas en tarjetas de cifra, la ciudad en chips, la búsqueda, una sola tabla (lista en el teléfono), el diálogo de movimientos y, al pie y solo para administradores, la tarjeta «Sincronizar stock desde Swayp». Desde el 12-10-2026 también Productividad (`/dashboard/productividad`, y «Mi productividad» de cada vendedora): el periodo en chips, la tienda y la fuente en píldoras, las cifras del equipo en un marco, la tabla por asesora (lista bajo 1280 px) y el panel de la asesora con sus leads; y, desde el mismo día, la semana de cada asesora contra su meta (la columna «Esta semana» y su zona en el panel) y la pestaña «Horarios» de Equipo (`/dashboard/team?tab=horarios`), donde se fijan la meta y el horario. Desde el 13-10-2026 también Consolidado (`/dashboard`) y el tablero de cada tienda (`/dashboard/[storeId]`), que comparten `ExecutiveDashboard`: la operación del MOM (excepciones e indicadores), LTV : CPA, el periodo de ventas en chips con «Desde / Hasta», el marco de cifras, la rejilla de módulos y los paneles laterales con el gráfico y la tabla de cada módulo, incluida la tabla de anuncios de Meta. Desde el 14-10-2026 también Leads (`/dashboard/leads`): la cabecera, los chips en dos filas con «Más filtros», el siguiente lead de cada vendedora, la cola, la ficha del lead, «Venta por teléfono» y Anuncios (`/dashboard/leads/anuncios`); el «Tablero de hoy», el aviso flotante «No se pudo tomar el lead» (comparte cáscara con el de Yape), la asignación de Yapes y el contenido del panel del agente de voz siguen con el aspecto anterior. Desde el 13-10-2026 también los dos paneles de roles y permisos de Equipo (`components/team-permissions.tsx`): «¿Qué hace cada rol?» y lo que puede hacer cada persona; la tabla de la pestaña «Usuarios y accesos» sigue con el aspecto anterior. Desde el mismo 12-10-2026 también «Repro Lima» (`/dashboard/pedidos/repro-lima`, MOM §9.5): la chapa del corte en la cabecera, cuatro tarjetas de estado que filtran y dicen su número («Por decidir», «Llamar después», «Programados» y «Cerrados») y, desde el 14-10-2026, una quinta, «Todos · por entregar» —a todo el ancho debajo de las cuatro en el teléfono, la quinta columna desde 1024 px—, que abre el resumen de los pedidos de Lima sin estado final por etapa y subetapa del Master, cada subetapa con su cifra, sus chapas de antigüedad y el enlace a su lista del Master («Por reprogramar Lima» abre sus cuatro listas), en dos bloques con líneas finas («Todavía por entregar» y «Ya entregado, anulado o devuelto: falta cerrar») que van uno al lado del otro desde 1024 px, la tienda en píldora y la búsqueda, una tabla desde 1280 px y, por debajo, una lista con líneas finas, sin tarjeta dentro de tarjeta, con las chapas de la caja, la fecha que pidió el cliente, las llamadas y el estado del acuerdo; y la hoja lateral para atender el caso («Antes de llamar», el resultado en cuatro opciones, la fecha y el courier en chips, «Qué hacer con la caja» y el segundo clic de «Desarmar y cerrar»), a lo ancho en el teléfono. Los tres pasos de la caja (`DispatchBoxPanel`) se ven igual en la mesa y en el panel; en la mesa la sección lleva la sombra de tarjeta porque está sobre el lienzo. Excepción consciente: bajo 1024 px las filas del Tarifario se vuelven tarjetas con el módulo compartido `components/courier-mobile.module.css`, que también usan las vistas anteriores y no se tocó; la tarjeta exterior se quita ahí para no anidar tarjetas. El resto de la aplicación (las partes de `components/routes.tsx` que el panel no muestra —añadir paradas y reintentos—; en `/reparto`, «Recibir mi caja» y el escáner de QR de «Confirmar todos» y «Lo llevo», montado sin `look="ops"`, y su cámara; las vistas anteriores del courier, los modales de guía de la ficha del pedido, Liquidaciones y demás) sigue con el aspecto anterior: Tailwind `slate-*`, `brand-600` como acento, radios `rounded-xl`/`rounded-2xl` y `shadow-xl`. Ese aspecto es deriva preexistente, no una segunda norma: las superficies nuevas o rediseñadas usan este documento. No hay esquema oscuro; el producto declara `color-scheme: light`. La única superficie oscura es el visor de la cámara, negro como en la cámara del teléfono.

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

### Datos (excepción consciente, 13-10-2026)
Los gráficos de Consolidado tienen su propia paleta, en `components/palette.ts`, validada con el validador de dataviz en modo claro:
- **Una serie** (ingresos, pedidos o conversión por día; la hora pico; la última etapa del embudo; la barra de una tasa del MOM): el azul de la marca, y el resto de las marcas de un gráfico de bolsillo en `ink-300`. Es una medida, no una acción: «Azul con Oficio» sigue valiendo fuera de los gráficos.
- **Categorías** (fuentes de venta, anuncios): `SERIES`, seis tonos en orden fijo —azul, naranja, aguamarina, ámbar, rosa, violeta— y `SERIES_OTHER` (`ink-300`) para «Otros» y «Sin atribuir». La fuente N lleva siempre el color N (`SOURCE_SERIES`), así se lee igual en la celda, la tabla, la leyenda y el gráfico. Sin verde ni rojo, que son estados; aguamarina, ámbar y rosa quedan bajo 3:1 sobre blanco y por eso van siempre con su etiqueta o su tabla.
- **Un orden** (quién cerró, de más a menos mano humana; el modo de envío): pasos de tinta, para no confundirse con las fuentes en el mismo panel. «Canal de cierre» de todas las ventas (MOM §17.3) usa `CLOSING_GROUP_SHADE`: asesora en `ink-900`, bot o automatización en `#3f4453`, la clienta sola en la web en `#6b7385` y otros en `#a3acba`. El cierre por etiquetas de los pedidos del bot (el panel de «Fuente» y la vista de respaldo) sigue con `CHANNEL_SHADE` (bot → bot asistido → asesora, de `ink-300` a `ink-900`).
- **Estados dentro de un dato** (carritos recuperados, por trabajar y perdidos; órdenes emparejadas, no encontradas y sin id): `ok-fg`, `warn-fg` y `ink-300`, siempre con la palabra en la leyenda.

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

### Stock Swayp
El stock de cada bodega de Swayp frente a lo que piden las guías pendientes de Repro Provincia (`/dashboard/envios/stock`, `components/fenix-stock.tsx`), con la lista de Stripe del tablero. Título de 28 px «Stock Swayp» con su contexto debajo (`text-pretty`) y, para todos, la línea del sync en 13 px: su punto (`ok-fg` si el diario está activo, la última corrida salió bien y no retuvo ciudades; `warn-fg` si no), «Sync diario con Swayp activo · última sincronización hace 3 h, automática, sin cambios» y, si el diario retuvo ciudades, «1 ciudad retenida» —enlace `brand-700` a la tarjeta del pie para el administrador, texto para los demás—; si las corridas no se pudieron leer, lo dice («No se pudo leer el estado del sync. Los números pueden no estar al día.») en vez de pasar por «todavía sin sincronizaciones». Quien no es administrador lee además «Solo un administrador puede editar el stock. Lo ves en modo lectura.» en su propia línea. A la derecha, «Recalcular elegibilidad» secundario (solo administradores) y «Repro Provincia» fantasma con flecha de vuelta.
- **Vistas:** tres tarjetas de estado en tres columnas también en el teléfono: «Por reponer» (abre ahí: lo que tiene guías pendientes y no alcanza), «Sin stock» (en 0 en su bodega, con o sin pedidos; la palabra del MOM) e «Inventario» (todo; no «Todo el inventario», que a 390 px se parte en tres columnas). Bajo ellas, la ciudad en chips de elección con su cifra (Todas y las ciudades de la vista, de más a menos) y, a la derecha, la búsqueda de producto o SKU con lupa: «/» la enfoca desde cualquier parte de la página, Escape la borra.
- **Tarjeta de trabajo:** arriba, la cuenta en una línea («7 productos · faltan 10 unidades para las guías pendientes»; en «Sin stock», cuántos tienen guías pendientes; en «Inventario», las unidades en bodega y cuántos van sin control de cantidad) y «Limpiar filtros» fantasma si hay ciudad o búsqueda. Desde 768 px es una tabla fija con cabecera pegajosa blanca entre hairlines: Ciudad (con la región debajo si no la repite), Producto (dos líneas; el SKU debajo en monoespaciada de 12 px), Pendientes, Stock (negativo en `crit-fg`), Faltante (en `crit-fg` peso 600) en cifras tabulares a la derecha, Estado con su `pl-4` y las acciones de fila. La chapa solo dice lo que pide acción o lo que está bien con pedidos: `warn` «Reponer», `crit` «Sin stock» (en 0 con guías), `ok` «Cubre»; neutra «Sin control» para lo que no lleva cantidad; un producto en 0 sin pedidos no lleva chapa —el 0 ya se lee—. Las acciones son botones de texto de 13 px peso 500 (no fantasmas: repetidos en cada fila no pueden pesar más que el producto): «Movimientos» en `ink-600` con hover `wash`, «Eliminar» en `crit-fg` con hover `crit-wash`, que pide confirmación en la propia fila. En el teléfono, cada fila es una ficha: producto y chapa arriba, ciudad debajo, «5 pendientes · stock 3 · faltan 2» y las acciones al pie.
- **Movimientos:** diálogo blanco de 512 px con sombra de popover, velo `ink-900` al 30 % y foco al abrir: el saldo, el tipo de movimiento en chips de elección (el ajuste se llama «Ajuste (conteo Swayp)»), cantidad y nota, y el historial en filas con fecha tabular.
- **Sincronizar stock desde Swayp:** la tarjeta del pie (`id="sincronizar"`), solo para administradores, con zonas sobre hairlines. «Leer el inventario de Swayp»: el estado del diario en un recuadro `wash` (última corrida, ciudades retenidas en `warn-fg` con su motivo; mientras carga, «Leyendo el estado del sync…»; si no se pudo leer, un aviso `warn` con «Reintentar»), «Leer inventario» principal, que no cambia nada (y que no se apaga por ese fallo si la cabecera dice que el diario está activo), y el respaldo con token plegado. Lo leído son filas por ciudad con casilla, chapas «N bajan» `crit` y «N suben» `ok` (en singular con uno), altas y productos sin vincular; «Aplicar a N ciudades…» pide confirmar en la tarjeta con un aviso `warn` y «Sí, aplicar a …». «Importar el Excel de Swayp»: el campo de archivo del navegador va oculto detrás de una etiqueta con aspecto de botón secundario («Elegir archivo», con el anillo de foco del campo) y el nombre del archivo o «Ningún archivo» al lado. «Anotar a mano» con tienda, ciudad, producto (combobox) y cantidad; y «Bodegas Swayp configuradas» plegado al pie, con cada bodega en filas de datos.

### Productividad
La lista de Stripe aplicada al equipo de venta (`/dashboard/productividad`, `components/productivity.tsx`, `productivity-filters.tsx` y `productivity-table.tsx`). Título de 28 px («Productividad por asesora», o «Mi productividad» para una vendedora) y debajo, en 14 px `ink-500`, qué se mira y con qué se compara («Hoy, domingo 11 de octubre · comparado con el sábado 10 de octubre»; en la vista por mes, «Octubre 2026 · día 11 de 31 · comparado con 1–11 sep»). Debajo, el periodo en chips de elección en dos grupos que bajan enteros —Hoy, Ayer, 7, 30 y 90 días; y, tras una raya `line-strong` que se oculta en el teléfono, Este mes, el anterior y «Otro mes…», un `<select>` con el aspecto del chip (`choiceChipClass`) y su chevrón— y, al borde derecho desde 1280 px, Tienda (si hay más de una) y Fuente como las píldoras de una opción del Master (`ChoicePill`), que cierran al elegir; las fuentes sin emojis (Campaña, Meta/Web, Carrito, Búsqueda, Orgánico). Mientras llega el periodo nuevo, «Actualizando…» junto a las píldoras. Desde 1280 px es una pantalla: cabecera y cifras fijas, la tarjeta de trabajo mide lo que su contenido hasta llenar el alto y entonces se desplaza por dentro con la cabecera de la tabla pegajosa; más angosta, baja la página.
- **Cifras del equipo:** un marco de celdas blancas sobre hairlines `line` (2, 3 o 6 columnas; 5 en «Mi productividad», la última a todo el ancho en el teléfono), cada una con su etiqueta en 13 px `ink-600`, la cifra en el paso Figure (20 px peso 600, tabular) y, a su lado, el cambio contra el periodo anterior en 13 px peso 600 —`ok-fg` con «+», `crit-fg` con «−», `ink-500` si no cambia, «sin base» si no hay con qué comparar—; debajo, en 12 px `ink-500`, la línea del mes (con qué se compara, a qué ritmo va y cómo cerró el anterior) o la de la 1ª gestión, en tramos que no se parten y sin renglones que empiecen por «·». Los leads nuevos sin gestionar son una chapa `warn` junto a la cifra de la 1ª gestión. Excepción consciente a «Las Cifras Navegan»: no filtran nada, así que no son tarjetas de estado sino un marco de cifras, el mismo dato con celdas que la ficha.
- **Tabla por asesora:** desde 1280 px, fija y de diez columnas con celdas de dos renglones; encabezados en el paso Label (12 px peso 600 `ink-600`) con el dato del segundo renglón debajo en `ink-500` («Horas / ritmo», «Esta semana / de la meta», «Leads / llamadas», «1ª gestión / leads», «Cierre / cambio», «Cerrados / por tienda», «Ingresos / cambio»). Asesora (nombre en peso 600, el punto `ok-fg` que late si está en línea —quieto con movimiento reducido— y la chapa `info` «Nueva» sin periodo anterior), la franja de actividad, horas con el ritmo debajo (`ink-600` a ritmo, `warn-fg` por debajo de 6 por hora), leads y llamadas, 1ª gestión (`ok-fg` hasta 30 min, `crit-fg` más de 4 h), cierre con su cambio en puntos, la línea de 7 días (`ok-fg` sobre la guía punteada del 10 %, el % de cada día encima), cerrados con su cambio y «AUR 4/27 KP 7/44» por tienda (la tienda con leads y sin cierres en `crit-fg`; cada tienda entera en su renglón si no caben juntas) e ingresos en peso 600. Fila con hover `wash`; la del panel abierto en `brand-50` al 70 % con el nombre en `brand-700`. Las asesoras en línea sin actividad, y las vendedoras (o quien tiene horario) sin actividad en el periodo, van al final en `ink-500`, sin abrir panel, con su semana: así una ausencia se ve. Bajo 1280 px, una lista con hairlines: nombre y cierre arriba, la franja a todo el ancho, «71 leads · 142 llamadas · 8.5 h · 8.4/h · 1ª gestión 12 min» en tramos enteros y cerrados e ingresos al pie. Arriba de la tabla, la cuenta («5 asesoras · 1 en línea sin actividad · 1 más sin actividad en el periodo · toca una para ver sus leads») y la leyenda de la franja con sus colores de verdad, que suma la marca negra de la semana («Lo que ya debería llevar en la semana»).
- **Franja de actividad:** en «Hoy» y «Ayer», una celda por hora de 07 a 21 h, juzgada dentro de la jornada real: a ritmo en cuatro pasos de azul según cuánto se acerca al máximo del tablero (`brand-50`, `brand-100` con número `brand-700`, `brand-300` con número `ink-900`, `brand-600` con número blanco), bajo ritmo en `warn-bg`/`warn-fg`, hora muerta en `crit-bg` con su «0» en `crit-fg` y fuera de jornada en `line` sin número. El lector de pantalla oye el resumen (horas a ritmo, bajo ritmo y muertas, y el pico). Dos excepciones conscientes: el azul aquí es una escala de datos, no una acción ni un estado («Azul con Oficio» sigue valiendo fuera de la franja), y los números de las celdas de la tabla (por hora, por día o por semana) y los % de la línea de 7 días van a 10 px, fuera de la escala de tipos, porque la celda mide unos 15 px; en el panel los mismos números van a 12 px.
- **Horas por día** (12-10-2026): con un periodo de más de un día, la franja deja de ser el promedio por hora y cuenta las horas trabajadas. Hasta 14 días, una celda por día; más, una por semana de lunes a domingo (recortada a los bordes del periodo; una semana de borde que no pide nada a nadie —un domingo suelto— no se dibuja). El encabezado dice «Horas por día» o «Horas por semana» con el rango («6 – 12 oct.») y, por día, el número de cada día en 10 px `ink-500` sobre su celda (hoy en peso 600 `ink-900`); en la lista del teléfono, que no tiene encabezado, eso abre la leyenda. Cada celda lleva sus horas en 10 px peso 600 (con una decimal hasta siete celdas; enteras, o «<1», si son más) y el tono de cómo le fue contra su parte de la meta, que es la meta de la semana repartida entre sus días de trabajo: en los tonos de estado, no en azul (aquí la celda sí es un estado): `ok-bg`/`ok-fg` si cumplió (media hora de margen por día, una por semana), `warn-bg`/`warn-fg` si quedó corto, `crit-bg` con su «0» en `crit-fg` un día de trabajo sin nada, `info-bg`/`info-fg` hoy mientras dura (con «0» si aún no hay nada) y `line` libre o por venir (con las horas en `ink-600` si trabajó un día libre). Los días antes de su alta en el equipo no se le piden: van libres y su título dice «antes de su alta». El título de cada celda da la fecha, las horas de cuántas, la primera y la última actividad, tarde o salió antes, y el estado; el lector de pantalla oye el total y «Cumplió su meta 3 días, 2 cortos, 1 sin actividad». Las horas son las de «Esta semana» (gestiones de leads y de envíos, sin la lente de fuente), así que pueden no sumar lo mismo que «Horas», que cuenta solo leads. La leyenda cambia con la franja: «Cumplió su meta», «Corto» (o «Corta»), «Sin actividad», «Hoy, en curso» si el periodo llega a hoy, «Libre o por venir».
- **Panel de la asesora:** `SidePanel` de 720 px con su nombre, «En línea» (`ok`) o «Nueva» (`info`) y el periodo. Dentro, en zonas sobre hairlines de borde a borde: un marco de cifras sobre `wash` (cierre con su cambio, cerrados de cuántos leads, ingresos, 1ª gestión en su tono) con llamadas, horas y leads por hora debajo; en un periodo de más de un día, primero la zona «Por día» (o «Por semana» si pasa de 31 días): el rango, la meta por día y el horario como ayuda, a la derecha el total y lo que tocaba, como en «Esta semana» y sin los días antes de su alta («26.2 h · tocaban ~41.4 h hasta ahora», «hasta ayer» sin horario, o «36 h de 48 h que tocaban» en un periodo cerrado), y las mismas filas que «Esta semana» —el día, su barra, las horas, la primera y la última actividad y sus chapas— o, por semana, el tramo, la barra, «38 h de 40 h» y «Cumplida», «Corta», «Sin actividad» o «En curso»; la franja grande con la hora bajo cada celda (en varios días, el promedio por día: a qué horas trabaja); el cierre de los últimos 7 días en columnas (`ok-fg` desde el 10 %, `warn-fg` por debajo, la guía punteada, el % y «3 de 18» bajo cada día); por tienda y por fuente en filas de dos columnas; y los leads trabajados: «Cierra por tipo» en chapas (`crit` el tipo trabajado tres veces o más sin un cierre) y una fila por lead con nombre y teléfono, estado (en `ok-fg` si cerró), fuente, tipo, llamadas y último toque, y a la derecha lo vendido en `ok-fg`. Mientras cargan, esqueletos; si fallan, un aviso `crit` con «Reintentar»; sin leads, una línea en `ink-500`. Escape cierra el panel.
- **Esta semana** (12-10-2026): las horas ACTIVAS de la semana en curso (lunes a domingo, hora local; las de la columna «Horas», contando también las gestiones de envíos) contra la meta de cada asesora, sea cual sea el periodo elegido. En la tabla, «26.7 / 48 h» (la meta en `ink-500`), una barra de 6 px sobre `line` con la marca `ink-900` de lo esperado a esta hora y debajo el veredicto en 12 px: «Al día» y «Cumplida» en `ok-fg`, «Atraso 1.7 h» en `warn-fg` si va más de 1 h por debajo de lo esperado, «Faltaron 10.3 h» en `crit-fg` si la semana cerró sin la meta; la barra va en el tono del veredicto. Lo esperado es la parte de la meta de cada día de trabajo pasado más, hoy, la fracción ya transcurrida de su horario (sin horario, hoy no cuenta hasta que termina). En la lista del teléfono, «Esta semana 26.7 de 48 h» con el veredicto a la derecha y la barra debajo. En el panel, una zona «Esta semana» tras las cifras: el rango, la meta, los días y el horario como ayuda, «Editar horario» (o «Definir horario») a la derecha para owner y admin, que abre Equipo › Horarios con el editor de esa persona; la cifra en 20 px peso 600 «activas de 48 h», «a esta hora debería llevar ~28.4 h» (sin horario, «hasta ayer debería llevar…») con el veredicto, la barra de 10 px y una fila por día con hairlines: el día, una barra corta contra la meta del día (`ok-fg`, `warn-fg` si quedó corto, `ink-500` el día en curso; solo desde 640 px), las horas, la primera y la última actividad y, a la derecha, chapas `warn` «Tarde 24 min» y «Salió 1 h 18 min antes» (pasados 10 minutos de gracia; la salida solo en días pasados) y la del día: «Cumplido» `ok` (desde 640 px, solo si no lleva otra chapa, porque la barra ya lo dice), «Corto» `warn`, «Sin actividad» `crit`, «En curso» `info`. Los días que vienen y los libres sin actividad van en `ink-500` con «—». Una nota de 12 px `ink-500` dice cómo se juzga con sus horas («“Tarde” si la primera pasa de las 10:10; “Salió antes” si la última es antes de las 18:50, en días ya cerrados»), o que sin horario cargado se usa la meta por defecto (48 h, lunes a sábado) y no se juzgan llegadas ni salidas.
- **Equipo › Horarios** (`components/team-schedules.tsx`, 12-10-2026): una tarjeta blanca con la explicación y una fila por persona (vendedoras primero): correo y rol, «48 h por semana · lun a sáb» con el horario debajo (o «Sin horario fijo»), o la chapa «Por defecto» con la meta por defecto; a la derecha, en una columna fija, «Editar» o «Definir horario» secundario. Abre un `SidePanel` de 480 px «Horario de la semana»: la meta en horas con cuánto toca por día, los días de trabajo en chips de elección, «Tiene horario de entrada y salida» con Entrada y Salida, con la ayuda de desde qué hora es «Tarde» y antes de cuál «Salió antes» (con la gracia ya sumada); si la salida no va después de la entrada, el error en `crit-fg` bajo Salida, el anillo del campo en `crit-fg` y «Guardar horario» apagado. El error del servidor va en un aviso `crit` «No se guardó». «Guardar horario» principal, «Cancelar» y, si ya hay horario, «Volver a la meta por defecto» en texto `crit-fg` al borde derecho, que pide confirmar en su lugar («¿Volver a 48 h, lun a sáb, sin horario?», «Sí, volver» en peligro y «No»). Al guardar o volver, un aviso `ok` en la cabecera de la tarjeta lo confirma. Solo owner y admin; la tabla `advisor_schedules` (migración 0245) solo la toca el servidor.

### Consolidado
La pantalla de mando del owner (`/dashboard`, `components/executive-dashboard.tsx`), la misma que cada tienda en `/dashboard/[storeId]`. Título de 28 px («Consolidado», o el nombre de la tienda con «Ajustes de la tienda» secundario a la derecha) y debajo, en 14 px `ink-500`, las tiendas («2 tiendas: Kenku Peru y Aurela») o el dominio. Luego, de arriba abajo:
- **Operación** (`components/mom-owner-summary.tsx`, solo en `/dashboard`): una tarjeta de sección con «Operación», cuántas excepciones esperan y la hora del resumen, y «Abrir Master de Pedidos» secundario. Las cuatro excepciones del MOM en un marco de celdas sobre hairlines (una columna en el teléfono, dos desde 640 px, cuatro desde 1280 px); toda la celda abre su cola: con algo pendiente, lavado `crit-wash` (hover `crit-bg`), la cifra en 20 px `crit-fg` y «Abrir la cola ›»; en cero, blanca, la cifra en `ink-500` y «Al día» en `ok-fg`. Debajo, en su zona, «Cierre y entregas»: los periodos fijos del Master en chips (Hoy, Ayer, 7 días —el de entrada—, Este mes, Mes anterior), que no siguen al periodo de ventas y lo dicen, y los cinco indicadores en un marco de celdas (dos columnas en el teléfono, la última a todo el ancho; cinco desde 1024 px): la tasa en el paso Figure, una barra de 4 px en el azul de la serie sobre `line` y, en 12 px, «159 de 260 · este mes 61 %» —la misma tasa en el mes en curso, o en el anterior si se mira el mes, para leer hoy contra el mes—, que baja a dos renglones donde la celda es angosta en vez de cortarse; título, tasa y línea se alinean entre celdas vecinas (`subgrid`) aunque un título parta en dos; lo que mide cada indicador va en su ayuda emergente y para el lector de pantalla. La tarjeta es corta a propósito: en 1280 × 800 las cifras del periodo empiezan dentro de la pantalla. Si el resumen falla, un aviso `warn`; mientras carga, su esqueleto. Sin antetítulo.
- **LTV : CPA** (`components/ltv-cpa.tsx`, solo en `/dashboard`, MOM §17.2): debajo de la operación, otra tarjeta de sección que no sigue al periodo. Por tienda, una celda en un marco (una columna en el teléfono, dos desde 768 px): el ratio a 30 días del último mes que ya los cumple en el paso Figure con la chapa de su zona de la escala del dueño (`crit` «Pierde caja», `warn` «Estable», `ok` «Gana cuota» y «Dominio», con su significado en la ayuda emergente), de qué clientas y con qué CPA en 12 px, el CPA del mes que aún no cumple 30 días (en `crit-fg` si sube más de 15 %) y lo que sumó la recompra, con el ratio en el tono de su zona. «Ver mes por mes» (secundario) abre un panel de 880 px con la escala, una tabla por tienda —mes, clientas nuevas, gasto, CPA y los horizontes que ya se pueden leer, con el valor por clienta debajo y «*» si es provisional— y cómo se calcula. Una moneda que no se pudo convertir es un aviso `warn` en la tarjeta.
- **Ventas del periodo:** título de 20 px con el rango y con qué se compara («7 – 13 oct · comparado con 30 set – 6 oct») y, a la derecha, «Órdenes CSV» y «Resumen diario CSV» como botones fantasma con su icono. Debajo, el periodo junto a lo que filtra: Hoy, Ayer, 7, 30 y 90 días en chips de elección; tras una raya, «Este mes», el mes anterior por su nombre y «Otro mes…» (un selector con aspecto de chip, los doce meses anteriores); «Desde / Hasta» con dos campos de fecha de 32 px que se aplican con «Aplicar» (o Enter), nunca al teclear —lado a lado con la etiqueta encima en el teléfono—; y la tienda en una píldora que cambia de ruta. Todo vive en la URL (`from`/`to`); mientras llega el tablero nuevo, el actual queda en su sitio al 60 % con «Actualizando…».
- **Cifras del periodo:** el marco de Productividad con cinco celdas (dos columnas en el teléfono, la última a todo el ancho; cinco desde 1024 px): Ingresos, Pedidos, Ticket promedio, Conversión y Primera respuesta, con el cambio contra el periodo anterior del mismo largo; la conversión cambia en puntos («+0.4 pts»), no en porcentaje.
- **Rejilla de módulos** (`components/module-board.tsx`): diecisiete módulos en cuatro grupos con su etiqueta en 12 px peso 600 `ink-500` —«Ventas», «Origen y cierre», «Lo que se pierde», «Números, negocio y sistema»—, cada grupo un marco de celdas blancas sobre hairlines (una columna en el teléfono, dos desde 768 px, una por módulo desde 1280 px; una celda impar al final ocupa la fila con dos columnas). Cada celda dice su título en 13 px `ink-600` con un chevrón `ink-300`, la cifra en el paso Figure (en `crit-fg` o `warn-fg` solo si dice un estado: el paso más débil del embudo, las tiendas con fallas en Kapso), una línea de 12 px `ink-500` que la explica y, al pie, un gráfico de bolsillo (`components/dashboard-viz.tsx`): columnas por día de 24 px como mucho con la del mejor día —el que nombra la línea— en azul (en «Patrón de horas», la hora pico), una línea con su lavado al 10 %, una barra partida con 2 px de aire en el orden canónico de sus partes y una leyenda que nombra cada segmento, las tres primeras filas de una lista con su barra en `ink-500` (el embudo, con conversaciones, interesados y pedidos) o los estados en filas con su punto, su nombre y la palabra del estado en su tono («Aurela · Degradada», «Conversaciones 17 % · Crítica»). Toda la celda es un botón (hover `wash`, foco con anillo interior de 2 px) que abre el módulo en un `SidePanel`; Escape lo cierra. Las celdas no cambian de sitio con el periodo: sin datos, la cifra va en `ink-500` («—») con lo que falta dicho («Sin carritos en el periodo»), la celda pierde su alto reservado y no abre nada.
- **Paneles:** `SidePanel` con el mismo título que la celda que lo abrió y, de contexto, el rango y el alcance («7 – 13 oct · todas las tiendas»); de 560 a 880 px según lo que llevan, y 1320 px la tabla de anuncios, que se desplaza de lado por dentro. Dentro, secciones con título de 14 px peso 600 y su ayuda en 13 px; los marcos de cifras sin sombra; tablas con encabezados en el paso Label, filas sobre hairlines y cifras a la derecha en `ink-900`. Un gráfico nunca va solo: lleva su tabla («Día por día», «Por anuncio») y un solo eje; dos medidas de escala distinta son dos gráficos uno debajo del otro con el mismo eje de días (Ingresos y Pedidos por día; Conversión y Conversaciones por día). Barras de 24 px como mucho con el extremo redondeado, rejilla de hairlines sólidas, ejes en 12 px `ink-500`, tooltip blanco con sombra de popover y el valor primero; con dos series o más, la leyenda arriba. Las fuentes se abren en la tabla con su chevrón para auditar sus pedidos; la tabla de anuncios conserva su orden por columna, el filtro por producto, el detalle de cada anuncio y el producto anunciado editable, con sus señales en chapas (`ok` «Escalar», `info` «Prometedor», `warn` «Revisar cierre» y «Producto desalineado», `crit` «Freno operativo» y «Sin leads atribuidos», neutras las de muestra o datos).

### Leads
La mesa de llamadas de las vendedoras (`/dashboard/leads`, `components/leads.tsx`), pensada para la computadora. Título de 28 px «Leads» y debajo, en 14 px `ink-500`, las tiendas con cuántos hay sin llamar y en seguimiento; a la derecha, la tienda en píldora de una opción (`ChoicePill`), «Venta por teléfono» secundario con su icono y «Audiencia Meta» fantasma con su cuenta (en la vista de varias tiendas, en su lugar «Audiencia Meta: elige una tienda» en `ink-500`). El «Tablero de hoy» (`LeadsInsightsPanel`) sigue con su aspecto anterior por decisión de Frankz. Luego, de arriba abajo:
- **Chips, dos filas como mucho y siempre a la vista:** arriba, qué lista se mira —«Sin llamar» y «En seguimiento» (este con los que piden atención en una chapa `crit`), tras una raya `line-strong` «Atender ahora» y «Yape / Shalom» como píldoras de excepción (`AttentionPill`, la cuenta en chapa `warn`), tras otra raya «Seguimientos», «Ganados» y «Perdidos»—; abajo, solo en la cola, «Segmento» (Frío, Conversó, Producto, Distrito, Carrito) y «Cobertura» (Lima, Provincia, Sin identificar), cada chip con su cuenta faceteada. No hay chip «Todos»: volver a tocar el elegido lo quita. Con 6 px entre chips y rayas de 4 px de aire; donde una fila no cabe (el teléfono), se desplaza por dentro sin barra a la vista. La primera fila la cierran a la derecha la búsqueda (256 px y 32 px de alto como los chips, por nombre o celular, en todas las etapas, con su propio «x» para borrar) y «Más filtros», como en la imagen aprobada (en la cabecera de la cola nadie lo encontraba; la búsqueda bajó de la cabecera de la página a pedido de Frankz); donde no caben al lado de los chips bajan juntas a su propia línea, nunca tapan un chip. «Más filtros» abre una hoja anclada (`Sheet` ops, ancha) con Gestión (en seguimiento), Edad del lead, Ventana de WhatsApp —cada una en chips con su cuenta y una línea `ink-500` de qué mide—, Última interacción (fecha), Fuente, Producto (con buscador pasadas ocho opciones) y Número en casillas con su cuenta, y «Quitar estos filtros»; con algo puesto, la píldora se vuelve sólida y nombra lo que filtra.
- **El siguiente lead** (`components/leads-next.tsx`, MOM §11): solo para el rol `vendedora`, en «Sin llamar» y sin búsqueda, una tarjeta a lo ancho en tres columnas desde 1280 px —el cliente y lo que pregunta, registrar la gestión y el chat— (entre 1024 y 1280 el chat baja a lo ancho; en el teléfono, una columna). Lo que pregunta va primero porque es lo que la vendedora mira (Frankz, 14-10-2026): llamar y escribir quedan a mano pero callados. **El cliente:** el nombre en 20 px peso 600, o el celular en grupos («+51 900 578 504») cuando no hay nombre, y entonces no se repite debajo; en 13 px `ink-500` la tienda (en la vista combinada), el celular si hay nombre, cuándo entró y por qué anuncio; a la derecha tres iconos de 32 px con anillo `line-strong` —copiar el número, llamar y abrir WhatsApp—; las chapas: el segmento con el monto del carrito, `ok` «Hora dorada · quedan 44 min» solo en la hora dorada, `warn`/`crit` la ventana, `brand` «Cliente recurrente» cuando compró antes, e `info` «Reservado para ti» con la explicación en su título; y, si «Más filtros» tiene algo puesto, «Sale de la cola con Hora dorada · Quitar». Debajo, «Lo que pidió» con la foto del catálogo (72 px, `/api/wa-image`, la misma regla de casado que la prueba de imagen) junto al producto en 14 px peso 600 y, en 13 px, las unidades, el monto, «contra entrega» en el formulario de carrito y el número del carrito (los artículos y las cantidades salen del borrador de Shopify, `loadNextLeadCart`); sin carrito, «Lo que miraba» o lo que escribió. «Lo que dijo al bot» (o «Su primer mensaje») en un bloque `wash`. Tras una hairline, una lista de dos columnas: Pedidos antes (cuántos, el último producto y los tres últimos con número, fecha y monto, o «Ninguno: es cliente nuevo»; mientras Shopify responde, «Buscando en Shopify…»), Llamadas (cuántas y la última, con quién y cómo quedó), WhatsApp (cuántas veces escribió y cuándo), Entrega (la calle, el lugar y la cobertura si no se lee ya; sin calle usable —el «-» que deja el formulario no lo es— un aviso `warn-fg` con su pin «Falta la dirección exacta: pídela en la llamada») y Llegó por (el origen y la hora). **Registrar la gestión:** título en 14 px peso 600; los seis resultados en chips centrados de dos o tres columnas según el ancho de la columna (consulta de contenedor), «Otro estado» con el aspecto del chip a lo ancho, «Próximo seguimiento», la nota en un área de tres renglones y, al pie, «Guardar y siguiente» principal grande a lo ancho con «Abrir ficha» secundario y «Saltar este lead» fantasma debajo. **El chat:** el de la ficha en su variante de tarjeta sobre `wash`, que no decide el alto: se desplaza dentro del que marcan las otras dos columnas (mínimo 448 px); sin ventana y sin plantillas, un solo aviso `warn` en lugar de dos. Mientras se reserva, su esqueleto; con dos leads abiertos, un aviso `warn` «Tu siguiente lead está en pausa» con «Reintentar»; sin nadie libre, una línea en `ink-500` que dice qué cambiar.
- **La cola:** una tarjeta de trabajo con su título («Sin llamar 14», o la vista elegida, o «Resultados» al buscar) y, a la derecha, en «Sin llamar», «Orden» con «Lo que más cierra» o «Más recientes». Es una sola lista en el orden medido, nunca agrupada por edad. Encabezados en el paso Label: «Lead y lo que pidió», «Última gestión», «Edad». Cada fila en dos renglones sobre hairlines: el nombre en 14 px peso 600, la tienda en la vista combinada, la chapa del segmento, «Pago» / «Agencia» en Yape / Shalom, `warn` «Atención», `brand` «Tu siguiente» y `info` «Tomado · Lucía» con su candado (la fila tomada sobre `info-wash`); debajo, el anzuelo en 13 px con su palabra en `ink-500` («Carrito:», «Anuncio:», «Escribió:»). La gestión con su punto (anillo `warn-fg` sin llamar, `ink-500` sin respuesta, `ok-fg` contactado) y la fecha; «Atendiendo ahora» con el punto `info-fg` que late si la tiene otra. La edad a la derecha con su punto del tramo —`ok-fg` en la hora dorada, que late y dice «quedan 44 min», `warn-fg` de 1 a 6 h, `ink-500` hasta un día, `ink-300` después— y la ventana solo cuando limita («ventana por vencer» en `warn-fg`, «sin ventana» en `crit-fg`). Llamar y WhatsApp aparecen al pasar el puntero. Sin raya lateral de color. Arriba de la tarjeta, la banda `ok-wash` de la hora dorada con «Ver estos 4» cuando hay alguno, y el aviso `warn` del costo de oportunidad al mirar los fríos.
- **Ficha del lead** (`components/leads-drawer.tsx`): `SidePanel` de 1040 px con el nombre, las chapas (segmento con carrito, ventana, Pago / Agencia, `crit` «No contactar») y el celular con «Copiar» y «Llamar». Desde 1024 px, dos columnas: a la izquierda la conversación, pegajosa y del alto de la hoja, con el hilo sobre `wash`, los mensajes entrantes blancos con anillo y los salientes en `line`, en 13 px con la hora tabular; a la derecha, en tarjetas: Lo que pidió, el resumen del bot en aviso `info`, Aliclik, el agente de voz, el QR para llamar desde el celular (solo en escritorio), Resultado de la llamada (chips en tres columnas, «Otro estado», «Próximo seguimiento», nota y «Guardar resultado»), Historial, Pedidos anteriores y Origen; «Generar pedido (contraentrega)» principal y pegajoso al pie. El formulario del pedido ocupa la columna derecha sin desmontar las tarjetas. Bajo 1024 px, una sola columna.
- **Venta por teléfono** (`components/venta-telefonica.tsx`): un `SidePanel` de 480 px con la tienda en chips, el celular («Consultando…» a la derecha de su etiqueta) y el nombre opcional; el pedido que ya existe va en el aviso de su tono (`crit` el mismo pedido, `warn` uno abierto, `info` una recompra), las conversaciones sin número en un bloque `warn-wash` con una fila por candidata que abre su ficha, y el botón principal a todo el ancho dice lo que va a pasar («Abrir y generar pedido», «Abrir su ficha», «No es ninguna: crear y abrir la ficha»).
- **Anuncios** (`/dashboard/leads/anuncios`, `components/ad-products.tsx`): título de 28 px con cuántos leads esperan una firma; tres tarjetas de estado (Sin declarar con su punto `warn-fg`, Declarados, Todos); una tarjeta de trabajo con buscador por titular o ID y una fila por anuncio (titular, tienda e ID en monoespaciada con «Copiar», leads, lo que suele vender con su chapa de evidencia `ok` fuerte o `warn` floja, y los periodos declarados o la chapa `warn` «Sin declarar»). «Declarar» o «Añadir periodo» abre un `SidePanel` de 520 px con la sugerencia en su aviso («es una sugerencia: no se aplica sola»), el producto por su nombre (ya escrito si la sugerencia coincide con uno conocido) y, debajo, el handle con el que se guarda, «Desde siempre» o «Desde una fecha» en chips y los periodos con «Quitar».

### Roles y permisos (Equipo)
Dos lecturas en el mismo `SidePanel`, para entender quién puede qué sin pasar el ratón. **«¿Qué hace cada rol?»** (880 px): desde `md`, un índice de 13 rem a la izquierda con los grupos «Roles» y «Además» en 12 px peso 600 `ink-500` y sus ítems de 32 px en 13 px `ink-600`, con su cifra tabular a la derecha; el elegido en `brand-50` con texto `brand-700` en peso 600, como el índice de Ajustes. Bajo `md` el índice es un selector «Ver» con grupos, también como en Ajustes: los chips ocupaban cuatro filas antes del contenido. Al lado, lo elegido: título de 16 px peso 600 con la chapa neutra de su cifra, para quién es en 14 px `ink-600` a 62 caracteres, «Lo tienen (n):» en 13 px y, tras una hairline, sus permisos por área: el área en 13 px peso 600 `ink-700` con su cifra, y cada permiso una fila sobre hairlines, el nombre en 14 px peso 500 `ink-900` y lo que deja hacer en 13 px `ink-500`. **Lo que puede hacer una persona** (600 px): su nombre con la chapa de su acceso, una línea con cuántas cosas puede hacer y, si su acceso trae algo, eso dicho una sola vez; sus roles como píldoras que abren su parte de la guía; y los permisos por área con el origen a la derecha en chapas neutras (el rol, «Dado uno por uno»), debajo en el teléfono. Lo quitado a mano va aparte, tachado en `ink-500` con la chapa `warn` «Quitado». Los nombres y las explicaciones salen del glosario de `lib/permissions.ts`; los encabezados Roles, Permisos por persona y Acceso de la tabla llevan un botón de información de 24 px (44 px táctil) que abre su parte de la guía.

### Ficha del pedido
La página de detalle de Stripe en una hoja lateral (880 px). Velo `ink-900` al 20 % para que la fila resaltada del Master se siga leyendo detrás; hoja con sombra de popover que recibe el foco al abrir y lo devuelve al cerrar, y por dentro el lienzo `slate-50` con las secciones en tarjetas de sección. Cabecera fija y blanca con hairline inferior: el pedido en 18 px peso 600, el enlace a Shopify como icono, la chapa del estado comercial (con candado si está fijado a mano), el monto en peso 600 y la chapa de cobertura; debajo, en 13 px `ink-500`, tienda · creado el · cliente · teléfono con «Copiar» (en el teléfono, el cliente entero en su propia línea y debajo tienda · teléfono, sin la fecha, que está en Información; en escritorio, si no cabe, se recorta el cliente y nunca el teléfono); a la derecha «Llamar», «WhatsApp», «Llamar desde Kapta» (con la línea de Telnyx configurada) y «Master de Pedidos» como secundarios pequeños (solo icono en el teléfono) y el cierre. Los avisos de las acciones (error en `crit`, hecho en `ok`) viven dentro de la cabecera fija con su «x». Pestañas subrayadas Operar / Información / Actividad (48 px, flechas, Inicio y Fin; la de Actividad con su cifra en chapa).
- **Índice de la pestaña:** bajo las pestañas, en la cabecera fija y sobre su hairline, una fila con las secciones de la pestaña abierta en el orden en que se ven (no el del DOM: el cobro sube o baja con `order-*`), botones de 28 px (44 px con puntero táctil) en 13 px peso 500 `ink-600`; la que se está leyendo —la última cuya tarjeta pasó bajo la cabecera, y la última al llegar al fondo— va en `brand-50` con texto `brand-700` y `aria-current="location"`. Un toque la lleva bajo la cabecera (la hoja mide su cabecera en `--ficha-head`, que también usan los saltos de la próxima acción) y le pasa el foco. En el teléfono se desplaza de lado, mantiene la actual a la vista y se desvanece por la derecha mientras quede índice. Con una sola sección no se dibuja.
- **Operar:** «Situación» con la chapa de macroetapa, la subetapa y los motivos en chapas de atención en su cabecera y la antigüedad como ayuda; debajo, el recorrido de seis pasos (hechos en disco `ink-900` con visto, el actual con el par de su macroetapa y anillo de 2 px de su tono, los siguientes en blanco). La próxima acción es la única tarjeta de sección con anillo azul de 2 px —excepción consciente al azul reservado: el usuario la eligió así en la maqueta de las secciones en tarjetas— y pasa a `warn-wash` con anillo `warn-bg` si algo la frena: título de 16 px con su chapa de contexto, explicación y un único botón principal con chevrón; el motorizado de Grupo GF, si lo hay, va en una zona de esa misma tarjeta. Debajo, cada mesa es una tarjeta de sección: gestión de confirmación (días como chapas, avisos de fecha pactada o ciclo, «Antes de llamar» como zona con el historial del cliente en filas de borde a borde, el intento en otra zona con su botón y el agente de voz en otra), mesa de ruta (una tarjeta-opción por modalidad; la sugerida con anillo azul de 2 px y botón principal, las de aviso en `warn-wash`, las bloqueadas en `wash`; las que casi no se usan —Axel y Urpi— plegadas al pie en «Otros couriers», una franja de borde a borde sobre hairline con chevrón que se abre sola si alguna tiene una salida viva; la de Aliclik, mientras se puede tomar y antes de la primera guía, lleva la entrega estimada —ver «Entrega estimada de Aliclik»—), cobro, salidas y guías (filas de borde a borde: courier, códigos en monoespaciada, chapa de estado y los papeles como enlaces con flecha; la credencial de Shalom en su zona), mesa de cierre (las acciones como tarjetas-opción con el lenguaje de la selección; las que no se deshacen, en `crit-fg`; el formulario en su zona) y gestión manual (registrar estado y comentario en zonas, y «Devoluciones y correcciones avanzadas» plegado en la última franja, de borde a borde).
- **Cobro:** título y chapa de estado del cobro (`warn` si falta el adelanto, `info` mientras hay algo por validar, `ok` pagado, `crit` posible duplicado, neutra si es opcional y no hay pago); el resumen es el marco de cifras (Validado de total, Cargado y Saldo por cargar sobre `wash`, en filas de etiqueta y monto bajo 448 px de tarjeta, y cada monto sin partirse) con la barra de lo validado en `ok-fg` sobre `line-strong` y la línea del adelanto mínimo. Los comprobantes son filas con su chapa de revisión, la cuenta receptora en `ok-fg`, `warn-fg` o `crit-fg` con icono, «Validar» como principal pequeño, el mensaje que se enviará como desplegable con chevrón y la miniatura a la derecha («Ampliar»). «Registrar un pago» es una zona con tres pasos en vertical: disco de 24 px con su número (o `ink-900` con visto al estar hecho, como el recorrido), título de 14 px con su estado en chapa («Opcional», «Guardado», «Ya en la guía», «Imagen cargada», «Leído», el saldo por cargar) y una línea que baja al siguiente paso. La cuenta receptora leída son dos columnas sobre `wash` separadas por una hairline, con el estado en el disco y en el color del texto. Con la imagen elegida y una tarjeta de 672 px o más (`@container`, no la ventana), el comprobante queda en una columna de 240 px a la derecha, fijo bajo la cabecera mientras se baja por los campos; si no cabe, va dentro del paso 2. Un solo principal a la vez: «Leer y rellenar» hasta leer, después «Registrar». Pagado en el checkout, la tarjeta dice «Cobro» con la chapa `ok` «Pagado por web». El texto secundario sobre `wash` o un lavado de tono va en `ink-600`.
- **Aliclik:** «Crear guía en Aliclik» con la salud de su API como chapa en la cabecera (`ok` operativo, `warn` si crear falla, `crit` si cotizar falla, neutra sin monitoreo; con `warn` o `crit` su explicación se lee además en un aviso). Lo que para la escritura va en avisos antes de los pasos: el riesgo de pago (`warn`, con la justificación de la excepción) y la retención por posible duplicado (`crit`, que pasa a `ok` resuelta; el otro pedido como enlace con su guía en monoespaciada y la resolución en tarjetas-opción con la consecuencia del §8.3). Detrás de ellos, y solo con entrega baja, el aviso `warn` de la entrega estimada («Pedido de 5 días · Aliclik entrega ~27 %», el dato en «de cada 10», qué hacer y de qué guías sale): informa, no para la escritura. Después, tres pasos: «Ubicación y cotización» (el campo de la coordenada con su ejemplo en la ayuda; «Cotizar envío» es el principal hasta que hay cotización y luego secundario; el pin que el pedido no respalda es el único bloqueo dentro de un paso, porque es la respuesta de la cotización), «Revisa antes de crear» (el pedido en monoespaciada y lo que se cobra en la puerta en un marco de cifras sobre `wash`, con la nota del redondeo al pie; recojo, dónde ubica Aliclik el pin, lo que teníamos y el almacén en filas con hairlines, en `warn-fg` el domingo y el pin que no coincide, que además llevan su aviso; los avisos de la cotización en líneas `warn-fg` con su icono) y «Transportadora y creación» (una tarjeta-opción por transportadora con el precio a la derecha, la más barata elegida con su chapa, la nota para el courier y, al pie, «Crear guía en Aliclik» con el motivo por el que está apagado en `warn-fg` a su lado, o lo irreversible en `ink-500`; mientras crea, un aviso `info` pide no cerrar). «Vincular una guía ya creada en Aliclik» es una franja plegada al pie de la tarjeta, de borde a borde, con chevrón. Los botones dentro de un aviso son secundarios: el azul de la tarjeta es cotizar o crear. Las rejillas miran el ancho del panel (`@container`), porque en Leads vive en media columna. El bloque de Agencia lleva «Revisar ubicación y cobertura» fantasma a la derecha de su cabecera y «Comprobar si Aliclik llega» como secundario; si llega, un aviso `ok` con «Marcar … como Provincia COD».
- **Llamada desde Kapta** (`components/browser-call.tsx`, 11-10-2026): una tarjeta que flota abajo a la derecha (blanca, 8 px de radio, sombra de popover, 352 px de ancho como máximo), fuera de la hoja para que no se mueva al bajar por la ficha. Arriba «Llamada desde Kapta» (12 px `ink-500`) y el teléfono en 14 px peso 600 tabular; a la derecha, la fase con un punto de 8 px del color del texto: `ink-500` mientras conecta o timbra (el punto late al timbrar), `ok-fg` en llamada, `crit-fg` si falla. En llamada, el reloj en 24 px peso 600 tabular. Mientras dura, una línea de 12 px `ink-600` dice con qué número llama y que cerrar la ficha la corta. Al pie, a la derecha: «Silenciar» (o «Activar micrófono») secundario y «Colgar» en peligro; al terminar, el resultado en 14 px peso 500 (contestó y cuánto, o por qué no), si quedó guardada, y «Registrar el resultado» como principal —lleva a la mesa de confirmación— y «Cerrar». Avisa con `role="status"`.
- **Entrega estimada de Aliclik** (`components/aliclik-outlook.tsx`, 09-10-2026): un recuadro sin anillo dentro de la tarjeta de Aliclik (`wash`, o blanco si la tarjeta está en `warn-wash`), como el de la salida que bloquea. Arriba «Entrega estimada» (12 px peso 600) con la chapa del nivel —«Baja» en `warn`, «Muy baja» en `crit`; sin chapa si es normal—, los días del pedido debajo y, a la derecha, la cifra en 20 px peso 600 tabular en el tono del nivel (`ink-900`, `warn-fg`, `crit-fg`). Debajo, la escalera: cuatro columnas (Hoy, 1 d, 2 d, 3+ d) con una barra de 32 px como máximo, proporcional desde cero, sobre una hairline `line-strong`; la del pedido en el tono de su nivel y las demás en `line-strong`, con el porcentaje y el tramo debajo (el del pedido en peso 600 y `aria-current`). Cierra con qué hacer (13 px `ink-700`: «Que salga hoy: mañana bajaría a 55 %», «Antes de crear la guía, confirma…», «Créala solo si el cliente contesta hoy…») y de qué guías sale (12 px `ink-600`). Es un dato de la tienda, no del pedido: con menos de 30 guías en un tramo usa las de todas las tiendas y lo dice; sin muestra, no se dibuja.
- **Actividad** (`TimelineMarker` en `components/order-master-shared.tsx`, 13-10-2026): la línea de tiempo es un riel de 1 px en `line-strong` con un disco de 28 px por movimiento (anillo blanco de 3 px que corta el riel) y su icono de trazo de 16 px, que dice qué hecho es (`lib/order-timeline-fact.ts`). Los hitos —pedido generado, confirmado, pago validado o rechazado, guía o salida creada, despacho, reprogramación, intento fallido, entrega, retorno, anulación, liquidación— toman el par `*-100` / `*-800` de su macroetapa (la misma excepción del MOM §25 que `MacroStageBadge`); el resto —llamadas, mensajes, notas, claves, barridos del courier en ruta— lleva su icono en `wash` con `ink-500`, para que los hitos se lean primero. El estado nuevo manda sobre el tipo: un barrido del courier que dice «Entregado» es la entrega. Un tipo sin dibujo lleva un punto de 6 px en `ink-300`. El disco es decorativo (`aria-hidden`): el título dice lo mismo.
