# Master Operations Map — Master de Pedidos v1

Estado: Fase 4 implementada; macroetapa Por confirmar cerrada funcionalmente;
modelo Grupo GF Courier definido para implementación incremental; tiendas
cliente de otra organización aprobadas, sin implementar (§29.15)
Propietario del proceso: Frankz  
Sistema: Kapta (`kapso-sales-dashboard`)  
Fuente visual: board Miro «Master Operations Map»  
Última consolidación: 2026-08-30

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

**No todos nacen de una conversación.** Desde agosto de 2026 las dos tiendas
venden también por un formulario COD en la web (EasySell, etiqueta
`easysell_cod_form`): 591 pedidos y S/93.677 en los 30 días previos al
11-09-2026, de los cuales 488 no tienen lead ninguno. Para el Master no cambia
nada —los 591 están en `order_master` y 499 ya tienen guía—, pero sí para todo
lo que se calcula recorriendo leads: ese camino no los ve. El anuncio que los
trajo viaja en `orders.utm_meta`, y las reglas para leerlo están en
`lib/cod-cart-attribution.ts`.

### Salida

Intento físico de entregar un pedido. Una salida corresponde a un paquete, un
QR estable, un courier o motorizado y, cuando exista, una guía externa.

### Guía externa

Código emitido por Aliclik, Swayp, Shalom, Olva, Tanders, Axel, Urpi u otro
courier. No es la identidad interna de la salida.

### Paquete

Bolsa o caja física correspondiente a una salida. La versión v1 soporta un solo
paquete por salida.

### Pedido acompañante

Pedido que viaja dentro de la caja —la salida y su guía— de otro pedido, el
principal: una sola guía cobra los dos. La salida sigue siendo del principal;
el acompañante no tiene salida propia y hereda el estado de esa caja (§32).

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
  solo acierta con una proporción, y la de cada courier es la suya.
- **La página del rótulo de agencia termina donde termina el contenido**, y sus
  márgenes son estrechos. Se imprime cuatro por hoja en A4, y ahí manda el
  ancho: la celda son 105 mm, la página 100, así que sale casi 1:1 y la etiqueta
  del courier vale exactamente el ancho útil que se le deje. Cada milímetro de
  margen y cada milímetro en blanco al pie salen impresos y se pagan en tamaño.
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
- **Cada courier al que se le pueda escribir una guía tiene que tener su propio
  botón de anular, y la ausencia de uno no es un hueco cosmético: cierra ventas.**
  Swayp no lo tenía. Su guía directa se escribe sobre la salida `por definir`
  como las demás, y al rellenarla dejan de ofrecerse los dos botones que existían
  —«Anular salida» porque cambió la vía, «Anular» porque es de Shalom—, así que
  no quedaba ninguno. El único alcanzable era el de Envíos, cuya disposición
  «cancela» significa otra cosa: **que la clienta canceló la venta**. Registrado
  eso, el pedido cae a `anulado` por ser su única salida real y el courier
  siguiente se niega a emitir. Es la forma de #KP127639 llegando por una tercera
  puerta, y le pasó a #AUR176830 el 15-09-2026.
- **Anular la guía de una salida RELLENADA la devuelve a `por definir`; no la
  anula.** La caja sigue armada, rotulada y en el almacén: lo único que dejó de
  ser cierto es quién la lleva. Conserva su consecutivo, su QR y su avance de
  preparación, y el pedido queda listo para recibir otra guía sin gastar una de
  las cinco salidas. Si la guía nació directa —sin salida previa que rellenar—,
  anularla sí cierra la salida, que es lo que es. Se distingue por el EVENTO de
  relleno, nunca deduciéndolo de la forma de la fila.
- Cuando el courier **sí tiene la guía**, se cancela allá primero y solo entonces
  acá. Una guía viva en el courier y anulada en el panel es la peor de las dos
  mentiras: nadie la busca y el paquete sale igual.
- El courier y la fecha son metadatos visibles; no forman parte del token QR.
- El código de guía externa se conserva separado.
- El límite global acordado es cinco salidas por pedido.
- Una salida de Aliclik puede llevar, además de su pedido, **pedidos
  acompañantes** de la misma clienta (§32). No es otra salida de ellos: es la
  misma caja, con una guía que cobra los dos, y el acompañante la hereda.
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
- **Un punto COD lo siembra una ENTREGA, no una cotización.** El mapa de
  `aliclik_cod_points` solo admite guías con `delivery_status = 'entregado'`.
  Cotizar no es entregar: hasta la 0149 bastaba con que la guía tuviera precio,
  y dos guías creadas y anuladas el 31-jul-2026 dejaron a **todo Tumbes**
  clasificado como Provincia COD cuando Aliclik no ha entregado allí ni una vez
  —las cuatro entregas del departamento son de Shalom—.
  - Medido al cambiarlo: de 954 puntos quedan 764. La única región que pierde
    cobertura es Tumbes; Arequipa, Trujillo, Chiclayo, Piura, Huancayo y Juliaca
    conservan los suyos, porque allí una dirección fallida está rodeada de
    entregas buenas. Por eso **no** se borran «los puntos que fracasaron» —eso
    sería ruido en esas ciudades—: se cambia qué siembra un punto.
  - Una zona con guías en curso y ninguna entregada todavía no siembra punto, y
    es lo correcto: la cobertura se declara cuando se ha entregado una vez, y se
    corrige sola en cuanto llegue la primera.
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
  justificación corta. **Salvo cuando el pin señala otro departamento** y ni el
  desplegable del checkout ni la ciudad escrita lo respaldan: ahí el pin es el
  destino y la guía no sale sin una excepción escrita (§10).

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

**Los contadores cuentan lo mismo que la lista (29-09-2026).** Con cualquier
filtro puesto en el Master —tienda, courier, región, estado operativo, fechas…—
el número de cada pestaña de macroetapa, el de «Todos» y el de cada chip de
subetapa es cuántos pedidos de esa etapa pasan esos filtros, con la misma
definición que la tabla (`applyServerFilters`). Sin filtros se cuenta todo el
Master de las tiendas visibles. La búsqueda sigue aparte: mientras se busca, las
pestañas no se muestran.

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
  no una hora. Vencidos, hoy y próximos forman colas operativas.

#### Ciclo automático de recontacto

- Un pedido en confirmación **con gestión** y **sin fecha pactada** vuelve a la
  cola cada `confirmation_cycle_days` días contados desde el último contacto.
  El ciclo se configura por tienda y su valor por defecto es **3 días**.
- El ciclo se cambia desde el Master, dentro del panel de **Más filtros**, y
  también desde Ajustes de la tienda. Lo mueve **owner o admin de la
  organización de esa tienda**: reparte la carga diaria de todo el equipo, así
  que no es una preferencia de quien mira la pantalla. Los demás lo ven.
- **El mando se guarda; el hecho no.** El control vive plegado porque es un
  ajuste de tienda que se toca una vez cada mucho, y en la fila de los chips le
  robaba un renglón a los cuatro números de la cola, que son lo que se mira todo
  el rato. Que un pedido llegara por ciclo sí se ve sin abrir nada: la columna
  `Próximo contacto` y el aviso del drawer lo dicen en cada pedido. Esconder
  también esa marca convertiría el ciclo en algo que mueve la cola sin que nadie
  sepa por qué.
- El Master es consolidado y el ciclo es por tienda: con varias tiendas a la
  vista el control se lee pero no se edita. Ofrecer un valor único sobre dos
  tiendas daría a elegir algo que no existe.
- Al cambiarlo se reescribe `confirmation_cycle_due_on` de los pedidos en
  confirmación de esa tienda en el acto. Es la misma regla del barrido, aplicada
  ya: sin eso la cola seguiría repartida con el ciclo anterior durante horas.
- El ciclo es una **derivación**, no un compromiso: se calcula en cada barrido
  del Master (`confirmation_cycle_due_on`) y nunca sustituye a
  `confirmation_next_contact_on`, que es el hecho que alguien pactó en una
  llamada. Si el intento dejó fecha, manda la fecha y no hay ciclo.
- **La fecha pactada vence; el ciclo y el recordatorio no.** Una fecha pactada
  incumplida se queda en `Vencidos` porque es una promesa al cliente que hay que
  ver, y es lo ÚNICO que hay en `Vencidos`. Un día de ciclo que ya pasó
  significa «toca hoy»: el pedido aparece en `Hoy` y, al registrarse el
  intento, el siguiente ciclo se cuenta desde ese contacto.
- **`Hoy` es la lista que se lleva a cero.** Cada llamada saca al pedido de
  `Hoy` y una regla de reencolamiento lo devuelve: `Sin respuesta` o `Se deja
  mensaje` fijan el recordatorio de dos horas y el pedido pasa a `Próximos`
  hasta esa hora; llegada la hora vuelve a `Hoy`. Pactar fecha lo manda a
  `Próximos` hasta la fecha. Cualquier otro resultado sin fecha lo deja al
  ciclo. `Próximos` es la fuente que alimenta a `Hoy`, no un cajón aparte.
- **El recordatorio no vence.** Llegada su hora, el pedido está en `Hoy` —se
  haya cumplido hace un minuto o hace tres semanas— y ahí se queda hasta que
  alguien lo rellame. Un reintento que nadie hizo es trabajo pendiente, y el
  sitio del trabajo pendiente es la lista que se trabaja, no `Vencidos` ni el
  ciclo. Antes el recordatorio de hoy pasado caía en `Vencidos` y el de días
  atrás cedía al ciclo: medido el 16-09-2026, los 24 de `Vencidos` eran
  recordatorios de hoy de pedidos contactados hoy —cero fechas pactadas—, y
  111 reintentos olvidados estaban escondidos en `Próximos` por el ciclo.
- Orden de mando de la cola: **fecha pactada → recordatorio → ciclo → sin
  ninguna, Hoy**.
- `Sin llamar` no entra en el ciclo —sin un solo contacto no hay desde cuándo
  contar— pero **sí está en `Hoy`**: la primera llamada es trabajo de hoy, y la
  más importante. Su chip propio en SUBETAPAS sigue separándola para atacarla
  aparte. Antes vivía fuera de las tres colas y la fila de Fecha pactada no
  sumaba el total: medido el 20-09-2026, «Todos los plazos» 275 contra
  0 + 172 + 11 = 183, y los 92 que faltaban eran exactamente los de `Sin
  llamar`. Que `Hoy` llegue a cero tiene que significar que el día está hecho.
- La cola de Fecha pactada es de `Por confirmar`. El filtro `cq` sobrevive al
  cambio de pestaña, así que tanto el filtro como su espejo en la base lo acotan
  a esa etapa: un pedido entregado tampoco tiene fechas de confirmación, y no
  por eso «toca llamarlo hoy».
- El ciclo no gasta días de gestión ni acerca el `Último intento`: solo el
  §6.1 —un día distinto CON gestión— gasta cupo. Un pedido puede rotar por
  ciclo muchas veces sin pasar de 1/7 si nadie lo llama, y eso es exactamente
  lo que el número tiene que seguir diciendo.
- Provincia COD queda confirmada al validar producto, cantidad, monto, fecha
  aproximada y dirección de entrega.
- Agencia queda confirmada solo cuando el pago exigido ha sido validado.
- **Confirmación expresa de agencia.** Un pedido con las TRES cosas —documento
  del cliente, sucursal de destino elegida y el adelanto mínimo validado (un
  `total`, o un `adelanto` que con sus diferencias suma el mínimo, §12)— queda
  confirmado por los hechos y pasa a Preparación sin necesidad de
  que nadie marque «Confirmó el pedido». Se registra como evento `confirmed` con
  `source: automatico` y la nota nombra la evidencia.
  - Las tres son necesarias. El borrador se guarda en cuanto se teclean el
    documento y la sucursal, así que sin el pago la asesora puede estar todavía
    negociando: **el dinero es lo que convierte la conversación en compromiso**.
  - Una `diferencia` sola, sin un `adelanto` vivo detrás, no compromete. Pero
    **sí suma para el mínimo** cuando hay adelanto: el formulario registra
    como `diferencia` todo Yape posterior al primero, así que un abono partido
    en S/ 10 + S/ 20 es el mismo compromiso que uno de S/ 30. Hasta la
    `mom-v1.21` (29-09-2026) solo contaba la fila `adelanto`, y #KP134162 —S/ 10
    + S/ 20 validados, siete días marcando «Confirmó el pedido»— se quedó en
    Por confirmar · Último intento con «Adelanto cargado»; ni pagando el total
    habría salido.
  - No mira la cobertura. La evidencia de que el envío va a agencia es el
    borrador con su terminal elegida, no la etiqueta del clasificador: un pedido
    puede estar clasificado `provincia_cod` e irse por Shalom.
  - Por qué: ninguna de las tres se consigue sin el cliente al teléfono, y la
    del pago no se consigue sin que además mande dinero. Medido sobre los 702
    pedidos que llegaron a tener las tres, 427 se entregaron, 198 iban en
    proceso, 74 seguían pendientes y solo **3 se cayeron** (2 anulados, 1
    devuelto): la regla acierta el 99,6 %. Antes, el clic que faltaba dejaba
    pedidos ya pagados esperando hasta 69 horas, y el 36 % de los pedidos de
    agencia llegaba a Preparación sin ninguna gestión registrada.
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
- **El congelamiento es frente a lo automático, no frente a otra persona.**
  Anular el pedido en Shopify también lo decide alguien, así que entre dos
  decisiones humanas manda la más reciente: una anulación **posterior** al cambio
  manual lo deja sin efecto y el pedido pasa a `anulado`; un cambio manual
  posterior a la anulación sigue mandando —es el caso de «lo anularon por error y
  lo reactivo»—. Con el mismo sello de tiempo gana el override, porque no hay
  forma de saber cuál fue después. Al ceder, el pedido se resuelve por la cadena
  normal: la anulación no gana prioridad nueva, solo deja de estar tapada, y
  «entregado es pegajoso» le sigue ganando. El candado del drawer marca si el
  cambio manual **gobierna**, no si existe: sobre un pedido anulado después se
  suelta. Sin esto, en #KP126722 un «Pendiente · no responde» del 12/08 mantuvo
  en la cola operativa —llamable y despachable— un pedido de S/ 99 que en Shopify
  ya no tenía ni productos.
- **Registrar una salida también lo decide alguien**, así que cede igual. Una
  guía registrada **después** del cambio manual lo deja sin efecto; registrada
  antes, el cambio manual sigue mandando. Lo que NO suelta el candado es el
  reporte de un courier (`courier_status`): es exactamente de lo que protege, y
  la diferencia no es de criterio sino de dato —los `guide_registered` y
  `guide_created` llevan actor los 3.672 de los últimos 30 días, y los 15.969
  `courier_status` no lo llevan ni uno—.
  Sin esto, ocho pedidos de Agencia marcados a mano «disponible para recojo» y
  con su guía Shalom registrada días después seguían figurando como «En curso ·
  recibido por courier» estando recogidos: el estado legado se quedaba en
  `en_proceso` y `recogido_sin_pago_completo` (§6.5) exige `entregado`, así que
  la alerta crítica no llegaba a encenderse. Medido sobre el resultado ya
  recalculado: **31 pedidos con guía posterior al candado, de los que 8
  (S/ 1.439) aparecieron en la alerta de cobro**. La estimación previa al cambio
  decía «11 pedidos y S/ 1.062» y salió mal en las dos direcciones; queda escrita
  la medida, no la estimación.
- **Vincular un pedido acompañante también lo decide alguien** (§32, regla 7):
  `companion_linked` cede el candado anterior en los dos pedidos, como un
  registro de guía. Los cuatro casos que lo motivaron tenían justo un «Cambiar
  estado» usado como nota —«comparte guía con…»— congelando a los dos.
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
- **Cada cambio de etiqueta deja un evento en el pedido**, aunque el estado
  traducido no cambie. `TO_PREPARE → PREPARED → IN_TRANSIT → IN_AGENCY → PICKED`
  se traducen casi todos a `en_ruta`, y mirando solo el estado nuestro la
  Actividad enseñaba un «en ruta» y nada más mientras el panel de Aliclik
  mostraba Preparado, Recolectado, En agencia y Validado con su hora
  (`AUR5X250809378012`, 15-09-2026). La API trae cada paso; ahora cada uno queda
  registrado, fechado con el `updatedAt` de Aliclik y con la etiqueta cruda en
  la nota. No es ruido: un snapshot igual al último aplicado se despacha antes
  sin dejar evento (solo sellos de lectura), así que una etiqueta distinta de la
  guardada es siempre un cambio real. La granularidad es la del barrido (20
  minutos), no la del panel.
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
  **Y el mismo `NO CONTESTA` no la saca de la cola** (`statusAfterFailedAttempt`):
  una guía `pendiente` con un intento fallido entrante se queda `pendiente`. Sin
  esta segunda mitad la primera rebotaba: el barrido relee cada guía cada 20
  minutos —dos veces, porque las dos tiendas listan los mismos pedidos— y el
  mismo snapshot reabría la guía en una lectura y la avanzaba en la siguiente
  (medido el 11-09-2026: 90 guías, 430 cambios de estado por hora de madrugada,
  un recálculo del Master en cada uno). Sale de la cola cuando la asesora la
  reprograma (Envíos la pone `en_ruta` con fecha) o cuando el courier reporta
  algo que no sea un intento fallido.
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
- `recogido_sin_pago_completo` — alerta crítica. **Qué cuenta como cobrado**: el
  comprobante Yape completo, o `financial_status = 'paid'` en Shopify sin
  reembolso. Lo segundo hace falta porque en Agencia la clienta paga en el
  mostrador, que no deja ni comprobante ni pasarela: mirando solo los dos
  primeros canales la alerta se encendía sobre pedidos ya cobrados. Medido el
  14-09-2026: de **651 pedidos y S/ 111.707** en la alerta, **569 (S/ 96.497)
  estaban `paid`**; sin rastro de cobro quedan **80 (S/ 15.022)** y 2 anulados
  (S/ 188). Que `financial_status` vale como prueba de cobro en Agencia está
  medido y no supuesto: lo tiene el 87,7 % de los recogidos por cerrar y el
  89,4 % de los recogidos finalizados, contra **0 % de los 1.642 anulados o
  devueltos**, y solo el 9-10 % de los pedidos de cada mes.
  **Esta regla laxa no se extiende** a cuánto cobra el courier en la puerta
  (`expectedCollectAmount`) ni al abono que Agencia exige para pasar a
  Preparación (§6.1): ahí el pedido aún no se ha recogido y equivocarse cuesta
  dinero, no una llamada de más.
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
| Motorizado propio asignado con custodia, sin «Lo llevo» | En curso | En tránsito |
| Motorizado propio dijo «Lo llevo» | En curso | En reparto |
| Motorizado propio reportó la parada entregada, ruta sin cerrar | Por cerrar | Validación de cierre pendiente |
| Motorizado propio reportó reprogramado o «no estaba» | En curso | Por reprogramar Lima |
| Motorizado propio reportó no entregado, rechazo incluido (v1.23) | En curso | Por reprogramar Lima |
| Cualquier courier de Lima anuló la guía con la caja ya fuera (v1.23) | En curso | Por reprogramar Lima |
| Ruta cerrada con la parada entregada, sin liquidar | Por cerrar | Pendiente de liquidación |
| Aliclik retornando y Swayp repartiendo | En curso | En reparto |
| Una salida entregó y otra sigue activa | Por cerrar | Salida adicional activa |
| Entregado, courier aún no liquidó | Por cerrar | Pendiente de liquidación |
| Shopify anulado, paquete aún con courier | Por cerrar | Devolución física pendiente |
| Shopify anulado, nunca se despachó | Finalizado | Anulado cerrado |
| Pedido acompañante con la caja del principal aún en la empresa (§32) | Preparación | Viaja en la caja de otro pedido |
| Pedido acompañante con la caja del principal entregada, sin liquidar (§32) | Por cerrar | Pendiente de liquidación |

**Una salida devuelta no cierra el pedido si otra sigue viva (v1.19,
29-09-2026).** El estado del pedido daba «Devuelto» en cuanto UNA salida
volvía con evidencia (despacho, guía y retorno), aunque otra salida siguiera en
marcha: el paquete que volvía mandaba el pedido a «Por cerrar · Devolución
física pendiente» con el reenvío ya en la calle. Contradecía el principio 7 y el
ejemplo de arriba («Aliclik retornando y Swayp repartiendo» es En curso). Medido
el 29-09-2026: 86 reenvíos Swayp de provincia estaban así. Ahora `devuelto`
exige además que no quede ninguna salida viva (`pendiente` o `en_ruta` sin
retorno); con una viva el pedido sigue en proceso y manda esa salida. Sin esto,
la salida nueva de Grupo GF para un pedido que Tanders devolvió (§9) lo habría
sacado de la lista nada más tomarlo.

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
| 1 | Sugerir adelanto de S/20 |
| 2 | Exigir adelanto de S/20 |
| 3 o más | Exigir pago completo |

El monto del adelanto de la escalera es **el mismo mínimo de agencia**
(`ADELANTO_MINIMO`, hoy S/20): la compuerta de Aliclik lee `payment_state`,
que se deriva de esa única constante. No son dos números que puedan moverse
por separado.

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

### 8.2 Dos rechazos en la puerta cierran Aliclik para siempre

Un cliente cuyo teléfono acumula **dos o más pedidos rechazados en la puerta**
no puede volver a salir por Aliclik. Nunca. **No se puede exceptuar**: ni
vendedora, ni admin, ni owner pueden levantarlo desde la aplicación. Le quedan
**Shalom, Olva o Swayp/Fénix**.

«Rechazado en la puerta» es el código `REFUSED` de Aliclik y solo ese: el
motorizado llegó, el cliente vio el producto y no lo quiso. `NOT_RESPOND`,
`CANCEL` y `ANNULLED` terminan igual de mal pero no son lo mismo — a quien no
contestó se le vuelve a intentar.

**Por qué solo Aliclik.** Es la única ruta que cobra el intento fallido: el
flete se paga aunque el paquete vuelva. El cliente puede seguir comprando, solo
no por la ruta que nos cuesta cuando falla.

**Por qué el segundo y no el primero.** Medido el 25-09-2026 sobre los reenvíos
que siguieron a un rechazo: 12 en total, 4 entregados, 6 caídos por otra causa
y 2 rechazados otra vez. Un tercio se recupera, así que el primer rechazo no
cierra la ruta — ahí sigue mandando la escalera de adelanto del §8.

**Es un eje distinto al del §8 y no se mezclan.** La escalera pregunta *cuánta
plata* hay que exigir por adelantado y se exceptúa con justificación. Esta
regla pregunta *por qué ruta* puede salir y no se exceptúa. Un cliente con el
pago completo validado sigue sin poder ir por Aliclik.

**La cuenta no espera a que el paquete vuelva.** Esto es lo que falló antes de
la regla: la tabla de riesgo del §8 cuenta `anulado + devuelto` leyendo
`general_status`, y 92 de las 133 guías con `REFUSED` estaban en `en_proceso`.
Un rechazo no pesaba hasta que el paquete terminaba de volver, semanas después,
y en esa ventana salieron las segundas guías de los dos únicos clientes que
rechazaron dos veces (#AUR175450 → #KP131487 el 31-08; #KP128958 → #AUR177007
el 15-09). El conteo del §8.2 mira la etiqueta del courier, que es el hecho: el
cliente lo rechazó el día que lo rechazó.

Se cuentan **pedidos, no guías**: un pedido reintentado arrastra la etiqueta a
la guía nueva, y eso es una venta rechazada, no dos. Ante la duda la cuenta
baja, porque el bloqueo no tiene marcha atrás.

Si el historial de guías **no se puede leer**, eso no es cero: la creación de la
guía Aliclik se rechaza con ese motivo. «No lo sabemos» no autoriza. El conteo
se lee bajo la misma RLS que el resto de la ficha (`shipments`, por tienda).

Corregir un bloqueo mal puesto se hace **sobre el dato** —la etiqueta de la
guía— y no sobre el permiso. Es el precio de que la regla no se pueda ablandar
a las 7 de la tarde con el pedido esperando.

### 8.3 Otro pedido del mismo producto todavía despachado (01-10-2026)

Decisión aprobada por el owner: en **Provincia COD**, crear otra guía Aliclik
queda retenido cuando otro pedido del mismo teléfono tiene el mismo producto
y variante en una salida físicamente despachada que todavía no se entregó ni
regresó. Se revisan las tiendas accesibles de la misma organización. Una
coincidencia de SKU permite reconocer el producto entre tiendas; dentro de la
misma tienda manda la variante Shopify. Basta un producto coincidente, aunque
las cantidades o el resto de la canasta difieran. No hay ventana de siete días:
la retención dura lo que dure el paquete pendiente.

Una guía creada pero sin despacho no activa esta regla. Tampoco un envío ya
entregado o recuperado. Cancelar en Shopify, cerrar la guía o solicitar retorno
no prueba que la caja volvió. Se revisan todas las salidas del otro pedido.

La operadora registra una resolución con motivo, actor, fecha y las salidas
concretas que revisó:

- **Solo quiere el anterior:** el nuevo sigue retenido; su cancelación se
  tramita por el procedimiento habitual, sin cancelar Shopify automáticamente.
- **Quiere ambos:** confirmación explícita registrada y al menos el adelanto
  mínimo vigente validado en el pedido nuevo. Un comprobante pendiente o el
  pago del primer pedido no sirven. El pago se vuelve a comprobar al crear.
- **Reemplaza al anterior:** sigue retenido hasta que conste la recuperación
  física o entrega del envío anterior. Solicitar detenerlo no lo libera.
- **Excepción autorizada:** exige el permiso `master.override_status` en la
  organización del pedido y un motivo. La autorización solo vale para los
  productos y salidas revisados; un cambio exige nueva revisión.

La retención se comprueba en el servidor antes de escribir hacia Aliclik y se
muestra en confirmación y en el panel de creación. Una confirmación genérica o
una excepción de antecedentes no la levantan. Si no puede verificarse el dato,
no se crea la guía. Esta excepción tampoco levanta el veto de dos rechazos del
§8.2. Cotizar o vincular una guía que ya existe siguen siendo operaciones
distintas; la regla impide emitir una nueva. Lima y los demás couriers conservan
sus reglas. Las resoluciones quedan en `order_events`, sin borrar historial.

## 9. Lima

- Todos los pedidos entran directamente a Preparación.
- Almacén arma todos los pedidos del turno.
- Seguimiento Lima decide el courier; la asignación automática será inicialmente
  una sugerencia.
- Un no entregado pasa a `Por reprogramar Lima`.
- Seguimiento Lima vuelve a llamar, elige otro courier permitido y solicita un
  nuevo armado si el paquete anterior todavía está con el courier.
- No es obligatorio esperar la devolución anterior para crear otra salida.
  Tampoco el reporte ni la liquidación de la ruta del otro courier: si Grupo GF
  no entregó hoy, el pedido puede salir mañana por Tanders o Swayp con la caja
  de Grupo GF todavía en la calle.

#### Lo que Tanders no entrega también es «Por reprogramar Lima» (v1.19, 29-09-2026)

**Despachos de Tanders de días anteriores sin entrega (decisión del owner,
01-10-2026).** En Lima, «Desde la lista» también ofrece para revisión los
pedidos En curso · En tránsito cuyo courier actual es Tanders y cuyas salidas
activas de Tanders fueron despachadas antes de hoy, según el día de Lima.
Casos: #KP137018 y #KP135818. Los entregados (#KP137017), anulados, despachos
del mismo día y pedidos con otra salida activa quedan fuera de esta excepción.

**El día de reparto de Tanders y el siguiente día hábil (02-10-2026).** Tanders
reparte el día en que recolecta. Mientras la guía está Pendiente, y hasta que
termina su día de reparto, el paquete es de Tanders: Grupo GF no puede agregarlo a
una ruta, y el escaneo lo rechaza porque el pedido ya tiene una salida de otro
courier (#KP136944, recolectado el 02-10 a las 9:28). Queda disponible el
**siguiente día hábil**. El único día no hábil es el **domingo**; los feriados se
trabajan. Recolectado el viernes, libre el sábado; recolectado el sábado, libre
el lunes. La fecha de recolección es la que Kapta anota como despacho al leer el
estado de Tanders (cada hora).

**Una guía que Tanders nunca recolecta también se libera (03-10-2026).** Se da
por hecho que Tanders la repartiría el siguiente día hábil después de crearla
(la fecha de creación la devuelve Tanders al crear la guía). Si termina ese día
y la guía sigue **Pendiente**, el paquete queda libre el día hábil siguiente, con
la misma regla del domingo: creada el jueves, libre el sábado; creada el
viernes, libre el lunes; creada el sábado, libre el martes. Aparece en «Desde la
lista» como **«Tanders · sin recolectar · guía del …»** y pide la misma
confirmación por pedido —el paquete está en el almacén, o saldrá otro—. La guía
de Tanders no se anula sola: si después la recolectan, se concilia por el
circuito de siempre.

**Una guía Swayp que su bodega no despachó, igual (decisión del owner,
03-10-2026).** #KP138099 (Lurín) tenía la guía directa 50000142751 escrita sobre
su salida KP138099-S01. Swayp la dejó en **Novedad (6)** con la novedad **20,
«Bodega no despachó mercancía»**: el paquete nunca salió y la caja estaba en
nuestra oficina. El barrido lee toda Novedad como «el paquete está con el
mensajero» y le selló salida y custodia del courier, así que el pedido quedó
«En curso · En reparto»; Novedad no abre la recuperación (§9, v1.22), «Anular
guía Swayp» se niega con la caja «ya salida», y el escaneo de Grupo GF respondía
«El pedido ya avanzó y salió de Pedidos disponibles». Nada lo destrababa.

- El día de reparto que Swayp le puso (la salida que anotó el barrido) es suyo.
  Si termina y la guía **sigue en Novedad 20**, el paquete queda libre el
  **siguiente día hábil**, con la misma regla del domingo que Tanders.
- Aparece en «Desde la lista» como **«Swayp · bodega no despachó · reparto del
  …»** y pide la misma confirmación por pedido: **el paquete está en el
  almacén**, o saldrá otro. El escaneo o una llamada directa sin esa
  confirmación lo rechazan diciendo que la bodega de Swayp no lo despachó.
- Grupo GF crea una **salida nueva con su rótulo** (la S01 es de la guía de
  Swayp) y el motivo de salida adicional se escribe solo.
- **Solo la novedad 20.** Cualquier otra novedad dice que el mensajero tiene el
  paquete, y «Reprogramado» que Swayp vuelve otro día (#KP137814): esas se
  resuelven desde Envíos. Si Swayp mueve la guía —Devolución abre la
  recuperación, Reparto la revive— deja de ofrecerse.
- La guía de Swayp **no se toca sola**: resolver su novedad («Devolver al
  remitente») sigue siendo una decisión de Envíos, para que Swayp no la
  despache después. Implementación: `swaypUndispatchedReview`,
  `lib/gf-tanders-review.ts`.

- Se muestran como **«Tanders · despacho anterior · sin entrega»**, con la fecha
  de despacho. La fecha de la caja elegida no adelanta esta disponibilidad.
- Antes de asignar a Grupo GF se exige confirmar **por pedido**, sin selección
  predeterminada, si el paquete volvió al almacén o si saldrá otro mientras se
  recupera el anterior. El servidor revalida el estado y las salidas confirmadas;
  el escaneo o una llamada directa no omiten este requisito.
- Se crea una salida nueva con rótulo propio y armado pendiente, respetando el
  máximo de cinco salidas. La confirmación, el actor y las salidas de Tanders
  quedan en el historial; si todavía hay una salida viva, se registra el motivo
  de salida adicional.
- Mostrar el pedido no cambia su macroetapa ni declara fallida, devuelta o
  anulada la guía de Tanders. La confirmación de almacén se conserva como
  declaración del operador; la recepción física y la conciliación del paquete
  anterior mantienen su circuito habitual. No se sobrescribe la salida original.

Hasta la v1.18 «un no entregado pasa a Por reprogramar Lima» solo se cumplía
con el motorizado propio. Cuando Tanders no entregaba, el pedido se quedaba en
**«En curso · En retorno»** mientras la caja volvía y pasaba a **«Devuelto ·
Por cerrar»** al llegar: fuera de la lista de Grupo GF, como si la venta hubiera
terminado. Pasó con #KP135035 (volviendo) y #KP135161 (ya devuelto); medidos el
29-09-2026, 24 volviendo y 62 devueltos sin anular en Shopify.

Decisión del owner (29-09-2026):

- **Entra desde «En retorno»**, sin esperar la caja: Tanders `RETURNING` o
  `RETURNED` abre la recuperación del pedido (`pendiente_nuevo_courier`) igual
  que la guía Aliclik fallida del §11. Es la misma regla
  (`lib/reproprovincia.ts`), así que el Master y cualquier otra pantalla la leen
  igual. Si Tanders vuelve a `PICKED` y reintenta, la guía está viva otra vez y
  la recuperación se apaga: manda el estado actual de Tanders, no la custodia.
  Desde el 02-10-2026 la custodia también lo sigue: de `retorno` vuelve a
  `courier` con un `PICKED`/`DELIVERED` (`reconcileTandersCustodyState`), la
  única vez que la custodia retrocede. Antes se quedaba en `retorno` y el
  Master mostraba «En retorno» guías que Tanders estaba repartiendo. `devuelto`
  no retrocede nunca.
- **La ventana es de 65 días** (`TANDERS_RECOVERY_DAYS`), la antigüedad de
  Tanders en la operación. Como su API no dice cuándo empezó a volver, se
  cuenta desde la **salida** del intento fallido: es fija y anterior al fallo,
  así que la ventana nunca se acorta ni salta al llegar la caja. Vencida, el
  pedido cae por su cadena normal a Por cerrar con `recuperacion_vencida`.
- La anulación en Shopify gana, como siempre: un pedido anulado no se
  reprograma.
- El paquete que vuelve sigue siendo inventario por conciliar: `Devolución
  pendiente de inventario` convive como razón mientras dura la gestión.
- En Despacho del día aparece en **«Desde la lista»** y en la tarjeta **«Por
  reprogramar»**, con la chapa «Tanders no entregó · vuelve / volvió» (§29.13).

#### Lo que Swayp no entrega, también (v1.22, 29-09-2026)

#KP135009 seguía **«En curso · En tránsito»** con su guía 50000139816 en
DEVOLUCIÓN en el panel de Swayp. Kapta nunca se enteraba: el webhook de Swayp
solo ha mandado entregas, y las 147 guías vivas seguían en el estado 1. Leídas
del tracking de Swayp el 29-09-2026, 94 estaban en Devolución, 17 en Devolución
confirmada y 1 con cobro. Ahora el estado se lee de su API (§11.2, «El estado de
Swayp se lee de su API»), y lo que Swayp no entregó sigue la misma regla que
Tanders:

- **Devolución (8), Devolución confirmada (9) y con cobro (12) abren la
  recuperación** (`swaypGuideFailed`, `lib/reproprovincia.ts`), desde que el
  paquete empieza a volver, sin esperar la caja. Novedad (6) no: el paquete
  sigue con el mensajero esperando instrucción (§11.2). La excepción es la
  novedad 20, «Bodega no despachó mercancía», que se libera a Grupo GF tras su
  día de reparto (§9, 03-10-2026). Cancelada (10) tampoco: no dice que saliera.
- **En Lima va a «Por reprogramar Lima»** y a la lista de Grupo GF con la chapa
  «Swayp no entregó · vuelve»: Swayp se usa una sola vez por pedido en Lima
  (§9.3), así que el siguiente intento es de otro courier. **En provincia va a
  Gestión Reproprovincia**, donde Swayp sí se repite: desde el 08-10-2026 la
  guía en devolución es la madre del reenvío por Swayp, sin esperar a que se
  confirme la devolución (§11.8).
- **La ventana es la de la tienda** (`return_recovery_max_days`), no los 65 días
  de Tanders, que eran por su antigüedad. Se ancla igual, en la **salida** del
  intento fallido: el barrido sella la guía en cada pasada y la Devolución
  confirmada llega días después de la Devolución, así que ninguna de las dos
  sirve de ancla.
- Si la vendedora revierte la devolución desde la novedad (§11.2) y la guía
  vuelve a Reparto, está viva otra vez y la recuperación se apaga: manda el
  estado actual de Swayp.
- La anulación en Shopify gana, y el pedido va a Por cerrar · Devolución física
  pendiente hasta que se recibe la caja (§9.4).
- **En pantalla, la salida se lee «En devolución · vuelve al origen»**, no «En
  ruta» (02-10-2026, #KP132318). La guía se guarda como `en_ruta` + custodia
  `retorno` —el paquete sigue con el courier, de regreso—, y mostrar sólo
  `delivery_status` contradecía al panel de Swayp. La etiqueta
  (`shipmentStateLabel`) sigue lo que el courier dice HOY —el estado de Swayp,
  el último de Tanders— y la custodia sólo cuando no se sabe: la custodia no
  retrocede, y una guía de Tanders que pasó por `RETURNING` y volvió a reintentar
  no está «en devolución». La tarjeta del courier ya no pide «anúlala»: una
  devolución en curso no se cancela.

#### En Lima, lo que no se entrega se reprograma (v1.23, 30-09-2026)

**#AUR177276** salió con Tanders el 23-09 y volvió: su caja se escaneó en
Devoluciones el 29-09. Tanders no dijo `RETURNED` sino **`CANCELLED`**, y la
regla de la v1.19 dejaba esa palabra fuera porque «no dice que saliera». La
salida sí lo decía, así que el pedido, vivo en Shopify, cayó en **«Por cerrar ·
Devolución pendiente de inventario»**, y la mesa de ruta pedía «Reabrir
primero» para elegir otro courier.

Decisión del owner (30-09-2026), para **todos los couriers de Lima**:

- **Lo que no se entrega pasa a «Por reprogramar Lima».** Solo la entrega lleva
  a Por cerrar (liquidación) y solo la **anulación en Shopify** termina la
  venta.
- **Una guía anulada después de salir es un intento fallido**, diga lo que diga
  el vocabulario de su courier (`guideAnnulledAfterDispatch`,
  `lib/reproprovincia.ts`): Tanders `CANCELLED`, Swayp Cancelada (10), una
  salida de Axel, Urpi o Grupo GF anulada con la caja ya en la calle. La prueba
  de que salió es la custodia: `dispatched_at`, o que la caja ya volvió. Lo que
  se anuló **sin salir** sigue siendo una corrección y se cierra solo, como
  antes (8 guías Tanders `CANCELLED` que nunca salieron, medido el 30-09-2026).
  Aliclik conserva su regla —su etiqueta distingue el intento fallido de la
  anulación de la tienda— y las agencias no entran: no reparten.
- **«Rechazó el pedido» del motorizado propio tampoco cierra la venta**: se
  reprograma como cualquier «No entregado». Deshace, para el rechazo, lo que
  fijaron la v1.15, la v1.16 y la 0189 (§29.13). El cierre de la ruta y
  Liquidaciones ya no anulan el pedido por un rechazo; «Recibir en oficina»
  (0206) lo devuelve a «por asignar» como los demás motivos, y el escaneo de una
  caja anterior lo recibe y lo asigna. Un rechazo que la 0189 ya recibió como
  devuelto va igual a «Por reprogramar Lima», con el inventario como razón.
- La ventana, el ancla y lo demás no cambian: Tanders 65 días, los demás la de
  la tienda, contadas desde la **salida** del intento fallido. El paquete que
  vuelve sigue arrastrando `Devolución pendiente de inventario` como razón.
- **Anulado en Shopify**: el pedido espera la caja en **Por cerrar** (§13:
  toda salida despachada necesita devolución física para cerrar una
  cancelación) y, conciliado el inventario, pasa a **Finalizado**. Una ventana
  vencida ya no le pone `recuperacion_vencida`: la anulación la decidió una
  persona y no había nada que recuperar. Antes esa razón no se apagaba nunca y
  el pedido quedaba en Por cerrar con el inventario ya conciliado (9 de Aliclik
  el 30-09-2026).

**La caja escaneada gana al courier atrasado (03-10-2026).** #AUR176862 salió
con Tanders el 14-09 y su caja se escaneó en Devoluciones el 29-09; cuatro días
después Tanders seguía diciendo `PICKED`. Leyendo sólo al courier, la guía
estaba viva, y un pedido vivo en Shopify en esa situación habría quedado en
«Por cerrar» en vez de «Por reprogramar Lima». (#AUR176862 no lo estaba: se
anuló en Shopify el 19-09 —su `financial_status` siguió en `pending` por ser
contra entrega— y su Por cerrar es correcto.) Una guía de **Tanders o Swayp** que el courier sigue
dando por viva pero cuya caja ya se recibió en el almacén (`returned_at`) es un
intento fallido (`apiGuideReceivedBack`, `lib/reproprovincia.ts`), con la misma
ventana y la misma ancla. Grupo GF y el motorizado propio no entran: su
«Recibir en oficina» devuelve la salida a «por asignar». Lo que el motorizado
propio no entregó se reprograma desde «Desde la lista» con su misma salida,
también sin solicitud de Grupo GF (06-10-2026, §29.13).

Lo que queda fuera: Axel no reporta sus no entregados a Kapta —solo llegan por
la liquidación, que únicamente mueve entregas—. Urpi sí los reporta desde el
05-10-2026 (§30.11), pero se registran y listan sin cambiar el Master porque sus
despachos no tienen salida en Kapta. Hasta que eso cambie, el no entregado de
ambos llega a «Por reprogramar Lima» cuando alguien anula esa salida con la caja
ya fuera.

#### Las guías con API también aceptan la salida adicional

La mesa de ruta manual (Axel, Urpi, Grupo GF) ya lo cumplía: con otra salida viva
pide el motivo y sigue. **Tanders y Swayp directa se negaban en seco** con «el
pedido ya tiene una guía activa, anúlala antes de crear otra» — y una salida con
la caja en la calle no se puede anular, así que el pedido quedaba sin ninguna
acción posible. Pasó con #KP134960 (Tanders) y #KP134416 (Swayp) el 24-09-2026.

Las dos pasan ahora por la misma regla, `puertaDeSalidaAdicional`:

- **En Lima, otra salida viva pide motivo, no bloquea.** El motivo queda en su
  propio evento (`additional_output_reason`) con las salidas que seguían vivas.
- **No se afloja nada más**: el máximo de cinco salidas (§4) y la repetición por
  courier —Swayp, Urpi y Tanders una sola vez por pedido en Lima (§9.3)— se
  aplican igual, con `canRepeatCourier`, la misma que usa la mesa manual.
- **Fuera de Lima no cambia**: Reproprovincia sigue exigiendo que no haya otra
  salida viva antes de una Swayp directa (Fase 3).
- **Lima se decide con `order_master.macro_operation`**, la misma fuente que la
  mesa manual.
- **El aviso nombra al courier de verdad.** El de Swayp directa elegía entre dos
  nombres —`fenix` → Swayp, todo lo demás → Aliclik— y anunció como de Aliclik
  una salida de Grupo GF, mandando a buscarla al panel equivocado.
- Si una de las salidas entrega, las demás siguen vivas y hay que cancelarlas:
  es la tarea urgente de §4.

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
- Excepción de Grupo GF: si no cambia el producto ni el courier, su propia
  salida vuelve a salir otro día con el mismo envío, QR y rótulo —recibida en
  oficina (§29.5, v1.15) o, sin solicitud de Grupo GF, desde «Desde la lista»
  (06-10-2026, §29.13)—. No se arma otra caja para el mismo paquete.
- La nueva salida no debe borrar ni cerrar automáticamente la devolución física
  de la salida anterior.
- El equipo revisa el courier anterior y el motivo antes de elegir el siguiente.
  Se mantiene la política aprobada por Frankz: Axel y motorizados propios pueden
  repetirse; Swayp, Urpi y Tanders solo una vez por pedido en Lima, dentro del
  máximo global de cinco salidas.

La entrevista menciona como posibilidad volver a enviar por Swayp. Esto queda
registrado como discrepancia operativa, pero no modifica la política del owner
hasta que Frankz la cambie expresamente.

#### Un pedido cerrado se dice igual en todas las pantallas, y con el sitio donde se abre

Un pedido `entregado`, `anulado` o `devuelto` no admite otra salida. Eso ya lo
sabían los modales de cada courier, pero **la mesa de ruta medía otra cosa**:
solo se apagaba con la macroetapa en `finalizado`. Con el expediente reabierto y
el pedido todavía `anulado` —#AUR176830— la mesa pintaba «Crear en Tanders» en
negro y recomendado, y la negativa aparecía recién dentro del modal.

Reglas:

- Las dos condiciones —expediente finalizado y estado general terminal— son
  independientes y pueden darse a la vez. Reabrir el expediente no levanta el
  estado, ni al revés, y el aviso cuenta las dos.
- **El botón se apaga por modalidad, no por pedido entero**, porque los guardas
  del servidor no dicen lo mismo y un interruptor único mentiría en tres de las
  cinco:

  | Modalidad | Con el pedido en estado terminal |
  | --- | --- |
  | Tanders, Shalom | Se niegan siempre |
  | Salida manual | Se niega, salvo si se cerró por una entrega fallida (§11) |
  | Aliclik, Swayp | No miran el estado general del pedido |

  La excepción de la salida manual no es teórica: son 844 guías sobre 842
  pedidos, y apagarle el botón habría roto la entrada a Reproprovincia que el
  §11 define. Se decide por la **etiqueta que el courier puso en la guía**, no
  por el estado del pedido: `anulado` cubre tanto «lo canceló el courier» como
  «lo cancelamos nosotros», y solo la etiqueta los separa.
- Con el **expediente finalizado** sí se apagan todas, sin excepción: el cierre
  exige que no queden salidas activas.
- El motivo se muestra **antes** de los botones, no solo como una etiqueta
  apagada encima de ellos, y se muestra aunque algún botón siga encendido — el
  hecho es cierto igual.
- **Y lleva atajo, no solo el nombre del panel.** Los dos sitios viven al fondo
  de la pestaña Operar, detrás de «Salidas y guías», y quien lee el aviso está
  arriba del todo: con #AUR176830 hicieron falta dos rondas para encontrarlo
  teniendo la instrucción delante. Cada motivo lleva su botón al panel que le
  toca, como ya hacía «Abrir Mesa de cierre ↓».
- El motivo nombra **dónde se arregla**, porque hay dos «reabrir» y no sirven
  para lo mismo: el del expediente vive en la **Mesa de cierre** y el del estado
  en **Gestión manual → Registrar estado**. Un aviso que manda a un panel
  inexistente es peor que no decir nada — el de Tanders mandaba a «Estado del
  pedido», que no existe con ese nombre.
- La frase la escribe una sola función para las tres pantallas. Cuando cada una
  tenía la suya, decían tres cosas distintas del mismo hecho.
- Si alguien acaba de anular la salida para cambiar de courier, el aviso lo dice:
  ese estado **se recalcula solo** en cuanto exista otra salida viva y no hace
  falta corregirlo a mano.

### 9.4 Reportes, pagos y devoluciones físicas de Lima

| Operador | Fuente del resultado | Momento observado |
| --- | --- | --- |
| Johnny, Roy y Douglas | WhatsApp; `entregado` o `entregado en efectivo`, más evidencia para Yape, Plin, link o POS | Durante/final de ruta |
| Axel Courier | Cuadro de entregados y devueltos; devolución física normalmente al día siguiente | Día siguiente |
| Swayp | Excel/plataforma en tiempo real | Durante la ruta |
| Urpi | Plataforma en tiempo real; su export «Reporte del mes – detallado» se carga en Kapta (§30.11) | Durante la ruta |
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
- **Un barrido que falla dice por qué.** El 08-09-2026 se encontró que, tras
  tres semanas de cron horario, ninguna de las 330 guías Tanders había recibido
  una sola lectura: sin `last_report_at`, sin `reported_status`, sin
  comprobación de pago. Los barridos envolvían cada guía en un `try/catch` que
  sumaba a `errores` y seguía —correcto para que una guía no tumbe a las demás—
  pero tiraban el motivo. Ahora los dos reportes (`fallos`) conservan los
  motivos distintos con su cuenta, con método, ruta y status HTTP cuando el
  fallo es de su API, y la pantalla de Cobros Tanders tiene una lectura en
  seco de estados que los muestra sin necesitar el secreto del cron.
- **La causa, confirmada con esa lectura el mismo día**, eran dos: `GET
  /orders/{id}` respondía **403 Forbidden resource** (120 de 200) —es una ruta
  de administrador de Tanders; todo lo que es de la tienda va por
  `/orders/me/…`— y a partir de ~120 llamadas seguidas Tanders corta con **429
  Too Many Requests** (las 80 restantes). Reglas desde entonces:
  - El detalle se lee por `GET /orders/me/{id}`.
  - Los barridos van con pausa entre guías y **se detienen en el primer 429**:
    seguir solo quema llamadas y alarga el castigo. Lo que queda va en la
    siguiente pasada; el tope por pasada bajó de 200 a 60 y las nunca leídas
    van primero, así que el atraso entra igual, en unas horas.
  - **`400 Order is not yet delivered` es la respuesta normal**, no un fallo.
    El endpoint de evidencias la devuelve mientras el paquete sigue en ruta, lo
    que confirma que **ese endpoint es por sí mismo la prueba de entrega**. La
    guía se cuenta como en curso. Contarla como error —15 de 15 «errores» el
    10-09-2026— infla el reporte y esconde los fallos de verdad.
  - Por lo mismo, una guía que responde **200 sin constancia reconocible SÍ está
    entregada**: el problema entonces no es del courier sino de nuestro
    extractor, y la lectura en seco guarda la respuesta cruda de hasta tres de
    ellas para poder verlo. **Así se encontró el fallo el 10-09-2026**: las 60
    guías salían «sin constancia aún» y ninguna lo estaba.
  - **La forma de la respuesta de evidencias, confirmada el 10-09-2026:**

    ```
    { orderNumber, evidences: [ … la ENTREGA … ],
      payments: [{ id, amount, paymentMethod, entity: "YAPE",
                   paymentDocument: "…/files_payment%2F…jpg",
                   status: "VERIFIED", paymentDate, createdAt }] }
    ```

    El enlace de la constancia es **`payments[].paymentDocument`**, y el medio
    de pago es **`entity`** («YAPE», «BCP»). El `method` de la respuesta NO es
    el medio de pago: cuelga de la evidencia de entrega y vale «Asignación
    masiva por mapa». El extractor se había escrito contra una forma imaginada,
    sin `paymentDocument` en su lista de claves, y por eso no validó ni un cobro
    entre el 15-08 y el 10-09. Ahora se prueba contra la respuesta literal
    (`test/tanders-payment-evidence.test.ts`): **una forma adivinada no se
    verifica leyéndola.**
  - Lo que Tanders dice del pago (`amount`, `entity`, `status: VERIFIED`) es
    dato de apoyo, **no el veredicto**. Quien decide sigue siendo la lectura de
    la imagen contra el monto de la guía y el nombre de Grupo GF SAC: que el
    courier se dé por pagado a sí mismo no es constancia de que el dinero
    llegó a nuestra cuenta.
  - **VALIDAR EL COBRO CIERRA EL PEDIDO.** Al validarlo en «Validar pagos» se
    emite `liquidation_closed` —el MISMO evento que el cierre manual del
    drawer—, así que el pedido sale de «Por cerrar · Pendiente de liquidación»
    y pasa a Finalizado sin que la macroetapa necesite saber nada nuevo.
    - **Por qué hacía falta.** Esa subetapa espera un `liquidation_closed` que
      el 12-09-2026 **no existía ni una sola vez** en toda la historia de la
      base: 4.204 pedidos parados (Aliclik 3.843, Tanders 201, Fenix 12), con
      el propio código admitiéndolo — «el repositorio auditado todavía no
      contiene la fuente de liquidaciones». Ahora la fuente existe, y por
      pedido en vez de en bloque: alguien miró el comprobante del motorizado y
      firmó. Eso es exactamente lo que una liquidación pretende demostrar.
    - **Se puede deshacer.** Rechazar u observar después un cobro ya validado
      emite `liquidation_observed`, que reabre el cierre. Un pedido no puede
      quedarse finalizado por una firma que luego se retiró.
    - **Solo el cobro del courier liquida.** Validar un adelanto de la clienta
      no cierra nada: el courier sigue debiendo el efectivo que cobró.
    - Aliclik y los motorizados propios siguen esperando su propia fuente de
      liquidación: se liquidan en bloque y eso es otro trabajo.
    - **LA FIRMA HUMANA MANDA TAMBIÉN SOBRE LA GUÍA** (0191). Validar el cobro
      pasa la guía Tanders a `entregado` —si Tanders la da por entregada—, y
      retirar esa validación la devuelve a `en_ruta`. Antes solo se emitía el
      cierre de liquidación y la guía se quedaba donde la hubiera dejado el
      MODELO: el 24-09-2026 había **49 pedidos validados por una persona y
      atascados en «En tránsito»**, justo los que el lector había rechazado
      (45) o no había podido leer (4). El cierre existía pero el pedido no
      podía usarlo, porque para el Master nunca se había entregado. Dos
      autoridades contradiciéndose sobre el mismo pedido.
      - El estado del cobro queda en **`revisado`** cuando la persona corrigió
        al lector, y en **`validado`** cuando los dos coincidían. Es la cifra
        que interesa al auditar el lector.
      - **El barrido ya no pisa a la persona.** Una guía cuyo cobro alguien
        decidió —aunque lo rechazara— no se vuelve a leer: sin esto, el modelo
        podía dar por bueno lo que una persona rechazó mirando la imagen y
        devolverlo a `entregado` en la pasada siguiente, y volver a encolar el
        mismo comprobante una y otra vez.
  - **QUIEN DA EL DINERO POR RECIBIDO ES UNA PERSONA** (0158). El lector de
    imágenes valida **una imagen, no un depósito**: no detecta una captura
    editada, ni un comprobante real de otra transferencia. Mientras no haya
    conexión con el estado de cuenta del banco, el modelo **prepara la ficha** y
    la firma la pone alguien.
    - **Desde el 04-10-2026 esa conexión existe para Yape** (§16.2): el cobro
      que aparece en el estado de cuenta de Yape al mismo minuto, por el mismo
      monto y por el mismo canal se valida solo, y cierra la liquidación igual
      que la firma de una persona. Lo que no cuadra así sigue esperando a
      alguien. Para eso el lector de Tanders transcribe ahora también la
      **fecha y hora** del pago.
    - Cada cobro entra a **«Validar pagos»** (`order_payments`, tipo
      `cobro_courier`) con la imagen guardada en NUESTRO bucket —la evidencia de
      un cobro no puede depender de que el courier conserve el archivo— y con lo
      que leyó el modelo en `vision`.
    - El estado de entrada dice QUÉ mirar: `pendiente_revision` (el modelo no
      vio nada raro), `revision_admin` (vio algo que no cuadra: no es un
      rechazo, es «míralo tú») e `info_incompleta` (no se pudo leer — culpar a
      la captura cuando falló el lector manda a perseguir a alguien por una foto
      correcta).
    - **La guía sigue pasando a `entregado` con la lectura del modelo**: el
      paquete SÍ llegó y eso lo acredita el courier. Lo que espera al humano es
      el cierre del dinero. Son dos preguntas distintas y las contesta cada uno
      quien puede.
    - **Un duplicado NO entra a la cola**: no es un cobro por confirmar, es una
      incidencia. Queda bloqueado y avisa — una sola vez, no en cada pasada.
    - Al entrar aquí se hereda lo que la vía paralela de Tanders no tenía: nº de
      operación único en todo el sistema, huella `sha256` que atrapa la misma
      imagen renombrada (es lo que habría cazado el «198yape.png» sin depender
      de leer bien el número) y la coincidencia difusa de monto + fecha +
      pagador (`lib/yape-dedup.ts`). El normalizador del nº de operación es
      ahora **uno solo**: dos reglas para la misma llave global es como se cuela
      un duplicado.
  - **El cobro del courier se ve y se filtra desde el Master** (0156). El
    veredicto viaja de la guía vigente a `order_master.payment_check_state` y
    el filtro **«Cobro del courier»** ofrece `validado`, `rechazado`,
    `pendiente`, `revisado` y **«courier sin constancia por guía»**. Esa última
    opción no es decorativa: sin ella, pedir «validado» sacaría de la lista
    todo lo que no es Tanders y parecería que solo esos pedidos están cobrados,
    cuando los demás se liquidan en bloque (`rider_settlements`) y esta columna
    nunca se les escribe.
    - **La columna no es de Tanders.** Hoy es el único courier que sube
      constancia por guía; el día que otro lo haga, el Master ya sabe
      enseñarlo. Lo específico de Tanders es quién la escribe, no el concepto.
    - Motivo: el 10-09-2026 había **21 guías con el cobro rechazado** —una por
      comprobante reusado— bloqueando pedidos, y ninguna pantalla podía
      listarlas. Un bloqueo que nadie puede ver es un pedido parado para
      siempre.
    - No confundir con `payment_state`, que es el cobro del PEDIDO (adelantos
      de la clienta). Este dice si el dinero que cobró el motorizado llegó a la
      cuenta.
  - **Vocabulario de estados de Tanders, confirmado por la operación el
    10-09-2026** (hasta entonces 105 guías vivían en estados que el Master no
    traducía, entre ellas paquetes ya de vuelta que nadie sabía que habían
    vuelto):

    | Tanders | Guía | Custodia | ¿Sella devolución? |
    |---|---|---|---|
    | `PENDING` | pendiente | empresa | no |
    | `PICKED` | en ruta | courier | no |
    | `DELIVERED` | en ruta | courier | no (el cobro decide, §9.4) |
    | `RETURNING` | en ruta | retorno | **no** — va de camino, no ha llegado |
    | `RETURNED` | anulado | devuelto | **sí** (`returned_at`) |
    | `CANCELLED` | anulado | — | no |

    - **`RETURNED` cierra la GUÍA, no el pedido.** El paquete está físicamente
      en el almacén y **puede volver a salir con otro courier** mientras no se
      anule en Shopify. El Master lo lee por `returned_at`/custodia y lo manda
      a recuperación, que es de donde se vuelve a despachar.
    - **`RETURNING` no sella nada.** Sellar la devolución antes de recibir el
      paquete metería el pedido en la cola de recuperación —de la que sale un
      mensaje pidiéndole un adelanto a la clienta— por algo que nadie tiene aún.
    - **`CANCELLED` no toca la custodia**: que la guía muera no dice dónde está
      el paquete, y afirmarlo mandaría a buscar al almacén algo que sigue en la
      calle.
    - El sello lleva procedencia `tanders_api` (0118): quien decide pedir un
      adelanto ve si la devolución la reportó el courier o una persona.
    - **QUE TANDERS DIGA `RETURNED` NO ES QUE LA CAJA ESTÉ EN EL ALMACÉN.** El
      24-09-2026 había 108 guías selladas como devueltas por su API y **ninguna
      confirmada físicamente** —el evento `return_received` no existía en toda
      la base—; el botón manual del drawer estaba además bloqueado para ellas,
      porque leía el sello del courier como «ya recibida». Se añade la
      recepción física en **`/dashboard/pedidos/devoluciones`**: en almacén se
      escanea el QR de Tanders (lleva literalmente el nº de seguimiento) y queda
      el evento canónico `return_received` con la persona que la escaneó.
      - **Sello del courier ≠ caja recibida.** «Ya recibida» es que una PERSONA
        la registró. El sello de la API no se reescribe (0118); la llegada
        física se escribe aparte. Si el courier aún no la había reportado
        (RETURNING), quien la tiene en la mano la sella con procedencia
        `manual`, igual que el botón del drawer.
      - **El cuadre**: lo que Tanders dice que devolvió frente a lo recibido.
        Lo que dio por devuelto y nadie escaneó es **lo que te debe**, ordenado
        de lo más antiguo a lo más reciente — una caja que no aparece tras días
        no es un retraso, es una pérdida.
      - No se recibe como devolución una guía que el courier dio por ENTREGADA:
        si esa caja está en el almacén es una incidencia que hay que escalar.
        La única excepción es la de Shalom, abajo.
      - **Tanders y Shalom** (Shalom desde el 03-10-2026). Aliclik sigue con su
        propia vía de sellado y su cola de recuperación.
      - **Shalom, en la misma pantalla.** Un solo escáner para los dos
        couriers: sirve el QR de nuestra banda del rótulo, el nº de guía Shalom
        original o el nº de pedido. La etiqueta de retorno de Shalom trae una
        guía nueva que el sistema no conoce: se anota, si se quiere, en el campo
        opcional «Guía de retorno de Shalom», y queda en la nota y el `payload`
        del `return_received`.
        - **Lo que el rastreo dejó de vuelta** (`anulado`, custodia `retorno`,
          §12) se recibe y se sella como cualquier retorno.
        - **Lo que Shalom dio por recogido** se recibe solo si el pedido tiene
          clave y nunca se le dio a la clienta: la caja en la mano prueba que
          aquel «recogido» era el retorno. La guía se corrige a `anulado` en el
          mismo escaneo y el pedido pasa a devuelto. Si la clave se reveló o se
          envió, puede que la clienta lo recogiera y lo devolviera: es una
          devolución del cliente y se abre desde el Master. Sin clave
          registrada, se escala.
        - **Una guía todavía viva** —la caja volvió antes de que Shalom lo
          dijera— se recibe y se anula; si no, el rastreo la daría por recogida
          cuando Shalom cierre la guía original.
        - Sin poder leer la clave no se decide nada: se pide volver a escanear.
          La escritura repite lo que se leyó (entregada, sin sellar): si la guía
          cambió entre medias, no se toca.
        - **El cuadre de Shalom**: lo que Shalom devolvió, lo recibido y lo que
          está **por recibir**, en ámbar si hay alguna —esa caja hay que ir a
          buscarla—, de la más antigua a la más reciente desde que salió de la
          agencia.
      - **El cuadre falla cerrado.** Si no se puede leer, la pantalla lo dice en
        vez de pintar «0 por recibir».
  - **EL MISMO COMPROBANTE NO COBRA DOS PEDIDOS.** Si el nº de operación ya
    quedó registrado en otra guía, la comprobación sale **`rechazado`** por
    `operacion_duplicada` aunque todo lo demás cuadre —buen medio, buena
    cuenta, buen monto—: es el mismo dinero acreditando dos pedidos. Se compara
    contra cualquier comprobación anterior, no solo las validadas (un voucher
    rechazado en A que reaparece en B sigue siendo el mismo papel dos veces), y
    se excluye la propia guía, que se relee mientras siga pendiente.
    - **Es el único motivo que además AVISA**, porque hay que mirarlo hoy; los
      otros rechazos son un cobro mal hecho y se corrigen. El aviso es la
      **alerta urgente de comprobante repetido** (abajo). El bloqueo del cobro
      no depende de él.
    - **Alerta urgente de comprobante repetido (0226, 05-10-2026).** Regla del
      owner: **un mismo comprobante no puede estar en más de un pedido**, y
      cuando pase lo tienen que ver Frank, Yohalis, Akemi y Daysi. El caso:
      un solo Lemon de S/ 89 (20-08, 15:12) era el comprobante de **cuatro**
      pedidos Tanders —#KP124940, #KP126075, #KP126468, #KP126871—, el mismo
      archivo subido cuatro veces. El nº de operación salía cortado
      («2026…843») y la huella del archivo, que sí lo cazaba, bloqueaba el
      cobro **en silencio**: nadie se enteró en un mes.
      - **Todos los caminos que encuentran un repetido avisan, por la misma
        puerta** (`lib/repeated-voucher-alert.ts`): el nº de operación repetido
        en el barrido de Tanders, el **mismo archivo** al encolar el cobro del
        courier, la subida a mano en el pedido (y el nº escrito a mano), el
        comprobante que llega por WhatsApp y la relectura de comprobantes. Solo
        cuando es **otro** pedido: el mismo pedido dos veces es un reintento.
      - **Dos vías.** En Kapta, la alerta flotante con sonido, en rojo, para
        quien tenga el permiso **«Alerta de comprobante repetido»**
        (`alerts.repeated_voucher`, se concede persona por persona en Equipo;
        el rol admin no lo trae). **Sin escalera**: la ven todos a la vez.
        Y por Telegram al **grupo de alertas urgentes** de la tienda (Ajustes →
        Telegram), porque quien no está conectado también tiene que enterarse;
        sin grupo configurado va al chat del resumen diario.
      - **Una por comprobante**: la huella es el archivo si se conoce, si no el
        nº de operación. Mientras esté abierta no se repite ni la alerta ni el
        Telegram, aunque el barrido vuelva a pasar cada hora.
      - **Se cierra diciendo qué se hizo** («Ya lo revisé»): cuál pedido sí
        estaba pagado y qué se hizo con el otro. Ningún hecho del sistema la
        resuelve sola, y no se descarta.
    - El nº se guarda **normalizado** (solo letras y dígitos, en mayúsculas) y
      **nunca como número**: Yape los emite con ceros a la izquierda
      («06420756»). Una lectura **truncada** («202609...495099») se guarda como
      null: un dato inventado en la clave que detecta un fraude puede tanto
      acusar en falso como tapar el duplicado bueno.
    - Al implantarlo (10-09-2026) el histórico de 78 comprobaciones no tenía
      **ninguna** colisión.
  - **Medios de cobro aceptados: Yape, Plin, transferencia BCP y cualquier app
    que pague a un Yape** (ver abajo). Plin entró
    el 10-09-2026: el motorizado remite con la billetera que tenga, y Plin y
    Yape se pagan entre sí y caen en la misma cuenta —la constancia de un Plin
    a Grupo GF SAC dice literalmente «Enviado a: Grupo Gf S · 930 555 309 -
    Yape»—. **7 de los 9 rechazos de ese día eran cobros buenos rechazados por
    el logo.** Aceptar el medio no es aceptar el pago: el destinatario y el
    monto se siguen exigiendo igual.
  - **El final del celular pegado al nombre es el celular, no parte del
    nombre.** La app del BBVA, al pagar a un Yape desde «Envío a contactos»,
    escribe el contacto como «Grupo gf s •5309». Leído como nombre, «5309»
    rompía la comparación y el cobro salía «El pago NO va a Grupo GF SAC»:
    **tres cobros del courier** a la cuenta de la empresa (#KP137040 entre
    ellos) quedaron en revisión administrativa. Ahora los dígitos que van tras
    **un solo punto** (•, ·) se separan del nombre y se juzgan como celular:
    tienen que terminar en `309`, o es otra cuenta aunque el nombre encaje.
  - **Pero una máscara no es el celular.** La app del BCP pone bajo el
    destinatario la **cuenta** enmascarada: «Grupo Gf S. **** 0012»
    (#AUR177129). Ese 0012 no es el ···309, y tomarlo por celular rechazaría
    un cobro bueno. Tras asteriscos o varios puntos seguidos no se sabe qué
    número es: se aparta del nombre y **no se juzga**, porque un dato que no
    se sabe no puede desmentir la cuenta. Un nombre que solo termina en
    números, sin separador, no se toca. Tampoco es parte del nombre la
    billetera de destino que Plin pega al final («Grupo Gf S - Yape»): se
    quita antes de comparar. Estas reglas rigen igual en los comprobantes de
    los pedidos (§12, Pagos).
  - **La app del BCP se reconoce aunque no se vea su logo** (29-09-2026). Su
    constancia —blanca con azul y naranja, «¡Transferencia exitosa!», «Enviado
    a», «Desde»— salía como medio «otro» porque el lector solo tenía descritos
    Yape (morado) y Plin (celeste). También se envía así a un Yape desde esa
    app. **Seis cobros** a «Grupo Gf S.» quedaron en revisión por el medio,
    #AUR177129 entre ellos.
  - **Cualquier app que pague a un Yape vale como medio** (29-09-2026). Prex,
    BBVA, el BCP… todas pagan a un Yape, y ese dinero cae en la **misma cuenta
    Yape** que un Yape directo: se concilia igual, que era la razón de limitar
    los medios. La constancia lo dice —«Cuenta/billetera: Yape» (Prex),
    «Entidad de destino: Yape» (BBVA), «- Yape» (Plin)— y el lector lo lee
    aparte de qué app la emitió. **#KP136441** era un Prex así rechazado por el
    medio, y había **43 cobros a «Grupo Gf S A C»** en la misma situación: 30 ya
    validados a mano. Una app que **no** dice adónde fue el dinero sigue
    exigiendo que alguien mire, y el destinatario y el monto se exigen igual.
  - **La cola de cobros se recorre entera: la que hace más tiempo que no se
    mira va primero.** El 10-09-2026 había **238 guías candidatas y el tope es
    de 60 por pasada**, y la consulta cortaba sin orden ninguno: entraban
    siempre las mismas y el resto no se miraba nunca. El #AUR176448 llevaba un
    día entregado, con su Yape de S/ 129 verificado, y no estaba en el lote —ni
    iba a estarlo—. **No era atraso, era hambre.** Ahora cada guía mirada deja
    sello (`payment_checked_at`, 0152) **haya dado veredicto o no**: las en ruta
    no escriben comprobación, así que sin sello se clavarían al frente de la
    cola para siempre. La que se topa con el 429 no se sella —no se la llegó a
    preguntar— y va primero en la siguiente. Con 60 cada dos horas, las 238 se
    recorren en unas ocho horas.
  - **El barrido de cobros pide la constancia directamente**, sin preguntar
    antes el estado. Una constancia bajo `files_payment/` existe solo cuando el
    motorizado cobró, así que es por sí misma la prueba de entrega; y es una
    llamada menos por guía, que con el límite de ritmo cuenta. La regla de
    §9.4 no cambia: la guía pasa a `entregado` únicamente con la constancia
    validada. Una guía que Tanders da por entregada pero sin constancia ya no
    la marca este barrido como `pendiente`: se ve como custodia del courier
    (que sí escribe el barrido de estados) con el cobro sin verificar.

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
  `devuelto` **una vez vencida o descartada la ventana de Reproprovincia**
  (§11). Mientras esa ventana esté abierta, el pedido sigue `en_proceso ·
  pendiente_nuevo_courier`: el paquete que vuelve es inventario por conciliar,
  no el fin de la venta.
- Si Aliclik no entrega, el pedido **ingresa** a Reproprovincia (§11): no es una
  posibilidad que alguien tenga que activar.
- Solo Aliclik tiene proceso de indemnización formal.

#### Un distrito que Aliclik no tiene en su tabla no es un problema de almacén

A la cotización solo se le mandan `warehouseId`, `lat` y `lng`: **el distrito lo
deduce Aliclik del pin**. Cuando su tabla de ubigeo no lo tiene, responde «No se
encontró el distrito en ubigeo para …» nombrando el distrito que acaba de
reconocer.

Nuestro aviso le pegaba detrás «Almacén(es) compatibles probados: …», así que el
mensaje entero se leía como un fallo de almacén y mandaba a buscar por donde no
era. Pasó con #AUR177131 y #KP135145 (18-09-2026).

**La causa costó dos intentos y las dos primeras explicaciones eran falsas.** Se
dejan escritas porque son las que uno vuelve a proponer:

1. «Su tabla no tiene el distrito porque es nuevo» (San Miguel, Ley 30927 de
   2019). La tiró abajo el segundo caso: **Callería** es el distrito de Pucallpa
   y no tiene nada de nuevo.
2. «El almacén no cubre esa zona». También falsa: los dos pedidos van al almacén
   **133 (GRUPO GF)** y de ese mismo almacén salieron 267 envíos a Puno y 96 a
   Ucayali en 30 días.

**Lo que encaja con todo: las dos mitades de Aliclik no se entienden.** Su
geolocalizador devuelve el nombre OFICIAL del distrito y su tabla de ubigeo está
indexada por el COMERCIAL. Los envíos que sí salen llevan `juliaca` (328),
`pucallpa` (121), `puno` (118) y `yarinacocha` (33) — y «Pucallpa» ni siquiera es
un distrito: la ciudad está en Callería. Cuando el pin cae donde los dos nombres
difieren, una mitad lo reconoce y la otra dice que no existe.

Eso además explica por qué el fallo parece aleatorio: depende de dónde cae el
pin, no del pedido ni del producto.

Reglas:

- Cuando el fallo sea de ubigeo, el aviso **no nombra el almacén**, y descarta
  de frente las dos pistas falsas: no es el almacén ni el stock. Dice el
  distrito y explica que Aliclik lo llama de dos maneras.
- Las salidas son dos, y el aviso las da: revisar el pin en «Ubicación y
  cobertura» por si la dirección es de otro distrito, o despachar por otro
  courier y pasarle a Aliclik la referencia para que lo arreglen de su lado.
  **Kapta no mueve el pin sola**: el pin decide a dónde va el paquete, así que
  acercarlo al centro de Juliaca o Pucallpa para que la cotización pase es una
  decisión de una persona mirando la dirección.
- Las referencias de la petición se conservan: son lo que se le reenvía a
  Aliclik para que lo corrijan de su lado.

#### El pin es el destino, y el pedido tiene que respaldarlo

A Aliclik solo se le mandan `warehouseId`, `lat` y `lng`. **El pin decide a dónde
va el paquete**; la dirección escrita viaja en la guía para que el motorizado la
lea, pero no corrige el destino. Un pin equivocado no es un detalle de
formulario: es otro destino.

Lo destapó #KP133769 (11-09-2026). La clienta eligió Puno en el desplegable del
checkout, escribió «Puno» como ciudad y «JR. Velasco Astete 191», y su checkout
geocodificó el punto en Puno. La guía salió con el pin en **Santiago, Cusco**, a
331 km. El paquete se fue a Cusco y volvió.

**El aviso que ya existía no sirvió, y por una razón medible.** Comparaba solo el
DISTRITO que Aliclik deduce del pin contra el nuestro, y eso salta en **1.958 de
4.173 guías (47%)**: Cusco/Cuzco, Coronel Portillo/Pucallpa, el nombre oficial
contra el comercial (ver arriba). Un aviso que sale en la mitad de los pedidos no
lo lee nadie, y este salió ahí dentro.

**Lo que sí discrimina son las dos declaraciones del pedido que no dependen del
pin.** El departamento que la clienta ELIGIÓ en el desplegable del checkout
—llega como código ISO 3166-2:PE, vocabulario cerrado, en 14.770 de 23.034
pedidos y hasta ahora sin usar— y la ciudad que escribió en la dirección. El
departamento del pin coincide con el del desplegable en el **99,9% de las guías
entregadas** (1.388 de 1.390).

Reglas:

- **El pin necesita que UNA de las dos declaraciones lo respalde.** Si el
  departamento del pin contradice al desplegable Y su distrito no es la ciudad
  escrita, el pin está solo contra el pedido y **la guía no se emite**.
- **La excepción se escribe, no se marca.** Existen casos reales en que quien se
  equivocó fue la clienta al elegir el departamento: se emite dejando dicho por
  qué, y queda registrado en el pedido (`aliclik_pin_exception`). Mismo trato que
  la excepción de riesgo de pago.
- **Sin código ISO no hay puerta.** Son 8.264 pedidos de 23.034; para ellos nada
  cambia. Bloquear con una sola fuente sería el mismo error que esta regla evita.
- **Kapta no mueve el pin sola**, aquí tampoco: acercarlo es decidir a dónde va
  el paquete, y eso lo hace una persona mirando la dirección.

Medido sobre las guías creadas por API, las 10 discrepancias existentes se parten
limpiamente: 5 con el pin equivocado —#KP133769, #KP134170, #KP130297, #KP127265,
#KP123779, **ninguna entregada**— y 4 con el desplegable equivocado y el pin bien,
que la segunda declaración deja pasar (#KP126473 se entregó). Cinco bloqueos, los
cinco reales, cero falsos positivos.

#### Una cotización no es cobertura

La cobertura de un pedido la decide la **matriz de costos**: si existe una tarifa
de primer intento que alcance ese destino, es Provincia COD. Y un cron nocturno
alimenta esa matriz cotizando los distritos de los pedidos pendientes. Juntas,
las dos cosas hacían que **una cotización bastara para convertir un distrito de
Agencia en Provincia COD**, sin que nadie hubiera entregado nunca ahí y sin que
nadie se enterara.

Lo destapó Caravelí (#AUR177128, 19-09-2026): tarifa creada por el sondeo el
17-09, cero envíos de Aliclik en su historia, la entrega suya más cercana a 247
km, y ocho envíos reales por Shalom.

Reglas:

- **El sondeo no cotiza lo que no es un distrito.** La clienta escribe la
  referencia en ese campo y se llegaron a crear tarifas para «frente al grifo
  amazonas» o «2do puente de la av. 28 de julio». Se descartan las cadenas con
  palabras de referencia o tipos de vía. La lista es corta a propósito: «puente»
  no entra, porque Puente Piedra es un distrito; y no se filtra por dígitos,
  porque eso se llevaba por delante «26 de Octubre», distrito de Piura con 44
  entregas reales.
- **El sondeo no cotiza donde ya consta que Aliclik no entrega**: distritos con
  entregas reales de agencia y cero envíos de Aliclik. Se mira la ENTREGA y no la
  guía creada, porque una guía anulada no prueba cobertura — es lo que pasó con
  Tumbes (§0149).
- **Lo que se pierde está dicho**: si Aliclik abre cobertura en uno de esos
  destinos, el sondeo no lo va a descubrir solo. Se registra con una fila en
  `district_coverage` o una tarifa cargada a mano, que es el camino correcto para
  una decisión comercial en vez de que la tome un cron de madrugada.
- **Un texto igual no es un lugar igual.** Al buscar los afectados, el primer
  análisis comparó la cadena del campo distrito y metió en la lista a Mariscal
  Nieto, que sí tiene cobertura: sus 62 envíos de Aliclik están registrados con
  distrito «moquegua», y las filas con el texto «mariscal nieto» son pedidos donde
  alguien escribió la provincia ahí. La comprobación que vale es **geográfica**:
  cuántas entregas reales de Aliclik hay a menos de 30 km de ese punto.

Decidido el 19-09-2026 con estos números, por distancia a la entrega de Aliclik
más cercana: Caravelí 247 km, Huaura 165, Olmos 81, Sicuani 79, Huancavelica 77,
Canchis 77, Azángaro 60 — los seis lugares pasan a Agencia. Y con cobertura
confirmada, que el primer análisis había marcado mal: La Unión (122 entregas a 30
km), Mariscal Nieto (34) y Chincha (23).

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

#### Un pedido de Agencia no puede haber llegado sin haber salido

Marcar `recogido`, `entregado`, `disponible_para_recojo` o cualquier otro estado
que signifique que la caja ya está en la sucursal **exige que exista una salida**.
Si el pedido es de cobertura Agencia y no consta ninguna, el Master pide **por qué
agencia se envió** —Shalom u Olva— y registra la salida con la firma de quien
marca. Sin courier elegido el marcado no se guarda.

**Por qué.** Una salida es lo único por lo que el tablero sabe que un pedido se
despachó. Un pedido que llega a la agencia sin ella desaparece de los indicadores
de envío, del aviso de vencimiento en agencia y del cotejo de liquidación.
Auditado el 09-09-2026 sobre los pedidos de Agencia ya recogidos o entregados:

| Origen del estado | Con salida | Sin salida |
| --- | --- | --- |
| Rastreo de Shalom | 107 | **0** |
| Marcado a mano | 185 | **42 (18,5 %)** |

El agujero está entero en el marcado manual. Son **43 pedidos y S/ 6.140 desde
agosto**, y ocho seguían ese día en la agencia sin fecha de vencimiento —el más
viejo de 62 días— justo cuando entre el 5 % y el 6 % de los envíos de agencia
acaba devuelto por no recogerse a tiempo. El problema ya venía cerrándose solo
(98,9 % sin salida en junio, 82,7 % en julio, 8,6 % en agosto, tras la integración
de Shalom); esto cierra el residuo.

**Se pregunta en el propio marcado, no en un formulario aparte**, porque el
formulario aparte ya existía: la salida manual (§4) admite Olva desde antes. No se
usó **ni una vez en 40 días**, contra 866 salidas de Shalom. Kapta no tiene una
sola guía de Olva.

**La firma del operador es lo que autoriza**, igual que al vincular una guía
creada en el portal (abajo). Por eso la salida nace con `match_method =
agency_operator_attested` y no con el `manual` de las demás: quien audite tiene
que distinguir la salida que trajo el courier de la que afirmó una persona. Nace
además **sin código de guía** —la tiene el mostrador de la agencia, y uno
inventado se cotejaría contra el reporte del courier sin casar nunca— y **en el
estado que el pedido declara**, no en «pendiente»: una salida pendiente haría que
el recálculo tirase el pedido hacia atrás y deshiciera el marcado que la creó.

> ⚠️ **La fecha de despacho es la del registro, no la del envío real**, y así lo
> dice la nota que queda en el historial. Nadie recuerda la fecha exacta y una
> inventada contamina peor que una declarada — pero las cohortes de los
> indicadores de despacho se arman con esa fecha, así que un pedido salido en
> julio y atestiguado hoy cuenta como despacho de hoy.

**Solo Agencia.** Lima sale por la mesa de despacho, que ya crea la salida sola;
añadir la misma fricción allí por simetría sería un coste cierto sin problema
medido.

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

**Una guía del portal que lleva dos pedidos** (la misma clienta, uno de Kenku y
otro de Aurela) se vincula a UNO solo —el principal— y el otro se registra como
**pedido acompañante** desde su ficha (§32). La guía sigue siendo de un pedido;
lo que cambia es que el otro la hereda, y la liquidación espera la suma.

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

#### Cuándo recogen el paquete, y por qué lo calculamos si lo decide Aliclik

La fecha de despacho **no se envía**: el esquema de `POST /integration/order` no
tiene campo de fecha y la calcula su servidor. La regla es suya y está en su
documentación: *el despacho se calcula contra la hora de corte del courier
(`schedule`); si cae en domingo, se desplaza al lunes*. Aliclik recoge todos los
días **salvo el domingo** —feriados incluidos—, así que no hay calendario que
mantener.

**La hora de corte no se codifica.** Llega en la cotización, por courier y por
almacén. Vale `14:00` para ALIDRIVER y `16:30` para Olva en el ejemplo de su
documentación; fijarla sería sembrar el próximo fallo.

Replicamos su cálculo por dos motivos, y ninguno es cambiar la guía:

1. **Avisar antes de crear.** Cuando el corte empuja a domingo, la pantalla lo
   dice y pide revisar la fecha en su portal.
2. **Contar los incumplimientos.** `aliclik_expected_dispatch_date` guarda lo que
   su regla manda; `aliclik_reported_dispatch_date`, lo que pusieron —columna
   «FECHA DESPACHO» de su Excel—. La diferencia es la cifra con la que se
   reclama, en vez de «nos pasa a veces».

El aviso solo aparece cuando su cálculo cae en domingo. El resto de los días las
dos fechas coinciden, y un aviso que sale siempre se deja de leer.

> ⚠️ **Esto NO corrige la guía.** Su API no admite fecha, así que el paquete
> sigue llevando lo que Aliclik decida y corregirlo sigue siendo manual, en su
> portal. Ocurrió con `AUR5X846640592825` (#KP123403), creada el sábado
> 29-08-2026 a las 14:13 de Lima —trece minutos pasado el corte— y fechada para
> el **domingo 30**: su regla mandaba el lunes 31, aplicaron la primera mitad y
> no la segunda. El lunes el motorizado vio una fecha vencida y no se llevó el
> paquete.

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

**Un barrido puede repartirse en varias pasadas (02-10-2026).** El recorrido de
la ventana de 14 días son ~13 páginas, y una pasada tiene ~115 s por tienda. El
último barrido completo fue el 29-09 y tardó 112 s; desde entonces cada pasada se
cortaba por tiempo y la siguiente volvía a la página 1, así que las últimas
páginas no se leían nunca y no hubo evidencia para caducar nada. Ahora una pasada
cortada deja anotado su **ciclo** —cuándo empezó, qué ventana consulta y por qué
página sigue— y la siguiente continúa ahí con la misma ventana. Al leer la última
página el ciclo cuenta como barrido completo **desde que empezó el ciclo**, no
desde la última pasada: una intención nacida a mitad del ciclo sigue sin contar
como buscada. Un ciclo de más de tres horas se descarta y se empieza de nuevo.

**El pase de rezagadas no depende de que el barrido termine.** Para no consultar
dos veces lo mismo, salta las guías que la API acaba de leer. «Acaba» son los
últimos **30 minutos**, y no el inicio del último barrido completo: con los
barridos sin completarse esa marca envejeció tres días, y excluía a 531 de 608
guías vivas. Entre ellas estaba #AUR177107, un rechazo del 25-09 que viene de
vuelta: mientras nadie lo releyera, la retención por duplicado de #AUR177661
(§8.3) no podía soltarse.

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

#### Guardar la fila es lo último que puede fallar

La guía ya existe en Aliclik cuando llega el momento de escribir nuestra fila.
Por eso esa escritura —`writeCourierGuide`, que comparten Grupo GF, Aliclik,
Shalom, Tanders y Swayp— tiene que ser **la más difícil de romper del sistema**, no la más
frágil: cualquier cosa que la tumbe deja un paquete vivo del otro lado que aquí
no existe, y un pedido que se muestra SIN guía es una invitación a emitir una
segunda por la misma caja.

**Una columna que la base todavía no tiene no cuesta la fila.** Si el `INSERT`
—o el `UPDATE` que rellena la salida— se queja de una columna inexistente
(`PGRST204` de PostgREST, `42703` de Postgres), se suelta esa columna y se
reintenta. Perder un dato nuevo es un dato de menos; perder la fila es un
paquete fantasma.

- El reintento **no** lleva una lista de columnas nuevas que alguien deba
  acordarse de mantener: olvidarla es exactamente el fallo que esto arregla.
  Lleva la lista de las que **jamás** se sueltan —tienda, pedido, courier,
  guía, estado, categoría, vínculo, procedencia y nombre del pedido—. Si falta
  una de esas, la base no es la que el código espera y el error sube tal cual.
- Solo se suelta lo que se envió, y como mucho cuatro columnas. Más que eso no
  es una ventana de despliegue: es la base equivocada, y conviene que se note.
- Las columnas soltadas vuelven al llamador (`droppedColumns`) en vez de
  desaparecer en silencio.

> ⚠️ **Ocurrió el 05-09-2026.** El despliegue que empezó a escribir
> `aliclik_expected_dispatch_date` (§10.1) salió antes de que se aplicara su
> migración. Aliclik respondió 201 a las dos creaciones —irreversibles, con
> costo— y el `INSERT` reventó por la columna ausente. `AUR5X950324066036`
> (#KP132639) y `AUR5X431594420316` (#KP132644) quedaron vivas en Aliclik y sin
> existir en Kapta, con sus pedidos en «Por confirmar». Las filas se
> reconstruyeron desde el payload guardado en `aliclik_order_requests`, que fue
> lo único que salvó el caso: la intención se registra ANTES de llamar, así que
> el rastro sobrevive aunque la fila no llegue a escribirse.

Indemnización Aliclik:

- Responsable: Yohalis.
- Evidencias: fotografías y valor del producto.
- SLA interno propuesto: máximo al día siguiente de detectar/recibir evidencia.

## 11. Reproprovincia y Swayp

Responsables: Akemi y Mariannys. Akemi es la jefa de Mariannys.

Entrada elegible desde Aliclik: no contesta, intento fallido, rechazo sujeto a
revisión, guía cancelada por courier y devolución.

**Cada transición del courier deja constancia en el PEDIDO.** El barrido de
Aliclik escribe un `courier_status` en el historial cada vez que el estado
cambia de verdad —no en cada pasada, que lo llenaría de líneas idénticas— con
el estado anterior, el nuevo y la **etiqueta cruda de Aliclik**. Esa etiqueta es
donde vive el motivo: «anulado» a secas no distingue si lo mató su LLAMADA
(`ANNULLED` en el tercer campo) o su reparto, y esa es toda la diferencia entre
«el paquete volvió» y «nos cancelaron la venta antes de que saliera».

Se fecha con el `updatedAt` de Aliclik, no con el nuestro: uno es cuándo pasó,
el otro cuándo nos enteramos.

Lo que Aliclik **no** manda es quién hizo el cambio. Su contrato no trae ni
autor ni motivo libre, así que el historial puede decir qué pasó y cuándo, pero
no quién. Para eso hay que preguntarles con el nº de guía y la hora.

**Una guía cerrada NO cierra el pedido.** Las dos últimas entradas de esa lista
—cancelada por courier y devolución— cierran la GUÍA: esa guía sí terminó, el
paquete sí volvió, y `returned_at` se sella. Lo que sigue vivo es el PEDIDO. Por
eso el estado de la guía no se falsea para que reaparezca: falsearlo rompería el
registro de lo que de verdad pasó, y las otras pestañas son ese registro.

Lo que distingue a un pedido cerrado que merece otro intento de uno cerrado de
verdad **no es el estado del pedido** —`anulado` cubre tanto «lo canceló el
courier» como «lo cancelamos nosotros»— **sino la etiqueta que Aliclik puso en
su guía**: un resultado de entrega fallido (`CANCEL`, `ANNULLED`, `REFUSED`,
`NOT_RESPOND`, `RESCHEDULED`) con un despacho que no diga que el paquete nunca
salió del almacén de origen.

#### El ciclo de recuperación (v1.10)

Hasta la v1.10 esa distinción solo la aplicaba el chip «Por recuperar» de
Envíos. El **estado del pedido** la ignoraba: con todas sus guías anuladas el
pedido pasaba a `anulado` —o a `devuelto` al volver el paquete— y el Master lo
mandaba a «Por cerrar · Devolución pendiente de inventario», un balde de almacén
donde nadie que vende mira. Medido en 60 días: **920** pedidos así, 561 de los
últimos 15 días, 570 en ciudad con bodega Swayp; **3** salidas Swayp posteriores
y **0** llamadas registradas — porque la gestión de llamadas es por guía y una
guía anulada no admite gestión.

La regla vive en `lib/reproprovincia.ts` y la leen igual el estado del pedido
(`resolveOrderState`) y la macroetapa (`resolveMacroStage`):

- **Entra** cuando la guía Aliclik queda `anulado` con etiqueta de intento
  fallido y el paquete ya fuera. No espera a que el paquete vuelva: los que
  viajan de vuelta son los más calientes. Desde la v1.19 también entra una
  guía de **Tanders** en `RETURNING` o `RETURNED` (Lima, ventana de 65 días,
  §9): esa guía sigue `en_ruta` mientras vuelve, pero no cuenta como «guía
  viva» para esta regla, porque ya no la trabaja nadie.
- **Mientras dura**, el pedido es `en_proceso · pendiente_nuevo_courier` y el
  Master lo enseña en **En curso · En gestión Reproprovincia** (Lima: «Por
  reprogramar Lima»). La guía Aliclik no se toca —sigue `anulado`, con su
  `returned_at` cuando vuelva— y el paquete devuelto sigue arrastrando el motivo
  `devolucion_pendiente_inventario` **como razón**, conviviendo con la gestión.
- **La ventana** es `return_recovery_max_days` (30 por defecto), el mismo número
  que la recuperación por WhatsApp, contada desde que el courier cerró la guía
  (`closed_at`, que el barrido sella al anular). Las guías anteriores al sello
  no lo tienen: el ancla se deriva del historial de llamadas —la última
  transición terminal, `lib/guide-dates.ts`— y ese cálculo es **el mismo en el
  Master y en Envíos**. Caer a `returned_at` no vale: el retorno llega días
  después del cierre (medido: 58 guías con más de un día de diferencia) y
  estiraría la ventana solo en una de las dos pantallas.
- **No aplica si alguna guía del pedido ya ENTREGÓ**: ése es el reenvío que
  funcionó, la venta terminó bien. Ni si hay una guía viva: la gestión la lleva
  ella.
- **La gestión es sobre el PEDIDO**: la mesa de confirmación registra los
  contactos aunque la guía esté anulada. Reenviar por Swayp es la acción normal,
  no una excepción; si no hay stock en su ciudad, Shalom u Olva con adelanto.
- **Desde Envíos, sobre la guía anulada**, mientras la segunda mitad diga
  «Reproprovincia»: **Reenviar por Fenix/Swayp** (el mismo flujo que la
  excepción sobre anulada, que deja de llamarse excepción: la guía queda madre
  transferida y nace la guía nueva), **Programar próxima llamada**, **No
  contesta** y **Cliente no quiere**, que descarta la recuperación con motivo.
  Ninguna mueve la guía —sigue anulada— y las cuatro alimentan «Última
  gestión». El descarte es el MISMO evento que el del Master
  (`lib/recovery-discard.ts`), y la puerta del servidor es la misma función que
  puso la segunda mitad del badge: si venció, se descartó o ya tiene guía
  nueva, la acción se niega y pide actualizar el panel.
- **Sale** por cuatro puertas: se crea la salida Swayp (pasa a En curso con la
  guía nueva); se reprograma Aliclik (excepción con motivo, como hasta ahora);
  se **descarta a mano con motivo** (evento `recovery_discarded`); o **vence la
  ventana**. Vencida o descartada, el pedido cae por su cadena normal a
  `anulado`/`devuelto` y a Por cerrar, con la razón `recuperacion_vencida`
  escrita cuando fue recuperable y nadie lo trabajó — la única forma de medir
  cuánto se pierde por no llamar.
- **Salvo que el último intento haya sido un rechazo en la puerta** (`REFUSED`):
  entonces la razón es `rechazo_no_reenviado` («Anulado · Rechazo no
  reenviado» en Envíos, la misma subetapa en el Master). Mientras la ventana
  está abierta no cambia nada —sigue en gestión, porque 4 de 12 reenvíos tras
  un rechazo se entregaron—; cambia solo el nombre con que se cierra. Los dos
  canales automáticos excluyen el rechazo a propósito y la cola dice
  «normalmente no se reenvía», así que dejarlo vencer es la regla funcionando,
  no una pérdida. Con la misma razón, la métrica de lo que se pierde por no
  llamar lo contaba igual: medido el 26-09-2026, 36 de las 483 vencidas eran
  rechazos en la puerta y 59 más estaban en camino, todos sin gestión. Decide la
  guía que ancla la ventana, la del **último** intento: si primero no contestó
  y después lo rechazó, es rechazo; si lo rechazó, se reenvió y la última vez
  no contestó, es `recuperacion_vencida`. Un descarte a mano sigue ganando.
- **No gana** sobre una anulación en Shopify: esa la decide una persona.

**Aparecen en la MISMA cola de Pendiente**, no en una pestaña propia: son la
misma pregunta —a quién hay que llamar— y esta sección las lista junto a las
demás entradas elegibles. Se acotan con el chip **«Por recuperar»** de la fila
de filtros. Una pestaña más sería un balde más que nadie mira, que es el mismo
motivo por el que los segmentos de leads se fusionaron.

**La cola abre sin Lima.** Cada salida «por definir» de Lima nace pendiente y
sin courier, así que también caía en Repro Provincia: medido el 24-09-2026, de
la cola pendiente ~3.770 guías eran salidas de Lima contra ~200 de provincia.
Lima se reprograma en su propia mesa (§9). El filtro **Cobertura** —la misma
columna que filtra el Master, `order_master.coverage`— abre con todo marcado
menos Lima; «Limpiar filtros» vuelve a eso y no a «todo», y quien necesite Lima
la marca. Las guías sin pedido vinculado van aparte y se ven por defecto: no se
esconde una guía por no saber su cobertura.

**Envíos aplica la MISMA regla que el Master**, no una propia. Hasta la v1.10
Envíos decidía «por recuperar» con dos condiciones —cerrada y etiqueta de
intento fallido— y el Master con cuatro —más la ventana y el descarte—. Medido
el día que se unificó: 976 guías en la cola de Envíos, de las que 164 el Master
ya daba por vencidas, y un descarte registrado en el Master no sacaba la fila
de Envíos. Ahora `recoveryOutcome` (`lib/reproprovincia.ts`) se calcula al leer
sobre los mismos hechos —todas las guías del pedido, sus `recovery_discarded`,
la anulación en Shopify y la ventana de la tienda— y **solo las activas entran
a Pendiente**. No se lee de `order_master` porque es el resultado de un cron:
tras un descarte diría lo de antes durante minutos.

**El badge de Estado tiene dos mitades.** La primera es la guía —la verdad del
courier, que no se falsea: sigue diciendo «Anulado»—; la segunda es en qué
quedó el pedido: **«Anulado · Reproprovincia»** mientras se puede reenviar,
**«Anulado · Recuperación vencida»**, **«Anulado · Rechazo no reenviado»** (si
el último intento fue un rechazo en la puerta) o **«Anulado · Descartada»**
después. Es
el mismo patrón de «Pendiente · Sin llamar» y «Entregado · por Swayp». Sin la
segunda mitad, una guía viva para Swayp se veía igual que una muerta. En la
tabla de la cola la segunda mitad va en la línea bajo la chapa, entera; en el
cajón y en la lista del teléfono, dentro de la chapa. Las
vencidas y descartadas se quedan en la pestaña Anulado, que es el registro, con
su segunda mitad escrita. No se inventa un `delivery_status` «reproprovincia»:
el barrido de Aliclik lo pisaría en el siguiente ciclo.

La consulta va **acotada por ventana** —la misma anchura que usa la pantalla de
recuperación, `RECOVERY_DEFAULT_MAX_DAYS * 2`— porque el conjunto «cerradas de
Aliclik» crece sin fin. Se consulta más ancho que la elegibilidad a propósito:
para poder MOSTRAR las vencidas con su motivo en vez de esconderlas.

**Dentro de esa ventana se lee todo, por páginas (04-10-2026).** La consulta
cortaba en 1.000 filas ordenadas por `updated_at`, y en 60 días ya había 2.640
cerradas. Como los barridos reescriben `updated_at` a diario, entraban solo las
de los últimos ~8 días: **404 pedidos con la recuperación activa** —todos «En
gestión Reproprovincia» en el Master— no aparecían en la cola, 141 de ellos con
los filtros de trabajo de provincia. Ahora se pagina por `id`, que no se mueve
mientras el barrido escribe, y la cola se ordena después.

La lista y el contador salen de la MISMA llamada. El conteo no puede ser un
`COUNT` exacto porque el predicado necesita partir `reported_status` y eso se
resuelve en memoria; dos caminos distintos para el número y las filas es cómo
el chip acaba diciendo una cosa y la tabla otra.

Sobre esos pedidos **se puede crear una salida Swayp aunque estén cerrados**,
que es lo que da sentido al stock puesto en provincia. Medido al abrirlo: 844
guías así sobre 842 pedidos; 456 con 15 días o menos, y 254 de la última semana
todavía de camino de vuelta — el momento en que llamar sirve más, porque el
paquete sigue cerca de la clienta.

**Segmentos de la cola de leads.** Un lead cae en UN solo balde, primera
coincidencia gana: `carrito` → `interes` → `converso` → `frio`.

`interes` junta dos señales que son la misma pregunta contestada de dos
maneras: **dio su distrito** de envío (dónde lo quiere) o **llegó desde la
ficha de un producto** (qué quiere) — el mensaje trae la URL prellenada porque
tocó «consultar por WhatsApp». Ninguna de las dos llega a carrito armado.

Van juntas por dos razones. La operativa: se probaron separadas y el equipo no
trabajaba las del medio — con cinco baldes, los de en medio no los atiende
nadie, y un balde que nadie mira no clasifica, estorba. La del dato: separadas,
las dos tiendas se contradecían en el orden (en Aurela la ficha cerraba por
encima del distrito, en Kenku por debajo), así que no existía un orden único
que fuera cierto en las dos. Unidas, sí.

Tasa de cierre entre los LLAMADOS, 60 días:

| Segmento | Aurela | Kenku |
|---|---|---|
| `carrito` | 43,5 % | 35,6 % |
| `interes` | 12,2 % | 19,1 % |
| `converso` | 2,6 % | 6,3 % |
| `frio` | 0,5 % | 1,3 % |

Mismo orden en las dos tiendas; lo que cambia son las magnitudes, y por eso los
pesos de llamada son por tienda.

**El filtro parte `interes` en Distrito y Producto (05-10-2026).** La fila de
chips del Segmento ya no muestra «Distrito o producto»: muestra **Distrito**
(dio su distrito, con o sin ficha) y **Producto** (solo llegó desde la ficha),
y la pastilla de cada fila dice «Dio distrito» o «Vio producto»
(`QUEUE_BUCKETS` / `leadQueueBucket` en `lib/leads.ts`). Quien trae las dos va
a Distrito: decir dónde lo quiere está más cerca de comprar que mirar el
producto. El motivo es el volumen: al abrirlo, sin carrito en la cola había
687 con distrito (Aurela 136, Kenku 551) y 876 solo con la ficha (Aurela 173,
Kenku 703); en un solo chip no se podían trabajar por tandas. Un `?seg=interes`
guardado de antes abre «Todos».

Solo cambia el FILTRO. La prioridad de llamada sigue con los cuatro segmentos
de arriba y su `interes` único (`leadSegment`): la razón del dato —el orden
entre las dos señales se contradice entre tiendas— sigue en pie, así que no se
les da un peso distinto.

**Cobertura de la cola de leads (04-10-2026).** Al lado del segmento, la cola
se parte en **Lima / Provincia / Sin identificar** (`lib/lead-coverage.ts`).
Es una pista para repartir llamadas, **no** la cobertura del pedido: esa sigue
teniendo una sola definición, `order_coverage_for` (§5), y el pedido la recibe
al nacer. Por eso existe un tercer valor que el pedido no tiene: un lead que no
dijo dónde vive no es de provincia, es uno del que no se sabe. Medido al
abrirlo: el 71 % de los ~3.000 «Sin llamar» no tenía ni distrito ni región.

Se decide con la primera señal que sirva:

1. **Su propia dirección**: la del carrito de Shopify, la guardada del cliente
   (el Flow deja el departamento en `province`, no en `region`) o la respuesta
   del chat. Lima es la MISMA regla del pedido (`isLimaMetropolitanaOrCallao`,
   espejo de `is_lima_metropolitana`) y las excepciones de `district_coverage`
   mandan igual (Pucusana → Provincia). El botón «¿Lima o provincia?» del bot
   cuenta como respuesta. Un texto libre se lee buscando distritos de Lima y
   departamentos, provincias o ciudades de fuera; si nombra las dos cosas, o un
   distrito que existe en Lima y en provincia (Independencia, La Victoria),
   queda Sin identificar.
2. **El último pedido del mismo teléfono** (`order_master.coverage`, 0225),
   solo si lo propio no alcanza: lo que contestó hoy es más nuevo.
3. **La dirección del cliente en Shopify** (`lead_shopify_locations`, 0228),
   solo si tampoco compró antes. La base tiene todos los pedidos desde que
   abrió cada tienda, pero no todos los carritos (los de Kenku empiezan el
   06-05-2026), y cada carrito viejo dejó en Shopify un cliente con su
   dirección. La sincronización busca por celular, con la conexión de la
   tienda, a los leads de la cola sin ubicación ni pedido (30 por tienda y
   corrida, los más nuevos primero, una vez por lead), y el reporte de la
   corrida dice cuántos buscó y cuántos tenían dirección. Va en una tabla
   aparte y no en el lead: un carrito de hace un año no es «dio su distrito»
   (no cambia el segmento) y escribir en `leads` haría recargar la cola en
   todas las pantallas.

«Lima (departamento)» sin un distrito legible **no** se da por Provincia: de
los pedidos con esa región de los últimos 120 días, 188 de 633 (30 %) resultaron
de Lima Metropolitana por su distrito. Las frases del bot que el lector del
chat guardó como distrito («indicarte bien 🚚», «coordinarlo») no son lugar y
quedan Sin identificar.

**Qué cuenta como distrito dicho en el chat (05-10-2026).** El lector
(`parseOrderSignals`, `lib/kapso.ts`) guardaba como distrito cosas que no lo
eran: medido en la cola, 459 leads, el 40 % de los que tenían distrito sin
carrito. Dos fallos:

- **El eco tomaba el texto del bot.** Si el cliente no contestaba la pregunta
  de ubicación, se guardaba lo que seguía a «envío … para» en el propio mensaje
  del bot: «indicarte bien 🚚» (130 leads), «Lima o provincia», «tu zona». Ahora
  el eco solo cuenta si nombra un lugar que se reconoce y no sale de una
  pregunta del bot.
- **Cualquier respuesta corta valía.** «Precio», «¡Hola! Quiero más
  información», «Gracias mañana te llamo», «Selected: Sí, la misma». Ahora
  (`isPlaceReply`) vale un lugar que se reconoce, el botón «Lima / Provincia»
  (sin el «Selected:»), o un texto corto sin números ni palabras de
  conversación, que es como se ve un distrito chico fuera de las listas.

Lo ya guardado no se corrige solo: la sincronización rellena el distrito pero
nunca lo borra, y releer la conversación con el lector nuevo solo lo
reemplaza si encuentra un lugar. Por eso se limpió aparte, una vez, el
05-10-2026: los 705 valores distintos de la cola pasaron por `isPlaceReply`
y, en todos los leads sin carrito con esos mismos valores, 2.049 quedaron sin
distrito y 546 perdieron el «Selected:». Cambia su segmento —de 276 «Sin
llamar», 207 dejaron `interes`—, no su estado: ninguno salió de la cola. No
se tocó `updated_at`, que ordena Ganados y Perdidos. El valor anterior quedó
en `lead_district_cleanup_20261005` (sin acceso desde la app), y revertir es
`update leads l set district = b.old_district from
lead_district_cleanup_20261005 b where l.id = b.lead_id`. Los leads cerrados
con valores que no estaban en la cola no se revisaron.

**Dentro de `carrito`, primero la que armó varios (Kenku, 30-09-2026).** Quien
armó 2 o más carritos en 48 horas cierra más cuando se la llama, en los cuatro
tramos horarios. Mismo método que la tabla de arriba —60 días, solo carritos
llamados, carritos contados hasta la primera llamada—:

| Hasta la 1.ª llamada | 1 carrito | 2+ carritos |
|---|---|---|
| < 1 h | 30,6 % (1.593) | 42,9 % (49) |
| 1–6 h | 16,3 % (897) | 26,7 % (45) |
| 6–24 h | 12,5 % (1.348) | 19,3 % (109) |
| + 1 día | 4,6 % (675) | 12,1 % (66) |

En la cola, el peso del carrito se multiplica por **1,5** (medido: 1,59 veces lo
esperado, z ≈ 4,1; se redondea hacia abajo). Solo el peso, no el bono de ticket.
Lo que se afirma es el orden **dentro** de cada tramo; entre tramos el factor
produce cruces que la muestra de «2+» no alcanza a confirmar ni a desmentir.

**Aurela no lo lleva:** 44 llamadas, 11 cierres contra 8,7 esperados (z ≈ 0,9).
Sin muestra no se inventa. El dato vive en `leads.cart_count_48h` (0207), que
escribe la sincronización de carritos junto con el carrito de la fila; sin la
migración aplicada, la cola se ordena como antes.

Esto ordena la llamada, no la reemplaza. Se descartó crear el pedido de forma
automática para esta señal: incluso aquí, 6 de cada 10 carritos que siguen
abiertos a las dos horas no terminan en pedido.

**Carrito que ya es pedido (29-09-2026).** Un carrito sale de la cola de
llamadas en cuanto llega un pedido que cumple cuatro variables fijas:

1. Mismo teléfono que el carrito.
2. El pedido no está anulado.
3. El pedido es posterior al carrito.
4. El pedido trae al menos un producto del carrito — mismo id de producto,
   mismo SKU o mismo nombre. Hacen falta los tres porque los carritos de
   EasySell a veces llegan sin id de producto.

El lead pasa a `ya_tiene_pedido` (ganado) con el pedido vinculado, pierde la
fecha de seguimiento —la vista Seguimientos lista por fecha sin mirar la
categoría— y queda una fila `system` en su historial con el número del pedido.
No le da la venta a ninguna asesora: eso lo decide `order_sales`, no el estado
del lead.

Por qué existe. El vínculo pedido → lead solo lo hacían los pedidos con tag
`kapso`. Un carrito que la clienta cerraba por otra vía —el bot de carritos
(«BOT + CARRITO RECUPERADO»), un formulario nuevo en la web, una venta manual—
se quedaba en «Sin llamar». Medido en 30 días: 56 carritos así, y en 23 la
asesora llamó a quien ya había comprado y lo cerró como «Ya compró en otro
lado», un perdido que era una venta nuestra.

**No hay ventana de horas**, a propósito. De esos 56, 24 compraron en menos de
una hora y 20 más de siete días después: con «últimas 24 h» quedaba la mitad en
la cola. La ventana tampoco protege de nada, porque la variable 3 ya impide que
un pedido viejo cierre un carrito nuevo. Si compró **otro** producto, el
carrito se queda en la cola: ahí sí hay algo que ofrecer.

Alcance:

- Solo leads **en cola** (open/hot), sea cual sea su estado dentro de ella. No
  crea leads —cada cliente de la web sería un ganado falso— ni reescribe un
  perdido o un ganado.
- Solo carritos respaldados por un borrador de Shopify (`draft_order_gid`): el
  carrito deducido del chat no trae productos con qué comparar.
- Si la asesora registró una gestión **después** del pedido, manda su
  resultado: ya habló con la clienta.

Corre en dos lugares: el webhook de pedidos, al instante, para todo pedido sin
tag `kapso` (los que sí lo llevan ya ganan el lead por su camino); y el cron,
que revisa los pedidos de los últimos `CART_ORDER_SWEEP_DAYS` días como red de
seguridad. El cron va después de sincronizar pedidos y carritos: si el sync de
carritos crea el lead de un carrito cuyo pedido ya llegó, sale de la cola en la
misma corrida.

**Quien ya compró y arma un carrito nuevo vuelve a la cola (recompra,
01-10-2026).** Un lead ganado —`pedido_generado` o `ya_tiene_pedido`— vuelve a
«Sin llamar» como `carrito` cuando arma un carrito abierto **7 días o más
después de su último pedido activo** (`isRepurchaseCart`). La clienta trae la
dirección del pedido anterior, y «Generar pedido» ya distingue una recompra de
un duplicado.

Por qué hacía falta. El código decía reabrir la recompra, pero dos guardas lo
impedían siempre: la sincronización de conversaciones no miraba la intención si
el lead ya estaba ganado, y la de carritos no reabría un `pedido_generado` ni un
`ya_tiene_pedido`, que son los únicos estados ganados. En 52 días quedaron 481
carritos de recompra escondidos en «Ganados»; aun sin que nadie los llamara,
el 27,3 % terminó en pedido.

Por qué 7 días y no «cualquier carrito posterior». En 60 días, 302 carritos
aparecieron **menos de una hora** después de un pedido —296 de ellos «abandono»
de EasySell— y los de menos de 7 días terminaron en pedido un 5,8 %: son
residuos del propio formulario. Ese era el motivo del bloqueo; el mínimo de días
los deja fuera sin esconder las compras nuevas. Coincide con la regla de negocio:
«no tiene pedido hace más de 7 días».

Lo que se respeta:

- Para **reabrir** un ganado, el carrito tiene que ser posterior a la última
  gestión de la asesora, como siempre.
- Una vez en cola, la gestión de la asesora («no responde», etc.) manda: la
  siguiente sincronización no la devuelve a ganado mientras la recompra siga
  abierta.
- Un pedido **viejo** que Shopify vuelve a notificar (se actualizó) solo se
  vincula; no vuelve a ganar el lead si su carrito es de 7+ días después.
- Un ganado **sin pedido activo** sigue sin reabrirse por un carrito cualquiera
  (sin cambios).

Fuera de alcance: quien solo escribe por WhatsApp sin armar carrito. Su mensaje
vive en Kapso y no dice producto ni cantidad en un campo que se pueda leer.

**Prueba: pedido de recompra sin llamada (`exp-recompra-1`, 02-10-2026).** Un
grupo cerrado de ~30 carritos de recompra se convierte en pedido **sin llamar
antes**, para medir cuántos se entregan y decidir si se automatiza. No es la
regla general: solo se generan los carritos que una persona cargó uno por uno
en `auto_order_trials` (0214). El cron (`lib/auto-order-trials.ts`, paso 1d)
los procesa.

Qué se generó y por qué esos. Del barrido de recompras del 02-10-2026 (68
carritos) se eligieron los de cliente cuyo **último pedido se entregó**, que
**no escribió después** de armar el carrito y que nadie había gestionado. Cada
fila lleva un grupo, porque cada uno prueba una regla distinta que se querría
automatizar:

- **A** — la dirección del carrito es la misma donde ya se le entregó.
- **B** — el carrito traía «-» o le faltaba el distrito; se usa la dirección de
  su entrega anterior (la fila la trae y se le pone al pedido).
- **C** — dirección nueva, real, distinta de la anterior.

Quedaron fuera los de último pedido aún en curso, devuelto o anulado, y los que
escribieron después del carrito.

Justo antes de completar, cada fila se vuelve a validar (`trialSkipReason`): el
lead sigue `nuevo` y sin gestión, el carrito sigue siendo el suyo y abierto
—también en Shopify—, el total es mayor que cero, el carrito tiene 12 días o
menos, el cliente no compró después y hay una dirección despachable. Si algo
falla, la fila queda `omitido` con el motivo y no se toca Shopify.

Qué hace al generar:

- Si la fila trae dirección (grupo B), la pone **en el borrador antes de
  completarlo**, sin tocar productos ni precios. Si Shopify no la guarda, el
  pedido no se genera (`direccion_no_aplicada`). Corregirla en el pedido ya
  creado pide `write_orders`, que las tiendas no dieron: el 02-10-2026 seis
  pedidos del grupo B salieron así con la «-» del formulario y hubo que
  corregirlos a mano en Shopify.
- Completa **el mismo borrador** del cliente (`paymentPending`): mismos
  productos, cantidades y precios que vio en el formulario.
- Intenta etiquetar el pedido en Shopify con `auto_recompra` y la cohorte. Sin
  `write_orders` no puede, y no hace falta para medir: la tabla guarda el
  pedido.
- Gana el lead (`pedido_generado`) y deja una fila `system` en su historial.
  **No acredita la venta a ninguna asesora**: nadie la cerró.
- El pedido sigue el camino normal del Master: Lima entra directo a
  Preparación; Provincia COD y Agencia pasan por «Por confirmar» como cualquier
  otro.

Cómo se mide. `auto_order_trial_results` cruza cada fila con el Master. La
comparación es contra los pedidos de recompra normales de julio-agosto de 2026
(cliente con un pedido entregado al menos 7 días antes): Kenku entregó el 76 %
en Lima, el 66 % en Provincia COD y el 65 % en Agencia; Aurela, ~60 %. Con 30
pedidos el margen es de unos ±18 puntos: alcanza para ver si se entrega «casi
igual» o «claramente peor», no diferencias finas.

**Qué couriers ve la cola.** `shipments` es el libro de TODAS las salidas, así
que la cola tiene que recortar: quedan fuera **Shalom, Olva, Tanders, Urpi y el
reparto propio**. Shalom y Olva son agencia —la clienta recoge en el terminal,
no hay intento de entrega que reprogramar— y por eso aparecen como DESTINO de
una recuperación (§11.1, §12), nunca como insumo; las guías Olva se cotejan en
«Cotejar Olva». Los otros tres no se reprograman desde esta pantalla.

El recorte es una lista de **excluidos**, no de admitidos: un courier nuevo
entra en la cola y alguien pregunta qué hace ahí. Con una lista de admitidos
desaparecería sin que nadie se enterara, y trabajo que falta no se ve.

#### Lo que la cola listaba sin tener nada que ver (04-10-2026)

Con la cola abierta como la trabaja el equipo —sin Lima, «Swayp: Fuera de
cobertura», «Sin contactar hoy»— salían 341 guías y **47 no eran trabajo de
reprogramación**: 15 de pedidos anulados en Shopify, 12 de pedidos cuyo primer
despacho aún no salía, 17 guías Olva (Olva no estaba en la lista solo porque
nadie la había nombrado) y 3 de pedidos por cerrar. Desde ese día:

- **Las salidas `por_definir` salen de Pendiente.** Son cajas armadas esperando
  courier (§4): la decisión que les falta es de despacho, no de reprogramación.
  Medido ese día: 3.250 pendientes así —1.245 de pedidos anulados en Shopify,
  1.254 de primer despacho por armar o por asignar, 730 salidas adicionales de
  pedidos por cerrar— y **ninguna** de un pedido en gestión Reproprovincia: el
  reenvío nace directo como guía Swayp. Eran el 77 % de la pestaña. Una
  `por_definir` anulada sigue en la pestaña Anulado, que es el registro.
- **Una guía de un pedido anulado en Shopify sale de Pendiente**, como ya salía
  de «Por recuperar»: la recuperación no gana sobre una anulación que decidió
  una persona (más abajo). La anulación vive en `orders`, así que este recorte
  va después de leer las filas, y por eso el chip de Pendiente cuenta filas en
  vez de pedir un conteo: la lista y el chip pasan por la misma función. Si la
  lectura de pedidos falla, la guía se queda.

**Y tampoco entra lo que Aliclik todavía no ha sacado del almacén.** La cola es
para lo que se intentó entregar y no se pudo; una guía recién preparada no tiene
nada que reprogramar. Había 92 así entre las pendientes —89 sin un solo intento,
varias creadas ese mismo día— y la pantalla les ofrecía ruta Fenix como a
cualquier otra.

El criterio es la **custodia física**, no el contador de intentos. `TO_PREPARE`
y `PREPARED` dejan el paquete en custodia `empresa`; desde `PICKED` pasa a
`courier` (§6.2). El contador sale del Excel y puede sencillamente no venir —la
pantalla ya lo dice, «Sin NRO. INTENTOS en Excel»—, así que filtrar por él
confundiría «no hubo intento» con «no nos lo contaron». Hay 2 guías en poder del
courier sin intentos informados: con la custodia se quedan, que es lo correcto.

Dos límites, los dos deliberados:

- **Solo Aliclik.** Las guías Fenix pendientes también están en custodia
  `empresa`; sacarlas es otra decisión y no está tomada. Las `por_definir` salen
  por su propia regla (arriba), no por la custodia.
- **Solo la pestaña Pendiente.** `custody_state` no se actualiza al entregar, así
  que en una guía cerrada el valor es viejo y no significa «sigue en el almacén».
  Aplicar el recorte a todas las pestañas escondía 317 anuladas, 78 entregadas,
  46 en ruta y 15 transferidas. Las otras pestañas son el REGISTRO de lo que
  pasó: esconder ahí una guía entregada es perder historial, no limpiar una cola.

El mismo recorte se aplica a la lista y a los contadores de las pestañas, desde
una sola definición: el número del chip se lee justo encima de la tabla, y si
cada uno filtrara por su cuenta podrían decir cosas distintas.

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

**El mensaje nombra el pedido, y ese nombre sale del pedido ENLAZADO.** No de la
copia que guarda la guía. La copia puede ser una conjetura del importador (0115)
—18 guías donde difiere del enlace— y sobre todo puede estar vacía aunque el
enlace exista: 602 guías así el 2026-08-21, 134 de ellas devueltas y dentro de la
ventana. Sin nombre del pedido **no se escribe**: el token no cae al código de
guía, porque «por tu pedido AUR5X619171670545» es un código interno del courier
que la clienta no ha visto nunca, en un mensaje que además le pide un adelanto.

Esa regla vive en **una sola función** (`recoveryOrderName`) y la usan las tres
cosas que antes decidían por su cuenta: el filtro de la cola, el token de la
plantilla y la etiqueta de la pantalla. Estaban en desacuerdo — el filtro miraba
el enlace, la etiqueta miraba la copia y el token caía a la guía—, y el síntoma
era una fila que decía «sin pedido» al lado de un botón «Enviar» habilitado.

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
Cusco, Trujillo, Ica, Piura, Chimbote, Chiclayo, Lima/Callao.

**Lima y Callao** entraron el 14-09-2026, cuando la bodega de Lima de Swayp pasó
a despachar pedidos desde el sistema. Lima provincia son 44 distritos (el padrón
ya trae Santa María de Huachipa, `150144`, creado en 2023) y Callao 7. **El
Callao es destino propio pero se despacha desde la bodega de Lima**, con el
stock de Lima — el mismo arreglo que Puno con Juliaca: tabla de ubigeo aparte
para no mandar el paquete a un distrito equivocado, y alias al almacén para no
inventar una bodega que no existe. En `SWAYP_SENDERS` van las dos claves,
`lima` y `callao`, porque el envío llega con su ciudad y el remitente se busca
por ella.

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

«Exacto» es sobre el DISTRITO, no sobre cómo se escribe. El nombre llega del
campo *city* de la dirección de Shopify, que usa el nombre oficial completo, y
el padrón a veces usa el corto: «Lurigancho-Chosica» contra «Lurigancho». El
guion, la barra y la coma se leen como separador, y las grafías conocidas
—«Surco», «Cercado de Lima», «Chosica»— tienen alias. Lo que sigue sin resolver
se rechaza: un nombre ambiguo como «San Juan» o «Huachipa» no se adivina.
Esto vino de #KP132394, donde la cobertura aceptaba la guía y el ubigeo la
negaba —comparaban distinto— y la salida se creó con código manual.

Falta la configuración de bodega Swayp (`senders`) de las cuatro ciudades
nuevas; sin ella la guía se niega aunque el ubigeo resuelva. Es configuración
operativa, no código.

Una salida Swayp puede coexistir con la devolución Aliclik. En Reproprovincia
Swayp se puede repetir, siempre con una salida, guía y QR nuevos, dentro del
máximo global.

### De dónde sale el stock: el conteo de Swayp, no la carga a mano

`fenix_stock` se llenaba a mano y se fue separando de la realidad sin que nada
avisara. Medido el 14-09-2026 contra dos exportaciones reales del panel:

| ciudad | referencias nuestras | de Swayp | unidades nuestras | de Swayp |
| --- | --- | --- | --- | --- |
| Trujillo | 25 | 17 | 177 | 116 |
| Juliaca | 19 | 7 | 185 | 165 |

Esa tabla es la reja que decide si el botón deja crear la guía, así que un saldo
fantasma no es un número feo en una pantalla: **autoriza guías que Swayp después
rebota por falta de inventario** (su motivo 18), con el pedido ya prometido al
cliente. El caso que lo destapó fue #KP123585, Ethiopian Oil en Juliaca: nuestra
tabla decía 25 unidades y esa bodega no tiene el producto.

La fuente pasa a ser la exportación de Swayp (**Stock → Inventario**, elegir
bodega, «Enviar a Excel»), que se sube en Stock Swayp. Reglas:

- **Un archivo por bodega**, y la ciudad sale de la columna `Bodega` del propio
  archivo. No hay selector: elegir la ciudad a mano es la forma de importar
  Trujillo sobre Juliaca y poner a cero una ciudad entera.
- **Sólo se toca la ciudad del archivo.** Nuestra tabla cubre nueve ciudades y
  Swayp tiene cinco bodegas: Cusco, Huancayo, Ica, Chiclayo y Chimbote se
  abastecen de otra forma y un importador que «limpiara lo que no vino» las
  vaciaría de un plumazo.
- **Lo que Swayp no lista queda en 0**, no se borra el renglón. La exportación de
  una bodega es su inventario completo; si una referencia no aparece, esa bodega
  no la tiene. El producto sigue existiendo y mañana puede reponerse.
- **Lo que Swayp tiene y la ciudad no tenía anotado se da de alta**, copiando la
  etiqueta con la que ya nombramos ese SKU en otra ciudad. Sin esto se perdían
  34 unidades reales sólo en Trujillo (AURE008 y AURE014). La etiqueta se copia y
  no se inventa porque `product` es lo que se cruza contra `shipments.product`:
  un renglón llamado «SUPER HUMAN FOCUS» sería stock que existe y nunca se
  encuentra.
- **El emparejamiento es por `codbar` vía Catálogo de productos**, nunca por
  nombre. Los títulos de Shopify y los de Swayp no coinciden («SUPER HUMAN
  Ethiopian Black Seed Oil – Aceite…» contra «ETHIOPIAN OIL»). Un código sin
  vincular se reporta con su nombre; no se adivina.
- **Se toma la columna `Disponible`**, no `En bodega`: la segunda incluye lo
  reservado para guías ya emitidas, que no se puede volver a prometer.
- Todo pasa por el kardex como `ajuste` (o `entrada` en las altas), así que el
  saldo conserva su historial y se puede responder «¿por qué bajó esto?».

**Juliaca y Puno comparten una sola bodega** (ubigeo `211101`) y el importador la
escribe sólo en `juliaca`. Poner las mismas unidades también en `puno` haría que
un mismo frasco habilite dos guías en dos ciudades — el sobreprometer que esto
viene a cerrar. Servir Puno desde esa bodega necesita que la tabla tenga concepto
de **bodega** y no de ciudad; hasta entonces no se inventa.

La carga a mano sigue existiendo para lo que el Excel no cubre, pero es el
parche: la fuente es el conteo de Swayp.

#### El mismo conteo, leído por API (desde el 29-09-2026)

Kapta lee el inventario de Swayp directo (Stock Swayp → «Sincronizar stock
desde Swayp»): **una sola lectura trae todas las bodegas**, en vez de un archivo
por bodega. La fuente es **`GET /v1/integrations/products` de la API de
integraciones, con la misma credencial que las guías** (`SWAYP_TOKEN`): cada
producto trae su `codbar` y, por bodega, `idBodega` (el ubigeo de la ciudad,
a veces sin el cero inicial), `nombre`, `lot` y `quantity` —el Disponible;
los lotes de una misma bodega se suman—. El API interno del panel queda sólo
de respaldo, con un token pegado a mano que no se guarda. Las reglas de arriba no cambian
—mismo `planearImportacion`, misma columna Disponible, mismo emparejamiento por
`codbar`, mismo kardex— y además:

- **Dos pasos: leer y aplicar.** «Leer» muestra el diff por ciudad sin escribir.
  «Aplicar» escribe sólo las ciudades marcadas y **vuelve a leer Swayp en ese
  momento**: no aplica el diff que tenía la pantalla, que pudo quedar viejo.
- **La ciudad sale de la bodega de fulfillment**, por su nombre («BODEGA
  TRUJILLO», «Juliaca - Puno»), su ubigeo INEI, una ciudad nombrada dentro del
  nombre («BODEGA CHICLAYO») o, en el respaldo del panel, la última ciudad
  nombrada en la dirección. En el respaldo del panel, las bodegas son las de
  `warehouse/getAll` y no las de `warehouses/byCompany`, que es la bodega de
  **recojo** de la empresa.
- **Un código de Swayp sin vincular en Catálogo no se carga, y el producto que
  le corresponde de nuestro lado pasa a 0**: para Kapta, Swayp no lo tiene. La
  pantalla lo avisa antes de aplicar cuando en una ciudad coinciden productos
  que van a 0 y códigos sin vincular; se vincula en Catálogo y se vuelve a leer.
- **Sólo se sincronizan Arequipa, Trujillo, Juliaca, Piura y Lima**
  (`CIUDADES_DEL_SYNC`), las mismas que el Excel sabía leer. Una bodega que
  resuelva a otra ciudad, o que no resuelva, se muestra y **no se toca**.
  Sumar una ciudad al sync es una decisión, no un efecto del mapeo.
- **Una ciudad que no vino en la lectura no se vacía**, y una lectura vacía
  (0 filas) no se aplica: es un fallo de Swayp, no un inventario en cero.
- Si dos bodegas caen en la misma ciudad, sus unidades **se suman**.

**Sync diario (desde el 29-09-2026).** Sobre todas las ciudades del sync, con
las mismas reglas y además:

- **Una vez al día basta** (decisión de Frankz, 29-09-2026): sincroniza sólo si
  la última sincronización buena, manual o automática, fue hace ≥ 20 h. El cron
  (`/api/cron/swayp-inventory`) revisa cada hora y casi siempre responde «al día».
- **Con la credencial de integración de la organización**, la misma de las
  guías: no vence, no depende de que nadie inicie sesión y no se guarda nada
  nuevo. Hubo dos intentos antes, retirados el mismo día: la sesión del panel
  reutilizada y una extensión de Chrome que la enviaba (el panel exige
  reCAPTCHA, así que su login no se automatiza nunca). Con la API de
  integraciones no hacen falta; sus tablas se borraron (0203).
- **Retiene la ciudad que quedaría vaciada** y no la aplica: si Swayp no trae
  ninguna unidad para una ciudad con stock, o si dejaría en 0 más de la mitad
  de sus productos con stock (y al menos 5). Es más probable una lectura rota
  que una bodega vaciada de un día para otro. La ciudad retenida se muestra en
  Stock Swayp para que una persona la lea y la aplique con el botón.
- **Cada corrida queda registrada** (`swayp_inventory_sync_runs`), automática o
  manual, con su resultado o su error. Stock Swayp muestra la última y avisa si
  el último intento automático falló. Un cron que falla en silencio es peor que
  el Excel.
- En el kardex, los movimientos del cron dicen «Swayp (API, automático)» y no
  tienen usuario.
- `/v1/integrations/products` **no está en la documentación pública** de Swayp
  (sólo `/v2/guias`): la forma se fijó con una respuesta real. Si Swayp la
  cambia, la lectura falla con el status y la respuesta a la vista, y quedan
  de respaldo el token del panel y el Excel.

### Stock sin control de cantidad (Lima)

Lima entró a cobertura el 14-09-2026 y la operación decidió **no contar
unidades** ahí: la bodega de Lima repone sola y lo que importa es *qué*
productos despacha, no cuántos hay. **Es una regla de la ciudad**
(`CIUDADES_SIN_CONTROL_DE_CANTIDAD` en `lib/fenix.ts`): todo producto anotado
en Lima —y en el Callao, que se sirve desde esa bodega— vale como disponible
sin que nadie marque nada. Se decidió por ciudad y no por renglón porque la
carga de Lima son decenas de productos y una casilla por producto es una forma
de olvidarse una; un renglón olvidado es un pedido rechazado por «sin stock» en
una ciudad donde el stock no se cuenta. La marca por renglón
(`fenix_stock.unlimited`) queda para la excepción inversa: un producto sin
control en una ciudad que sí cuenta. En cualquiera de los dos casos, el renglón
dice «este producto existe en esa bodega» y nada más:

- las dos rejas —reprogramación y guía directa— lo dan por disponible sin mirar
  la cantidad (una sola definición, `stockDisponible`, para que no discrepen);
- la entrega no lo descuenta, porque no hay saldo que llevar;
- el reporte de demanda nunca lo marca como faltante y la pantalla muestra ∞;
- el importador del Excel de Swayp **no lo toca**: ni lo ajusta ni lo pone en 0
  por no venir en el archivo;
- el kardex manual lo rechaza: mover un saldo que no significa nada sería ruido.

**En Lima y Callao la tabla de stock no gobierna nada: todo producto pasa la
reja.** No hay que anotar renglones. Lo que sí se exige es el **vínculo en
Catálogo de productos** (`codbar`). Se probó la alternativa —exigir además un
renglón por producto en Stock Swayp— y la primera guía real de Lima (#KP131993)
salió rechazada por «sin stock» con la tabla vacía: era una segunda lista que
mantener para decir lo mismo que ya dice el Catálogo. Anotar renglones en Lima
queda como opcional e informativo.

#### El número de guía lo emite Swayp. Sin su número no hay guía

Dos familias de número convivieron hasta el 16-09-2026:

| Forma | Quién la emite | Ejemplo | `swayp_guide` |
| --- | --- | --- | --- |
| **Guía Swayp** | Swayp, por su API | `50000132589` | lleno |
| **Código Kapta** | Kapta, `<pedido><DDMMYYYY>` | `#KP13166415092026` | vacío |

El código Kapta era el respaldo: si la API no emitía —ciudad sin bodega
configurada, producto sin codbar, error de Swayp— la guía se creaba igual con un
número nuestro y se cargaba después a mano por el Excel de programación. En el
código se llamaba «código local» en un sitio y «código manual» en otro.

**Ese respaldo se retira.** Un número que Swayp no emitió no sale en su panel, no
descuenta su stock y no rastrea: es una caja despachada contra un número que no
existe para el courier que la lleva. Con las once bodegas configuradas
(16-09-2026, todas menos Ica) la API puede emitir en toda la cobertura, así que
el respaldo dejó de pagar lo que costaba.

Reglas:

- Las cuatro puertas que paren una guía Swayp —guía directa, reprogramación
  confirmada, reenvío de una anulada y alta con número escrito a mano— exigen un
  número emitido por Swayp.
- Si la API no emite, **la gestión no se registra** y el aviso dice el motivo que
  dio Swayp. Antes ese motivo quedaba enterrado en una frase al final que nadie
  relacionaba con nada; era lo único que se perdía al caer al código Kapta.
- El alta con número escrito a mano sigue existiendo, para registrar una guía que
  la operadora ya creó en el panel de Swayp. Pero el número tiene que **ser de
  Swayp**: solo dígitos. Medido sobre 90 días, `^\d{6,}$` separa las dos familias
  sin tocar ninguna guía buena (62 con forma Swayp, 598 con forma nuestra, 3 de
  julio con `KP…` sin almohadilla).
- Los botones «Autogenerar» de las dos pantallas se retiran: acuñaban justo el
  número que esta regla prohíbe.
- **Ica queda fuera** mientras Swayp no tenga bodega allí; sin bodega no hay API
  y sin API no hay guía, así que Ica no despacha por Swayp.

El nombre queda fijado para no volver a tener dos: **guía Swayp** la que emite
Swayp, **código Kapta** la que acuñábamos nosotros. No se usa «manual», que ya
nombra la salida de ruta manual y la excepción manual de Aliclik.

#### El vínculo se comprueba ANTES, no dentro de la llamada a Swayp

Que la reja de Lima sea el vínculo tiene una consecuencia que al principio se
pasó por alto: **si nadie lo pregunta hasta el final, la pantalla miente todo el
rato**. El panel de guía directa anunciaba «Stock Swayp disponible para todo el
pedido» —cierto según la regla de la ciudad— sobre un producto que Swayp no
tiene en su catálogo. Pasó con #KP134541 el 15-09-2026: la Pulsera Magnética de
Cobre Saludable entró con el SKU `5463456456`, y el vínculo existía para otra
variante (`64565434`).

Y lo que venía después era peor que un aviso tardío: al crear la guía, la llamada
a Swayp fallaba con «Falta vincular a Swayp», el flujo caía al código local y
**la guía se creaba igual**. Una caja despachada contra un número que Swayp nunca
emitió, con el fallo contado en un aviso al final.

Reglas:

- **Sin vínculo de codbar no se genera guía Swayp. Ninguna, por ninguna puerta.**
  No es solo la guía directa: son las cuatro que paren una guía —guía directa,
  reprogramación confirmada, reenvío de una guía anulada y alta con número
  escrito a mano—. En Kapta las tres últimas pasan por `spinOffFenixGuide`, y la
  reja vive **ahí**, en el cuello, para que la quinta puerta que alguien añada no
  nazca sin ella.
- El vínculo se comprueba con una sola función (`productosSinVinculo`) y el aviso
  lo escribe una sola (`avisoSinVinculoSwayp`). Una copia por pantalla acabaría
  nombrando productos distintos en el aviso y en el rechazo.
- **El botón se apaga Y dice por qué.** Un botón apagado sin motivo manda a
  adivinar; y peor, un botón encendido que el servidor rechaza deja a la asesora
  descubriéndolo con la clienta al teléfono. El motivo nombra los productos y la
  pantalla donde se arregla. Marcarlos solo en una columna a la derecha de una
  lista no basta.
- **«Sin stock» y «sin vínculo» son hechos distintos y no se mezclan**: el
  primero se arregla en Stock Swayp, el segundo en Catálogo de productos.
  Juntarlos manda a la operadora a la pantalla equivocada. En Lima el primero
  nunca dice que no, así que el aviso que se lee es siempre el segundo.
- **Un vínculo que falta rechaza la guía; no cae al código local.** El respaldo
  del código local sigue vivo para lo que sí es una limitación de Swayp —una
  ciudad que su API no atiende—. Un hueco nuestro se arregla en dos minutos y no
  puede despachar una caja mientras tanto.

  Alcance medido antes de ponerlo, sobre 60 días:

  | Puerta | Guías | Sin codbar |
  | --- | --- | --- |
  | Guía directa | 143 | 4 |
  | Reprogramación y reenvío | 418 | 41 |

  Son unas cinco por semana en la puerta de reprogramación, con la asesora al
  teléfono. Se acepta a sabiendas: son exactamente las guías que Swayp no
  reconocería, y el minuto que cuesta vincular el producto se paga una vez.
- **Mapa vacío = función apagada**, el mismo interruptor que ya gobernaba
  `buildProductos`: una tienda que todavía no vinculó nada no se queda sin poder
  crear guías el día del despliegue. Con al menos una entrada, un hueco es un
  hueco.

Si un día Lima pasa a contarse, se la quita del conjunto y sus renglones vuelven
a regirse por la cantidad y por la marca propia de cada uno.

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

### 11.2 Novedades de Swayp

Una **novedad** es el estado 6 de Swayp: el mensajero llegó, no pudo entregar, y
la guía queda detenida esperando una instrucción. No es un intento fallido ya
cerrado —eso se registra aparte—; es una pregunta abierta que alguien tiene que
responder para que el paquete siga moviéndose.

El estado 8, «Devolución», es el mensajero marcando devolución («pendiente por
entregar al origen»). Admite la misma gestión, y es la única puerta para
revertir una devolución que la operación no pidió; mientras no se revierta, el
pedido ya está en recuperación (§9, «Lo que Swayp no entrega, también»). Ambos
estados mapean a `en_ruta` en el modelo de la app —que solo tiene cinco
estados—: el paquete está con el mensajero. El estado crudo de Swayp
(`swayp_state`) es lo único que distingue «esperando instrucción» de «va en
reparto». Hasta el 29-09-2026 mapeaban a `pendiente`; nunca se notó porque el
webhook no los mandaba, pero leídos de la API el Master los habría devuelto a
«Por armar» con el paquete en la calle.

Swayp acepta exactamente tres respuestas:

| Acción | Qué significa | Reversible |
| --- | --- | --- |
| Volver a ofrecer | El mensajero reintenta la entrega sin cambiar la fecha | Sí |
| Devolver al remitente | Se cierra el intento y el paquete vuelve a la bodega | No |
| Reprogramar | El mensajero vuelve en la fecha que se indique | Sí |

Reglas:

- **El comentario es obligatorio en las tres.** Swayp se lo muestra al mensajero:
  es lo único que va a leer antes de decidir qué hacer con el paquete.
- **La fecha solo existe al reprogramar**, y no puede ser hoy: Swayp arma la ruta
  del día siguiente entre las 16:00 y las 17:00 (§9), así que reprogramar «para
  hoy» es pedir algo que ya no entra en ninguna ruta.
- **Resolver una novedad NO es una salida nueva.** No crea guía, no crea QR, no
  consume el máximo global de cinco salidas ni la política de §9.3 de que Swayp
  se use una sola vez por pedido en Lima. Es gestión de la guía que ya existe.
  Devolver al remitente sí abre la devolución física, que en Swayp se recoge cada
  semana o cada quince días (§9.4).
- **El desenlace lo confirma Swayp, no nosotros.** Al resolver una novedad la app
  no toca el estado del envío: lo trae la lectura de su API (abajo) cuando el
  mensajero ejecuta la instrucción —o cuando no la ejecuta—. Adelantarlo sería
  pintar en el Master un final que todavía no ocurrió.
- Queda registrado en `order_events` con el término `novelty_solved`, que guarda
  quién decidió, qué acción, con qué comentario y para qué fecha. Es append-only.

Permisos: resolver una novedad exige `swayp.solve_novelty`, que la vendedora
tiene —es gestión de venta, la misma persona que llamaría a la clienta—.
**Devolver al remitente exige además `closure.return`**, porque cierra la entrega
y dispara la devolución física, que es lo que ese permiso gobierna en el resto
del sistema.

#### El estado de Swayp se lee de su API (29-09-2026)

**Qué pasaba.** El único canal era el webhook, y el webhook de Swayp **solo ha
mandado entregas**: las 43 guías que alguna vez actualizó estaban en 7, y no
llegó ni un Reparto, una Novedad ni una Devolución. Las 147 guías que Kapta
tenía vivas seguían en el estado 1, y el Master enseñaba «En tránsito» a 112
devoluciones y a 14 novedades que nadie veía en Envíos (#KP135009).

**Qué hace ahora.** Cada media hora (`/api/cron/swayp-status`, a los :22 y
:52) Kapta lee cada guía Swayp viva con `GET /v2/guias/{guia}` y toma el
**`estado`** de la respuesta —como indicó la operación—, y lo aplica por la
misma puerta que el webhook (`applySwaypState`, `lib/swayp-ingest.ts`). Reglas:

- **Los estados reales**, confirmados con el historial de las 147 guías: 1
  Generada, 3 Por recolectar, 4 Asignada, 5 Reparto (también «Solucionado», la
  novedad resuelta), 6 Novedad, 7 Entregada, 8 **Devolución**, 9 **Devolución
  confirmada**, 10 Cancelada, 12 **Devolución confirmada con cobro**. El
  catálogo anterior llamaba «Revisión» al 8, «Cancelación» al 9 y «Devolución
  confirmada» al 12. Un `estado` que no conocemos **no toca la guía**: el
  barrido lo cuenta con su texto, igual que Tanders.
- **El estado de entrega solo avanza.** 1–3 son `pendiente`, pero una guía
  directa nace `en_ruta` y no retrocede; 4, 5, 6 y 8 son `en_ruta`; 7
  `entregado`; 9–12 `anulado`. Una guía cerrada no se reabre.
- **La custodia sigue a Swayp:** con el mensajero (`courier`) en 4–6, de vuelta
  (`retorno`) en 8, 9 y 12. Nunca `devuelto`: «Devolución confirmada» es que la
  caja llegó a la bodega de Swayp, y la salida sigue abierta hasta recibirla
  (§9.4). Una novedad resuelta que vuelve a Reparto regresa a `courier`.
- **Las fechas se llenan una vez**, del historial de Swayp si viene: la salida
  (`dispatched_at`, la primera Asignada o Reparto), el reparto
  (`out_for_delivery_at`) y el cierre (`closed_at`).
- Hasta 200 guías por pasada, las nunca leídas primero; se detiene en el primer
  429 o si la credencial falla, y deja una línea `[swayp-status]` con los
  conteos y los motivos de fallo, sin datos de guías ni pedidos.
- En pruebas el endpoint reventaba con 500 en guías en novedad; si pasa en
  producción, el reporte lo cuenta con su motivo y la guía se reintenta en la
  pasada siguiente.
- **La novedad se guarda como etiqueta del courier** (`reported_status`):
  «Swayp · Destinatario ya no desea el producto (16)», con el nombre para
  leerla en Envíos y el id del catálogo público de Swayp para decidir. Cuenta
  la **última** novedad del historial: si primero no contestó y después dijo
  que ya no lo quiere, vale lo segundo. Sin historial —el webhook— no se borra
  la que hay. Las novedades 15 y 16 son rechazo en la puerta (§11.8).
- **La API cierra una devolución como 10 «Cancelada»** (confirmado en la
  primera pasada, 29-09-2026). Su documentación dice que 10 solo sale de 1
  (Generada) y llama «Cancelación» al 9, pero las 15 guías que el tracking
  enseña en 9 «Devolución confirmada» —con Reparto, Novedad y Devolución en su
  historial— llegaron como 10. Kapta las tomó por canceladas antes de salir, y
  siete pedidos sin anular cayeron en «Finalizado · Anulado cerrado». Regla
  (`normalizeSwaypIncoming`): **un 10 sobre una guía que ya salió** (estado
  previo 4–9 o 12, salida registrada o custodia `courier`/`retorno`) **es una
  Devolución confirmada (9)**; sobre una que nunca salió, una cancelación de
  verdad. Como el barrido pasa cada media hora, una devolución se ve en 8 antes
  de cerrarse. Las 15 se corrigieron a 9 con sus fechas del tracking.
- La respuesta tampoco trae el historial como `notas`, así que las fechas de
  salida del atraso quedaron con la hora del barrido. El historial se busca
  también bajo otros nombres probables, y el log del barrido deja la **forma**
  de la respuesta —claves, `estado|idEstado` crudos y dónde vino el historial,
  sin datos de clientes— para fijar la lectura con lo que la API manda de
  verdad.

### 11.3 Quién emite el número de guía al reprogramar

Al reprogramar hacia Swayp desde Reproprovincia, el número de guía **lo emite
Swayp por API**, no la app. Hasta ahora la app inventaba un código local y la
guía había que cargarla después a mano por el Excel de programación; ese código
seguía siendo el que la operadora leía, así que nadie notaba que en el sistema
de Swayp no existía nada.

**Qué ciudades van por API y quién lo decide.** La frontera es una sola:
`SWAYP_SENDERS`, el JSON de bodegas configuradas. Hoy solo tiene Arequipa,
porque es la única bodega con stock cargado del lado de Swayp. Un destino de
otra provincia no encuentra bodega, la API no se llama y el envío sigue por
Excel exactamente como hasta hoy. **Habilitar una ciudad es agregarle una clave
a ese JSON**: no se toca código y no se reentrena a nadie.

**No conseguir número de Swayp no es un error.** Integración apagada, ciudad sin
bodega, dirección incompleta, token vencido o API caída: en todos los casos la
reprogramación se completa con el código local y el aviso dice por qué. Dejar a
la operadora bloqueada porque un courier no responde sería peor que una guía
manual —y la guía manual es el procedimiento que ya conoce—.

**Se pide una sola vez.** La API de Swayp no acepta clave de idempotencia, así
que un POST repetido tras un timeout crearía una segunda guía y un segundo
paquete. Un intento, y si falla, código local.

**El stock se valida ítem por ítem, no por pedido.** La reja que decide si el
envío se sigue trabajando aprueba cuando *cualquier* producto tiene stock; para
mandar un paquete eso no alcanza. En un pedido de dos productos con uno solo en
bodega, Swayp recibiría una guía que su almacén no puede armar. Si falta
cualquier ítem, el envío cae al código local con el motivo —no se bloquea la
reprogramación, que antes de esto no validaba nada—.

**Los TRES caminos que crean una guía Swayp, y cuál pide número.** Reprogramar
un envío pendiente y recuperar uno anulado o devuelto terminan igual —una guía
nueva a una fecha nueva—, así que los dos le piden el número a Swayp. El tercero,
el alta manual, NO: ahí el operador pega un código que ya generó en el panel de
Swayp, y pedir otro crearía un segundo paquete.

| Camino | ¿Pide número a Swayp? |
| --- | --- |
| Reprogramar un envío pendiente | Sí |
| Recuperar una guía anulada o devuelta | Sí |
| Alta manual con código escrito a mano | No — ya existe |

La asimetría no es gratuita y por eso está probada: el camino de guías anuladas
se quedó sin API durante semanas cuando se conectó la primera vez, y nadie lo
notó porque la guía seguía saliendo con código local, que es lo que salía antes.
Una vía que nunca se entera de una regla nueva no parece rota.

**La guía directa RELLENA la salida «por definir» en vez de exigir que la
anulen.** Swayp era el único courier fuera de `writeCourierGuide`: su guardián
de «este pedido ya tiene una guía activa» contaba la salida por definir como
estorbo, y el único camino era anularla — lo que arrastra el pedido a `anulado`
(#KP127639), que es exactamente el rodeo que ese mecanismo vino a cerrar. Ahora
una salida por definir no bloquea: el modal la nombra («la salida KP132394-S01
está por definir: la guía se le escribe encima») y el aviso posterior dice sobre
cuál se escribió. La caja conserva su consecutivo, su rótulo, su QR y su avance
de preparación, porque rellenar decide el courier de un bulto que ya existe, no
rehace el trabajo del almacén.

Lo que **sí** sigue bloqueando es una guía de verdad activa —de Swayp o de
Aliclik—, porque ahí hay dos paquetes en juego y no uno.

**Crear la guía directa no es reprogramar (v1.19, 29-09-2026).** La guía
directa deja una gestión `reroute` **sin estado resultante** para que cuente en
la productividad de quien la creó; Repro Provincia ya contaba como
«reprogramada» solo la que resulta `en_ruta`. El Master, en cambio, leía
cualquier `reroute` como reprogramación (`lib/guide-dates.ts`), así que toda
guía directa nacía con fecha de reprogramación: en Lima caía en «En curso · Por
reprogramar Lima» sin un solo intento fallido (#KP135009, 38 pedidos) y en
provincia en «Gestión Reproprovincia» (32). La gestión con la que nace la guía
directa no es una reprogramación: la guía queda en **En curso · En tránsito**.
Las reprogramaciones de verdad dejan estado —Aliclik `en_ruta`, el reenvío
Swayp `en_ruta` en la hija y `transferido` en la madre— y no cambian.

**Solo en la guía directa (v1.20, 29-09-2026).** La v1.19 ignoraba toda gestión
`reroute` sin estado, y en julio el reenvío por Fenix dejaba esa misma fila,
sin estado, en la guía **madre** («Guía Fenix creada: …», 149 guías): ahí sí
marca la reprogramación. Cinco pedidos de julio (#KP117144) cayeron en
«Preparación · Por armar» hasta que la excepción se limitó a las guías con
`created_via = fenix_directo`.

**El destino lo pone la GUÍA, no el pedido.** Al reprogramar, la salida ya
existe y su destino es mejor dato que el del pedido por tres razones: es el que
el courier usó, es el que la operadora ve en el drawer, y es el que ella puede
haber corregido a mano. Usar el del pedido por encima de una corrección
devolvería el paquete a la dirección mala. El del pedido queda de respaldo, y se
resuelve campo a campo: una guía puede traer el distrito y no el teléfono.

Importa más de lo que parece porque **el pedido a menudo no tiene dirección**:
el `shippingAddress` de Shopify llega vacío en el 6,8% de los envíos de Arequipa
—90 de 1.324—, y en 51 de ellos la dirección sí está en la guía. Buscarla solo
en el pedido convertía «no la tengo acá» en «no hay destino», y la guía salía
con código manual sin decir por qué. Es el mismo error que la cobertura
(§19.0.2): el dato existe, se buscaba donde no estaba.

**Los productos van por CÓDIGO, no por nombre.** Swayp acepta las dos formas y
descarta una ella misma:

| Forma | Qué es |
| --- | --- |
| `productos: [{codbar, cantidad, nombre}]` | **La que usamos.** Estructurada: es con la que Swayp descuenta por código |
| `contenido: "2 x AURE001"` | **También la usamos.** Es obligatoria y es el texto que el mensajero lee. Lleva el CÓDIGO, el formato que pidieron: *«CANTIDAD X SKU … con el match exacto del sku»* |
| `contenido: "2 x NOMBRE EXACTO"` | Texto con el nombre. *«Tiende a ser inestable porque se busca por nombre y no por código»* — Swayp. Es el respaldo para una tienda sin nada vinculado |

Se mandan **las dos**, no una en vez de la otra: `contenido` es obligatorio y es
lo que se imprime; `productos[]` es lo que descuenta el inventario.

`productos[]` estuvo sin mandarse un tiempo y conviene saber por qué, porque el
razonamiento sigue valiendo para el próximo campo no documentado: no figura en
su documentación, y al preguntar por el catálogo su desarrollador respondió que
«esa funcionalidad no está disponible para consumir por API» —una frase sobre el
endpoint de LECTURA que dejaba la duda abierta sobre este campo—. Mandar algo
que quizá no procesan podía devolver 400 y dejar al envío sin guía, así que se
esperó. El **14-09-2026** mandaron un `curl` de ejemplo, suyo, que lo incluye:
`"productos": [ { "codbar": "ABC123", "cantidad": 1, "nombre": "…" } ]`. Con eso
dejó de ser una apuesta.

Vamos por `codbar`. Buscar por nombre ata el descuento de stock a que su
catálogo y el nuestro escriban igual un producto: cambian una tilde y las guías
dejan de descontar **sin error y sin aviso**, hasta que el inventario no cuadre.
**`contenido` lleva el código y NADA más.** Ni el nombre, ni un paréntesis: no
conocemos la gramática de su buscador, y si le sobra texto hay dos desenlaces
—lo tolera, o no encuentra el producto y no descuenta stock—. No hay un tercero
donde falle ruidosamente.

**El nombre legible va en `observaciones`**, que nadie parsea, con la misma
información: `contenido: "2 x AURE001"` y `observaciones: "2 x CANDIDA CLEANSE"`.
Lo parseable en el campo parseable, lo humano en el campo libre. Se usa el nombre
de Swayp que guarda el mapeo —corto y el que su almacén reconoce— y solo se cae a
nuestro título de Shopify si no hay otro; por eso vale la pena rellenar el campo
«Nombre en Swayp» de la pantalla de Catálogo. La nota del operador se conserva a
continuación, y el conjunto se recorta a 500 caracteres: no sabemos el límite del
campo, y perder una guía por un texto de cortesía sería mal negocio.

**Los dos catálogos no tienen relación** y el puente es una decisión humana, no
una regla: el mismo producto es `765545233` en Shopify y `AURE001` en Swayp. El
mapeo vive en `swayp_sku_map` y se edita en **Catálogo de productos**, junto al
de Aliclik — la unidad de trabajo es el producto, no el courier.

**El vínculo es de la ORGANIZACIÓN, no de la tienda.** Se guarda por tienda
porque el catálogo se gestiona desde una, pero se lee juntando todas las de la
organización: el codbar es un hecho del producto en Swayp, y Aurela y Kenku Perú
despachan de la misma bodega. Vincular en una vale para las dos, y desvincular
borra en las dos — si no, quitar el vínculo lo dejaría vivo por la hermana y la
pantalla mentiría. Cuando las dos tienen el mismo SKU en codbar distintos manda
el de la tienda desde la que se opera, y si no, el más reciente; la guía no se
detiene por eso, pero la discrepancia es un error de captura que hay que
corregir. Acotarlo a la tienda costó 18 de 19 productos invisibles para Aurela,
con sus pedidos rechazados por «Falta vincular» teniendo el codbar escrito
(15-09-2026). El importador de inventario ya leía así.

**El mapa es el interruptor.** Una tienda sin ninguna vinculación crea guías
como hasta hoy, sin `productos`: nadie deja de despachar el día del despliegue.
Con al menos una vinculación la función está en marcha, y entonces **un producto
sin vincular RECHAZA la guía** nombrándolo, y el envío cae al Excel. Nunca se
manda el ítem con el código vacío ni se aproxima por nombre: eso dejaría unas
guías descontando stock y otras no, sin que se note — la misma razón por la que
un ubigeo aproximado se rechaza (§11.3).

**La bodega de origen: la nombra `ciudadRemitente`, y `idWarehouse` la confirma.**
Swayp opera cinco bodegas —Arequipa, Trujillo, Juliaca-Puno, Piura y Lima— y el
origen viaja como el **ubigeo** en `ciudadRemitente`. El `curl` de ejemplo que
mandaron el 14-09-2026 no lleva `idWarehouse` en absoluto, y las guías de
Arequipa salen sin él: **no es obligatorio para habilitar una ciudad**. El campo
existe para no dejarle la elección a Swayp cuando el ubigeo no alcance; va junto
al remitente de esa ciudad en `SWAYP_SENDERS`, porque el remitente ya ES la
bodega y separarlos dejaría dos sitios que pueden discrepar.

**El RUC del remitente puede ir vacío.** El mismo `curl` lleva
`"nitRemitente": ""`. Exigirlo era una regla nuestra, y era cara: `parseSenders`
valida ciudad por ciudad y descarta **en silencio** la que no pase, así que una
bodega escrita sin RUC quedaba fuera y el aviso decía «No hay bodega Swayp
configurada para …» sin insinuar cuál era el campo. Una ciudad perdida por una
regla inventada es peor que un RUC vacío que a Swayp no le molesta.

**El `idBusiness` deja de ser opcional en la práctica.** Swayp valida los
productos contra un id único de tienda, así que sin ese campo es Swayp quien
decide a qué comercio atribuye la guía; si se equivoca, descuenta del stock de
otro y no nos enteramos.

**El número que emite Swayp se guarda en `swayp_guide`, no solo en
`guide_code`.** El webhook de Swayp busca la guía por esa columna: sin ella el
envío se quedaría En ruta para siempre por más que el mensajero reportara.

### 11.4 Una sola puerta a «entregado»

La llamada de gestión desde Envíos **no cierra guías como entregadas**. Una
guía se marca entregada solo por quien la entregó: para Swayp/Fenix, el
resultado del courier («Registrar resultado del courier», con «Entregado —
cerrar la guía»); para Aliclik, la API o el Excel. Hasta el 12-09-2026 el
formulario de llamada ofrecía además «Entregado (Fenix)»: dos puertas al mismo
estado terminal, y la segunda podía cerrar una guía que el courier no había
cerrado, incluso una que nunca salió del almacén. Se quitó del formulario, del
tipo `RerouteDisposition` y el servidor la rechaza si llega de una pestaña con
el código viejo. Los resultados de llamada son cuatro: **Cliente confirma
reprogramación**, **Programar próxima llamada**, **No contesta** y **Cliente
cancela / anula**.

**En una guía que Swayp informa por API, el resultado no se pide a mano
(08-10-2026).** «Registrar resultado del courier» nació en julio, cuando Fénix
no le decía nada a Kapta y alguien escribía lo que reportaba el motorizado.
Desde el 29-09-2026 el barrido lee cada media hora cada guía con número de
Swayp (§11.2), así que la entrega, la cancelación, la devolución y la novedad
llegan solas. En #KP135202 el recuadro pedía como **«Obligatorio»** un resultado
que Swayp ya había dado —Devolución (8)— y ni siquiera ofrecía esa opción, así
que parecía que faltaba el estado.

- Con número emitido por Swayp (`swaypInformsByApi`), **desde que nace la guía**,
  el cajón muestra **«Lo que informó Swayp»**. Primero se exigía una lectura del
  barrido, y la guía nueva de #KP135202 —creada a las 10:25— recibió a las 10:52
  un «No contesta» a mano en el recuadro viejo, que borró la fecha del reenvío.
  El barrido lee toda guía viva con número de Swayp, así que el número basta.
  El cajón muestra: el estado con su nombre y número,
  la última novedad, la hora de la lectura y qué toca. Con novedad, resolverla.
  En devolución, «Reenviar por Swayp» en provincia (§11.8) o resolver la
  novedad para que vuelva a reparto.
- **«Corregir a mano»** abre el recuadro de siempre, sin «Obligatorio», para
  cuando Swayp esté atrasado o se equivoque, y **sin «No contesta»**
  (`SWAYP_API_MANUAL_EXCLUDED`). Ese «No contesta» pasaba la guía a Pendiente,
  pero mientras Swayp siga diciendo reparto o novedad la siguiente lectura la
  devolvía a En ruta (`en_ruta` gana a `pendiente`): la gestión se perdía sola
  en media hora. El servidor lo rechaza igual. Con la clienta al teléfono, lo
  que toca es resolver la novedad en Swayp.
- La llamada de gestión sigue oculta mientras la guía esté En ruta, como antes.
- Las guías manuales, sin número de Swayp, siguen igual.
- En la lista, la chapa de una Swayp viva dice **«En ruta · en devolución»** o
  **«En ruta · con novedad»** (`swaypLiveSubState`): las tres situaciones se
  guardan `en_ruta`.

Dos reglas más del mismo cajón, por la misma razón (no preguntar lo que ya
está decidido): si «Ruta sugerida» deja una sola ruta posible, la llamada no
pide elegir entre Aliclik y Swayp, lo dice; y el formulario manual de guía
Swayp, con fecha propia, queda plegado salvo cuando el envío no tiene número
de pedido, único caso en que es el camino obligado.

### 11.5 Lo que cierra una venta se confirma, y se avisa antes

Tres salidas del cajón de Envíos terminan una venta. Las tres piden la misma
ceremonia, porque el coste de equivocarse es el mismo:

- **Cliente cancela / anula** pide un segundo clic que nombra la guía y el
  pedido («Sí, anular la guía AUR5X… del pedido #KP…»), con Cancelar al lado.
  Antes se registraba con el mismo botón «Registrar llamada» que un «No
  contesta».
- **El último intento.** Con los {MAX_INTENTOS} intentos agotados, registrar un
  «No contesta» más **anula la guía** (`nextShipmentTransition`). El cajón lo
  dice antes, en ámbar, y el botón pasa a «Registrar y anular la guía»: la
  guía se cerraba en silencio mientras la pantalla solo mostraba «Llamadas
  7 / 7».
- **Descartar la recuperación** ya lo hacía (§11 y `lib/recovery-discard.ts`):
  motivo de 8 caracteres como mínimo, visible junto al campo, y segundo clic
  que nombra el pedido.

Y lo que **no** es terminal pero se perdía igual: al cerrar el cajón o saltar a
otra guía con una nota a medio escribir, el texto se descartaba sin preguntar.
Ahora se avisa y se puede volver. En una cola de llamadas, ese texto es lo que
la asesora acaba de oír por teléfono.

### 11.6 Una reprogramación confirmada no puede ser de ayer

La regla es de la **fecha que se estampa en una guía Swayp**, no de un
formulario: toda fecha que llegue a `rescheduleGuideCode` tiene que ser futura.

Hay **dos puertas** que acuñan una guía con esa función, y las dos se validan en
los dos lados:

1. **Cliente confirma reprogramación**, el camino normal.
2. **Guía Swayp a mano**, el formulario manual del cajón — el que se despliega
   solo cuando el envío no tiene N° de pedido, o sea el camino obligado cuando
   la autogeneración no es posible.

En los dos casos:

- En el formulario, el `min` del campo y la fecha dentro de la condición del
  botón, con el motivo escrito **al lado** del botón y no dentro de su etiqueta
  (un `<button disabled>` está fuera del orden de tabulación: quien navega con
  lector de pantalla no lo alcanza).
- En el servidor, `isFutureShipmentFollowup`, porque el `min` de un
  `<input type="date">` es una sugerencia del navegador: la fecha se puede
  teclear.

Hasta el 12-09-2026 ninguno de los dos lados lo exigía para «confirma» —solo que
la fecha existiera— y se emitía una guía Swayp con la fecha pasada **estampada en
su número** y un despacho agendado para un día que ya había pasado. El 14-09-2026
se descubrió que el arreglo había cubierto una puerta de dos: la manual seguía
sin `min`, sin la fecha en el `disabled` y sin guarda en `createFenixGuide`. La
lección se escribe acá porque es la que se repite: **la regla pertenece a la
función que acuña, no a la pantalla desde la que se llegó**, y se valida en cada
sitio que la llame.

La **fecha de entrega informada por el courier** («Reprogramado por Swayp») sigue
otra regla, porque es otro hecho: **hoy sí vale** —el motorizado puede
reprogramar para más tarde el mismo día—, ayer no (`isTodayOrLaterDelivery`).

Y los topes de intentos se leen de una constante, no de un texto: la métrica del
cajón, la columna de la cola y los mensajes del servidor muestran `MAX_INTENTOS`
(7 llamadas) y `ALICLIK_MAX_INTENTOS` (3 intentos de Aliclik), las mismas que
aplican la transición y la ventana de reprogramación. El mínimo del motivo de
descarte sale igual de `DISCARD_REASON_MIN`.

### 11.7 El motivo anterior se ve antes de llamar, y su ausencia también

§11 manda revisar cómo terminó el intento anterior antes de reenviar: «si el
cliente vio el producto y aun así lo rechazó, normalmente no reenviar». Esa
etiqueta es `reported_status`, y hasta el 14-09-2026 **no se pintaba en ninguna
pantalla**: estaba en la fila, tipada y usada por la elegibilidad de
recuperación, y la asesora llamaba a ciegas. Ahora sale en la cola y en la ficha
del cliente del cajón —la que se lee mientras suena el teléfono—, con la lectura
en castellano (`motivoDelCourier`).

Cuando el rechazo consta, la frase va **destacada**: es la que cambia la
decisión.

Donde no hay motivo **no va un guion**. Un guion se lee «no hay nada que decir»,
y lo que pasa es otra cosa: de 130 devoluciones candidatas medidas el 2026-08-10,
100 no traían motivo alguno. Va escrito «sin motivo del courier · no consta si la
rechazó en la puerta», porque ausencia de motivo no equivale a recuperable.

### 11.8 Recuperación por agente de voz

Estado: **construido, apagado por tienda (Fase 2).** Existen la bitácora
(`voice_calls`, 0190), las dos tools del agente, la llamada de prueba, el
barrido (`/api/cron/voice-recovery`), el panel del drawer y los ajustes de la
tienda. Faltan la transcripción al cerrar la llamada, la etiqueta «Acepta
reenvío · crear salida Swayp» en la cola y el renglón del resumen diario. El plan técnico vive en
`docs/voz-reproprovincia-plan.md`. Esta sección define las reglas; el plan
define cómo se construyen. Ninguna de las dos autoriza a llamar a un cliente
hasta que el piloto de abajo se encienda por tienda.

#### Qué es

Un **agente de voz** —un modelo conversacional que habla por teléfono, hoy la
Voice Agent API de Grok sobre telefonía Zadarma, ambos reemplazables— llama a
los pedidos en **gestión Reproprovincia activa** y les propone el reenvío desde
la bodega Swayp de su ciudad. Es **un operador más**: lee la misma ficha, escribe
los mismos hechos por la misma puerta que una asesora y no tiene ningún estado,
subetapa ni motivo propio. Lo único nuevo que existe por él es su bitácora
(`voice_calls`), que es un registro de llamadas, no un estado del pedido.

#### Por qué empieza aquí y no en Por confirmar

- **Nadie está llamando.** El ciclo de recuperación (§11) se midió con 920
  pedidos en 60 días y **cero llamadas registradas**; 570 en ciudad con bodega
  Swayp y 254 de la última semana todavía de camino de vuelta. El agente no
  reemplaza a nadie ni le quita cola a nadie: la línea base es cero y todo lo
  que recupere es incremental.
- **Fallar cuesta poco.** En Por confirmar un falso «confirmó» quema flete de
  Aliclik. Aquí el pedido ya se dio por perdido: una llamada mala lo deja donde
  estaba.
- **No toca la WABA.** La plantilla de recuperación (§11.1) pide dinero por
  adelantado y un reporte de spam le cuesta la plantilla a toda la tienda. Una
  llamada no pasa por Meta.
- **Consigue el dato que falta.** 100 de 130 devoluciones no traen motivo del
  courier (§11.7). El agente lo pregunta y lo deja escrito, y no pide plata para
  averiguarlo.

Por confirmar y Agencia con adelanto quedan **fuera** de esta versión: uno tiene
equipo humano y coste de error alto; el otro exige negociar dinero, y eso no se
delega (§2, principio 11, y §8).

#### Quién entra a la cola del agente

Todas las condiciones a la vez. La primera es la misma función que ya decide la
recuperación; las demás recortan sobre ella. **Ninguna se calcula aparte**: si
una condición existe en otra pantalla, se lee de la misma función.

1. `recoveryOutcome` da **`activa`** (`lib/reproprovincia.ts`). Eso ya cubre
   guía Aliclik fallida tras salir, sin guía viva, sin entrega previa, sin
   descarte, dentro de la ventana y sin anulación en Shopify.
2. La guía se cerró hace **`voice_recovery_max_age_days` días o menos** (7 por
   defecto), contados desde el **mismo ancla** que la ventana de recuperación
   (`closed_at`, o la última transición terminal cuando falta). Es la parte
   caliente de la cola: el paquete está cerca de la clienta.
3. **Hay stock Swayp del producto en la ciudad del pedido**, leído del conteo
   de Swayp (§11, «De dónde sale el stock»). Sin stock el agente no tiene nada
   que ofrecer: la única propuesta del guion es el reenvío local contra
   entrega. Agencia con adelanto no es una oferta del agente. **Y la ciudad
   tiene bodega Swayp configurada** (remitente en `SWAYP_SENDERS`, la misma
   prueba `esCiudadPorApiSwayp` que usa Envíos): con stock pero sin remitente
   la clienta aceptaba y la salida fallaba después («No hay bodega Swayp
   configurada para ica», KP133059, 03-10-2026). Motivo propio,
   `sin_bodega_swayp`, para que se vea qué ciudad falta configurar.
4. El motivo del courier **no es rechazo en puerta** (`REFUSED` y equivalentes
   leídos por `motivoDelCourier`). **Sin motivo entra**: §11.7 dice que la
   ausencia no equivale a recuperable, y la llamada es justamente el medio que
   lo averigua sin pedir dinero. **Swayp también rechaza en la puerta
   (29-09-2026):** su novedad 16 «Destinatario ya no desea el producto» y la 15
   «no ha comprado ningún producto» cuentan igual que el `REFUSED` de Aliclik
   (`guideDoorRejection`, `lib/reproprovincia.ts`). Desde que el fallo de Swayp
   abre la recuperación (§9, v1.22), el agente habría llamado en provincia a
   clientas que se lo dijeron al mensajero. La 12 «Pedido diferente al
   solicitado» no: ahí el error es nuestro.
5. **Teléfono peruano válido.** Los leads identificados solo por BSUID (§8.1)
   quedan fuera: no se pueden llamar.
6. **Menos de dos antecedentes** (§8). Con dos o más, la conversación exige
   adelanto, y el adelanto lo negocia una persona.
7. **Sin gestión de hoy** de nadie —persona o agente— y **sin fecha pactada
   futura**. Si `confirmation_next_contact_on` existe, manda la fecha (§6.1):
   el agente respeta el compromiso que alguien tomó con la clienta.
8. **Con cupo de gestión**: menos de siete días distintos con gestión (§6.1).
   El agente hereda el tope de todos; un pedido sin cupo no se llama y se cuenta
   (ver pendientes).
9. El teléfono **no pidió que no lo llamen** (`no_llamar`, abajo) en esa
   tienda.

Orden de la cola: **fecha pactada por el propio agente → guía cerrada más
reciente primero**. Lo mismo que §6.1 con la antigüedad invertida: aquí lo
nuevo es lo caliente.

#### Interruptores y topes por tienda

Dos interruptores, como la plantilla de recuperación (§11.1) y por la misma
razón: el primer lote de cada tienda se mira antes de soltarlo.

- `voice_recovery_enabled`: la cola del agente existe y se ve; desde el drawer
  se puede lanzar **«Llamar con el agente»** a un pedido concreto.
- `voice_recovery_auto`: el barrido llama solo. Apagarlo es la marcha atrás.
- `voice_recovery_daily_cap` (30 por defecto): llamadas salientes por tienda y
  día de Lima. Se cuenta sobre `voice_calls`, no sobre un contador.
- **Una llamada del agente por pedido y día**, y **`voice_recovery_max_attempts`**
  (2 por defecto) llamadas del agente por pedido en total. Agotadas, el pedido
  sigue en la cola de Reproprovincia para una persona, marcado «el agente ya
  llamó N veces».
- Horario `voice_recovery_hour_start`–`voice_recovery_hour_end` (09–20 de Lima
  por defecto), más estrecho que el laboral de §6.1 a propósito: una llamada
  automática a las 21:45 se recibe distinto que la de una asesora. El
  owner lo puede extender por tienda: Kenku llama hasta las 22:00 desde el
  04-10-2026 (ver «Piloto y medida»). **Los
  domingos llama desde las 11:00** (`VOICE_SUNDAY_START_HOUR`, o desde el
  inicio de la tienda si es más tarde), el barrido y el botón por igual.
  Decisión del owner, 26-09-2026; antes el domingo no llamaba. Lo que sigue
  sin cambiar es la entrega: el agente nunca ofrece un domingo.
- Lo mueve **owner o admin de la organización de esa tienda**, igual que el
  ciclo de recontacto (§6.1): reparte llamadas y reputación de toda la tienda.
- **La clienta siempre ve un número peruano.** Kapta no pide una llamada sin
  la extensión de Zadarma cuyo caller ID es peruano
  (`voice_recovery_zadarma_sip`). Sin ella la cuenta llama con su número por
  defecto, que es de EE. UU. (+1 202 773 4798, medido el 22-09-2026): una
  clienta de provincia no contesta ese número, y la cuenta la comparte otra
  operación que llama a Costa Rica, así que el número se fija por extensión y
  no en la cuenta.
- **El agente entra por un escenario de la centralita, sin salir a la red
  telefónica** (decisión del owner, 24-09-2026). El callback de Zadarma marca
  primero `from` y luego `to`, y a quien contesta primero le reproduce «Por
  favor, espere a que se realice la conexión». `from` es un escenario de un
  menú de la centralita **sin números asignados** (`voice_recovery_agent_number`
  = «menú-tecla», hoy `1-11`) que llama a la extensión desviada al SIP de xAI;
  `to` es la clienta. Así la locución la oye el agente, la clienta contesta y
  oye al agente sin locución ni tono, y el audio no da la vuelta por la red.
  Se probaron y descartaron el 23-09-2026: el número del agente como `from`
  (audio comprimido por la vuelta a la red) y como `to` con la clienta
  primero (la clienta oía la locución y un tono antes del agente: «malísimo»,
  en palabras del owner). El costo aceptado: el agente conecta antes que la
  clienta, así que xAI cobra los segundos de timbre y las no contestadas
  hasta el corte por silencio de la consola.
- **Una llamada abierta por número de agente.** El agente no recibe el
  teléfono de la clienta —el callback le llega con el caller ID de la cuenta—,
  así que sabe de qué pedido habla porque es la única llamada abierta de su
  número (índice único en `voice_calls`). Con 20 a 30 llamadas al día cabe de
  sobra; para más, otro número de agente.
- **Quien devuelve la llamada no recibe la ficha ajena.** El agente manda a
  `identificar_llamada` el número de quien habla. Si es un celular peruano y
  no es el de ninguna llamada abierta, es otra persona marcando al número del
  agente —típicamente una clienta que devuelve una perdida mientras el agente
  llama a otra—: no se le entrega la ficha ni puede registrar sobre ese
  pedido, y el agente la deriva a WhatsApp. El 24-09-2026, en pruebas, una
  llamada entrante recibió la ficha de la llamada abierta y registró un
  «confirma»; en modo prueba no escribió nada. Un número que no es celular
  (el de la cuenta o el del propio agente) no decide y se usa la única
  llamada abierta.
- **Llamadas caducadas.** Una llamada que en tres minutos no pasó a «en
  curso» (el agente pide la ficha al oír a una persona) es una clienta que
  **no contestó**: el agente no pudo registrarlo, así que el barrido la cierra y, en modo real,
  escribe el mismo `sin_respuesta` que habría escrito el agente, con día de
  gestión (`staleCallResolution`). Incluye, sin poder distinguirlos, los
  pocos casos en que contestó pero el tramo del agente no conectó. Una
  llamada que llegó al agente y en cinco minutos no registró también se
  cierra como **no contestó** y, en modo real, se escribe igual (decisión
  del owner, 25-09-2026). El margen eran diez minutos; el owner lo bajó a
  cinco el mismo día porque una llamada colgada ocupa la línea del agente y
  una conversación real dura menos de tres. En las pruebas fueron buzones que el
  agente tomó por persona o clientas que colgaron antes de decidir. Si no se
  escribiera, el pedido quedaría sin rastro y volvería a la cola el mismo
  día. Solo una llamada que ni se llegó a marcar queda `sin_resultado`.
- **Modo prueba.** Una llamada en `mode = 'test'` usa la ficha de un pedido
  real, llama al teléfono de quien prueba y **no escribe nada sobre el
  pedido**: solo su fila. No cuenta para topes ni métricas.

#### El guion: qué dice y qué no

El guion completo es del plan técnico; aquí van las reglas que no cambian con
el redactado.

- Se presenta **con su nombre y el de la tienda**, sin anunciar que es un
  asistente virtual (decisión del owner, 23-09-2026: el anuncio alargaba el
  saludo sin cambiar la conversación). **Si le preguntan si es una persona,
  dice que es un asistente de IA. Nunca lo niega.**
- **El aviso de grabación no va en el saludo** (misma decisión). Queda
  pendiente confirmar con quien asesore en protección de datos si la
  grabación puede seguir sin aviso o si hay que apagarla; ver pendientes.
- Nombra el pedido **por su producto**, nunca por el código de guía (§11.1,
  `recoveryOrderName`): la clienta no ha visto ese código nunca.
- **Va directo a reprogramar.** El saludo dice que el courier no pudo
  entregar y propone la entrega **mañana** (el primer día hábil si mañana es
  domingo), contra entrega y sin costo adicional, y pregunta si le viene
  bien. No pregunta primero qué pasó en el intento anterior (decisión del
  owner, 23-09-2026). La consecuencia es aceptada: el motivo solo se
  pregunta si la clienta dice que ya no lo quiere, así que la llamada captura
  menos motivos de los que §11.7 echa en falta.
- Si mañana no le viene bien, **negocia otra fecha futura**. Acordada,
  reconfirma **en una sola frase** producto, cantidad, monto a pagar,
  dirección y distrito. La referencia no se lee; se anota solo si la clienta
  la corrige.
- **Nunca** pide dinero, datos de tarjeta ni Yape; **nunca** promete hora; no
  ofrece descuentos ni cambia producto ni precio; no habla de otros pedidos del
  mismo teléfono. Cualquiera de esas peticiones se **anota y se deriva**: el
  pedido queda en la cola con la nota arriba para que una persona retome.
- Si contesta otra persona, deja un mensaje breve y corta. Si sale buzón, corta
  sin dejar audio largo.
- **Dura lo menos posible: el costo es por segundo conectado.** xAI cobra el
  agente de voz por duración, no por tokens: medido en su consola del 16 al
  22-09-2026, 177 segundos costaron US$ 0,24, unos **US$ 0,08 por minuto**. El
  largo del prompt no cambia el costo; lo cambian los segundos conectados,
  incluidos silencios, buzones y la espera de la primera tool. El guion apunta a cuatro
  turnos —saludo con propuesta, respuesta, reconfirmación y cierre en una
  sola frase, despedida— y un tope de dos minutos; pasado el tope, se despide
  y registra lo que haya. La cifra que decide si compensa es el costo por
  pedido entregado de la tabla del piloto, no el costo por llamada.
- Si la clienta pide que **no la llamen más**, el agente lo registra
  (`no_llamar`) y se despide. Ese teléfono no vuelve a entrar a la cola del
  agente en esa tienda; una persona puede seguir llamándolo si lo decide.

#### Lo que escribe, y por dónde

El agente escribe **por `register_confirmation_attempt_v2`** (0190) con canal
`llamada` y `source = 'agente_voz'`, con `operation_id` igual al identificador
de la llamada. Es la misma transacción atómica e idempotente de §6.1 —la v2 es
una copia de la v1 con `p_source` y `p_payload_extra`—: un reintento del
agente devuelve el resultado existente y no gasta un segundo día. La v1 no se
toca, así que ninguna pantalla cambia.

El agente registra con cuatro `disposition`, que se traducen a los resultados
de §6.1 (`lib/voice-recovery.ts`, `translateGestion`):

| `disposition` | Resultado de §6.1 |
| --- | --- |
| `confirma` con fecha futura | `confirmado`, con fecha, rango y dirección en el payload, y **crea la salida Swayp** (ver abajo) |
| `confirma` sin fecha futura | `se_deja_mensaje` con la nota «revisar»: sin fecha no hay reprogramación (§11.6) |
| `programar` con fecha | `volver_a_contactar` |
| `programar` sin fecha | `se_deja_mensaje` |
| `no_contesta` | `sin_respuesta` |
| `cancela` | propuesta de descarte, o descarte si la tienda lo delega (abajo) |

| Lo que pasó en la llamada | Hecho sobre el pedido | Día de gestión |
| --- | --- | --- |
| No contesta, buzón, ocupado (lo registra el agente, o el barrido si no llegó al agente) | `confirmation_contact` · `sin_respuesta` | sí |
| Contestó otra persona, se dejó recado | `confirmation_contact` · `se_deja_mensaje` | sí |
| Pide que llamen otro día | `confirmation_contact` + `confirmation_followup` · `volver_a_contactar` con fecha | sí |
| **Acepta el reenvío** | `confirmed` con la dirección leída, referencia y rango de día en `payload` | sí |
| No quiere el producto | ver «Descartar», abajo | según el interruptor |
| Pide no ser llamada | `no_llamar` solo en `voice_calls`; además el resultado que corresponda a lo hablado | según ese resultado |
| Pide algo que el agente no puede dar (precio, cambio, pago, hora) | el resultado que corresponda + nota «deriva a persona» | sí |
| Se cortó, error técnico, no se entendió | **nada sobre el pedido**; solo `voice_calls` | **no** |

Reglas de esa tabla:

- **El agente gasta días de gestión como cualquiera.** Un «no contesta» suyo
  cuenta un día del §6.1 igual que el de una asesora. Contarlo distinto haría
  que el número de días dijera cosas distintas según quién llamó, y el tope de
  intentos del agente (arriba) es lo que evita que se coma el cupo entero.
- **Una llamada sin resultado no es gestión.** No escribe nada sobre el pedido
  y no gasta día. El pedido se queda en la cola, que es donde vive el trabajo
  pendiente (§6.1), con la transcripción a un clic para quien retome.
- **`confirmed` en Reproprovincia no mueve la macroetapa.** El pedido sigue en
  **En curso · En gestión Reproprovincia** hasta que exista la salida Swayp:
  el hecho que cierra la recuperación es la guía nueva, no la palabra de la
  clienta (§11, «Sale por cuatro puertas»). El resolver lo ignora ahí y una
  prueba lo fija.
- **Aceptar crea la salida Swayp** (decisión del owner, 25-09-2026; antes el
  agente solo dejaba el pedido marcado para que almacén la creara). Tras un
  `confirma` con fecha futura, Kapta crea la salida por **el mismo camino que
  «Reenviar por Swayp» de Envíos** (`reenviarGuiaAnulada`), con las mismas
  rejas y sin atajos:
  - cobertura y stock de hoy;
  - stock ítem por ítem;
  - vínculo de codbar (§11, «El vínculo se comprueba ANTES»);
  - número emitido por Swayp.

  La guía anulada queda como madre `transferido` y nace la hija Swayp En ruta
  con la fecha que aceptó la clienta. El actor es nulo y la nota dice «Agente
  de voz».
- **La madre también puede ser una guía Swayp en devolución (08-10-2026,
  decisión del owner).** #KP135202 (Arequipa): Swayp no entregó la guía
  50000137273 y la marcó en **Devolución (8)**. Eso abre la recuperación (§9,
  v1.22) y el agente llamó: el 05/10 la clienta aceptó el reenvío para el 07/10,
  pero no salió nada («el pedido no tiene una guía anulada sin reemplazo»). La
  guía en devolución sigue `en_ruta` mientras el paquete vuelve a la bodega de
  Swayp y nadie la anula, porque una devolución en curso no se cancela. Así que
  el reenvío no tenía por dónde salir, ni por el agente ni por el botón.
  Ahora la madre del reenvío (`origenReenvioSwayp`, `lib/swayp-reenvio.ts`) es:
  - la guía **anulada** sin reemplazo, como antes (la Aliclik que no entregó, o
    la Swayp con la devolución confirmada, que se guarda `anulado`);
  - o, si no hay, la guía **Swayp en devolución** sin reemplazo, **solo en
    provincia**. La modalidad es la del Master (`macro_operation`). En Lima
    Swayp va una sola vez por pedido (§9.3) y el reintento es de Grupo GF; sin
    modalidad no se adivina.

  Justo antes de emitir, Kapta **le pregunta a Swayp** por esa guía
  (`confirmarDevolucionSwayp`). Si la vendedora revirtió la devolución desde la
  novedad y la guía volvió a reparto, no se emite: sería un segundo paquete para
  la misma clienta. Si Swayp no responde, tampoco. La guía en devolución queda
  como madre `transferido`, igual que la anulada, y nace la hija con la fecha
  pedida.

  Los tres caminos usan la misma regla:
  - el agente de voz, para la salida y para dejar su gestión en la guía;
  - el botón **«Reenviar por Swayp»** de la ficha de esa guía en Envíos, que
    ahora aparece también sobre la guía en devolución;
  - la Mesa de ruta del pedido, que en provincia ya no dice «no se crea otra con
    Swayp» y manda a ese botón. Se pide **después de responder** a la tool, con la clienta todavía
  en línea, y **una sola vez por llamada**. La fila se reclama antes de llamar
  a Swayp porque su API no deshace una guía: un segundo POST sería un segundo
  paquete. El barrido del cron (cada cinco minutos, a cualquier hora) recoge
  los «confirma» reales de los últimos tres días que **todavía no intentaron**
  su salida (`salidasSwaypPendientes`): una llamada cuyo `after()` murió, o las
  aceptadas antes de este cambio (KP135055 y KP134986, 25-09). Una llamada que
  ya lo intentó, con éxito o no, no vuelve: el reintento lo decide una persona.
- **No crea la salida** si la dirección que dijo la clienta no es la del
  pedido (`mismaDireccion`: se compara sin tildes, signos ni espacios y con
  los números dichos en cifras). Ante la duda, no es la misma: una salida a la
  dirección equivocada es un paquete perdido, y una salida no creada la crea
  después una persona. Tampoco la crea si falla cualquier reja. En los dos
  casos el motivo queda en `voice_calls.outcome_payload.salida_swayp` y en el
  log, y el pedido sigue en **En gestión Reproprovincia** con su `confirmed`:
  lo termina una persona con «Reenviar por Swayp».
- Pendiente: la etiqueta «Acepta reenvío · salida no creada» en la cola y el
  renglón **«aceptado sin salida»** del resumen diario del owner (§17.1), para
  los aceptados cuya salida falló.
- Cada gestión del agente, y el «no contesta» que escribe el barrido, se anota
  además como llamada (`shipment_calls`, actor nulo, nota «Agente de voz · …»)
  en la guía anulada que muestra Envíos. Una fecha pactada va también a
  `next_followup_at` de esa guía, como en «programar» a mano. El intento vive
  en el pedido, pero «Historial desde el origen» se arma con la guía, y la
  operadora veía «Sin gestiones registradas» en un pedido que el agente ya
  había llamado (26-09-2026).
- En **«Hoy por asesora»** (Envíos) esas filas cuentan como una asesora más,
  **«Agente Daaph»** con la marca IA, siempre al final de la tabla y dentro
  del total del equipo. Se reconocen por el actor nulo y una nota que dice
  «Agente de voz»: sus llamadas la empiezan así, y las dos filas `reroute` de
  la salida Swayp que crea la llevan en el motivo. Cada llamada suya es una
  gestión; su salida suma una reprogramada. Otra fila sin actor no se atribuye
  a nadie (28-09-2026). **Un `reroute` sin actor ya no basta** (04-10-2026): el
  «Reintento automático Aliclik → Swayp» también lo escribe, y el 03-10 le dio
  al Agente Daaph 21 gestiones y 6 reprogramadas con 10 llamadas y ningún
  «confirma».
- **Agente Daaph contra Agente Telnyx** (03-10-2026). Es el mismo agente de
  xAI con el mismo guion y la misma voz. Cambia solo la línea: Daaph llama por
  Zadarma (callback) y Telnyx por Telnyx Call Control. Así se mide qué línea
  conecta mejor.
  - **Cómo llama Telnyx.** Kapta escribe la fila (`telephony = 'telnyx'`) y
    marca a la clienta con detección de contestadora. Cuando contesta, abre
    un segundo tramo hacia la puerta SIP de xAI del número de Telnyx y lo une
    al de ella (`bridge_on_answer`). No usa SIP REFER, que Telnyx cobra por
    llamada.
  - **Ocupado, rechazo o sin respuesta.** Se registra «no contesta» al
    momento, con la causa. No se espera al barrido.
  - **Corte sin gestión (04-10-2026).** Si se corta una llamada que ya
    llegó al agente y él no registró nada, Kapta la cierra como «no
    contesta» en cuanto Telnyx avisa el corte, sin esperar al barrido de
    cinco minutos. Antes de cerrar espera 3 s, por si el registro venía en
    camino.

    El error empieza con «sin registrar_gestion», igual que el del barrido,
    así que la comparación la sigue contando como atendida y cortada sin
    gestión. Esto importa porque las tres líneas comparten el número de
    agente: el domingo 04-10, cada corte dejaba la cola parada unos 10 min
    hasta que pasaba el barrido.

    **Daaph (Zadarma), desde el 05-10-2026.** Zadarma no le avisa a Kapta el
    fin de la llamada: la cuenta tiene una sola URL de avisos de la centralita
    y la usa KairoAI, que sigue en uso. No se toca. En su lugar, cada pasada
    del barrido le pregunta a la estadística de Zadarma
    (`reconcileZadarmaCalls`), después del vigilante y antes de ver qué
    agentes están libres. Así, si Daaph terminó, vuelve a llamar en esa
    misma pasada.
    - Solo consulta si hay llamadas de Zadarma abiertas. Lee las llamadas
      terminadas de `/v1/statistics/` y `/v1/statistics/pbx/` desde 10 min
      antes de la más antigua.
    - Las horas de la estadística vienen en la zona de la cuenta, que se lee
      de `/v1/info/timezone/`.
    - La llamada se reconoce por el teléfono de la clienta y por haber
      empezado desde un minuto antes de marcar, porque el callback no devuelve
      un id. Una llamada anterior al mismo teléfono no cuenta.
    - Una llamada en curso solo se da por terminada con el registro
      contestado (`answered`). El callback deja además un registro «failed» de
      0 s. El 05-10 se vio uno mientras la clienta hablaba con Daaph, y cerrar
      con ese registro cortaría el registro de la gestión.
    - Si estaba en curso sin gestión, se aplica el mismo cierre por corte que
      en Telnyx (`closeCutWithoutGestion`). Si seguía marcando, se cierra como
      «no contesta» con la causa que dio Zadarma: ocupado, sin respuesta,
      cancelada.
    - Cada cierre queda en `telephony_response.eventos` con tipo
      `zadarma.stats`. Si la API falla, no se cierra nada y queda el
      vigilante.
    - La ruta `/api/webhooks/zadarma` (aviso firmado con `ZADARMA_SECRET`,
      verificación `zd_echo`) existe, pero no está configurada en el panel.
      Sirve si algún día la URL de avisos queda libre.

    Con la consulta, un corte de Daaph tarda en liberarse lo que falta hasta
    la siguiente pasada (≤ 5 min), no los ~10 min del vigilante.

    El 05-10, una llamada de Daaph contestada a las 09:15:30 seguía «en curso»
    a las 09:20 sin resultado, y la pasada de las 09:20 se perdió.

    Para no anotar un «no contesta» encima de una gestión,
    `registrar_gestion` reserva primero la llamada: escribe su `outcome` solo
    si la llamada sigue en curso y sin resultado, y recién después escribe
    sobre el pedido. El cierre por corte no toca una llamada reservada.
    Tampoco vale un segundo registro en la misma llamada. El barrido sí
    cierra una llamada reservada cuyo registro se cayó, porque si no el
    número quedaría ocupado.
  - **Contestadora: modo sombra.** La detección de Telnyx corre en cada
    llamada y su resultado queda anotado (`amd`), pero no cuelga. En la
    primera prueba (03-10-2026) tomó por buzón a una persona dos segundos
    después de contestar y cortó antes de que el agente hablara. Los buzones
    los sigue resolviendo el agente, como en Zadarma. Se activará solo si,
    comparada con lo que realmente pasó en las llamadas, acierta.
  - **Mismo número de agente.** Las dos líneas usan el mismo
    `agent_number`, así que `identificar_llamada` encuentra la llamada igual y
    nunca hay dos abiertas a la vez.
  - **Avisos de Telnyx.** Los recibe `/api/webhooks/telnyx`, solo si vienen
    firmados (Ed25519, `TELNYX_PUBLIC_KEY`). Cada aviso queda en
    `voice_calls.telephony_response.eventos`, con el tramo, la causa del
    corte, quién colgó y el resultado de la detección.
  - **Reparto.** Cada llamada del barrido se sortea: va por Telnyx con
    probabilidad `VOICE_TELNYX_SHARE` (0–100; 0 = solo pruebas) y, si no,
    por Zadarma. La prueba manual elige la línea: «Probar en mi teléfono»
    del Master tiene «Llamarme» (Zadarma) y «Por Telnyx», y
    `/api/internal/voice/test-call` acepta `telefonia`.
  - **«Hoy por asesora».** Las notas de una llamada por Telnyx firman
    «Agente de voz (Telnyx)» y cuentan en la fila **«Agente Telnyx»**; las de
    Zadarma, en «Agente Daaph». Las dos filas van al final de la tabla.
  - **Agente ElevenLabs** (03-10-2026). Usa la misma línea Telnyx, pero con
    otro motor: el agente de ElevenLabs («Agente ElevenLabs · Kenku
    Reproprovincia»), con el mismo guion y las mismas herramientas de Kapta.
    La llamada guarda el motor en `voice_calls.provider` (`grok` o
    `elevenlabs`). El tramo hacia el agente va a `TELNYX_ELEVENLABS_SIP_URI`
    en vez de a la puerta de xAI. Sus notas firman «Agente de voz
    (ElevenLabs)» y cuentan en la fila **Agente ElevenLabs**. Se prueba con
    «Por ElevenLabs» en el Master o con `motor` en la prueba interna.
    Primero se compara la línea (Daaph contra Telnyx, mismo motor) y después
    el motor (Telnyx + Grok contra Telnyx + ElevenLabs), una variable a la
    vez. **Cambio del owner (04-10-2026):** compiten los tres a la vez. El
    barrido sortea cada llamada real:
    - `VOICE_TELNYX_SHARE` % al Agente Telnyx (Telnyx + Grok);
    - `VOICE_ELEVENLABS_SHARE` % al Agente ElevenLabs (Telnyx + ElevenLabs);
    - el resto al Agente Daaph (Zadarma + Grok).

    Las reglas del sorteo están en `pickVoiceRoute`. Un agente sin configurar
    (sin puerta SIP) no recibe llamadas y su parte vuelve a Daaph; si los dos
    porcentajes suman más de 100, se recortan a 100. Sigue habiendo una sola
    llamada a la vez por tienda, porque las tres líneas comparten el número de
    agente.

    **Agentes en paralelo (decisión del owner, 05-10-2026).** Con una sola
    llamada a la vez, cada pasada del barrido (cada 5 min) daba una llamada:
    unas 12 por hora para una cola de ~250. Ahora cada agente con **número
    propio** llama a la vez. La pasada lanza una llamada por número libre, cada
    agente con el siguiente pedido de la cola y todas contando contra el tope
    del día (`planVoiceSlots`).

    Las tools encuentran la llamada por el número de agente, así que dos
    agentes solo pueden ir en paralelo si Kapta sabe, al recibir la tool, de
    qué motor viene. Si no lo sabe, comparten número y se turnan.
    - **ElevenLabs** firma sus tools con su propio secreto
      (`VOICE_TOOLS_SECRET_ELEVENLABS`). Por eso tiene su número
      (`<número>#elevenlabs`), y sus tools y su inicio solo ven llamadas de
      ElevenLabs (`callsForEngine`). La URL de sus tools no cambia
      (`?agente=1-11`), porque el sufijo no tiene dígitos y el número se
      compara por dígitos.
    - **Daaph y Telnyx** usan el mismo agente de xAI y el mismo secreto, así
      que comparten número y su turno se sortea con sus porcentajes. Telnyx
      pasa a tener turno propio cuando su agente de xAI tenga otro `?agente=`,
      configurado en `VOICE_AGENT_NUMBER_TELNYX` (con dígitos distintos).
    - En paralelo, el porcentaje de un agente con turno propio solo lo
      enciende o lo apaga (> 0). Si falta el secreto de ElevenLabs o es igual
      al de xAI, todo vuelve a un turno sorteado entre los tres.

    **Reintento automático (04-10-2026).** Si un pedido de la cola corresponde
    al reintento automático Aliclik → Swayp, el agente no lo llama: el
    reintento tiene prioridad. En ese caso el barrido lo salta y prueba el
    siguiente, hasta 10 pedidos por pasada. El domingo 04-10 un solo pedido
    así quedó al frente de la cola y bloqueó todas las pasadas desde las
    11:00, con 24 pedidos listos detrás.

    Esa misma tarde volvió a pasar, con la cola de 266. Los pedidos que ya
    tienen una emisión del reintento automático
    (`swayp_guide_emissions.automatic`) se ponen al frente, porque son
    cierres recientes. Los diez primeros eran así: nueve los saltó Kapta y el
    décimo lo rechazó la base (`swayp_auto_voice_interlock`). Ese rechazo no
    se tomaba como un salto, así que la pasada terminaba sin llamar a nadie.

    Desde entonces ese pedido ni siquiera entra a la cola: queda excluido como
    `reintento_automatico`. Si la base rechaza igual una llamada por esa
    razón, se trata como un salto y la pasada sigue con el siguiente.

    Aun así quedaban más de diez pedidos al frente que Kapta saltaba. La regla
    del reintento automático los marca como candidatos, pero el despachador
    emite pocos al día (por ejemplo, el piloto tiene cupo diario). Ahora cada
    pasada prueba hasta 60 pedidos, con un tope de 30 s, antes de rendirse.

    **Cupo del piloto lleno (decisión del owner, 05-10-2026).** Si el pedido
    es apto para el reintento solo como piloto (cohorte `recent_no_history`,
    sin entrega previa en el domicilio) y el cupo diario del piloto ya está
    usado, el despachador no lo va a emitir hoy, así que el agente sí lo
    llama. En la corrida del 04-10, 20 a 26 de cada 50 pedidos revisados
    quedaron fuera solo por ese cupo, y se quedaban días sin que nadie los
    atendiera.

    El cupo se cuenta con la misma función en los dos lados
    (`pilotUsedToday`, día de Lima). Con cualquier otro motivo (ubicación sin
    corroborar, producto sin vínculo, sin stock) el reintento sigue teniendo
    prioridad y el agente no llama.

    Mientras la llamada está abierta, el despachador no emite
    (`human_management`). Un «cancela» o un «que no me llamen» lo descartan
    para siempre (`rejection`). Si la clienta no contesta, al día siguiente el
    despachador puede emitirlo con cupo nuevo.
    **Secreto propio (04-10-2026).** Las tools aceptan `VOICE_TOOLS_SECRET`
    (xAI) o `VOICE_TOOLS_SECRET_ELEVENLABS` (ElevenLabs). El segundo es
    opcional: si está vacío, solo vale el primero. Así cada agente tiene su
    secreto y rotar uno no corta al otro.

    Se mandan como `Authorization: Bearer …` o como `x-voice-secret`. En
    `x-voice-secret` también vale con «Bearer » delante: así quedó guardado
    el secreto en ElevenLabs en la primera prueba, y dio 401.
    **Ficha precargada (04-10-2026).** ElevenLabs llama a
    `/api/voice/elevenlabs/inicio?agente=…` al entrar la llamada (el webhook
    de datos de inicio de conversación, con `x-voice-secret`). Kapta busca la
    llamada abierta igual que `identificar_llamada`, la pasa a «en curso»
    (`outcome_payload.ficha_precargada`) y devuelve dos cosas:
    - la ficha como variables dinámicas de texto, siempre todas, con
      `encontrada` = `si` o `no`;
    - el primer mensaje: «Hola, buenas. ¿Hablo con {nombre}?», o «¿Con quién
      tengo el gusto?» si no hay nombre.

    Así el agente habla al conectar con los datos ya cargados, sin ida y
    vuelta a la tool. En la medición del 03-10, esa ida y vuelta eran unos 2 s
    después del primer «aló».

    Sin ficha (o si algo falla) responde igual 200, con todo vacío y
    `encontrada = no`, y el agente cae a `identificar_llamada`.
    `identificar_llamada` entrega una llamada ya «en curso» solo si la abrió
    este inicio; cualquier otra en curso sería la ficha de otra conversación.
    **Sin respuesta real (04-10-2026).** El domingo, las 3 llamadas atendidas
    por ElevenLabs terminaron sin registro:
    - una de 300 s, dando vueltas con una grabación que solo decía «aló»;
    - otra en que la persona no habló, y el agente colgó sin registrar;
    - otra que se cortó tras 20 s de silencio.

    Desde entonces el guion manda insistir como mucho dos veces cuando nadie
    habla, o cuando solo dicen «aló» o suena una grabación. Si sigue igual,
    el agente registra `no_contesta` y **después** cuelga. Nunca cuelga sin
    registrar, salvo si la ficha no existe. La duración máxima bajó de 300 s
    a 180 s.
    **Registrar antes de anunciar, y sin silencios largos (08-10-2026).**
    - **Registro primero.** El 08-10, el cliente de #KP138343 pidió cancelar.
      El agente le dijo «Cancelaremos su pedido» sin haber llamado a
      `registrar_gestion`. El cliente colgó al oír la despedida, y Kapta lo
      cerró como «no contesta». Desde entonces el guion manda registrar **en
      cuanto la decisión está clara y antes de anunciarla o despedirse**. El
      agente nunca dice que el pedido queda cancelado, confirmado o
      reprogramado sin haber registrado antes. Con «cancela», registra apenas
      la clienta da el motivo, o cuando no quiere darlo.
    - **Muletilla.** El 07-10, tras «Sí, habla», el modelo (Gemini 2.5 Flash
      Lite) tardó 3 s en contestar, cuando lo normal es 0,3 s. La clienta oyó
      casi 4 s de silencio y colgó. Ahora, si el modelo tarda más de 1,5 s, el
      agente dice «Ajá…», y si sigue tardando, «Un momentito…». La muletilla
      no se usa antes de que la clienta hable.
    - **Sin razonamiento interno** (`thinking_budget` = 0). En esa respuesta,
      el modelo generó 841 tokens para una sola frase.
  - **«Llamando ahora» (Envíos, 05-10-2026).** En la pestaña Pendiente, la
    pantalla pregunta cada 5 s por las llamadas del agente abiertas: reales,
    marcando o en conversación, y sin las caducadas (`getLiveVoiceCalls`).
    - **La fila va primero**, sea cual sea el orden elegido, con fondo azul
      claro y una nota: «Marcando · Agente X» mientras suena, o «Llamando ·
      Agente X» con un punto verde cuando la clienta ya habla. La nota lleva
      el tiempo que va la llamada. Así nadie abre esa guía para llamar a la
      vez que el agente.
    - **Línea «Agente de voz»**, siempre visible arriba de la tabla. Con
      llamada, dice a quién llama. Si los filtros esconden ese pedido, lo
      avisa y ofrece «Buscarlo».

      Sin llamada dice «Sin llamada en curso», cómo terminó la última
      (pedido, agente, resultado y hace cuánto) y la hora de la próxima
      pasada del barrido. Esa hora sale de la misma regla de horario que usa
      el barrido (`withinVoiceHours`); si el automático está apagado, lo
      dice. Se agregó el 04-10-2026: con una llamada cada 5 min y la mayoría
      de menos de un minuto, la tabla pasaba casi todo el tiempo sin ninguna
      fila marcada y no se sabía si el agente estaba trabajando.
    - **Al terminar la llamada**, la cola se recarga (como mucho una vez cada
      15 s) y la fila sale con la gestión que registró el agente.
    - **Pestaña oculta:** con la pestaña del navegador oculta no se consulta.
    - **Tiempo de la llamada:** el reloj de la nota corre solo, sin repintar
      la tabla.
  - **«Agentes de voz: comparación»** (Envíos, en el resumen de arriba, junto
    a «Hoy por asesora»). Muestra una fila por agente, siempre los tres, con
    llamadas **reales** (`mode = 'real'`) del rango elegido, con los mismos
    chips que el popup de reprogramaciones: Hoy, Ayer, Últimos 7 días, Este
    mes o un Rango a mano (días de Lima, ambos incluidos, hasta 366). Hoy llega
    con la página; los otros rangos se piden al elegirlos. El agente sale de la
    llamada: Zadarma es Daaph; Telnyx con
    `provider = 'grok'` es Telnyx y con `elevenlabs` es ElevenLabs.
    - **Atendidas:** `started_at` presente —`identificar_llamada` corrió, el
      agente creyó oír a una persona— **salvo que el propio agente registrara
      después «no contestó»**: eso es un buzón. El «no contestó» que escribe el
      vigilante al cerrar una llamada sin registro (`error` «sin
      registrar_gestion…») sí es atendida (04-10-2026: el 03-10 salían 10
      atendidas y 10 sin gestión sobre 4 buzones y 6 cortes).
    - **Sin gestión:** atendidas cuyo resultado no es `confirma`, `programar`
      ni `cancela`.
    - **Guías Swayp:** `outcome_payload.salida_swayp.ok`.
    - **Conversión:** confirma sobre atendidas.
    - **Llamadas por confirma:** llamadas sobre confirma, como aproximación
      del costo.

    - **Costo línea (US$):** lo que Telnyx avisa que cobró, la suma de los dos
      tramos. No incluye el minuto de xAI ni el de ElevenLabs.
    - **Costo por confirma:** solo cuando todas las llamadas del rango traen
      costo. Si hay llamadas sin costo, la columna muestra «n de m».

    Daaph sale con guion porque Zadarma no avisa el costo por llamada, y la
    duración que guarda `voice_calls` no es la facturada cuando la cierra el
    barrido.
  - **Costo real de cada llamada Telnyx** (04-10-2026). Con «call cost
    webhooks» activado en la aplicación de Telnyx, cada tramo manda
    `call.cost` al colgar: total, moneda, segundos facturados y desglose
    (`call-control`, `sip-trunking`, etc.). Se guarda en
    `voice_calls.telephony_response.costo` así:
    - `cliente` y `agente`: el aviso de cada tramo.
    - `total`: la suma de los tramos con monto.
    - `moneda`.

    Los dos tramos avisan casi a la vez. La escritura solo se hace si la fila
    no cambió desde que se leyó (`updated_at`) y, si cambió, se vuelve a leer
    y se reintenta. Un aviso repetido reemplaza el de su tramo, no lo suma dos
    veces. Con `status = error` no hay monto, y el total no lo cuenta como
    cero.
  - **Cuándo arranca el reparto.** El plan era esperar el número de Lima,
    porque con un +1 la clienta contesta menos y la comparación sale
    injusta. El owner decidió arrancar el 04-10-2026 con el +1 de EE. UU.
    Al leer la comparación, la tasa de atendidas de Telnyx y ElevenLabs se
    lee con esa desventaja hasta que llegue el número de Lima.
- Todo hecho que escribe lleva en `payload` el `voice_call_id`, y la línea de
  tiempo del drawer lo muestra con actor **«Agente de voz»** y enlace a la
  transcripción. Un intento que no se puede leer después no es historial
  (§6.1).
- **La llamada se ata al pedido ANTES de marcar, no durante.** Kapta escribe
  la fila de `voice_calls` con pedido y teléfono, y solo entonces pide a la
  telefonía que llame. Lo que el agente dice y registra se atribuye a esa fila,
  nunca a un pedido buscado por el número que contesta: dos pedidos abiertos
  del mismo teléfono (§8.1, duplicados) se resolverían al azar. Si al conectar
  no se puede establecer a qué fila pertenece la llamada, el agente se despide
  sin gestionar y la fila queda `sin_resultado`.

**Descartar.** «Cliente no quiere» es la salida terminal de la recuperación
(§11.5 le pide ceremonia). No está en la lista de lo que nunca se automatiza
(§2, principio 11) y no es irreversible —sobre un pedido descartado se puede
seguir creando una salida Swayp—, pero el piloto empieza sin delegarlo:

- `voice_recovery_can_discard = false` (por defecto): el agente **propone**. La
  llamada queda en `voice_calls` con resultado `no_quiere` y el motivo dicho
  por la clienta; la cola muestra «El agente propone descartar: “…”» y el
  descarte lo ejecuta una persona con la ceremonia de siempre. La llamada no
  escribe `confirmation_contact` y no gasta día: es una asimetría conocida y
  aceptada mientras el interruptor esté apagado.
- `voice_recovery_can_discard = true`: escribe `recovery_discarded` con
  `source = 'agente_voz'` y el motivo literal, por la misma función que Envíos
  y el Master (`lib/recovery-discard.ts`). Se enciende cuando el piloto haya
  escuchado los descartes propuestos y los dé por buenos.

#### Lo que el agente nunca hace

Crear guías. Tocar Shopify. Pedir o recibir pagos. Prometer hora. Llamar fuera
de horario, por encima del tope o a quien pidió no ser llamado. Hablar de otro
pedido. Y **no decide condiciones de pago**: si por antecedentes tocaría exigir
adelanto, ese pedido no entró a su cola.

#### Piloto y medida

Una tienda (Kenku), dos semanas. **Decisión del owner, 23-09-2026:** el
automático se enciende desde el primer día con el tope de 30 llamadas diarias,
en lugar de una semana a mano desde el drawer; el tope es la marcha atrás, y
apagar `voice_recovery_auto` la detiene. **Ajuste del owner, 25-09-2026:**
Kenku pasa a `voice_recovery_daily_cap = 80` y `voice_recovery_max_age_days =
21`. El primer día el tope de 30 se agotó a las 11:45 con 37 pedidos todavía
en cola, y el límite de 7 días dejaba fuera 817 pedidos, unos 300 de ellos con
stock Swayp completo. **Segundo ajuste, 26-09-2026:** el owner
sube Kenku a `voice_recovery_daily_cap = 130` y `voice_recovery_max_age_days
= 30`, la misma ventana que la recuperación (`return_recovery_max_days`). Con
una llamada cada cinco minutos, 130 es lo que cabe entre las 9:00 y las 20:00.
Se mide la tasa de «confirma» por antigüedad de la guía (0–7, 8–14, 15–21 y
22–30 días) para decidir si la parte tibia vale la llamada.
**Tercer ajuste, 04-10-2026:** Kenku tenía en la base `voice_recovery_daily_cap
= 80` y `voice_recovery_max_age_days = 21`, no el 130/30 del ajuste anterior.
La cola se vació a las 14:35: de los pedidos con stock Swayp, 158 ya tenían las
2 llamadas del agente. El owner pasa Kenku a **`voice_recovery_max_attempts =
3`** y **`voice_recovery_max_age_days = 30`**. Con eso la cola pasa de 6 a 266
pedidos. Ese mismo día también sube el tope a **`voice_recovery_daily_cap =
130`**, lo que cabe entre las 9:00 y las 20:00 con una llamada cada cinco
minutos. Sigue habiendo una llamada del agente por pedido y día. El tope de
siete días de gestión (§6.1) sigue siendo de todos.
**Cuarto ajuste, 04-10-2026 (noche):** Kenku pasa a **`voice_recovery_hour_end
= 22`** y **`voice_recovery_daily_cap = 150`**. Así el agente llama en el mismo
horario laboral de las asesoras (§6.1, hasta las 22:00), y no solo hasta las
20:00 como manda el valor por defecto. La última pasada es a las 21:55, y esa
llamada puede terminar pasadas las 22:00. Con dos horas más caben unas 155
pasadas por día, por eso el tope sube de 130 a 150. Las demás tiendas siguen
con 09–20 por defecto. Todas las
transcripciones de la
primera semana se escuchan. Se decide con estas cifras, comparadas con la
línea base de cero llamadas:

| Métrica | Qué delata |
| --- | --- |
| Llamadas contestadas / realizadas | Si el número, el horario o el caller ID están mal |
| Aceptaron / contestadas | Si el guion convence |
| Salidas Swayp creadas ≤ 48 h tras un aceptado, y entregadas | Si la aceptación se convierte en venta; **la que manda** |
| Aceptados sin salida a las 24 h | Si almacén recoge lo que el agente deja |
| Descartes propuestos que una persona rechazó | Si el agente entiende un «no» |
| Motivos capturados sobre devoluciones sin motivo | El dato que §11.7 no tenía |
| `recuperacion_vencida` por semana, antes y después | Lo que se pierde por no llamar. Desde la v1.18 (26-09-2026) excluye los rechazos en la puerta, que pasan a `rechazo_no_reenviado`: el cron reescribe también el histórico, así que el antes y el después se comparan ya sin ellos — no es una caída que haya causado el agente |
| Costo (Grok + Zadarma, las dos patas) por pedido entregado | Contra el margen del pedido |

Con los aceptados y las salidas se calcula lo mismo que la tabla de cierre de
§11 mide para las llamadas humanas, con el mismo corte de 60 días, para poder
poner las dos columnas una al lado de la otra.

#### Criterios de aceptación

- La elegibilidad es **una función pura** (`voiceRecoveryEligible`) que recibe
  el resultado de `recoveryOutcome`, guías, eventos, stock, antecedentes y
  ajustes de tienda, y cada una de las nueve condiciones tiene una prueba que
  la excluye por separado.
- El orden de la cola tiene prueba: fecha pactada por el agente primero, luego
  cierre más reciente.
- Cada fila de la tabla de resultados tiene prueba de **qué hechos escribe y
  cuáles no**. Un resultado desconocido o una llamada sin resultado no escribe
  nada sobre el pedido.
- El mismo `voice_call_id` recibido dos veces produce **un** `confirmation_contact`,
  un día y una tarea.
- `confirmed` con `source = 'agente_voz'` sobre un pedido en Reproprovincia no
  cambia `macro_stage` ni `macro_substage`, y la cola lo etiqueta «Acepta
  reenvío».
- Con `voice_recovery_auto` apagado el barrido no crea llamadas; con
  `voice_recovery_enabled` apagado no existe la cola ni el botón.
- El tope diario, el tope por pedido, el horario y `no_llamar` se prueban
  cada uno con un caso que los cruza por una unidad.
- `register_confirmation_attempt_v2` escribe la procedencia que recibe y la
  v1 no cambia.
- Sin extensión con caller ID peruano configurada, Kapta no pide la llamada.
- Una fila `test` no escribe nada sobre el pedido con ninguna `disposition`.
- La transcripción y la grabación se leen bajo RLS de la tienda, como la ficha
  (§8.1).

#### Pendientes de esta sección

- **Pedidos sin cupo de gestión** (condición 8): contar cuántos recuperables
  quedan fuera por haber gastado siete días en su confirmación original. Si son
  muchos, decidir si la recuperación abre un cupo propio.
- **Agencia con adelanto por voz** (§11.1): solo después del piloto, y solo
  hasta `pendiente_de_abono`; el pago lo valida una persona.
- **Por confirmar por voz** (§6.1): después de Reproprovincia, con la misma
  arquitectura y una decisión aparte sobre falsos confirmados.
- **Grabación sin aviso en el saludo**: desde el 23-09-2026 el saludo no
  anuncia la grabación. Antes del piloto con clientas reales, confirmar con
  quien asesore en protección de datos si eso es aceptable; si no lo es, o se
  apaga la grabación (queda la transcripción) o el aviso vuelve al saludo.

### 11.9 Reintento automático Aliclik → Swayp sin contacto (01-10-2026)

Decisión operativa: se autoriza un nuevo despacho por parámetros, **sin llamada
ni reconfirmación**. No se registra una aceptación del cliente. El flujo de voz
de §11.8 sigue siendo otro flujo y cede prioridad a los candidatos de esta regla.

La política v1 exige todas estas condiciones:

- Pedido Shopify vigente, en PEN y pendiente de pago, sin devolución de dinero,
  con importe positivo y creado hace como máximo **14 días**. Las guías antiguas
  del piloto fueron excepciones manuales; no amplían esta ventana.
- Guía Aliclik **anulada con cierre registrado** (`closed_at` o devolución),
  con motivo `CANCEL` o `NOT_RESPOND`. No hace falta esperar el retorno físico
  del paquete: Swayp arma una nueva salida con su propio stock. Un intento
  «no responde» que sigue en reparto no puede originar otra salida.
- Teléfono peruano válido, igual al del destino; una entrega anterior a la
  compra actual, en los últimos **180 días**, al mismo domicilio, distrito y
  provincia. El historial se cruza entre tiendas de la misma organización.
- Productos distintos de los entregados: no basta cambiar talla o variante.
  SKU, producto, título normalizado y codbar permiten detectar coincidencias.
  Una compra posterior con el mismo producto se aparta como posible reemplazo.
- Sin rechazo explícito en las notas del pedido, gestiones o resultados de voz;
  sin descarte, guía viva, entrega del pedido ni intento Swayp anterior. Sin
  guía tomada por un asesor, programación futura o llamada en curso.
- Provincia fuera de Lima/Callao, distrito con ubigeo exacto y bodega habilitada
  por API. Todos los SKU deben tener codbar sin conflictos entre tiendas.
- Inventario **leído de Swayp al emitir**, para todas las cantidades. La reserva
  serializada resta emisiones concurrentes y emisiones inciertas. Nunca basta
  el indicador guardado de elegibilidad. Si falta un dato, el pedido se aparta.

`swayp_auto_settings` conserva interruptor y límites por organización: apagado
al instalar, máximo **10 intentos diarios** entre todas sus tiendas, día de Lima.
Los plazos y el tope se pueden configurar en la base. El cron corre cada
**30 minutos** en producción; cada pasada revisa hasta 50 pedidos, rotando los
menos recientemente evaluados. Programa para el siguiente día operativo:
sin domingo y, conservadoramente, sin sábado en Arequipa.

El nuevo envío físico conserva su identidad propia, el número real de Swayp y
el vínculo desde la guía Aliclik, que queda transferida. El historial dice
«reintento automático, sin llamada ni nueva confirmación».

**Una solicitud como máximo por origen.** Antes del POST, `swayp_emission_claim`
serializa por organización, verifica cupo, stock reservado y que los datos no
hayan cambiado. La reserva se comparte con emisiones por botón y voz. Un pedido
tiene un solo intento automático. Swayp no admite clave de idempotencia: un
timeout o caída del proceso no libera la reserva ni repite el POST. Se conserva
el número emitido antes del alta local; los resultados inciertos quedan para
reconciliación humana. No se anulan guías externas automáticamente.

**Solo el automático exige que no quede otra salida viva (02-10-2026).** Su
origen es una guía Aliclik ya anulada, y la reserva lo comprueba. Las emisiones
por botón o voz no: la guía Swayp directa se escribe sobre la salida «por
definir» del pedido, y en Lima puede salir como adicional con motivo (§9,
`puertaDeSalidaAdicional`). Desde la 0209 el chequeo se aplicaba a todas, contaba
como «otra guía activa» la propia salida «por definir» y ninguna guía directa se
podía crear (#KP138264, #KP138197 y #KP138302, esta con la salida de Grupo GF
todavía pendiente). La 0219 lo limita al automático.

En **Repro Provincia → Ver automático Aliclik → Swayp** se muestran el estado,
las ejecuciones, las guías emitidas y el último motivo por pedido. Un administrador
puede pausar o activar la regla y ejecutar una pasada. Las escrituras quedan
restringidas al servidor; las lecturas respetan organización y tiendas mediante
RLS. Los previews no pueden activar ni ejecutar emisiones automáticas.

#### 11.9.1 Piloto sin entrega previa (01-10-2026)

Ampliación aprobada: la entrega previa deja de ser obligatoria para una segunda
vía con **6 intentos diarios por organización** (eran 3 hasta el 03-10-2026),
dentro del máximo general de 10. El cupo se configura en la base
(`pilot_daily_cap`, de 1 a 50) y siempre cuenta dentro del cupo general:
la reserva comprueba el general primero. Tiene interruptor
propio, apagado al instalar. La vía con historial se conserva.

- Pedido de hasta **14 días**, importe positivo de hasta **S/500**, con **1 o 2
  intentos Aliclik informados** y el paquete **en reparto o de vuelta**
  (despacho `PICKED`, `TO_RETURN` o `RETURNED`). Un intento sin dato no cuenta
  como cero: se aparta. Cero intentos, tres o más, y un despacho que diga que el
  paquete no salió a reparto (`LEFT_IN_WAREHOUSE`, `STORE_CENTRAL`,
  `REMAINING_IN_TRANSIT`) también.
- **Solo si Aliclik llegó a visitar** (05-10-2026, decisión del owner,
  migración 0231). Revierte el «0 intentos» de la ampliación del 03-10. Medido
  sobre los reenvíos por Swayp tras una Aliclik fallida desde el 15-09, con 4 o
  más días: de los **37** cuyo paquete Aliclik nunca salió a reparto o no tuvo
  ni un intento, **ninguno** se entregó; los 7 entregados tenían todos al menos
  una visita. Un `CANCEL` sin visita suele ser el cliente cancelando por
  teléfono con Aliclik: así contestaron #KP136734 y #KP136038, reenviados por el
  piloto el 03-10 con 0 intentos («cancelé ese pedido», «ahora no lo quiero»).
  De las 22 guías del piloto hasta ese día, 13 habían salido con 0 intentos.
  Se aparta con su propio motivo, «Piloto: Aliclik no llegó a visitar»
  (`aliclikSalioAReparto`), para que la pantalla diga por qué. La vía con
  entrega previa no cambia.
- El máximo inicial de S/199 se amplió a **S/500** por decisión del usuario el
  01-10-2026. Se conservaron el cupo y el resto de condiciones.
- **Ampliación del 03-10-2026** (decisión del owner, migración 0220): de 7 a 14
  días y de exactamente un intento a 0–2 (el 0 se revirtió el 05-10, arriba). En 70 pasadas el piloto emitió 4
  guías y en las últimas no halló ni un elegible; el cupo no era el freno. De
  126 pedidos apartados por estos límites, 95 pasaban de 7 días —la edad se
  cuenta desde la compra y Aliclik suele fallar entre el día 5 y el 10—, 68
  traían 0 intentos (el courier cerró sin llegar a ir) y 26 traían 2 o más. Al
  ampliar se contaba 1 entrega y 1 devolución de 4 emitidas: se mide de nuevo
  antes de tocar el cupo. Los límites viven en `PILOT_MAX_ORDER_DAYS` y
  `pilotAttemptsOk` (`lib/swayp-auto-policy.ts`) y la reserva
  (`swayp_emission_claim`) repite los mismos.
- **Cupo de 3 a 6 diarios** (03-10-2026, decisión del owner, migración 0221).
  Se decidió el mismo día de la ampliación, sin esperar la nueva medición: con
  ~99 pedidos que pasan los límites nuevos, 3 al día los dejaba vencer a los 14
  días. La 0210 fijaba el tope en 3 con un `check`; la 0221 lo deja de 1 a 50,
  la misma cota del cupo general. No se compara contra `daily_cap`: ese check
  entre columnas rompía una organización con cupo general menor que 3.
- Referencia no vacía y coordenadas completas. Antes de emitir se consulta el
  pin mediante la lectura de cotización de Aliclik: distrito y provincia deben
  resolver al mismo ubigeo exacto que el destino. Si falla la consulta o difieren,
  se aparta; no se mueve el pin ni se modifica el domicilio automáticamente.
- Sin pago registrado no rechazado: este piloto cobra el total contra entrega.
  La vía para descontar adelantos se mantiene fuera de este alcance.
- Siguen vigentes cierre Aliclik, rechazo, duplicados, producto ya entregado,
  otras salidas, gestión vigente, cobertura, vinculación y stock completo vivo.
- Sin llamadas ni reconfirmación. Se consulta la tarifa Swayp antes del único
  POST de emisión y se conserva como estimación de costo, no como liquidación.

La reserva serializada verifica también el subcupo, el interruptor y los límites
del piloto. Enviar, crear o quedar incierto consume el cupo; no se libera por un
timeout. El historial distingue `recent_no_history` de `prior_delivery`.
La pantalla agrega guías, entregas, devoluciones, anulaciones y pendientes por
vía. Costo por entrega recuperada = suma de fletes cotizados y devoluciones
registradas de la vía / entregas logradas, incluyendo envíos fallidos. Si falta
un costo o aún no hay entregas, indica pendiente; nunca lo presenta como cero.

**El resultado se lee del estado de Swayp (0236, 09-10-2026).** La vista
`swayp_auto_metrics` contaba como devuelta solo una guía `devuelto` en Kapta, y
Swayp nunca llega ahí: su Devolución (8) queda `en_ruta` y la confirmada (9, 12),
`anulado`. La pantalla decía «1 entregada · 0 devueltas · 25 pendientes» con 18
guías en Devolución. Ahora: entregada es `entregado` o Swayp 7; devuelta, Swayp
8, 9 o 12, la caja de vuelta o `devuelto`; anulada, el resto de las anuladas;
pendiente, lo demás. Los retornos de Swayp no traen costo registrado, así que el
costo por entrega queda «pendiente» hasta tenerlo, en vez de mostrarse más bajo
de lo que es.

### 11.10 Filtro «Swayp» en el Master (08-10-2026)

El Master tiene el mismo filtro «Swayp» que Repro Provincia, con las mismas tres
opciones y los mismos textos: **Swayp ok · con stock**, **Sin stock Swayp** y
**Fuera de cobertura**. Responde, sobre el pedido, lo que Repro responde sobre
la guía: ¿lo puede llevar Swayp hoy?

- **La regla es la de Repro**, no una propia: `evaluateFenix`. «Ok» es que la
  ciudad de destino tiene almacén Swayp (o se reparte desde uno, como Chupaca
  desde Huancayo) y hay stock disponible del producto del pedido; «sin stock»,
  que hay almacén pero no stock; «fuera de cobertura», que no hay almacén. Lima
  no lleva control de cantidad, así que siempre sale «ok»: para provincia se
  combina con el filtro Cobertura.
- **El destino** es el del Master: distrito y provincia del ubigeo, o el
  departamento si falta la provincia.
- **Solo se calcula en Por confirmar, Preparación, Por despachar y En curso.**
  En Por cerrar y Finalizado queda vacío: el stock de hoy no decide nada ahí, y
  un «ok» congelado de hace semanas confundiría.
- **Vive en `order_master.swayp_availability`** (0235) porque el Master filtra en
  la base y pagina; calcularlo en la página no permitiría contar ni filtrar.
- **Se refresca cada hora** (cron `swayp-inventory`) y al terminar cada sync de
  inventario, sin depender del recálculo del pedido: lo que la cambia es el
  stock, y el recálculo del pedido no se entera de que el stock cambió. Un
  pedido nuevo o que cambia de etapa puede tardar hasta una hora en tener valor.
  La función es `recalcularDisponibilidadSwaypMaster`
  (`lib/master-swayp-availability.ts`) y solo escribe las filas que cambian.

### 11.11 Swayp desde Por confirmar (v1.24, 09-10-2026)

Decisión del owner. Un pedido de **provincia COD** en **Por confirmar** que
Swayp puede llevar hoy («Swayp ok · con stock», §11.10) puede salir por Swayp
**sin confirmar**, con el botón **«Enviar por Swayp»** de la mesa de
confirmación. Invierte, para esos pedidos, el orden de la Fase 3 («Aliclik
primero, Swayp tras el fallo»), y es una excepción escrita a «crear el rótulo
implica confirmación» (§6.1), como la del §11.9.

- **El botón** abre la guía Swayp directa de siempre (mismas validaciones de
  destino, stock por producto, vínculo de Catálogo, número de Swayp y fecha de
  despacho posterior a hoy: Swayp arma la ruta del día siguiente). El servidor
  exige además que el pedido siga en Por confirmar y sea provincia COD, y graba
  el hecho `swayp_desde_por_confirmar` con la guía (`shipment_id`) y quien lo
  pulsó, **antes** de recalcular el Master. No escribe `confirmed`: no hubo
  confirmación. No se ofrece en «Swayp no entregó».
- **Si Swayp entrega**, terminó como cualquier entrega.
- **Si Swayp no entrega**, el pedido **vuelve a «Por confirmar · Swayp no
  entregó»** y entra otra vez a las llamadas, normalmente para salir por
  Aliclik. «No entregó» es: Devolución (8), Devolución confirmada (9) o con cobro
  (12) —en provincia Swayp deja la guía en 8 y no la pasa a 9—, la caja ya
  escaneada de vuelta, o la guía anulada. Una novedad abierta (6) **no** es un
  fallo: Swayp todavía la resuelve.
- **Vuelven todos los motivos**, también el rechazo en la puerta (novedades 15 y
  16) y las fallas de Swayp (18 falta inventario, 20 bodega no despachó, 21 sin
  cobertura), con su motivo a la vista: «Rechazó a Swayp en la puerta» y «Falla
  de Swayp, no de la clienta». Llamar cuesta poco; lo caro es el envío. Si la
  caja volvió y su inventario no está conciliado, arrastra además
  `devolucion_pendiente_inventario`.
- **No pasa por Gestión Reproprovincia** ni por el agente de voz de recuperación
  (§11.8): esa cola toma solo «En gestión Reproprovincia», y este pedido está en
  Por confirmar. Sí entra a las llamadas de confirmación.
- **Deja de mandar** en cuanto pasa algo después: otra salida viva o entregada
  (la guía nueva toma el pedido), la anulación en Shopify, o una confirmación
  (`confirmed`) posterior al envío, que lo pasa a **Preparación · Por generar
  rótulo** para la salida nueva.
- **La guía Swayp en Devolución no frena la guía Aliclik.** La regla «fuera de
  Lima no hay otra salida viva» pide anular la anterior, pero una guía Swayp en
  Devolución no se puede anular (Swayp solo cancela en Generada) ni se va a
  entregar. Crear o vincular una guía Aliclik la ignora
  (`swaypGuiaDeVuelta`, lib/swayp-desde-confirmacion.ts). Riesgo aceptado: si
  Swayp devolviera esa guía a Reparto con la Aliclik ya emitida, habría dos
  salidas vivas y el Master lo avisa (§4).
- **Registro**: Master de Pedidos → Por confirmar → «Swayp desde Por confirmar»
  (`/dashboard/pedidos/swayp-desde-confirmar`). Cada envío con su guía, el
  estado y la novedad de Swayp, el resultado (en camino, entregado, volvió a Por
  confirmar, salió por otra vía, anulado en Shopify), el motivo y la salida que
  vino después. Arriba, enviados, entregados y la tasa de entrega sobre los ya
  resueltos.

Contexto medido al decidirlo (guías Swayp desde el 15-09-2026): de 11 guías
Swayp directas a provincia, 0 entregadas; en Lima, 47 de 119. De las 157 que
terminaron en devolución, el 21 % fue rechazo en la puerta y el 12 % falla de
Swayp. El registro existe para medir si, sin confirmar, Swayp entrega lo
suficiente.

La regla vive en `lib/swayp-desde-confirmacion.ts` y la aplica
`resolveMacroStage` antes del estado terminal y de Reproprovincia
(`MOM_RESOLUTION_VERSION` sube a `mom-v1.24`).

## 12. Agencia: Shalom y Olva

### Shalom

- Adelanto mínimo: **S/20** validado antes de generar rótulo. Se mide con el
  dinero validado del pedido —el `adelanto` más sus `diferencia`s—, no con la
  fila que lo trajo; un `total` validado siempre alcanza. Es la misma cuenta
  que el candado de Olva y el KPI «Adelanto de Agencia», y de ella cuelgan
  `payment_state`, el paso a Preparación y la confirmación expresa (§6.1).
  Con el mínimo validado, un comprobante en revisión deja el pedido en
  `diferencia_cargada`, que también pasa a Preparación: lo que falta es saldo,
  y el saldo lo exige la clave, no la confirmación. Era S/30 hasta el
  08-09-2026; se bajó a lo que la operación ya hacía —de 78 adelantos de S/20
  cargados, 76 se validaron— porque con el mínimo en 30 esos pedidos quedaban
  con «Adelanto cargado» sobre plata ya aceptada y, en Agencia, no salían de
  confirmación (#KP133181). El número vive en UN sitio, `lib/adelanto-minimo.ts`,
  y de él se derivan las comprobaciones y los textos: si vuelve a moverse, se
  mueve ahí. La clave de recojo NO depende de él —exige el total cubierto—.
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
- **Aviso al cliente cuando la guía sale en tránsito** (migración 0166). En el
  instante en que el rastreo de Shalom registra `en_transito` —el mismo
  `courier_status` que ya se escribe en la línea de tiempo— Kapta le manda a la
  clienta la plantilla aprobada (`guias_shalom`, o `guias_shalom_imagen` con el
  ticket de Shalom en cabecera) con guía, código, producto, agencia de recojo y
  el resumen de pago: total, **adelanto validado** y saldo. Se vio en #KP133540:
  el tránsito se registró el 11/09 a las 11:46 y el saldo lo cobró una asesora
  a mano el 15/09; con esto, el mensaje habría salido a las 11:46.
  - **Una sola vez por guía.** El tránsito se ENCOLA cuando ocurre y se ENVÍA
    aparte, con reintentos: el envío puede fallar por Meta o por Shalom y esa
    transición no se repite. Una fila por guía en `shalom_transit_notifications`
    es la garantía; un envío que Meta aceptó cierra la fila.
  - **El adelanto que se le dice es lo validado**, no lo cargado. Un comprobante
    en revisión todavía no es dinero, y decirle que ya cuenta es prometer una
    clave que no se va a liberar.
  - **Los importes van al parámetro sin «S/».** Las plantillas aprobadas ya lo
    escriben —«Monto total del pedido: S/ {{6}}»—, así que mandar «S/ 89.10»
    imprimía «S/ S/ 89.10». Kapta pone el dato, la plantilla la presentación.
    El texto libre que escribe Kapta —la respuesta al botón «Link de pago»— sí
    lo lleva, porque ahí no hay plantilla que lo ponga.
  - **El saldo del «Link de pago» se recalcula al pulsar**, no se lee del aviso:
    entre el aviso y el botón puede haber pagado y alguien haberlo validado, y
    cobrarle el saldo viejo sería cobrar dos veces.
  - **El ticket PDF de Shalom se manda al contestar, aunque ya haya ido en la
    cabecera del aviso** (0167). Si la plantilla lleva cabecera de documento,
    viaja ahí; y se **reenvía igual** con la respuesta, porque encima de un
    mensaje de quince líneas el adjunto queda arriba del todo y pasa
    desapercibido justo cuando la clienta baja a los botones. Se comprobó en el
    chat real. **Se repite con CADA botón, no solo con el primero**: quien pulsa
    «Transferencia» después de «Yape» está mirando esa segunda respuesta, y el
    ticket que llegó con la primera ya quedó fuera de pantalla — es el mismo
    problema que resolvió sacarlo de la cabecera, así que la misma respuesta.
    Cuesta poco: el PDF sale de la caché de Storage, sin otra llamada a Shalom.
    El sello `ticket_sent_at` guarda el último envío, no una reja. El botón abre
    la ventana de 24 h, así que el documento sale como mensaje normal: sin
    plantilla que aprobar en Meta y sin número escrito a mano que pueda
    desalinearse de las cuentas de cobro. Nunca puede tumbar el texto — lo que
    la clienta necesita para pagar son las cuentas; el ticket es el respaldo.
    Una guía sin `ose_id` (llegó por el Excel) no tiene ticket que mandar y se
    anota el motivo.
  - **La respuesta a cada botón empieza por el saldo**: `💵 Saldo pendiente:
    S/ 119.00` y debajo la cuenta. El importe ya iba en el aviso, pero la
    clienta pulsa el botón horas después, con ese mensaje fuera de pantalla: la
    cifra tiene que estar pegada a la cuenta a la que va a pagar, no quince
    líneas más arriba. Se recalcula al pulsar, igual que el «Link de pago». Sin
    saldo conocido no se inventa ninguna cifra y la respuesta sale como antes.
  - **A quien ya no debe nada no se le enseña ninguna cuenta.** Si al pulsar el
    saldo recalculado es cero —pagó entre el aviso y el botón y alguien lo
    validó—, se contesta que el pedido está pagado y que solo tiene que
    recogerlo. Darle el número de Yape ahí es invitarla a pagar dos veces, y esa
    devolución la paga la operación.
  - Si la plantilla trae el Yape **fijo en el cuerpo** en vez de como variable
    —la variante con el ticket en PDF—, el token `yape` sobra y hay que quitarlo
    del orden configurado: un parámetro de más y Meta rechaza el envío. Y el
    número escrito a mano en una plantilla es justo lo que no puede desalinearse
    de las cuentas de cobro: si se puede, va como variable.
  - **Hay DOS avisos, y el segundo es el que cobra de verdad** (0169). El de
    tránsito dice «va en camino, llega en 2 a 5 días hábiles». El de llegada
    dice «ya está en tu agencia, recógelo cuanto antes». Son momentos distintos
    y textos distintos, y confundirlos es mandarle a esperar a quien ya tiene el
    paquete esperándola a ella. **Los ocho parámetros son los mismos**: cambia
    el texto, no los datos.
    - **Tope de envío por tienda** (0194, 28-09-2026): máximo por día —en 24 h
      móviles, que es como lo mide WhatsApp— y máximo por hora, contando los
      avisos de Shalom y Olva, tránsito y llegada, juntos. Nace en **30/día y
      8/hora** y se sube desde Ajustes a medida que el número gane calidad.
      - **Por qué.** Ese día WhatsApp bloqueó el 600, desde el que salían estos
        avisos: venía mandando 50-75 plantillas al día a clientas que nunca le
        habían escrito. El número que lo reemplace es nuevo, y un número nuevo
        tiene que empezar despacio.
      - **Al llegar al tope el aviso no se pierde**: se queda en la cola sin
        tocar y sale en la siguiente pasada con cupo.
      - **Una tienda topada no le quita el turno a otra.** Cada pasada coge
        los pendientes más antiguos de todas las tiendas; los de una tienda
        topada no pueden salir, y si ocupaban esos puestos, la siguiente pasada
        volvía a cogerlos a ellos. El 29-09-2026 Kenku amaneció con sus 30
        gastados y 40 esperando, y Aurela —con 7 de 30— no mandó nada en toda
        la mañana. Ahora primero se mira qué tiendas tienen cupo y la cola se
        pide solo de ésas.
      - **Si no se puede contar lo ya enviado, no se manda.** Mandar a ciegas
        con un número nuevo es justo lo que el tope existe para evitar.
      - **No cuenta** las respuestas a lo que escribe la clienta (botones,
        acuses, la clave al validar): van en la ventana que ella abrió y cortarlas
        sería dejarla hablando sola. Tampoco los carritos, el winback y demás,
        que salen por otro número (el 981) y se dejaron fuera a propósito.
      - Consecuencia asumida: si entran más avisos de los que caben, la cola
        crece y los últimos salen con retraso — un «va en camino» puede llegar
        cuando el paquete ya está en la agencia. Es el precio de no quemar el
        número; se corrige subiendo el tope, no quitándolo.
    - **Los dos son avisos de COBRO, y no salen a quien ya no debe nada ni a un
      pedido cerrado** (anulado, entregado, devuelto). Se decide **al enviar**,
      no al encolar: entre una cosa y otra la clienta puede haber pagado. La
      fila queda `skipped` con el motivo. #KP135533: a Alvina se le mandó «ya
      llegó a tu agencia» con saldo S/ 0.00 y los tres botones de pago, un día
      después de pagar todo y con el pedido ya marcado Entregado. Pedirle
      dinero a quien ya pagó es la forma más rápida de que deje de creerse los
      mensajes que sí importan.
      - Consecuencia asumida: quien pagó entero antes de que el paquete llegue
        no recibe el aviso de llegada. Ya tiene su clave, y el mensaje de la
        clave le dijo «cuando llegue, preséntala con tu DNI». Un «ya llegó» para
        pagados necesitaría su propia plantilla, sin saldo ni botones de cobro.
    - **El aviso de llegada NO lleva fecha límite**, y es una decisión, no un
      olvido: «puedes recogerlo hasta el 16 de octubre» es un permiso a 28 días
      vista, y lo que provoca es dejarlo para después. Urge sin fecha y sin
      amenaza — «recógelo lo antes posible» y, sobre todo, «paga ahora y al
      llegar solo retiras», que es urgencia que le sirve A ELLA: con el cobro
      validado, la clave está lista cuando llegue al mostrador. El token
      `vence` existe en el código por si algún día hace falta (un recordatorio
      cerca del plazo), pero no entra en el orden por omisión.
    - **Una fila por guía y por tipo.** La unique pasó de `shipment_id` a
      `(shipment_id, kind)`: una misma guía recibe el de tránsito y, días
      después, el de llegada — pero ninguno de los dos dos veces.
    - **Interruptores separados, número compartido.** Encender uno no enciende
      el otro, porque cada plantilla se aprueba aparte en Meta. El número, el
      horario y las cuentas de cobro son de la tienda y valen para los dos.
    - Por qué importa: al 18-09-2026 había **213 guías esperando en el mostrador
      con saldo** (173 de Kenku y 40 de Aurela, ~S/ 34.000) a las que nunca se
      les escribió, porque llegaron antes de que esto existiera o su tránsito
      ocurrió con el aviso apagado. Ese es el hueco que cierra el segundo aviso.
  - **La clave de recojo nunca va en el mensaje.** Guía, código y agencia sin la
    clave no abren nada; la clave se entrega desde la salida, con el cobro
    validado y con auditoría. Esta regla no cambia.
  - Sale dentro del horario configurado de la tienda y por el número por el que
    la clienta escribió (su lead), o por el de la tienda; nace **apagado** y se
    enciende en Ajustes. Encender el aviso no dispara los avisos de guías que ya
    estaban en tránsito: solo entra lo que cambia desde entonces.
  - **Los tres botones los contesta Kapta**, no el bot: «Pagar con Yape» con el
    saldo y la cuenta Yape principal en una línea (`YAPE GRUPO GF SAC 930 555 309`),
    «Transferencia Depósito» con todas las cuentas activas, y «Link de pago» con
    el texto configurado (`{saldo}`, `{pedido}`, `{yape}`) o, sin configurar, con
    el Yape. Las cuentas viven en **Ajustes → Cuentas de cobro que ve el
    cliente** (`store_payment_methods`), una lista por tienda: **un solo sitio
    donde cambiarlas**. No son las cuentas contra las que se verifica un
    comprobante (`store_collection_accounts`); conviene que el Yape principal
    sea una de ellas, o el pago quedará en revisión.
  - **«Link de pago» puede cobrar de verdad, por Flow.cl** (0168). Con el
    interruptor encendido y la cuenta configurada, ese botón crea una orden de
    cobro **por el saldo de ese momento** y manda el link; el pago vuelve por el
    webhook de la 0160/0161 y entra como comprobante `diferencia`. Reglas que
    son de dinero, no de estilo:
    - **Un cobro confirmado por la pasarela entra YA VALIDADO**, y es la única
      excepción a que todo comprobante pase por revisión. Un Yape es la foto de
      una pantalla: puede estar editada, ser de otro pedido o de otro día, y por
      eso alguien la mira. Un cobro de Flow no es una foto — es la pasarela
      diciendo, con la respuesta firmada de `payment/getStatus`, que el dinero
      entró en la cuenta. No hay nada que revisar, y dejarlo pendiente tiene un
      costo: el saldo se calcula solo con lo validado, así que la clienta
      seguiría viendo una deuda que ya pagó y la clave de recojo esperaría a que
      una persona hiciera clic. `validated_by` queda en **NULL**: no lo validó
      nadie, lo validó la pasarela, y la línea de tiempo lo dice.
    - **Nunca dos cobros vivos por el mismo saldo.** Si ya hay un link vivo por
      el mismo importe se reenvía ese; solo un importe distinto justifica otro,
      y el anterior se deja de ofrecer. Pulsar el botón dos veces no puede
      acabar en dos órdenes cobrables.
    - **Los otros dos botones no crean cobros.** Emitir una orden es un efecto,
      y no se dispara por pulsar «Yape».
    - **La fila se escribe antes de llamar a Flow**, y `payment/create` no se
      reintenta: un reintento a ciegas deja dos links vivos y la clienta puede
      pagar los dos.
    - **Un link vivo cobra el importe con el que nació.** Si paga parte por Yape
      el siguiente botón crea uno nuevo por lo que falta, pero el viejo sigue en
      su chat hasta que caduca. Por eso caduca: 48 h por omisión.
    - **Si la pasarela falla, la clienta recibe el Yape igual.** Que Flow esté
      caído no puede dejarla sin forma de pagar; queda la anomalía.
    - Flow exige un email del pagador y **el 95 % de los pedidos no trae uno**
      (340 de 7.585 en 30 días): se usa el del cliente si existe y, si no, el
      buzón de la tienda configurado en Ajustes. Sin ninguno de los dos, no hay
      cobro que crear y el botón contesta como antes.
  - Solo reacciona a un **botón pulsado**, nunca a texto libre que mencione el
    medio: un «ya te hice el yape» sigue con el bot y la asesora, como siempre.
    Cada botón se contesta una sola vez aunque Kapso reintente el webhook.
  - **Única excepción: un «ok» pelado.** No es texto que interpretar, es un
    acuse de recibo: no pregunta nada ni aporta dato nuevo, y el bot de ventas
    no tiene nada que hacer con él. Se vio en producción el 18-09-2026 — una
    clienta contestó «Ok» al aviso y recibió «ya le paso tu consulta a una
    asesora», una derivación por nada; otra contestó «ok» y no recibió nada.
    A esos se les repite **el saldo y el Yape**, con dos rejas que es lo que lo
    hace inofensivo: tiene que haber un aviso enviado a ese celular en las
    **últimas 48 h**, y no habérsele contestado ya —ni por botón ni por otro
    «ok»— desde ese aviso. Repetirle el número a cada «gracias» es acoso.
    La lista de acuses es **cerrada**, igual que los rótulos de los botones:
    «ok pero me llegó mal el producto» no está en ella y va a la asesora.
    - **Esa lista y la del router del bot tienen que encajar.** El router del
      workflow del 600 calla ante sus «triviales» y Kapta contesta ante sus
      «acuses». Una frase trivial para el router y no para Kapta deja a la
      clienta **sin ninguna respuesta**; al revés, recibe **dos**. Por eso se
      comparan palabra a palabra con la misma mecánica y las dos listas son
      **idénticas**. Un subconjunto no basta: una palabra que el router calla y
      Kapta no reconoce deja a la clienta sin respuesta de nadie. Las únicas
      diferencias deliberadas son `NUNCA_ACK` y los mensajes de puros dígitos.
    - **Un mensaje de solo números no es un acuse.** Lo más probable es que sea
      el número de operación de un Yape recién hecho — un dato, no un cierre.
      Kapta calla porque no es suyo; el bot tiene que llevarlo a una persona.
    - **«no» no es un acuse en ninguna de las dos.** Después de pedir un saldo,
      un «no» o un «no gracias» es un rechazo —abre devolución (§13)—, no un
      recordatorio del Yape. Los dos callan y va a la asesora.
  - **El comprobante que llega por ese número se registra solo**, con dos
    puertas que evitan adivinar de qué pedido es. Antes moría en el chat: el
    bot contestaba «tu pago pasa a revisión» y en Kapta no había nada. Medido
    en #KP134340 el 20-09-2026: S/ 237 pagados y cero rastro.
    - **Puerta 1, el monto.** El importe leído coincide exacto con el saldo
      pendiente de un candidato, o con su total (paga todo de golpe ignorando
      el adelanto).
    - **Puerta 2, la guía escrita.** Nombró la guía o el código de Shalom junto
      a la foto. Vale aunque el monto no cuadre, y **manda sobre el monto**:
      nombrar la guía es decir de qué pedido habla.
    - **Una puerta basta, pero tiene que señalar a UN candidato.** Dos
      empatados es no saber, y no saber se resuelve con una persona. Registrar
      la plata en el pedido equivocado le da la clave a quien no pagó y se la
      niega a quien sí.
    - **Un pago parcial no pasa** —debe S/ 237 y manda S/ 200— y es el caso más
      frecuente de los que caen a mano. Es deliberado.
    - **Entra sin validar**, como todo comprobante que no miró una persona. Un
      error automático puede ensuciar la cola de revisión; no puede soltar un
      paquete sin cobrar.
    - Los candidatos se buscan **por celular**, no por el pedido del último
      aviso: quedarse con el último sería justo la adivinanza que las puertas
      existen para evitar.
    - Lo que no pasa **queda como anomalía con su motivo** (`inbound_voucher`).
      El silencio es lo único inaceptable: la clienta ya pagó.
    - **El comprobante repetido del MISMO pedido no avisa a nadie.** Rastro y
      silencio: la clienta mandó su Yape dos veces o el webhook reentregó, y ya
      está registrado donde tiene que estar. A Esmeralda (#KP134470,
      21-09-2026) le llegó su clave a las 09:52 y a las 09:51 se había
      levantado una alerta diciendo «llegó un pago y no se sabe de qué pedido
      es», que además escaló dos veces. Un aviso que miente se deja de leer.
      - **Repetido en OTRO pedido sí avisa**, con el pedido con el que choca
        escrito por su nombre: es el mismo Yape cobrando dos pedidos, que es
        justo lo que la deduplicación existe para cazar.
    - **La lectura se guarda con la MISMA forma que la carga a mano**
      (`voucherReading`, en `lib/voucher-inspect.ts`), y esa forma es un
      contrato: el drawer relee `vision.extracted.*` para decir a qué cuenta
      llegó el dinero. La ingesta nació escribiendo un objeto plano propio y el
      resultado fue que **todos** sus comprobantes mostraban «La cuenta
      receptora no pudo leerse» teniendo el nombre correcto guardado dos llaves
      más arriba (#KP134730, 20-09-2026). Un control de dinero apagado en
      silencio, justo en la puerta donde nadie mira la imagen al recibirla. De
      dónde vino el mensaje —número, `message_id`, puerta, saldo esperado— va
      **fuera** de `extracted`, que es solo lo que el lector dijo de la imagen.
    - **Interruptor propio y apagado de nacimiento** (0171), aparte del del
      aviso: una tienda puede querer avisar sin querer que se le registren
      pagos solos. Es el único sitio del Master donde una fila de dinero la
      escribe algo que no es una persona mirando la imagen, y eso merece que se
      encienda a mano, tienda por tienda.
    - **Cada comprobante levanta una alerta con DUEÑO y reloj** (0172), no una
      fila en una bandeja que alguien mire cuando se acuerde. Dos tipos:
      `registrado` —entró solo, falta validarlo para liberar la clave— y
      `sin_atribuir` —llegó plata y no se supo de qué pedido es—.
      - **La escalera se configura en Ajustes**, en orden y con minutos por
        escalón. Escribir los nombres en el código costaría un despliegue cada
        vez que alguien cambie de puesto.
      - **La escalera SUMA, no traspasa** (22-09-2026). Escalar amplía quién ve
        la alerta; no se la quita a nadie. A Gerardo le queda delante hasta que
        se resuelva, y a sus minutos le aparece **además** a Yohalis, y después
        a Frank: llegado ese punto la tienen los tres a la vez. Antes cambiaba
        de dueño y **desaparecía** de la pantalla del anterior, que es dar por
        hecho que ya no va a atenderla —falso, suele estar a punto— y ocultarle
        el final de un trabajo que empezó él.
        - **Sigue habiendo un responsable de turno**, y la tarjeta lo dice: a
          quien la mira sin ser suya le sale «Le toca ahora a Yohalis», en gris
          y no en ámbar. Es lo que evita que dos la atiendan a la vez sin
          saberlo.
        - **Las propias van primero** en el pop-up. Con tres personas mirando la
          misma cola, el trabajo de uno no puede quedar debajo del que solo
          está mirando.
        - **Quien no la ha recibido todavía NO la ve.** Si no, los tres verían
          todo desde el minuto cero y la escalera no serviría de nada.
      - **No mira si está conectado**, a diferencia de la alerta de asesoras:
        ahí compiten por atender primero, aquí hay un responsable. La oferta
        aguanta sus minutos con el navegador cerrado; si saltara al
        desconectarse, todo acabaría siempre en el último escalón.
      - **El último escalón no escala.** Alguien tiene que ser el final; pasar
        de largo dejaría la alerta sin dueño, que es peor que dejarla con quien
        no la quiere.
      - **Sin escalera configurada la alerta se crea igual**, sin dueño.
        Perderla porque nadie tocó Ajustes sería el peor de los dos errores.
      - **Las alertas se cierran con el HECHO, no con un clic.** Cuando el pago
        se valida o se rechaza, o cuando alguien sube el comprobante a mano, la
        alerta se cierra sola: el sistema ya sabe que se atendió, y pedir
        además una confirmación es el clic que se deja de dar a la semana — y
        entonces la cola se llena de trabajo ya hecho que figura pendiente. Lo
        único que se cierra a mano es **descartar**, con su motivo, para lo que
        nunca se va a resolver solo (una foto que la visión confundió).
        - **Y el hecho se comprueba AL LEER, no solo al escribir.** El cierre
          dentro de `validatePayment` es un empujón al final de la acción, y un
          empujón se puede perder: si algo entre medias falla, el pago queda
          validado —eso ya está escrito— y la alerta se queda abierta para
          siempre. Pasó con #KP134730 el 20-09-2026: validado a las 22:42, su
          alerta seguía en la cola cinco horas después pidiendo trabajo hecho.
          Así que al listar la cola se retiran primero las alertas cuyo pago ya
          tiene decisión (`sweepResolvedAlerts`), y el empujón al validar pasa a
          ser una optimización en vez de la única vía. Se barre **antes** de
          escalar: al revés, una alerta ya resuelta podría subir a otra persona
          justo antes de retirarse.
        - **Y la `sin_atribuir` se retira cuando ese CELULAR ya no debe nada**
          (`sweepUnattributedAlerts`): lo que pedía —que alguien averigüe de
          qué pedido es y lo registre— ya está hecho. Cuenta lo **cargado**, no
          solo lo validado, porque validar es el otro trabajo y tiene su propia
          alerta. Si de ese celular no consta **ningún** pedido, se queda: ése
          es el caso en que de verdad no se sabe quién pagó, que es para lo que
          la alerta existe.
      - **El título no afirma lo que no consta.** `sin_atribuir` es el cajón de
        todo lo que no se pudo registrar —la imagen que no se pudo bajar, el
        pago parcial, el Yape ya usado en otro pedido—, así que el pop-up dice
        «Llegó un comprobante y no se pudo registrar» y dentro, en el detalle,
        el motivo exacto. Decía «no se sabe de qué pedido es» sobre un
        comprobante ya registrado y con la clave enviada. Sin pedido, lo que
        identifica es el **celular**, y va delante: con él se busca el chat.
      - **«Ir a validar» lleva al DRAWER del pedido**, con la sección de Cobro
        delante (`/dashboard/pedidos?abrir=<id>&ir=pagos`), no a la bandeja de
        revisión. Dos motivos: la bandeja valida a secas —el botón que además
        manda la clave vive en el drawer— y llevar allí obligaba a buscar a
        mano el pedido que el sistema ya sabía cuál era.
      - **Al validar el pago que cierra el pedido, la clave sale sola** (0173),
        en el mismo clic, y ese envío **es** el registro de la entrega.
        - **Por qué.** Medido el 21-09-2026: 786 pedidos pagados con clave
          registrada, **770** con la clave ya consultada por alguien y **3**
          con la entrega registrada. La clave se entrega —si no, habría
          cientos de reclamos— pero el segundo clic de «registrar que la
          entregué» no lo da nadie, al 0,4 %. «Clave enviada al cliente» era
          ficción, y «¿a esta clienta ya le dieron su clave?» no se podía
          responder desde Kapta.
        - **El listón sube respecto a `canRevealPickupKey`.** Esa regla abre la
          clave con los comprobantes CARGADOS, y está bien: del otro lado hay
          una persona que mira la imagen antes de dictarla. Para que salga
          sola no basta — lo **validado** tiene que cubrir el pedido. Un
          comprobante recién llegado por WhatsApp no manda ninguna clave.
        - **Lo demás se comprueba con la misma función de siempre**, otra vez
          en el servidor y con los datos frescos, después de validar: clave
          registrada, pedido abierto, ningún comprobante observado. El envío
          automático no puede soltar un paquete que la pantalla no soltaría.
        - **Pagado entero NO espera a que el paquete llegue** (decisión del
          24-09-2026). Esperar a la agencia protegía de soltar un paquete sin
          cobrar; con lo **validado** cubriendo el total ese riesgo ya no
          existe, y retener la clave solo tenía costes. #KP135533: Alvina pagó
          los S/ 198 que faltaban con el paquete en tránsito, se validó, y la
          clave no salió porque llegaba al día siguiente — hubo que consultarla
          dos veces como excepción y dictarla a mano. Además es el momento
          bueno: al validar, la clienta acaba de escribir y la ventana de 24 h
          está abierta; cuando el paquete llega suele estar cerrada.
          - Con el paquete todavía en camino, el mensaje **no la manda a la
            agencia**: *«Tu pedido va en camino a la agencia Shalom de Motupe.
            Cuando llegue, preséntala con tu DNI para recogerlo.»*
          - Solo levanta la espera lo **validado**. Con comprobantes cargados
            sin validar, el paquete en tránsito sigue bloqueando la clave, como
            antes. Vale igual para la pantalla y para el envío automático: una
            sola regla, en `canRevealPickupKey`.
        - **El botón lo dice antes de pulsarlo**: cambia a «Validar y enviar la
          clave» solo en el comprobante que de verdad la libera, y enseña el
          mensaje exacto que va a salir con la clave **tapada** —al navegador
          no viaja nunca—. Validar desde la bandeja de revisión no habla con
          nadie.
        - **Fuera de las 24 h no se manda nada y se dice.** WhatsApp solo deja
          texto libre dentro de esa ventana y no hay plantilla con la clave
          dentro. Sin constancia de que la clienta escribiera, la ventana se da
          por cerrada: dar por entregada una clave que nunca salió es peor que
          no enviarla.
        - **Interruptor por tienda, apagado de nacimiento.** Manda la llave del
          paquete sin que nadie vuelva a mirar después del clic.
      - **No hay «es mía» ni «no es mía».** Se copiaron del pop-up de asesoras,
        donde varias compiten por un lead. Aquí la alerta se ofrece a UNA
        persona a la vez, así que no hay con quién chocar — y reclamarla solo
        habría servido para **parar el reloj**, que es justo la red de
        seguridad que no se puede desactivar.
  - Todo queda en la línea de tiempo del pedido (`whatsapp_template`) y en las
    tablas de la cola y de respuestas, con el motivo cuando no salió.
- Seguimiento comienza desde la constancia del adelanto y se intensifica cuando
  el paquete llega a destino.
- Plazo: 28 días desde que está disponible en agencia destino.
- Alertas: 7, 3 y 1 día antes del vencimiento.
- Responsable de seguimiento, pago, recojo y retorno: Gerardo.
- Si Shalom reporta `Recogido` sin pago completo: conservar el hecho logístico,
  mantener el caso abierto y generar alerta financiera crítica. **Salvo cuando
  no pudo ser la clienta** (03-10-2026): ver «El "entregado" que es el retorno».

#### El «entregado» que es el retorno (03-10-2026)

Shalom no tiene un hito de retorno. Cuando saca el paquete de la agencia de
destino para devolverlo —con una guía nueva y la etiqueta «CAMBIO DE DESTINO»
rumbo a Lima—, cierra la guía original con fecha en `entregado`, y el rastreo lo
leía como el recojo de la clienta. El pedido caía en «Por cerrar · Recogido sin
pago completo», la alerta crítica de cobro, por un paquete que venía de vuelta.

- **El caso.** La caja de #KP128064 llegó al almacén con esa etiqueta y el Master
  la tenía como recogida. Medido sobre los «recogido» de Shalom de 75 días:
  **48** salieron de la agencia sin que la clave se revelara ni se enviara
  nunca, sin el saldo pagado y tras **15 a 41 días** en ella, en tandas de minuto
  a minuto —el 22/09 a las 15:25, 15:26 y 15:27, por ejemplo—. Sin clave no se
  recoge en el mostrador: eran retornos. Los 10 recojos reales con saldo
  pendiente salieron a los **1-7 días**, y en 9 de ellos alguien había revelado
  la clave.
- **La regla.** Un `entregado` de Shalom es el **retorno** cuando, a la vez:
  1. el pedido tiene clave registrada y **nunca** se reveló en pantalla
     (`key_view`) ni se envió (`key_shared`, `pickup_key_shares`);
  2. no hay rastro de cobro, con el **mismo** criterio que la alerta
     `recogido_sin_pago_completo` (§6.5);
  3. pasaron **8 días o más** entre la **primera** llegada a la agencia y la
     salida. La primera llegada es la más antigua entre el
     `disponible_para_recojo` de esa guía en la línea de tiempo y el hito
     `destino` de la respuesta.

  Sin clave registrada o sin ninguna fecha de llegada no se adivina: se respeta
  el recojo y la alerta sigue encendida para que una persona lo mire.
- **La llegada que cuenta es la primera (05-10-2026).** Shalom mueve la fecha de
  `destino` mientras el paquete sigue en la agencia: la que trae la respuesta
  del `entregado` no dice desde cuándo está ahí. Contando con ella, la primera
  versión de la regla dejó pasar **7 retornos** el 03/10 y el 05/10 —llevaban
  36 a 40 días en la agencia y Shalom decía menos de 8—, y los dos que sí
  detectó (#KP130021 y #KP129758) los contó en 10 y 8 días cuando llevaban 37 y
  38. La llegada se toma de la línea de tiempo: el `disponible_para_recojo` que
  el rastreo escribió **para esa guía**. Un reenvío con otra guía no hereda los
  días de la primera, y una corrección manual (`status_override`) no trae guía
  ni es la llegada física.
- **Qué se escribe.** La guía queda `anulado` —terminal: el rastreo deja de
  preguntar por ella—, con `pickup_state = retorno_iniciado`, custodia `retorno`
  y `closed_at` en la fecha de salida, y su `courier_status` en la línea de
  tiempo dice por qué y cuántos días estuvo en la agencia. El pedido pasa a
  «Por cerrar · Devolución física pendiente» y la caja se espera en
  **Devoluciones** (§9.4).
- **Falla cerrado.** Si no se pueden leer la clave, el cobro o la llegada, no
  se escribe nada: la guía sigue viva y la pasada siguiente lo reintenta. «No
  pude leer la clave» no es «no hay clave».
- **De la clave solo se pregunta si existe.** Nunca se lee `key_enc`.
- Costo asumido: un recojo real con la clave dictada por fuera de Kapta, sin
  revelarla en pantalla, sin cobro y tras 8 días en la agencia se leería como
  retorno. Esa caja nunca llegaría a Devoluciones y se quedaría «por recibir»:
  ahí se ve.
- Lo leído antes de esta regla —y lo que su primera versión dejó pasar entre el
  03/10 y el 05/10— no se corrige solo: esas guías ya están `entregado` y el
  rastreo no vuelve a preguntar por ellas.

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
7. **El OSE ID que falte se trae solo** (decidido el 04-10-2026). Los avisos de
   tránsito y de llegada llevan el ticket en PDF, y el ticket se baja con el
   OSE ID: sin él el aviso no sale. El 01-10-2026 se crearon a mano 21 guías de
   Kenku sin OSE ID y 25 avisos se perdieron. Ahora el cron de Shalom, antes de
   drenar la cola de avisos, busca las guías manuales de los últimos 30 días
   sin OSE ID en el listado de órdenes de la cuenta (`GET /v1/orders`) y les
   pone el `id` de su orden. Que ese `id` sea el OSE ID **se comprueba en cada
   lectura** con las guías creadas por API, cuyo OSE ID se conoce: si alguna
   aparece con otro `id`, o ninguna aparece, no se escribe nada. Mientras
   tanto, el aviso de una guía manual sin OSE ID **reintenta** en vez de
   fallar.

### Olva

- Regla normal: pago completo.
- Excepción operativa permitida: recojo en agencia con adelanto de S/20.
- Cualquier asesor puede seleccionarla.
- En el drawer se recomienda primero Shalom.
- Plazo: 6 días desde disponibilidad en agencia destino.
- Gerardo también realiza seguimiento.

#### El tracking de Olva y su rastreo (migración 0174, decidido el 20-09-2026)

- **La salida de Olva guarda el tracking que emite Olva** («2552504-26»: el
  número y los dos dígitos del año de emisión), aparte del `guide_code` interno
  del rótulo, que no cambia. Se registra al crear la salida si ya se tiene, o
  después desde **Salidas y guías** («Registrar tracking Olva»), que es el caso
  normal: Olva lo emite en el mostrador y lo manda por el correo «Confirmación
  de Envíos» —donde aparece como `26-2552504`— después de que la caja ya salió
  con su rótulo. Se aceptan las dos escrituras y el número solo con el año
  actual. **El mismo tracking no puede colgar de dos salidas**; corregirlo
  escribe un evento con el valor anterior.
- **Olva no tiene API para clientes.** El rastreo se hace con la misma llamada
  que hace su página pública de seguimiento —`getTrackingInformation` con
  `details=1` en `reports.olvaexpress.pe`, con la apikey fija que la propia
  página publica en su JavaScript— desde el cron `olva-reconcile`, cada media
  hora, sobre las salidas de Olva vivas que tengan tracking. Es lo que la
  operación ya hacía a mano pegando el número en `tracking.olvaexpress.pe`.
  La apikey es de Olva y la pueden rotar sin aviso: vive en el entorno
  (`OLVA_TRACKING_APIKEY`) y, cuando falle, **el cron reporta y no toca
  estados**; el marcado a mano sigue siendo el camino de respaldo.
- **Manda el estado que Olva declara vigente** (`nombre_estado_tracking`), no el
  hito «más avanzado» como en Shalom. Se comprobó en un envío real: asignado a
  un operador el 09/09, confirmado en tienda el 10/09 y asignado de nuevo el
  12/09; una escalera habría dicho «en reparto» durante tres días de mostrador.
- Traducción de los estados conocidos (`lib/olva/tracking.ts`, con las dos
  respuestas reales del 20-09-2026 como prueba):

  | Olva dice | `pickup_state` | `delivery_status` |
  |---|---|---|
  | REGISTRADO, RECEPCION TIENDA, TRACKING EN GUIA, RECEPCION GUIA, PRE VALIJA, EN VALIJA | `registrado_en_agencia` | `pendiente` |
  | DESPACHADO («En camino») | `en_transito` | `en_ruta` |
  | CONFIRMACION EN TIENDA (oficina de destino) | `disponible_para_recojo` | `pendiente` |
  | ASIGNADO (operador salió a entregar) | `en_reparto` | `en_ruta` |
  | ENTREGADO | `entregado` si hubo operador asignado; `recogido` si no | `entregado` |

  Un estado que no esté en la tabla **no se traduce**: se guarda crudo en
  `olva_status`, se anota en la línea de tiempo sin mover el estado del Master y
  el cron lo lista en `estadosSinTraducir` para añadirlo aquí con su
  significado. Están pendientes de capturar los estados de **devolución** y de
  **anulación**; hasta entonces `flg_devolucion` solo se anota en la nota.
- **Llegar a la oficina de destino arranca los 6 días.** `CONFIRMACION EN
  TIENDA` fija `agency_arrived_at` (solo la primera vez) y `agency_expires_at` a
  6 días, con lo que «Próximo a vencer» y las alertas de vencimiento funcionan
  igual que para Shalom. La oficina de destino se toma de la observación de ese
  movimiento («Nombre Oficina : …») si la salida no la tenía.
- Olva fecha los movimientos solo con el día; se anclan al mediodía de Lima
  para que no caigan en la víspera al pasar a UTC.
- **La fecha de vencimiento se conserva al entregar, pero ya no vence.**
  `agency_expires_at` es un hecho y no se borra; «Próximos a vencer», en la tira
  y en el filtro, solo cuenta lo que **sigue esperando en la agencia**
  (disponible, notificado, pendiente de recojo, próximo a vencer). Un pedido
  recogido, entregado o devuelto con fecha puesta no cuenta (#KP134959,
  25-09-2026).
- **Los dos avisos a la clienta, igual que Shalom** (migración 0175). Cuando el
  rastreo pone la guía `en_transito` se encola el aviso de «va en camino», y
  cuando la pone `disponible_para_recojo` el de «ya está en la oficina:
  recógelo y paga el saldo». Es **la misma cola, el mismo envío, el mismo
  horario, el mismo número y los mismos botones de cobro** que los avisos de
  Shalom; una fila por guía y por tipo, con el courier marcado. Lo que es propio
  de Olva: la **plantilla** (Meta aprueba cada texto aparte, y los de Shalom
  nombran a Shalom), sus **variables** —las de Shalom sin `codigo`, y `guia` es
  el tracking «2552504-26», que es lo que la clienta dice en el mostrador—, **sin
  ticket** en cabecera ni detrás del botón, y `vence` a **6 días**. `agencia`
  es la oficina que el rastreo apuntó al llegar. Los interruptores y las
  plantillas de Olva se configuran en Ajustes, aparte de los de Shalom; con el
  aviso apagado la cola cierra la fila como omitida y no manda nada.

#### Cotejar Olva: el tracking sale del portal de clientes (migración 0218, decidido el 02-10-2026)

- **El problema.** Sin tracking no hay rastreo ni avisos, y el tracking había
  que teclearlo a mano: del 22-09 al 02-10-2026 **ninguna de las 28 salidas de
  Olva lo tuvo**. El portal de clientes de Olva (atc.olvaexpress.pe →
  Reportes → Seguimiento de envíos) sí lista todos los envíos de la cuenta de
  la empresa, con destinatario, distrito, dirección y fecha de registro.
- **Qué hace.** «Cotejar Olva» (menú lateral, con permiso de logística) entra
  al portal con la cuenta de la empresa, trae los envíos de los **últimos 7
  días** y pone el tracking en las salidas de Olva **sin tracking** de todas
  las tiendas de la organización. Corre **solo cada dos horas, de 7 a 19 h de
  Lima** (`/api/cron/olva-portal`) y con el botón «Traer de Olva ahora». Desde
  ahí todo sigue como siempre: el rastreo de cada media hora mueve el estado y
  encola los avisos a la clienta.
- **Solo se vincula lo que no admite duda**, porque un tracking en la salida
  equivocada mueve el estado de OTRO pedido y le avisa a OTRA clienta. Tres
  caminos (y un cuarto con el rótulo del correo, más abajo):
  1. **«Doc. externo» = número del pedido** (`KP137860`, con o sin `#`) o el
     código de la salida. Quien registra en Olva puede teclearlo y entonces no
     hay nada que interpretar.
  2. **Misma dirección y todos los nombres.** La dirección de Olva, sin el
     « NRO null» y la referencia entre paréntesis que Olva le añade, es
     idéntica a la de la salida (sin importar mayúsculas, tildes ni
     puntuación); y **todos** los nombres que Kapta tiene de la clienta, al
     menos dos, están en el destinatario de Olva (que suele traer además el
     segundo nombre). La salida se creó entre 21 días antes y 2 días después
     del registro en Olva.
  3. **El DNI de la clienta** (añadido el 02-10-2026). El listado del portal no
     trae el documento del destinatario, pero el portal **sí filtra por él**
     (`dni_consignado`). Para cada salida sin tracking que los dos caminos
     anteriores no resolvieron y que tiene DNI apuntado («DNI y agencia» del
     panel de pagos, `shalom_order_drafts`), se le pregunta al portal por ese
     DNI desde dos días antes de crear la salida. Vale si contesta **un solo
     envío sin tracking**, en la ventana de fechas, con **al menos un nombre
     en común** —por si el portal un día ignorara el filtro—. Resuelve lo que
     la dirección no puede: el envío a la **oficina de Olva** cuando Kapta
     tiene la casa (#AUR177457) y los nombres de relleno («Renan Renan»). Solo
     con el acceso automático; al pegar la respuesta no hay a quién preguntar.

  Y en todos, **pareja única**: un envío con una sola salida posible y esa
  salida pedida por un solo envío. Si no, va a **«Por revisar»** con hasta tres
  candidatos y el motivo, y una persona pulsa «Es este» (la misma acción del
  drawer). Casos reales del 02-10: «Ciro Alegria Claro» contra «CIRO ALEGRIA
  ALVARON», misma casa, y «Ramiro Casapia Guzman» contra «JORGE CASAPIA
  GUZMAN», misma casa: los dos a revisar. Un tracking que ya está en una salida
  no se toca, y si alguien teclea uno mientras se coteja, gana lo tecleado.
- **«Vincular a pedido» para lo que no encontró pareja** (añadido el
  03-10-2026). Cada envío «sin pareja» —y cada uno «por revisar», por si es
  otro pedido— lleva una casilla para escribir el número del pedido. Lo
  decide una persona, así que no hay regla de parecido: si el pedido tiene
  **una** salida de Olva sin tracking, el tracking va ahí; si **no tiene
  ninguna** (pedido «sin asignar courier»), se le crea la salida de Olva con
  el tracking, por el mismo camino que el Master, con fecha de salida de hoy y
  la nota de que el envío ya estaba en Olva; si tiene **otro** tracking o
  **varias** salidas de Olva libres, no se toca y se pide hacerlo en el
  Master. Los permisos, el tracking repetido y el evento en la ficha son los
  de las acciones del Master. Casos del 02-10: #KP136585, #KP137218 y
  #AUR177643 estaban «sin asignar courier»; #KP136660 («Carlos Carlos») y
  #KP137464 («Alfredo Alfredo») tenían salida pero ni DNI ni nombre real.
- **El menú lateral dice cuántos quedan** (añadido el 03-10-2026). Al lado
  de «Cotejar Olva» aparece el número de envíos del último cotejo de cada
  organización que siguen «por revisar» o «sin pareja» y cuyo tracking hoy no
  está en ninguna salida: lo vinculado después a mano ya no cuenta. Sin nada
  pendiente no se pinta nada. Solo lo ve quien ve la entrada (logística).
- **El rótulo que Olva manda por correo** (migración 0223, añadido el
  03-10-2026). Al registrar cada envío, Olva escribe desde
  notificaciones@olva.com.pe («Registro exitoso … - Registro Nro …») con el
  **rótulo en PDF**, y ese rótulo —a diferencia del listado y del rótulo del
  portal— trae **«RUC/DNI» y «TELEFONO/CELULAR» del destinatario**. Un
  escenario de **Make** vigila el buzón (cuenta de Microsoft 365 conectada en
  Make), saca el PDF y lo manda a `/api/webhooks/olva-email` con un secreto
  propio (`OLVA_EMAIL_WEBHOOK_SECRET`). Kapta lo lee y lo guarda en
  `olva_email_labels` (con el texto leído, para corregir el lector sin pedir
  el correo otra vez), y:
  - si su tracking no está en ninguna salida, busca entre las salidas de Olva
    sin tracking de las tiendas de esa cuenta (el RUC de «ENVIA») **una sola**
    con el **mismo teléfono** (los 9 dígitos, con o sin 51) **o el mismo
    DNI**, **al menos un nombre en común** y creada en la ventana de fechas.
    Si la hay, le pone el tracking. Dos —la misma clienta con dos pedidos— no
    se adivinan.
  - si ninguna salida casa pero **un solo pedido abierto** tiene ese teléfono
    (el pedido «sin asignar courier», sin salida de Olva), **no crea la
    salida**: la deja **sugerida** en «Cotejar Olva», con la casilla «Vincular
    a pedido» ya rellena, y lo confirma una persona.
  - el cotejo del portal vuelve a usar los rótulos guardados para lo que siga
    sin resolver, porque la salida puede crearse después del correo.
- **Y cada correo queda a la vista en «Cotejar Olva › Correos de Olva»**
  (migración 0227, añadido el 05-10-2026). La pantalla tiene dos pestañas:
  «Cotejo del portal» (lo de siempre) y «Correos de Olva»
  (`/dashboard/olva?vista=correos`), que lista cada rótulo recibido, del
  último al primero y por día de llegada en Lima: hora, tracking y nº de
  registro (el asunto, si no se leyó), destinatario y dirección, el
  resultado y el pedido. El resultado de cada correo AL LLEGAR se guarda en
  `olva_email_labels.outcome` (`vinculado`, `ya_vinculado`, `sugerido`,
  `ambiguo`, `sin_pareja`, `ilegible`; las filas anteriores se rellenan con
  las frases que ya escribía el webhook), y la pantalla lo cruza con dónde
  está HOY el tracking, como el resto de «Cotejar Olva»:
  - **Vinculado al llegar**: el correo le puso el tracking a su salida. Si
    después se corrigió en el Master, sigue contando y dice dónde está hoy.
  - **Ya tenía tracking**: estaba en una salida antes de llegar el correo; se
    dice quién se adelantó y cuándo (el evento `olva_tracking_linked`: el
    cotejo del portal y por qué camino, otro correo, o una persona a mano).
  - **Vinculado después**: llegó sugerido, ambiguo o sin pareja y hoy el
    tracking está en una salida; dice quién lo puso y qué pasó al llegar.
  - **Sin vincular**: su tracking sigue sin salida. Lleva «Vincular a
    pedido» —la misma acción del cotejo—, rellena con el pedido sugerido si
    lo hay.
  - **Ilegible**: no se leyó el tracking del PDF.

  Las cifras de arriba filtran la lista. Si no llega ningún correo en tres
  días, un aviso pide revisar el escenario de Make. Alcance: los correos
  cuyo RUC de «ENVIA» es de una organización de quien mira, y los que no
  son de ninguna (sin RUC legible o con un RUC que ninguna tienda tiene en
  Ajustes), porque ver que llegaron es lo que explica por qué no
  vincularon; los de un RUC de otra organización no se muestran. Se ven los
  200 más recientes (`lib/olva/email-log.ts`). Si Make vuelve a mandar un
  correo que ya vinculó, sigue figurando como «vinculado al llegar» y no
  pasa a «ya tenía tracking».
- **Un PDF trae un rótulo por envío del registro** (migración 0232, 06-10-2026).
  Un registro de Olva con varios envíos manda un solo correo con un solo PDF
  que trae un rótulo por envío («N° REGISTRO: … (1/4)», «(2/4)»…). Hasta
  entonces se guardaba una fila por PDF y solo se leía el primer rótulo: el
  registro 202600718786 del 05/10 traía cuatro envíos y solo vinculó
  #KP138456; de los primeros 61 correos, 102 de sus 163 rótulos nunca se
  cotejaron. Ahora el PDF se parte en sus rótulos (cada uno empieza en
  «ENVIA:» y termina en su TRACKING), cada rótulo es **una fila y un cotejo
  propio** (`label_index`, la «k» de «(k/n)», y `label_count`; la clave es
  `message_id` + `file_name` + `label_index`) y «Correos de Olva» cuenta
  rótulos —«163 rótulos en 61 correos»— y muestra «Reg. … · rótulo 2/4».
- **El tracking se guarda sin ceros delante.** El portal escribe
  «02649804/26»; la página pública, el correo y todo lo guardado, «2649804-26».
  `parseOlvaTracking` quita los ceros para que el índice único vea el mismo
  envío en las dos formas.
- **Credenciales** en Ajustes de la tienda → «Olva (portal de clientes)»:
  usuario, contraseña (cifrada) y RUC (el portal lo pide en cada consulta).
  Basta con ponerlas en una tienda de la organización; una tienda con **otro**
  RUC queda fuera de esa cuenta.
- **Cloudflare** está delante del portal. Si bloquea el acceso automático, el
  cotejo queda en la bitácora como fallido con ese motivo y la pantalla ofrece
  **«Pegar respuesta»**: la respuesta de `getTrackingsClient` copiada del
  navegador pasa por el mismo cotejo.
- **Bitácora** (`olva_portal_runs`): cada cotejo —automático, botón o pegado—
  guarda cuántos envíos trajo, cuántos vinculó, el detalle de lo que quedó por
  revisar o sin pareja, o el error. La pantalla enseña el último y, de lo
  pendiente, solo lo que hoy sigue sin tracking.

### Pagos

- **Un pedido pagado en el checkout no tiene cobro que gestionar.** Desde que
  entran pedidos con pasarela (`financial_status = 'paid'`), «ya está cobrado»
  tiene dos vías —comprobante Yape o pago web— y **no se suman**: sumarlas sería
  contar dos veces el mismo dinero. Un reembolso deshace el prepago.
- **Solo la pasarela confirmada del checkout nace pagada** (decidido el
  10-09-2026, v1.11). Shopify dice por dónde entró el dinero
  (`payment_gateway`, `lib/payment-gateway.ts`) y solo cuenta la que la
  operación confirmó con nombre y apellido: «Checkout Flow | Tarjeta, Transf.,
  Cuotas débito». Ese pedido se salta la verificación de constancias aunque
  alguien haya subido una captura como comprobante (#KP132708). Todo lo demás
  sigue el conducto regular: **«manual»** —alguien lo marcó como pagado a mano
  en Shopify—, **COD**, una pasarela que nadie confirmó, o ningún dato porque
  el pedido se sincronizó antes de pedírselo a Shopify. **Nada se deduce.**
  Hasta la v1.11, «pagado en Shopify y sin comprobantes» contaba como pagado por
  web; la deducción fallaba en los dos sentidos y se quitó. A los pedidos
  pagados que siguen vivos y no tienen el dato se les pregunta a Shopify por
  tandas desde el cron de sync (`lib/payment-gateway-backfill.ts`); hasta que
  llega su respuesta no son prepago. Costo asumido: los marcados a mano sin
  constancia validada pasan a exigirla.
  De esa regla única cuelga todo lo demás:
  - El panel de cobro colapsa a una constancia: ni pide comprobante ni enseña
    saldo por cargar. Lo que sí sigue haciendo falta en Agencia —DNI y agencia de
    Shalom— no es cobro: son datos de entrega.
  - **La clave de recojo se entrega sin comprobantes.** Exigirlos a quien pagó
    con tarjeta la bloqueaba para siempre: no existe un Yape que cargar, así que
    «falta el adelanto» era cierto de forma permanente y el paquete se quedaba en
    la agencia. Lo que NO se salta: que la clave exista y que el pedido no esté
    cerrado. Que el paquete ya esté en la agencia tampoco se exige desde el
    24-09-2026: pagado por web es pagado entero, la misma regla que para los
    comprobantes validados que cubren el total.
  - La guía sale con **cobro 0** y el rótulo dice **PAGADO · NO COBRAR**, nunca
    «S/ 0»: cero es un importe, y un importe ambiguo se resuelve cobrando.
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
  cuando existen al menos S/20 validados, no solo por haber subido una imagen.
- **Una lectura fallida no es una respuesta.** Si Kapta no consigue leer los
  pagos del pedido, el drawer dice que no pudo leerlos y ofrece reintentar.
  Nunca imprime «Todavía no se ha cargado ningún comprobante» ni «S/ 0.00
  validados»: esas frases afirman algo sobre el dinero del cliente y solo valen
  cuando la consulta respondió. Se vio en #AUR175525 — el comprobante estaba
  registrado y el drawer lo negaba, que es como mandar al equipo a pedir un Yape
  que el cliente ya envió.
- Validadores actuales: Milagros, Mildred, Gabriela, Yohalis y Frankz, según la
  cuenta receptora.
- Hoy existe validación interna por WhatsApp/app bancaria; Kapta debe conservar
  quién cargó y quién validó.
- Al pulsar **Leer y rellenar**, Kapta separa dos identidades del comprobante:
  el pagador o remitente se conserva internamente para trazabilidad y detección
  de duplicados; la interfaz valida la **cuenta receptora**.
- Un comprobante es **la constancia de un pago hecho**, venga de la billetera o
  del banco que venga: Yape, Plin, BCP, Interbank, BBVA o Scotiabank. Lo que
  decide es que se vea una interfaz de pago con la operación concretada, no de
  qué app sea. Preguntar «¿es un Yape?» en vez de «¿es un pago?» tenía dos
  efectos que se refuerzan: la constancia de una transferencia salía «no es
  comprobante» y el pago entraba como `info_incompleta`, y el lector exigía el
  rótulo de Yape —«Nro. de operación»— y devolvía vacío el número que la imagen
  sí mostraba bajo «Código de operación». Lo que NO es comprobante sigue igual
  de acotado: una captura de chat, la foto de un producto o la pantalla para
  ingresar un monto **antes** de pagar.
- El nº de operación se acepta bajo el rótulo de cualquiera de esos bancos, y
  Kapta guarda **con qué rótulo** lo leyó. Sin ese dato, un comprobante que no
  se pudo leer y uno de un banco que no reconocemos son el mismo hueco, y la
  pregunta «¿de qué bancos nos llegan los comprobantes?» no se puede responder.
  Un rótulo nuevo no invalida el número: se registra, para que el banco
  siguiente aparezca en los datos en vez de desaparecer en un vacío silencioso.
- Ampliar los rótulos **no** afloja el guardarraíl que los ancló: el «Código de
  seguridad» de 3 dígitos, el monto y el celular siguen sin poder convertirse en
  nº de operación. Un identificador tan corto leído por OCR nunca es llave
  global (§ deduplicación).
- Un comprobante **no se registra** si la comprobación de duplicidad no llegó a
  ejecutarse. Con esas consultas caídas, «no hay duplicado» quiere decir «no se
  sabe». El nº de operación y la huella del archivo tienen índice único detrás y
  chocarían igual; la tercera señal —mismo monto y misma fecha— no lo tiene, así
  que ahí el silencio se cobra dos veces el mismo Yape.
- La cuenta receptora se comprueba con dos señales independientes y visibles:
  el destinatario y los últimos tres dígitos del celular. Cada señal muestra su
  propio check verde; la cuenta solo queda `verificada` cuando ambas coinciden,
  y entonces se nombra **con cuál** de las cuentas encajó.
- Las cuentas de cobro son **varias y viven en los datos**, una lista por tienda
  (`store_collection_accounts`, migración 0126): la de la empresa —`Grupo GF
  S.A.C.` · `930 555 309`— y las de las dos personas dueñas. Estuvo escrita a
  mano y era una sola, y como el negocio cobra por más de una, cada comprobante
  a la cuenta de una dueña quedaba en `revision_admin` —la etiqueta que dice que
  el dinero se fue a OTRA cuenta—: diecisiete comprobantes en tres semanas,
  ninguno validado nunca, y los pedidos salieron igual. El bloqueo no protegía
  nada; solo enseñaba a no leer la alarma.
- **La captura «Te yapearon» es de nuestra propia cuenta (02-10-2026).** Yape
  titula así la pantalla de quien RECIBIÓ, y la operación la saca de nuestra
  sesión: el receptor somos nosotros aunque no aparezca. El nombre grande y el
  «Número de celular» que muestra son de **quien pagó**, así que no se contrastan
  con las cuentas de cobro. Antes se leían como receptor y el cobro se acusaba
  de desvío: #KP138399, S/ 30 de «Guadalupe Del\*» (···717), operación 15926914.
  **Candado: el aviso de Yape Empresa.** «Te yapearon» lo muestra cualquier
  cuenta que recibió un Yape, también la personal de un cliente que reenvía lo
  que le pagó otra persona. La nuestra es Yape Empresa y su pantalla trae al pie
  «el cobro servicio Yape Empresa…». Con ese aviso la cuenta queda `verificada`
  como «captura de nuestro Yape Empresa»; sin él queda `parcial` —no acusa, puede
  ser la cuenta personal de una dueña— y alguien confirma en nuestro Yape que el
  pago entró antes de validar.
- **La fecha del pago tiene que encajar con el pedido (02-10-2026).** Un pago de
  **más de dos días antes** de que se creara el pedido no lo paga: es un Yape de
  otra venta. El nº de operación y la huella del archivo solo atrapan lo que ya
  está cargado; esto atrapa el Yape viejo que nunca se registró. El margen cubre
  el adelanto que llega antes de que se arme el pedido. No bloquea: el pago entra
  en `revision_admin` con el motivo («el pago es de N días antes de que se creara
  el pedido»), igual que un receptor que no cuadra. Sin fecha leída no se juzga.
- **Una tienda sin cuentas configuradas NO acusa a nadie.** Vacío significa "no
  sabemos contra qué contrastar" y cae en verificación parcial —contraste
  manual—, jamás en `receptor distinto`. Lo contrario convertiría un despiste de
  configuración en una acusación de desvío sobre todos los cobros de la tienda.
- Una cuenta puede declarar **otras formas de escribir su nombre**: la constancia
  del banco pone los apellidos primero donde la billetera los pone al final, y es
  la misma persona. Se declara en la ficha de la cuenta y no aflojando la
  comparación: enseñarle a ignorar el orden la volvería permisiva con cualquiera.
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
- Una lectura puede venir con **el pagador y el receptor cambiados de sitio**, y
  entonces no se juzga tal cual: se corrige antes. La contradicción que lo
  delata es no poder ser las dos puntas del mismo pago — que quien paga sea una
  cuenta de cobro de la tienda **y** el celular del receptor también lo sea. Con
  una sola de las dos no se afirma nada: en un reembolso la tienda sí es quien
  paga, legítimamente. La corrección **se dice en pantalla**, nunca se aplica en
  silencio: esta comprobación decide si el dinero se desvió, y quien valida
  tiene que saber que el nombre que ve salió del otro campo.
- **El mensaje del Yape no es el receptor.** Yape deja que quien paga escriba un
  mensaje, y la captura lo pinta justo debajo del receptor; muchas clientas
  escriben ahí su propio nombre. El lector lo copiaba como destinatario y el
  cobro quedaba acusado de desvío: **#AUR177541** salió «sonia ludeña» —la
  clienta es SONIA IBETH LUDEÑA QUISPE— con el celular ···309 de la empresa. Dos
  defensas:
  - el lector tiene instrucción expresa de no copiar el mensaje en ningún
    nombre;
  - y, como una instrucción puede desobedecerse, al juzgar la cuenta: si el
    celular receptor leído es de una cuenta nuestra **y** el nombre leído es el
    de la clienta del pedido, ese nombre **no cuenta**. La cuenta se juzga por
    el celular y queda en verificación parcial —contraste manual—, **nunca** en
    `verificada`. Exige las dos puntas, como la inversión: el nombre de la
    clienta como receptor **sin** nuestro celular es la forma de un pago que
    ella se hizo a sí misma, y eso sigue saltando.
  - Se reconoce a la clienta con dos palabras o más de su nombre, en cualquier
    orden y sin tildes. El orden no importa aquí porque no se está afirmando
    que el dinero sea nuestro —eso lo sigue diciendo el celular—, solo que ese
    nombre es el de ella. Un nombre de pila suelto no basta.
  - El nombre descartado **se dice en pantalla** con el motivo, igual que la
    inversión. Rige en la carga (decide si entra en `revision_admin`), en la
    bandeja y en el servidor al validar; como se recalcula, los comprobantes ya
    cargados se destraban solos.
- **El final del celular pegado al nombre cuenta como celular.** La app del
  BBVA escribe el contacto como «Grupo gf s •5309», y Plin como «Grupo Gf S ·
  930 555 309 - Yape». Los dígitos tras **un solo punto** se apartan del
  nombre y son el celular —mandan sobre uno leído aparte, porque salen del
  mismo bloque que el receptor—: la misma señal tajante de siempre. Tras una
  máscara (asteriscos o varios puntos, como la cuenta «**** 0012» que pone el
  BCP) se apartan del nombre pero no se juzgan. El lector tiene además
  instrucción de separarlos. Es la misma regla que en los cobros del courier
  (§9.4).
- **La billetera de destino tampoco es parte del nombre.** Plin escribe el
  receptor como «Grupo Gf S - Yape» (#KP136682): « - Yape» dice adónde fue el
  dinero, y leído como nombre acusaba de desvío un cobro a la empresa. Se
  quita antes de comparar. No afloja nada: «Juan Pérez - Yape» sigue siendo
  Juan Pérez. Rige igual en los cobros del courier (§9.4).
- **Una cuenta puede no tener celular: la pasarela Flow** (migración 0198). La
  constancia de Flow dice «Pagado a: Aurela Kenku» —una sola cuenta de Flow para
  las dos marcas— y no enseña ningún celular. Sin darla de alta, **#KP136181**
  quedaba en «cuenta receptora no coincide». Una cuenta sin celular se verifica
  con su nombre entero, porque es la única señal que su constancia puede dar;
  recortado queda en contraste manual, y **un celular leído la desmiente**,
  porque su constancia no muestra ninguno. El celular nulo quiere decir «esta
  cuenta no cobra con celular», no «falta el dato».
- Esta distinción es de seguridad, no de comodidad: una alarma de desvío que
  salta casi siempre por un nombre cortado deja de leerse, y tiene que ser
  creíble el día que el receptor sea de verdad otro.
- **«p. m.» con espacio es de la tarde (04-10-2026).** Yape escribe la hora como
  «02:15 p. m.», y la lectura solo reconocía «p.m.» o «pm»: toda hora de la
  tarde de un Yape se guardaba **doce horas antes** (#KP138402, «02:15», era el
  Yape de las 14:15:08). Ese día catorce comprobantes pendientes estaban así.
  Se acepta también el día de la semana que antepone el BCP («Martes, 29
  Septiembre 2026») y la «hs.» de Prex. Lo ya cargado no se reescribe: el cruce
  con el estado de cuenta lo tiene en cuenta (§16.2).
- La visión corre **una sola vez**, al subir el comprobante, y su lectura queda
  guardada en la fila. Arreglar el lector no mueve lo ya cargado: hay que
  releerlo (`scripts/reprocess-vouchers.ts`). El estado del receptor sí se
  recalcula en cada pantalla a partir del nombre y el celular guardados, así que
  ese sí mejora solo; el `recipient_check` escrito en la fila es únicamente
  rastro de auditoría y **no** es la regla que decide.
- El reproceso se dispara de dos formas que hacen **exactamente lo mismo**: la
  ruta `/api/cron/reprocess-vouchers` (con `CRON_SECRET`, simulacro por defecto,
  `escribir=1` para aplicar) y el script `scripts/reprocess-vouchers.ts` desde
  una máquina con el repo. La regla vive una sola vez, en
  `lib/voucher-reprocess.ts`: dos copias de «qué se rellena» acabarían
  discrepando.
- El reproceso solo **rellena huecos** y nunca pisa un dato que ya tenga valor:
  puede haberlo escrito una persona mirando la imagen, y su lectura manda. Tocar
  `revision_admin` tampoco le corresponde: ahí hay alguien revisando, y moverlo
  por su cuenta le vaciaría la cola sin que nadie haya mirado.
- La captura del comprobante permanece grande y visible durante la revisión y
  puede abrirse a tamaño completo. `Titular/pagador` no es un campo operativo:
  si la visión lo obtiene, se conserva internamente para trazabilidad y
  deduplicación, sin pedirle al asesor que lo complete.
- **La clave se libera cuando el monto cubre el total, no cuando los pagos tienen
  la forma esperada.** Adelanto y diferencia son la convención del flujo COD, no
  el requisito: si un solo comprobante validado ya cubre el pedido, está pagado y
  la clave se entrega. Pasó en #KP128018 —adelanto de S/ 200.00 sobre un pedido
  de S/ 198.00— donde el panel mostraba «Saldo por cargar: S/ 0.00» y encima
  «Completar el pago antes de liberar la clave»: la pantalla se contradecía
  porque la compuerta miraba si existía una fila `diferencia`, no si alcanzaba la
  plata.
  El listón no baja: se suman los comprobantes **vivos** (no rechazados), un
  comprobante sin monto suma cero, y un **posible duplicado sigue bloqueando
  aunque cubra** — un duplicado no es dinero nuevo. Lo mismo vale para el
  indicador de estado: si lo validado cubre el total, es `pago_completo`, y de
  ahí cuelgan la subetapa y el monto que se manda al courier.
- Si el pago es menor al requerido, la clave permanece bloqueada y se alerta al
  asesor.
- Solo Frankz ejecuta reembolsos.
- Un sobrepago puede devolverse después de validación.
- **El adelanto NO se reembolsa cuando el cliente rechaza el saldo.** Decidido
  el 18-09-2026; estuvo meses como «pendiente de decisión formal» y esa
  indefinición impedía decirle nada a la clienta. Cubre la logística ya
  gastada: la guía se pagó, el paquete viajó y el retorno también cuesta.
  - Es **rechazo del saldo**, no cualquier no-entrega. Un paquete que no llega
    por culpa del courier, un producto equivocado o un pedido que la tienda
    cancela no son rechazo: ahí el adelanto se devuelve como siempre.
  - **Se le dice antes, no al final.** Una política que la clienta descubre el
    día que pierde su dinero es una discusión perdida aunque se tenga razón, y
    una devolución de tarjeta reclamada después cuesta más que los S/ 30. Va en
    el aviso de cobro y tiene que estar también donde compra.
  - Lo ejecuta Frankz, como todo reembolso: la regla dice qué se devuelve y qué
    no, no automatiza la caja.

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
- La guía que lleva **pedidos acompañantes** (§32) cobra la suma: su fila se
  cuadra contra el total del principal más el de sus acompañantes vigentes, y
  cerrar la liquidación del principal cierra la de ellos.
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
- Exportar datos (`data.export`, 08-10-2026): descargar en Excel el Master de
  Pedidos (filtrado o la selección) y en CSV los pedidos o el resumen diario.
  Una descarga es la base de clientes entera —nombre, teléfono, distrito y
  monto de ~28.000 pedidos— en un clic, y ninguna vendedora la necesita para
  trabajar: ve en pantalla lo que gestiona. Viene con **owner y admin**; la
  vendedora no la trae y se le concede con el check **Exportar datos** de
  **Equipo** (a un admin también se le puede quitar ahí). Sin el permiso el
  botón no aparece y las rutas (`/api/export`, `/api/export/pedidos`)
  responden 403 sin leer la base.
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

- `Pendientes`: `pendiente_revision`, ordenados del más reciente al más antiguo.
- `Observados`: `posible_duplicado`, `info_incompleta` o `revision_admin`.
- `Validados hoy`: pagos `validado` durante el día calendario de Lima. Cada
  tarjeta dice **quién lo validó** (04-10-2026): la persona —como en el resto
  del panel, por la parte local de su correo—, o, cuando no hubo persona, con
  qué prueba: «el estado de cuenta de Yape» con el movimiento que lo concilió
  (pagador, monto y hora, §16.2) o «la pasarela Flow» (§12). Decía solo
  «Validado el …», y desde que hay validaciones sin persona esa frase no
  distinguía una firma de una conciliación.
- `Observar` exige motivo y mueve el comprobante a `revision_admin`.
- `Rechazar` es una decisión definitiva desde Observados. No borra el pago: sale
  de la cola activa y queda preservado en el expediente y sus eventos.
- `Validar` exige número de operación y bloquea una cuenta receptora
  incompatible con las cuentas de cobro de la tienda (`store_collection_accounts`,
  ya no una sola escrita a mano).

#### Una cuenta receptora que no cuadra tiene que tener salida

El bloqueo no tenía puerta trasera y por tanto atascaba para siempre. **#KP126085
llevaba siete semanas** en la bandeja: el lector puso «Cerdo Gf S.a.c.» por
«Grupo Gf S.a.c.» y eso basta para `mismatch`, aunque el celular receptor leído
—···309— sea exactamente el de la cuenta de la empresa. Lo único que la pantalla
ofrecía era `Rechazar`, que habría sido falso: el dinero llegó.

- **El aviso dice QUÉ señal falló.** Decía «el destinatario o el celular receptor
  no coincide», y ese «o» deja a quien revisa sin saber cuál mirar. Ahora
  distingue los dos casos: celular nuestro con nombre que no encaja —casi siempre
  lectura mala, pero también la forma que tendría un comprobante ajeno con
  nuestro número delante— y celular que no es de ninguna cuenta, que es tajante.
- **Un administrador puede validar dejando escrito por qué.** Queda en su propio
  evento (`payment_recipient_exception`), con el nombre y el celular que se
  leyeron, para poder listar después cuántos cobros se dieron por buenos sin que
  la cuenta cuadrara y quién lo decidió.
- **La excepción no afloja nada más.** Vive DENTRO de `validatePayment`, después
  del nº de operación obligatorio y de la regla de cuatro ojos, así que no
  alcanza a ninguna de las dos. Un camino aparte —escribir el estado a mano con
  `overridePaymentValidation`— dejaba el pago sin validador, sin fecha, sin
  asiento de liquidación y sin la confirmación de agencia: peor que el atasco.
- **La regla NO se afloja por celular.** Lo tentador es dar por buena cualquier
  lectura cuyo celular sea el nuestro, y un nombre ajeno con nuestro celular
  sigue necesitando ojos. La salida es una persona escribiendo el motivo, no una
  regla nueva.
- **Corrección (28-09-2026).** Esta sección citaba **#AUR177034** —celular ···309
  y nombre «Rosa campos Mendoza»— como el comprobante ajeno con nuestro número.
  No lo era: la clienta de ese pedido es ROSA LUZ CAMPOS MENDOZA, y el nombre era
  el mensaje que ella escribió en el Yape (ver «El mensaje del Yape no es el
  receptor» en §12, Pagos). Ese caso se resuelve ya sin excepción; la regla de arriba
  no cambia, porque un nombre que **no** es el de la clienta sigue bloqueando.

Mientras Kapta y el Excel convivan, validar un pago deja el comprobante listo
para continuar y registra actor y fecha, pero **no cambia por sí solo la
macroetapa ni marca el pedido como pagado en Shopify**. Esas automatizaciones se
activan cuando la migración operativa al sistema sea completa.

### 16.2 Validación por el estado de cuenta de Yape

**Lo que una persona hacía mirando la app de Yape lo hace ahora el estado de
cuenta (04-10-2026).** Validar un comprobante pedía a alguien porque el lector
valida una imagen, no un depósito (§9.4, 0158): faltaba la conexión con el
estado de cuenta. El reporte de movimientos que Yape Empresa manda por correo
—«Te compartimos tus movimientos», desde `notificaciones@yape.pe`, un Excel con
cada ingreso— **es** esa conexión. Ese día se cruzó a mano el primero contra la
bandeja: **66 de 87 comprobantes cuadraban sin margen de duda**, y nueve más
solo «casi».

- **El circuito.** Un escenario de Make vigila el buzón (el mismo de los
  rótulos de Olva) y manda el Excel a `/api/webhooks/yape-movements`. Kapta
  guarda cada movimiento **una sola vez** —los reportes se solapan— y cruza la
  bandeja contra ellos.
- **El reporte no trae nº de operación.** Por eso un comprobante y un
  movimiento son el mismo pago solo si coinciden **a la vez**:
  1. **el monto**, al céntimo;
  2. **el minuto**: la constancia imprime la hora al minuto y el reporte al
     segundo. Un Yape directo cae dentro de ese minuto; lo que viene de otra
     app (Plin, BCP, Prex…) trae el reloj de esa app y tiene un minuto de
     holgura a cada lado;
  3. **quién pagó**: en un adelanto, diferencia o pago total, el pagador del
     reporte es **la clienta del pedido** («Benito Cac\*» ↔ Benito Cachique
     Puga; con el nombre completo, dos palabras suyas en cualquier orden). En
     el **cobro del courier** paga el motorizado, así que el nombre no dice
     nada: se exige que **el canal** del reporte sea el de la constancia (un
     Yape sale como Yape directo; Plin, BBVA o Scotiabank como «PLIN - …»; el
     BCP como «BCP - …»);
  4. y que sea **inequívoco**: un solo movimiento encaja con el comprobante y
     **ningún otro pago vivo** —validado o no, de cualquier pedido— encaja con
     ese movimiento.
- **Lo que coincide así se valida solo**, por el **mismo camino** que la firma
  de una persona (`applyPaymentValidation`, `lib/payment-validation.ts`):
  estado `validado`, evento `payment`, cierre de liquidación del cobro del
  courier y su guía a `entregado` (§9.4), confirmación de agencia, alertas y
  Master. Con `validated_by` nulo y fuente `estado_yape` —no lo validó nadie,
  lo validó el estado de cuenta, igual que Flow (§12)—, y el evento lleva el
  movimiento: pagador, canal, monto y hora. Cada conciliación queda en
  `yape_statement_matches`, **única por movimiento y por comprobante**: el
  mismo dinero no paga dos pedidos.
- **Nunca lo valida el cruce, aunque el dinero esté en el reporte:**
  - lo que no está en `pendiente_revision`: lo observado, lo incompleto y lo
    duplicado lo está mirando una persona, y su decisión manda. Por lo mismo,
    si entre la lectura y la escritura alguien lo observó o rechazó, no se
    toca;
  - sin nº de operación (validar lo exige), o con el nº **transcrito a mano**:
    los cuatro ojos piden que lo dé por bueno otra persona y el reporte no
    trae el número para contrastarlo;
  - sin hora en la ficha;
  - con una cuenta receptora que **no cuadra**: esa excepción es de un
    administrador, por escrito (§16.1);
  - un cobro de courier que **no fue a un Yape** (la transferencia a la cuenta
    BCP ···0012): no está en este reporte;
  - **el mismo monto y minuto pero pagó otra persona**. El 04-10 fueron nueve
    («Tito Gab\*» pagando el pedido de Gilberto Gabino, «Luis Pal\*» el de
    Alfredo Palao): probablemente un familiar, pero eso lo decide alguien.
- **Dos imposibles se descartan**: un movimiento **posterior** a la carga del
  comprobante —nadie sube la constancia de un pago que aún no hizo— y uno que
  ya concilió otro comprobante.
- **La hora leída 12 h antes.** Hasta el 04-10-2026 el lector perdía el
  «p. m.» de Yape (§12, Pagos). Al comprobante con hora de mañana se le prueba
  también la misma hora por la tarde; sigue exigiendo minuto, monto, la
  clienta y que el pago sea anterior a la carga.
- **El cobro del courier necesita su hora.** El lector de Tanders no la leía
  hasta el 04-10-2026; ahora la transcribe, y antes de cruzar se le relee la
  constancia guardada a los cobros pendientes que entraron sin ella. Sin hora
  —el Plin de Scotiabank no imprime el año y se toma el de la lectura— no hay
  cruce.
- **Se puede deshacer como cualquier validación**: observar o rechazar después
  emite `liquidation_observed` y devuelve la guía a `en_ruta` (§9.4).
- `?simulacro=1` en el webhook calcula qué validaría sin escribir nada. Cada
  reporte deja su fila en `yape_statement_imports` con lo validado, lo omitido
  por motivo y lo que no se pudo escribir.
- **Y eso se ve en «Validar pagos › Estado de cuenta Yape»** (05-10-2026).
  Una pestaña al lado de los comprobantes lista cada correo, del último
  recibido al primero: cuándo llegó y cuándo se procesó, el periodo y los
  movimientos nuevos que traía, **los pagos que validó** —pedido, quién pagó
  según Yape, monto, hora del movimiento y la regla que cuadró— y los
  pendientes del periodo que quedaron para validar a mano, por motivo. El
  mismo correo procesado dos veces se marca como tal, y un pago que una
  persona observó o rechazó después lo dice en vez de seguir figurando como
  validado sin más. Solo muestra los reportes de una cuenta de cobro de las
  tiendas donde quien mira puede validar pagos, y de cada uno solo los pagos
  de esas tiendas (`lib/yape-statement/log.ts`).

## 17. KPI principales

Vistas: hoy, ayer, últimos 7 días, mes actual y mes anterior.

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

El primer tablero operativo de la Fase 4 usa cinco ventanas fijas en hora de
Lima: hoy, ayer, últimos 7 días, mes actual y mes anterior. Cada porcentaje
muestra siempre su numerador y denominador; un universo vacío se presenta como
`Sin datos`, nunca como 0 %.

**Las ventanas se leen según su madurez, no una contra otra.** Todas las tasas
de confirmación y adelanto son de cohorte: el denominador son los pedidos
*creados* en la ventana y el numerador es lo que esos mismos pedidos han
logrado *hasta ahora*. Un pedido creado ayer a las 22:00 lleva pocas horas de
gestión; uno de hace tres semanas ya cerró su ciclo. Por eso «Ayer» sale por
debajo de «Mes anterior» aunque la operación no haya cambiado, y «Hoy» arranca
bajo por la mañana y sube durante el día: **está para ver ese progreso**, no
para compararlo con un día cerrado. «Últimos 7 días» y «Mes actual» incluyen el
día de hoy a medias —empiezan seis días atrás y a inicio de mes, y cierran al
final de hoy—, así que arrastran una fracción pequeña de esa inmadurez
(auditado el 08-09-2026: 618/778 con hoy dentro frente a 614/759 sin él, un
punto y medio de diferencia en Provincia).

| Indicador | Cohorte / denominador | Resultado / numerador |
| --- | --- | --- |
| Confirmación Provincia COD | Pedidos Shopify creados en la ventana cuya cobertura actual es Provincia COD | Pedido que actualmente conserva evidencia de confirmación: evento `confirmed`, `guide_registered` o `label_generated`, cualquier salida registrada (despachada o no), o macroetapa ya en Preparación, Por despachar, En curso o Por cerrar. Un pedido anulado antes de confirmarse no cuenta |
| Adelanto de Agencia | Pedidos Shopify creados en la ventana cuya cobertura actual es Agencia | Pagos actualmente validados que acumulan al menos S/ 20 para el pedido |
| Entrega Aliclik | Salidas Aliclik despachadas dentro de la ventana | Salidas de esa cohorte cuyo resultado actual es Entregado |
| Entrega Lima total | Pedidos Lima con al menos una salida despachada dentro de la ventana (ver «qué es despachada» abajo: para Lima, el escaneo «listo despacho») | Pedidos de esa cohorte con al menos una de esas salidas Entregada |
| Pago completo de Agencia | Pedidos con guía Shalom u Olva **creada** dentro de la ventana | Pedidos de esa cohorte cuyos pagos actualmente validados cubren el total Shopify, se hayan cobrado cuando se hayan cobrado |

**Qué es «despachada» depende del courier.** `dispatched_at` en la salida solo
lo escribe Aliclik. Auditado el 08-09-2026: de 3.145 salidas Aliclik desde
agosto, 2.940 lo tenían; de 809 Shalom, 300 Tanders y 2.641 salidas «por
definir» de Lima, **cero**. Mientras el tablero miraba solo ese campo, Entrega
Lima y Pago completo de Agencia daban «Sin datos» con 740 pedidos Lima y 453
guías Shalom delante. La fecha de despacho se resuelve así
(`dispatchSignalAt`):

- **Aliclik**: `dispatched_at` y nada más. Una guía lista en la Mesa que el
  motorizado no recogió no está despachada; contarla bajaría la tasa de entrega
  por algo que no es culpa del courier.
- **Shalom / Olva**: la creación de la guía. Es el momento en que la caja va a
  la agencia y no hay ningún registro posterior.
- **El resto (Lima: por definir, Tanders, propio, Urpi)**: la entrega de
  custodia al motorizado si se registró; si no, el escaneo «listo despacho»
  (`ready_at`). Hoy la custodia no se registra nunca, así que en la práctica
  es el escaneo: la última señal que existe de que la caja salió. Por eso
  Entrega Lima muestra «0 de N» y no «Sin datos»: el denominador es real y el
  numerador espera a que se carguen entregas.

Las tasas de confirmación y adelanto se miden por pedido. Aliclik se mide por
salida para no ocultar el desempeño de un courier cuando un pedido tuvo varias
cajas. Lima y Agencia se deduplican por pedido porque representan el resultado
del negocio. Los resultados tardíos actualizan la cohorte de la fecha original
de creación o despacho, **el pago completo de Agencia incluido**.

**El pago completo de Agencia dejó de exigir que el cobro cayera en la ventana
del envío (09-09-2026).** La regla anterior —pago y envío dentro de la misma
ventana— era deliberada, pero producía un número que no era el que la fila
prometía. Entre despachar por agencia y cobrar el total pasan **5,6 días de
mediana**, así que exigir ambas cosas en la misma ventana borraba todo lo
despachado en los últimos seis días del mes. Medido sobre agosto de 2026:

| | Pedidos | Tasa |
| --- | --- | --- |
| Lo que mostraba el tablero | 324 de 648 | 50,0 % |
| Cobranza real de esa cohorte | 458 de 648 | **70,7 %** |

Los 134 que faltaban no reaparecían en septiembre —el denominador va por fecha
de despacho, y su despacho fue en agosto— sino que no se contaban nunca. De
ellos, **107** se cobraron el mes siguiente y **27** eran pagos validados sin
`paid_at`, que el filtro de ventana descartaba en silencio (62 en total desde
agosto, S/ 6.355): `paid_at` no lo teclea nadie, lo extrae la visión del
comprobante y a veces no lo consigue. Un pago validado es dinero cobrado, tenga
fecha legible o no.

El cambio además alinea la fila con la de arriba: «Adelanto de Agencia» ya
contaba los pagos actualmente validados sin mirar la fecha, y dos reglas
distintas en filas contiguas se leen como comparables sin serlo.

**Lo que NO cambia: la cohorte sigue siendo la del despacho.** Un pedido pagado
en la ventana pero despachado fuera no entra; si entrara, «Ayer» acabaría
contando el mes entero.

**Cómo leer las ventanas cortas de esta fila.** «Hoy» y «Ayer» seguirán
mostrando cifras cercanas a cero, y no es un fallo: con una mediana de cobro de
5,6 días, casi ningún pedido despachado hoy puede estar cobrado hoy. Lo mismo
vale para el mes en curso mientras esté empezando — el 09-09-2026, 120 de los
218 despachos del mes (el 55 %) llevaban menos de tres días. La comparación
honesta es contra el mismo día del mes anterior, no contra el mes anterior
cerrado.

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

**La búsqueda mira TODO el universo asignable, no la porción que se pinta.** Una
lista de miles se muestra recortada por fuerza, y un buscador que solo filtre lo
recortado no encuentra lo que quedó fuera por más que se escriba el código
exacto: contesta «no hay» cuando lo cierto es «no bajó». La consulta va al
servidor, y la muestra dice que es una muestra.

**Qué pedidos se ofrecen para una ruta.** Solo los que están vivos y con el
paquete bajo custodia de la empresa sin comprometer en otro sitio:
`listo_para_asignar`, `retirado_del_manifiesto` —salió de un manifiesto con
motivo y vuelve al pool— y `por_reprogramar_lima` (§13). Quedan fuera
`asignado_a_ruta` y `en_cotejo` porque ya van en otra —dos motorizados con el
mismo paquete es el fallo caro—, `listo_para_recojo` porque en agencia recoge la
clienta, y toda `Preparación` porque el paquete todavía no existe. Ofrecer lo
que no se puede rutear no es ruido inocuo: gasta el recorte de la lista y empuja
fuera a los que sí se podían despachar.

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
  ambas muestran el requisito de adelanto y el servidor exige S/ 20 validados.
  La salida de Olva admite el tracking de Olva, y con él su estado se rastrea
  solo (§12, 0174).
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
  denominador en las cinco ventanas de la sección 17.1.
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

**La cobertura se calcula sobre `peru_districts`, que es texto libre.** El
Master rellena la región y la provincia del pedido desde esa tabla
(`fetchGeo` en `lib/order-master.ts`), y esa región entra a `order_coverage_for`
→ `is_lima_metropolitana` → `lima_region_kind`. La tabla se llena a mano y nada
valida lo que se escribe, así que un departamento inventado **no da error: da
otra cobertura**, en silencio.

La 0129 corrigió ocho filas que lo demostraban. Siete tenían el departamento
copiado del propio distrito —`Pachacamac`, `Pucusana`, `HUACHIPA`, `Chancay`,
`Huaral`, `Lurigancho chosica`, `Barranca`— y una tenía la geografía de otra
región entera: **Pacasmayo, que es de La Libertad, decía `Callao`** en provincia
y en departamento, y `lima_region_kind` sí reconoce «Callao», de modo que un
destino a 600 km de Lima se clasificaba como reparto local.

Tres de las ocho (`chancay`, `huaral`, `paramonga paramonga`) ya devolvían
`agencia`, que es lo correcto —pero **por accidente**: un departamento que no
empareja con nada da el mismo resultado que uno correcto fuera de Lima
Metropolitana. Se corrigieron igual. El acierto por accidente deja de serlo en
cuanto alguien añada una tarifa con alcance por departamento.

Dos cosas que conviene recordar antes de estimar el daño de un caso así:

- **La región de Shopify gana a la de esta tabla** en la prioridad de
  `order-master.ts`. El departamento inventado solo llegaba a los pedidos cuya
  dirección de Shopify venía sin provincia —siete—. La provincia, en cambio, se
  usa en más sitios y se leía en pantalla tal cual: `Pucusana` para Chaclacayo.
- **`district_key` es la clave de unión, no `district`.** Corregir el texto
  visible no arregla ninguna cobertura, y por eso la 0129 no lo tocó.

Convención de la tabla para Lima Metropolitana: `Lima` / `Lima`. Es lo que
`lima_region_kind` resuelve a `'lima'`, dejando que decida el distrito.

**Una región que nombra un DISTRITO de Lima también es Lima.** `peru_districts`
no era el único sitio por donde entraba una región inventada. Corrigiendo la
tabla quedaron dos pedidos sin arreglar, y al perseguirlos aparecieron otras dos
fuentes: `#KP127256` traía `shippingAddress.province = "Chaclacayo"` de Shopify,
y `#KP127130` traía `region = "HUACHIPA"` de una **corrección manual del equipo**
en `order_geo_overrides`. Tres orígenes distintos, el mismo síntoma.

El agujero estaba en `is_lima_metropolitana`, que cortaba en seco ante cualquier
región no vacía que no sonara a Lima. La regla defendía un caso real —una región
que nombra OTRO departamento (Independencia/Huaraz, La Victoria/Chiclayo)— pero
trataba igual a una región que no nombra ningún departamento sino un **distrito
de Lima**, que es lo que pasa cada vez que alguien escribe el distrito o el
barrio una casilla más arriba de la que toca.

La 0130 lo separa: si la región resuelve a un distrito metropolitano —alias
incluidos, que es como «HUACHIPA» llega a `lurigancho`— el destino es Lima.

Dos límites que son la mitad importante del arreglo:

- **Los nombres ambiguos siguen fuera.** Bellavista, Independencia, La Victoria,
  Miraflores, Pueblo Libre, San Luis, San Miguel y Santa Rosa existen en Lima y
  en otros departamentos. Esa lista ya vivía escrita a mano dentro de la función;
  ahora es `lima_ambiguous_districts()` y **las dos ramas leen la misma** —
  duplicarla habría sido plantar la siguiente divergencia con las manos.
- **La región tiene que SER el distrito, no mencionarlo.** Sin búsqueda dentro
  del texto: «Cerca de Chaclacayo» no dice dónde entregar.

Cambiaron 12 pedidos en toda la historia, todos inequívocamente de Lima. Y
`Pucusana`, que también encaja en la regla, **no** cambió: tiene una excepción
explícita en `district_coverage` y esa manda sobre todo lo demás. El orden de
precedencia de §19 hizo su trabajo.

La prueba vive en `scripts/sql/lima_region_smoke.sql` y se comprobó que **puede
fallar**: se verificó contra cuatro mutantes —la función anterior, la versión sin
el guardarraíl de ambigüedad, la que busca dentro del texto y la que rompe la
rama sin región— y los caza los cuatro. Una prueba que no falla ante ninguno de
esos no habría estado protegiendo nada.

### 19.0.1 La ortografía del departamento se unifica; el matiz de Lima no

Medido el 14-09-2026: `shipments.region` tenía **77 valores distintos para 25
departamentos**. El filtro de la cola de Envíos agrupa por esa columna, así que
el desplegable ofrecía «Junín» (501 filas) y «Junin» (125) como si fueran dos
sitios, y elegir uno escondía el otro. Lo mismo con Áncash, Huánuco, Apurímac,
San Martín, Cusco/Cuzco e Ica.

`normalizeDepartment` (`lib/peru-departamentos.ts`) canoniza la grafía al
importar y al agrupar —las dos, porque las filas ya guardadas no se reimportan—.
Es **seguro para la cobertura por construcción**: `normalizeCoverageLabel` ya
compara sin tildes y en minúsculas, así que arreglar la ortografía no cambia
ninguna decisión de courier. Hay una prueba que lo fija recorriendo las grafías
reales y exigiendo que `limaRegionKind` dé lo mismo antes y después.

**Lo que NO se unifica, y es la parte que importa: las tres Limas.**

| Valor | Qué es | `limaRegionKind` |
|---|---|---|
| `Lima (provincia)` · `Lima Metropolitana` | la ciudad | `metropolitana` |
| `Lima (departamento)` · `Región Lima` | el resto del departamento | `departamento` |
| `Lima` a secas | no consta cuál | `lima` |

Parecen la misma etiqueta mal escrita y no lo son. Los distritos lo confirman:
en «(provincia)» están Miraflores, Surco y Puente Piedra; en «(departamento)»
están Barranca, Cañete, Canta y Sayán, que son otras provincias del mismo
departamento y otra cobertura. Fusionarlas —que es lo que parece el arreglo
obvio mirando el desplegable— habría roto el ruteo de 113 envíos.

Y **un distrito suelto en la columna se deja como vino**. Entran «Trujillo»,
«Chorrillos», «Av Mariátegui mercado orizonte». Adivinarles el departamento es
inventar: un dato sucio que se ve es mejor que uno limpio que miente, y §19.0
ya fija el mismo criterio para los nombres ambiguos.

### 19.0.2 «No hay dato» no es «no hay cobertura»

La cobertura Fenix/Swayp de un envío se decide por su ciudad. La columna `city`
de `shipments` es la que la nombra, y **el alta por la API de Aliclik la deja
vacía**: 219 envíos, 85 de ellos pendientes. Leerla sola convierte «falta el
dato» en «fuera de cobertura», que son dos cosas distintas —y la segunda esconde
trabajo despachable—.

La regla: **cuando `city` viene vacía, la ciudad se deriva del distrito y la
provincia.** Cuando viene cargada manda ella, sin derivar nada por encima: el
courier puede contradecir a Shopify, y esa discrepancia es un aviso que hay que
ver, no tapar.

Vive en una sola función (`coverageCityOf`) porque estuvo repartida y las copias
se desincronizaron. Tenerla en un sitio no basta: **hay que pasarle el destino
completo**. Las rejas que escriben la elegibilidad seleccionaban `city` a secas,
así que la cola mostraba «Fenix Ok» —la lectura sí traía el distrito— y el botón
respondía «Fenix no tiene cobertura en la ciudad indicada» sobre el mismo envío.
La frase delataba el bug: «la ciudad indicada» es el texto de respaldo de cuando
`city` es NULL. Por eso las cuatro columnas del destino se seleccionan juntas,
desde una constante única (`FENIX_COVERAGE_COLUMNS`), en los cuatro caminos: la
lectura de la cola, la reja de reprogramación, la excepción sobre guía anulada y
el barrido masivo que resincroniza la elegibilidad.

`province` llegó en la migración 0039 y el histórico guarda la suya en `region`.
Se resuelve una sola vez (`province ?? region`): sin ese respaldo, media base
pierde la provincia y con ella la derivación.

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
   el `updated_at` de las guías contra el `recomputed_at` del Master. No basta
   con que cada ruta se acuerde de recalcular, porque **la escritura puede venir
   de fuera de la aplicación** —de una consola de SQL, como el 09-08— y ninguna
   ruta puede responder por eso. El read-model se reconcilia contra los datos, no
   contra las llamadas.

   **Y «contra los datos» quiere decir sin ventana.** La primera versión
   (`staleByShipment`, en TypeScript) comparaba sobre las **2.000 guías tocadas
   más recientemente** de la tienda, porque PostgREST no sabe comparar dos
   columnas de tablas distintas. Eso seguía siendo una llamada disfrazada de
   dato: un pedido que caía por debajo de esa línea **no podía volver a entrar
   jamás**, y cada guía nueva lo hundía un poco más. Medido el 18-08-2026 en
   Kenku: **487 desfasados, 381 bajo la línea**, mientras el barrido recalculaba
   620 pedidos por hora en esa misma tienda — no le faltaba tiempo, no los veía.

   La pregunta la responde ahora la base (`order_master_stale`, 0123), que es
   donde la comparación se puede hacer de verdad, y con eso la definición del
   desfase existe en **un solo sitio** —como `order_coverage_for` desde la 0104,
   y por la misma razón—. Se recorre del recálculo más viejo al más nuevo: lo
   que lleva más tiempo mintiendo sale primero, y lo que un tope de recorrido
   deje fuera es siempre lo más recientemente recalculado, que es lo que menos
   falta hace mirar.
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

### 19.2 Mirar una guía no es cambiarla (0204)

La regla 1 de §19.1 sigue igual: el desfase se detecta comparando el
`updated_at` de las guías contra el `recomputed_at` del Master. Lo que se
precisa es **qué escritura cuenta como cambio de la guía**.

- **El sello de lectura de la API no es un cambio.** `api_report_at` (cuándo la
  miramos) y `api_updated_at` (qué `updatedAt` vimos) se escriben en cada
  relectura, cambie o no la guía. Una escritura que solo toca esos dos deja
  `updated_at` como estaba, y el pedido no se da por desfasado. Es la misma
  regla que `lib/aliclik-snapshot-diff.ts` ya aplicaba en el camino directo
  («los sellos dicen cuándo miramos, no qué vimos»), llevada al trigger, que es
  donde el detector la lee. Cualquier otra columna distinta —también desde una
  consola de SQL— sigue moviendo `updated_at`, y reescribir el mismo valor no lo
  mueve.
- **`last_report_at` sí cuenta.** Lo escriben el Excel, Olva y Tanders, y los
  barridos de Olva y Shalom eligen qué guía leer después ordenando por
  `updated_at`: si dejara de moverlo, se quedarían releyendo siempre las mismas.
- **En el Master, un recálculo que no cambia nada tampoco es un cambio.**
  `recomputed_at` dice cuándo se recalculó la fila; `updated_at`, cuándo cambió
  lo que la fila dice. Solo lo segundo le avisa a la pantalla de que hay algo
  nuevo que enseñar.

Por qué importa, medido el 29-09-2026 en horario de trabajo: 161 pedidos con un
evento real en una hora y 2.298 filas del Master reescritas. De 741 guías de
Aliclik tocadas en dos horas, 729 solo habían recibido el sello. Cada sello
disparaba un recálculo por el barrido del Master, y cada recálculo, una recarga
completa de la página en cada pestaña abierta. Las pruebas de estas tres reglas
viven en `scripts/sql/master_liviano_smoke.sql`.

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
- Agente de voz fuera de Reproprovincia: Agencia con adelanto y Por confirmar
  (§11.8, pendientes).

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
- Olva no se crea con menos de S/ 20 validados aunque el navegador sea alterado.
  **Salvo que el pedido ya esté cobrado**: pagado en el checkout o con
  comprobantes que cubren el total (`orderFullyPaid`). Un pedido prepago no
  tiene comprobantes que sumar, y exigírselos lo bloqueaba (#KP135087,
  21-09-2026).
- Dos salidas del mismo pedido reciben QR y código `Sxx` diferentes.
- Con una salida activa, la salida adicional exige una justificación auditada.
- **Una salida «por definir» no cuenta como salida que estorba.** Crear la guía
  del courier la rellena en vez de abrir otra, así que la mesa no advierte de una
  salida adicional que no se va a crear: nombra la salida —`KP128892-S01`— y dice
  que se le escribirá el courier encima. El aviso de justificación auditada se
  reserva para las salidas que sí obligarían a un segundo paquete, y vuelve a
  aparecer en cuanto la caja deja de ser rellenable —custodia transferida al
  motorizado, o guía emitida ya por el courier—, porque entonces sí se crea una
  nueva. Con varias por definir se nombra la de consecutivo más alto, que es la
  que se rellena y la caja que el almacén tiene delante.
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
  próximos. `Vencidos` es solo la fecha pactada incumplida; `Hoy` es lo que
  toca llamar ahora y se lleva a cero; `Próximos` es lo que todavía no toca.
  Cada chip de Fecha pactada muestra el conteo exacto de su grupo sobre todos
  los pedidos filtrados, no solamente sobre la página visible.
- `Sin respuesta` y `Se deja mensaje` generan un recordatorio a las dos horas
  laborales dentro de 08:00–22:00 de Lima. Hasta esa hora el pedido está en
  `Próximos`; llegada la hora vuelve a `Hoy` y no sale de ahí hasta que alguien
  lo rellame.
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

### 25.1 La ficha se abre desde cualquier pantalla

El drawer es **la ficha del pedido de todo el panel**, no una pieza del Master.
Antes, «Ver actividad» en Despacho del día o el número de pedido en Grupo GF
Courier mandaban al Master con `?q=…&abrir=…`: la persona perdía la cola, la
ruta o la hoja en la que estaba trabajando y tenía que volver a buscarla.

Reglas:

- **Misma ficha en todas partes.** Despacho del día (cola, cajas, excluidos),
  Rutas, Grupo GF Courier, Validación de pagos, Liquidaciones (conciliación) y
  Liquidaciones 2 (columna Pedido) abren el mismo componente que el Master,
  encima de la pantalla actual. No hay una «ficha resumida» distinta: lo que se
  ve y lo que se puede hacer es idéntico, con los mismos permisos que en el
  Master (`master.edit`, `master.override_status`, guías por courier y los
  permisos de cierre). Quien no puede actuar en el Master tampoco puede desde
  la ficha abierta en otra pantalla.
- **La URL manda.** Fuera del Master la ficha se abre con
  `?ficha=<pedido>&seccion=operar|informacion|historial` sobre la ruta actual,
  conservando el resto de la query (pestaña, motorizado, mes, filtros). El
  Master conserva su `?abrir=<pedido>&seccion=…`. La ficha global no actúa en
  `/dashboard/pedidos`: ahí la abre el propio Master, y montar dos sería
  enseñar dos paneles iguales. El parámetro no se llama `pedido` porque Grupo
  GF Courier ya usa `?pedido=` para preseleccionar un pedido en su lista.
- **Cerrar devuelve al mismo sitio.** Al cerrar solo desaparecen `ficha` y
  `seccion`; la pantalla de atrás no se vuelve a pedir ni pierde sus filtros.
  Un enlace que abre la ficha es un enlace de verdad: se puede abrir en otra
  pestaña o copiar, y esa URL abre la ficha al cargar.
- **Las acciones cuentan igual.** Registrar un pago, crear una guía, cambiar la
  ruta o cerrar desde la ficha abierta en Despacho es la misma acción de
  servidor que en el Master, con la misma autorización por tienda. Al terminar,
  la ficha recarga su detalle y refresca la pantalla de atrás, para que la cola
  o la hoja reflejen lo hecho.
- **Enlace al Master.** La ficha abierta fuera del Master lleva «Abrir en
  Master de Pedidos» en la cabecera: va a `/dashboard/pedidos?abrir=<pedido>`,
  donde están la tabla, los filtros y las acciones en lote que la ficha sola
  no trae.
- **Móvil.** Fuera del Master la ficha ocupa la pantalla entera, con botón de
  cerrar siempre a la vista en la cabecera fija y Escape en escritorio.
- **Sección al abrir.** «Ver actividad» abre en `Actividad`; el número de pedido
  abre en `Operar`. La pestaña inicial se respeta al montar (antes un reinicio
  a «Operar» al cambiar de pedido pisaba la pestaña pedida).

Implementación: `components/order-drawer.tsx` (la ficha),
`components/order-master-shared.tsx` (formato, chapas y botones de anular que
comparten Master y ficha), `components/order-drawer-host.tsx` (montada en
`app/dashboard/layout.tsx`), `components/order-link.tsx` (`OrderLink`,
`useOpenOrderDrawer`) y `lib/order-drawer-href.ts` (las URL; probado en
`test/order-drawer-href.test.ts`).

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
- Un usuario cuyo único rol es `motorizado` no tiene tiendas, así que el Master
  le abre solo los pedidos que son paradas de una ruta suya en curso o cerrada
  (0186, `auth_rider_order_ids()`): lo que necesita para ver nombre, celular,
  dirección y monto de cada parada, y nada de otros motorizados. La escritura
  del Master sigue cerrada para él.

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

## 29. Grupo GF Courier — operador logístico y fulfillment

### 29.1 Decisión de producto

Los motorizados que hasta ahora se llamaban **propios** dejan de ser una
excepción dentro de Aurela o Kenku. Operan bajo **Grupo GF Courier**, un operador
logístico de Grupo GF que presta servicio a las tiendas del grupo y, en el
futuro, a tiendas externas.

La interfaz puede mostrar todos los operadores como alternativas de envío, pero
las identidades no se mezclan:

- **Tienda cliente**: dueña del pedido comercial y del dinero de la venta.
- **Operador logístico**: empresa contratada para preparar y/o entregar.
- **Motorizado**: persona que trabaja para un operador y recibe la custodia.
- **Solicitud logística**: instrucción de preparar o entregar un pedido.
- **Paquete/salida**: unidad física con QR estable (§3–4).
- **Ruta**: trabajo de un motorizado durante un día.
- **Carga**: conjunto de paquetes entregado al motorizado dentro de esa ruta.
- **Contrato de servicio**: cobertura, tarifas y reglas entre tienda y operador.

Grupo GF posee cuatro capacidades distintas, aunque compartan administración y
almacén:

| Capacidad | Responsabilidad |
| --- | --- |
| Proveeduría Grupo GF | Puede ser propietaria de una bolsa de inventario compartida |
| Almacén Grupo GF | Custodia inventario, reserva, arma y rotula |
| Aurela / Kenku / tienda externa | Canal comercial y propietario del pedido |
| Grupo GF Courier | Planifica rutas, transfiere custodia, entrega y liquida |

No se crea una tienda Shopify ficticia para Grupo GF Courier. Aurela y Kenku
deben relacionarse con el operador bajo las mismas reglas que una futura tienda
externa, para no mantener un segundo flujo especial de «propios».

### 29.2 Alcance inicial

#### Experiencia móvil del cotejo — 12-09-2026

La vista móvil presenta cada carga con motorizado, fecha, número de carga,
contadores independientes y acceso visible a verificar/recibir. Los pedidos
se leen verticalmente sin esconder sus acciones a la derecha de una tabla.
La cámara es la entrada principal; escribir el código es explícito y nunca
abre el teclado automáticamente en una pantalla táctil.

Al terminar oficina, la pantalla confirma **Caja verificada** y ofrece pasar
a recepción solo a quien tiene permiso. Ese botón cambia de vista, no marca
paquetes ni transfiere custodia. El segundo cotejo sigue siendo independiente.
Las correcciones de contenido se despliegan aparte, con motivo e historial.
No cambian elegibilidad, tarifas, identidad de salidas ni reglas de liquidación.

#### Recorrido unificado aprobado el 12-09-2026

**Unificación de navegación, 13-09-2026.** La entrada independiente «Rutas»
se retira del menú: el reparto y su cierre financiero pertenecen a **Grupo GF
Courier → Rutas → Reparto y cierre diario**. «Cajas y cotejos» conserva los
controles físicos. La URL canónica del reparto es `/dashboard/courier/reparto`;
`/dashboard/rutas` redirige conservando id, fecha y demás parámetros.
No se recrean rutas, paradas, salidas ni liquidaciones. Se conservan permisos:
mostrar la entrada al módulo no concede administración logística a quien solo
puede gestionar rutas o cotejar. La planificación rápida sigue en «Tomar y
asignar», no en un segundo formulario de creación de rutas.

Master representa a la tienda; Almacén prepara y entrega; Grupo GF Courier
planifica, recibe, reparte y liquida. Los pedidos elegibles de Aurela/Kenku se
ofrecen automáticamente, sin una segunda aprobación en Master. La búsqueda y
la paginación cubren todo el universo elegible, nunca solo los primeros 300.
Se mantienen confirmación, cobertura, tarifa, disponibilidad y exclusividad.

El camino rápido es **Tomar y asignar**: una selección, un motorizado, las fechas
previstas visibles. Se conservan dos hechos auditados aunque haya un solo gesto.
**Tomar sin asignar** sigue disponible. Almacén trabaja en paralelo; no se exige
su escaneo para admitir ni planificar. Verificar físicamente el paquete puede
registrar su armado cuando todavía no estaba marcado, sin un tercer escaneo.

Los cotejos de GF viven en **Grupo GF Courier → Rutas**, sobre la caja exacta:
verificar caja, recibir carga y consultar reparto. Abrir una caja con pedidos
va al siguiente control pendiente, no vuelve a pedir asignarlos. Agregar pedidos
es una acción secundaria. El escaneo confirma solo lo previamente asignado.
Oficina y motorizado conservan autores independientes y permisos separados.

Almacén conserva **Entregas a couriers** para los demás operadores. Los enlaces
antiguos de GF redirigen a su módulo sin cambiar ids, QR ni historial.

Una ruta diaria de reparto puede tener varias cargas/manifiestos vinculados.
Una carga adicional solo se abre cuando el motorizado ya salió con la
anterior, es decir, con la custodia cambiada. Cada nueva carga exige ambos
controles. Al completar recepción se incorporan automáticamente las paradas a
la misma ruta de reparto. Una ruta liquidada no admite cargas; no se recrean
rutas ni se sustituyen paradas ya reportadas. Finanzas conserva aprobación
humana.

**La caja sigue abierta mientras se coteja (28-09-2026, decisión de Frankz,
0196).** Mientras la caja no sale, se le siguen sumando paquetes **en paralelo**
al cotejo de oficina y a la recepción del motorizado. Al final todo debe quedar
cotejado por los dos, o retirada la diferencia que no irá.

- Un paquete nuevo entra sin cotejar. Si oficina ya había terminado, la caja
  vuelve a «cotejo de oficina» solo por él; lo ya cotejado y recibido no se
  toca.
- El motorizado recibe cada paquete que oficina ya verificó, aunque queden
  otros por verificar. Un paquete sin verificar no se recibe y se le dice por
  qué.
- La custodia, y con ella la ruta, pasa solo con el 100 % de los paquetes
  activos cotejados dos veces. Lo que no irá se retira: oficina con «Retirar» o
  el motorizado con «No lo recojo». Si con ese retiro lo que queda está
  completo, la custodia pasa en el acto (`gf_finalize_if_complete`).

Antes, desde el primer paquete cotejado por oficina, no se le podía sumar nada
al motorizado hasta que recibiera la caja entera: «La carga ya inició el
cotejo» y «Termina de verificar y recibir la carga actual antes de agregar
otra». Medido del 23 al 26-09: ventanas de 9 a 74 minutos sin poder sumar. El
25-09 lo escaneado para Yhoni a las 10:46 no salió con él. El 26-09 su carga 2
se abrió cuando él ya salía, nunca la recibió y quedó vacía, bloqueando la
liquidación del día.

- Cobertura: Lima Metropolitana y Callao.
- Punto de operación: un único almacén de Grupo GF.
- Corte para salida el mismo día: **11:30**.
- La tienda asigna directamente la solicitud a Grupo GF Courier.
- Grupo GF puede recibir inventario de una tienda, pero en el alcance inicial no
  recoge paquetes armados en otros almacenes: Grupo GF reserva, arma y rotula.
- Una ruta puede mezclar pedidos de Aurela, Kenku y otras tiendas autorizadas.
- El portal de una tienda externa admite conexión Shopify, API y carga Excel.
  La primera versión es solo con Shopify y en la organización de la tienda
  (§29.15); API y Excel vienen después.

Para Aurela y Kenku, la admisión operativa ocurre desde **Grupo GF Courier →
Pedidos disponibles**, no creando una salida pedido por pedido en la Mesa de
ruta. Los pedidos Kapta aparecen automáticamente desde `Preparación · Por
generar rótulo`, `Preparación · Por armar` y `Por despachar · Listo para
asignar`, cuando corresponden a Lima Metropolitana o Callao y tienen operador y
contrato activos, distrito canónico, tarifa vigente y servicio no pausado.
También entra `En curso · Por reprogramar Lima` (v1.19), y desde el 06-10-2026
por su etapa, sea cual sea el estado operativo (§29.13). Si
ya existe una salida, debe ser la caja `por definir` —o, al reprogramar, la
salida propia de Grupo GF que no se entregó (§29.13)—; una salida viva de otro
courier no se ofrece (la que ese courier no entregó no cuenta, v1.19). El operador puede tomarlos individualmente o en lote. La
Mesa de ruta solo informa que el pedido está disponible y enlaza esa bandeja;
no abre un segundo formulario ni genera un rótulo desde el drawer.

**Tomar y armar son procesos independientes.** Grupo GF Courier puede tomar la
solicitud antes, durante o después del armado. Tomar congela servicio, tarifa y
fecha prevista; no certifica que la caja esté armada y no exige el escaneo de
Almacén. Almacén conserva todos los pedidos en su cola normal y siempre los
prepara, hayan sido tomados o no. La bandeja del courier muestra
`Pendiente de armado`, `Almacén armando` o `Armado · listo para ruta` como dato,
nunca como candado para admitir la solicitud. El operador del courier no debe
entrar a la pantalla de Almacén para hacer avanzar el pedido.

**Tomar, asignar y cotejar son hechos distintos.** El camino rápido combina
tomar y asignar en un gesto, pero nunca combina asignar con cotejar. Desde `Pedidos tomados`,
Grupo GF Courier puede seleccionar solicitudes y asignarlas a la ruta diaria de
un motorizado aunque Almacén todavía no haya terminado de armarlas. La asignación
reutiliza la única ruta de ese motorizado para la fecha prevista y coloca cada
salida en su manifiesto; no crea otra caja física, no cambia custodia y no marca
el paquete como armado. Almacén deja luego una caja o agrupación lista por
motorizado con todos los pedidos que alcanzaron a preparar. El **cotejo de
oficina** ocurre frente a esa caja: se escanea cada paquete armado y solo se
confirma lo que ya estaba asignado. Un pedido pendiente de armado puede figurar
en la ruta planificada, pero no puede superar el cotejo ni transferir custodia
hasta existir físicamente. La bandeja abre la caja dentro de Grupo GF Courier
para continuar ese cotejo sin volver a seleccionar los pedidos.

La operación se lee en dos niveles. `Pedidos tomados` separa **Sin ruta**,
**Asignados**, **Pendientes de armado** y **Listos para cotejo** sin duplicar
estados persistidos. `Rutas operativas` agrupa por manifiesto/motorizado y fecha,
y muestra cuatro contadores distintos: asignados, armados por Almacén, cotejados
en oficina y recibidos por el motorizado. El porcentaje visible corresponde al
primer cotejo físico, no al mero armado ni a la planificación. Desde cada fila
se abre el manifiesto exacto dentro de Grupo GF Courier.

`Tomar pedidos` crea o reutiliza una **solicitud logística** idempotente, congela
contrato, tarifa, distrito y fecha prevista, y recién entonces crea la salida.
Si Kapta ya había creado una salida `por definir`, se rellena esa misma fila y
se conserva su QR; nunca se pega un segundo rótulo por elegir Grupo GF Courier.
La acción vuelve a comprobar todas las reglas en el servidor, porque una tarifa,
contrato o pausa puede cambiar mientras la bandeja está abierta. Un doble clic o
dos operadores tomando el mismo pedido no pueden crear dos solicitudes activas.
Volver a tomar un pedido que Grupo GF Courier ya tiene aceptado o programado
—por ejemplo al escanearlo en Despacho del día días después de tomarlo— no lo
rechaza por la salida que dejó esa toma: cuenta como ya tomado y sigue a la
asignación.

Las tiendas cliente de otra organización asignan ellas mismas cada pedido y
nunca entran a esta cola (§29.15.2). La cola automática descrita arriba es el
camino de mínima fricción para las tiendas de Grupo GF administradas dentro de
Kapta.

**Prioridad dentro de Pedidos disponibles.** La bandeja separa dos colas sin
inventar un estado operativo nuevo:

- **Prioridad urgente · nunca salieron:** el pedido nunca salió a reparto.
  Crear o anular un rótulo sin transferir físicamente el paquete no lo saca de
  este grupo. Esta es la vista inicial y se ordena del pedido más reciente al
  más antiguo.
- **Con salida previa («Ya salieron»):** el pedido salió a reparto al menos una
  vez, aunque haya regresado a Preparación o esté en Por reprogramar Lima. Se
  trata como reprogramación o recuperación y conserva toda la evidencia de la
  salida anterior.

**Qué es «salió a reparto» (29-09-2026).** Hasta esta fecha se leía solo
`shipments.dispatched_at`, que Grupo GF no llena y `gf_return_to_office`
vuelve a null: de 1.863 pedidos en cola, 0 figuraban con salida previa. Ahora
lo decide `gf_order_departures` (0199), para cualquier courier: en
`order_events`, «Lo llevo» (`pickup_checked`), el reporte en la puerta
(`stop_reported`), el paquete recibido de vuelta en oficina
(`returned_to_office`) o entregado sin «Lo llevo»
(`delivered_unconfirmed_pickup`); una parada reportada de las rutas anteriores;
o una salida de otro courier con `dispatched_at`. **`custody_transferred` no
cuenta**: en el modo «confirmar» la custodia pasa al asignar, antes de que el
paquete deje el almacén, y un paquete retirado de la caja sin salir no es un
reintento. La lista vive en `DEPARTURE_EVENT_KINDS` (`lib/dispatch-day.ts`) y
en la función; se cambian juntas.

La separación solo prioriza la gestión. No cambia la elegibilidad, la tarifa ni
las comprobaciones idempotentes de `Tomar pedidos`.

Durante la transición, las salidas de Grupo GF siguen guardando el token legado
`propio` para no romper rutas, QR, manifiestos ni liquidaciones históricas. La
interfaz ya las nombra **Grupo GF Courier**. El token se reemplazará por el
`provider_id` estable al ejecutar el paso 2 de §29.11, con migración auditada y
sin reescribir el historial.

Las fichas de `riders` ya usan **Grupo GF Courier** como empresa operadora para
altas y ediciones nuevas. Un `courier` nulo, vacío, `propio` o
`motorizado propio` sigue siendo un alias histórico de la misma afiliación. Esta
compatibilidad permite conservar `riders.id`, usuarios vinculados, rutas y
liquidaciones; la normalización del texto no crea una segunda ficha.

Shopify continúa siendo la única fuente de **pedidos comerciales administrados
por Kapta** (§2). Una solicitud recibida directamente por API o Excel es una
solicitud logística, no un pedido Shopify inventado. Debe conservar el código
externo de la tienda y una clave de idempotencia para impedir duplicados.

### 29.3 Inventario preparado, pero no obligatorio

El courier no exige implementar ahora un ERP completo. La fundación admite
**bolsas de inventario** opcionales:

- Una bolsa tiene propietario; inicialmente puede existir la bolsa compartida de
  Proveeduría Grupo GF.
- Una tienda puede vender desde una o varias bolsas autorizadas.
- Cada línea del pedido conserva la bolsa de la que se reservó.
- El primer pedido que entra y reserva correctamente gana la unidad.
- Un pedido que mezcla bolsas no queda listo hasta reservar todas sus líneas.
- La reserva ocurre al ingresar el pedido.
- Un faltante deja la solicitud logística observada; Grupo GF puede anularla,
  pero no cancela automáticamente el pedido comercial en Shopify (§2).
- La tienda y Grupo GF cotejan una futura recepción de inventario; la palabra
  final sobre la cantidad recibida es de Grupo GF. Una diferencia queda
  observada hasta que la tienda la acepte.
- Las filas históricas o tiendas todavía sin control de inventario pueden
  mantener la bolsa y la reserva nulas. Esta compatibilidad no se interpreta
  como stock cero.
- En una tienda cliente de otra organización, la bolsa de cada línea sale del
  mapeo de SKU de la tienda; la primera versión no reserva ni cuenta unidades
  (§29.15.4).

La Mesa de fulfillment debe ser rápida y excepcional: `Pendiente de armar →
Armando → Listo`. La reserva es automática y no crea un formulario. En el camino
normal, almacén comprueba productos, imprime el rótulo y confirma «Armado y
rotulado» con una sola acción o escaneo. Los motivos aparecen solo ante faltantes
o correcciones. Debe permitir lotes, impresión masiva, escáner y filtros por
tienda/fecha; el courier se decide en despacho, no durante el armado.

### 29.4 QR e identidad física

- Un paquete físico tiene **un solo QR interno**.
- Si la solicitud nace de Kapta, Grupo GF Courier reutiliza el QR de la salida.
- Si entra directamente por API o Excel, Grupo GF crea la solicitud, la salida y
  el QR con el mismo esquema de identidad.
- Una transferencia entre motorizados conserva el QR; cambia la custodia y queda
  un evento por cada actor.
- Una reprogramación que conserva el paquete armado conserva su identidad física.
- Un pedido anulado, rechazado definitivamente o que debe desarmarse libera la
  reserva y devuelve el producto a su bolsa. Si luego se vuelve a armar, nace una
  salida nueva con QR nuevo, respetando §4.
- En una tienda cliente de otra organización, un no entregado que vuelve a la
  oficina sin reprogramación registrada también se desarma (§29.15.5).

### 29.5 Ruta diaria, cargas y transferencias

- Cada motorizado tiene una sola ruta por día. La ruta también es la unidad de su
  liquidación diaria.
- Si vuelve al almacén por uno o dos pedidos, se agregan a la misma ruta mediante
  una **carga adicional**; nunca se crea otra ruta ni se incorporan paquetes sin
  cotejo.
- Cada carga registra hora, paquetes, entrega de almacén y recepción del
  motorizado. La segunda recepción usa el mismo doble cotejo de §18.
- La ruta puede mezclar tiendas. El cobro, costo e inventario siempre conservan
  su tienda de origen.
- Una ruta puede transferirse a otro motorizado. Los paquetes pendientes cambian
  custodia mediante doble cotejo y el historial conserva quién entregó y quién
  recibió.
- Una ruta transferida sigue siendo una ruta operativa; cada motorizado liquida
  únicamente lo que cobró. Grupo GF emite una sola liquidación diaria a cada
  tienda.
- Si Roy es responsable y Daysi o Frankz completa un reporte por él, se guardan
  por separado `motorizado_responsable` y `reportado_por`, con motivo, fecha y
  evidencia. Nadie suplanta al motorizado.

**Permiso de reporte por coordinación (12-09-2026):** Equipo expone la casilla
«Reportar entregas de rutas» (`routes.report_others`) por persona y organización.
La lectura de concesiones filtra explícitamente al usuario autenticado; poder
consultar permisos de compañeros como administrador no concede esos permisos.
No viene incluido en admin ni en routes.manage. El owner lo conserva, revocable
desde Equipo. Permite registrar/corregir paradas de rutas en curso de su
organización desde Rutas → Reportar entregas, sin crear una ficha de motorizado.
Reutiliza las exigencias de evidencia del reparto y exige un motivo adicional.
El responsable permanece en la ruta; `reported_by` y el actor del evento son el
usuario autenticado que reportó. No concede validación bancaria, cierre de ruta
ni liquidación. Rutas cerradas o todavía no recibidas no admiten reportes.

Para Grupo GF, `delivery_routes` representa la ruta diaria y cada
`dispatch_manifests` vinculado representa una carga numerada. Completar la
recepción incorpora automáticamente sus paradas a `/reparto`, dentro de la misma
transacción que transfiere custodia. Los otros couriers conservan sus manifiestos
diarios actuales. Nunca se borran historiales ni se sustituyen paradas reportadas.

**Reintento con el mismo envío (25-09-2026, 0192):** un paquete «no entregado»
vuelve a salir otro día con el mismo `shipment_id` (la guía y el QR no cambian).
La recepción de la nueva caja le suma una parada nueva en la ruta del día; la
parada anterior queda como historia. Lo único prohibido es que un envío tenga
dos paradas **pendientes** a la vez (`delivery_stop_shipment_open_uniq`): el
mismo paquete en dos rutas abiertas. Antes el índice cubría toda la historia y
el último escaneo de «Recibir mi caja» fallaba con `delivery_stop_shipment_uniq`.

### 29.6 Agenda y cambios posteriores al corte

- Una tienda puede pactar fecha y una franja amplia de aproximadamente cinco
  horas.
- Un cambio después de las 11:30 requiere aprobación de Grupo GF y muestra
  distrito, tarifa y fecha resultantes.
- Solo se aprueba dentro del día si el destino permanece en la ruta del mismo
  motorizado.
- Si el cambio exige pasar a otro motorizado, se cancela la guía logística y la
  solicitud vuelve a `Por agendar`. Nunca se mueve silenciosamente entre rutas.
- La tienda o Grupo GF pueden reprogramar, y siempre se registra actor y motivo.
- Cancelar una solicitud no tiene costo, incluso si el motorizado ya salió. El
  paquete puede retornar al almacén al día siguiente y la cancelación logística
  no cancela por sí sola el pedido Shopify.
- En una tienda cliente de otra organización, la tienda asigna, cancela y
  decide el reintento (§29.15.2, §29.15.5).

**Programar la salida sin tomar el pedido (29-09-2026).** En Despacho del día,
el calendario de «Desde la lista» **solo guarda el día** en que deben salir los
pedidos marcados, con actor y motivo obligatorio (`gf_dispatch_programs`,
0199; evento `dispatch_programmed`). No toma el pedido, no reserva tarifa ni
crea salida: sigue disponible. Uno ya tomado mueve también su
`logistics_requests.scheduled_for`, para que las dos fechas digan lo mismo.
Uno que ya está en la caja de un motorizado no se programa: primero se quita
de la caja. La fecha no puede ser anterior a hoy. «Quitar la fecha» devuelve
el pedido a su apartado de siempre (`dispatch_program_cleared`).

Ese día el pedido aparece en **«Programados hoy»**, el primer apartado de la
cola (§29.13); si el día pasa sin que salga, sigue ahí con la chapa «vencido».
La programación se borra cuando el pedido entra en la caja de un motorizado.

**Asignar un programado a la caja de otro día avisa y pide confirmar.** Desde
la lista, una franja ámbar sobre la tabla dice cuáles son y para cuándo
estaban, con «Asignar igual», «Asignar solo los otros» y «Cancelar». Por QR,
la línea del escaneo dice «Programado vie 02/10 → Asignar igual» y no toma
nada hasta que se confirma; igual en «Agregar pedidos» de la caja. El servidor
repite la comprobación (`programNeedsConfirm`): un programado vencido no pide
confirmar, porque que salga es justo lo que falta. Lo confirmado queda como
`dispatch_program_overridden`, con el día programado y el de la caja.

### 29.7 Resultado y evidencia

El resultado lo reporta el motorizado o, excepcionalmente, Daysi/Frankz en su
nombre. Fecha y hora se capturan automáticamente. Una entrega exige:

- foto del paquete entregado;
- comprobante del pago cuando corresponde;
- coordenada GPS tomada al reportar; y
- actor real que cargó la evidencia.

La tienda ve estado y evidencia, no nombre/teléfono del motorizado ni ubicación
en vivo. El cliente final recibe un enlace público que muestra solo estados.
Lo que se oculta a una tienda cliente de otra organización, y dónde, está en
§29.15.3.

Catálogo inicial y regla de cobro:

| Resultado | Costo de envío |
| --- | --- |
| Entregado | Tarifa del distrito |
| Rechazado por el cliente | Misma tarifa distrital que una entrega, una vez por pedido y ruta/día |
| No responde | S/ 0 |
| Cliente ausente | S/ 0 |
| Dirección incorrecta | S/ 0; Grupo GF absorbe el intento y se identifica la falla de origen |
| Reprogramado | S/ 0; conserva el paquete armado |
| Cancelado por la tienda | S/ 0 |
| Incidencia del motorizado | S/ 0 |
| Paquete dañado o faltante | Observado |

Un rechazo exige motivo y evidencia. Si el cliente rechaza en días distintos,
se cobra como máximo una vez en cada ruta/día. Otros intentos no entregados
siguen sin costo aunque se repitan.

En una tienda cliente de otra organización, «Reprogramado» conserva el paquete
armado solo si la reprogramación está registrada cuando el paquete vuelve a la
oficina; si no, se desarma (§29.15.5).

**La foto del rechazo se pide al reportarlo, no al liquidar (28-09-2026,
decisión de Frankz).** El teléfono pedía foto a la entrega pero no al
rechazo: al marcar «No entregado» solo mostraba motivo y nota, y el campo de
foto aparecía únicamente cuando otra persona reportaba por el motorizado. La
exigencia vivía solo en la liquidación, días después, cuando ya no había
puerta que fotografiar. Resultado: de 204 rechazos reportados en toda la
historia, ninguno tenía foto, y el 28-09 siete rutas abiertas no se podían
liquidar por eso.

- Al marcar «Rechazó el pedido» el teléfono muestra «Foto del rechazo», y el
  reporte no se guarda sin ella. La regla está en `validateStopReport`, que
  usan el teléfono y el servidor.
- El error de liquidación nombra cada parada sin foto con su pedido, en vez
  de «Falta evidencia de entrega o rechazo» a secas.
- Los rechazos anteriores sin foto se completan con «Corregir» en la ruta del
  motorizado, que ahora sí muestra el campo, o desde «Reportar entregas». La
  foto puede ser la del paquete devuelto.
- No cambia qué es un rechazo ni cómo se cobra. Si una anulación de la tienda
  debe dejar de reportarse como rechazo, es otra decisión.

**Excepción: los rechazos de rutas anteriores al 28-09-2026 no exigen foto
(28-09-2026, decisión de Frankz).** Esos rechazos se reportaron cuando el
teléfono todavía no pedía foto, y ya no hay puerta que fotografiar: 16 de
ellos frenaban siete rutas del 23 al 26/09. Ahora:

- Para terminar la ruta, un rechazo sin foto solo cuenta si la ruta es del
  28/09 o después (`REJECTION_PHOTO_FROM` y `rejectionNeedsPhoto` en
  `lib/routes.ts`, que usan el cierre y el panel «Para terminar la ruta»).
- Para aprobar el pago del motorizado, lo mismo: `rider_pay_preview` (0197)
  deja de contarlos en `evidence_missing`. Los cierres ya aprobados no cambian.
- La fecha que manda es la de la ruta, no la del reporte: un rechazo de una
  ruta del 28/09 exige foto aunque se haya reportado antes de que el teléfono
  la pidiera.
- La entrega sin foto y el Yape sin captura se siguen exigiendo siempre, sea
  cual sea la fecha. El rechazo exento se sigue pagando al motorizado y se
  sigue cobrando a la tienda como antes; solo deja de pedirse su foto.
- En la tabla de la ruta, ese rechazo lleva una cámara tachada con el aviso
  «Sin foto · no se exige (antes del 28/09)» en vez del ícono ámbar de «Falta
  la foto».

**Excepción: lo cargado desde el cuaderno no exige foto (03-10-2026, decisión
de Frankz).** Alexis todavía no usa la app: sus rutas del 01/10 y del 02/10
existían en Kapta, con la caja cotejada y recibida, pero nadie reportó las
paradas desde el teléfono. Se cargaron desde la foto de su hoja, y de ahí no
sale foto de entrega que pedir.

- Una parada reportada con `reported_by` vacío es una parada **cargada desde
  el cuaderno**. Es la misma marca del backfill histórico de Liquidaciones 2
  (§29.12), que la puerta al Master ya eximía de evidencia. La app nunca la
  deja vacía al reportar.
- No exige foto para terminar la ruta (`reportedFromNotebook` y
  `stopsMissingEvidence` en `lib/routes.ts`) ni para aprobar el pago del
  motorizado (`rider_pay_preview`, 0222). Se paga y se cobra a la tienda como
  cualquier entrega o rechazo. El Yape sin captura se sigue exigiendo.
- Quién la cargó no se pierde: queda en `delivery_stop_events.actor`, en el
  `stop_reported` de la actividad del pedido (`origen: cuaderno`) y en la nota
  de la parada.
- En la tabla de la ruta lleva la cámara tachada con «Sin foto · cargada desde
  el cuaderno». Corregirla desde la app la vuelve un reporte normal, que
  exige foto.
- Vocabulario de la hoja de Alexis: EFECTIVO y PAGO POS son entregas; RECHAZO
  y COBRO CAIDA, «Rechazó el pedido» (se pagan y se cobran, como en su hoja);
  CAIDA y ANULADO, «Otro» con la palabra en la nota (no se pagan ni se cobran;
  ANULADO no anula: solo Shopify anula, §9); NO CONTESTO, «No contesta»; REPRO,
  «Reprogramado». Lo que la hoja trae fuera de la caja del día no se carga
  como parada: §29.5 exige el cotejo.
- Excepción (04-10-2026, decisión de Frankz): un pedido asignado a la ruta de
  ese día en una carga que nunca se cotejó ni se recibió sí se carga, si la
  hoja dice que salió. La parada apunta a esa carga (`dispatch_manifest_id`),
  pero no se inventa el cotejo: la carga sigue sin recibir y se cancela vacía
  para poder terminar la ruta. Fue #KP136825, rechazado el 02/10 en la carga 2
  de Alexis.
- El paso a paso está en `docs/runbooks/cuaderno-a-rutas.md`.

**Excepción: el reprogramado que el motorizado conserva sale en su ruta
siguiente, ya cotejado (07-10-2026, decisión de Frankz).** Alexis no devuelve
a la oficina lo que el cliente pide para otro día: se lo queda y lo vuelve a
llevar, y su hoja del día siguiente lo trae. En Kapta el paquete seguía en la
caja del día anterior (§29.13: un no entregado vuelve físicamente a la
oficina), así que esas filas de la hoja quedaban fuera de la ruta y sin
cargar: #KP138029 (S/ 89) y #KP138037 (S/ 567) del 01/10, entregados el 02/10.

- Un «No entregado · Reprogramado por el cliente» que el motorizado conserva
  pasa a su ruta del día siguiente sin volver a la oficina. Si la hoja nombra
  un día («LUNES», «MIÉRCOLES»), pasa a la ruta de ese día. El día siguiente
  es aunque sea domingo: si la hoja muestra que salió, la ruta de ese día se
  abre con esa carga (el 04/10 de Alexis nació así, con 4 paquetes).
- El paquete sale de la caja anterior con motivo («Reprogramado…: Alexis se
  quedó con el paquete y sale en su ruta del dd/mm, ya cotejado»), y deja
  `carried_over` en esa caja y `package_removed` en el pedido. Entra en una
  carga adicional de la ruta siguiente, cotejada por oficina y por el
  motorizado: él ya lo tiene, no hay nada que cotejar. La carga pasa a
  custodia y nace la parada pendiente, como cualquier carga recibida.
- No queda «Por devolver»: en «Reparto y liquidación» la parada anterior dice
  **«Pasó a la ruta del dd/mm»** (`stopReturnState`, `lib/routes.ts`) y la
  columna «Devolver» de Rutas lo cuenta como resuelto
  (`lib/courier-route-ledger.ts`). La parada anterior se conserva: es la
  evidencia del intento y cuenta en la liquidación de ese día.
- Solo el reprogramado. «No contesta», «Otro» y el rechazo siguen volviendo a
  la oficina. Un pedido anulado en Shopify tampoco pasa aunque el motorizado lo
  siga cargando: va a «Devolución física pendiente» y hay que recibirlo
  (#KP138124, #AUR177704 y #KP138376 siguieron en la hoja de Alexis del 02 al
  04/10).
- Si la hoja del día siguiente no lo trae, no se pasa: se le pregunta a quien
  liquida, porque una parada sin reporte frena el cierre de esa ruta.

**La hoja del motorizado sin app se carga desde Kapta (08-10-2026, decisión de
Frankz).** Hasta el 07/10 cada hoja de Alexis se cargaba con SQL desde una
conversación con Claude. Ahora la carga cualquiera que arma rutas en Grupo GF
Courier (`routes.manage`), desde «Reparto y liquidación» de la ruta, con
«Cargar hoja»:

- **Fotos.** De una a cuatro capturas de la misma hoja, subidas de una en una
  al bucket privado `rider-notebooks`. Kapta las lee con visión
  (`lib/rider-sheet-vision.ts`): transcribe, no corrige ni inventa; lo
  ilegible queda vacío y lo completa una persona.
- **Cruce** (`buildNotebookPlan`, `lib/notebook-import.ts`). Por el código de
  OBSERVACIÓN; sin código, por nombre y monto solo si hay un candidato claro,
  marcado «por nombre». Cada fila cae en un grupo: pendiente de la ruta (se
  reporta), ya reportada (no se toca), reprogramado que conserva de una caja
  anterior (pasa a esta ruta, como arriba), anulado en Shopify, en otra caja,
  inexistente o sin código. Estas últimas no se cargan: se dice dónde está el
  paquete. Las paradas pendientes que la hoja no nombra se listan, y una fila
  sin código se puede asignar a mano a una de ellas.
- **Vocabulario.** El de arriba, más: SOLO ENTREGA, YAPE PROV y PAGADO son
  «Entregado · Sin cobro» (ya estaba pagado); NO ESTABA, DIRECCIÓN y SIN
  DINERO, su motivo; un día de la semana («MIÉRCOLES»), «Reprogramado» con el
  día en la nota. Lo que no se entiende («CAMBIO») queda sin decidir.
- **Avisos.** Cobro menor que el saldo (se carga y la nota lo dice), mayor que
  el saldo (no se carga), «Sin cobro» con saldo pendiente, plata anotada en una
  no entrega y un total escrito que no cuadra con la suma de las filas.
- **Aplicar.** Se revalida contra la base de ese momento. Los reprogramados
  pasan con `gf_carry_over` (0234): todo o nada, y nunca en una carga que
  Despacho todavía está armando. Cada parada se reporta por `writeStopReport`
  en modo cuaderno: `reported_by` vacío, sin foto ni captura, la nota «Cuaderno
  de X del dd/mm (punto N)… Cargado por Y el dd/mm» y `origen: cuaderno` con
  el id de la hoja en la actividad del pedido. Si quien liquida cambia lo que
  dice la hoja, la nota lo dice.
- **Auditoría.** `rider_notebook_imports` guarda las fotos, lo leído, la
  propuesta y lo aplicado. Una hoja se aplica una sola vez; si algo falló, se
  vuelve a leer y lo ya cargado sale como «Ya reportada».
- **Otro día.** «Día de la hoja» cruza con otra ruta del mismo motorizado. Si
  ese día no tiene ruta (salió solo con reprogramados), el traspaso la abre.
- Terminar la ruta y aprobar el pago siguen siendo de quien liquida. El SQL de
  `docs/runbooks/cuaderno-a-rutas.md` queda como respaldo.

### 29.8 Tarifas por distrito y comisión Yape

Grupo GF Courier cobra una tarifa por distrito/zona que **incluye IGV**. Debe
existir una tabla configurable, no constantes en código:

| Campo | Regla |
| --- | --- |
| Distrito | Ubigeo oficial; no texto libre como identidad |
| Zona | Agrupación opcional para edición masiva |
| Tarifa de entrega o rechazo | Un solo importe incluido IGV; ambos resultados cobran exactamente lo mismo |
| Tienda | Nula = general; informada = excepción contractual |
| Vigencia | Desde/hasta; una edición abre otra vigencia |
| Estado | Activa/inactiva, sin borrar historial |

El universo de la matriz se deriva de los pedidos de la organización que el
Master clasifica con `coverage = lima`. El distrito libre del pedido nunca se
muestra directamente: se resuelve contra el catálogo canónico y sus alias
(`Surco` → `Santiago de Surco`, `SJL` → `San Juan de Lurigancho`, etc.).
`Lurigancho Chosica` y `Chosica` comparten la tarifa canónica de `Lurigancho`.
Cada fila muestra también la cantidad histórica de pedidos Lima que la sustenta,
como señal de auditoría; los textos que no pueden resolverse se corrigen en el
Master y no crean distritos ni tarifas nuevas por accidente.

La disponibilidad es independiente de la tarifa. Un distrito puede pausarse de
forma general o solo para una tienda, con motivo obligatorio y fecha opcional de
reactivación. La pausa general prevalece sobre cualquier excepción contractual,
bloquea únicamente nuevas asignaciones y no altera rutas ya iniciadas. Poner una
tarifa en S/0 nunca pausa el servicio. Reactivar conserva el precio y registra un
nuevo evento; el historial de pausas y reactivaciones es append-only.

Precedencia: tarifa particular de la tienda y distrito, luego tarifa general de
Grupo GF Courier. Sin coincidencia se muestra `Sin tarifa configurada`, no S/0,
y se bloquea el cierre financiero. Daysi y Frankz pueden administrar tarifas;
la pantalla permite edición por zona e importar/exportar Excel.

La comisión general por pagos recibidos en el Yape de Grupo GF es **3.5 %**:

- se calcula solo sobre el importe efectivamente pagado por Yape;
- se redondea a dos decimales por operación;
- se descuenta en la liquidación diaria de la tienda;
- no se aplica a efectivo ni a un rechazo sin pago; y
- se conserva como regla con vigencia, aunque inicialmente sea general.

**Tiendas cliente de otra organización (§29.15.6).** Tienen su propia tabla
general de tarifas (la de externos), una comisión Yape general de 5 % y una
comisión POS fija de 5 %. La tabla interna y el 3.5 % siguen siendo de Aurela
y Kenku.

### 29.9 Liquidaciones y efectivo

Existen dos conciliaciones relacionadas, no intercambiables:

1. **Motorizado ↔ Grupo GF Courier**: cobros y evidencia de la ruta diaria.
2. **Grupo GF Courier ↔ tienda**: COD cobrado menos tarifa de entrega/rechazo y
   comisión Yape aplicable.

Ambas son diarias y requieren aprobación humana después de finalizar todas las
rutas. Una parada pendiente bloquea la liquidación. Daysi o Frankz pueden
completar el reporte faltante con la auditoría de §29.5; no existe cierre
automático silencioso.

El efectivo máximo planificado por motorizado es S/ 9,000 por ruta:

- advertencia desde S/ 4,000;
- bloqueo de nuevas asignaciones al superar S/ 9,000; y
- Daysi o Frankz pueden autorizar una excepción con motivo auditado.

**Límite subido de S/ 5,000 a S/ 9,000 (28-09-2026, decisión de Frankz).** Una
ruta de Roy con 29 paquetes llegaba a S/ 5,363.10 y el escáner la bloqueaba en
plena salida. Los dos montos viven en `logistics_providers`
(`cash_warning_amount`, `cash_limit_amount`) y se leen en cada asignación, así
que cambiarlos no requiere desplegar; se cambió con un UPDATE sobre la fila de
Grupo GF, igual que el modo de recepción de §29.13. El aviso se quedó en
S/ 4,000. Un operador nuevo sigue naciendo con S/ 4,000 / S/ 5,000, que son los
valores por defecto de 0134.

Neto de la tienda:

```text
COD cobrado
− tarifa de entrega o rechazo
− 3.5 % del importe recibido por Yape
= neto diario para la tienda
```

Si una fila no tiene tarifa, evidencia o resultado definitivo, la liquidación
completa permanece abierta. Las correcciones conservan lo declarado, el valor
anterior, actor, motivo y fecha como ya exige §14.

Para una tienda cliente de otra organización, el neto también descuenta la
comisión POS y el producto de Proveeduría entregado. Además, entra a una
cuenta corriente, el saldo a favor se deposita a diario y aprobar cierra
financieramente sus pedidos (§29.15.8).

**Pago por motorizado desde el Tarifario (22-09-2026).** La tabla de tarifas
de Grupo GF suma una columna **«Pago a [motorizado]»**: el motorizado se
elige en la cabecera y cada distrito muestra su tarifa personal vigente en la
fecha de «Ver y registrar desde» —la propia del distrito o, en gris como
sugerencia, la general del motorizado— y permite registrar una nueva. Escribe
en `rider_pay_rates` (0162) con `rider_pay_save_rate`: agrega una versión
desde esa fecha, nunca sobrescribe, y exige `costs.manage`. La liquidación del
motorizado sigue resolviendo como siempre (la del distrito gana a la
general). Es lo que se le paga al motorizado, no el precio que cobra Grupo GF
a la tienda (la columna «Entrega o rechazo»). En «Reparto y liquidación», la
tarifa de cada parada dice si viene del **distrito** o es la **general**, y
avisa en ámbar cuando el distrito del pedido no se reconoce (se aplica la
general) o cuando el monto calculado —o el aprobado y congelado— ya no es el
que rige con las tarifas registradas (`checkStopRate`). Un cálculo aprobado no
cambia solo: la diferencia se corrige con un adicional o reabriendo la ruta.

### 29.10 Acceso y administración

#### Acuerdo 13-09-2026: cobro en puerta y ganancia del motorizado

- Reportar una entrega exige elegir el medio de pago, sin efectivo preseleccionado.
  El importe sugerido es el saldo después de pagos validados o prepago checkout,
  nunca el total si ya hubo adelanto. Pagos pendientes se muestran como pendientes,
  no se descuentan como validados. Si el saldo no puede comprobarse no se inventa.
- `Sin cobro` guarda exactamente cero, tanto en la parada como en su historial.
  El monto reportado no equivale a ingreso bancario validado.
- La tarifa que Grupo GF cobra a la tienda es independiente de la ganancia del
  motorizado. El tarifario personal usa ficha estable del motorizado, distrito
  canónico opcional y vigencia. La excepción de distrito gana a su tarifa general.
  Entregado y rechazado por el cliente pagan el mismo importe por punto; los demás
  intentos no pagan automáticamente. Roy acordó S/8.50 por entrega o rechazo.
  Alexis cobra lo de su hoja desde el 01/10: S/ 10, S/ 13 en Puente Piedra y
  Carabayllo y S/ 15 en Lurigancho (decisión de Frankz, 03-10-2026).
  No se asigna una tarifa por coincidencia de nombre ni se modifica historia.
- En Rutas se configuran tarifas personales con `costs.manage` en la organización
  correspondiente. Una nueva tarifa crea una versión y exige motivo. Sin tarifa
  personal aplicable, el pago queda pendiente, no cero ni tarifa del courier.
- Un adicional por espera, retorno u otra excepción se aprueba explícitamente con
  `settlements.close`, importe positivo y motivo. Se liga a la ruta y al punto,
  identifica al aprobador y no sobrescribe la tarifa. Su anulación es otro evento.
- La liquidación del motorizado es una por ruta diaria, aunque mezcle tiendas o
  cargas. Muestra por punto tarifa y versión, adicional/motivo/aprobador, ganancia,
  efectivo reportado y cobros directos reportados separados. El neto de efectivo
  es efectivo menos ganancia: positivo entrega el motorizado, negativo paga GF.
- Terminar la ruta es un cierre operativo. Aprobar el cálculo diario es un acto
  financiero distinto con `settlements.close`: congela el desglose y exige ruta
  terminada, evidencia, tarifas y confirmación de la versión vista. No registra
  automáticamente un depósito, un pago al motorizado ni validación bancaria.
  Los lotes por tienda originados en ruta no vuelven a generar un pago personal
  con el motor antiguo; se remiten a este cierre diario para evitar duplicarlo.
- Las rutas y reportes históricos no se corrigen automáticamente. En particular,
  el caso Roy/AUR176840 requiere verificar Efectivo/Yape antes de aprobar cifras.

- Daysi administra tiendas cliente, motorizados, capacidad, asignaciones, rutas,
  contratos y tarifas de Grupo GF Courier.
- Frankz conserva permiso de propietario y excepción.
- Una tienda ve únicamente sus solicitudes, inventario asociado, estados,
  evidencias, cargos y liquidaciones.
- El operador ve solo los datos necesarios de las tiendas con contrato vigente.
  En una tienda cliente de otra organización, eso es solo los pedidos que la
  tienda le asignó (§29.15.3).
- El motorizado ve únicamente sus cargas y paradas activas.
- Grupo GF puede suspender una tienda por deuda, incidencias o problemas de
  inventario; la suspensión no borra pedidos ni liquidaciones existentes.

### 29.11 Implementación incremental

El orden obligatorio evita reescribir las pantallas sobre identidades ambiguas:

1. Crear operador, tienda cliente, contrato, tarifa y comisión con vigencia.
2. Formalizar «motorizados propios» como Grupo GF Courier conservando ids e
   historial. **Compatibilidad aplicada:** nuevas altas/ediciones guardan la
   afiliación formal y las fichas antiguas nulas siguen resolviendo al mismo
   operador; no se duplican personas ni rutas.
3. Vincular ruta diaria, cargas/manifiestos y paradas; retirar la doble verdad
   entre `delivery_routes` y `dispatch_manifests` solo después de comprobarla.
4. Implementar doble liquidación y límites de efectivo.
5. Publicar portal de tiendas, seguimiento por estados y entrada Shopify/API/
   Excel. Va en dos partes: primero las tiendas cliente con Shopify en su
   propia organización (§29.15); después la entrada por API y Excel.
6. Añadir bolsas y reservas opcionales; el inventario estricto no bloquea las
   primeras fases.

Cada fase debe ser compatible con Aurela y Kenku y no debe convertir una
solicitud logística externa en un pedido comercial de Shopify.

### 29.12 Convergencia con Liquidaciones 2: la parada es la verdad

Decisión del 19-09-2026. El mismo hecho físico —el motorizado fue a la casa
de la clienta y cobró— se escribía en dos modelos que no se hablaban: la
parada de Rutas (`delivery_stops`: tipada, con evidencia obligatoria y
validación contra el saldo real, la que este módulo ya usa) y la fila de la
hoja cuaderno de Liquidaciones 2 (texto libre, alias, observaciones). Dos
pantallas del motorizado y dos puertas al Master con guardas distintas.

**Rutas manda.** La parada es el registro canónico del resultado; la hoja de
Reparto propio es una vista con vocabulario y cuadre encima de ella:

- La parada aprende lo que solo la hoja sabía decir (0180): `written_status`
  (lo escrito, literal), `written_status_code` (el estado del dominio Reparto
  propio al que resolvió; null = sin equivalente) y `written_payment`. El enum
  de tres estados y el motivo del catálogo siguen mandando para el cierre de
  ruta; el detalle («LO DEJA», «CEL APAGADO») ya no se pierde.
- Cada reporte de parada deja `stop_reported` en la actividad del pedido:
  quién reportó, resultado, medio y monto cobrado, evidencia y nota. Hasta el
  22-09-2026 era solo información y el Master cambiaba únicamente al cerrar la
  ruta; desde v1.14 el resolver lee esa señal y mueve la etapa (§29.13, «La
  etapa sigue al motorizado»). El cierre de la ruta sigue siendo lo que
  liquida, por la puerta única. La foto y el comprobante se ven desde Reparto
  y liquidación y desde la ficha del pedido (`GET /api/reparto/foto`, solo
  para quien puede ver la parada).
- Una ruta que nace del cuaderno también recibe su **caja**
  (`scripts/backfill-boxes-from-routes.ts`, runbook `docs/runbooks/cuaderno-a-rutas.md`):
  un ítem por parada, cotejado y recibido a la hora del reporte, con la custodia
  en el motorizado. Sin ese paso la ruta queda «sin caja» y el panel de la caja
  abre vacío. Un paquete que sale varios días se retira de la caja del día
  anterior al final de ese día si no se entregó; la lista de Rutas cuenta lo
  que estaba en la caja ese día.
- Cada fila de cuaderno apunta a su parada (`sheet_rows.stop_id`, única). La
  sincronización parada → fila corre al reportar, al cerrar la ruta y al abrir
  la hoja del mes; una fila editada a mano no se pisa. Las filas del Excel
  histórico sin parada siguen valiendo tal cual.
- Una edición de la hoja sobre una fila atada se escribe **primero en la
  parada por el mismo camino que /reparto** (`lib/stop-report.ts`: ruta en
  curso, saldo, evidencia, catálogo); si Rutas rechaza, la edición falla.
- **Una sola puerta al Master** (`lib/master-door.ts`) para el cierre de
  ruta, Liquidaciones 1 y Liquidaciones 2, con las guardas unidas: la parada
  debe estar entregada; con evidencia cuando el reporte es real
  (`reported_by` presente) y se exige, como en las cargas de Grupo GF; y sin
  observación abierta en la fila. Las paradas de backfill histórico
  (`reported_by` null, ruta con nota «Completada desde el cuaderno histórico»)
  no pueden tener foto y no se les exige.
- **Una sola pantalla del motorizado**, /reparto: escribe como en el cuaderno
  (texto libre con sugerencias de su hoja), el detalle del pago, y el motivo
  obligatorio cuando cobra distinto al total. Un pedido que lleva sin haber
  pasado por despacho se añade como parada en su ruta del día; un punto sin
  pedido Shopify (Kast) vive solo en la hoja, porque la parada exige pedido.
  /reparto/cuaderno redirige.
- **Asimetría resuelta (v1.23)**: «rechazado» y «cancelado» del cuaderno se
  traducen al motivo `rechazado` de Rutas, con el que el cierre de ruta
  anulaba el pedido; desde la hoja, «Aplicar al Master» nunca anula (§30.3).
  Desde la v1.23 ninguno anula: solo Shopify anula (§9).
- **Límites de efectivo (§29.9) activos**: al asignar a la ruta diaria se suma
  el efectivo previsto (lo que ya lleva más lo nuevo, sin pedidos pagados en
  Shopify); pasa del umbral → aviso; pasa del límite → rechazo salvo
  autorización explícita de quien administra el operador.
- **Backfill de la historia**: `scripts/backfill-stops-from-sheets.ts` crea
  rutas cerradas y paradas a partir de las filas históricas con pedido, sin
  tocar el Master ni las liquidaciones. Un pago sin dato en una fila
  entregada queda como `efectivo` en la parada (la parada lo exige) con
  `written_payment` null, para que se vea que no se escribió.

### 29.13 Despacho en dos pasos y el gesto único (19-09-2026)

Auditoría y rediseño en `docs/plan/despacho-crm.md`. Llevar un pedido de
«disponible» a «en poder del motorizado» costaba 9-10 clics en tres pantallas
y dejaba tres huecos: el motorizado no podía decir «no lo recojo», mover un
paquete entre cajas no dejaba evento, y el mismo gesto de escanear o
fotografiar vivía en tres componentes que decidían por su cuenta.

**Dos pasos para el supervisor, en una pantalla, con la pistola en la mano.**
La pestaña «Despacho del día» de Grupo GF Courier abre en **modo escaneo**: el
supervisor elige motorizado (y el día de la caja, hoy por defecto, nunca un día
ya pasado) y escanea QR tras QR. Ese día manda también después del corte de
las 11:30: el corte rige lo que se toma sin despachar todavía, no a la mesa
que ya tiene el paquete en la mano; si la solicitud estaba prevista para otro
día, se mueve al de la caja con `logistics_request_rescheduled`. Cada lectura, en un
solo gesto, **toma** el pedido si hacía falta, lo **pone en la caja** del
motorizado del día (`scanAssignToRider`, sobre las mismas acciones de tomar
y asignar; eventos `logistics_request_accepted`, `dispatch_route_assigned`).
**Asignar no coteja** (decisión del 22-09-2026): hasta esa fecha el mismo
escaneo dejaba el paquete «cotejado por oficina» y la caja se saltaba el
control físico. Ahora asignar por QR y desde la lista es lo mismo, y alguien
en oficina confirma después, en «Verificar caja», escaneando el QR o
tecleando el código, que cada paquete está de verdad en la caja física del
motorizado (`office_checked`). Con el modo `exigir` la caja no sale sin ese
100 %. El escaneo de asignación **no espera al servidor para responder**:
cada QR aparece al instante como «asignando…», el número «N en la caja de
Roy» sube en ese momento y la cámara acepta el siguiente; los QR se procesan
en cola, en orden, sin descartar ninguno. En el servidor el escaneo hace un
solo control de permisos, no reconstruye la página de Grupo GF y deja el
recálculo del Master para después de responder (`after()`); el navegador
refresca una sola vez, dos segundos después del último resultado. Antes cada
QR tardaba 6-7 s porque la página entera (≈1.700 pedidos) se reconstruía
tres veces por escaneo. «Verificar caja», «Recibir carga» y «Recibir mi caja» usan la misma
cámara en serie que la asignación: queda abierta tras cada lectura y debajo
dice «Verificados 3 de 4 · faltan 1» (o «Recibidos …»), y se cierra con
«Listo» o sola al completar la caja.

**Lecturas seguidas sin esperar a la red (01-10-2026).** Asignación, cotejo y
recepción conservan cada QR distinto en una cola y procesan las confirmaciones
en orden. Un código repetido mientras está pendiente no se envía dos veces.
El aviso encima del visor muestra al instante el último QR leído y cuántos
siguen **por confirmar**; leer no equivale a guardar. El cotejo suma al contador
solo las respuestas exitosas, y recarga la caja al terminar la cola, sin
descartar un QR porque la respuesta anterior o la recarga siguen en curso.
Cada lectura conserva la caja, motorizado y paso elegidos al capturarla. Si una
falla, su aviso permanece visible aunque las siguientes se guarden; ese código
se puede reintentar y solo desaparece del aviso cuando se confirma correctamente.
La cámara no se cierra automáticamente mientras haya confirmaciones pendientes.
Al volver a la app después de ocultarla, se vuelve a abrir la cámara.

La lista de resultados de «Por QR» y su contador se separan por organización,
motorizado y día de la caja. Cambiar de destino muestra solo sus lecturas;
volver al anterior recupera las suyas. Una respuesta tardía se queda en el
destino original y no aparece ni suma en el nuevo. «Limpiar lista» afecta
únicamente al destino visible. Los códigos escaneados sin motorizado siguen
en la bandeja y se asignan al motorizado elegido.

**Agregar pedidos dentro de la caja (01-10-2026).** El paso de Rutas también
usa escaneo continuo: muestra «Asignando…» desde la lectura y cuenta únicamente
los paquetes confirmados de la tanda, sin duplicar un paquete repetido. No
cierra la cámara al guardar; actualiza la caja una vez al cerrar la cámara
y vaciar la cola, tras una pausa de 250 ms. Con lector o ingreso manual, basta
con vaciar la cola. Mientras quedan guardados o la actualización pendientes no se cambia
de paso ni se ejecutan correcciones de otras filas. La autenticación del
cotejo se comparte solo dentro de cada operación; las búsquedas conservan
RLS. La asignación reutiliza el identificador del proveedor durante la toma
y consulta en paralelo los datos independientes, conservando la validación
de proveedor activo, custodia, programación y efectivo antes de asignar.

Si el pedido se tomó días atrás y su fecha prevista ya pasó, la caja no es la de
aquel día (cuya ruta está liquidada) sino la de hoy o la elegida: la fecha
prevista se mueve hacia adelante y queda `logistics_request_rescheduled` en el
historial. Nunca se mueve hacia atrás. El
límite de efectivo de §29.9 se avisa en línea y bloquea salvo autorización
explícita. La lista viva dice qué pasó con cada QR: asignado y cotejado; ya
estaba en esa caja; está en la caja de otro motorizado (y ofrece moverlo); no
elegible con el motivo; o QR desconocido. Sin motorizado elegido, los QR se
guardan en una bandeja y se asignan todos al elegirlo («escanear primero»).
La lista con selección múltiple queda como vía secundaria. Desde el 22-09-2026
las tres vistas van en **una sola columna con tres pestañas** —«Asignación por
QR», «Desde la lista» y «Cajas de hoy» con el número de paquetes del día en un
círculo— en vez de la lista a media pantalla y las cajas a la derecha; «Desde
la lista» es una **tabla de columnas** (pedido, tienda, cliente, distrito,
estado, creado, sale, venta, tarifa), con anchos fijos para lo corto y
flexibles para el resto, y el texto que se trunca se lee entero al pasar el
ratón. En «Cajas de hoy», las cajas por motorizado con el cotejo de oficina en
línea para lo que faltara; desde la misma fila un paquete se **quita** (con motivo,
`package_removed`) o se **mueve** a otro motorizado
(`dispatch_route_reassigned`, con origen y destino). Mover abre la carga del
destino antes de retirar del origen: si el destino ya está en cotejo, no se
toca nada, igual que al asignar (§29.5).

**Un paso para el motorizado, antes de la ruta.** Mientras su carga tenga
algo verificado por oficina y siga sin custodia, `/reparto` abre en «Recibir mi
caja»: un escaneo por paquete y, por paquete, «No lo recojo» con un motivo
corto (no está en la caja, dañado, no cabe, otro). Desde 0196 eso empieza con
la caja todavía en cotejo: lo que oficina no verificó se ve «esperando a
oficina» y no se recibe hasta que lo coteje. El rechazo (0182, `gf_rider_decline`)
retira el paquete de la carga con rastro «No recogido por X: motivo», deja
`pickup_declined` en el pedido, devuelve la solicitud a `accepted` con
observación —reaparece en «por asignar» y el supervisor la asigna a otro— y
libera la salida para otra caja el mismo día. **El 100 % se calcula sobre los
aceptados**: con lo demás recibido, la custodia pasa en el mismo acto y las
paradas se crean solo para lo aceptado. La ruta aparece recién con la custodia
cambiada. Un paquete ya recibido no se rechaza desde el teléfono: lo retira el
supervisor.

**Reportes anteriores sin recibir la caja de hoy (01-10-2026).** En modo
`exigir`, «Recibir mi caja» permite elegir una ruta propia de un día anterior
a hoy en Lima para completar sus reportes. La selección explícita de esa ruta
no exige escanear la carga pendiente de hoy; sus permisos de reporte y cierre
siguen vigentes (una ruta cerrada continúa siendo de consulta). Al volver a la
ruta de hoy o a `/reparto`, se muestra otra vez la recepción mientras quede
pendiente. Elegir otro día no recibe paquetes, no cambia custodia ni elimina
historial. Un id de ruta ajeno, inválido o sin acceso no evita el bloqueo.

**La verificación del motorizado tiene tres modos, y se deciden en datos.**
`logistics_providers.rider_pickup_mode` (0185; reemplaza el booleano
`rider_pickup_check_required` de 0183, migrado `true`→`exigir` y
`false`→`ninguno`) gobierna qué hace el motorizado con su caja. Se lee en un
solo sitio en código (`riderPickupMode`, `lib/grupo-gf-courier-route-access.ts`)
y en uno en SQL (`gf_rider_pickup_mode`); sin proveedor se asume `exigir`.

- **`exigir`**: todo como se describe arriba. Oficina coteja, el motorizado
  escanea su caja desde «Recibir mi caja» y la custodia cambia al 100 % de los
  aceptados; la ruta aparece recién entonces.
- **`confirmar`** (valor de producción del 19-09-2026 al 22-09-2026, que
  vuelve a `exigir` para que oficina verifique toda caja antes de que salga): **basta con
  asignar y nada bloquea la ruta**, pero el motorizado dice **«Lo llevo»** por
  cada pedido al sacarlo del almacén y meterlo en la caja de la moto. En cuanto
  el supervisor pone paquetes en la caja del día, la custodia pasa
  (`gf_assign_custody`, nota «Custodia al asignar: el motorizado confirma cada
  paquete al llevarlo»), el trigger crea las paradas y `/reparto` muestra la
  ruta con cada parada **«Por confirmar»**. En la parada, «Lo llevo» abre el
  gesto único (`motorizado_recepcion` sin caja → `gf_rider_confirm_pickup`, que
  marca `pickup_checked_at` y deja `pickup_checked` con la nota «Lo lleva
  Roy»); «Confirmar todos» en la cabecera abre el mismo escáner en **modo
  continuo**: la cámara se queda abierta tras cada lectura, ignora el mismo QR
  repetido seguido, muestra bajo el visor «Confirmados X de N · faltan Y» con
  su barra. La última lectura (también los errores, sin cerrarse) aparece en una
  franja encima del visor, incluso sin un contador de avance. La cámara conserva
  la misma sesión al actualizar los resultados y ofrece «Reiniciar cámara» si
  se interrumpe. Se cierra con «Listo» o sola un segundo después de confirmar
  el último. El
  escaneo de asignación de Despacho del día usa el mismo modo con «N en la
  caja de Roy». **«No lo llevo»** con motivo (`gf_rider_decline`, que en este
  modo admite la caja en custodia) retira el ítem, **borra su parada si sigue
  pendiente**, devuelve la custodia a la empresa y la solicitud vuelve a «por
  asignar» con el evento `pickup_declined` («No lo llevó Roy: motivo»). Ese
  paquete se puede volver a asignar a cualquier motorizado, incluida la misma
  caja del mismo día: la fila retirada revive (0187) y el rechazo anterior
  queda solo en el historial. Lo
  asignado y no confirmado es «no se lo llevó»: en «Despacho del día» cada caja
  muestra **confirmados/asignados** junto a los cotejados y un desplegable
  **«Sin confirmar por Roy · N»** con «Mover a…» y «Quitar»
  (`gf_supervisor_withdraw`: mismo retiro, con `package_removed` «Retirado sin
  confirmar…»); lo ya confirmado no se retira desde ahí. Una parada sin
  confirmar **se entrega igual**: al reportarla, `delivery_stops.pickup_confirmed`
  guarda si había «Lo llevo» en ese momento y, si no lo había, la bitácora de
  la parada y el pedido (`delivered_unconfirmed_pickup`) dicen «Entregado sin
  confirmar recojo». El paquete sumado a una caja ya en custodia
  (`gf_add_item_in_custody`) también nace por confirmar.
- **`ninguno`**: basta con asignar y no se pide nada más (lo que 0183/0176
  llamaban «flag apagado»): custodia al asignar con la nota «verificación del
  motorizado desactivada», paquetes sumados ya cotejados y recibidos, y ninguna
  pertenencia se altera una vez que la caja salió.

En `confirmar` y `ninguno` el cotejo de oficina posterior se registra como
«registro opcional», y hay **una sola carga por motorizado y día** (0184): si
vuelve a la oficina, los paquetes nuevos se suman a la misma carga y ruta
(`gf_dispatch_load_open` la reutiliza; `gf_add_item_in_custody` mete el paquete
con su parada sin duplicar) y el cierre es por día. En `exigir` una carga en
custodia sigue abriendo una carga adicional, como en §29.5. El modo se cambia
sin desplegar:

```sql
update logistics_providers set rider_pickup_mode = 'exigir'    where code = 'grupo-gf-courier'; -- verificación antes de la ruta
update logistics_providers set rider_pickup_mode = 'confirmar' where code = 'grupo-gf-courier'; -- «lo llevo» por paquete (producción)
update logistics_providers set rider_pickup_mode = 'ninguno'   where code = 'grupo-gf-courier'; -- basta con asignar
```

**Despacho absorbe las pestañas anteriores (19-09-2026).** «Pedidos
disponibles» y «Pedidos tomados» salen de la barra de Grupo GF Courier y
quedan como «vista anterior» bajo «⋯ Más vistas» (mismo `?tab=`, con una nota
arriba). Lo que aportaban vive en Despacho del día: en la fila de «Desde la
lista» el teléfono y la fecha de creación, la búsqueda por teléfono, la chapa
«salida previa» —el mismo «Con salida previa» de la vista anterior; hasta el
22-09-2026 decía «2.º intento»— con su filtro; «N sin condiciones» junto al
contador abre la lista de excluidos con el motivo de cada uno (tarifa
faltante, distrito inválido, servicio pausado, ya en caja, sin salida
armable) y enlace al Tarifario; un picker «Filtros» (tienda, distrito, con
salida previa, armados, tomados sin caja, fecha de creación) con chips; y tiles de
métricas encima de Asignar, una por filtro con su cantidad, que abren la lista
o las cajas ya filtradas.

**Etapa, subetapa y fecha pactada en el picker de Filtros (22-09-2026).** El
flotante «Filtros» de «Desde la lista» abre con tres grupos de chips como los
del Master (§6), antes de tienda, distrito y fecha de creación: un solo sitio
para filtrar. **Etapa** —las seis macroetapas numeradas con «N pedidos»,
contadas sobre **todos los pedidos de Grupo GF**: la cola de asignación
(Preparación · por generar rótulo / por armar, Por despachar · listo para
asignar) más los que ya salieron con una caja del courier, en la etapa en que
el Master los tenga (En curso, Por cerrar, Finalizado). Sin ninguna etapa
elegida la lista es la cola de asignación, que es para lo que está la
pantalla; elegir una etapa abre esa etapa entera, y los pedidos que ya
salieron se listan **para seguimiento, sin casilla**: su subetapa del MOM, el
motorizado, la caja del día y si «lo lleva», está cotejado o sigue sin
cotejar—, **Subetapas** —solo con una etapa elegida, y son las de esa etapa en
el orden del MOM (aunque estén en cero); si una fila trae otra por un dato
viejo del Master, aparece detrás; cambiar de etapa apaga las subetapas que
dejan de verse— y **Fecha pactada** —Vencidos, Hoy, Próximos sobre la salida
prevista: la de la solicitud tomada o, si el pedido sigue disponible, hoy o
mañana según el corte de las 11:30; «vencido» es un tomado cuya salida ya
pasó—. Dentro de cada grupo se encienden varios chips a la vez (basta con
cumplir uno) y los grupos se combinan entre sí y con el resto del picker, la
búsqueda y las tiles; sin ningún chip encendido el grupo es «todas», y el
total es «N en cola» (o «N pedidos en esa etapa») bajo la búsqueda. **Cada
chip lleva su cantidad facetada**: cuántas filas quedarían al tocarlo con el
resto de filtros tal como están, sin contar los chips de su propio grupo, de
modo que el número de un chip encendido coincide con el total. Un chip en
cero se muestra apagado; uno encendido se apaga tocándolo o desde «Filtros
activos» bajo la búsqueda, que lo lista con el flotante cerrado. Las tiles de
métricas siguen contando solo la cola. Lógica pura en `lib/dispatch-day.ts`
(`queueSubstageOptions`, `setStages`, `queueFacetCounts`, `scheduledBucket`),
probada en `test/dispatch-day.test.ts`; la fila de la cola trae `macro_stage`
y `macro_substage` del Master. Nada de esto cambia acciones de servidor. Los cuatro segmentos de «Pedidos tomados» siguen
visibles en Cajas de hoy: cada caja dice «N paq. · armados · cotejados ·
confirmados», cada paquete lleva su chapa de estado (por armar / armado /
cotejado / confirmado / no lo llevó) y un filtro rápido Todos · Por armar ·
Listos para cotejo · Sin confirmar; «Sin ruta» es «tomado · sin caja» en la
lista. Nada de esto cambia acciones de servidor.

**Apartados de la cola: nunca salieron, ya salieron y programados
(29-09-2026).** «Cómo sé cuáles pedidos no han salido ni una sola vez, versus
los que han salido alguna vez; dar prioridad siempre a los que nunca han
salido.» Encima de la tabla de «Desde la lista», una fila **Apartados** como
las subetapas del Master: «Todos · N» y un chip con su cantidad por apartado.
Cada pedido asignable cae en uno solo (`queueSegment`), y así se ordena la
lista (`sortQueue`):

1. **Programados hoy** — con salida programada para hoy o para un día que ya
   pasó (chapa «programado hoy» o, en ámbar, «programado lun 28/09 ·
   vencido»). Van primero: es la fecha que se le dio a la clienta.
2. **Programados para mañana** (01-10-2026) — con salida programada para el
   día siguiente a hoy en Lima. Su tarjeta aparece junto a «Programados hoy»
   y filtra esos pedidos; al llegar su fecha pasan a «Programados hoy».
3. **Nunca salieron** — nunca salieron a reparto (§29.2) y se crearon en los
   últimos 30 días. Es el apartado a dejar en cero, como «Sin llamar» en Por
   confirmar; del más reciente al más antiguo.
4. **Ya salieron** — salieron al menos una vez y volvieron (chapa «ya salió»,
   que reemplaza a «salida previa»): reprogramaciones o recuperaciones.
5. **+30 días** — nunca salieron y se crearon hace más de 30 días
   (`STALE_AFTER_DAYS`): se revisan después de los recientes. Un pedido sin
   fecha de creación se queda en «Nunca salieron».
6. **Programados después** — con salida programada para después de mañana:
   al acercarse la fecha pasan a «Programados para mañana» y después a
   «Programados hoy». Los conteos no se duplican entre apartados.

La programación manda sobre todo lo demás. Un apartado solo reúne pedidos que
se pueden asignar; con una etapa elegida (seguimiento) la fila no se muestra y
elegir etapa apaga el apartado. El apartado no suma en «Filtros · N» ni lo
borra «Quitar filtros»: tiene su propia fila a la vista. Las tiles **«Nunca
salieron»** y **«Programados hoy»**, junto a «Por asignar», encienden su
apartado; reemplazan a la tile «Con salida previa», que contaba 0 siempre
porque leía `shipments.dispatched_at`. El filtro «Solo con salida previa» del
picker se retira: es el apartado «Ya salieron». Lógica pura en
`lib/dispatch-day.ts`, probada en `test/dispatch-day.test.ts` y
`test/despacho-apartados-programados.test.ts`.

**Lo cerrado no se asigna, y quitar de la caja devuelve a «por asignar»
(29-09-2026).** Los «tomados sin caja» salen de las solicitudes de Grupo GF,
no de las etapas de admisión, así que un pedido anulado con su solicitud
aceptada seguía con casilla (#KP136160, #KP136100, #KP136653). Un tomado
cuyo pedido está en **Por cerrar** o **Finalizado** (`takenIsAssignable`) ya
no es asignable: pasa a seguimiento, y el servidor lo rechaza también al
asignar por lista o por QR. **La solicitud no se cancela sola al cerrarse el
pedido**: el MOM no lo pide (§29.6 separa la cancelación logística del pedido
Shopify) y un pedido se puede reabrir; si vuelve a una etapa de admisión,
vuelve a la cola sin tocar nada. Cancelarla sigue siendo un acto explícito.

«Quitar» un paquete de una caja sin custodia dejaba la solicitud en
`scheduled` sin caja (#KP136039, #KP136010, #KP135989, #KP137239,
#KP137430). Ahora vuelve a `accepted` con evento `route_removed` en
`logistics_request_events`, como ya hacían el retiro en custodia (0185) y el
«no lo recojo» (0182); 0200 reparó las cinco con `route_removed_repair`. Al
revés, mover un paquete a la caja de otro motorizado lo deja en `scheduled`:
en custodia, el retiro lo devolvía a `accepted` dentro de la caja nueva.

**El gesto único.** Escanear o fotografiar es un solo componente
(`ScanAction`) y el contexto lo fija la pantalla, nunca el usuario:
`supervisor_asignacion` → tomar + asignar (sin `office_checked` desde el 22-09-2026);
`oficina_cotejo` → `office_checked`; `motorizado_recepcion` →
`pickup_checked` o `pickup_declined` (con caja recibe; sin caja es «Lo llevo»
sobre la ruta en custodia); `motorizado_entrega` → foto de la
parada; `supervisor_retiro` → `package_removed` con motivo. Cada uno deja su
evento en el pedido y recalcula el Master.

**Trazabilidad.** La pestaña «Actividad» del drawer del Master etiqueta en
español todos los hitos del camino —tomado, asignado, cotejado en oficina,
«Lo lleva Roy», «No lo llevó Roy: motivo», movido, retirado, entregado,
«Entregado sin confirmar recojo», aplicado al Master— con actor y hora, sobre
`order_events`; no hay otra línea de tiempo.
«Ver actividad» desde Grupo GF Courier abre ese drawer en esa pestaña.

**La ficha dice quién tiene el paquete y en qué quedó (22-09-2026).** Hasta
aquí «Salidas y guías» enseñaba de una salida propia lo mismo que de
cualquier otra —courier, código y `delivery_status`— y la tarjeta «Revisar la
salida activa» prometía un «último estado del courier» que no se veía: lo del
motorizado solo estaba en «Actividad», como texto. Ahora el detalle del pedido
lee, por cada salida de Grupo GF, la caja del motorizado
(`dispatch_manifest_items` + `dispatch_manifests`) y la parada de su ruta
(`delivery_stops` + `delivery_routes` + `riders`), y bajo la salida pinta una
línea con lo más reciente, en este orden de precedencia: la parada reportada
—**Entregado por Roy** · hora · cobro (Yape S/ 89 / sin cobro) · «entregado
sin confirmar recojo» si no hubo «Lo llevo» · nota, con la foto y el
comprobante (`GET /api/reparto/foto`); **Postergado por Roy** cuando el motivo
es «reprogramado por el cliente» o «no estaba / volver luego»; **No entregado
por Roy** con el resto de motivos—; si no, la caja: **No lo llevó Roy** ·
motivo · «vuelve a por asignar»; **Retirado de la caja de Roy** · motivo;
**Lo lleva Roy** · desde hora · caja del día (y carga si no es la primera) ·
parada pendiente; **En la caja de Roy** · cotejado o sin cotejar · sin «Lo
llevo»; y una parada del cuaderno sin caja se lee como **En la ruta de Roy**.
Sin ficha de motorizado no se inventa un nombre («el motorizado»). La misma
frase encabeza la tarjeta «Revisar la salida activa» en En curso. Lógica pura
en `lib/gf-delivery.ts`, probada en
`test/gf-delivery.test.ts`; lectura en `getOrderMasterDetail`
(`loadGfDeliveries`, con service role porque las políticas de caja son del
supervisor y las de parada de la tienda o del motorizado, y quien abre la
ficha ya pasó el filtro de `order_master`).

**La etapa sigue al motorizado (v1.14, decisión del 22-09-2026).** Hasta aquí
un pedido de Grupo GF quedaba en «En curso · En tránsito» desde que se
asignaba con custodia hasta que se cerraba la ruta, aunque el motorizado ya lo
hubiera entregado o postergado; §29.12 lo decía a propósito («la parada es una
declaración»). Se aprueba cambiarlo: el resolver (`gfRiderSignal`,
`lib/order-macro-stage.ts`) lee de `order_events` la **última** señal del
motorizado sobre la salida propia vigente —`pickup_checked`, `stop_reported`,
y `pickup_declined` o `package_removed`, que la anulan— y decide así:

| Última señal del motorizado | Macroetapa | Subetapa |
| --- | --- | --- |
| Asignado con custodia, sin «Lo llevo» | En curso | En tránsito (como hasta ahora) |
| «Lo llevo» (`pickup_checked`), o la caja recibida por el motorizado en modo `exigir` (`custody_transferred` «Paquete cotejado y recibido…») | En curso | En reparto |
| Parada **entregada** | Por cerrar | Validación de cierre pendiente |
| Parada **no entregada** por cualquier motivo salvo «Rechazó el pedido» (v1.15) | En curso | Por reprogramar Lima |
| Parada **no entregada** por «Rechazó el pedido» | Por cerrar | Devolución física pendiente |

Cada reporte de parada **recalcula el Master en el acto** (`writeStopReport`),
sin esperar al cron: el pedido entregado pasa a Por cerrar al momento.
Deshacer un reporte (volver la parada a pendiente) deja su propio
`stop_reported` con estado «pendiente», que anula los reportes anteriores y
devuelve el pedido a lo que había antes («Lo llevo» → En reparto). Las
paradas del cuaderno, sin `shipment_id`, valen para la salida propia
vigente. Una señal de otra salida o de un courier externo no cuenta. El
`since` de la etapa es la hora de esa señal. **El cierre de la ruta no cambia
de sitio**: sigue escribiendo por la puerta única (`applyDeliveriesToMaster`)
y, cerrada, el pedido entregado pasa a «Pendiente de liquidación» y con la
liquidación a «Finalizado · Entregado cerrado», como cualquier Lima. Para que
eso ocurra, una salida propia cuya parada se reportó entregada **cuenta como
entregada** en las obligaciones de cierre: nadie escribe
`delivery_status = entregado` en esas salidas, y sin esta regla todo pedido de
Grupo GF caía en «Devolución física pendiente» o «Salida adicional activa» al
cerrar la ruta. Reasignar un paquete postergado deja un `pickup_checked`
nuevo, más reciente, y el pedido vuelve a «En reparto». La versión del
resolver sube a `mom-v1.14` para que el cron reconcilie el histórico. Pruebas
en `test/order-macro-stage.test.ts` («motorizado propio: lo que reporta mueve
la etapa»).

**No entregado → recibir en oficina → reprogramar (v1.15, 22-09-2026).** Todo
«No entregado» es reprogramable salvo «Rechazó el pedido» (§9: un no
entregado pasa a Por reprogramar Lima). El paquete sigue en la caja del
motorizado hasta que vuelve físicamente: en «Desde la lista» aparece con la
chapa roja «No entregado · motivo» y casilla; marcarlo y **«Recibir en
oficina»** (`gf_return_to_office`, 0188) lo saca de la caja con rastro
(`returned_to_office`), devuelve la custodia a la empresa y la solicitud a
«por asignar». La parada reportada se conserva: es la evidencia del intento
y cuenta en la liquidación del día. El pedido sigue en «Por reprogramar
Lima» hasta que se asigna a otra caja. Junto a «Asignar», el botón de
calendario **programa** la fecha de salida de los marcados
(`rescheduleGroupGfCourierOrders`): desde el 29-09-2026 solo guarda el día,
con motivo, sin tomar el pedido (§29.6); hasta entonces un disponible se tomaba
con esa fecha. Uno que ya está en la caja de un motorizado no se mueve. La tarjeta **«Por
reprogramar»**, antes de «Tomados sin caja», cuenta los pedidos de Grupo GF en
«En curso · Por reprogramar Lima» (en una caja o ya en oficina) y al tocarla
aplica ese filtro de etapa y subetapa. La versión del resolver sube a
`mom-v1.15`.

**Devoluciones en Rutas y el rechazo en puerta (v1.16, 22-09-2026).** Todo
«No entregado» que salió en una caja tiene que volver físicamente. En Rutas,
la columna **«Devolver»** dice devueltos / por devolver de cada ruta (verde
completo, rojo si falta alguno). En Despacho del día, la tarjeta
**«Devoluciones»**, a la derecha de «Por reprogramar», cuenta las
devoluciones pendientes de cualquier fecha; al tocarla, el recuadro de
asignar muestra solo «Escanear» y el campo de código para confirmar que cada
paquete llegó a la oficina (cámara en serie, «Devueltos X de N»), y cada
lectura hace «Recibir en oficina». Tocarla otra vez vuelve a asignar. En «Reparto y
liquidación», cada no entregado dice **«Devuelto · fecha hora»** o **«Por
devolver»**. **Hasta la v1.23, «Rechazó el pedido» no se reprogramaba** (0189;
desde la v1.23 se reprograma como los demás motivos, §9): mientras estaba en
la caja va a «Por cerrar · Devolución física pendiente»; recibido en oficina,
la salida queda devuelta (`custody_state = devuelto`, `returned_at`), la
solicitud del courier se cancela y el pedido pasa a «Por cerrar · Devolución
pendiente de inventario» (también después de anularse al cerrar la ruta),
nunca a la cola. Con «Reingresar a inventario» o «Merma» desde el cierre de
la ficha pasa a **«Finalizado · Anulado cerrado»**; si eso ocurre antes de
cerrar la ruta (el pedido aún no está anulado), espera en «Por cerrar ·
Validación de cierre pendiente» hasta el cierre (v1.17). Los demás motivos vuelven a «por asignar» en «Por
reprogramar Lima».

**Lo que otro courier no entregó también se reprograma desde la lista (v1.19,
29-09-2026).** «Desde la lista» solo miraba Preparación y Por despachar, y un
pedido que Tanders no entregó está En curso (§9), así que no aparecía nunca:
#KP135035 y #KP135161 buscados por número daban «Nada por asignar». Ahora la
cola suma los pedidos de Lima en **«En curso · Por reprogramar Lima» que
esperan courier nuevo** (`pendiente_nuevo_courier`, `lib/gf-retry.ts`). Un
«Por reprogramar Lima» cuya guía sigue viva con su courier —una reprogramación
de Aliclik, por ejemplo— no entra: esa la lleva ese courier. Desde el
06-10-2026 la puerta es la etapa y lo que Grupo GF no entregó con su propia
salida también entra, con esa misma salida (abajo).

- La fila lleva la chapa **«Tanders no entregó · vuelve»** o **«· volvió»** —o
  **«Swayp no entregó · vuelve»** desde la v1.22— y
  cuenta en «Por asignar» y en la tarjeta «Por reprogramar».
- Cuando la salida que falló es de **otro courier**, **tomarlo crea una salida
  NUEVA** con su QR y Almacén arma otra caja (§9.3): la anterior es de otro
  courier y lleva su rótulo. Nunca se rellena otra salida, y la que falló no
  cuenta como «ya en caja» aunque siga volviendo.
- Si la caja anterior **todavía vuelve**, la salida nueva es adicional y su
  motivo se escribe solo (`additional_output_reason`, §9): el hecho ya lo
  reportó el courier. El tope de cinco salidas se aplica igual.
- Con la salida nueva el pedido deja la recuperación y sigue el camino normal
  de Grupo GF; el paquete que volvió no lo devuelve a «Devuelto» (§7).

**Lo que Grupo GF no entregó con su propia salida también se reprograma desde la lista, con esa misma salida (06-10-2026, decisión del owner).**
#KP132798 salió el 06/09 en una ruta del cuaderno con su salida KP132798-S01 y
volvió «No entregado · rechazado» el 07/09. El Master lo tenía en «Por
reprogramar Lima» (v1.15, `gfAwaitingRetry`), pero la cola solo traía ese
apartado con `pendiente_nuevo_courier` —lo que otro courier no entregó— y el
pedido no tenía solicitud de Grupo GF ni caja: no aparecía en «Desde la lista»,
el escaneo respondía «El pedido ya avanzó» y la ficha decía «Grupo GF Courier ya
tiene una salida activa». Medido el 05-10-2026: el Master tenía **336** pedidos
en «Por reprogramar Lima» y la tarjeta «Por reprogramar» contaba **277**.
Faltaban 45 como #KP132798 (salida del cuaderno en la empresa, nunca en una
caja) y 10 con la S01 todavía dentro de una caja de Grupo GF del 17 o 19/09, sin
solicitud; otros 4 estaban en «Sin condiciones» por distrito inválido.

Decisión del owner (06-10-2026):

- **La puerta es la etapa.** «Desde la lista» trae todo «En curso · Por
  reprogramar Lima» de Lima de las tiendas con contrato
  (`REPROGRAM_QUEUE_FILTER`, `lib/gf-retry.ts`), sea cual sea el estado
  operativo. Cada pedido dice qué toca o, en «Sin condiciones», por qué no
  sale: ninguno desaparece en silencio.
- **Lo que otro courier no entregó** sigue como en la v1.19: salida nueva.
- **Si la única salida viva es la propia de Grupo GF** (`ownRetryOutput`), **se
  toma con ESA salida**: mismo consecutivo, QR, `output_code`, `guide_code`,
  rótulo y armado (no se toca `preparation_state`). No se crea otra ni se
  «rellena» —ya es de Grupo GF—, no gasta una de las cinco salidas ni pide
  motivo de salida adicional. La solicitud apunta a esa salida
  (`logistics_requests.shipment_id`), que pasa a `created_via =
  grupo_gf_courier` como al rellenar, con `assigned_at` y `next_followup_at` de
  la toma; los valores anteriores quedan en el evento de la toma
  (`payload.ownRetry`). Una salida devuelta (custodia `devuelto` o
  `returned_at`, como deja la 0189 un rechazo recibido) no cuenta como viva. Es lo que ya hacía
  «Recibir en oficina» con los no entregados de una caja (v1.15) y lo que dice
  el §29.4: una reprogramación que conserva el paquete armado conserva su
  identidad física. La fila lleva la chapa **«Grupo GF no entregó · sale con su
  S01»**.
- **Si sigue en una caja** y lo último que su motorizado reportó en ESA caja
  es «No entregado» —lo mismo que exige `gf_return_to_office`, 0206—, aparece
  con la chapa «No entregado · motivo» para **«Recibir en oficina»** —o se
  escanea, que lo recibe y lo asigna— y después se toma con la misma salida.
  Sin ese reporte (solo la parada del cuaderno, o la de la caja dice otra cosa)
  va a «Sin condiciones · En una caja sin "No entregado" de esa caja»: hay que
  revisar la parada antes de sacarlo otra vez (#KP134157, #KP134960 y #KP134917
  el 05-10-2026). Ni en la empresa ni en una caja: «El paquete no consta en la
  oficina ni en una caja» (revisar su custodia en la ficha).
- **Lo que no se puede tomar se ve en «Sin condiciones» con su motivo**
  (`reprogramBlockReason`, `ownRetryDecision`), la misma regla en la cola, al
  tomar y al escanear:
  - «Otra salida sigue viva: la lleva su courier» —una reprogramación de
    Aliclik, por ejemplo—.
  - «Sus salidas de Grupo GF no se pueden reusar tal cual: revísalas en la
    ficha» (más de una viva, una en ruta, o junto a una entregada).
  - «Su salida ya volvió al almacén (devuelta)»: el rechazo que la 0189 recibió
    como devuelto. Todavía no tiene camino desde la lista (0 casos el
    05-10-2026).
  - «Su salida ya estuvo en otra solicitud de Grupo GF»: una salida solo puede
    estar en una solicitud, aunque esté cancelada
    (`logistics_requests_shipment_uniq`).
  - Sin ninguna salida, «Sin salida armable en Almacén».
- La ficha del pedido ya no manda a anular esa salida: la Mesa de ruta dice que,
  si no se entregó, se reprograma con esa misma salida desde Despacho del día
  (`lib/order-route-plan.ts`). Anularla gastaba el consecutivo y obligaba a
  armar otra caja para el mismo paquete.
- «Asignar» cuenta y asigna solo lo asignable: un «No entregado» que sigue en
  una caja se recibe en oficina primero, y si no había nada asignable se dice.
- Si la salida cambia entre la lectura y la toma (se anuló o salió), la
  solicitud recién creada se deshace: no queda una «observada» sin salida.
- Una solicitud de Grupo GF cancelada antes ya no se cuenta como «ya estaba
  tomado»: la clave de idempotencia (`kapta:proveedor:pedido`, 0138) choca
  también con ella, y ahora se dice que no se puede volver a tomar desde aquí.
- Asignar a una caja exige la salida `pendiente`: una anulada o entregada no
  entra (`assignRouteCore`).
- Asignado a una caja, el pedido deja «Por reprogramar Lima» como cualquier
  reintento de Grupo GF (`dispatch_route_assigned` es movimiento para
  `gfAwaitingRetry`). El resolver no cambia y la versión **no sube**
  (`mom-v1.23`). **Pendiente:** con `rider_pickup_mode` en `confirmar` o
  `ninguno` (hoy `exigir`), la custodia pasa al asignar y `gfRiderSignal` sigue
  leyendo el «No entregado» anterior: el pedido se vería en «Por reprogramar
  Lima» hasta el «Lo llevo» (`confirmar`) o el reporte de la parada
  (`ninguno`). Antes de cambiar de modo hay que contar la asignación como
  reinicio en `gfRiderSignal`, como ya hace `returned_to_office`.

Con la foto del 05-10-2026, la tarjeta pasa de 277 a 329 (los 45 por asignar y
7 por recibir en oficina) y los 7 restantes del Master se ven en «Sin
condiciones» con su motivo (4 por distrito, 3 en una caja sin su reporte).
Implementación: `lib/gf-retry.ts`, `app/dashboard/courier/actions.ts`
(`loadCourierOperations`, `loadActiveBoxes`, `takeOrdersCore`, `adoptOwnOutput`,
`assignRouteCore`), `lib/order-route-plan.ts` y
`components/dispatch-day-board.tsx`. Pruebas en `test/gf-own-retry.test.ts`.

**Escanear un «No entregado» de una caja anterior lo recibe y lo asigna
(29-09-2026).** #KP136779 y #KP136896 salieron el 26/09 con Yhoni y volvieron
«No entregado · reprogramado». La ruta se cerró el 28/09, pero nadie los
recibió en oficina, así que seguían dentro de esa caja: cerrar la ruta no vacía
la caja. El 29/09, con los paquetes en la mano, el escaneo de «Por QR»
respondía **«Ya estaba»** —miraba si había una caja activa del motorizado, sin
mirar de qué día— y no entraban en la ruta de hoy. Había 78 «No entregado»
así, en cajas del 16 al 28/09, y 20 rechazos sin recibir.

Regla (`lib/gf-scan-return.ts`, en `scanAssignToRider`): si el paquete está en
la caja de un día **anterior** al de la caja que se arma, escanearlo en oficina
prueba que volvió, igual que en «Devoluciones».

| Reporte de su parada en esa caja | Qué hace el escaneo |
| --- | --- |
| «No entregado» (cualquier motivo, rechazo incluido desde la v1.23) | Lo recibe en oficina (`gf_return_to_office`) y lo asigna a la caja de hoy. La chapa dice «En la caja de X · volvió de Yhoni del 26/09». |
| «Entregado» | No hace nada: lo dice. |
| Sin reporte | No lo toca: la parada es de la liquidación de ese motorizado. Pide que la reporte. |

Si algo impide asignarlo después de recibirlo (programado para otro día,
límite de efectivo), la línea lo dice y el paquete queda recibido, «por
asignar». Lo del **mismo día** no cambia: «Ya estaba» es solo la caja de ese
día, y la de otro motorizado ofrece «Mover».

**«Mover» un paquete que está en la oficina (05-10-2026).** Con verificación
«exigir», un paquete que el motorizado confirmó al recibir su caja no se puede
sacar de ella desde Despacho del día: nadie le retira en silencio algo de su
cuadre. Pero escanearlo en la oficina prueba que no salió: #KP138381 seguía en la
caja de Yhoni y estaba en la mano de quien armaba la de Alexis. Desde el escaneo,
«Mover» lo recupera (`gf_office_reclaim`, 0230): lo saca de la caja del primero
con el motivo «recuperado en oficina», borra su parada pendiente, devuelve la
custodia a la empresa y lo mete en la caja del segundo. Solo con la parada
**pendiente**: una ya reportada se resuelve por su reporte. Queda en el historial
de la caja y del pedido. Si algo falla, el motivo se dice en la misma fila del
escaneo; antes salía arriba de la página, fuera de la pantalla del celular, y
parecía que el botón no hacía nada.

**Devoluciones de Almacén también recibe lo que vuelve de Grupo GF
(05-10-2026).** El escáner de Almacén → Devoluciones solo aceptaba Tanders y
Shalom: KP137351-S01 y KP137320-S01 respondían «no es de Tanders ni de Shalom»
y quien tenía la caja en la mano no sabía qué pasaba con el pedido. Ahora un
paquete de Grupo GF (o aún sin courier) se resuelve igual que en Despacho del día
→ «Devoluciones» (`lib/gf-returns-scan.ts`):

| Dónde está el paquete | Qué hace el escaneo |
| --- | --- |
| En la caja de un motorizado, reportado «No entregado» (cualquier motivo) | Lo recibe en oficina (`gf_return_to_office`): sale de la caja, la custodia vuelve a la empresa y el pedido queda por asignar en Grupo GF, en «Por reprogramar Lima». |
| En la caja, reportado entregado | No lo toca: lo dice. |
| En la caja, sin reporte | No lo toca: pide que el motorizado lo reporte. |
| Sin caja y en la empresa, nunca recibido en oficina | Nada que recibir: dice que nunca salió en Kapta y sigue por asignar. Era el caso de KP137351 y KP137320 («Por despachar · Listo para asignar»). |
| Sin caja y ya recibido en oficina | Lo dice sin alarma. |

Solo la anulación en Shopify termina la venta: un anulado que vuelve se recibe
igual —la caja tiene que salir de la del motorizado— y el aviso dice que está
anulado y se separa para el stock. Aliclik y los demás siguen recibiéndose desde
el Master. Pruebas en `test/gf-returns-scan.test.ts`.

**Un pedido anulado se dice primero, en cualquier escaneo (05-10-2026).** Al
escanear un paquete —armado en almacén, agregar a una ruta, cotejo de la caja o
caja del motorizado de Grupo GF—, si su pedido está anulado (en Shopify o en
Kapta) la respuesta es esa y nada más: «#AUR177767 está ANULADO en Shopify (el
04/10, lo canceló el cliente): no sale. Sepáralo para devolverlo al stock.».
Antes cada pantalla respondía con su propio motivo —«Ese paquete no pertenece a
esta ruta», «El pedido ya avanzó…»— y quien tenía la caja en la mano no sabía que
la decisión era simplemente no despacharla.

**Verificar una caja dice cuál es, y dónde está lo que no es suyo
(07-10-2026).** KP136825-S01 ya estaba en la caja de Alexis —la única que le
faltaba verificar— y se escaneó en la verificación de Roy, también de 16
paquetes. La cámara solo decía «Escanear QR» y el error «Ese paquete no
pertenece a esta ruta»: parecía que no dejaba asignarlo. Ahora, con pocas
palabras:

- La cámara se titula con el paso y la caja: **«Verificar caja · Roy»** (o
  «Recibir carga · …»), y debajo el día y «Solo cuenta lo que está en esta
  caja».
- El error nombra las dos cajas (`lib/scan-other-box.ts`): «Está en la caja de
  Alexis (07/10), no en la de Roy. Verifícalo en esa caja.» Si no está en
  ninguna: «No está en la caja de Roy ni en otra. Agrégalo primero a una
  caja.» El anulado sigue diciéndose antes que esto.

### 29.14 Rutas: una sola lista y la caja al lado (19-09-2026)

**Antes** la pestaña «Rutas» tenía dos subpestañas —«Cajas y cotejos» (solo
las cajas con pedidos tomados, y «Abrir caja» llevaba a otra pantalla con
KPIs y una columna de «Rutas recientes») y «Reparto y cierre diario» (la tabla
de `delivery_routes` de siempre)— y una misma ruta se veía en las dos con
datos distintos.

**Ahora** hay una sola lista, `getCourierRouteLedger`
(`lib/courier-route-ledger.ts`): una fila por ruta de reparto —motorizado y
día, `delivery_routes`— con su caja de despacho cuando la tiene
(`dispatch_manifests` de courier propio; si hay varias cargas se enseña la
última y se suman sus paquetes). Las rutas que trajo el cuaderno (§29.12) no
tienen caja y aun así están. La lista se agrupa por fecha con la cabecera de
cada día pegajosa, hoy primero y luego hacia atrás, y se filtra por motorizado
y por fecha (Hoy · un día concreto · Todas) con el mismo picker de Despacho
del día. La consulta de situación carga todas las fechas y los filtros de
día y motorizado se aplican en el navegador (`?dia=` y `?motorizado=`).

**Situación y búsqueda por código (01-10-2026).** El desplegable «Situación»
reemplaza «Solo abiertas». Ofrece Todas las situaciones y cada situación de la
columna que tenga al menos una ruta disponible con la fecha, motorizado y
búsqueda actuales. No ofrece situaciones vacías. Las opciones se calculan
antes de aplicar la situación elegida, para poder cambiar entre ellas.
Si la situación elegida se queda sin rutas al cambiar otro filtro o actualizar
los datos, vuelve a Todas las situaciones; no lo hace durante la carga ni
ante errores. Todas las situaciones siempre está disponible para quitar el
filtro. «Todas las abiertas» solo aparece si hay alguna ruta abierta y agrupa las que no están
cerradas ni liquidadas. Usa el mismo resolver de la fila: una ruta liquidada
no aparece en Cerrada ni En reparto aunque su estado operativo siga así.
La consulta trae todas las situaciones sin el tope de las últimas 150;
elegir una filtra en el navegador y conserva fecha y motorizado. Al quitar
una situación no desaparecen rutas antiguas que se acababan de encontrar.
«Quitar filtros» restablece Hoy y elimina también la búsqueda y la situación.

El buscador acepta número de pedido (con o sin `#`, también un fragmento de al
menos tres caracteres), guía, código de salida o QR. Consulta las identidades
del pedido y sus paradas y cajas con RLS, sin limitarse a las rutas cargadas.
Al buscar restablece Todas las fechas y Todos los motorizados, conserva la
situación elegida si tiene coincidencias; si no, vuelve a Todas las situaciones.
Muestra el código encontrado junto al motorizado, fecha y situación, con acceso
a la caja y a «Reparto y liquidación». Si hubo varios intentos, conserva sus
rutas en orden de fecha; no elige una a ciegas. Las cajas canceladas y los ítems
retirados o no recogidos no cuentan como asignación activa. Si el fragmento
coincide con más de 30 pedidos o salidas, pide precisar en vez de mostrar una
muestra como resultado completo. Buscar y filtrar no cambian pedidos ni rutas.
La URL conserva `buscar` y `situacion` al abrir y cerrar los paneles. Los
enlaces anteriores con `abiertas=1` siguen seleccionando Todas las abiertas.

**Cada fila** dice motorizado y carga, la situación, asignados / armados /
cotejados / recibidos, efectivo previsto (§29.9), avance y liquidación. La
situación es una sola, del momento más temprano al más tardío: borrador →
cotejo de oficina → lista para recojo → en poder del courier → en reparto →
cerrada → liquidada (`ledgerSituation`); las tres primeras salen del estado
de la caja, las tres últimas del estado de la ruta y de `rider_settlements`.
Sin caja, armados/cotejados/recibidos van en «—» y el avance es lo ya
reportado por el motorizado. El aviso «N pedidos sin ruta» sigue arriba y
lleva a Despacho del día.

**Clic en la fila** abre la caja a la derecha, como la ficha del pedido
(§25.1): `?caja=<carga>` en la URL, o `?ruta=<ruta>` cuando no hay caja
(`lib/courier-box-href.ts`, `components/courier-box-drawer.tsx`). Dentro van
los tres pasos de la mesa de despacho —Agregar pedidos, Verificar caja,
Recibir carga— con el mismo componente que usa Almacén (`DispatchBoxPanel`,
extraído de `dispatch-workspace.tsx`), sin la columna de rutas recientes ni
los KPIs, y el acceso a «Reparto y liquidación» de esa ruta. Una ruta sin
caja lo dice y solo ofrece el reparto. Cerrar reemplaza la URL sin apilar
historial y conserva pestaña y filtros; cada acción refresca la fila de
atrás. En el teléfono el panel ocupa toda la pantalla.

**Pantallas que quedan.** `/dashboard/courier/reparto?id=` sigue siendo el
reparto y cierre de UNA ruta (paradas, reporte, cierre, pago del
motorizado); sin `id` manda a la lista. `/dashboard/courier/rutas` es la
misma lista y el mismo panel para quien coteja, recibe o arma rutas sin
administrar el courier; quien administra cae en la pestaña. Los enlaces
antiguos `?manifiesto=` abren esa caja en la pestaña (`legacyManifestHref`).
Nada de esto cambia acciones de servidor ni la base.

### 29.15 Tiendas cliente de otra organización (aprobado entre el 05 y el 08-10-2026)

**Estado: aprobado, sin implementar.** El plan de trabajo, con lo que hoy lo
impide en el código, está en `docs/plan/clientes-externos-gf.md`.

Grupo GF Courier presta servicio a **tiendas cliente**: negocios ajenos que
venden en su propio Shopify y le encargan pedidos. Hasta ahora §29 solo se
cumplía con Aurela y Kenku, que viven en la misma organización que el operador.
En esta sección, **tienda** es la tienda cliente y **comprador** es quien
recibe el pedido en la puerta.

#### 29.15.1 Identidad y alta

- Cada tienda cliente vive en **su propia organización** y usa Kapta completo:
  su Master, su Shopify, su equipo. Grupo GF no es miembro ni dueño de esa
  organización. Kapta es una sola base de datos; el aislamiento entre
  organizaciones lo da la base, no una base por cliente.
- **Alta por invitación.** El registro público de Kapta sigue cerrado. Grupo GF
  invita por correo al dueño de la tienda; el dueño entra, crea su
  organización, conecta su Shopify y acepta el contrato con un código.
- El contrato nace en `draft` y pasa a `active` solo cuando la tienda lo
  acepta. Kapta comprueba que la tienda pertenece a la organización cliente
  del contrato. Grupo GF nunca vincula una tienda ajena por su cuenta.
- **Un solo operador.** Grupo GF Courier existe una vez. El owner de una
  organización cliente no administra operadores ni ve el módulo de Grupo GF
  Courier.
- Las integraciones que usan credenciales únicas de Grupo GF quedan
  **apagadas** para organizaciones cliente: Swayp, Shalom, agente de voz y
  Chatby. Se encienden solo cuando sean por tienda.
- Grupo GF suspende un contrato a mano, por deuda u otro motivo (§29.10). La
  suspensión bloquea nuevas asignaciones y no borra pedidos, solicitudes ni
  liquidaciones.

#### 29.15.2 La tienda asigna

- El contrato dice **quién inicia**: la cola del operador (Aurela y Kenku,
  §29.2) o la tienda. Los pedidos de una tienda cliente **nunca** aparecen en
  «Pedidos disponibles».
- La tienda asigna desde la Mesa de ruta de su pedido, o en lote desde su
  Master. Antes de confirmar ve distrito, tarifa y fecha prevista.
- **Asignar obliga a Grupo GF.** Se valida en el servidor lo mismo que en
  «Tomar pedidos» (§29.2):
  - contrato vigente;
  - Lima Metropolitana o Callao, con distrito canónico;
  - tarifa vigente;
  - distrito sin pausa;
  - corte de las 11:30 para la fecha prevista.

  Además, todas las líneas del pedido tienen que estar mapeadas (§29.15.4). Si
  cumple, queda tomado: no existe un estado «solicitada» ni una aprobación de
  Grupo GF.
- Asignar crea la solicitud logística idempotente, congela tarifa, bolsa y
  precio de cada línea, y crea la salida o rellena la caja `por definir`
  conservando su QR (§29.2). El actor que solicita es el usuario de la tienda.
- El pedido aparece en Grupo GF en «Pedidos tomados · Sin ruta» con el nombre
  de la tienda, y desde ahí sigue el camino de siempre: caja, cotejo de
  oficina, recepción del motorizado, reparto, reporte y cierre de ruta.
- Grupo GF puede anular la solicitud con motivo; la tienda lo ve en su Master.
- **La tienda cancela cuando quiera, sin costo** (§29.6), aunque el paquete
  esté en una caja o en la calle: el paquete vuelve al almacén y se desarma
  (§29.15.5). Cancelar la solicitud no cancela el pedido en Shopify (§2).

#### 29.15.3 Qué ve cada uno

- **Grupo GF ve solo los pedidos que la tienda le asignó**, con los datos que
  necesita para armar, entregar, cobrar y liquidar. Nunca ve el resto de
  pedidos, clientes ni pagos de la tienda.
- **La tienda ve** etapa, evidencia (foto y comprobante), su liquidación y su
  cuenta corriente.
- **La tienda no ve** nombre, teléfono ni ubicación del motorizado, ni el
  correo del personal de Grupo GF. En su actividad aparecen como «Motorizado de
  Grupo GF» y «Grupo GF Courier». La regla vale también para lo que la tienda
  pueda consultar directamente en la base, no solo para la pantalla.
- **Marca blanca.** El rótulo (§28) y los mensajes del motorizado al comprador
  llevan el nombre de la tienda, como ya ocurre con Aurela y Kenku.
- Una tienda cliente nunca ve nada de otra.

#### 29.15.4 Producto, catálogo y armado

- **Grupo GF arma** en su almacén (§29.2). El producto puede ser de
  Proveeduría Grupo GF o propio de la tienda, guardado en Grupo GF. Un pedido
  puede mezclar los dos.
- **Catálogo de Proveeduría.** La tienda ve, en solo lectura, el nombre, SKU,
  foto y precio a la tienda de cada producto. El precio tiene vigencia: hay un
  precio general y excepciones por contrato, con la misma precedencia que las
  tarifas (§29.8).
- **Mapeo de SKU obligatorio.** Cada SKU del Shopify de la tienda se marca como
  «producto Grupo GF X» o «producto propio de la tienda». Un pedido con una
  línea sin mapear no se puede asignar, y Kapta dice qué línea falta.
- **Primera versión sin control de stock** (§29.3 lo permite). Se registra de
  qué bolsa sale cada línea, para armar y para cobrar, pero no se reservan ni
  se cuentan unidades. El conteo, la recepción y el retiro del inventario de la
  tienda quedan para una versión posterior.
- El Almacén de Grupo GF arma estos pedidos. En el Almacén de la tienda
  aparecen como «Lo arma Grupo GF» y no se preparan allí.
- **El producto de Proveeduría se cobra solo en lo entregado.** Un rechazo o un
  no entregado lo devuelve a su bolsa sin cargo.
- **Pérdida o daño de producto de la tienda: caso a caso.** El paquete queda
  observado (§29.7) y Grupo GF registra un ajuste con motivo en la cuenta
  corriente (§29.15.8).

#### 29.15.5 No entregado, reprogramación y desarmado

- **El reintento lo decide la tienda.** Un no entregado de una tienda cliente
  va a «En curso · Por reprogramar Lima» en el Master de la tienda (§9). No
  entra a la cola de reprogramados de Grupo GF. La tienda reprograma con fecha.
- Un «Reprogramado por el cliente» que el motorizado **conserva** (§29.7,
  07-10-2026) cuenta como reprogramación registrada: pasa a la ruta del día
  pedido sin volver a la oficina. La tienda lo ve con la fecha y puede
  cambiarla o cancelar.
- Al recibirlo en la oficina:
  - **con una reprogramación registrada**, conserva la salida, la guía y el QR
    (§29.5, reintento con el mismo envío);
  - **sin reprogramación registrada**, se desarma: el producto vuelve a su
    bolsa, la solicitud se anula con motivo «desarmado sin reprogramación» y
    la salida termina.
- Reprogramar un pedido desarmado lo arma de nuevo con una solicitud y una
  salida nuevas, con QR nuevo (§29.4) y con la tarifa y el precio vigentes ese
  día.
- Para una tienda cliente, la fila «Reprogramado · conserva el paquete armado»
  de §29.7 se cumple solo si la reprogramación está registrada cuando el
  paquete vuelve.

#### 29.15.6 Precios

| Concepto | Aurela y Kenku | Tienda cliente |
| --- | --- | --- |
| Tarifa por distrito | Tabla general interna | **Tabla general de externos** |
| Excepción por contrato | Sí | Sí |
| Comisión Yape | 3.5 % | **5 %** general |
| Comisión POS | — | **5 % fijo**, sin excepción por contrato |
| Producto de Proveeduría | — | Precio a la tienda (§29.15.4) |

- **Tarifa.** Para una tienda cliente se busca primero la excepción del
  contrato y después la tabla general de externos; nunca la interna. Todo lo
  demás de §29.8 se mantiene: incluye IGV, entrega y rechazo cobran lo mismo,
  y sin coincidencia aparece «Sin tarifa configurada», nunca S/ 0.
- **Comisiones.** La comisión Yape y la de POS siguen las mismas reglas que la
  comisión Yape de §29.8:
  - se calculan solo sobre lo efectivamente recibido por ese medio en las
    cuentas de Grupo GF;
  - se redondean a dos decimales por operación;
  - tienen vigencia.

  La comisión Yape admite excepción por contrato. La comisión POS es **5 % fija
  para todas las tiendas cliente**, sin excepción por contrato.
- **El motorizado gana lo mismo** por un pedido de tienda cliente que por uno
  de Aurela o Kenku. Su tarifario (§29.10) no distingue la tienda.

#### 29.15.7 Cobro en la puerta

- **Todo cobro va a Grupo GF:** efectivo, Yape de Grupo GF y POS de Grupo GF.
- El reporte de la parada de un pedido de tienda cliente registra la **cuenta
  receptora**, no solo el medio.
- Si el comprador igual paga directo a una cuenta de la tienda, se registra
  como «pago directo a la tienda»: no entra al neto ni paga comisión.
- El importe sugerido sigue §29.10: el saldo después de los pagos que la tienda
  ya validó.

#### 29.15.8 Liquidación diaria y cuenta corriente

Hay **una liquidación por contrato y día**. Se calcula sobre las paradas de ese
día, en rutas de Grupo GF, con pedidos de esa tienda. Una ruta que mezcla
tiendas aporta a cada una solo sus paradas (§29.5).

```text
COD cobrado por Grupo GF
− tarifa de entrega o rechazo (la congelada en la solicitud)
− comisión Yape sobre cada Yape recibido por Grupo GF
− comisión POS sobre cada cobro por POS de Grupo GF
− precio a la tienda del producto de Proveeduría, solo en lo entregado
= neto del día
```

- **Tarifa por resultado.** Entregado y rechazado cobran la tarifa congelada en
  la solicitud. El rechazo se cobra una vez por pedido y ruta/día (§29.7); los
  demás resultados, S/ 0.
- **Producto.** El precio es el congelado en la solicitud.
- **Bloqueos.** La liquidación queda **por aprobar** y no se puede aprobar
  mientras haya:
  - una ruta sin terminar;
  - una parada pendiente;
  - evidencia faltante (con las excepciones de §29.7);
  - una línea sin tarifa.
- **Aprobación humana.** La aprueba la responsable financiera (Yohalis) o el
  owner (Frankz), con `settlements.close` en la organización de Grupo GF, sobre
  la versión que vio. La liquidación queda **aprobada** y congelada. Una
  corrección posterior es un ajuste con motivo en la cuenta corriente, nunca
  una edición de la liquidación (§14).
- **Al aprobar:**
  - el neto entra a la cuenta corriente;
  - cada pedido incluido queda **cerrado financieramente** en el Master de la
    tienda: de «Por cerrar · Pendiente de liquidación» pasa a «Finalizado ·
    Entregado y liquidado» (§6.5, §6.6).
- **Cuenta corriente por contrato**, append-only. Sus movimientos son:
  - el neto de una liquidación aprobada (positivo o negativo);
  - un depósito de Grupo GF a la tienda;
  - un pago de la tienda a Grupo GF;
  - un ajuste con motivo.

  El saldo es la suma; ningún movimiento se edita ni se borra.
- **Depósito diario.** Al aprobar la liquidación del día, Grupo GF deposita el
  saldo a favor de la tienda y registra la constancia. Un saldo en contra (por
  ejemplo, pedidos pagados por adelantado que solo deben la tarifa) se arrastra
  al día siguiente. Grupo GF ve el saldo de cada tienda y decide si suspende el
  contrato (§29.15.1).
- **Lo que ve la tienda**, en solo lectura: liquidación, líneas, evidencias,
  cuenta corriente y depósitos, con exportación del detalle. En esta versión
  los reclamos van por fuera de Kapta y Grupo GF registra el ajuste.
- **Facturas fuera de Kapta.** Los montos se muestran con IGV incluido.
- **Yape.** La aprobación humana compara el total contra el estado de cuenta
  del Yape de Grupo GF. El cruce automático, operación por operación, queda
  para después.

#### 29.15.9 Lo que no cambia

- Shopify sigue siendo la única fuente de pedidos (§2). Kapta no crea pedidos
  para la tienda, y cancelar una solicitud no cancela el pedido en Shopify.
- Aurela y Kenku siguen con la cola automática de «Pedidos disponibles», la
  tabla interna, el 3.5 % y el reintento gestionado por Grupo GF.
- Rutas que mezclan tiendas, cotejos, custodia, reportes y pago del motorizado
  funcionan igual para todos.

#### 29.15.10 Fuera de esta versión

- Entrada por API o Excel para tiendas sin Shopify (§29.11).
- Conteo, reserva, recepción y retiro del inventario de la tienda (§29.3).
- Reclamos de la tienda dentro de Kapta.
- Valor declarado por SKU para compensar pérdidas.
- Facturación electrónica.
- Cruce automático del Yape de Grupo GF con su estado de cuenta.
- Cobro de la suscripción de Kapta a la tienda.

#### 29.15.11 Criterios de aceptación

- Una tienda invitada que acepta el contrato con su código lo deja `active`.
  Un código equivocado o de otra invitación no lo activa.
- El owner de una organización cliente no ve Grupo GF Courier ni puede crear
  un segundo operador.
- Un pedido de tienda cliente en Lima, con todas sus líneas mapeadas, se asigna
  desde su Mesa de ruta y aparece en «Pedidos tomados · Sin ruta» de Grupo GF
  con el nombre de la tienda. No aparece nunca en «Pedidos disponibles».
- Asignar dos veces el mismo pedido, o en paralelo, deja una sola solicitud
  activa.
- Un pedido con una línea sin mapear no se asigna, y el aviso nombra la línea.
- La tarifa congelada sale de la excepción del contrato o, si no hay, de la
  tabla de externos, nunca de la interna. Sin tarifa, el pedido no se asigna.
- El equipo de Grupo GF escanea, coteja, rotula, reporta por el motorizado y
  cierra la ruta de un pedido de tienda cliente igual que uno de Aurela. Al
  cerrar la ruta, ninguna parada de la tienda queda fuera.
- Grupo GF no ve un pedido de la tienda que no le fue asignado. La tienda A no
  ve nada de la tienda B.
- Con la sesión de la tienda, ninguna consulta, ni de pantalla ni directa a la
  base, devuelve el nombre o el teléfono de un motorizado ni el correo del
  personal de Grupo GF.
- Un no entregado sin reprogramación se desarma al recibirse en la oficina. Uno
  ya reprogramado, o conservado por el motorizado con fecha, sale con la misma
  guía.
- Ejemplo de liquidación. Supuestos: tarifa S/ 10, Yape al 5 %, POS al 5 % y
  producto a S/ 40. Paradas del día:
  - entrega de S/ 100 cobrada por Yape;
  - entrega de S/ 80 en efectivo;
  - un rechazo;
  - un pedido pagado por adelantado entregado sin cobro.

  | Concepto | Monto |
  | --- | ---: |
  | COD cobrado (100 + 80) | S/ 180.00 |
  | Tarifas: 3 entregas y 1 rechazo × S/ 10 | − S/ 40.00 |
  | Comisión Yape: 5 % de S/ 100 | − S/ 5.00 |
  | Comisión POS (no hubo cobros por POS) | S/ 0.00 |
  | Producto: 3 entregados × S/ 40 | − S/ 120.00 |
  | **Neto del día** | **S/ 15.00** |

  El neto entra a la cuenta corriente y se deposita ese día.
- Aprobar la liquidación deja los pedidos entregados de la tienda en
  «Finalizado · Entregado y liquidado». Una corrección posterior aparece como
  ajuste en la cuenta corriente, sin cambiar la liquidación aprobada.

## 30. Liquidaciones 2 — hojas por dominio

Plan y hallazgos en `docs/plan/liquidaciones-2.md`. Base en la migración 0176;
código en `lib/sheets/`, `app/dashboard/liquidaciones-2/` y
`components/sheets-board.tsx`.


**Reparto y liquidación, en el mismo panel (19-09-2026).** La columna
«Liquidación» de cada fila es un enlace —«Reparto y liquidación» o el estado
de la liquidación si ya existe— que abre a la derecha el reparto y el cierre
de la ruta (`?reparto=<ruta>`, `components/courier-route-report-drawer.tsx`,
datos por `loadCourierRouteReport`): paradas, «Terminar ruta operativa»,
«Cerrar con paradas sin reportar», «Reabrir ruta» y el pago del motorizado, el mismo
`RoutesBoard` de antes. Solo hay un panel abierto a la vez: abrir el reparto
cierra la caja y viceversa. La caja ya no lleva enlaces a esa pantalla; la
página `/dashboard/courier/reparto?id=` redirige a la lista con ese panel
abierto. Añadir paradas y los reintentos no van en ese panel: eso es de la
caja (paso 1) y de Despacho del día. El panel no repite datos: una fila de
métricas (paradas, efectivo en manos, Yape/POS, ganancia base, adicionales y
saldo con su explicación) y UNA tabla de paradas con cliente, pedido (y su
monto), distrito (y su tienda), resultado, cobro y respaldo, y ganancia (con
su tarifa y su adicional debajo), con scroll horizontal en pantallas medianas
y el cliente fijo a la izquierda; en el teléfono las paradas van como lista.
Tarifa y adicional quedan como plegables al pie; «+ adicional» en la fila de
una parada reportada abre el formulario con ese punto elegido. La ganancia de
un no entregado que no es rechazo dice «No se paga · solo entrega o rechazo»,
no «Sin tarifa»: ese punto no se paga con o sin tarifa (§29.10); «Sin tarifa»
queda para la entrega o el rechazo sin tarifa personal vigente (28-09-2026).

**Dos líneas por fila, como máximo (29-09-2026, pedido de Frankz).** La tabla
tiene anchos fijos por columna y cada fila ocupa a lo sumo dos líneas; lo que
no cabe se recorta y se lee entero en el tooltip. El resultado de un no
entregado se lee por su motivo, en rojo («Rechazó el pedido», «No
contesta»…), con la devolución y la nota debajo. El respaldo va como íconos
sin texto, con su nombre en el tooltip: cámara y comprobante para abrir la
foto o la captura, en ámbar lo que falta, y una cámara tachada para el
rechazo que no la exige (§29.7). «+ adicional» es un botón «+» que aparece al
pasar por la fila (siempre visible en pantallas táctiles), y el aviso de
tarifa del distrito es un ícono ámbar con el texto en el tooltip.

**Qué impide terminar la ruta, a la vista (28-09-2026).** Antes el
coordinador pulsaba «Terminar ruta operativa», leía UN error («Grupo GF:
todas las paradas deben tener reporte»), lo arreglaba y volvía a pulsar para
descubrir el siguiente: Roy, 19/09, tenía 8 paradas sin reportar, 8 entregas
sin foto y 7 Yape sin captura. Ahora arriba del panel va «Para terminar la
ruta», con TODO lo que el cierre va a rechazar y el arreglo de cada cosa al
lado:

- Una sola regla, `routeCloseBlockers` (`lib/routes.ts`), para el panel y
  para `closeRoute`: carga de Grupo GF sin recibir (vacía o con paquetes),
  ruta sin paradas, paradas sin reportar y, en Grupo GF, entregas y rechazos
  sin foto. El servidor rechaza con el primero que no se pueda forzar y su
  mensaje nombra los pedidos. Las cargas las lee `loadRouteCloseContext`
  (`lib/route-close.ts`); si no se pueden leer, el cierre se niega y el panel
  lo dice: «no lo sé» no es «no hay cargas».
- «Terminar ruta operativa» se habilita solo cuando el cierre va a pasar.
  «Cerrar con paradas sin reportar» existe solo fuera de Grupo GF y solo
  cuando lo único pendiente son paradas sin reportar.
- Cada bloqueo lleva su arreglo: «Reportar entregas» (modo coordinación, con
  «Corregir» para adjuntar la foto), «Ver en la tabla» (filtra Sin reportar,
  Sin foto o Yape sin captura), «Cancelar carga» con motivo para una carga
  abierta y vacía (permiso `dispatch.manage`) y «Abrir la caja» para una con
  paquetes sin recibir. «Volver a comprobar» relee paradas y cargas sin
  cerrar el panel.
- Debajo, lo que después frena APROBAR EL PAGO y ya se puede resolver: puntos
  sin tarifa personal («Configurar tarifa» abre «Tarifa de …») y cobros Yape
  sin captura.
- El panel ya no carga la muestra de pedidos asignables ni la cola de
  reintentos, que se pedían en cada apertura y no se enseñaban.

**Cerrar una ruta no vacía la caja: los «No entregado» se reciben o se dejan a
conciencia (29-09-2026).** La ruta de Yhoni del 26/09 se cerró el 28/09 con
#KP136779 y #KP136896 reportados «No entregado» dentro de la caja, y nadie los
recibió en oficina: al escanearlos el 29/09 para la ruta de hoy, el escaneo
decía «Ya estaba». Había 78 así, en cajas del 16 al 28/09, y 20 rechazos.

- `routeCloseBlockers` suma, en Grupo GF, **«No entregado» sin recibir en
  oficina** (`sin_recibir`): paradas «No entregado» cuyo paquete conserva su
  ítem activo en la caja (`stopsNotReceived`, el mismo criterio del escaneo).
- **Se puede cerrar igual, a conciencia** («Cerrar igual», con confirmación):
  el motorizado propio devuelve el saldo no entregado al día siguiente (§9.4),
  y exigirlo esa noche frenaría la liquidación del efectivo. Lo que queda sigue
  en «Devoluciones» y el escaneo de «Por QR» lo recibe al volver a asignarlo.
  Es lo único que se fuerza en Grupo GF; lo sin reportar y la foto no.
- **«Recibir en oficina»** en la misma fila (`receiveRouteReturns`) los recibe
  de una vez por la puerta de «Devoluciones» (`returnUndeliveredToOffice`,
  0188/0206): vuelven a «por asignar», rechazos incluidos (v1.23). Pulsarlo es
  decir que las cajas están en la oficina, y lo confirma.
- La tabla de la ruta filtra **«Por devolver»** con el mismo criterio.

**Reabrir ruta.** Una ruta cerrada vuelve a «en curso» (`reopenRoute`, permiso
`routes.manage`) solo mientras su liquidación de origen `ruta` siga en
borrador y el cálculo diario del motorizado no esté aprobado. Descarta esa
liquidación en borrador, deja `route_reopened` en cada pedido de la ruta y no
toca el Master: lo que se corrija cruza al volver a terminar la ruta, por la
puerta única. En la lista de Rutas, una ruta cerrada muestra el resultado del
reparto (entregados · no) en vez de las barras de la caja, y una ruta abierta
sin paradas ni paquetes no se lista.

**Agregar pedidos desde la caja.** El paso 1 del panel de la caja escanea
sobre ESA caja (`components/gf-box-add-packages.tsx`, `scanAssignToRider`
con el motorizado y el día de la caja): toma el pedido si hace falta y lo
mete, sin cotejarlo (la verificación es el paso 2), con la misma lista de resultados de Despacho del día
(ya estaba, en otra caja → Mover, límite de efectivo → Autorizar, no
elegible). No hay motorizado que elegir: la caja ya es de uno.

**Recojo con la carga en custodia.** En modo «confirmar» o «ninguno» (0185)
el paso 3 sigue abierto con la carga en custodia: «N paquetes sin confirmar
por Roy» y el escáner activo para los que faltan; es el respaldo cuando el
motorizado no puede confirmar desde su teléfono. «La entrega de esta carga
quedó registrada» solo cuando todos están confirmados. El paso 2 con
custodia queda cerrado: la caja ya salió. El modo viaja con los datos de la
mesa (`DispatchWorkspaceData.pickupModeByOrg`).
### 30.1 Qué es y de dónde viene

El cierre de Lima vivía en un Google Sheet («MASTER KEY 2.0»): una hoja por
repartidor, una por courier, dos hojas consolidadas por tienda con una columna
por repartidor y un resolver de estatus hecho con COUNTIFS. El cruce del
16-09-2026 contra la base mostró que los pedidos y montos de Shopify coinciden
casi al 100 %, pero que **Lima vivía en la hoja y Provincia en Kapta**: de
4.764 pedidos entregados por repartidor según la hoja, Kapta no tenía ninguno
como entregado por repartidor; y 2.563 entregas de Provincia que Kapta conoce
por las APIs estaban «Pendiente» en la hoja. Liquidaciones 2 junta las dos
verdades en hojas configurables dentro de Kapta.

### 30.2 Dominio, hoja y columna

- **Dominio**: el grupo que define el contrato. Clave de fila (pedido, guía,
  punto de ruta, valor de catálogo, periodo), vocabulario de estados con su
  equivalencia en Kapta y plantilla de columnas. Son seis: Pedidos, Catálogos,
  Reparto propio, Courier externo, Consolidado e Indicadores.
- **Hoja**: instancia del dominio (Roy, Aliclik Lima, Consolidado · Aurela).
  Hereda la plantilla y puede añadir columnas manuales; no puede romper el
  contrato. Las de Pedidos y Consolidado se crean una por tienda.
- **Columna**: cuatro tipos y nada más. `campo` lee del pedido y es de solo
  lectura; `manual` se teclea y deja historial; `lookup` busca en otra hoja;
  `derivada` aplica una regla con nombre. No existe un motor de fórmulas: lo que
  en la hoja era una fórmula por fila aquí es una regla probada.
- Alexis y Urpi son **couriers externos** aunque en el Excel tuvieran hoja de
  puntos. Reparto propio son los motorizados de Grupo GF Courier.

### 30.3 Estados por dominio y equivalencia con Kapta

Cada dominio tiene una lista cerrada de estados. Cada estado equivale a **un
estado operativo** de Kapta (§6) —el general se deriva de ahí— y declara su
efecto sobre el pedido:

| Efecto | Qué hace | Aporte al Consolidado |
| --- | --- | --- |
| informa | No cierra nada; registra el intento o el avance | T |
| entrega | Propone el cierre como entregado, con la fila como evidencia | E |
| devolucion | Propone el cierre como devuelto | D |
| anulacion | El courier lo da por cancelado. **No anula el pedido Shopify** (§9.4) | T |

Reglas:

1. Lo que llega de una hoja o de un archivo se normaliza (mayúsculas, sin
   acentos, sin puntuación final) y se busca entre los **alias de la hoja**. Cada
   hoja tiene los suyos porque Roy no escribe como Aliclik.
2. Un valor sin equivalente **no se adivina**: se guarda como alias sin
   equivalente, la fila queda a revisión y el alias aparece en la configuración
   con una sugerencia que nadie aplica sola. Es la misma disciplina que Tanders.
3. Mapear a `entrega` no cierra el pedido por sí solo. El cierre pasa por la
   puerta única a entregado (§11.4). Un pedido entregado por el repartidor y
   anulado en Shopify queda como observación abierta, nunca se resuelve solo.
4. Las equivalencias se editan desde la pantalla por quien tiene
   `sheets.manage`. La semilla (lib/sheets/statuses.ts) es el vocabulario real
   del Excel más lo que ya traducen los adaptadores de Aliclik, Shalom y
   Tanders; una vez sembrada, manda la base.

### 30.4 El Consolidado

Una fila por pedido de la tienda. Cada hoja de Reparto propio o Courier externo
aporta una marca por pedido —E entregado, T en tránsito o con intento, D
devuelto, 0 nada— y el Estatus se resuelve con la precedencia de la hoja
«Revisar»: **Entregado > Devuelto > Anulado > Tránsito > Pendiente**, con una
diferencia deliberada: «Anulado» solo lo pone Shopify. Lo que Kapta ya sabe del
pedido (su estado general, que integra las APIs de Provincia) entra como un
aporte más, así que Provincia está cubierta desde el primer día.

Columnas derivadas: zona (catálogo por distrito; si el distrito no está, la
cobertura de Kapta decide), «# Motos Lima» (intentos, solo en pedidos abiertos
de Lima), «Entregado por» y «Diferencia», que dice cuando la hoja y el Master no
coinciden. La diferencia se muestra; no se corrige sola.

### 30.5 Observaciones de cuadre

Cuando un valor externo no coincide con el de Kapta —monto, estado, pedido,
courier— se abre una observación con la hoja y fila de origen, el pedido, los
dos valores, la diferencia, un motivo del catálogo y una nota. Resolver exige
motivo; con «Otro», exige nota. El catálogo inicial sale de lo que mostraron
los datos: descuento en puerta, cobro parcial con adelanto, producto adicional
o faltante, redondeo del courier, delivery cobrado aparte, anulado en Shopify
tras entregar, error de transcripción, estado sin equivalente, pedido no
encontrado, otro.

### 30.6 Historial y permisos

Cada celda manual deja una fila append-only en `sheet_cell_history` con valor
anterior, nuevo, actor y motivo. `sheets.edit` (vendedora, admin, owner)
escribe celdas y abre o resuelve observaciones; `sheets.manage` (admin, owner)
configura dominios, hojas, columnas, estados y alias. Un viewer solo lee.

### 30.7 Reparto propio: una vista con vocabulario sobre la parada

Desde el 19-09-2026 (§29.12) la hoja de Reparto propio no es un segundo
registro: cada fila con parada apunta a ella (`stop_id`) y se llena desde la
parada; lo que sigue describe el vocabulario y la importación del Excel
histórico, cuyas filas no tienen parada y siguen valiendo tal cual hasta que
el backfill les crea una.

Una hoja por motorizado, con clave de fila **fecha#pedido**: un mismo pedido
puede salir varios días (cada salida es una fila) y dos veces el mismo día se
conserva con sufijo y aviso. Las columnas son las del cuaderno: fecha, punto,
tienda, cliente, pedido, estado, efectivo, a cobrar, método de pago y dos
observaciones, más las que Kapta añade: «En Kapta» (si el pedido existe),
«Reprogramar para», los valores escritos tal cual y «Revisión».

Reglas del lector, que es el mismo para el archivo subido desde la pantalla y
para la importación histórica:

1. La hoja se lee por bloques de fecha. Un bloque cuya fecha no se entiende
   deja sus filas **sin fecha y a revisión**; no se toma la del bloque vecino.
2. El estado escrito se normaliza y se busca en los alias de la hoja. Los días
   de la semana, «hoy» y «mañana» son **reprogramado** con la fecha calculada
   a partir del día de la ruta. Lo que no está en el vocabulario se guarda
   literal, la fila queda a revisión y el alias aparece en la configuración
   con una sugerencia que nadie aplica sola.
3. Un monto que no es número queda vacío, nunca cero. Un método de pago fuera
   de la lista cerrada se guarda literal en «Método escrito».
4. El pedido se vincula por número dentro de las tiendas de la organización.
   Sin pedido en Kapta la fila igual se guarda: la historia anterior a la
   conexión de la tienda no está en Kapta y sigue valiendo para liquidar.
5. Re-importar actualiza lo importado y **respeta lo editado a mano**.
6. Los puntos ajenos a Shopify (tienda Kast) se conservan sin vínculo.

Aporte al Consolidado: cada fila vinculada aporta la marca del efecto de su
estado (entrega → E, devolución → D, informa o cancelación → T). Una fila con
estado sin equivalente aporta T: existe, luego el pedido salió a ruta.

Cuatro estados del cuaderno son el **detalle de una no entrega** y se leen
así (definidos por la operación el 16-09-2026):

| Escrito | Estado | Equivalente Kapta | Efecto |
| --- | --- | --- | --- |
| LO DEJA | No salió a reparto: se puso en la caja del motorizado pero quedó en almacén | nunca_salio_a_reparto | sin_salida (aporta 0, no cuenta como intento) |
| DESARMAR | No se entregó y el paquete se desarma en almacén | devuelto_al_origen | devolucion (D) |
| DICE QUE RECIBIÓ / YA RECIBIÓ | No se entregó: la clienta dice que ya lo recibió por otro delivery | intento_de_entrega | informa (T) |
| REPETIDO | No se entregó: el pedido estaba repetido | intento_de_entrega | informa (T) |

«OK» como método de pago significa **pagado antes por Shopify**: el cruce del
16-09-2026 encontró 91 de 106 pedidos vinculados con checkout pagado.

**Courier externo con cuaderno.** Alexis y Urpi no son Reparto propio: son
couriers externos que reportan con el mismo cuaderno de puntos que los
motorizados. Sus hojas viven en el dominio Courier externo con formato
«cuaderno» (`config.layout`): mismas columnas y mismo lector de bloques por
fecha, pero el vocabulario de estados es el del courier (cancelado, no
contesta, reprogramado, retirado…) y **la unidad de liquidación es el courier,
no la persona que reparte**. Los demás couriers (Swayp, Aliclik, Shalom, Olva,
Axel, Tanders) usan el formato «reporte» por guía.

«VENDE MÁS» como método de pago es una app de cobro por link (operación,
16-09-2026): se lee como «Link de pago».

**Tres niveles, y el detalle nunca se pierde.** El estado escrito es el dato
y no se normaliza en la base; el estado del grupo es una lectura por alias; el
estado de Kapta es una lectura del grupo. La pantalla muestra primero lo
escrito («CEL APAGADO») y al lado la etiqueta del grupo («No responde»).
Editar a mano es texto libre, nunca un desplegable que pierda el detalle: lo
tecleado se guarda tal cual, el grupo se deriva con los mismos alias que usa
la importación, y si no resuelve la fila queda a revisión con el alias sin
equivalente a la vista para asignarlo una vez. Cambiar a qué equivale un alias
cambia el grupo de todas sus filas sin tocar lo que decían.

### 30.8 Cierre por pedido desde la hoja

Desde el 19-09-2026 la puerta es `lib/master-door.ts`, compartida con el
cierre de ruta y Liquidaciones 1 (§29.12): para una fila atada a su parada se
exige parada entregada, con evidencia si el reporte es real, y sin
observación abierta; una fila del Excel sin parada conserva solo la guarda de
observaciones. Lo demás de esta sección sigue vigente.

**Qué aplica.** Desde una hoja cuaderno, una fila vinculada a un pedido de
Kapta cuyo estado tiene efecto *entrega* puede marcar ese pedido como
entregado en el Master. Va por la **misma puerta que Liquidaciones**
(`applySettlementToMaster`): un evento `status_override` con fuente
`liquidacion`, el courier de la hoja (el de `config.courier` para un courier
externo, `propio` con el nombre del motorizado para Reparto propio), la fecha
de la ruta y el operativo por defecto de «entregado»; después se recalcula el
Master. No hay otro camino a entregado, a propósito (§11.4). Se aplica fila a
fila o todas las del periodo de una vez, con confirmación que dice cuántas.

**Qué nunca aplica.** Un pedido anulado en Kapta no se marca entregado: vive
como observación «anulado tras entregar». Un pedido que Kapta ya tiene
entregado no se vuelve a escribir. Una fila sin pedido en Kapta no puede
cruzar. No existe camino de devolución desde una hoja, ni en Liquidaciones ni
en Rutas: las filas con efecto *devolución* se cuentan y se dejan como están
hasta que exista una puerta propia. **Una fila con observación abierta no
cruza al Master: alguien lee el motivo del motorizado y lo acepta primero.**
El motivo lo escribe quien repartió; aceptarlo es de quien liquida
(`sheets.edit`); aplicar al Master exige `master.edit`.

**Observaciones automáticas.** Al importar un cuaderno y al editar a mano el
estado, el monto o el pedido de una fila, cada fila que declara entrega se
contrasta con Kapta (§30.5): un «a cobrar» que difiere del total del pedido
en más de S/ 0,50 abre una observación de monto con la diferencia firmada;
un pedido anulado o devuelto en Kapta abre una de estado; **No se
observa el comprobante**: la causa «pago digital sin comprobante validado» se
retiró el 17-09-2026 porque ese dato vive en Validar pagos, no en la hoja, y
para todo lo anterior al cuaderno en Kapta significaba «no lo sé», no «no se
pagó»; las 1.542 que abrió la carga histórica se cerraron en bloque con ese
motivo (0178, que queda en el catálogo). Nunca dos
abiertas para la misma fila y campo; una resuelta con el mismo valor externo
no se reabre. Al editar un monto que no cuadra, la propia fila pide el motivo en
línea; cerrar sin motivo deja la observación abierta sin motivo.

### 30.9 La pantalla del motorizado

Desde el 19-09-2026 hay una sola pantalla, /reparto (§29.12): la ruta del
día de Rutas con el vocabulario del cuaderno encima. Lo que sigue describe
lo que esa pantalla conserva de la antigua /reparto/cuaderno: estado escrito
con sugerencias, motivo obligatorio cuando cobra distinto, y que solo ve su
hoja (0179). Las referencias a /reparto/cuaderno se leen como /reparto.

`/reparto/cuaderno`. Vive fuera del panel, para el teléfono, y es la misma hoja
de Reparto propio que ve quien liquida: el motorizado escribe en su cuaderno
y el coordinador lo lee en Liquidaciones 2 sin que nadie copie nada.

- **Qué ve.** Su nombre, el día (hoy por defecto, se puede ir a ayer u otro),
  y un punto por tarjeta: pedido, cliente, distrito y dirección si el pedido
  está en Kapta, el monto de Kapta, y lo que él ya reportó. Al tocar un punto,
  su detalle (dirección, mapa, llamar, «Lo llevo», reporte) se abre en un panel
  al lado de la lista, no debajo de la tarjeta: en el teléfono entra deslizándose
  desde la derecha, cubre el ancho de la lista y «←» o «atrás» del navegador vuelven a ella; en pantalla ancha
  lista y detalle van en dos columnas. La parada abierta va en la URL
  (`?parada=`), así un refresco vuelve al mismo sitio. Guardar o confirmar
  cierra el panel y refresca la lista. Si hay ruta de
  despacho para ese día, un botón trae los paquetes que falten; si no, añade
  los puntos a mano buscando el pedido por número o por nombre, o escribiendo
  un punto ajeno a Shopify (Kast).
- **Qué escribe.** Estado en texto libre con sugerencias, como en el cuaderno
  de papel; a cobrar, precargado con el monto de Kapta; efectivo; método de
  pago de la lista cerrada; observación; y la foto del comprobante cuando el
  pago fue digital. Todo entra por las mismas reglas que una importación:
  alias, revisión, historial por celda.
- **El motivo es obligatorio.** Si el estado significa entrega y cobró distinto
  al monto de Kapta en más de S/ 0.50, no puede guardar sin elegir un motivo
  del catálogo y, con «Otro», una nota. Eso abre o actualiza la observación de
  monto de esa fila, con su nombre en la nota. Es lo que después lee y acepta
  quien liquida antes de aplicar al Master (§30.8): el motivo lo escribe quien
  repartió; aceptarlo es de quien liquida.
- **Solo ve su hoja.** Un usuario cuyo único rol es `motorizado` solo puede
  entrar a `/reparto`; el panel lo redirige. En la base (0179), sus lecturas
  de hojas, filas, alias, observaciones e historial quedan acotadas a la hoja
  cuyo `rider_id` es su ficha. Los dominios y sus estados siguen legibles
  porque son vocabulario, no datos de nadie. Del Master lee solo los pedidos de
  sus rutas (0186, §27).

### 30.10 Programaciones mensuales enviadas a Urpi (01/10/2026)

`/dashboard/urpi` reúne los Google Sheets mensuales de programación de Urpi.
Es una fuente documental de lo enviado: no confirma custodia, salida a reparto,
entrega, cobro ni liquidación. Vive separada de las rutas propias de Grupo GF.

Una fuente se registra por tienda, archivo y mes. El prefijo no se escribe: sale
de `stores.order_prefix` (0115) y una tienda sin prefijo no se registra. Un libro
mixto Kenku/Aurela se registra de una vez para ambas tiendas (opción por defecto),
creando una fuente por tienda que aísla KP y AUR; prefijos solapados se rechazan.
Se leen todas las pestañas con fecha del mes y las columnas reales de la plantilla.
El vínculo se resuelve por código completo dentro de la tienda; sin coincidencia
o con varias coincidencias, se conserva el registro y se pide revisión. Nunca
crea pedidos fuera de Shopify ni salidas físicas a partir de una fila del Sheet.

Cada cambio importado conserva una versión inmutable, con origen, actor y hora.
Reimportar el contenido actual no duplica la versión. Las importaciones fallidas,
incompletas o concurrentes atrasadas conservan la versión vigente. Las versiones
anteriores siguen disponibles; retirar una fila de la hoja no equivale a cancelar
ni entregar el pedido. Los conteos son de programaciones, no ventas ni intentos.

Lectura mediante conexión propia de Google con permiso de solo lectura; alternativa
de carga del libro mensual completo `.xlsx`. «Actualizar desde Google» y «Cargar
Excel del mes» sobre una fuente procesan todas las fuentes del mismo archivo y mes
que el usuario puede editar: el libro se lee una vez, cada tienda guarda su propia
versión con su prefijo, y el fallo de una no impide guardar la otra; una tienda
sin permiso de importación no se toca y se informa. La conexión de una conversación de
Codex no autoriza automáticamente al servidor de Kapta. La lectura automática se
programa cada 15 minutos para fuentes registradas del mes anterior, actual y
siguiente, según Lima. No descubre ni registra por sí sola archivos nuevos.
Los meses más antiguos mantienen actualización manual. Un libro compartido se
lee una vez por ejecución; sus prefijos siguen aislados por tienda. Una reserva
temporal y un intervalo mínimo de 10 minutos evitan lecturas automáticas
duplicadas. Cada ejecución procesa hasta 12 fuentes, priorizando las de intento
más antiguo; al agotar el tiempo, el resto queda para el siguiente ciclo.
Un fallo conserva la versión vigente, queda visible y se reintenta en el ciclo
siguiente. Las versiones automáticas registran actor de sistema (`created_by`
nulo); una lectura manual más reciente prevalece sobre datos automáticos previos.
El proceso no modifica estados de entrega ni genera reprogramaciones.
RLS restringe fuentes y versiones a `auth_store_ids()`; registrar
exige `sheets.manage` e importar `sheets.edit`, dentro de la organización elegida.

**Regla de Urpi confirmada por el owner:** «Reprogramado» es para el día siguiente
de lunes a sábado. Viernes pasa a sábado, sábado a lunes. Se calcula desde la
fecha del reporte, no desde su importación. Cruza meses y años sin crear otra
identidad de pedido ni otra salida física. Se omiten domingos; no se estableció
excepción para feriados. La usan los resultados de Urpi (§30.11) para el día del
reintento; la programación enviada conserva su fecha original.

Runbook: `docs/runbooks/urpi-programaciones.md`. Persistencia: migraciones 0215–0216.

### 30.11 Resultados de entrega que reporta Urpi (05/10/2026)

`/dashboard/urpi?vista=resultados` carga el export «Reporte del mes – detallado»
del AppSheet de Urpi (.csv). Es lo que Urpi **dice** que pasó en cada intento:
Kapta lo registra, lo vincula al pedido y propone; no lo da por hecho.

**Identidad.** Urpi exporta una fila por **intento**, no por pedido, con su
número de fila («_RowNumber») como identidad. Un reintento apunta al anterior en
«Row number relacionado», que el export pinta como fecha (serial de Excel:
«24/04/1906» es la fila 2306); el lector recupera el número. La identidad de una
fila es organización + número de fila: Kenku y Aurela comparten libro y
organización. Medido el 05-10-2026: 2307 intentos de febrero a octubre; 1072
reintentos encadenados, todos con el mismo teléfono que su anterior.

**Vínculo por teléfono (decisión del owner, 05-10-2026).** El reporte no trae
código de pedido. La cabeza de cada cadena se vincula al **único** pedido de la
organización con ese teléfono creado entre los 45 días previos al envío y el
final de ese día (hora de Lima); los reintentos heredan el vínculo de su cadena.
La tienda que a veces escribe Urpi («KENKU», «AURELA») solo desempata si deja
algún candidato. Con varios candidatos el envío queda **por vincular** —en dos
listas: lo que Urpi ya entregó y lo demás— con la
lista; sin pedido o sin teléfono válido, también. Nunca se elige por cercanía ni
por nombre. Un vínculo elegido a mano (candidato o código de pedido) se aplica a
toda la cadena y ninguna lectura posterior lo cambia. Medido sobre los 422
intentos de septiembre y octubre: 395 con un único pedido, 27 con varios, 0 sin
pedido. Esta regla vale para el reporte de resultados; la programación enviada
(§30.10) sigue cruzando solo por código.

**Qué hace cada resultado.** Lo decide el **último** intento del pedido:

| Urpi | Kapta |
| --- | --- |
| Entregado, pedido abierto en Kapta | «Entregados por marcar». Quien tiene `master.edit` los marca entregados, uno a uno o en lote, por la única puerta (§11.4, `lib/master-door.ts`): `status_override` con fuente `liquidacion`, courier `urpi`, mediodía de Lima del día del reporte y la fila de Urpi como evidencia. |
| Entregado, pedido anulado **solo en Kapta** (Shopify vivo) | También «Entregados por marcar»: solo Shopify termina una venta (v1.23). Caso real: #KP135768, entregado por Urpi el 23/09 y cerrado como anulado porque esa tarde se le emitió una guía de Tanders que se anuló sin salir. |
| Entregado, pedido anulado **en Shopify** o devuelto | Observación. Nunca se marca. Se resuelve de dos formas: si el pedido se rehízo en Shopify, se vincula el envío al pedido nuevo con su código (y pasa a «por marcar»); si no, se **cierra con motivo** —evento `urpi_observation_resolved` en el historial del pedido, que no cambia su estado— y el dinero se cuadra en la liquidación de Urpi. Un intento posterior de Urpi la reabre. El 05-10-2026 eran 6: anulados en Shopify entre 7 y 14 días después de que Urpi los entregara y cobrara. |
| Cancelado | Se registra con su motivo, detalle y fotos y se lista en «Cancelados por Urpi» para Seguimiento Lima. **No cambia el estado del Master** ni anula el pedido en Shopify. |
| Reprogramado | Se registra y se lista con su nuevo día: el siguiente de lunes a sábado desde la fecha del reporte (§30.10). No cambia el estado del Master. |
| Programado, En coordinación, sin resultado | En curso; solo informa. |
| Cualquier otro valor | «Estado no reconocido»: se guarda tal cual y no se interpreta. |

Si Kapta ya cerró el pedido (entregado, anulado o devuelto), el envío pasa a
«Al día». La diferencia entre lo que cobró Urpi y el total del pedido se
muestra; no bloquea ni mueve dinero, eso es de la liquidación.

**La salida de Urpi (decisión del owner, 05-10-2026).** Marcar entregado no
basta: la caja de Urpi está en Kapta como salida «por definir» —se arma y rotula
antes de saber el courier, y como los despachos a Urpi salen del Sheet nadie le
pone el courier—, y esa salida pendiente dejaba el pedido en «Por cerrar ·
Salida adicional activa» (37 de los primeros 40 marcados). Así que al marcar
entregado, Kapta **rellena** la salida «por definir» como salida de Urpi, igual
que la rellenan Tanders, Aliclik, Shalom y Swayp al emitir su guía (§4,
`lib/route-output-fill.ts`): se conservan consecutivo, QR, preparación y
custodia; pasa a courier `urpi`, `created_via = urpi_report`, entregada
(`delivered_source = urpi_report`) y con `dispatched_at` el mediodía de Lima del
primer intento de Urpi; queda el evento `route_output_filled`. Solo si es la
**única** caja viva del pedido: con otra salida viva —otro courier u otra «por
definir»— no se sabe qué caja se llevó Urpi y no se toca; sin «por definir», no
se crea una salida. La pantalla ofrece completar las ya marcadas antes de esta
regla con el mismo botón.

**Por qué cancelado y reprogramado no mueven el Master.** «Por reprogramar
Lima» (§9) exige una salida que conste fuera. Los despachos a Urpi salen del
Google Sheet de programación, no de la ruta de Urpi de Kapta (6 salidas de Urpi
en Kapta, todas de agosto), así que no hay salida sobre la que apoyar el intento
fallido. Pasar los cancelados a «Por reprogramar Lima» queda para una decisión
posterior: crear la salida desde el reporte o despachar a Urpi desde Kapta.

**Historial.** Cada fila se guarda como llegó y cada cambio deja una versión
inmutable; reimportar el mismo archivo no escribe filas, aunque la lectura queda
registrada. Los lotes de 200 filas son atómicos. Nunca se borra una fila que
desaparezca del export. Los intentos se ven también en la ficha del pedido
(pestaña Actividad).

**Permisos.** Cargar el reporte y vincular exige `sheets.edit` en la
organización, igual que cerrar una observación con motivo; marcar entregados
(y rellenar la salida), `master.edit`. Vincular y marcar solo alcanzan
pedidos de las tiendas que la persona ve. RLS: una fila vinculada se lee
con su tienda (`auth_store_ids()`); una sin vincular, con la organización
(`auth_org_ids()`). Escritura solo del servidor.

Runbook: `docs/runbooks/urpi-programaciones.md`. Persistencia: migración 0229.

## 31. Agradecimiento con catálogo al entregar

Cuando un pedido pasa a **entregado**, se le manda a la clienta una plantilla de
WhatsApp: gracias por la compra y un botón al **catálogo privado** de su tienda,
con los precios de descuento ya aplicados. El catálogo identifica a la clienta
por su celular (`?wa=`), así que el botón es de **URL dinámica**: la plantilla
aprobada guarda `https://…/kenku-peru/?wa={{1}}` y cada envío pone el número.

- **Es una plantilla, y de Marketing.** La entrega llega días después de la
  última conversación: la ventana de 24 h ya se cerró. Lleva una oferta, y Meta
  reclasifica o rechaza una oferta presentada como Utilidad. Meta además no
  entrega todas las de marketing a quien ya recibió muchas esa semana; que
  algunas no lleguen es normal.
- **Las 48 horas y el «único uso» del texto son un recurso de urgencia**, no
  una restricción: el catálogo es una página estática y no caduca. Decidido así
  por el owner el 25-09-2026.
- **Una vez por pedido y una por clienta cada 7 días.** Quien recibe dos
  pedidos el mismo día recibe un solo agradecimiento.
- **Solo entregas recientes** (72 h por defecto). Muchas entregas se marcan en
  bloque al importar un reporte de Aliclik, días después, y un «gracias» de
  hace una semana suena a error.
- **Ritmo: 5 mensajes cada 20 minutos, de 9 a 21 h** (configurable). Da 15 por
  hora y 180 al día como máximo: por debajo de las 250 clientas distintas al día
  con que Meta suele empezar un número nuevo, y por encima del volumen normal
  (~74 entregas al día en Kenku), así que un día normal no se frena. Salen
  primero las entregas más recientes; si una ráfaga no cabe, las más viejas
  vencen a las 72 h sin mensaje. La ventana es deslizante y cuenta todos los
  intentos, aceptados o no. Decidido el 28-09-2026: la primera activación
  encontró ~170 entregas pendientes, que con el tope anterior de 25 por corrida
  habrían salido en 35 minutos desde un número recién estrenado.
- **El celular del botón va en dígitos, sin «+»**: en una URL el «+» se lee como
  un espacio.
- **Un valor por cada botón dinámico.** La plantilla de Kenku lleva dos botones
  —«Kenku» y «Aurela», cada uno a su catálogo— y Meta exige un valor para cada
  uno o rechaza el envío entero. En Ajustes van en orden: `telefono,telefono`.
- **Nace apagado en todas las tiendas.** Se enciende en Ajustes de la tienda →
  «Agradecer al entregar», con el nombre de la plantilla ya aprobada en la WABA
  de esa tienda. Cada envío y cada rechazo quedan en `delivered_thanks_sends`.

## 32. Pedido acompañante: una caja y una guía para dos pedidos (05-10-2026)

Un **pedido acompañante** viaja dentro de la caja de otro pedido —el
**principal**— con la guía de ese. Pasa cuando la misma clienta tiene dos
pedidos abiertos —casi siempre uno de Kenku y otro de Aurela, que comparten la
cuenta de Aliclik— y la operación decide mandarlo todo junto: **una sola guía
cobra en la puerta los dos importes**.

**Por qué existe.** El modelo era una salida = un pedido (§3) y el código de
guía es único por courier, así que el caso no tenía dónde escribirse. Se
anotaba con «Cambiar estado», que **congela** el pedido (§6.1, y justo lo que
ese apartado prohíbe: el cambio manual no es una bitácora). Medido el
05-10-2026: 4 casos y 8 pedidos entre el 15-09 y el 02-10, la misma clienta en
los cuatro.

| Principal (lleva la guía) | Acompañante | Qué pasaba |
| --- | --- | --- |
| #AUR176985 (S/ 215) | #KP134433 (S/ 149) | Aliclik entregó el 16-09 y cobra **S/ 364 = 215 + 149**; el acompañante seguía en «Preparación · Por generar rótulo» |
| #AUR177589 (S/ 119) | #KP137733 (S/ 83) | Guía en ruta; el principal con candado en «Pendiente» |
| #AUR177622 (S/ 116,10) | #KP137851 (S/ 104) | Aliclik entregó el 03-10; el candado del principal lo dejaba «En curso» |
| #KP138284 (S/ 149) | #AUR177714 (S/ 62) | Guía por armar; los dos con candado |

Tres daños a la vez: los acompañantes (S/ 398) no salían nunca de Preparación
—a un clic de que alguien les generara una segunda guía—; el candado del
principal escondía lo que reportaba Aliclik; y la liquidación de la guía trae
el cobro de los dos pedidos contra el total del principal solo, que es «Reportó
más de lo esperado» y deja el lote observado (§14).

### 32.1 Reglas

1. **El vínculo es con una SALIDA, no con el pedido.** El acompañante viaja en
   una caja concreta del principal —su salida y su guía—, que es el hecho
   físico (§3, §4). Si el principal tiene otra salida, no la arrastra.
2. **Solo Aliclik, y con la guía ya emitida.** La guía combinada —productos y
   cobro de los dos pedidos— se crea en el portal de Aliclik y se vincula al
   principal como cualquier guía del portal (§10.1). Kapta no crea guías
   combinadas por API. La caja puede estar por salir, en ruta, entregada o de
   vuelta: el vínculo se puede registrar tarde, que es como se registran los
   cuatro casos de arriba. Lo único que no vale es una guía **anulada sin haber
   salido** de la empresa: esa caja ya no existe. Sumar otro courier es
   decisión del owner y se escribe aquí antes de tocar `COMPANION_COURIERS`.
3. **Quién puede ser acompañante:** un pedido distinto del principal, **de la
   misma clienta** (mismo celular, últimos 9 dígitos; sin teléfono en alguno de
   los dos no se puede comprobar y no se vincula), no anulado en Shopify, con
   el expediente sin finalizar, **sin salida propia viva** (una salida `por
   definir` se anula antes), que no lleve a su vez acompañantes y que no esté
   ya en otra caja. El principal tampoco puede ser acompañante de otro: no hay
   cadenas.
4. **Vincular y desvincular** exigen `master.edit`, ver las tiendas de los dos
   pedidos y un **motivo escrito** de 8 caracteres como mínimo. Se escriben como
   hechos en los **dos** pedidos a la vez, en un solo insert
   (`companion_linked` / `companion_unlinked` en `order_events`, con el mismo
   `link_id` en el `payload`): la línea de tiempo de cada uno lo cuenta, y nada
   se borra. El vínculo vigente lo dice el **último hecho del lado
   acompañante**; el del principal es su espejo. No hay tabla nueva ni
   migración. Se vincula desde la ficha del acompañante («¿Viaja en la caja de
   otro pedido?»), y se desvincula desde cualquiera de las dos.
5. **Qué hereda el acompañante mientras el vínculo esté vivo:** el estado de
   esa salida —courier, guía, despacho, entrega, devolución, Reproprovincia—,
   los hechos de esa salida (retorno, inventario, merma, custodia) y la
   liquidación del principal (`liquidation_closed` / `liquidation_observed`),
   porque su dinero llega en la misma fila. **No hereda** el costo logístico (el
   flete se paga una vez y está en el principal: el acompañante queda en
   S/ 0), ni la ubicación, ni el cliente, ni los cambios manuales, comentarios,
   registros de guía o cierres de expediente del principal.
6. **Mientras la caja no sale de la empresa**, el acompañante está en
   **«Preparación · Viaja en la caja de otro pedido»**
   (`en_caja_de_otro_pedido`). No es «Por generar rótulo» ni «Por armar»: no
   tiene caja propia que preparar, así que no entra a las colas del almacén,
   del despacho ni de Grupo GF. En cuanto la caja sale, sigue a su caja: En
   curso, Por cerrar, Finalizado.
7. **Vincular suelta el candado** de un cambio manual anterior **en los dos
   pedidos**, igual que registrar una guía (§6.1): es una persona decidiendo
   sobre la salida, con motivo. Desvincular no lo resucita.
8. **La mesa de rutas del acompañante se cierra** mientras esté vinculado, y el
   panel de crear guía de Aliclik no se ofrece: darle salida propia exige
   desvincularlo primero, porque sería un segundo paquete para la misma
   clienta.
9. **Una salida anulada sin haber salido deja de prestar su estado**: el
   acompañante vuelve a su propia situación (normalmente Preparación) y la
   ficha avisa de que esa caja ya no existe, hasta que alguien lo desvincule o
   lo vincule a otra caja. Anulada **después** de salir sí presta —es un «no
   entregó»— y el acompañante entra a Reproprovincia con su principal.
10. **Un reenvío no muda al acompañante.** Si el principal sale otra vez
    (Swayp, otra guía), la caja nueva puede llevar o no los productos del
    acompañante: se decide desvinculando y vinculando a la salida nueva. Sin
    eso, el acompañante sigue la suerte de la caja vieja, y su ventana de
    recuperación vence con ella.
11. **Liquidación.** La fila del courier para la guía del principal espera el
    total del principal **más** el de sus acompañantes vigentes
    (`companion_total`): con eso, S/ 364 en #AUR176985 «Coincide». Cerrar la
    liquidación del principal —en la Mesa de cierre o al validar el cobro—
    cierra la del acompañante: no se firma dos veces el mismo dinero.
12. **La puerta del Master (§11.4).** Si una ruta o una liquidación marca
    entregado al principal, el acompañante vigente se marca entregado con él,
    con la misma fuente y un motivo que nombra al principal y la guía. Las
    fuentes de esa puerta no escriben en la salida, así que sin esto el
    acompañante se quedaría «En curso».
13. **El agente de voz no llama dos veces** a la clienta: comprueba la
    recuperación con las salidas propias del pedido (§11.8), y el acompañante
    no tiene ninguna. Llama solo al principal.
14. **La ficha y el rótulo.** En «Salidas y guías» el acompañante dice en qué
    caja viaja (pedido, guía, estado); el principal lista lo que lleva y cuánto
    debe cobrar la guía en la puerta —la suma—, y avisa si Aliclik informó por
    API otro cobro. El **rótulo interno** de la caja lista también los
    productos del acompañante, con su pedido al lado, y el importe a cobrar es
    lo que todavía deben los dos.

### 32.2 Lo que no cambia

- La salida sigue siendo de un solo pedido (`shipments.order_id`) y el código
  de guía sigue siendo único por courier. El principal no cambia de estado
  por llevar acompañantes.
- El acompañante muestra en el listado la guía del principal
  (`order_master.guide_code`): buscar por guía encuentra a los dos.
- Los dos pedidos se recalculan juntos: recalcular cualquiera arrastra al otro
  (`recomputeOrderMaster`), así que un reporte de Aliclik sobre la guía mueve a
  los dos sin que nadie se acuerde.
- La versión de resolución **no sube** (`mom-v1.23`): ningún pedido tenía
  vínculo, así que ninguna fila cambia sola. Cada vínculo recalcula sus dos
  pedidos al escribirse.

### 32.3 Criterios de aceptación

- Vincular #KP137851 a la salida AUR5XAUR177622 de #AUR177622 deja a los dos
  sin candado; #KP137851 pasa a «Por cerrar · Pendiente de liquidación» con la
  entrega de Aliclik del 03-10 y costo logístico S/ 0, y #AUR177622 a «Por
  cerrar · Pendiente de liquidación».
- Un acompañante cuya caja está por armar aparece en «Preparación · Viaja en la
  caja de otro pedido», no en «Por generar rótulo» ni en las colas del almacén.
- La línea de liquidación de #AUR176985 por S/ 364, con #KP134433 vinculado,
  sale «Coincide».
- Cerrar la liquidación del principal lleva al acompañante a Finalizado
  (entregado y cerrado) sin firmarlo aparte.
- No se puede vincular: a una guía de otro courier, a una salida sin guía o
  anulada sin salir, con teléfonos distintos, un pedido con salida propia
  viva, un pedido anulado en Shopify o finalizado, ni formando cadenas.
- Desvincular devuelve al acompañante a su propia situación y queda en el
  historial de los dos pedidos con su motivo.

Implementación: `lib/order-companion.ts` (reglas puras),
`lib/order-companion-access.ts` (lectura), `lib/order-master.ts` (la caja
prestada), `lib/order-macro-stage.ts` (`en_caja_de_otro_pedido`),
`lib/settlements.ts` (`companion_total`), `lib/master-door.ts`,
`app/dashboard/pedidos/companion-actions.ts` y
`components/order-companion-panel.tsx`. Pruebas en
`test/order-companion.test.ts`.
