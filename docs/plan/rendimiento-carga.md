# Carga del sistema: análisis y plan (25-11-2026)

Pedido del owner: «analizar la carga de todo el sistema… para que al equipo le
cargue más rápido», con la duda de si conviene «cargar por bloques», y el
reporte de que **Repro Lima carga demasiado lento**.

Este documento es un análisis y una propuesta. No cambia código ni reglas. Lo
medido salió de producción en modo lectura: los logs de Vercel y las
estadísticas de consultas de la base (`pg_stat_statements`), del 14-11 al 25-11
(10,4 días). Lo que es deducción del código y no una medida lo dice.

## 1. La respuesta corta

**«Por bloques» ayuda, pero no es lo primero.** Cargar por bloques hace que la
pantalla aparezca antes; el trabajo total del servidor y de la base es el mismo.
El sistema hoy está lento por tres causas, en este orden:

1. **Recarga demasiadas veces.** Casi cada acción vuelve a leer la pantalla
   entera, a veces dos o tres veces, y varias pantallas se releen solas cada
   pocos segundos o minutos.
2. **Lee demasiado cada vez.** Las pantallas principales leen todo (todos los
   pedidos de Lima, toda la cola de leads, todo el historial de solicitudes) en
   vez de leer lo que se está mirando.
3. **Trabaja de fondo aunque nada cambie.** Los procesos automáticos (crons)
   vuelven a tocar las mismas guías y pedidos todo el día.

El orden que propongo: primero recargar menos y cortar el trabajo de fondo
(fase 1), después leer menos (fase 2), y recién ahí partir en bloques (fase 3).

## 2. Lo que se midió

### El tamaño real de la operación

| Dato | Valor |
|---|---|
| Tiendas activas | 2 |
| Usuarios con acceso | 37 |
| Pedidos nuevos por día (últimos 7 días) | 293 |
| Leads nuevos por día (últimos 7 días) | 1.106 |
| Pedidos abiertos en el Master | 2.644 de 42.649 |
| Base de datos | 4 GB |

Con ese volumen, la base atendió **62 millones de consultas en 10,4 días**:
unas 69 por segundo de promedio, de día y de noche. La base no está saturada
(ocupa en promedio el 12,5 % de un núcleo). El problema no es falta de máquina:
es la cantidad de idas y vueltas. **Subir el plan de la base no lo arregla.**

### Repro Lima

| Medida | Valor |
|---|---|
| Cargas completas en un día (24-11) | 1.056 |
| Pedidos que lee en cada carga | 1.157 (todos los pendientes de Lima) |
| Tiempo del servidor con el sistema tranquilo | 2,0 a 2,6 s |
| Tiempo cuando coinciden varias cargas | 5 a 8,7 s |
| Cargas de 5 s o más (muestra de 100, de noche) | 18 |

Ese tiempo es solo leer los datos; falta enviarlos y dibujar la pantalla. La
muestra es de las 8 a 9 p. m. de Lima; en hora punta no lo medí.

Por qué se recarga tanto (código):
- **Abrir una ficha («Atender») recarga la pantalla entera**, y cerrarla
  también (`claimReproCase` y `releaseReproCase` hacen `revalidatePath`,
  `app/dashboard/pedidos/repro-lima/actions.ts:170,190,237`).
- Cada guardado recarga otra vez.
- Volver a la pestaña después de 20 s recarga otra vez
  (`components/repro-lima-board.tsx:73,310`).
- Hay dos lecturas paralelas de los mismos pedidos (`loadReproLima` y
  `loadLimaPending`), cada una con sus oleadas de consultas.
- Los 1.157 pedidos con todos sus datos viajan al navegador en cada recarga.

Cuando cinco personas atienden a la vez, cinco recargas completas coinciden y
todas tardan 5 a 8 s. Eso es lo que el equipo siente.

### Qué consume la base (10,4 días)

