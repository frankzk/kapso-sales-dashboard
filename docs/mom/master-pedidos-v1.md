# Master Operations Map — Master de Pedidos v1

Estado: Fase 4 implementada; macroetapa Por confirmar cerrada funcionalmente
Propietario del proceso: Frankz  
Sistema: Kapta (`kapso-sales-dashboard`)  
Fuente visual: board Miro «Master Operations Map»  
Última consolidación: 2026-08-18

## 1. Propósito

Este documento es la fuente de verdad funcional para traducir el Master
Operations Map (MOM) al software. Miro explica visualmente el proceso; esta
especificación define las identidades, estados, transiciones, precedencias,
responsabilidades y condiciones que Kapta debe poder ejecutar y auditar.

Objetivo de producto:

> Todo el equipo debe poder ejercer sus funciones dentro del Master de Pedidos,
> y toda acción operativa debe quedar registrada allí.

La implementación es incremental y compatible con la operación actual. La
Fase 1 calculó las macroetapas en modo sombra. Desde la Fase 2, las seis
macroetapas y sus subetapas son la navegación principal del Master; los estados
heredados continúan disponibles como evidencia y compatibilidad.

## 2. Principios no negociables

1. Shopify es la única fuente de pedidos.
2. Todo pedido de Shopify aparece en el Master: ni más ni menos.
3. Kapta no crea pedidos comerciales. Las correcciones comerciales se realizan
   anulando el pedido incorrecto en Shopify y creando otro.
4. Kapta es la fuente de verdad operativa, logística, financiera y de auditoría.
5. El historial se conserva indefinidamente.
6. Los hechos no se sobrescriben ni se eliminan. Una corrección genera un nuevo
   evento que conserva el valor anterior.
7. Un pedido puede tener varias salidas físicas simultáneas o sucesivas.
8. El estado del pedido no reemplaza el estado de cada salida.
9. `Entregado` en logística y `cerrado financieramente` son hechos distintos.
10. Ningún resultado de courier cancela por sí solo el pedido en Shopify.
11. Nunca se automatizan sin intervención humana: cancelación en Shopify,
    reembolsos, excepción de adelanto, merma y cierre de una liquidación
    observada.

## 3. Vocabulario canónico

### Pedido

Orden comercial creada en Shopify. Tiene una identidad única y puede sobrevivir
a múltiples intentos logísticos.

### Salida

Intento físico de entregar un pedido. Una salida corresponde a un paquete, un
QR estable, un courier o motorizado y, cuando exista, una guía externa.

### Guía externa

Código emitido por Aliclik, Swayp, Shalom, Olva, Tanders, Axel, Urpi u otro
courier. No es la identidad interna de la salida.

### Paquete

Bolsa o caja física correspondiente a una salida. La versión v1 soporta un solo
paquete por salida.

### Manifiesto

Agrupación de salidas para un courier y una ruta del día. El manifiesto debe
quedar cotejado al 100 % antes de transferir la custodia.

### Evento

Hecho inmutable ocurrido sobre el pedido o una salida: confirmación, llamada,
generación de rótulo, escaneo, transferencia de custodia, resultado, pago,
retorno, liquidación, corrección, reapertura, etc.

## 4. Identidad de las salidas

Cada pedido mantiene su número Shopify y cada salida recibe un consecutivo:

```text
Pedido: KP123
Salida interna: KP123-S01
Etiqueta visible: KP123-S01-ALICLIK
QR: token estable e independiente del courier y de la fecha
```

Reglas:

- El consecutivo se asigna dentro del pedido y no se reutiliza.
- Cambiar de courier después de existir custodia genera una salida nueva.
- Una salida puede nacer **sin courier decidido** (`por definir`). El almacén
  arma y rotula antes de saber con quién sale —que es el orden real del trabajo—
  y el courier se fija cuando la caja entra a la ruta de un courier concreto en
  la mesa de despacho. Hasta entonces la etiqueta visible es solo
  `pedido + consecutivo` y el rótulo dice `Por definir`.
- La regla de repetición por modalidad se evalúa cuando el courier se conoce; el
  máximo de cinco salidas rige siempre, porque no depende del courier.
- **Crear la guía de un courier (Tanders, Aliclik, Shalom) RELLENA la salida
  `por definir` del pedido en vez de abrir una segunda.** Fijar el courier es lo
  que la salida estaba esperando; es la misma caja, ya armada y rotulada. Se
  conservan el consecutivo, el `output_code`, el QR, el estado de preparación y
  el de custodia: el rótulo interno dice `Por definir` y el equipo le pega encima
  el del courier, así que sigue siendo válido. Solo se rellena si sigue
  `pendiente`, sin courier decidido, y la caja no cambió de custodia — las mismas
  condiciones que para anularla, más el courier sin decidir; con courier ya
  puesto, escribir encima escondería un cambio de courier. Al rellenarla, la vía
  pasa a ser la del courier, así que deja de ofrecerse «Anular salida»: esa guía
  ya existe del otro lado y se anula desde su propio botón.
- **Por lo mismo, una salida `por definir` no cuenta como «guía activa»** para el
  freno que impide emitir dos guías. No es otro paquete en la calle: es esta caja
  esperando courier. Contarla obligaba a anular la salida para poder emitir la
  guía, y anularla arrastraba el pedido a `anulado` — con un solo camino de ida.
- Cada salida nueva genera un QR nuevo.
- Una salida de **agencia** se imprime en UN solo papel: la etiqueta del courier
  arriba —incrustada tal cual desde su API, nunca redibujada— y debajo la banda
  de Kapta con el QR de la salida, el pedido, la guía y los productos con su
  cantidad. El papel cuelga de la salida del courier, que ya trae su propio QR,
  así que el almacén no necesita crear una salida `por definir` para tener algo
  que escanear. La medida de la página del courier no se da por supuesta: se
  escala conservando la proporción contra lo que devuelva su API, y **la banda
  arranca donde termina su etiqueta**, no a una altura fija — un reparto fijo
  solo acierta con una proporción, y la de cada courier es la suya. El sitio que
  sobra se reparte en QR más grande y más líneas de producto, no en margen.
- El PDF del courier **se guarda la primera vez** y se pide adelantado al crear
  la guía. Ese documento es inmutable una vez emitida —se indexa por su
  identificador de envío, no por el pedido— y pedirlo cuesta unos 45 segundos,
  al filo del tiempo máximo de espera: sin caché, un día lento no da un rótulo
  tarde, deja al almacén sin papel. Un fallo de la caché nunca impide imprimir.
- Una salida de ruta manual se puede **anular** mientras siga `pendiente` y la
  caja no haya cambiado de custodia. Anular no borra: la fila conserva su
  consecutivo y su historial, y el consecutivo no se reutiliza. Es la corrección
  de un registro —la salida creada por error o con el courier equivocado—, no un
  hecho logístico. Una vez transferida la custodia al motorizado hay un paquete
  en la calle y el camino es recibir su retorno, no anular.
- Anular es obligatorio que exista porque el sistema ya lo exigía: crear una guía
  de agencia rechaza el pedido con una salida activa, y el cierre no finaliza con
  salidas activas. Sin la acción, una salida `por definir` creada por error deja
  al pedido sin poder emitir guía **ni** cerrarse.
- Las salidas con API propia (Aliclik, Shalom, Tanders) no se anulan por esta
  vía: tienen la suya, que además avisa al courier. Marcarlas anuladas solo de
  nuestro lado dejaría la guía viva en el courier.
- El courier y la fecha son metadatos visibles; no forman parte del token QR.
- El código de guía externa se conserva separado.
- El límite global acordado es cinco salidas por pedido.
- Puede existir más de una salida activa, pero Kapta debe mostrar una alerta.
- Si una salida entrega, las demás salidas activas deben generar una tarea
  urgente para Daysi: avisar al courier o motorizado y cancelar la entrega.

Reglas de repetición conocidas:

| Operación | Courier | Repetición |
| --- | --- | --- |
| Lima | Motorizados propios | Permitida, dentro del máximo global |
| Lima | Axel Courier | Permitida, dentro del máximo global |
| Lima | Swayp | Una vez por pedido |
| Lima | Urpi | Una vez por pedido |
| Lima | Tanders | Una vez por pedido |
| Reproprovincia | Swayp | Varias veces, cada una con salida y QR nuevos |

La regla de repetición de Aliclik todavía debe cerrarse.

## 5. Clasificación de operación

La ruta se decide automáticamente a partir del distrito, cobertura, modalidad,
stock y reglas de riesgo. La clasificación visible es:

1. Lima COD.
2. Provincia COD.
3. Agencia.

Reglas iniciales:

- Lima omite confirmación y entra directamente a Preparación.
- Provincia COD y Agencia empiezan en `Sin llamar`.
- Provincia COD recomienda primero Aliclik.
- Reproprovincia usa Swayp con stock local después de una salida Aliclik fallida.
- Agencia recomienda Shalom primero y Olva como alternativa.
- Aliclik no atiende Agencia: no se ofrece como ruta **ni se puede crear o
  vincular una guía suya** desde un pedido de esa cobertura. Si la clasificación
  está mal, el camino es corregir la dirección; la cobertura se recalcula a
  partir de ella y la ruta reaparece sola.
- Tanders es exclusivo de cobertura Lima. No se muestra ni se acepta desde el
  servidor para Provincia COD o Agencia.
- Cañete siempre se clasifica como Agencia, aunque Shopify lo etiquete como
  `Lima (provincia)` o exista una tarifa COD histórica que coincida.
- La cobertura tiene UNA sola definición, `order_coverage_for` en la base. Decide
  la cobertura COD por tarifa vigente **y** por cercanía a un punto donde Aliclik
  ya entregó COD, porque el nombre del destino no basta: Shopify guarda
  «Puerto Maldonado» (la ciudad) y Aliclik factura «Tambopata» (el distrito), y
  por texto nunca casan. La modalidad del pedido —y con ella la exigencia de
  abono— se deriva de esa clasificación, así que nada la recalcula por separado.
- La confirmación tiene UNA sola definición, `hasConfirmationSignal`.
  Un pedido está confirmado si existe una guía, si hay evento `confirmed`,
  `guide_registered` o `label_generated`, o si Shopify lo da por pagado —en
  contraentrega no hay pago previo, así que `paid` significa que se cobró por
  otra vía—. Responde por la evidencia: la exención de Lima es política de
  macroetapa y se aplica donde se resuelve la etapa, no dentro de la
  definición, porque el estado operativo legado sí debe seguir distinguiendo
  un pedido de Lima que nadie llamó.
- Las rutas que no tienen cobertura se ocultan.
- Las rutas con una condición pendiente, como falta de stock o pago, pueden
  mostrarse bloqueadas con una explicación.
- Una inconsistencia entre distrito y coordenadas puede continuar con alerta y
  justificación corta.

Fallback de Provincia:

```text
Aliclik → Swayp con stock local → Shalom u Olva
```

Swayp es el nombre vigente de Fénix. El código legado puede continuar usando
`fenix`, pero la interfaz debe mostrar `Swayp (antes Fénix)`.

## 6. Macroetapas del pedido

Las macroetapas pertenecen al pedido y se calculan automáticamente. Los estados
de transporte pertenecen a cada salida.

```text
Por confirmar → Preparación → Por despachar → En curso → Por cerrar → Finalizado
```

### 6.1 Por confirmar

Aplica a Provincia COD y Agencia. Lima la omite.

Subetapas:

- `sin_llamar`: cero contactos registrados.
- `por_confirmar`: hay al menos un intento y ningún compromiso vigente.
- `volver_a_contactar`: el intento más reciente dejó pactada una fecha.
- `ultimo_intento`: séptimo día distinto de gestión.
- `historico_sin_gestion`: pedido anterior al corte operativo de Kapta que no
  tiene contactos. Se conserva para consulta, pero no es trabajo nuevo.

Motivos (conviven con la subetapa, no la reemplazan):

- `pago_requerido_pendiente`: Agencia confirmó verbalmente, pero todavía no se
  validó el pago exigido.

Reglas:

- El corte operativo de confirmación se configura por tienda y empieza el
  **01/06/2026**. La base puede contener pedidos anteriores por backfill; si no
  tienen gestión, no inflan `Sin llamar`, los conteos ni los KPI del equipo.
- Si un pedido anterior al corte sí tiene gestión, sale del histórico y se
  clasifica por sus hechos reales.
- La subetapa dice en qué punto va la gestión; el motivo dice qué falta para
  avanzar. Un pedido de Agencia con próximo contacto pactado y sin abono
  validado está en `volver_a_contactar` **con** el motivo
  `pago_requerido_pendiente`.
- Si el cliente no abona en la fecha pactada, no cambia de etiqueta: se vuelve a
  llamar y sigue en confirmación con el mismo motivo abierto hasta que el pago
  se valide o se agoten los siete días.
- El motivo se abre a partir del primer contacto registrado: antes no hay a
  quién pedirle el abono.

- Un pedido que ya tuvo contacto nunca vuelve literalmente a `Sin llamar`.
- Llamada normal, llamada WhatsApp y mensaje escrito realizados el mismo día
  constituyen un día de intento.
- Se gestionan siete días distintos. Dentro de un día puede haber varios
  contactos.
- **Los siete días se cuentan como días distintos CON gestión, no como días
  transcurridos desde el primer contacto.** Contactos el 20, 22, 25 y 28 de
  julio suman cuatro días, no nueve. Los días en que nadie llamó no gastan cupo.
- El día se corta en el calendario de Lima. Un intento de las 20:00 pertenece a
  ese día, aunque en UTC ya sea el siguiente.
- `Último intento` se **deriva** del conteo; no depende de que alguien recuerde
  marcarlo.
- El día siete es `Último intento`; después se crea una tarea de anulación
  manual en Shopify. Se asigna a la última persona que gestionó y la responsable
  de respaldo configurable es Milagros. Kapta nunca anula automáticamente; la
  tarea se completa cuando Shopify sincroniza la anulación.
- Un intento posterior sin compromiso de fecha devuelve el pedido a
  `por_confirmar`: el compromiso anterior ya no describe nada. Manda el hecho
  más reciente.
- Un pedido que nadie contacta **nunca llega a `Último intento`**: sin gestión no
  hay días gastados. Queda en `Sin llamar` y su antigüedad es lo que lo delata,
  no la subetapa.
- Existe un recordatorio automático una vez transcurridas dos horas laborales
  sin respuesta.
- Horario laboral: 08:00–22:00, hora de Lima. El reloj se pausa fuera de horario.
- `Volver a contactar` y `Pendiente de abono` guardan únicamente una **fecha**,
  no una hora. Vencidos, hoy y próximos forman colas operativas; los
  recordatorios de dos horas entran en las mismas colas según su vencimiento.
- Provincia COD queda confirmada al validar producto, cantidad, monto, fecha
  aproximada y dirección de entrega.
- Agencia queda confirmada solo cuando el pago exigido ha sido validado.
- Crear el rótulo implica confirmación; no puede existir rótulo para un pedido
  de Provincia/Agencia sin confirmación válida.

Registro:

- Registrar un intento es una transacción atómica: contacto, seguimiento,
  confirmación y tarea derivada se guardan juntos o no se guarda ninguno.
- Cada gesto lleva un `operation_id`. Un doble clic o reintento de red devuelve
  el resultado existente y no duplica eventos, días ni tareas.
- Cada intento se registra en la **mesa de confirmación** del pedido, con canal
  y resultado. Escribe `confirmation_contact`; si el resultado pacta una fecha
  escribe además `confirmation_followup`, y si el cliente confirma, `confirmed`.
- Resultados del intento:

  | Resultado | Pacta fecha | Confirma | Subetapa resultante |
  | --- | --- | --- | --- |
  | `sin_respuesta` — No contestó | No | No | `por_confirmar` |
  | `se_deja_mensaje` — Se deja mensaje | No | No | `por_confirmar` |
  | `volver_a_contactar` — Contestó · volver a contactar | Sí | No | `volver_a_contactar` |
  | `pendiente_de_abono` — Pendiente de abono | Sí | No | `volver_a_contactar` |
  | `confirmado` — Confirmó el pedido | No | Sí | pasa a Preparación |

- `se_deja_mensaje` gasta día igual que `sin_respuesta`: el §6.1 cuenta el día
  con gestión, no el día con respuesta. Se distingue porque el cliente quedó
  preguntado y eso cambia el guion del siguiente intento.
- `pendiente_de_abono` es el caso ya descrito arriba —aceptó y quedó en
  abonar—, ahora seleccionable. Pacta fecha y **no** confirma: en Agencia la
  confirmación exige el pago validado, no la promesa. No enciende
  `pago_requerido_pendiente`; ese motivo se deriva del estado del pago y no de
  lo que se marque en la mesa.
- La línea de tiempo del pedido muestra el resultado y el canal de cada intento,
  no solo que hubo uno. Un intento registrado que no se puede leer después no
  sirve de historial: quien retoma la gestión necesita saber qué pasó, y la nota
  es opcional.
- Los comentarios y el cambio manual de estado **no** son registro de gestión.
  El cambio manual es un override que congela el pedido frente al recálculo:
  usarlo como bitácora de llamadas lo desconecta del MOM.
- La subetapa y el conteo de días se derivan de esos hechos. No hay un contador
  que alguien tenga que mantener.

### 6.2 Preparación

Responsable principal: Yelitza.

Subetapas:

- `por_generar_rotulo`.
- `por_armar`.
- `incidencia_preparacion`.

Flujo físico:

```text
Validar datos → generar e imprimir rótulo → buscar producto → empacar
→ pegar rótulo → escanear → dejar en agrupación de despacho
```

Reglas:

- Provincia COD confirmada pasa a `Por generar rótulo`.
- Agencia pasa a `Por generar rótulo` solo con el pago requerido validado.
- Lima entra directamente a `Por generar rótulo`.
- Si faltan datos, Yelitza avisa al equipo, no genera guía y no arma.
- El escaneo del QR confirma que el paquete está armado y lo mueve a
  `Por despachar`.
- El armado ocurre en la pantalla de Almacén (`/dashboard/pedidos/almacen`), no
  en la Mesa de despacho. Son dos oficios distintos: aquí se cierran cajas y la
  cola es la de esta fase (`Preparación · Por armar`); allá se decide qué caja
  va con qué courier. Quien arma no necesita permisos de ruta y ve su pendiente
  además de lo que ya escaneó.
