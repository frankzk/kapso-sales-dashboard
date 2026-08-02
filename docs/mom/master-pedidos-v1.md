# Master Operations Map — Master de Pedidos v1

Estado: Fase 4 implementada; Mesa de cierre y resumen operativo publicados
Propietario del proceso: Frankz  
Sistema: Kapta (`kapso-sales-dashboard`)  
Fuente visual: board Miro «Master Operations Map»  
Última consolidación: 2026-08-01

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
- Cada salida nueva genera un QR nuevo.
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
- Tanders es exclusivo de cobertura Lima. No se muestra ni se acepta desde el
  servidor para Provincia COD o Agencia.
- Cañete siempre se clasifica como Agencia, aunque Shopify lo etiquete como
  `Lima (provincia)` o exista una tarifa COD histórica que coincida.
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
- `por_confirmar`: existe al menos un contacto del día.
- `volver_a_contactar`: existe fecha o compromiso de próximo contacto.
- `ultimo_intento`: séptimo día de gestión.
- `pago_requerido_pendiente`: Agencia confirmó verbalmente, pero todavía no se
  validó el pago exigido.

Reglas:

- Un pedido que ya tuvo contacto nunca vuelve literalmente a `Sin llamar`.
- Llamada normal, llamada WhatsApp y mensaje escrito realizados el mismo día
  constituyen un día de intento.
- Se gestionan siete días distintos. Dentro de un día puede haber varios
  contactos.
- El día siete es `Último intento`; después se crea una tarea de anulación
  manual en Shopify. Kapta nunca anula automáticamente.
- Existe un recordatorio automático una vez transcurridas dos horas laborales
  sin respuesta.
- Horario laboral: 08:00–22:00, hora de Lima. El reloj se pausa fuera de horario.
- Provincia COD queda confirmada al validar producto, cantidad, monto, fecha
  aproximada y dirección de entrega.
- Agencia queda confirmada solo cuando el pago exigido ha sido validado.
- Crear el rótulo implica confirmación; no puede existir rótulo para un pedido
  de Provincia/Agencia sin confirmación válida.

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
- Para Aliclik, el estado autenticado `PREPARED` constituye el evento equivalente
  a ese escaneo físico y mueve automáticamente la salida a
  `Por despachar · Listo para asignar`. No se exige un tercer escaneo en Kapta.
- La equivalencia completa de despacho Aliclik es: `TO_PREPARE` →
  `Preparación · Por armar`; `PREPARED` → `Por despachar · Listo para asignar`;
  `PICKED` → `En curso · Recibido por courier`.
- Estos avances son monotónicos: un reporte atrasado de Aliclik no puede deshacer
  un escaneo local ni devolver ficticiamente la custodia desde el courier.
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
- Si Aliclik no entrega, el pedido puede ingresar a Reproprovincia.
- Solo Aliclik tiene proceso de indemnización formal.

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

Ciudades con stock/operación conocidas: Arequipa, Huancayo, Juliaca/Puno,
Cusco, Trujillo.

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
- Si cualquiera de las dos señales leídas pertenece a otra cuenta, el pago queda
  en revisión y Kapta bloquea su validación también en servidor. Si una señal no
  pudo leerse, se conserva la imagen y se exige contraste manual sin inventar el
  dato faltante.
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
- Validar pagos: grupo autorizado por cuenta.
- Excepción COD por riesgo: justificación obligatoria.
- Continuar con discrepancia geográfica: justificación obligatoria.
- Retirar del manifiesto: motivo obligatorio.
- Corrección de resultado courier: evento de corrección, nunca edición destructiva.
- Cerrar liquidación observada: rol financiero autorizado.

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
- Primer cotejo: oficina confirma que el paquete completo está físicamente en
  la caja/agrupación correcta.
- Segundo cotejo: el propio motorizado confirma todo lo que recibe.
- Crear, organizar o enviar una ruta no cambia custodia.
- `finalize_dispatch_manifest()` bloquea la ruta y vuelve a comprobar el 100 %
  de ambos cotejos dentro de una sola transacción antes de mover todos los
  paquetes a custodia `courier`.
- Un faltante se retira expresamente con motivo, persona y hora. No se borra.
- Cada creación, escaneo, retiro, cancelación y transferencia queda en
  `dispatch_events`; los movimientos por pedido también llegan a `order_events`.
- Cámara del celular, lector USB y escritura manual resuelven el mismo token QR,
  código de salida o código de guía.

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
- El resolver quedó versionado como `mom-v1.4`; el cron detecta versiones
  anteriores y recalcula el histórico por lotes hasta que todo el Master
  converja, sin necesitar credenciales locales ni detener la sincronización.

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
- El primer escaneo de oficina puede agregar y cotejar el paquete en una sola
  acción operativa.
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
- El rótulo interno contiene pedido, salida, courier, cliente, destino, productos
  y el QR que consume la mesa de despacho.
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

## 25. User journey del drawer del Master

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
- El motorizado se elige de una lista **filtrada por el courier** y solo con
  fichas activas. Siempre existe «Sin asignar» (p. ej. Urpi, Swayp o Tanders
  cuando no se conoce al conductor).
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
- La selección alcanza solo a los pedidos visibles en la página actual: el Master
  pagina en el servidor y no expone los identificadores del filtro completo.
- El QR impreso identifica la salida y es el que se escanea en ambos cotejos
  (§6.3). El contenido del rótulo se lee bajo RLS: una salida de otra tienda no
  aparece aunque se manipule la URL.