| Qué | Parte del tiempo de la base | Quién lo dispara |
|---|---|---|
| Leads (todo junto) | ~47 % | La pantalla de Leads y sus refrescos |
| — `lead_routing_scope` | 21 % | 389.308 llamadas |
| — lecturas de `leads` | 13 % | 2,06 millones |
| — `lead_insights_rollup` | 4,6 % | 7.185 llamadas de 723 ms |
| Lecturas de `order_master` | 8,7 % | Master, contadores, crons |
| `swayp_auto_inspect` | 6,9 % | Cron de Swayp automático |
| Catálogo Aliclik (lee `orders.raw`) | 4,9 % | Cron de cada hora |
| Filtros del Master (`master_facets` y opciones de producto) | 6,9 % | Cada carga y cada filtro del Master |
| Recalcular el Master | 2,6 % + sus lecturas | 28.763 veces por día |

Dos números que resumen el trabajo de fondo:
- El Master se recalcula **28.763 veces por día** con 293 pedidos nuevos por
  día: unas 100 veces por pedido.
- Las guías se actualizan **85.047 veces por día**; en 14 días hubo 1.747 guías
  de Aliclik.

### Navegar entre secciones no es el problema

El sistema ya mide lo que tarda cada cambio de sección en el navegador
(`/api/performance`). En la muestra del 24-11 casi todos tardan menos de 0,5 s,
porque el menú precarga. Lo lento viene después: los datos de la pantalla y la
recarga tras cada acción. Esa medida junta Repro Lima con «pedidos», así que hoy
no se ve por separado.

## 3. Hallazgos por sección

Cada uno dice si está **medido**, **verificado en el código** o es
**deducción**.

### Repro Lima
1. Abrir y cerrar una ficha recarga todo (verificado). Es lo más barato de
   arreglar y lo que más se nota.
2. Cada carga lee los 1.157 pedidos de Lima con dos lectores distintos
   (verificado).
3. Nada se comparte entre usuarios: cinco personas, cinco lecturas idénticas
   (verificado).

### Leads
1. Cada pestaña abierta consulta la cola cada 60 s y recarga el tablero entero
   cada 2 minutos, porque la «firma» que compara incluye el minuto y siempre
   cambia (deducción de `lib/leads-live-refresh.ts` y la migración 0351).
2. «Por llamar» no pagina: trae todos los leads abiertos (12.386 hoy) en
   páginas de 1.000 y los manda al navegador (verificado en
   `lib/leads-access.ts`).
3. `leads.claimed_by` **no tiene índice** (medido en la base): cada toma de un
   lead recorre la tabla completa. La tabla tuvo 111.982 recorridos completos
   en el periodo.
4. `lead_insights_rollup` tarda 723 ms; antes de la migración 0289 tardaba
   15 ms (lo dice la propia migración 0263). Perdió un filtro que usaba el
   índice.
5. Cada acción sobre un lead pide permiso con una consulta aparte, y la ficha
   abierta consulta cada 12 y 20 s (verificado).
6. El cron de cada 5 minutos reescribe unos 160 leads por pasada aunque no
   haya nada nuevo: 478.000 actualizaciones en el periodo (el número coincide
   con el cálculo del código).

### Master de Pedidos
1. Los filtros (`master_facets`, opciones de producto) recorren toda la tabla
   nueve veces y se calculan en cada carga, cada filtro y cada cambio de
   página. Tienen caché de 2 minutos, pero se llamaron el doble de lo que esa
   caché permitiría: algo la está vaciando (deducción: las acciones).
2. Guardar en la ficha puede recargar el Master hasta tres veces (verificado:
   la acción revalida, la ficha recarga y el tablero refresca).
3. Cada pestaña del Master pregunta cada 45 s si algo cambió, y recarga todo
   si cambió cualquier pedido de cualquier persona o cron (verificado).
4. La página es un solo bloque: la tabla espera a los filtros, los contadores
   y la revisión de distritos (verificado). Aquí «por bloques» sí aplica.
5. Con un filtro puesto, los contadores son una consulta por pestaña
   (verificado).
6. La ficha carga todo de una vez, incluidas las pestañas que no se miran:
   25 a 35 consultas (verificado).

### Menú y avisos (todas las pantallas)
1. Tres avisos consultan al servidor desde cada pestaña abierta: cobranza cada
   20 s, Yape y devoluciones de llamada cada 15 s (verificado). El de cobranza
   además escribe en cada consulta.