- La cola de armado se define por el PEDIDO, no por la salida suelta: una salida
  cuyo pedido ya no está en `Por armar` —cancelado, o despachado por otra caja—
  no es trabajo de almacén y no se lista.
- Una salida cuya guía está `anulada` o `transferida`, o que el courier ya reporta
  `en ruta` o `entregada`, tampoco es trabajo de armado: nadie va a empacar esa
  caja. Se aparta con el motivo a la vista y **no** cuenta en el pendiente. No se
  oculta: el pedido puede seguir vivo en el Master y esta es la pantalla que debe
  explicar por qué su caja ya no está en la fila.
- La cola se agrupa por operación en la prioridad de almacén de este apartado
  —Lima, después agencia, después provincia— y dentro de cada grupo lo más
  antiguo va primero. Una lista sola ordenada por fecha entierra las cajas de
  Lima debajo del volumen de provincia, que es el grueso de los días normales.
- La pantalla encabeza con **un recuadro por operación** —Lima, agencia,
  provincia— que dice cuánto falta empacar. Los tres se muestran **siempre,
  incluso en cero**, y el cero se dibuja distinto: es el dato que el almacén
  necesita para saber si ya cerró lo suyo. Un grupo vacío no se dibuja en la
  lista, así que sin el recuadro la ausencia de cajas es indistinguible de no
  haber mirado. El recuadro cuenta la cola completa; el buscador filtra la lista,
  nunca el recuadro.

**Turnos de almacén y cortes.** El almacén trabaja en dos turnos, cada uno con
su hora de corte en hora de Lima y su propio calendario:

| Turno  | Corte | Días              |
| ------ | ----- | ----------------- |
| Mañana | 10:20 | lunes a viernes   |
| Noche  | 21:20 | domingo a viernes |

Reglas:

- El corte se le exige **solo a Lima**. Agencia y provincia se muestran con su
  número, pero sin corte: las cajas de Provincia COD salen de la cola con el
  `PREPARED` de Aliclik, así que un rojo ahí señalaría al almacén por una demora
  del courier, que no es suya.
- El sábado **no tiene corte**: no lo trabaja ninguno de los dos turnos. No es
  una excepción escrita aparte, sale del calendario de cada turno.
- El corte vencido se exige durante **4 horas**. Pasado ese plazo la caja sigue
  pendiente, pero deja de leerse como «el turno no cerró» y pasa a ser atraso,
  que es lo que ya cuenta el contador de detenidas. Sin ese tope, el corte del
  viernes por la noche teñiría de rojo todo el sábado.
- El aviso previo empieza **90 minutos** antes del corte.
- Sin cajas no hay nada que exigir: el recuadro en cero no se pone en rojo
  aunque el corte haya pasado.
- El renglón nombra siempre el turno además de la hora. Un corte sin turno no
  señala a nadie, y la responsabilidad de las 10:20 y la de las 21:20 son de
  equipos distintos.
- Cada caja dice **qué hecho la saca de la cola**: el escaneo local, o el reporte
  del courier en los casos con equivalencia documentada (hoy solo Aliclik). El
  almacén empaca las tres operaciones; lo que cambia es quién cierra la caja.
  Sin esa distinción, Provincia COD se lee como pendiente de escanear cuando en
  realidad espera el `PREPARED` de Aliclik, y la pantalla acusa un atraso que no
  existe.
- Una caja pendiente de tres días o más se marca **detenida**. No es el trabajo
  del día: o el courier nunca reportó, o la caja se quedó sin dueño.
- El escaneo acepta cuatro identificadores del mismo rótulo: el QR, el código de
  salida, la guía del courier y el número de pedido en código de barras. Los tres
  primeros designan una caja; el número de pedido designa al pedido, que puede
  tener varias salidas. Cuando el pedido tiene más de una salida pendiente, el
  sistema no elige por el operador: pide el QR o el código de salida.
- Para Aliclik, el estado autenticado `PREPARED` constituye el evento equivalente
  a ese escaneo físico y mueve automáticamente la salida a
  `Por despachar · Listo para asignar`. No se exige un tercer escaneo en Kapta.
- La equivalencia completa de despacho Aliclik **autenticado** (API/webhook) es:
  `TO_PREPARE` → `Preparación · Por armar`; `PREPARED` →
  `Por despachar · Listo para asignar`; `PICKED` → `En curso · Recibido por
  courier`. Esta vía avanza además la custodia física (`custody_state`) y la
  preparación (`preparation_state`).
- Estos avances son monotónicos: un reporte atrasado de Aliclik no puede deshacer
  un escaneo local ni devolver ficticiamente la custodia desde el courier.
- **Reporte Excel de Aliclik.** Mientras la API no esté conectada, el estado
  llega por el Excel del panel de Aliclik. El importador deriva el
  `delivery_status` de la guía combinando las columnas **ESTADO ENTREGA** y
  **ESTADO DESPACHO** (mismo cerebro que la vía autenticada, `mapAliclikStatus`):
  - `ENTREGADO` → `entregado` (cierra; manda sobre cualquier despacho).
  - `CANCELADO` / `ANULADO` → `anulado`; `DEVUELTO` (despacho) → `anulado`.
  - `RECHAZADO` / `NO CONTESTA` / `REPROGRAMADO` → `en_ruta` (el paquete ya salió
    y sigue en calle), salvo que el despacho ya diga `DEVUELTO` (→ `anulado`).
  - Despacho `RECOLECTADO` / `EN TRÁNSITO` / `POR DEVOLVER` / `EN AGENCIA` →
    `en_ruta`; `POR PREPARAR` / `VALIDADO` / `DEJADO EN ALMACÉN` o `POR ENTREGAR`
    sin señal de despacho → `pendiente` (sigue en almacén).
  - Un valor no reconocido no inventa estado: cae al binario histórico
    entregado-vs-pendiente.
- **Excepción — un `NO CONTESTA` devuelve la guía a `pendiente`.** Es la única
  transición que RETROCEDE, así que se decide aparte de la precedencia
  monotónica (`reopensForFailedAttempt`) y solo si el intento ocurrió **en o
  después** del día agendado (`next_followup_at`): un reporte rezagado con un
  "no contesta" viejo no deshace una reprogramación que todavía no le toca. Sin
  fecha del intento no reabre (falla del lado seguro); sin fecha agendada sí,
  porque no hay nada que proteger. Motivo operativo: si la guía se queda `en
  ruta` nadie la vuelve a llamar, se agota la ventana de reprogramación de
  Aliclik y el paquete se devuelve a Lima con el flete a cargo nuestro.
  La regla vive en **las tres** vías que escriben estado —el barrido de la API
  (`aliclik-track`), el Excel de Aliclik (`aliclik-ingest`) y el Excel de los
  demás couriers (`report-ingest`)—; en una sola no sirve, porque la otra
  devolvería la guía a `en_ruta` en el siguiente barrido.
- A diferencia de la vía autenticada, el Excel **solo** fija `delivery_status`:
  no avanza `custody_state` ni `preparation_state` (el dato de despacho del Excel
  es ruidoso — `VALIDADO` persiste incluso en entregados). Por eso un `VALIDADO`
  del Excel mantiene el pedido en `Preparación · Por armar`, no lo promueve a
  `Por despachar`; ese ascenso lo hará la vía autenticada.
- El `anulado` derivado del Excel es de guía, no de venta: un pedido solo pasa a
  `anulado` general cuando **todas** sus guías están anuladas y ninguna activa
  (la operación lo dio por perdido), reversible con un override; nunca anula el
  pedido en Shopify (§3.4, §9.4).
- **Una corrección de registro no cuenta para esa regla.** La salida anulada
  **por la acción «Anular salida»** queda FUERA del reparto: no cierra el pedido
  como anulado ni lo sostiene «en proceso». El §4 ya la define como corregir el
  courier equivocado, no como un hecho logístico, y una caja que nunca salió de
  la empresa no puede ser prueba de que nadie se rindió. Sin esta excepción el
  pedido de una sola salida quedaba anulado al corregirlo —la regla se cumplía
  por vacío— y encima bloqueaba la guía nueva, que era el motivo de la
  corrección. La fila anulada sigue visible en «Salidas y guías» con su
  consecutivo; lo que no hace es decidir el estado. El pedido vuelve a
  `Preparación · Por armar`: el rótulo ya se generó y la caja pudo quedar
  armada, así que retroceder más desharía trabajo físico real.
- **La corrección se PRUEBA por su evento `route_output_cancelled`, que nombra
  la salida; no se deduce de su forma.** Deducirla de «ruta manual + nunca
  despachada + nunca transferida» parece equivalente y no lo es: al finalizar un
  expediente el cierre exige que no queden salidas activas, así que un pedido
  cerrado normalmente termina con esa misma huella. Medido en producción, esa
  forma la cumplían 368 pedidos y solo 2 se habían anulado por el botón; 336 ya
  estaban finalizados. Tratarlos como correcciones habría reabierto expedientes
  cerrados por S/ 56.216. Si la salida llegó a despacharse o a cambiar de
  custodia después, la excepción tampoco aplica aunque exista el evento.
- Debe existir una alternativa manual al escaneo, siempre con actor, fecha y
  motivo registrados.
- Incidencias mínimas: datos incompletos, producto faltante, rótulo incorrecto,
  pedido cancelado durante el armado.
- Si el pedido se cancela mientras se arma, se detiene y pasa a `Por cerrar`
  hasta recuperar el producto o registrar su destino.

Prioridad de almacén observada:

1. Lima.
2. Shalom, Olva y Falabella.
3. Aliclik.

Falabella debe documentarse antes de activar reglas específicas.

### 6.3 Por despachar

El paquete está armado y continúa bajo custodia de la empresa.

Subetapas:

- `listo_para_asignar`.
- `asignado_a_ruta`.
- `en_cotejo`.
- `cotejo_incompleto`.
- `listo_para_recojo`.
- `retirado_del_manifiesto`.

Reglas de manifiesto:

- Existe una agrupación distinta por courier y ruta del día.
- Daysi crea y organiza la ruta.
- El primer escaneo/cotejo lo realiza normalmente Daysi; también pueden hacerlo
  Diana, Yohalis o Yelitza.
- Si falta un pedido, debe retirarse expresamente del manifiesto con motivo,
  actor y hora antes de permitir que continúe la ruta.
- El manifiesto actualizado debe estar al 100 %.
- El motorizado realiza el segundo escaneo al recoger.
- Solo el segundo cotejo completo transfiere la custodia y mueve las salidas a
  `En curso`.
- Enviar una ruta o crear una guía no prueba custodia física.
- Para couriers con API se puede aceptar el evento equivalente de recepción.

Aliclik tiene actualmente un doble cotejo entre Excel y celular. Cuando Kapta
reemplace el Excel, la igualdad será entre salidas esperadas en el manifiesto y
paquetes físicamente escaneados.

### 6.4 En curso

Existe al menos una salida bajo custodia externa, en reparto, disponible para
recojo, por reprogramar o retornando mientras la venta continúa abierta.

Subetapas comunes:

- `recibido_por_courier`.
- `en_transito`.
- `en_destino`.
- `en_reparto`.
- `disponible_para_recojo`.
- `pendiente_pago_diferencia`.
- `por_reprogramar_lima`.
- `gestion_reproprovincia`.
- `salida_swayp_programada`.
- `retorno_solicitado`.
- `en_retorno`.

Resultados normalizados de courier:

- Entregado.
- No contesta.
- Ausente.
- Rechazado.
- Reprogramado.
- Dirección incorrecta.
- Guía cancelada.

`Guía cancelada` nunca equivale a `Pedido Shopify anulado`.

Un resultado fallido regresa a la cola de reprogramación correspondiente. El
pedido solo queda Anulado cuando la anulación existe en Shopify.

### 6.5 Por cerrar

El resultado comercial principal ya está definido, pero existe una obligación
logística, financiera, de devolución, inventario o reclamo.

Motivos simultáneos posibles:

- `pendiente_liquidacion`.
- `liquidacion_observada`.
- `salida_adicional_activa`.
- `devolucion_fisica_pendiente`.
- `devolucion_pendiente_inventario`.
- `recogido_sin_pago_completo` — alerta crítica.
- `indemnizacion_pendiente`.
- `merma_pendiente`.
- `reembolso_pendiente`.
- `devolucion_cliente`.
- `validacion_cierre_pendiente` mientras una fuente todavía no esté integrada.

Un pedido puede tener varios motivos de cierre abiertos. La macroetapa no cambia
a Finalizado hasta que todos estén resueltos.

### 6.6 Finalizado

No quedan tareas comerciales, logísticas, financieras, de devolución,
inventario, indemnización ni reembolso.

Resultados finales visibles:

- Entregado y liquidado.
- Recogido y pagado completamente.
- Anulado sin paquetes pendientes.
- Devuelto y conciliado.
- Entregado con incidencia resuelta.
- Entregado con devolución del cliente resuelta.
- Perdido e indemnizado.
- Merma cerrada.

Solo Frankz y Yohalis pueden reabrir un pedido finalizado. Una reapertura genera
un evento nuevo; nunca elimina el cierre anterior.

## 7. Precedencia para calcular la macroetapa

Orden de evaluación:

1. Reapertura vigente.
2. Obligaciones críticas o de cierre pendientes.
3. Resultado terminal sin obligaciones pendientes.
4. Salida bajo custodia externa o reprogramación activa.
5. Paquete armado bajo custodia de la empresa.
6. Pedido listo para preparar.
7. Confirmación pendiente.

Ejemplos:

| Situación | Macroetapa | Subetapa/motivo |
| --- | --- | --- |
| Lima nuevo, sin guía | Preparación | Por generar rótulo |
| Provincia sin contacto | Por confirmar | Sin llamar |
| Provincia confirmada | Preparación | Por generar rótulo |
| Rótulo generado, paquete no armado | Preparación | Por armar |
| Paquete escaneado | Por despachar | Listo para asignar |
| Manifiesto cotejado por oficina | Por despachar | Listo para recojo |
| Motorizado cotejó y recogió | En curso | Recibido por courier |
| Aliclik retornando y Swayp repartiendo | En curso | En reparto |
| Una salida entregó y otra sigue activa | Por cerrar | Salida adicional activa |
| Entregado, courier aún no liquidó | Por cerrar | Pendiente de liquidación |
| Shopify anulado, paquete aún con courier | Por cerrar | Devolución física pendiente |
| Shopify anulado, nunca se despachó | Finalizado | Anulado cerrado |

### 7.1 La macroetapa es una foto, y hay que revelarla

Esta precedencia no se evalúa al mirar el Master: se evalúa al **recalcular**, y
el resultado se guarda en `order_master`. Lo que la operación ve es la última
foto revelada, no el estado de ahora. Por eso el cajón de un pedido puede
enseñar dos verdades a la vez —«SALIDAS Y GUÍAS» lee las guías en vivo, la
cabecera y la macroetapa leen la foto— y esa contradicción es siempre el mismo
síntoma: **el recálculo no llegó a correr**.

El recálculo es best-effort en casi todos los puntos que lo disparan, y con
razón: una gestión registrada no se pierde porque el Master no se haya podido
refrescar. **Pero best-effort no es sin rastro.** Un `catch` vacío se tragó el
refresco de 42 pedidos de Aurela entregados entre el 19-06 y el 27-07-2026: sus
guías decían «entregado» y su Master seguía en «Por confirmar», así que la cola
de confirmación siguió pidiendo llamar a clientes que ya tenían el paquete en
casa. Dos meses sin que nadie lo viera, porque no había nada que ver.

Reglas que salen de ahí:

- **Un recálculo que no se completa deja constancia**, y en el sitio donde
  alguien vaya a mirar: la fila del lote de importación (`import_batches.errors`)
  cuando lo dispara un reporte, la respuesta del cron cuando lo dispara un cron,
  y los logs de ejecución siempre.
- **Se cuenta lo escrito, no lo pedido.** Informar el tamaño de la lista de
  entrada da la misma cifra tanto si el recálculo funcionó como si se cayó
  entero.
- **Fallar y escribir de menos cuentan igual.** El recálculo puede no lanzar y
  aun así refrescar menos pedidos de los pedidos; para quien mira el Master el
  resultado es idéntico, una fila con el estado viejo.
- Cuando el Master y las guías se contradicen, **la fuente de verdad son las
  guías**: la foto está vieja, no equivocada. Se arregla recalculando
  (`scripts/backfill-mom.ts` es idempotente), nunca editando la foto a mano.

Un estado congelado por un humano (`status_source = 'manual'`) **no** es una foto
vieja: es una decisión, el recálculo no la pisa (§4) y no cuenta como
desperfecto aunque contradiga a las guías.

## 8. Confirmación y riesgo del cliente

Responsables actuales: Milagros, con apoyo de Mildred, Gabriela, Yohalis y
Frankz según la acción.

Antes de llamar se revisan duplicados, conversación, cobertura Aliclik e
historial del cliente.

Riesgo por teléfono y antecedentes de rechazo/devolución:

| Antecedentes | Regla |
| --- | --- |
| 1 | Sugerir adelanto de S/30 |
| 2 | Exigir adelanto de S/30 |
| 3 o más | Exigir pago completo |

Una excepción COD es posible con justificación corta, actor y fecha. Las
promesas de pago incumplidas aumentan el riesgo futuro.

### 8.1 La ficha previa a la llamada

Kapta arma esa revisión y la muestra dentro de la gestión de confirmación, sin
que nadie tenga que resumirla a mano:

- **Historial del cliente**: los otros pedidos del mismo teléfono, desglosados
  por desenlace — entregados, en curso, anulados, devueltos y sin confirmar. El
  teléfono es la identidad del cliente en esta operación: no hay cuenta ni
  documento en un COD de Shopify.
- **El historial se lista pedido a pedido**, no solo como recuento. De cada uno
  se muestra fecha, antigüedad, estado operativo, qué llevaba y si llegó a
  salir. El desglose dice cuántos; la lista dice cuáles, que es de donde sale la
  decisión.
- **Anterior o posterior.** No todos los pedidos del historial son anteriores al
  que se está mirando: un pedido que nadie confirmó acumula por debajo los
  intentos nuevos del mismo cliente. Los posteriores se marcan como tales.
  Llamarlos a todos «anteriores» invierte la lectura del caso — «tres anulados
  previos» es un cliente con mal historial, «tres re-pedidos posteriores» es un
  pedido estancado que el cliente sigue intentando.