2. Los contadores del menú se recalculan en cada recarga (verificado).

### Courier, Envíos y Consolidado
1. Courier carga las tres pestañas cada vez, con todo el historial de
   solicitudes sin límite de fecha, y recarga dos veces por acción
   (verificado). El propio código anota que rehacer esta página dos veces
   costaba 6 a 7 s por cada QR escaneado.
2. Envíos calcula dos veces lo más caro (los recuperables) y manda hasta
   5.000 filas al navegador (verificado).
3. Consolidado baja miles de filas para contarlas (verificado). Se abre unas
   25 veces por día, así que pesa menos.

### Procesos automáticos (43 crons)
1. **Aliclik, cada 20 minutos:** casi seguro reescribe cada guía entregada y
   recalcula su pedido en cada pasada, porque compara la fecha de cierre como
   texto y los dos formatos nunca coinciden (`lib/aliclik-track.ts:288-291`,
   `lib/aliclik-snapshot-diff.ts:27-35`). Verifiqué el código; falta una prueba
   que lo confirme. Explicaría buena parte de los 28.763 recálculos diarios.
2. **Catálogo Aliclik, cada hora:** relee un año de pedidos con su JSON
   completo (verificado; 12.307 lecturas de 445 ms).
3. **Swayp automático, cada 30 minutos:** vuelve a inspeccionar los mismos 50
   candidatos aunque no hayan cambiado (verificado; 25.245 inspecciones de
   310 ms).
4. **Comprobantes, cada 2 minutos:** recorre todos los pedidos desde el 29-08
   (verificado).
5. **GF, Olva y Tanders:** marcan la guía como «revisada» aunque no cambió, y
   eso hace que el Master la recalcule (verificado).
6. `pago-solo-online` está programado `* 10 * * *`: corre cada minuto durante
   una hora. Confirmar si es lo que se quería.

## 4. Plan propuesto

### Fase 0 — Medir cada pantalla (1 día)
- La misma línea de tiempos que ya tiene Repro Lima, en Leads, Master, Courier
  y Envíos.
- Separar Repro Lima y Courier en la medida del navegador.
- Sin esto no se puede decir cuánto mejoró cada cambio.

### Fase 1 — Recargar menos y cortar el trabajo de fondo (1 a 2 semanas)
No cambia reglas del negocio. Ataca consultas que hoy suman cerca de la mitad
del tiempo de la base.

| # | Cambio | Sección | Riesgo |
|---|---|---|---|
| 1 | Abrir y cerrar una ficha ya no recarga la pantalla; se actualiza solo esa fila | Repro Lima | Bajo |
| 2 | Una sola recarga por guardado (hoy 2 o 3) | Repro Lima, Master, Courier, Despacho | Medio |
| 3 | Índice en `leads.claimed_by` (migración, se aplica a mano) | Leads | Bajo |
| 4 | Devolver a `lead_insights_rollup` su filtro con índice | Leads | Bajo |
| 5 | No consultar la cola dos veces antes de cada recarga; contadores con caché de 30 a 60 s | Leads | Bajo |
| 6 | Arreglar la comparación de fechas del barrido de Aliclik (con prueba) | Crons | Bajo a medio |
| 7 | Catálogo Aliclik: lo reciente cada hora, el año completo de noche | Crons | Bajo |
| 8 | Swayp automático: no reinspeccionar lo que no cambió | Crons | Medio |
| 9 | Filtros del Master: cargarlos al abrir el filtro, con caché que las acciones no vacíen | Master | Bajo |
| 10 | Avisos del menú: una sola consulta liviana cada 30 a 60 s | Todas | Bajo a medio |

### Fase 2 — Leer menos (2 a 4 semanas, pantalla por pantalla)
1. **Repro Lima:** una sola lectura en vez de dos, y una «foto» compartida por
   todo el equipo durante 10 a 20 s, que se renueva cuando alguien guarda.
   Cinco personas a la vez pasan de cinco lecturas a una. El navegador recibe
   los contadores y solo las filas del paso que está mirando.
2. **Leads:** «Por llamar» filtra en la base en vez de traer todo, y los
   refrescos traen solo lo que cambió.
3. **Courier:** cada pestaña carga lo suyo; las solicitudes, solo las abiertas.
4. **Envíos:** calcular una vez, paginar.
5. **Fichas (pedido y lead):** lo esencial primero; el historial y las demás
   pestañas, al abrirlas.

### Fase 3 — Por bloques (1 a 2 semanas)
La tabla primero; contadores, filtros y avisos después, cada uno en su bloque.
Aplica al Master, Courier, Envíos y Consolidado.

### Fase 4 — Sostener más volumen
- Recalcular el Master en lotes y con sus lecturas en paralelo.
- GF, Olva y Tanders con su propia marca de «revisado», como ya tiene Shalom.
- Contadores en tablas resumen en vez de contar cada vez.
- Revisar qué historial se guarda: `shopify_history_*` ocupa 1,7 GB de los
  4 GB.

## 5. Decisiones del owner

1. **Refresco de Leads:** hoy el tablero se recarga cada 2 minutos. Subirlo a
   5 minutos baja la carga; el MOM documenta la cadencia actual.
2. **Comprobantes:** pasar el cron de cada 2 minutos a cada 10.
3. **Avisos de cobranza:** hoy avanzan «al leer»; moverlos a un cron cambia
   cuándo escalan.
4. **Por dónde empezar.** Recomendación: fase 0 y los cambios 1, 2 y 6 de la
   fase 1, que son los que el equipo de Lima va a sentir primero.

## 6. Lo que no se pudo verificar

- Los planes de ejecución de las consultas pesadas (hace falta `EXPLAIN` en la
  base).
- El peso de lo que viaja al navegador en cada pantalla.
- Repro Lima en hora punta (la muestra es de noche).
- El arreglo del barrido de Aliclik necesita una prueba antes de tocarlo:
  `closed_at` ancla la ventana de Reproprovincia.
- El reparto exacto de las 389.308 llamadas de `lead_routing_scope` entre el
  tablero y la ficha.
- Varias afirmaciones sobre cómo se comporta Next.js al revalidar salen del
  código y su documentación, no de una prueba.

## 7. Avance (25-11-2026)

El owner aprobó la fase 0, los cambios 1, 2 y 6 de la fase 1, y dos de las
decisiones: Leads cada 5 minutos y comprobantes cada 5 (no cada 10).

### Hecho

| Qué | Antes | Ahora |
|---|---|---|
| Repro Lima: abrir una ficha | Una lectura entera de la pantalla | Ninguna |
| Repro Lima: cerrar una ficha | Una lectura entera | Ninguna |
| Repro Lima: guardar una llamada | Tres lecturas enteras | Una |
| Repro Lima: «Programar», «No se entregó» y la guía rápida de la fila | Dos lecturas | Una |
| Aliclik: guías entregadas sin cambios | Se reescribían y recalculaban su pedido cada 20 minutos | Solo se anota que se leyeron |
| Leads: recarga del tablero | Cada 2 minutos | Cada 5; lo urgente, al momento |
| Foto de pedidos para boletas | Cada 2 minutos | Cada 5 |
| Medición | Solo Repro Lima | También Leads, Master, Courier y Envíos |

**Aliclik, confirmado con datos.** La causa era la que se sospechaba: la fecha
de cierre se comparaba como texto y los dos formatos nunca coincidían. Medido
el 25-11: 247.723 reescrituras en 10 días, unas 23.800 al día, cerca del 83 %
de los recálculos del Master. De las 735 guías entregadas de la ventana, en
tres horas se recalcularon los 735 pedidos y cambiaron 3.

**Cuánto mejora.** No está medido todavía: los cambios no están en producción.
Con la medición puesta, al día siguiente de desplegar se puede comparar contra
las 1.056 lecturas de Repro Lima del 24-11 y los 28.763 recálculos diarios.

### Lo que no entró del cambio 2