- **Si llegó a costar flete.** Un pedido sin guía no lo recogió nadie: se anuló
  antes de despacharse y no gastó flete. Uno con guía salió a la calle. La ficha
  los distingue y muestra courier, guía e intentos de entrega cuando existen.
- **Qué llevaba cada pedido.** Cuando el historial repite el mismo producto y la
  misma cantidad, se marca: eso no es un historial de compras variado, es el
  mismo pedido una y otra vez.
- **Excepción: el cliente sin teléfono.** Desde el 29-jul-2026 Meta empezó a
  entregar conversaciones sin número — el cliente adoptó un *username* de
  WhatsApp y su identidad pasó a ser el **BSUID**. Fueron 0 durante 23 días y
  luego 1, 3, 11, 16, 20, 29 al día (~3,5 % del volumen). Esos leads existen en
  Kapta desde la migración `0105`, identificados por `(store_id, bsuid)`.
  Para la confirmación cambian tres cosas, y conviene tenerlas claras:
  - **No se pueden llamar, y por lo tanto no se confirman por llamada.** La
    acción es escribirles por WhatsApp pidiéndoles el número.
  - **No tienen historial ni antecedentes**, porque el historial se arma por
    teléfono. La regla de riesgo del §8 no se les puede aplicar: no es que den
    riesgo cero, es que **no hay dato**. Tratarlos como clientes limpios sería
    leer un vacío como un aval.
  - **No se les puede crear guía** hasta tener el número: los couriers lo
    exigen. Un pedido suyo no puede pasar de Preparación sin ese dato.
  En cuanto el cliente da su número, el lead vuelve a ser uno normal y todo lo
  anterior aplica sin excepción.
- **Antecedentes**: solo cuentan los **anulados y devueltos**, que es lo que la
  tabla nombra. Un pedido abierto o sin confirmar todavía no es un rechazo. Que
  un anulado se haya despachado o no **no cambia el conteo**: se muestra para
  informar la excepción humana del §8, no para que la herramienta se ablande la
  regla sola.
- **Devoluciones**: hoy Kapta no registra ninguna. `general_status='devuelto'` y
  `returned_at` están vacíos en toda la base, así que el contador «Devueltos» de
  la ficha vale siempre 0 y la mitad «o devolución» de la tabla de riesgo no se
  puede aplicar. Queda pendiente poblar la señal desde la ingesta de courier;
  hasta entonces los antecedentes son, en la práctica, solo anulados.
- **La regla se aplica plana.** Haber recibido antes no la ablanda: la excepción
  del §8 exige justificación, actor y fecha, o sea una decisión humana
  registrada, no un descuento automático. Por eso los entregados se muestran
  bien visibles — son el argumento de quien decida tomar la excepción.
- **Duplicados**: los pedidos del mismo teléfono que siguen **abiertos**. Un
  cliente que ya recibió y vuelve a comprar no es un duplicado, es recurrente.
- **Cobertura COD**: qué couriers tienen tarifa vigente para ese destino, leído
  de la misma matriz que clasifica la cobertura del pedido, así que no puede
  contradecirla. Vacío significa que va por agencia.
- Con `Exigir adelanto` o `Exigir pago completo`, el panel de cobro pasa a ser
  dominante también en Provincia COD. La barrera de pago se aplica al crear una
  salida **Aliclik**, porque es el courier que cobra incluso el intento no
  entregado. Swayp, Lima y los demás motorizados no se bloquean por esta regla:
  el antecedente permanece visible como advertencia, pero pueden salir contra
  entrega. `Sugerir` nunca bloquea.
- La excepción Aliclik requiere una explicación corta y genera un evento
  append-only con actor, fecha, requisito, estado del pago y antecedentes.
- La ficha se lee bajo RLS: el historial de un teléfono nunca cruza a una tienda
  que quien mira no puede ver.

## 9. Lima

- Todos los pedidos entran directamente a Preparación.
- Almacén arma todos los pedidos del turno.
- Seguimiento Lima decide el courier; la asignación automática será inicialmente
  una sugerencia.
- Un no entregado pasa a `Por reprogramar Lima`.
- Seguimiento Lima vuelve a llamar, elige otro courier permitido y solicita un
  nuevo armado si el paquete anterior todavía está con el courier.
- No es obligatorio esperar la devolución anterior para crear otra salida.

Responsable principal: Daysi. Diana apoya rutas y cotejo.

### 9.1 Preparación, corte y capacidad diaria

- Almacén: Yelitza y Matías.
- El corte operativo actual se realiza aproximadamente hasta las 11:00.
- Los pedidos de Lima centro se distribuyen principalmente entre los
  motorizados propios Johnny, Roy y Douglas.
- Axel Courier es operado por Alexis. Daysi llama y confirma aproximadamente
  entre 30 y 40 puntos diarios antes de entregarle la ruta.
- Las entregas de Alexis comienzan normalmente entre 14:00 y 15:00 y continúan
  durante la tarde.
- La preferencia de entrega indicada previamente por el cliente en WhatsApp
  debe formar parte de la sugerencia de ruta.

Los cortes previamente declarados siguen como referencia para automatización:

- Motorizados propios: mismo día hasta 10:30.
- Axel Courier: mismo día hasta 12:00.
- Swayp: rutas enviadas 16:00–17:00 para el día siguiente.
- Tanders: normalmente día siguiente.

La diferencia entre el corte general de almacén (aprox. 11:00) y los cortes de
cada courier debe modelarse como capacidad/horario de ruta, no como un estado
del pedido.

### 9.2 Sugerencia de courier en Lima

La decisión final sigue siendo de Seguimiento Lima. La sugerencia actual parte
de estas reglas observadas por Daysi:

1. Lima centro: Johnny, Roy o Douglas.
2. Cliente que pidió la tarde o puede recibir desde las 14:00: Axel Courier.
3. Distritos del sur, incluidos Punta Hermosa y Pachacámac: priorizar Swayp.
4. Si el cliente no puede recibir en el horario de Axel: Swayp, después Tanders
   y finalmente Urpi, siempre que cobertura, turno y política de repetición lo
   permitan.
5. Urpi tiene dos turnos, mañana y tarde, pero actualmente recibe sobre todo
   pedidos difíciles o sin respuesta. Daysi procura enviarle como máximo tres o
   cuatro pedidos nuevos/confirmados por ruta.

Swayp es el nombre vigente de Fénix. Daysi y otras personas todavía lo llaman
Fénix. `Thunder` y `Tander` en la entrevista se normalizan como **Tanders**.

Estas prioridades son parámetros operativos, no reglas rígidas: el sistema debe
mostrar la razón de la sugerencia y permitir que Daysi elija otra ruta válida.

### 9.3 Resultado fallido y nueva salida

- Se revisa primero por qué no fue entregado: horario, ausencia, falta de
  respuesta, producto/color equivocado, rechazo u otro motivo.
- Si el problema puede resolverse el mismo día y el motorizado conserva el
  paquete, puede reintentarlo con la misma salida.
- Si cambia el producto, courier o día de salida, se crea una salida nueva con
  QR nuevo. Almacén reimprime, arma otra caja y la coloca en la agrupación del
  nuevo courier.
- La nueva salida no debe borrar ni cerrar automáticamente la devolución física
  de la salida anterior.
- El equipo revisa el courier anterior y el motivo antes de elegir el siguiente.
  Se mantiene la política aprobada por Frankz: Axel y motorizados propios pueden
  repetirse; Swayp, Urpi y Tanders solo una vez por pedido en Lima, dentro del
  máximo global de cinco salidas.

La entrevista menciona como posibilidad volver a enviar por Swayp. Esto queda
registrado como discrepancia operativa, pero no modifica la política del owner
hasta que Frankz la cambie expresamente.

### 9.4 Reportes, pagos y devoluciones físicas de Lima

| Operador | Fuente del resultado | Momento observado |
| --- | --- | --- |
| Johnny, Roy y Douglas | WhatsApp; `entregado` o `entregado en efectivo`, más evidencia para Yape, Plin, link o POS | Durante/final de ruta |
| Axel Courier | Cuadro de entregados y devueltos; devolución física normalmente al día siguiente | Día siguiente |
| Swayp | Excel/plataforma en tiempo real | Durante la ruta |
| Urpi | Plataforma en tiempo real | Durante la ruta |
| Tanders | Incidencias por WhatsApp y cierre completo de ruta por la noche | Cotejo al día siguiente |

Estados externos observados: entregado, no responde, rechazado, reprogramado y
anulado/cancelado por el courier. Un `anulado` en el reporte del courier no
anula el pedido Shopify; solo la anulación explícita en Shopify cierra la venta.

Tanders tiene API propia y Kapta relee el estado de cada guía viva desde ella,
sin tope de antigüedad. Reglas:

- El vocabulario de estados de Tanders **no está documentado por ellos**. Se
  traduce solo lo confirmado; un estado que no reconocemos se guarda literal en
  `reported_status` y **no toca la guía**. No se inventan equivalencias.
- `DELIVERED` acredita que el paquete salió de la empresa —custodia del
  courier—, no que el dinero esté cobrado. La guía pasa a `entregado` solo con
  la constancia de pago validada, porque en Tanders cobra el motorizado y el
  cliente deposita directamente (§14).
- La custodia solo avanza: un reporte atrasado no devuelve a la empresa un
  paquete que ya se llevó el motorizado.
- El WhatsApp y el cierre de ruta de la noche siguen siendo la fuente para las
  incidencias; la API cubre el estado de la guía, que antes se congelaba en el
  valor del momento de creación y dejaba cajas detenidas en `Por armar`.

Devoluciones físicas:

- Motorizados propios: el saldo no entregado se coteja físicamente al día
  siguiente, pedido por pedido.
- Axel: Daysi o Diana fotografía y coteja los paquetes devueltos y la fecha.
- Swayp y Urpi: el recojo de devoluciones ocurre actualmente cada semana o cada
  quince días; cada salida debe permanecer abierta hasta recibir su caja.
- Si ya existe otra caja armada para el mismo pedido, la devolución anterior se
  identifica por su salida/QR; nunca se concilia solo por número de pedido.
- Los pedidos que el cliente rechazó definitivamente y que fueron anulados en
  Shopify no se vuelven a armar.

Cobros y liquidación observados:

- Motorizados propios reportan el medio de pago. Efectivo queda en liquidación;
  Yape, Plin, link o POS requieren evidencia del ingreso directo.
- Swayp y Urpi cobran al cliente y posteriormente liquidan a la empresa.
- Tanders puede usar la cuenta de Grupo GF para que el dinero ingrese
  directamente; Daysi coteja los entregados contra los pagos visibles.
- Daysi realiza hoy parte de estos cotejos semanalmente por capacidad. Los SLA
  financieros definidos en la sección de Liquidaciones no cambian: el sistema
  debe separar `resultado reportado`, `pago verificado` y `lote conciliado`.

## 10. Provincia COD y Aliclik

- Aliclik es la primera recomendación.
- La confirmación expresa la registra el asesor; generar el rótulo también se
  considera señal de confirmación.
- Estados externos de Aliclik se conservan literalmente y se normalizan sin
  perder el original.

Cómo se clasifica una guía que llega por reporte Excel:

- La clasificación es **por resultado para la clienta**: solo `ESTADO ENTREGA =
  ENTREGADO` cierra como entregada, y todo lo demás entra a la cola de gestión
  como pendiente. El estado de despacho no decide si una guía está en ruta.
- **Única excepción: la devolución consumada.** `ESTADO DESPACHO = DEVUELTO`
  (o `ÚLTIMO ESTADO DESPACHO = RETURNED`) sella la devolución. Se lee del
  despacho porque no aparece en ninguna otra columna: el `ESTADO ENTREGA` de
  una guía devuelta dice CANCELADO, NO CONTESTA o RECHAZADO, que es el
  **motivo**, no el desenlace.
- ENTREGADO gana sobre el despacho, y el orden importa: una guía entregada
  arrastra valores heredados de intentos previos en las columnas de despacho.
- **`DEJADO EN ALMACÉN` / `LEFT_IN_WAREHOUSE` también sella la devolución, pero
  solo si hubo intento de entrega.** Aliclik usa esa misma etiqueta para dos
  momentos opuestos del ciclo: el paquete que todavía no ha salido, y el que ya
  volvió. Lo que los separa es el `ESTADO ENTREGA`: con un **resultado**
  —CANCELADO, ANULADO, RECHAZADO, NO CONTESTA, REPROGRAMADO— el paquete salió y
  regresó; con `POR ENTREGAR`, o sin dato, nunca se movió y sigue siendo
  `pendiente`.

  Es el desenlace con el que Aliclik reporta de verdad la mayoría de las
  devoluciones — más que `DEVUELTO`. Leerlo solo como «aún no ha salido» dejaba
  la cola de §11.1 vacía mientras las cajas estaban físicamente en el almacén.

  La exigencia del intento no es un detalle: sin ella se le pediría un adelanto
  de S/30 a una clienta cuyo paquete jamás salió. El lado barato del error está
  en exigirlo — como mucho se pierde una recuperación dudosa.
- `POR DEVOLVER` / `TO_RETURN` **no** es una devolución: el paquete sigue
  viajando de vuelta y la guía sigue viva, así que se sigue consultando. Pero
  tampoco está por armar: **su estado de guía es `en_ruta`** (§6.2), porque ya
  salió del almacén. En `pendiente` el Master lo dibujaría en
  `Preparación · Por armar`, que es exactamente lo que no es.
- La guía devuelta se cierra como `anulado` —el vocabulario de guías no tiene
  código `devuelto`— y es `returned_at` lo que convierte el **pedido** en
  `devuelto`.
- Si Aliclik no entrega, el pedido puede ingresar a Reproprovincia.
- Solo Aliclik tiene proceso de indemnización formal.

### 10.1 Qué fuente manda: la API sobre el Excel

El estado de una guía Aliclik llega por dos vías, y **no valen lo mismo**:

| | API (`/integration/order`) | Reporte Excel |
| --- | --- | --- |
| Cómo llega | barrido automático cada 20 min | alguien lo exporta y lo sube |
| Antigüedad | el estado de ahora, con `updatedAt` | la del momento en que se exportó |
| Consistencia | una respuesta por guía | repite la guía por ítem, con filas que se contradicen |

**Regla: mientras la última lectura de la API siga fresca, el reporte importado
no cambia `delivery_status`.** El Excel sigue actualizando todo lo demás —
dirección, producto, intentos, importe a cobrar—; lo único que cede es el estado
de entrega.

Por qué hizo falta: la precedencia monotónica sola no alcanzaba. Como `anulado`
tiene rango 3 y `en_ruta` rango 2, un Excel exportado días antes **cerraba** una
guía que la API acababa de reportar viva. El estado no retrocedía, pero avanzaba
al lugar equivocado — y un terminal no se reabre.

**La propiedad caduca** (`API_OWNERSHIP_DAYS`, hoy 7 días). Si la API dejara de
conocer una guía —Aliclik la saca de su retención, o deja de responder— una
propiedad perpetua la congelaría sin forma de corregirla. Pasada la ventana, el
Excel vuelve a ser autoridad bajo la precedencia de siempre. Con el barrido cada
20 minutos, una guía que la API sigue viendo nunca se acerca a ese límite.

La marca vive en `shipments.api_report_at`, que **solo** escribe la vía API.
`last_report_at` no sirve para esto: lo escriben las dos vías, así que no permite
saber quién habló último.

**La guarda monotónica del barrido tiene el mismo problema, y por eso también
tiene su propia marca** (`api_updated_at`, 0117). El barrido descarta un snapshot
de Aliclik más viejo que el último que aplicó; para saberlo compara el `updatedAt`
de la API contra esa marca, **nunca** contra `last_report_at`. Son dos relojes
distintos: `updatedAt` dice cuándo se movió el pedido en Aliclik y
`last_report_at` cuándo miramos nosotros —y el Excel lo pone en la hora de la
subida—. Compararlos entre sí hacía que cada reporte importado dejara la marca en
«ahora» para todas las guías del archivo y, desde ese instante, el barrido las
diera por rezagadas y no volviera a tocarlas hasta que Aliclik moviera el pedido:
la vía automática se apagaba justo sobre las guías que más se miran. Sin marca
previa no hay guarda —una guía nunca leída por la API se aplica y queda sellada
para la próxima—, así que la columna no necesita backfill.

Alcance de la API: empareja por `external_order_number` y, si no lo hay, por
`guide_code`.

> ⚠️ **La segunda vía no funciona, y esto cambia el alcance real de esta
> sección.** Se escribió asumiendo que el `orderNumber` de la API es el mismo
> código AUR5X… del reporte. Medido contra producción el 2026-08-09: de **632**
> guías actualizadas por API alguna vez, **632 tenían `external_order_number`**
> —las creadas por nosotros— y **ninguna** se emparejó solo por `guide_code`.
> Sobre 876 guías perseguibles que únicamente tienen código de Excel, la cifra
> es cero.
>
> El barrido sí las consulta: entran al pool, se pregunta por ellas y Aliclik
> responde que no las conoce. Como una respuesta vacía **no escribe nada** —y no
> debe hacerlo: cerrar una guía porque una búsqueda vino vacía sería inventar un
> desenlace—, el fallo no deja rastro. Por eso pasó desapercibido.
>
> Consecuencia: **para una guía nacida del Excel, el Excel es la única fuente**.
> La regla «la API manda» de arriba solo rige sobre las guías que creamos
> nosotros por API. Para el resto, esta sección describe una intención, no lo
> que ocurre.
>
> Qué haría falta, y es conversación con Aliclik, no código nuestro: que el
> reporte traiga una columna con el `orderNumber` (`ALC…`). Con eso cada fila
> importada quedaría enlazada a la API para siempre y el punto ciego
> desaparecería entero. La alternativa —un endpoint que acepte el código impreso
> en el paquete— es la que el equipo usa físicamente, pero hoy no existe.

Seguimiento de una guía hasta que cierra:

- Una guía se sigue consultando **mientras siga viva**, sin importar su edad. El
  criterio es el estado, no la fecha de creación: el barrido periódico relee una
  ventana reciente y además persigue de una en una a las guías vivas que esa
  ventana ya no alcanza.
- **Una guía anulada se sigue mirando tres semanas más.** No es viva, pero
  tampoco ha terminado: se anula cuando la clienta cancela o se agotan los
  intentos, y el paquete vuelve **después**. Dejar de mirarla al anularla era
  perderse el retorno, que es justo lo que abre §11.1. Pasadas las tres semanas
  ya no va a volver y se deja de preguntar. `entregado` y `transferido` sí
  cierran: una entregada terminó, y una transferida vive en otra guía.
- Existe porque la **devolución** es el tramo más lento: un paquete rechazado
  tarda semanas en volver al origen, mucho más que la ventana del barrido. Si el
  seguimiento se anclara a la fecha, el `RETURNED` de Aliclik llegaría cuando ya
  nadie pregunta y la devolución —que es entrada elegible a Reproprovincia
  (§11)— no se registraría nunca.
- Se deja de preguntar cuando la guía termina (entregada, anulada o
  transferida) o tras **60 días sin noticias**. Ese silencio no cierra la guía:
  solo detiene la consulta.
- **La cola se ordena por a quién hace más que no se le pregunta**, no por quién
  lleva más callada. Parece lo mismo y no lo es: preguntar por una guía parada
  devuelve un estado que la guarda monotónica descarta sin escribir, así que su
  silencio no se acorta y volvía a encabezar la cola en la pasada siguiente,
  para siempre. Con un tope de consultas por pasada, las de cabeza se repetían y
  las del fondo no llegaban a tener turno. Lo que ordena es el turno —que
  siempre avanza porque se sella al preguntar, responda Aliclik lo que responda—
  y, entre iguales, la más callada primero.
- El seguimiento alcanza **también a las guías nacidas del Excel**: pregunta por
  `external_order_number` si lo hay y por `guide_code` si no. Son el mismo
  identificador por dos vías, así que limitarlo al primero dejaría fuera a la
  mayoría de las guías — justo las que se congelan cuando nadie sube un reporte.
- Una guía que Aliclik ya no reconoce **no se cierra**: se cuenta aparte para
  revisión humana. Dar por terminada una guía porque una búsqueda vino vacía
  sería inventar un desenlace.

**Cuando el reporte trae el código definitivo de una guía nuestra.** Una guía
creada por API nace con un código provisional (`ALC…`) y el reporte la trae
después con el impreso (`AUR5X…`). Que son la misma guía se reconoce por, en este
orden: el `orderNumber` si el reporte lo trae, el pedido ya vinculado, nombre de
pedido **y** teléfono juntos, y —último— solo el teléfono.

El teléfono a secas existe para la guía que **todavía no tiene pedido**: ahí no
hay nada más con qué reconocerla. No sirve para ganarle a un nombre que ya está
escrito y dice otra cosa. Cuando la fila nombra un pedido y el candidato lleva
otro, eso no es falta de evidencia sino evidencia **en contra**, y no se
promueve. Perder la promoción no cuesta nada —la guía se ingesta por Excel como
cualquier otra—; acertarle al pedido equivocado sí.

Esta retención es preventiva: a 11-08-2026 **ninguna guía se ha promovido nunca**
en producción, así que el camino existe pero no se ha usado. No confundirla con
el emparejamiento del importador, que sí falló y se trata justo debajo.

#### El código impreso nombra a su pedido, y manda sobre el teléfono

Al quitar el prefijo `AUR5X` quedan tres familias de código, y medidas sobre las
3.976 guías con pedido (11-08-2026) se comportan de forma tajante:

| dígitos | guías | terminan en el nº de su pedido |
| --- | --- | --- |
| 12 | 2.841 | 0 |
| 7 | 12 | 0 |
| 6 | 1.179 | 1.162 (98,6%) |

Las de doce y siete son identificadores de Aliclik. **La de seis es el número del
pedido**, tecleado por quien creó la guía en el portal. Por eso solo esa se lee
como referencia: en las otras dos, leer un pedido ahí dentro sería leer ruido.

**Regla: si el código nombra un pedido, la guía no admite otro.** Los demás
candidatos se descartan antes de emparejar, y si el nombrado no está entre ellos
la fila va a revisión.

Lo que evita es un error que el teléfono solo no puede ver. El emparejamiento por
teléfono exige un único pedido con ese número, y lee ese «uno» como *solo hay
uno* cuando significa *solo he ingerido uno*: el pedido bueno puede no haber
llegado aún desde Shopify. Ocurrió **17 veces entre el 01-07 y el 23-07-2026**,
todas con el mismo perfil —la guía se importó antes que su pedido, el teléfono
señalaba a un pedido anterior del mismo cliente, y los 17 dueños reales entraron
en la carga del 26-07—. Nadie volvió a mirar aquellos enlaces, así que 17 pedidos
cargan el desenlace de un paquete ajeno y otros 17 figuran sin salida.

El teléfono es la identidad del cliente (§8), no la del pedido, y un cliente que
vuelve a comprar tiene dos. Por eso no basta para elegir entre ellos.

> ⚠️ **Frágil a propósito, y hay que vigilarlo**: la regla distingue las familias
> por longitud, y hoy los pedidos de la operación son de seis dígitos
> (106620–127540). El día que lleguen al millón, siete dígitos dejarán de ser
> «identificador de Aliclik» y habrá que revisar esto.

#### Vincular una guía creada en el portal de Aliclik

La API oficial solo lista los pedidos de la integración (`ALC…`). Una guía creada
a mano en la web de Aliclik no aparece ahí, así que al vincularla **no hay nada
que consultar**: hay que decidir con lo que se tiene.

**Lo que autoriza el vínculo es la confirmación auditada** —escribir el código
del pedido y dejar un motivo— más la comprobación de que la guía no cuelgue ya de
otro pedido. Que el código impreso lleve dentro el número del pedido **corrobora,
no autoriza**: solo lo cumple la familia de seis dígitos (§10.1), así que
exigirlo dejaba sin vincular guías reales. Ocurrió con `AUR5X7478480` y
`#KP128572` el 17-08-2026: la operación había creado la guía en el portal para no
quedarse parada, y el Master no admitía registrarla.

`shipments.match_method` distingue las dos: `portal_code_suffix` cuando el código
nombra al pedido y `portal_operator_attested` cuando lo único que hay es la firma
de quien lo afirmó. Un solo valor para ambas borraría esa diferencia justo en la
columna que se mira para auditar cómo llegó una guía a su pedido.

#### Preguntar si Aliclik llega, aunque el pedido sea de Agencia

**La clasificación decide a dónde va el paquete, no si podemos preguntar.**
Cotizar es una lectura: no crea guía, no reserva stock, no cuesta nada. Mientras
la pregunta estuvo detrás de la respuesta —el bloque de Aliclik no se dibujaba
para un pedido de Agencia, y la acción de cotizar exigía el permiso de crear—,
una clasificación equivocada no se podía desmentir nunca. Es lo que pasó con
Pisac: la operación sabía que Aliclik cubre y el pedido no ofrecía ni el botón.

Hoy el bloque de Agencia deja cotizar. **Escribir sigue cerrado**: crear y
vincular siguen rechazando un pedido de Agencia, así que lo peor que puede pasar
al preguntar es enterarse de un precio.

Si Aliclik cotiza, se ofrece marcar el distrito como Provincia COD, y eso escribe
la excepción de §19.0.1 con la nota rellenada —precio, pedido y fecha— y
recalcula los pedidos abiertos de ese distrito. **La generalización la firma una persona**:
la cotización es por coordenada y la cobertura es por distrito, así que llegar a
un punto de Pisac no prueba que se llegue a todo Pisac. Se automatiza el trabajo,
no la decisión. Y marcar un distrito exige ser administrador, como en Ajustes:
cambia el despacho de todos sus pedidos, no el de este.

### 10.2 Crear una guía en Aliclik: el candado y su caducidad

Crear un pedido en Aliclik es una escritura hacia afuera, irreversible, con
ventanas de cancelación estrictas, y su API **no tiene idempotency key**. Por eso
la intención de creación se registra **antes** de llamar a Aliclik y actúa de
candado.

- **Un pedido no admite dos intenciones vivas.** Un doble clic, dos operadoras
  sobre el mismo pedido o un reintento chocan contra el candado en lugar de
  convertirse en dos guías reales.
- **Un timeout no es un rechazo.** Aliclik pudo haber creado el pedido y
  habérsenos perdido la respuesta. La intención queda a la espera y **sigue
  bloqueando** el reintento: reintentar a ciegas es lo que crea el duplicado.

El barrido periódico resuelve esa espera, y tiene que cerrar **las dos** ramas
posibles:

- **Aliclik sí lo creó** → se busca el pedido huérfano por la marca que se
  estampa en la nota (identidad, no parecido), se registra la guía y la intención
  se cierra como completada.
- **Aliclik nunca lo creó** → no hay huérfano que encontrar. Tras **90 minutos**
  de barridos sin dar con él, la intención **caduca**: se cierra como fallida con
  el motivo escrito y el pedido vuelve a admitir un intento.

Sin esa caducidad el candado no tenía salida: la intención quedaba viva para
siempre y el pedido inoperable hasta que alguien lo desbloqueara a mano. Ocurrió
el 08-08-2026 con dos pedidos, durante una caída de la API de Aliclik.

**Barrer y cerrar son dos trabajos, y corren por separado.** Recorrer el listado
por fechas es lo largo; caducar candados y perseguir rezagadas es lo corto y lo
urgente. Mientras compartieron invocación, lo corto dependía de que lo largo
terminase a tiempo — y dejó de terminar: el recorrido creció hasta agotar el
límite de ejecución y el 10-08-2026 las nueve pasadas de tres horas seguidas
murieron dentro del bucle. El barrido parecía sano porque aplicaba estados antes
de morir, pero **nada de lo que iba después llegó a ejecutarse nunca**. Un
candado duró más de diez horas y 515 guías vivas acumularon una media de 8 días
sin noticias. Hoy el cierre tiene su propio cron y su propio presupuesto.

Separarlos obliga a que la prueba de haber buscado **sobreviva a la invocación
que la produjo**: el barrido deja constancia de sí mismo —cuándo empezó, cuándo
terminó y qué ventana cubrió— y el cierre la lee. Ninguna de las retenciones de
abajo se aflojó al mudarse; lo único que cambió es de dónde sale la evidencia.

**Cuándo NO se caduca**, porque liberar de más cuesta una guía duplicada —dinero
real y ventana de cancelación corta— mientras que liberar de menos solo cuesta
esperar:

- **Si no consta un barrido completo y reciente, no se caduca nada.** «Buscamos y
  no está» no es «no pudimos buscar», y es justo durante una caída de Aliclik
  cuando las dos se confunden: sin esta condición, la misma caída que provoca los
  timeouts liberaría los candados que protegen de ellos. Que la constancia además
  **caduque** —dos horas, unas seis pasadas— evita lo contrario: dar por buena
  para siempre la última búsqueda que salió bien.
- **Si el barrido arrancó antes de que naciera la intención, tampoco.** Pudo
  pasar de largo por la zona del listado donde estaría el pedido, así que no
  haberlo visto no dice nada de él.
- **Si la ausencia quedó en duda, tampoco.** Una intención cuyo teléfono señalaba
  a varios pedidos abiertos a la vez queda para revisión humana. La duda se
  anota en la propia intención y vale para el barrido que la vio: si el siguiente
  barrido completo no la vuelve a marcar, la intención vuelve a ser caducable.
- **Si la fecha de creación cayó fuera de la ventana del barrido**, la intención
  caduca igual —lleva demasiado bloqueando—, pero el motivo registra que la
  ausencia **no** pudo comprobarse, y se cuenta aparte. Antes de reintentar hay
  que mirar el panel de Aliclik.

El motivo de la caducidad **se añade** al fallo original en vez de sustituirlo:
el timeout es la mitad del diagnóstico y esa fila es lo que se le presenta al
soporte de Aliclik cuando hay que reclamar.

Lo que se le dice a la operadora tiene que distinguir los casos: una guía ya
creada se identifica por su número, y una intención a la espera indica que no
reintente y **cuándo** se libera sola. Un mensaje único para todos los casos
—«ya hay una creación en curso o completada»— era falso justo en el caso que
importa y no ofrecía salida.

**El semáforo cubre los dos caminos.** Cotizar y crear son endpoints distintos y
se caen por separado: el 10-08-2026 se crearon 15 guías sin un fallo hasta las
10:44 y a las 11:19 la creación empezó a irse en timeout mientras el sondeo de
cotización seguía verde. Un solo foco para ambos miente justo cuando más caro
sale, porque invita a pulsar el botón que deja el pedido bloqueado.

- **Cotizar se sondea**; es una lectura y no cuesta nada repetirla.
- **Crear NO se sondea.** Es una escritura irreversible con dinero real: no hay
  forma de probarlo sin crear una guía de verdad. Su salud se **deduce** de los
  intentos que la operación ya hizo.
- Se avisa con **dos fallos seguidos** y ningún éxito posterior, dentro de una
  ventana reciente. Uno solo no basta —pasa con la API sana— y encender el foco
  por él enseñaría a ignorarlo. El aviso se apaga en cuanto una creación vuelve
  a funcionar.
- El aviso nombra la **consecuencia**, no el síntoma: lo que la operadora
  necesita saber no es que falla, sino que cada intento le bloquea el pedido.

Indemnización Aliclik:

- Responsable: Yohalis.
- Evidencias: fotografías y valor del producto.
- SLA interno propuesto: máximo al día siguiente de detectar/recibir evidencia.

## 11. Reproprovincia y Swayp

Responsables: Akemi y Mariannys. Akemi es la jefa de Mariannys.

Entrada elegible desde Aliclik: no contesta, intento fallido, rechazo sujeto a
revisión, guía cancelada por courier y devolución.

Antes de enviar:

- Revisar el motivo anterior.
- Si el cliente vio el producto y aun así lo rechazó, normalmente no reenviar.
- Revisar duplicados del mismo producto por teléfono.
- Volver a confirmar producto, cantidad, precio, fecha y rango horario.
- Verificar cobertura y stock físico local.

Gestión de contacto: hasta tres llamadas diarias durante siete días. Los siete
intentos se cuentan por día, no por llamada.

### 11.1 Recuperación del pedido devuelto

La devolución es entrada elegible a Reproprovincia, pero esa puerta solo se abre
si alguien vuelve a escribirle a la clienta. El primer contacto se automatiza:
una **plantilla aprobada por Meta** —una devolución tarda semanas, así que la
ventana de 24 h de WhatsApp lleva mucho tiempo cerrada y fuera de ella no entra
un mensaje libre—.

Lo que propone el mensaje **no es repetir el contraentrega**: eso apuesta el
flete otra vez a la misma clienta que ya no respondió. Propone **reenviar por
agencia con adelanto** (§12). Si acepta, no hay flete en riesgo; si no contesta,
no costó nada.

**De qué depende que la cola vea una devolución.** `returned_at` se sella cuando
una fuente reporta el retorno. Para las guías nacidas del Excel —la mayoría— esa
fuente es **únicamente el reporte de Aliclik**, porque la API no las reconoce
(§10.1). Y ese reporte **pierde filas**: una guía cerrada deja de exportarse, así
que puede volver físicamente al almacén sin que ninguna vía lo cuente.

El síntoma es una caja en la mano que no aparece en esta pantalla. Comprobado el
2026-08-09 con siete devoluciones recibidas: **ninguna** figuraba en la cola, y
las siete llevaban entre 8 y 15 días sin noticias, congeladas en el estado
anterior al retorno.

Mientras Aliclik no dé una vía por guía impresa, **subir el reporte es parte de
la operación de recuperar**, no una tarea administrativa: si no se sube, la cola
se queda vacía y parece que no hubo devoluciones.

**Toda devolución se registra con su procedencia** (`returned_source`, 0118). El
sello lo pueden poner tres manos —la API de Aliclik, su reporte en Excel, o una
persona recibiendo el paquete en el almacén— y hasta 0118 las tres se veían
iguales en pantalla: una guía sellada a mano figuraba como «devuelta» sin nada
que la distinguiera de una con constancia del courier. Sobre este dato se manda
un mensaje que **pide un adelanto**, así que la cola marca «sellada a mano»
cuando no hay reporte detrás.

Marcar **no es excluir**: una devolución sellada a mano entra a la cola como
cualquier otra. El paquete sobre la mesa es un hecho tan real como una fila de un
CSV, y son justamente los casos que Aliclik no reporta —los que obligan a sellar
a mano— los que más falta hacen en esta pantalla. Lo que cambia es que quien
decide lo ve antes de pulsar.

La procedencia **se sella junto a la fecha y no se pisa**, igual que la fecha: un
reporte posterior del courier no convierte en «reporte de Aliclik» una devolución
que recibió una persona. Cuando el sello es manual se guarda además **quién**
(`returned_by`), como ya se hace con el alistamiento y la transferencia de
custodia (§8). La regla vive en un solo sitio (`sealReturn`) y la aplican las
tres vías de escritura; con la pasada de motivo de abajo dejó de ser una
precaución teórica, porque esa pasada consulta la API **justo por las guías ya
devueltas** y sin la guarda las habría reetiquetado a todas en la primera vuelta.

Qué guía entra:

- Devolución **consumada** (`returned_at` sellado), no `POR DEVOLVER` (§10).
- Courier de **contraentrega de provincia**. Una devolución de agencia ya se
  pagó por adelantado —no hay adelanto que proponer— y una de Lima se gestiona
  el mismo día por teléfono.
- **Quien rechazó el producto teniéndolo delante queda fuera**, por la regla de
  arriba. Es la exclusión que más importa: el mensaje pide plata por adelantado,
  y pedírsela a quien dijo que no en la puerta invita al reporte por spam — y un
  reporte le cuesta la plantilla a **toda la tienda**, no solo a ese chat. El
  motivo se lee del reporte del courier y también del texto libre de quien
  gestionó, donde aparece conjugado.