«Una sola recarga por guardado» quedó hecho en Repro Lima. Falta en:
- **Master, Courier y Despacho.** Cada acción de la ficha del pedido recarga
  la pantalla de atrás dos veces. Hay que revisar acción por acción cuáles ya
  la traen en su respuesta; con la medición nueva se sabrá cuáles pesan.
- **Los lotes de Repro Lima** («Programar» y «Aprobar» elegidos): leen la
  pantalla una vez por pedido. Con 30 pedidos son 30 lecturas. Necesita que el
  lote entero vaya en una sola llamada.

### Hallazgos nuevos

1. **El cierre de Aliclik tocaba guías que no cambiaron. Confirmado, con su
   migración lista (0356).** Cada 20 minutos anota en las guías que persigue
   que ya les preguntó (`aliclik_followup_at`). La base contaba eso como un
   cambio de la guía, el Master recalculaba el pedido y todas las pestañas del
   Master se recargaban. Medido el 25-11: de 1.219 guías de Aliclik tocadas en
   tres horas, 997 solo habían recibido esa anotación. La migración
   `0356_aliclik_followup_no_touch.sql` aplica la misma regla de la 0204 y la
   0321; se aplica a mano, fuera de horario (DEPLOY.md).
2. **La foto de pedidos para boletas ya no tenía qué fotografiar. Apagada el
   25-11-2026 por decisión del owner.** La última es del 04-11-2026 y los
   2.039 pedidos de la última semana son de WooCommerce, que no llevan foto.
   Cada pasada terminaba en error: Shopify rechaza con HTTP 403 el único pedido
   que quedaba sin foto. Las fotos guardadas y la emisión de boletas no cambian
   (MOM §35.10).

### Avisos de cobranza (aprobado el 25-11-2026)

Antes, cada consulta del aviso flotante (cada 20 s, en cada pestaña) hacía
avanzar los avisos de todas las tiendas: unas 150 pasadas por minuto, y sin
nadie conectado no avanzaban. Ahora:
- Un proceso los hace avanzar cada 5 minutos, haya o no alguien conectado.
- Con Kapta abierto, cada servidor los hace avanzar como mucho una vez por
  minuto por tienda; entre medias la consulta solo lee.

No quedó «una vez por minuto» con un proceso: varios procesos tienen su minuto
reservado y uno de cada minuto los pisaría. El efecto para el equipo es el
mismo: con Kapta abierto, un aviso vencido pasa a la siguiente persona en un
minuto y pico.

### Repro Lima: cuánto tarda cada lectura (25-11-2026)

Medido con la línea `[repro-lima] carga`, una hora en horario de trabajo, ya
con una lectura por guardado: 2,3 a 3,6 s por lectura. La causa era la
cantidad de consultas: unas 260 por lectura, porque cada tabla se leía de a
100 pedidos y varias lecturas esperaban a otras sin depender de ellas.

| Qué | Antes | Ahora |
|---|---|---|
| Pedidos por tanda en cada tabla | 100 (12 tandas con 1.184 pedidos) | 400 (3 tandas) |
| Consultas por lectura de la pantalla | Unas 260 | Unas 100 (estimado) |
| Pedidos de la etapa (3 páginas) | Una tras otra | La primera, y las otras dos juntas |
| Cajas vigentes de Grupo GF, proveedor y salidas | Las cajas primero, lo demás detrás | En una sola espera |
| Historial de rutas reportadas | En fila al final | Junto a las demás lecturas |

Filas por tanda, medidas en producción ese día: la tabla más cargada son las
salidas, con 1,25 por pedido (unas 500 filas por tanda de 400), lejos del tope
de 1.000 filas por respuesta. Por si un día no lo está, cada tanda pide el
conteo exacto y se parte sola cuando el servidor la corta.

**Cuánto mejoró, medido.** 13 cargas en los primeros minutos tras desplegar
(hora de almuerzo, poca gente): de 1,6 a 2,3 s, mediana cerca de 1,9 s, contra
2,3 a 3,6 s de antes. Cerca de un tercio menos; no la proporción de las
consultas que se estimó. Ninguna consulta suelta es lenta (la de la etapa
tarda 9 ms en la base), así que lo que queda son las esperas en fila. Para
saber cuál, la línea `[repro-lima] carga` anota desde entonces cada etapa
(`c.*` para casos, `p.*` para pendientes).

Queda para después: que las dos lecturas de la pantalla (casos y pendientes)
compartan lo que hoy leen por separado (las salidas se leen cuatro veces), y
que los lotes vayan en una sola llamada.

### Leads: cuánto tarda la lista (25-11-2026)

Medido con la línea `[leads] carga`, una hora en horario de trabajo: 2,9 a
9,8 s por carga, y `lista` era cerca del 90 %. La cola de «Por llamar» son
12.513 leads con 47 columnas, leídos en 13 páginas de mil, cada una esperando
a la anterior. La base contestaba cada página en 42 ms de media (con el
armado de la respuesta incluido): el tiempo se iba en la fila de viajes, no
en la base.

| Qué | Antes | Ahora |
|---|---|---|
| Cómo se lee la cola | 13 páginas, una detrás de otra | 16 tramos de ids, de a 8 a la vez |
| Tandas de espera | 13 | 2 |
| Costo en la base, medido igual en las dos formas | 21 ms y 7.700 bloques por página de mil | 10 ms y unos 950 bloques por tramo de unos 800 |
| Cuándo empieza a leerse | Después de la respuesta del reparto | A la vez que el reparto |
| Medición | `lista` (cola y productos sumados) | `lista` y `productos` por separado |

**Cuánto mejora.** Estimado, no medido: de 13 esperas a 2. Se confirma con la
línea `[leads] carga` después de desplegar.

**Lo que este cambio no arregla.** La pantalla sigue trayendo los 12.513
leads enteros al navegador en cada carga y en cada recarga. Eso pesa en la
red y en el navegador de cada asesora y no lo mide `lista`. Es el cambio 2 de
la fase 2 («Por llamar» filtra en la base en vez de traer todo).

**Un tope que se acerca.** La cola se corta en 20.000 leads
(`LEADS_PAGE_CAP`) y la pantalla no avisa cuando lo alcanza: los que pasan el
tope no salen en «Por llamar». Eran unos 7.000 el 02-10-2026 y son 12.513 el
25-11-2026. Si sigue creciendo así, se alcanza en unos dos o tres meses
(estimado). El cambio 2 de la fase 2 lo resuelve de raíz.

### Medido el 26-11-2026, con todo en producción

| Pantalla | Antes (25-11) | Después (26-11, tarde y noche) |
|---|---|---|
| Leads | 2,9 a 9,8 s | 1,5 a 2,2 s; una de cada tres, 4,6 a 6,3 s por `productos` |
| Repro Lima | 2,3 a 3,6 s (5 a 8,7 s en picos) | 1,5 a 2,1 s; 3 a 4,2 s cuando cargan varias a la vez |

- **Leads.** `lista` bajó a 1,1–1,8 s. Lo que quedaba eran las cargas que
  coincidían con la renovación del catálogo de productos (cada 5 minutos, 3 a
  4,5 s desde WooCommerce). Desde el 27-11 el tablero no la espera.
- **Repro Lima.** Las dos lecturas van a la par y tardan parecido. En
  `pendientes` manda `p.gestion` (1,0–1,7 s, saber si ya se llamó a cada
  clienta, en dos esperas) y `p.gf` (salidas → detalle → cajas, en fila). En
  `casos`, `c.hechos.tablas` (0,4–0,9 s) y `c.hechos.rutas`. Ninguna consulta es
  lenta en la base: son esperas en fila de varias consultas.
- **«Guardar y pasar al siguiente».** Dos usos registrados la tarde del 26-11;
  en uno la dirección intentó volver al pedido guardado y la guarda la
  corrigió (`repro:next-reverted`). No hubo queja nueva.

### Siguiente paso propuesto

1. Medir un día con lo que ya está en producción (desde el 25-11-2026).
2. Aplicar la migración 0356, fuera de horario.
3. Con los tiempos reales de Leads y del Master, elegir entre los cambios 3,
   4, 5 y 9 de la fase 1.