- **Sin motivo del courier, la exclusión de arriba no se aplica: no hay con qué
  aplicarla.** Y eso no es un detalle de borde, es la mayoría de la cola. De las
  130 devoluciones candidatas de los últimos 30 días (medido el 2026-08-10),
  **100 no traen motivo alguno** — guías `anulado` importadas del Excel del 20-07
  que nunca pasaron por la API. La regla se estaba aplicando de verdad a 27 de
  127: las otras 100 pasaban por **ausencia de dato**, no por constancia de que
  la clienta nunca viera el producto.

  Ausencia de motivo **no equivale a recuperable**. Un `false` de la exclusión
  significa «no consta que lo rechazara», no «consta que no lo rechazó», y la
  diferencia se paga en la moneda del párrafo anterior. Por eso:

  1. La cola **lo escribe**: donde no hay motivo dice «sin motivo del courier ·
     no consta si la rechazó en la puerta», y el confirmar del envío lo repite.
     Un guion se lee «no hay nada que decir»; lo que pasa es otra cosa.
  2. El cron **sale a buscarlo**. Una tercera pasada del cron de cierre
     (`/api/cron/aliclik-close`, `fillReturnReasons`) consulta a Aliclik por las
     devoluciones sin motivo dentro de la ventana de recuperación. Va ahí y no
     en el barrido por dos razones: es donde ya vive la persecución de guías una
     a una, y es la que tiene presupuesto propio (§10.2) — colgada del final del
     barrido correría el mismo riesgo de no ejecutarse nunca. Con lo que le
     sobre del reloj, además: persigue un dato que ya llegó tarde, mientras la
     de rezagadas persigue estados que aún se pueden mover.

     Las otras dos pasadas no las alcanzaban: la de fechas se les cayó del rango
     y la de rezagadas le da a una anulada tres semanas de silencio. Se anota en
     `reason_probed_at` haya o no respuesta, que es lo único que evita
     repreguntar en bucle por un dato que Aliclik quizá no tenga.

  **No excluye.** Sacar de la cola a las 100 sería tratar la falta de dato como
  si fuera un rechazo, el mismo error que se está corrigiendo, y en la dirección
  que además vacía la pantalla. Se marca y se busca; quien decide, decide viendo
  lo que no se sabe.
- Con nombre, producto y número de WhatsApp peruano válido: un parámetro vacío
  lo rechaza Meta, y un «¡Hola !» quema el mensaje.
- Devuelta hace poco. Una devolución de hace meses ya se reingresó o se dio de
  baja, y la clienta no recuerda el pedido: el mensaje llega como spam de un
  desconocido.

Cómo se envía:

- **Dos interruptores por tienda, no uno.** El primero habilita la cola y el
  botón; el segundo deja que el envío salga solo. Están separados porque el
  mensaje pide dinero por adelantado: el primer lote de cada tienda se mira
  antes de soltarlo, y apagar el automático sin cerrar la cola es la marcha
  atrás que se querría tener a mano.
- La plantilla y el **orden de sus parámetros se configuran por tienda**. Cada
  tienda es una WABA distinta con su propia aprobación, así que el cuerpo no es
  el mismo y compilar el orden obligaría a un despliegue por cada palabra que
  Meta apruebe distinto.
- **El número desde el que sale también se configura**, y es el único envío del
  que se puede decir eso. El drip y los carritos salen del número por el que
  escribió la clienta; lo demás, del número de la tienda. Este puede apuntar a
  una **línea aparte** porque es el que pide dinero por adelantado: si acumula
  reportes, la calidad cae en la WABA de esa línea y no en la que sostiene el
  drip, los carritos y las confirmaciones.
  Aislarlo solo es sano con **dos condiciones**, y las dos son de operación, no
  de software: la plantilla tiene que estar aprobada en la WABA de ese número, y
  esa línea tiene que **atender la respuesta** —la clienta acepta y alguien debe
  mandarle el número de cuenta—. Un número que dispara y no escucha corta el
  circuito justo donde empezaba a valer la pena. Sin configurar, sale del número
  de la tienda.
- Horario local y tope por corrida, como el resto de automatizaciones de
  WhatsApp.
- **Un envío rechazado no marca la guía**: vuelve a la cola y el motivo queda
  registrado. Al revés que el drip, que quema el toque aunque falle — allá el
  riesgo es martillar un número cada cinco minutos; acá la cola es corta y
  perder la única oportunidad de recuperar la venta por un error transitorio es
  el peor desenlace.
- Escribirle a la clienta es **permiso propio** (`recovery.contact`), no
  `master.edit`: es una escritura hacia afuera que no se puede retirar.

Dónde termina: **en el primer mensaje**. La respuesta la atiende el bot de
WhatsApp, que es quien manda el número de cuenta cuando la clienta acepta —
Kapta no envía datos bancarios—. De ahí en adelante el circuito de adelanto,
comprobante y clave de recojo (§12) ya existe y no cambia.

Ciudades con stock/operación conocidas: Arequipa, Huancayo, Juliaca/Puno,
Cusco, Trujillo, Ica, Piura, Chimbote, Chiclayo.

Estar en la lista habilita la ciudad para cargarle stock; **no** la vuelve
elegible por sí sola. La elegibilidad exige cobertura **y** stock del producto
en esa ciudad, así que una ciudad recién agregada queda en `sin_stock` —no en
`sin_cobertura`— hasta que alguien cargue existencias. Nada se reencamina solo
por aparecer acá.

Las nueve ciudades están registradas con el padrón INEI completo de su
provincia: Ica (14 distritos), Piura (10), Santa/Chimbote (9) y Chiclayo (20)
se sumaron a las seis anteriores. Swayp identifica el destino por ubigeo y la
creación de guía **exige** distrito exacto, así que un distrito que no esté en
la tabla se rechaza con mensaje explícito en vez de salir con un código
aproximado: un ubigeo equivocado desvía el paquete sin avisar.

Los códigos son INEI, nunca RENIEC — numeran distinto los mismos distritos.

Falta la configuración de bodega Swayp (`senders`) de las cuatro ciudades
nuevas; sin ella la guía se niega aunque el ubigeo resuelva. Es configuración
operativa, no código.

Una salida Swayp puede coexistir con la devolución Aliclik. En Reproprovincia
Swayp se puede repetir, siempre con una salida, guía y QR nuevos, dentro del
máximo global.

Stock objetivo:

```text
stock disponible = stock físico - stock reservado
```

Propuesta para implementación:

- Crear salida Swayp: reservar.
- Entregado: descontar definitivamente.
- Guía cancelada o reserva liberada: devolver a disponible.
- Pérdida/merma: descontar con evento.

El proceso actual descuenta al entregar; la reserva debe validarse con Akemi y
Frankz antes de activarse.

Horarios Swayp documentados:

- Lunes a sábado.
- Arequipa, 09:00–13:00: Cayma, Cerro Colorado, Tiabaya, Socabaya, Characato,
  Sabandía, Sachaca y Jacobo Hunter.
- Arequipa, 09:00–18:00, excepto sábados: Cercado, Yanahuara, José Luis
  Bustamante y Rivero, Alto Selva Alegre, Miraflores, Mariano Melgar y Paucarpata.
- Huancayo: 09:00–18:00.
- Cusco, Wanchaq y Santiago: 09:00–16:00.
- San Sebastián y San Jerónimo: 10:00–13:00.
- Trujillo: 09:00–17:00.
- Juliaca: 09:00–16:00.

## 12. Agencia: Shalom y Olva

### Shalom

- Adelanto mínimo: S/30 validado antes de generar rótulo.
- El formulario abre siempre con `Caja Paquete XXS`; la operadora puede cambiar
  el tipo de paquete únicamente cuando el envío real lo requiera.
- La API de creación no exige una fecha de despacho y Kapta no debe pedirla. La
  fecha operativa nace del escaneo o transferencia real de custodia.
- Se permiten varios pagos; se libera la clave cuando la suma validada alcanza
  el total exigido.
- Sin pago completo no se entrega la clave.
- La clave pertenece a la salida Shalom: se registra, consulta y entrega desde
  **Salidas y guías**, no desde el formulario de comprobantes. El pago solo
  gobierna si la credencial puede revelarse.
- Seguimiento comienza desde la constancia del adelanto y se intensifica cuando
  el paquete llega a destino.
- Plazo: 28 días desde que está disponible en agencia destino.
- Alertas: 7, 3 y 1 día antes del vencimiento.
- Responsable de seguimiento, pago, recojo y retorno: Gerardo.
- Si Shalom reporta `Recogido` sin pago completo: conservar el hecho logístico,
  mantener el caso abierto y generar alerta financiera crítica.

Contingencia cuando la creación por API o Shalom Pro está degradada:

1. La operadora crea una sola vez la guía directamente en `pro.shalom.pe`.
2. En el drawer elige **Ya la creé en Shalom Pro** y registra como mínimo el
   número de guía. También puede guardar código Shalom, clave de recojo, agencia,
   serie, OSE ID e ID de orden.
3. Kapta no vuelve a llamar al endpoint de creación: vincula la guía existente,
   crea una salida física con QR propio y la deja en
   `Preparación · Por armar` (`rotulo_generado`, custodia de la empresa).
4. La clave ingresada se cifra y nunca se escribe en la línea de tiempo. Si no
   se conoce todavía, puede registrarse después en la credencial de esa salida,
   dentro de **Salidas y guías**.
5. El tracking público se recupera automáticamente por número de guía; no exige
   OSE ID ni sesión de Shalom Pro. OSE ID solo habilita rótulo/comprobante, e ID
   de orden permite una eventual anulación por API.
6. El mismo número de guía no puede vincularse a dos pedidos. Un segundo envío
   del mismo formulario sobre el mismo pedido actualiza datos sin crear otro QR.

### Olva

- Regla normal: pago completo.
- Excepción operativa permitida: recojo en agencia con adelanto de S/30.
- Cualquier asesor puede seleccionarla.
- En el drawer se recomienda primero Shalom.
- Plazo: 6 días desde disponibilidad en agencia destino.
- Gerardo también realiza seguimiento.

### Pagos

- Cualquier asesor puede subir el comprobante.
- El comprobante puede registrarse como `Adelanto`, `Diferencia` o `Pago total`.
  `Pago total` es un camino de captura visible, no una combinación implícita de
  adelanto y diferencia.
- El primer comprobante solo puede ser `Adelanto` o `Pago total`. Si existe un
  adelanto vivo, todos los comprobantes posteriores se registran como
  `Diferencia`; pueden existir varias diferencias hasta cubrir el monto total.
  `Adelanto` y `Pago total` son mutuamente excluyentes.
- El drawer muestra tres importes distintos: total cargado, total validado y
  saldo por cargar. El check **Adelanto mínimo validado** aparece únicamente
  cuando existen al menos S/30 validados, no solo por haber subido una imagen.
- Validadores actuales: Milagros, Mildred, Gabriela, Yohalis y Frankz, según la
  cuenta receptora.
- Hoy existe validación interna por WhatsApp/app bancaria; Kapta debe conservar
  quién cargó y quién validó.
- Al pulsar **Leer y rellenar**, Kapta separa dos identidades del comprobante:
  el pagador o remitente se conserva internamente para trazabilidad y detección
  de duplicados; la interfaz valida la **cuenta receptora**.
- La cuenta receptora se comprueba con dos señales independientes y visibles:
  el destinatario debe coincidir con `Grupo GF S.A.C.` y el celular debe ser
  `930 555 309` o conservar de forma legible la terminación `309`. Cada señal
  muestra su propio check verde; la cuenta solo queda `verificada` cuando ambas
  coinciden.
- Si cualquiera de las dos señales leídas **contradice** la cuenta esperada, el
  pago queda en revisión y Kapta bloquea su validación también en servidor. Si
  una señal no pudo leerse, se conserva la imagen y se exige contraste manual
  sin inventar el dato faltante.
- Un destinatario leído **a medias** no contradice: el voucher de Yape y el de
  BCP truncan o enmascaran el nombre por ancho de pantalla («Grupo Gf S»,
  «Grupo G\*\*\*»). Una lectura que empieza como el nombre esperado y se corta
  no verifica la cuenta, pero tampoco la acusa: queda como verificación parcial
  con contraste manual, nunca como *receptor distinto*. La regla se lee por
  palabras y desde el principio, que es como recorta una pantalla; el celular no
  admite este matiz, porque leído y sin terminar en `309` es otra cuenta.
- Esta distinción es de seguridad, no de comodidad: una alarma de desvío que
  salta casi siempre por un nombre cortado deja de leerse, y tiene que ser
  creíble el día que el receptor sea de verdad otro.
- La captura del comprobante permanece grande y visible durante la revisión y
  puede abrirse a tamaño completo. `Titular/pagador` no es un campo operativo:
  si la visión lo obtiene, se conserva internamente para trazabilidad y
  deduplicación, sin pedirle al asesor que lo complete.
- Si el pago es menor al requerido, la clave permanece bloqueada y se alerta al
  asesor.
- Solo Frankz ejecuta reembolsos.
- Un sobrepago puede devolverse después de validación.
- Pendiente de decisión formal: si el adelanto de S/30 se considera no
  reembolsable para cubrir logística cuando el cliente rechaza el saldo.

## 13. Devoluciones, inventario y reclamos

- Toda salida físicamente despachada necesita devolución física para cerrar una
  cancelación.
- Seguimiento Lima controla devoluciones de Lima.
- Gerardo solicita retornos Shalom/Olva.
- Almacén registra recepción y coteja solicitado contra recibido.
- Actualmente se verifica principalmente que llegó la caja.
- Yelitza decide reingreso a inventario o merma.
- Una devolución posterior del cliente mantiene el resultado Entregado y abre
  `Por cerrar · Devolución del cliente`.
- Solo Frankz y Yohalis pueden reabrir una devolución finalizada.

## 14. Liquidaciones

Couriers que cobran y luego liquidan: Aliclik, Swayp, Axel y Urpi.

- Tanders: el cliente deposita directamente; Kapta puede asociar la constancia
  Yape con la guía.
- Motorizados propios: efectivo neteado contra costo o pago directo a cuentas de
  la empresa.
- Los couriers descuentan el costo de envío antes de depositar.
- Neto esperado: cobrado menos costo logístico aplicable.
- La cabecera distingue el emisor del lote de una persona repartidora: Axel,
  Aliclik, Swayp y Urpi se asignan como **courier**. El campo motorizado se usa
  únicamente cuando la liquidación corresponde a Johnny, Roy, Douglas u otro
  motorizado propio. Un lote de Axel no exige crear a «Axel Courier» como
  usuario ni calcularle tarifas de motorizado propio.
- Conciliación: guía y pedido Shopify, con nombre/teléfono como apoyo.
- En la corrección manual, una búsqueda por código Shopify exacto consulta todas
  las tiendas accesibles y no queda oculta por la ventana de fechas ni por una
  pista de tienda, nombre o distrito del reporte. Las discrepancias se muestran
  como advertencia y una persona debe confirmar el vínculo; nunca se corrige de
  forma automática.
- No existe liquidación parcial por guía.
- Si una fila no cuadra, todo el lote queda Observado.
- Causas: pago faltante, importe menor o pedido no incluido.
- Antes del cierre, un rol con `settlements.manage` puede corregir una comisión
  o monto transcrito de una fila. La corrección exige motivo y conserva en un
  historial inmutable la liquidación, fila, campo, valor anterior, valor nuevo,
  actor y fecha. La imagen y el contenido original de `raw` no se sobrescriben.
- La revisión debe mostrar por separado **lo reportado por el courier** y **lo
  esperado según Kapta**. Por fila se presentan monto reportado, comisión
  reportada, monto esperado, diferencia y resultado de validación. En la
  cabecera se resumen las anomalías del lote, el total cobrado reportado, la
  comisión retenida, el neto que debe depositar, el depósito registrado y el
  saldo pendiente o excedente.
- «Coincide» significa que la fila concuerda con el Master. «Courier reporta
  cobro, Kapta aún no registra entrega» indica que primero debe aplicarse o
  validar el resultado operativo; no implica automáticamente fraude ni cierre.
- El costo faltante bloquea el cierre.
- Swayp vence a los cuatro días; Axel y Urpi a los tres días.
- Responsables: Daysi para Lima, Akemi para Swayp, Yohalis como responsable
  financiera principal y Frankz para validar depósitos Aliclik.

El módulo de Liquidaciones conserva la conciliación por lote. La Mesa de cierre
consume su resultado por pedido y no sustituye la regla de que una diferencia
mantiene observado el lote completo.

## 15. Responsables actuales

| Proceso | Rol estable | Persona actual |
| --- | --- | --- |
| Confirmación | Confirmación | Milagros |
| Preparación/almacén | Almacén | Yelitza y Matías |
| Seguimiento Lima | Seguimiento Lima | Daysi |
| Apoyo Lima/cotejo | Operación Lima | Diana |
| Reproprovincia | Jefatura Repro | Akemi |
| Reproprovincia | Operación Repro | Mariannys |
| Shalom/Olva | Seguimiento Agencia | Gerardo |
| Finanzas/liquidación | Responsable financiera | Yohalis |
| Reembolsos/propietario | Owner | Frankz |

La autorización futura se asigna al rol estable, no al nombre. El actor real se
registra en cada evento.

## 16. Permisos de alto riesgo

- Reembolso: solo Frankz.
- Reapertura: Frankz o Yohalis.
- Validar pagos: autorización individual `payments.validate`, administrada con
  un check en **Equipo**. El owner lo conserva por continuidad operativa; para
  los demás, el rol por sí solo no concede este permiso y cambiar a alguien a
  admin no le permite validar movimientos bancarios. Debe quedar al
  menos un validador activo y, al retirar un miembro, se eliminan sus permisos
  puntuales para que no reaparezcan si vuelve a ser invitado.
- Excepción COD por riesgo: justificación obligatoria.
- Continuar con discrepancia geográfica: justificación obligatoria.
- Retirar del manifiesto: motivo obligatorio.
- Corrección de resultado courier: evento de corrección, nunca edición destructiva.
- Cerrar liquidación observada: rol financiero autorizado.

### 16.1 Bandeja de validación de pagos

El control de acceso anterior cierra quién puede decidir, pero la operación
necesita además una bandeja central para que ningún comprobante quede escondido
dentro de un pedido. La vista aprobada tendrá tres columnas visibles:
`Pendientes`, `Observados` y `Validados hoy`. La lista `Todos` permanece oculta
y solo se consulta mediante búsqueda o filtros, para no renderizar una cola
histórica innecesariamente larga.

La bandeja vive en **Finanzas → Validar pagos** y se limita a las tiendas de las
organizaciones donde el usuario tiene `payments.validate`. Cada comprobante
muestra el pedido, cliente, tienda, tipo de pago, monto, operación, fecha,
cuenta receptora leída, evidencia y progreso acumulado del pedido.

- `Pendientes`: `pendiente_revision`, ordenados del más antiguo al más reciente.
- `Observados`: `posible_duplicado`, `info_incompleta` o `revision_admin`.
- `Validados hoy`: pagos `validado` durante el día calendario de Lima.
- `Observar` exige motivo y mueve el comprobante a `revision_admin`.
- `Rechazar` es una decisión definitiva desde Observados. No borra el pago: sale
  de la cola activa y queda preservado en el expediente y sus eventos.
- `Validar` exige número de operación y bloquea una cuenta receptora incompatible
  con Grupo GF S.A.C. / terminación 309.

Mientras Kapta y el Excel convivan, validar un pago deja el comprobante listo
para continuar y registra actor y fecha, pero **no cambia por sí solo la
macroetapa ni marca el pedido como pagado en Shopify**. Esas automatizaciones se
activan cuando la migración operativa al sistema sea completa.

## 17. KPI principales

Vistas: ayer, últimos 7 días, mes actual y mes anterior.

1. Tasa de confirmación Provincia COD.
2. Tasa de cierre de adelantos de Agencia.
3. Tasa de entrega Aliclik.
4. Tasa de entrega Lima total.
5. Tasa de pago completo/recojo de Agencia.
6. Éxito de primer intento.
7. Recuperación de Reproprovincia.
8. Rentabilidad por courier.

El negocio se mide por pedido; el desempeño del courier se mide por salida.

### 17.1 Primer tablero diario del owner

El primer tablero operativo de la Fase 4 usa cuatro ventanas fijas en hora de
Lima: ayer, últimos 7 días, mes actual y mes anterior. Cada porcentaje muestra
siempre su numerador y denominador; un universo vacío se presenta como `Sin
datos`, nunca como 0 %.

| Indicador | Cohorte / denominador | Resultado / numerador |
| --- | --- | --- |
| Confirmación Provincia COD | Pedidos Shopify creados en la ventana cuya cobertura actual es Provincia COD | Pedido que actualmente conserva evidencia de confirmación mediante evento `confirmed`, generación de rótulo/guía o una salida despachada |
| Adelanto de Agencia | Pedidos Shopify creados en la ventana cuya cobertura actual es Agencia | Pagos actualmente validados que acumulan al menos S/ 30 para el pedido |
| Entrega Aliclik | Salidas Aliclik despachadas dentro de la ventana | Salidas de esa cohorte cuyo resultado actual es Entregado |
| Entrega Lima total | Pedidos Lima con al menos una salida despachada dentro de la ventana | Pedidos de esa cohorte con al menos una de esas salidas Entregada |
| Pago completo de Agencia | Pedidos con salida Shalom u Olva despachada dentro de la ventana | Pedidos de esa cohorte cuyos pagos validados dentro de la misma ventana cubren el total Shopify |

Las tasas de confirmación y adelanto se miden por pedido. Aliclik se mide por
salida para no ocultar el desempeño de un courier cuando un pedido tuvo varias
cajas. Lima y Agencia se deduplican por pedido porque representan el resultado
del negocio. Los resultados tardíos actualizan la cohorte de la fecha original
de creación o despacho, excepto el pago completo de Agencia, que conserva la
regla aprobada de pago y envío dentro de la misma ventana.

Alertas del primer tablero:

- `Recogido sin pago completo`: razón crítica abierta en el Master.
- `Liquidación vencida`: obligación pendiente u observada que superó el SLA
  desde la entrega. Aliclik y motorizado propio vencen al día siguiente; Axel y
  Urpi a los 3 días; Swayp (antes Fénix) a los 4 días. Tanders no genera esta
  alerta porque el dinero entra directamente a la empresa.
- `Manifiesto incompleto`: ruta que ya inició el cotejo de oficina o de recojo y
  todavía no alcanzó el 100 %.
- `Sin movimiento por 60 días`: pedido no finalizado cuya última señal quedó
  antes del corte. Las subetapas con una reprogramación explícita vigente se
  excluyen; cuando la fecha programada venza, vuelven a ser elegibles.

El tablero es de lectura y abre la cola correspondiente del Master o la Mesa de
despacho. No finaliza, liquida ni corrige pedidos desde el resumen.

Alertas críticas iniciales:

1. Recogido sin pago completo.
2. Liquidación vencida.
3. Manifiesto incompleto.
4. Pedido sin movimiento por 60 días, salvo reprogramación explícita.

## 18. Implementación incremental

### Fase 1 — Fundaciones

- Catálogo versionado de macroetapas/subetapas.
- Resolución pura y testeada en modo sombra.
- Identidad estable y consecutivo por salida.
- Token QR estable por salida.
- Campos de preparación y custodia compatibles con las guías existentes.
- Persistencia del cálculo en `order_master`.
- Historial append-only existente como base de auditoría.

### Fase 2 — Almacén y manifiestos

- Consume la salida/rótulo generado por los paneles actuales de cada courier;
  la decisión y creación específica del rótulo pertenece a la Fase 3.
- Escaneo de paquete listo.
- Agrupación de ruta.
- Doble cotejo.
- Transferencia de custodia.

Implementación publicada en `/dashboard/pedidos/despacho`:

- `dispatch_manifests`: una ruta por organización, courier, fecha y nombre.
- `dispatch_manifest_items`: una salida física por ítem; una salida no puede
  pertenecer activamente a dos rutas.
- **Asignar es un paso propio y anterior al cotejo** (ver «Los cuatro pasos»).
- Primer cotejo: oficina confirma que el paquete completo está físicamente en
  la caja/agrupación correcta. **Solo confirma lo asignado**: un código que no
  pertenece a la ruta se avisa, nunca se agrega.
- Segundo cotejo: el propio motorizado confirma todo lo que recibe. **Solo
  existe en las rutas de reparto** (ver «Los dos tipos de ruta»).
- Crear, organizar o enviar una ruta no cambia custodia.
- `finalize_dispatch_manifest()` bloquea la ruta y vuelve a comprobar dentro de
  una sola transacción el 100 % de los cotejos que correspondan a su tipo, antes
  de mover todos los paquetes a custodia `courier`.
- Un faltante se retira expresamente con motivo, persona y hora. No se borra.
- Cada creación, escaneo, retiro, cancelación y transferencia queda en
  `dispatch_events`; los movimientos por pedido también llegan a `order_events`.
- Cámara del celular, lector USB y escritura manual resuelven el mismo token QR,
  código de salida o código de guía.

#### Los cuatro pasos del despacho

El orden es el de la operación real, y cada paso lo hace una persona distinta:

1. **Armar en almacén.** Almacén escanea cuando el pedido está completo,
   rotulado y dentro de su caja. Ocurre en la pantalla de **Almacén**, no en la
   Mesa de despacho.
2. **Asignar a ruta.** Seguimiento decide en la computadora qué va con quién,
   **seleccionando pedidos, sin escanear**.
3. **Cotejo de oficina.** El encargado escanea cada bolsa que entra en la caja
   del motorizado y confirma que está lo asignado.
4. **Cotejo del motorizado.** El motorizado escanea lo que recibe.

La **Mesa de despacho** contiene solo los pasos 2 a 4, que son los de una ruta:
asignar, cotejar oficina y recibir. El paso 1 tiene pantalla propia porque no es
trabajo de ruta y su cola es otra —lo que falta armar—, que la mesa nunca mostró.

Los pasos 1 y 2 son **independientes**: la ruta se planifica antes de que
almacén termine de armar. Por eso asignar **no exige** el escaneo de almacén —
ese escaneo se muestra como indicador («armado» / «almacén aún no lo escaneó»),
no como candado. Lo que ningún paquete puede saltarse es el cotejo de oficina,
que es el que prueba que la caja existe y entró donde debía.

Asignar y cotejar fueron el mismo gesto durante un tiempo: cada escaneo del
cotejo agregaba el paquete a la ruta. Además de impedir planificar, hacía que un
escaneo distraído metiera una caja ajena a la ruta y la diera por cotejada en el
mismo movimiento.

**Un motorizado tiene UNA ruta al día, y un courier también.** Partir la carga de
alguien en dos rutas el mismo día no ocurre en la operación, y cuando aparece una
segunda es un error: los paquetes quedan repartidos entre dos manifiestos y el
cotejo de ninguno cuadra. Lo impide la base, no solo la interfaz.

La unicidad sigue a la identidad de la ruta: **con motorizado**, uno por
motorizado y día —así Johnny, Roy y Douglas tienen cada uno la suya aunque los
tres sean «motorizados propios»—; **sin motorizado**, uno por courier y día, que
es el caso de Aliclik, las agencias y las rutas «Sin asignar».

**Una ruta se identifica por quién se la lleva y qué día**: «Roy · 03/08». El
nombre de zona no existe como dato que nadie escriba: la ruta se llama como el
motorizado, o como el courier cuando no hay persona — porque ahí **quien se lleva
la caja ES el courier**. Una ruta de Urpi se titula «Urpi» con «Courier» de
subtítulo, nunca «Sin motorizado»: eso no nombra nada y deja la tarjeta sin
identidad justo donde hay que elegir entre varias rutas.

Crear una ruta son **dos campos**: con quién sale y la fecha. Un solo desplegable
lista los **motorizados propios por su nombre**, agrupados bajo su cabecera, y
debajo los **couriers**. Elegir courier y después motorizado era decir una sola
cosa en dos pasos, y el segundo desplegable solo tenía sentido para los propios:
en Aliclik, Urpi o Tanders la ruta **es** el courier y quién conduce ni se sabe
ni hace falta.

**A qué ruta se está trabajando no se puede deducir.** El destino se repite
pegado a la acción —no solo en la lista lateral, que en el celular queda debajo y
lejos— con su propio selector de ruta. Asignar pide una confirmación que nombra
la ruta, y cambiar de ruta descarta la selección pendiente: arrastrarla al
destino nuevo es exactamente el cruce que hay que evitar.

**Con cientos de paquetes, desplazarse no es una forma de encontrar nada.** Las
listas de armados, de paquetes sin ruta y de paquetes dentro de una ruta se
buscan por código de salida, guía, pedido, cliente o distrito.

#### El Excel de Urpi

Urpi no recibe una lista nuestra: carga los pedidos en **su** sistema desde **su**
formato de Excel. Una ruta de Urpi trae un botón que descarga ese archivo listo
para copiar y pegar, con sus quince columnas en su orden — incluida la cuarta,
que no tiene encabezado y va vacía: omitirla corre todo lo demás una columna.

Las conversiones que exige su formato:

- El **teléfono sin el prefijo del país**: guardamos `51991467077`, su sistema
  espera `991467077`.
- La **tienda** como su desplegable la nombra: `KENKU`, `AURELA`.
- La **fecha** en `dd/mm/aaaa`, y el monto a cobrar como número.
- «N DE REF (CANTIDAD)» son las **unidades totales** del pedido, no las líneas.
  Sin productos queda **vacía, no en cero**: un cero se lee como «no lleva
  nada», y lo que pasa es que falta el dato.
- «OBSERVACIONES» lleva la **nota del pedido en Shopify**.

El archivo exporta lo que la ruta tiene **en ese momento**, no lo planificado: un
paquete retirado en el cotejo no puede seguir en la lista que Urpi carga, o
quedarían esperando una caja que nunca sale. Por eso el botón vive junto a la
ruta —visible al asignar, al cotejar y al recibir— y avisa cuando el cotejo de
oficina todavía no está completo, en vez de esconderse hasta entonces.

#### Los dos tipos de ruta

El tipo lo decide el **courier**, no quien crea la ruta:

| Tipo | Couriers | Cómo cierra |
| --- | --- | --- |
| **Ruta de reparto** | Motorizados propios, Axel, Urpi, Tanders, Swayp | Cotejo del motorizado al 100 % |
| **Entrega al courier** | Aliclik, Shalom, Olva | Cotejo de oficina al 100 % **+ el nombre de quien recoge** |

En una entrega al courier **no hay segundo cotejo**: Aliclik recoge y a las
agencias se les lleva la caja; nadie del otro lado escanea. Exigírselo dejaba
esas rutas trabadas para siempre esperando algo imposible, y la custodia no
pasaba nunca. Su prueba de entrega es el nombre de quien se llevó las cajas, y
sin él el servidor no cierra la ruta: sin nombre no hay a quién reclamarle una
caja que no llegó.

#### Qué puede entrar en cada ruta

Una ruta acepta solo las operaciones (§5) que su courier atiende:

- Motorizados propios, Axel y Urpi: Lima.
- **Tanders: Lima y solo Lima**, también desde el servidor (§5).
- Swayp: Lima y Provincia COD (Reproprovincia, §11).
- Aliclik: Provincia COD. Shalom y Olva: Agencia.

Un pedido de provincia en la caja de un motorizado de Lima se rechaza con el
motivo. Una operación **sin clasificar no bloquea**: el dato falta, y negarle el
despacho a una caja que existe físicamente es peor que dejarla pasar; lo que se
bloquea es la contradicción explícita.

### Fase 3 — Modalidades

- El drawer contiene una mesa de ruta que clasifica Lima COD, Provincia COD y
  Agencia, explica la recomendación y conserva visibles las alternativas.
- Lima aplica cortes operativos y políticas de repetición para motorizado
  propio, Axel, Tanders, Urpi y Swayp.
- Provincia COD recomienda Aliclik como primera salida; después de un resultado
  fallido prioriza Swayp cuando la ciudad y todos los productos tienen stock.
- Reproprovincia abre la guía concreta en la cola existente; una salida Swayp
  directa valida nuevamente cobertura, stock, pedido y salidas activas.
- Shalom continúa por su API directa y Olva se registra como salida de agencia;
  ambas muestran el requisito de adelanto y el servidor exige S/ 30 validados.
- Axel, Urpi, motorizado propio y Olva generan una salida interna, un consecutivo
  `Sxx`, un QR opaco y un rótulo imprimible de Kapta.
- Una salida manual nace como `rotulo_generado`, bajo custodia de la empresa. No
  pasa a despacho hasta el escaneo de almacén y no pasa al courier hasta el doble
  cotejo de la Fase 2.
- Si ya existe una salida activa, una nueva salida manual exige motivo. El
  límite de cinco y las políticas de repetición se vuelven a validar en servidor.

### Fase 4 — Cierre

- Liquidaciones.
- Retornos, inventario y merma.
- Indemnizaciones y reembolsos.
- KPI y resumen diario del owner.

Primer bloque publicado en el drawer del Master:

- La Mesa de cierre aparece en `Por cerrar` y `Finalizado`, muestra todas las
  obligaciones simultáneas y no confunde el resultado comercial con el cierre.
- Solicitud y recepción física de retornos por salida; recibir actualiza la
  custodia del paquete y abre la conciliación de inventario.
- Reingreso a inventario o cierre como merma por salida física concreta,
  siempre después de recibir la caja y con nota auditada. Un evento no puede
  conciliar las demás cajas del mismo pedido.
- Liquidación observada o conciliada. No se permite conciliar si falta el costo
  logístico configurado.
- El módulo de Liquidaciones permite corregir transcripciones por fila con
  auditoría append-only, asigna courier y motorizado como conceptos distintos y
  muestra un resumen explícito de anomalías antes de permitir el cierre del lote.
- Apertura y resolución de indemnización Aliclik por salida concreta.
- Solicitud de reembolso y confirmación posterior; el botón no mueve dinero y
  solo el rol owner puede confirmar que Frankz ya lo ejecutó.
- Devolución posterior del cliente sin borrar el resultado Entregado.
- Finalización y reapertura explícita. Una reapertura queda `Por cerrar` hasta
  que Frankz o Yohalis la finalicen de nuevo.
- Permisos separados para retornos, inventario, finanzas, finalización y
  reembolsos; los permisos puntuales de `user_permissions` siguen prevaleciendo.
- El resolver quedó versionado —`mom-v1.4` en este bloque; la versión vigente es
  siempre `MOM_RESOLUTION_VERSION` en `lib/order-macro-stage.ts`, hoy
  `mom-v1.9`—; el cron detecta versiones anteriores y recalcula el histórico por
  lotes hasta que todo el Master converja, sin necesitar credenciales locales ni
  detener la sincronización. Toda regla que cambie el resultado de filas que
  nadie tocó debe subir esa constante, o el histórico queda con el veredicto
  viejo.

Segundo bloque publicado en el Dashboard consolidado:

- El resumen operativo del owner aparece antes del dashboard comercial y usa
  únicamente hechos accesibles por RLS de `order_master`, salidas, pagos,
  eventos y manifiestos.
- Las tasas de Confirmación Provincia COD, Adelanto de Agencia, Entrega Aliclik,
  Entrega Lima y Pago completo de Agencia muestran porcentaje, numerador y
  denominador en las cuatro ventanas de la sección 17.1.
- Las alertas `Recogido sin pago completo`, `Liquidación vencida`, `Manifiesto
  incompleto` y `Sin movimiento por 60 días` muestran conteos reales y abren la
  cola correspondiente; el resumen no cambia estados ni ejecuta cierres.
- Los plazos de liquidación distinguen Aliclik/motorizado propio, Axel/Urpi,
  Swayp y Tanders, incluyendo Johnny, Roy y Douglas como motorizados propios.
- Un universo vacío se presenta como `Sin datos`, nunca como una tasa falsa de
  0 %, y el cálculo conserva la unidad pedido o salida aprobada en el MOM.

## 19. Compatibilidad y activación

La Fase 1 añadió `macro_stage`, `macro_substage` y `macro_reasons` en modo
sombra. La Fase 2 activa estas columnas como navegación principal:

1. El Master se filtra por las seis macroetapas del MOM.
2. Cada macroetapa expone sus subetapas y conteos reales.
3. La tabla y el drawer muestran macroetapa y subetapa.
4. `general_status` y `operational_status` se conservan para compatibilidad,
   reglas heredadas y correcciones autorizadas; ya no organizan las pestañas.
5. Las diferencias se corrigen en el resolver o mediante nuevos eventos, nunca
   editando directamente el read-model.

### 19.0 Un vínculo por teléfono es provisional

Al importar un reporte, el emparejador vincula la guía a un pedido por nombre de
pedido y, si no lo hay, **por teléfono — solo cuando existe un único pedido con
ese número**. La regla es correcta en el instante en que corre, y ahí está la
trampa: **la respuesta caduca**. El pedido bueno puede llegar después.

Pasó con AUR5X121336. Entró el 10-07, cuando `#KP121336` (creado el 06-07) aún no
se había importado, así que el único pedido con ese teléfono era el ANTERIOR del
mismo cliente —anulado desde junio— y ahí se quedó. Nadie vuelve a mirar un
vínculo ya hecho, así que el error es permanente y silencioso: al 10-08 eran
**15 guías colgando de pedidos ajenos y 15 pedidos legítimos sin ninguna guía**,
mostrando «Por confirmar» con el paquete entregado. Los pedidos que las recibían
acumulaban dos y tres guías que no eran suyas.

**La evidencia que faltaba estaba a la vista.** Aliclik numera sus guías `AUR5X` +
el número del pedido: AUR5X121336 dice `#KP121336` en su propio nombre. Con
`stores.order_prefix` ese número se convierte en un nombre de pedido real. Dos
reglas nuevas:

1. **Al importar**, el número del código de guía entra como candidato SIN
   CONFIRMAR (`orderNameFromGuideCode`). Sin confirmar a propósito: es una
   convención del courier, no una garantía, así que el emparejador solo lo acepta
   si el teléfono apunta al MISMO pedido. Dos señales independientes donde antes
   había una.
2. **Hacia atrás**, `/api/cron/aliclik-fix-phone-links` devuelve a su sitio las ya
   enganchadas mal. Solo mueve con las dos señales de acuerdo y cuando el destino
   **no tiene ninguna guía propia** — el patrón que corrige es «pedido huérfano de
   su guía»; encimar una guía a un pedido que ya tiene la suya es decisión de una
   persona, no de un barrido. Ensayo por defecto (`?apply=true` para ejecutar) y
   fuera de `vercel.json`: mover una guía reescribe a qué venta pertenece un
   paquete, y de ahí salen el cierre, el costo y la liquidación.

Y para el caso suelto que ninguna regla alcanza, la corrección a mano vive en
**Gestión manual → correcciones excepcionales → «Corregir vínculo de guía»**: la
mueve, renumera la salida, deja constancia en los dos historiales y recalcula los
dos Masters.

### 19.0.1 La cobertura de un distrito es una decisión, no un mapa

La regla general clasifica por geografía: Lima Metropolitana y Callao son
**Lima**, un destino con tarifa COD vigente es **Provincia COD**, el resto
**Agencia**. Acierta casi siempre y se queda corta donde la operación manda:
Pucusana está dentro de la provincia de Lima y el reparto propio no llega, así
que sale por agencia. Hasta 0121 eso solo se cambiaba tocando código —la lista
vive en `is_lima_metropolitana`— y cada distrito nuevo era un despliegue.

`district_coverage` guarda esas decisiones y **nace vacía**. No es un catálogo de
los 1.870 distritos del país ni una copia de la lista de Lima: sembrarla con los
51 distritos de Lima/Callao crearía una TERCERA copia de algo que ya está en SQL
y en TypeScript, y este MOM lleva media docena de incidentes causados por dos
definiciones de lo mismo divergiendo. Vacía, además, el comportamiento del día
del despliegue es exactamente el anterior.

**La excepción manda sobre todo lo demás.** El orden en `order_coverage_for` es:

1. `district_coverage` — la decisión explícita.
2. Cañete.
3. Lima Metropolitana.
4. Tarifa COD vigente, o punto COD cercano (§10).
5. Agencia.

Si una excepción no pudiera contradecir a las reglas automáticas no serviría de
nada: existe justamente para eso. Y vive **en la base**, no en TypeScript, porque
la definición canónica de la cobertura es `order_coverage_for` (§19.1 y 0104): el
Master se la pregunta a ella. Una excepción escrita solo en TS no habría tenido
ningún efecto.

`store_id` nulo vale para todas las tiendas —así está hoy la clasificación— y una
fila con tienda gana sobre la global, para el día en que dos tiendas difieran en
un destino.

**Al guardar se reclasifican los pedidos ABIERTOS de ese distrito**, no solo los
nuevos. Sin eso la excepción sería cierta para el futuro y mentira para lo que ya
está en pantalla, que es el desfase de §19.1. Los finalizados no se tocan: su
historia queda como ocurrió.

### 19.1 La etapa es una foto, y alguien tiene que revelarla

`order_master` no calcula en vivo: guarda el resultado del resolver y lo sirve.
Eso hace que el listado sea una consulta a una tabla, y trae la contrapartida
obvia —**una etapa correcta depende de que alguien recalcule cuando cambia una
guía**— más una menos obvia: cuando el recálculo no ocurre, **no se nota**. La
pantalla no muestra un error; muestra la etapa de antes, con toda naturalidad.

Pasó el 09-08, y la causa importa porque no es la que parece. Ese día se
enlazaron **71 guías huérfanas a sus pedidos con SQL a mano contra la base** —53
a las 19:24 emparejadas por nombre de pedido + teléfono, y 18 a las 21:25 por
código de guía, verificado en `pg_stat_statements`—. No hubo import: cero filas
en `import_rows` y cero lotes ese día. **Ninguna ruta de la aplicación
intervino**, así que tampoco hubo un recálculo que pudiera fallar; simplemente no
lo llamó nadie.

Esos pedidos acababan de recibir su PRIMERA guía. Su fila del Master seguía
respondiendo lo que se había calculado cuando no tenían ninguna —«Por confirmar ·
Sin llamar», `courier_count = 0`—, incluidas guías ya **entregadas**. El síntoma
apareció días después: #AUR173240, con su guía entregada, decía **48 días en esta
macroetapa**, porque `macro_since` nunca dejó de ser su fecha de creación. Eran
69 pedidos así.

Lo que los dejó pegados no fue un fallo, sino que **nada los buscaba**. El barrido
de reconciliación miraba tres cosas, y ninguna miraba las guías:

| Puerta | Por qué no los veía |
|---|---|
| Fila ausente en el Master | La tenían |
| `macro_version` anticuada | Era la vigente (`mom-v1.8`) |
| `macro_version is null` | **Nunca podía abrir**: la columna es NOT NULL |

Y como la lista de candidatos salía de los **1.000 pedidos más recientes de la
tienda**, 66 de los 69 quedaban fuera solo por edad. Un pedido viejo que se movía
no tenía forma de volver a entrar.

Tres reglas, a partir de acá:

1. **La señal de «etapa vieja» son las guías, no el pedido.** El barrido compara
   el `updated_at` de las guías contra el `recomputed_at` del Master
   (`staleByShipment`). No basta con que cada ruta se acuerde de recalcular,
   porque **la escritura puede venir de fuera de la aplicación** —de una consola
   de SQL, como el 09-08— y ninguna ruta puede responder por eso. El read-model
   se reconcilia contra los datos, no contra las llamadas. Alcanza además a un
   pedido de hace tres meses en cuanto su guía se mueve.
2. **El recálculo va por tandas.** Un pedido que revienta cuesta su trozo, no la
   lista entera. Endurecimiento, no la causa de este incidente: el import de
   Aliclik llega a llamar con más de mil pedidos de golpe y cualquier fallo los
   congelaba a todos.
3. **Best-effort no es en silencio.** Seguir adelante ante un fallo es correcto;
   no dejar rastro no lo es. El recálculo devuelve cuántos pedidos se quedaron
   sin recalcular, y el reporte de sincronización lo dice.
4. **Una regla correcta no sirve si no llega a ejecutarse.** El barrido vivía en
   la última línea de `runStoreSync`, y el cron recorría las tiendas en serie
   bajo un solo `maxDuration`. Sin reparto de reloj, la segunda tienda hereda lo
   que la primera no gastó — y lo primero que muere cuando se acaba es
   precisamente la última línea de la segunda. **Medido el 17-08-2026**, con la
   regla ya desplegada: el atraso global cayó de 955 pedidos a ~200 y ahí se
   detuvo; al agrupar los que no drenaban salió **una sola tienda, Kenku, con
   207 pedidos y 50 horas de desfase medio**, y Aurela con cero. Misma regla,
   mismo código, dos tiendas activas: a una no le llegaba nunca.

   Ahora el barrido tiene **su propio cron** (`/api/cron/master-reconcile`) con
   presupuesto propio, repartido entre las tiendas que faltan por barrer
   (`budgetShareMs`), y lo que no cabe se cuenta en `deferred` —que no es un
   fallo: vuelve solo en la pasada siguiente porque el ancla es el desfase, no
   una lista—. La sincronización sigue barriendo cuando se pide **una** tienda
   (la conexión inicial, el botón de sincronizar); lo que ya no hace es barrer
   desde la cola de un recorrido multitienda.

   Es la tercera vez que este repositorio paga el mismo defecto —antes fue la
   caducidad de huérfanas y el pase de rezagadas detrás del bucle de Aliclik— y
   la lección está escrita en `aliclik-close/route.ts`: **un trabajo colgado del
   final de otro más largo no tiene garantía de ejecutarse nunca.** Al revisar
   por qué algo «no funciona», la pregunta va antes que la regla: ¿llegó a
   correr?

Y una cuarta, para quien toque la base a mano: **enlazar una guía a un pedido por
SQL deja el Master mintiendo hasta el siguiente barrido.** Ahora el barrido lo
recoge; antes no lo recogía nadie.

## 20. Criterios de aceptación de la Fase 1

- Un pedido Shopify sin salidas existe una sola vez en el Master.
- Dos guías del mismo pedido producen `S01` y `S02`.
- Cada salida conserva un QR distinto.
- Relacionar una guía al pedido no sobrescribe el historial.
- Lima nuevo se calcula como Preparación.
- Provincia nueva se calcula como Por confirmar/Sin llamar.
- Una guía generada sin despacho se calcula como Preparación/Por armar.
- Un paquete listo bajo custodia de empresa se calcula como Por despachar.
- Una salida entregada con otra activa se calcula como Por cerrar.
- Un pedido cancelado con paquete todavía fuera se calcula como Por cerrar.
- Un pedido cancelado que nunca salió se calcula como Finalizado.
- La implementación funciona aunque la migración todavía no esté aplicada.
- La navegación principal muestra Por confirmar, Preparación, Por despachar,
  En curso, Por cerrar y Finalizado.

## 21. Pendientes posteriores

- Regla de repetición de Aliclik.
- Tratamiento contractual del adelanto de S/30 no recuperado.
- Flujo Falabella.
- Significado operativo de «no se puede volver» en ciertas rutas Swayp.
- Regla exacta para pausar nuevas rutas Swayp por liquidación vencida.
- Integración directa del resultado por lote del módulo de Liquidaciones con la
  obligación financiera por pedido de la Mesa de cierre.

## 22. Criterios de aceptación de la Fase 2

- Un paquete no puede agregarse a una ruta si no está `listo_despacho` y bajo
  custodia de la empresa.
- El courier de la salida debe coincidir con el courier de la ruta.
- El mismo paquete no puede estar activo en dos manifiestos.
- El escaneo del cotejo de oficina SOLO confirma lo ya asignado: un código que
  no pertenece a la ruta se avisa, nunca se agrega.
- El segundo cotejo no puede comenzar hasta completar el primero al 100 %.
- El paquete que falta puede retirarse sin bloquear los demás, pero exige motivo.
- La ruta solo llega a `in_custody` después del segundo cotejo al 100 %.
- La transferencia actualiza todos los paquetes de la ruta atómicamente.
- Una ruta cancelada libera sus paquetes y conserva el historial.
- Cada actor queda registrado con fecha y hora.

## 23. Criterios de aceptación de la Fase 3

- Un pedido no-Lima con geografía conocida y sin modalidad histórica se trata
  como Provincia COD, no como operación desconocida.
- Provincia COD nueva muestra Aliclik como primera sugerencia.
- Aliclik fallida + cobertura y stock completo muestra Swayp como siguiente ruta.
- Swayp sin cobertura o sin stock explica el bloqueo y no crea una salida.
- Swayp puede repetirse en Reproprovincia; en Lima solo se usa una vez.
- Tanders solo aparece y puede crear guía en cobertura Lima.
- Cañete se muestra como Agencia y nunca habilita una guía Tanders.
- Axel y motorizado propio pueden repetirse sin superar cinco salidas.
- Shalom y Olva avisan que el adelanto debe validarse antes de crear la guía.
- Olva no se crea con menos de S/ 30 validados aunque el navegador sea alterado.
- Dos salidas del mismo pedido reciben QR y código `Sxx` diferentes.
- Con una salida activa, la salida adicional exige una justificación auditada.
- La vía de contingencia de Shalom («Ya la creé en Shalom Pro») rechaza el pedido
  que ya tiene una salida viva, igual que la vía API. Se salta los frenos del
  API —para eso existe— pero no este: ahí el problema no es la llamada, es que
  el pedido acabaría con dos paquetes en la calle. Reenviar la **misma** guía
  para completar identificadores sigue siendo idempotente. Y como cualquier otra
  vía de guía, **rellena** la salida «por definir» si la hay en vez de abrir otra.
- Rellenar decide el **courier** de una caja que ya existe: no toca el avance de
  preparación, la custodia ni la identidad de la salida (QR, consecutivo,
  código). Escribir «rótulo generado» sobre una caja ya escaneada como «listo
  despacho» sería borrar un escaneo real para registrar una guía.
- **Anular la guía de un courier sobre una salida rellenada la devuelve a «por
  definir», no a anulada.** La caja no desaparece: sigue armada, rotulada y en el
  almacén, y lo único que dejó de ser cierto es quién la lleva. Marcarla anulada
  cerraba la venta entera cuando era la única salida —el pedido pasa a `anulado`
  con todas sus guías anuladas— y encima bloqueaba la guía nueva que motivaba la
  corrección. Que una salida fue rellenada se sabe por su **evento**, no por su
  forma: una fila rellenada y una creada de cero acaban idénticas.
- Una salida de ruta manual pendiente y en almacén ofrece **Anular salida** en
  «Salidas y guías», con confirmación en dos pasos y evento auditado. Tras
  anularla, el pedido vuelve a poder crear guía de agencia y a finalizarse.
- La misma salida ya transferida al motorizado **no** ofrece anular, y el
  servidor la rechaza aunque se llame a la acción directamente: esa se cierra
  recibiendo su retorno.
- Un courier con salida **viva** deja de ofrecerse, y la tarjeta **nombra esa
  salida**: número del courier, código corto y el estado que el courier reporta.
  Decir «no disponible» sin decir cuál obliga a bajar a «Salidas y guías» para
  averiguarlo, y en el panel del courier hay que buscarla por su número.
- En «Salidas y guías», el número del courier se muestra junto al código interno
  de Kapta. Son dos identificadores distintos y hacen falta los dos: el interno
  para el cotejo, el del courier para buscar el envío en su panel.
- **Con la guía de agencia creada, el destinatario y la agencia de destino dejan
  de ser editables.** Se apuntan como borrador durante el cobro, pero una vez que
  la guía existe el courier ya los tiene y los imprimió en su rótulo: cambiarlos
  en Kapta no cambia el papel que viaja con el paquete, solo hace que digan cosas
  distintas. Para corregirlos se anula la guía y se crea otra. El servidor
  ignora el borrador en ese estado; no basta con esconder el formulario.
- El rótulo interno contiene pedido, salida, courier, cliente, destino, productos
  y el QR que consume la mesa de despacho.
- El rótulo lleva además un **código de barras Code 39 del PEDIDO de Shopify**,
  sin el sufijo `-Sxx` de la salida. Es un puente de transición: mientras la
  operación no esté migrada del todo, el almacén pistolea el rótulo contra un
  Excel cuya clave es el número de pedido, y un código que incluyera la salida
  obligaría a limpiarlo a mano. **No sustituye al QR**: el QR identifica la
  salida y es lo único que vale para el cotejo y las transferencias de custodia.
  Una salida cuyo pedido no se puede determinar se imprime sin código de barras
  —nunca con el número de guía del courier en su lugar—, porque pistolear una
  guía dentro de la columna del pedido corrompe el Excel en silencio.
- Desde el Master se accede al panel correcto de Aliclik, Shalom, Tanders,
  Swayp/Reproprovincia o a la creación manual sin volver a buscar el pedido.
- La interfaz funciona en celular y escritorio, con cámara y entrada manual.

## 24. Criterios de aceptación del primer bloque de la Fase 4

- Una solicitud de retorno conserva la salida concreta, courier, guía, actor,
  fecha y motivo.
- Una devolución no puede marcarse recibida sobre una salida que todavía está
  bajo custodia de la empresa.
- Inventario o merma no se pueden conciliar antes de recibir físicamente una
  devolución.
- Una entrega COD no finaliza hasta registrar su liquidación conciliada.
- Falta de costo logístico bloquea la conciliación financiera.
- Una liquidación observada conserva el lote abierto hasta su conciliación.
- La indemnización formal solo se abre sobre una salida Aliclik.
- Un administrador puede solicitar un reembolso, pero solo el owner puede
  confirmar que Frankz ya lo ejecutó y debe indicar el monto.
- Reabrir un pedido finalizado crea una obligación de validación; las señales
  históricas no lo vuelven a cerrar automáticamente.
- Finalizar se bloquea mientras existan salidas activas u otras obligaciones.
- Todas las acciones se guardan como eventos append-only y recalculan el Master.

### 24.1 Criterios de aceptación de Por confirmar

- Los pedidos sin gestión anteriores al 01/06/2026 aparecen como
  `Histórico sin gestión`, no como `Sin llamar`.
- Llamada, WhatsApp y mensaje del mismo día consumen un solo día de los siete,
  aunque cada intento queda auditado.
- Un seguimiento exige fecha y nunca hora; la cola distingue vencidos, hoy y
  próximos.
- `Sin respuesta` y `Se deja mensaje` generan un recordatorio a las dos horas
  laborales dentro de 08:00–22:00 de Lima.
- El séptimo día sin confirmación crea una tarea manual de revisión en Shopify;
  no anula el pedido desde Kapta.
- Un doble clic no duplica el día, los eventos ni la tarea.
- El riesgo del cliente se muestra para todas las rutas, pero solo Aliclik queda
  bloqueado por el pago requerido. Una excepción Aliclik deja motivo auditado.
- El bloqueo de pedido por asesor queda expresamente diferido hasta abandonar
  el Excel; no forma parte de esta activación.

## 25. User journey del drawer del Master

El Master trae **una página de 100 pedidos**, no la lista entera. El contador
dice el total de la macroetapa y el paginador aparece en **todas** las vistas, no
solo en la de búsqueda: enseñar 100 de 2.976 sin forma de llegar al resto es
esconder el trabajo pendiente.

**La tabla del Master es para barrer; el drawer es para trabajar un pedido.** La
tabla solo lleva lo que sirve para localizar y priorizar: quién, dónde, en qué
macroetapa y desde cuándo. El detalle de un pedido —modalidad, courier actual,
guía, agencia y sus días, pago y clave, costo logístico— vive en el drawer, que
es donde se mira uno por uno. Sumarlo todo a la tabla la volvía tan ancha que
había que scrollear en horizontal para leer la fila que se estaba mirando.

Nada se elimina al sacarlo de la tabla: si un dato deja de tener columna, tiene
que aparecer en el drawer en el mismo cambio.

El drawer no es un formulario largo ni un resumen de tablas. Es la mesa de
trabajo de un pedido concreto. La experiencia principal se diseña primero para
el equipo que opera desde una computadora y se divide en tres espacios estables:

1. **Operar:** muestra macroetapa, subetapa, antigüedad, avance del MOM y una sola
   próxima acción. Aquí viven pagos requeridos, elección de ruta, rótulos,
   salidas, cierre y gestión manual, únicamente cuando corresponden al pedido.
2. **Información:** reúne cliente, monto, tienda, cobertura, ubicación y
   productos. Shopify es la fuente comercial y Kapta agrega el contexto
   operativo sin mezclarlo con la acción actual.
3. **Actividad:** conserva cronológicamente eventos, actores, fuentes, guías,
   motivos y correcciones. Es evidencia de solo lectura; no compite con el
   trabajo pendiente.

Dentro de `Operar`, el orden de decisión es:

1. **Dónde está:** macroetapa, subetapa, antigüedad y avance dentro de las seis
   macroetapas del MOM.
2. **Qué toca hacer ahora:** una acción dominante calculada desde la macroetapa
   y subetapa actuales.
3. **Qué requisito la bloquea:** pago, ubicación, confirmación, stock, retorno u
   otra obligación explícita.
4. **Cómo se ejecuta:** ruta, creación del rótulo, salida, QR y transferencia de
   custodia en la Mesa de despacho.
5. **Qué falta cerrar:** liquidación, retorno, inventario, indemnización,
   reembolso o devolución del cliente como obligaciones independientes.

Reglas de interfaz:

- El encabezado conserva siempre pedido, estado comercial, monto, tienda,
  cliente y accesos de llamada/WhatsApp.
- La navegación usa las pestañas `Operar`, `Información` y `Actividad`. No se
  reemplaza por una lista horizontal de enlaces a formularios.
- La próxima acción nunca se deduce por color ni queda enterrada entre
  formularios; tiene título, explicación y acceso directo a su herramienta.
- El color refuerza significado sin ser la única señal: ámbar para confirmación
  o pagos, celeste para preparación, índigo para despacho, cian para seguimiento,
  naranja para cierre, verde para completado y gris para consulta/auditoría.
- El panel de pagos aparece antes que la ruta únicamente cuando la operación de
  Agencia o una regla de riesgo exige el cobro. En Provincia COD, Aliclik y
  Swayp pueden salir contra entrega: la Mesa de ruta conserva la prioridad y el
  pago anticipado aparece después, rotulado como opcional, aunque Shalom u Olva
  estén disponibles como alternativas.
- La credencial de recojo no comparte formulario con el comprobante. Solo
  aparece cuando ya existe una salida Shalom y vive dentro de **Salidas y
  guías**. Shalom origina la clave; el pago completo autoriza mostrarla y
  registrar su entrega al cliente.
- Adelanto, Diferencia y Pago total conservan identidades distintas, pero se
  presentan según la secuencia de cobro permitida. Los
  datos anticipados de Shalom (documento y agencia) se muestran desplegados por
  defecto para evitar que se olviden durante la llamada, sin volverlos requisito
  para registrar el comprobante.
- Dentro del cobro por Agencia, el orden de trabajo es fijo: (1) documento y
  agencia Shalom, si aplica; (2) pegar o subir el comprobante y ejecutar la
  lectura; (3) cotejar imagen, monto, operación, fecha y cuenta receptora antes
  de registrar. En el primer pago se muestran únicamente `Adelanto` y
  `Pago total`; después solo `Diferencia` hasta cubrir el pedido.
- Cada salida conserva su propia tarjeta, courier, guía, QR, estado y resultado.
- Historial, devoluciones manuales y corrección de vínculos están plegados por
  defecto: siguen accesibles, pero no compiten con la acción operativa normal.
- Se reutilizan patrones familiares de Shopify: identidad y estado fijos,
  pestañas predecibles, acción contextual y divulgación progresiva.
- El flujo móvil de escaneo, cotejo y motorizados se diseña aparte. No se debe
  comprimir el drawer de escritorio y asumir que eso resuelve la operación móvil.

## 26. Costo de producto (COGS)

El módulo de Costos tiene tres ámbitos: costo logístico (§14), costo de producto
y costos adicionales. Esta sección define el costo de producto, que alimenta la
rentabilidad (§17) y es distinto del costo logístico de la conciliación (§14).

### Principios

1. **Kapta no crea productos** (principios 1 y 3): el producto es siempre el de
   Shopify. Costos de productos asigna un costo a lo que ya existe; nunca da de
   alta un producto.
2. **La identidad del producto es el SKU de Shopify**, tal como llega en
   `orders.line_items[].sku`. No hay tabla de catálogo propia: la lista de
   productos se deriva de los pedidos (`org_shopify_products`, 0094).
3. **Vigencia append-only** (principio 6): un costo es un número con fecha de
   inicio. Un cambio abre un periodo nuevo y cierra el anterior; nada se
   reescribe ni se borra.

### Comportamiento de la pestaña

- Lista los productos vistos en pedidos de Shopify, con su SKU en solo lectura,
  el número de pedidos y el estado del costo (asignado o sin asignar).
- No hay alta manual de productos ni de SKU. `Proveedor` y `Lote` son metadatos
  opcionales del costo, no la identidad del producto.
- El ámbito puede ser general (todas las tiendas) o una tienda concreta; la
  tarifa por tienda gana a la general al resolver (`resolveProductCost`).
- También muestra SKU que tienen costo pero ya no aparecen en Shopify, marcados
  como fuera de Shopify, para no ocultar nada configurado.
- Escritura solo para administradores (`costs.manage`), bajo el mismo patrón del
  resto del módulo de Costos.

### Cambios de costo en el tiempo

- Cada punto de cambio es una fecha de inicio de vigencia que cierra el periodo
  anterior y abre otro; el pedido usa el costo **vigente en su fecha**, no el
  último registrado (`resolveProductCost` resuelve por día).
- Se puede fechar un cambio hacia adelante o corregir el pasado con un registro
  nuevo; un periodo pasado nunca se reescribe.
- La pestaña muestra, por producto, la línea de tiempo de sus costos: cada
  periodo con su costo unitario, su fecha de inicio y, si cerró, su fecha de fin.

### Criterios de aceptación

- La pestaña muestra los SKU presentes en pedidos de Shopify sin teclearlos.
- Un producto sin costo vigente aparece como «sin asignar».
- Registrar un costo cierra la vigencia anterior del mismo SKU y abre otra desde
  la fecha indicada, sin alterar los costos ya aplicados a pedidos pasados.
- No es posible crear un producto que no exista en Shopify.
- El costo de producto nunca sustituye al costo logístico en la conciliación de
  liquidaciones.

## 27. Registro de motorizados

El motorizado es un actor operativo (§9, §14): recoge, entrega, hace el segundo
cotejo y liquida. Su ficha se gestiona en **Equipo**, en una pestaña propia,
separada del usuario de acceso.

### Principios

1. **La ficha del motorizado es distinta de su usuario.** Un motorizado puede
   existir sin login: se necesita para asignarlo en despacho y liquidar. Solo se
   le vincula un usuario si va a entrar a `/reparto` a cotejar y reportar sus
   paradas desde el celular.
2. **Se conserva, no se borra.** Un motorizado se activa o desactiva; nunca se
   elimina. Las rutas y liquidaciones pasadas conservan al motorizado que las
   ejecutó (principio 5 y 6).
3. **Propio o de transportadora.** La transportadora vacía marca un motorizado
   propio; con transportadora (Axel, Urpi, Swayp, Tanders, u otra) pertenece a
   ese courier.

### Ficha

- Nombre, celular, DNI, transportadora, tienda (o todas), activo/inactivo, nota
  y un usuario vinculado opcional.
- El DNI es único por organización.
- Vincular un usuario exige que ya sea miembro de la organización; un usuario se
  vincula a lo sumo a un motorizado. El vínculo es lo único que habilita
  `/reparto` (lo acota la RLS por `auth_rider_id()`), sin necesitar rol especial.

### Permisos

- Gestionar motorizados en Equipo: owner/admin (`riders.manage`). El alta rápida
  por nombre desde Liquidaciones sigue disponible bajo `settlements.manage`.

### En la Mesa de despacho

- El courier de la ruta se elige de una lista (Aliclik, Swayp, Shalom, Tanders,
  Axel, Urpi, Olva, propios). Swayp se guarda con el token legado `fenix` para
  que calce con `shipments.courier`, pero se muestra como «Swayp (antes Fénix)».
- Los motorizados propios se eligen **por su nombre**, en el mismo desplegable
  que los couriers y bajo su propia cabecera. No hay un segundo desplegable de
  motorizado: en los couriers externos la ruta es el courier.
- El manifiesto guarda `rider_id` y **copia el nombre** en `driver_name` al
  crear la ruta. Si después se renombra o desactiva la ficha, las rutas ya
  creadas no cambian: conservan a quién recibió físicamente los paquetes (§6.3).

## 28. Rótulos en lote

El almacén no imprime de a uno: prepara la tanda del día (§6.2). Desde el Master
se seleccionan varios pedidos y se descarga **un solo PDF** con todos sus
rótulos.

- Una página de **100 × 150 mm por rótulo**, el mismo formato del rótulo
  individual, para no reconfigurar la impresora de etiquetas.
- El rótulo pertenece a la **salida**, no al pedido: cada pedido aporta la salida
  que sigue bajo custodia de la empresa (la que se va a preparar) y, si no hay
  ninguna, la más reciente.
- Un pedido en `por_generar_rotulo` **todavía no tiene salida**, así que no
  aporta rótulo. La interfaz informa cuántos quedaron fuera por ese motivo en vez
  de fallar en silencio.
- **La selección sobrevive a las búsquedas.** La tanda del día se arma buscando
  pedido por pedido, así que vaciarla en cada búsqueda obligaba a imprimir de a
  uno. Lo que no puede pasar es imprimir a ciegas: la barra avisa cuántos
  seleccionados no están en la búsqueda actual y deja ver la lista completa con
  su nombre, sacando cualquiera de un clic.
- **«Seleccionar todos» alcanza solo la página visible**: el Master pagina en el
  servidor y no expone los identificadores del filtro completo, así que prometer
  «todos los resultados» sería mentir.
- La barra también **registra un estado sobre la selección**, con su detalle
  operativo, motivo y comentario opcionales. Es el mismo gesto de la gestión
  manual del drawer y **cae en las mismas reglas**: un pedido ya cerrado exige
  permiso de override y motivo. Existe porque cerrar la tanda de entregados y
  cobrados de la semana pedido por pedido son dos clics por pedido y ninguna
  forma de ver cuáles quedaron a medias.
- Aplicar un estado a la selección es un **cambio manual**, y por tanto congela
  cada pedido frente al recálculo. La barra lo advierte antes de aplicar: no es
  una etiqueta más, es sacarlos del seguimiento automático.
- Si el estado de un pedido falla, **su comentario no se escribe**. Un comentario
  sobre un pedido que no cambió parece constancia de algo que no ocurrió.
- Al terminar se informa **cuántos se aplicaron y cuáles no, con el motivo de
  cada uno**, y la selección se conserva para poder leer ese resumen.
- El QR impreso identifica la salida y es el que se escanea en ambos cotejos
  (§6.3). El contenido del rótulo se lee bajo RLS: una salida de otra tienda no
  aparece aunque se manipule la URL.

### La cabecera del rótulo

Arriba va **el nombre de la tienda** —Kenku Perú, Aurela— y debajo el código de
salida, con el **pedido de Shopify a su costado**. La tienda es la marca que el
cliente reconoce; «Kapta» no le dice nada a quien recibe la caja. El pedido y la
salida son el mismo dato leído de dos formas, así que comparten línea en vez de
gastar una fila entera del rótulo.

El courier **no** se imprime en la cabecera: cuando está decidido ya viaja dentro
del código (`KP123-S01-ALICLIK`), y cuando no lo está, un «POR DEFINIR» grande en
la etiqueta es ruido — quién lo decide es la Mesa de despacho, no quien lee el
rótulo.

### Las notas del pedido

La **nota de Shopify** va impresa a la derecha del QR. Es donde el asesor escribe
las instrucciones reales —«enviar con Tanders», «antes de la 1 y 30», el DNI para
una agencia— y quien arma la caja no las tenía en ninguna parte del papel: había
que abrir Shopify para enterarse. Las trae aproximadamente la mitad de los
pedidos, así que no es un caso marginal.

La instrucción del QR y su token bajan a **pie de página, en el tamaño más chico
del rótulo**: se leen una vez en la vida y estaban ocupando el mejor espacio.

Del destino se imprimen **distrito y provincia**. La región repite la provincia
en casi todo el país y gastaba una línea sin decir nada que el motorizado no
supiera.

### El monto a cobrar

Lo que hay que cobrar en la puerta es **el dato más importante del rótulo**:
cobrar de menos es plata perdida y cobrar de más es una devolución con el cliente
molesto. Por eso se imprime en un recuadro de ancho completo, arriba de todo, y
es **el texto más grande de la etiqueta** — más que el código de salida, más que
la dirección.

- La cifra es el **total del pedido** (`orders.total_amount`), el mismo importe
  que ya usan la ruta del motorizado y el cálculo de lo que cobra Aliclik.
- Cuando no se conoce el total —una salida sin pedido vinculado— el recuadro dice
  **«VER PEDIDO»**, nunca «S/ 0». Un cero impreso manda a entregar sin cobrar.
- El importe se dibuja al mayor tamaño que quepa en el recuadro, así que un
  monto de cuatro cifras se ve igual de bien que uno de tres.

### El reparto vertical del rótulo

Los datos se **miden antes de dibujarse**. Un rótulo de un solo producto quedaba
denso arriba y con un hueco grande justo encima del QR: además de feo, engañoso —
parece que falta información. Sabiendo de antemano cuánto ocupa todo, el espacio
sobrante se reparte como aire entre bloques.

Cuando en vez de sobrar **falta**, el orden en que se cede está fijado y no
depende del orden de dibujo: primero la **referencia**, luego el **distrito**,
después los **productos** y solo al final la **dirección**, que es lo que decide
si el paquete llega.

### El rótulo se imprime en PDF, no en HTML

**Existe un solo rótulo**, y es el PDF de 100 × 150 mm: el del lote y el de la
reimpresión individual son el mismo archivo. Pedir el rótulo de una salida
concreta lleva al mismo generador.

La razón es doble. Una página HTML se imprime a la medida que supone el
navegador —A4—, y el rótulo salía diminuto en una esquina de la hoja. Y un
segundo renderizador se queda atrás: el HTML se había quedado sin la tabla de
productos, sin la variante y sin el monto a cobrar. Dos rótulos distintos para el
mismo paquete son una fuente permanente de errores de almacén.

### Los productos del rótulo

El rótulo lo lee quien arma la caja, así que la lista de productos responde dos
cosas de un vistazo: **cuántos** y **cuál**.

- Va en dos columnas: **cantidad** y **producto**.
- Una cantidad **mayor a uno se imprime más grande** que una de una unidad.
  Empacar una unidad cuando iban dos es un reenvío completo, así que el número
  no puede leerse igual que el resto de la línea.
- La **variante** (talla, color, presentación) va en su propia línea, con su
  propia cantidad. Hay pedidos con varias líneas del mismo título que solo se
  distinguen por ahí, y sin ella el almacén no sabe qué empacar.
- Las variantes de un mismo producto van **agrupadas bajo un único título**. Los
  títulos de Shopify se recortan a una línea, así que repetirlo por talla
  escribía tres veces el mismo texto truncado —idéntico a la vista— y dejaba
  otros productos fuera del rótulo por falta de sitio.
- Si hay que recortar, se corta **por producto entero**: media lista de tallas es
  peor que ninguna, porque parece completa.
- Las líneas salen del pedido de Shopify, que es la fuente de la cantidad y de
  la variante. El texto guardado en la salida solo se usa cuando la salida no
  está vinculada a un pedido.
- Si no caben todas las líneas se indica cuántas faltan: el rótulo nunca calla
  que hay más producto del que muestra.
- Cuando los productos y la **referencia** no caben juntos, cede la referencia.
  El almacén no puede empacar lo que no ve escrito, mientras que la referencia es
  una ayuda para encontrar la puerta que el motorizado también tiene en la app.

### Pedir el rótulo crea la salida

El almacén no pide «una salida»: pide **el rótulo**. La salida es la
consecuencia interna de rotular, y por eso descargar los rótulos de una tanda la
crea cuando hace falta, sin preguntar courier ni fecha (§4).

Por cada pedido seleccionado:

| Situación | Qué ocurre |
| --- | --- |
| Ya tiene una salida en custodia de la empresa | Se **reimprime esa**; no se crea otra |
| No tiene ninguna salida | Se **crea** una sin courier decidido |
| Su última salida fue **devuelta** | Se **crea** una nueva: rearmar es reprogramación normal, no una salida simultánea |
| Tiene una salida **todavía en la calle** | No se crea nada: una salida adicional exige justificación auditada (§23) y se hace desde el pedido |

- **Reusar gana a crear**: pedir el rótulo dos veces no puede consumir el límite
  de cinco salidas del pedido.
- Reimprimir el rótulo de una salida concreta —papel perdido o dañado— se hace
  desde el pedido, que lista cada salida con su rótulo.

### Crear salidas en lote

Para que `por_generar_rotulo` se pueda resolver de una tanda, el Master permite
crear la salida de varios pedidos a la vez, con un solo courier y una sola fecha
—el caso real del almacén: «todos estos salen hoy con motorizado propio».

- Solo couriers de rótulo interno: motorizado propio, Axel, Urpi y Olva. Los que
  tienen API propia (Aliclik, Shalom, Tanders) conservan su flujo.
- **Las reglas no cambian por ser un lote**: se siguen aplicando el máximo de
  cinco salidas (§4), el motivo obligatorio cuando el pedido ya tiene una salida
  activa, la política de repetición por modalidad y el adelanto validado de
  Olva (§12). El lote reutiliza la misma operación que la salida individual para
  que no existan dos verdades sobre cuándo se puede crear una salida.
- Un pedido que no cumple **no detiene a los demás**: la tanda informa cuál falló
  y por qué, pedido por pedido.
- Al terminar se descargan los rótulos de las salidas creadas en el mismo gesto.

