# Clientes externos de Grupo GF Courier — plan

Versión 1 · 05-10-2026 · rama `claude/ecstatic-feynman-2w64ot`

Grupo GF Courier hoy reparte solo para tiendas de su propia organización
(Aurela y Kenku). Este plan lo abre a **tiendas cliente**: negocios ajenos, con
su propia organización y su propio Shopify, que le encargan pedidos. La
especificación funcional vive en el MOM (`docs/mom/master-pedidos-v1.md`, §29);
este documento es el plan de trabajo y el registro de lo que se encontró en el
código. **Nada de esto cambia el MOM todavía**: las reglas nuevas se aprueban y
se escriben allí en la Fase 0, antes de programar (AGENTS.md).

## 1. Decisiones tomadas (05-10-2026)

| # | Decisión |
| --- | --- |
| 1 | El cliente usa **Kapta completo** en **su propia organización**: su Master, su Shopify, su equipo. Grupo GF no es dueño de su tienda ni entra a su organización. |
| 2 | **El cliente elige qué pedidos** encarga a Grupo GF. Sus pedidos no aparecen solos en «Pedidos disponibles» como los de Aurela y Kenku. |
| 3 | La **liquidación Grupo GF ↔ tienda** entra en la primera versión. |
| 4 | **Una sola base de datos**, separada por organización (propuesta, §2). |

## 2. Una sola base de datos

Kapta ya es multi-organización: `docs/onboarding-tienda-externa.md` da de alta a
otro dueño en su propia organización, y la seguridad de la base (RLS) le muestra
solo sus tiendas. Separar una base por cliente rompería lo central de este
servicio:

- **Una ruta mezcla tiendas** (§29.5). La caja de un motorizado lleva paquetes
  de Aurela y de dos clientes a la vez; caja, ruta, QR y liquidación del
  motorizado son un solo registro. Con bases separadas habría que sincronizarlos
  y tendríamos dos verdades del mismo hecho.
- **El aislamiento entre clientes ya existe** por organización. Lo nuevo es un
  permiso acotado para Grupo GF: ver **solo los pedidos que cada cliente le
  asignó**, nada más de su tienda (§29.10).

El riesgo real no está en la base sino en el código: muchas pantallas de Grupo
GF leen con la llave de servicio, que se salta la RLS. Por eso cada fase incluye
pruebas de aislamiento entre dos clientes.

## 3. Quién es dueño de qué

| Vive en la organización del **cliente** | Vive en la organización de **Grupo GF** |
| --- | --- |
| Tienda, conexión Shopify, pedidos (`orders`, `order_master`) | Operador (`logistics_providers`), tarifas y comisión |
| Salidas y QR (`shipments`), actividad (`order_events`) | Motorizados, rutas (`delivery_routes`), cajas (`dispatch_manifests`) |
| Pagos previos del cliente final (`order_payments`) | Paradas y su evidencia (`delivery_stops`, con el `store_id` del cliente) |
| Lectura de su liquidación | Pago a motorizados, liquidación al cliente y su aprobación |

El **contrato** (`logistics_service_agreements`: `provider_id`, `client_org_id`,
`store_id`) une las dos y es lo único que da acceso de una a otra. La
**solicitud** (`logistics_requests`) es el pedido concreto que el cliente
encargó, con la tarifa congelada.

## 4. Recorrido de un pedido

1. El cliente conecta su Shopify en Kapta (ya existe) y acepta el contrato que
   Grupo GF le ofrece.
2. En la Mesa de ruta de su pedido ve Grupo GF Courier con distrito, tarifa y
   fecha prevista, y pulsa **«Asignar a Grupo GF Courier»** (uno o en lote).
3. Kapta valida contrato, cobertura, tarifa y pausas, congela la tarifa y crea
   la solicitud y la salida con su QR (o rellena la caja `por definir`).
4. El pedido aparece en Grupo GF en «Pedidos tomados · Sin ruta», con el nombre
   de la tienda. Desde ahí sigue el camino de siempre: asignar a una caja,
   cotejo de oficina, recepción del motorizado, reparto, reporte y cierre de
   ruta.
5. El cliente ve en su Master la etapa y la evidencia (foto, comprobante), sin
   nombre ni teléfono del motorizado (§29.7).
6. Al terminar el día, Grupo GF aprueba la liquidación de esa tienda: cobrado −
   tarifa − 3.5 % del Yape recibido = neto. El cliente la ve en su Kapta.

## 5. Lo que hoy lo impide

Tres revisiones del código (cadena operativa, lado del cliente y dinero)
encontraron unos 30 puntos. Casi todos vienen de cuatro causas:

**a) Grupo GF se busca en la organización de la tienda.**
`loadGroupGfCourierRouteCheck` (`lib/grupo-gf-courier-route-access.ts:66-98`)
responde «Grupo GF Courier todavía no está activado» para cualquier tienda de
otra organización. Lo usan tomar, asignar, escanear, la Mesa de ruta y el drawer.
Además, `activateGroupGfCourier` (`app/dashboard/courier/actions.ts:1998-2120`)
solo crea contratos para tiendas propias, y el owner de cualquier organización
nueva tiene `logistics.manage` (`lib/permissions.ts:224`): ve el menú de Grupo GF
y podría crear un segundo operador en su organización.

**b) El equipo de Grupo GF no ve los pedidos del cliente.** Las políticas de
`shipments`, `order_master`, `order_events`, `orders`, `dispatch_manifest_items`
y `delivery_stops` filtran por `auth_store_ids()`. Todo lo que lee con la sesión
del usuario los pierde:

| Pantalla | Efecto |
| --- | --- |
| Escaneo de QR (`despacho/actions.ts:79-109`) | «No encontramos…» al escanear, cotejar o recibir de vuelta |
| Cajas del día (`lib/dispatch-access.ts:116-217`) | Las cajas muestran menos paquetes; una caja solo de un cliente se ve vacía |
| Rótulos (`app/api/pedidos/rotulos/route.ts`) | 404 |
| Coordinación y fotos (`app/reparto/actions.ts:76-82`, `app/api/reparto/foto`) | «Esa parada no es tuya» al reportar por el motorizado |
| Drawer del pedido (`pedidos/actions.ts:122-140`) | «Sin acceso a este pedido» |
| Cierre de ruta (`rutas/actions.ts:286-324`) | **Silencioso:** la ruta se cierra con paradas del cliente sin reportar, no llegan al Master y quedan sin liquidar |
| Libro de rutas y búsqueda (`lib/courier-route-ledger.ts`, `lib/courier-route-search.ts`) | Conteos y contraentrega (COD) incorrectos |

Ya funcionan de una organización a otra, y no se tocan: la app del motorizado
(`/reparto`), la bandeja de admisión, asignar a caja y todas las funciones SQL
`gf_*`, que no comparan organizaciones.

**c) Filtros explícitos por «tiendas de mi organización».** Reprogramar
(`courier/actions.ts:1437-1444`), buscar por número de pedido (`:1377`,
`:2566`), quitar de la caja (`despacho/actions.ts:575`), importar el cuaderno
(`lib/sheets/reparto-import-db.ts:76-95`) y el universo de distritos del
tarifario (`courier_lima_districts`, 0135).

**d) No existe la liquidación a la tienda.** `merchantSettlement`
(`lib/grupo-gf-courier.ts:215`) no lo usa nadie. Tampoco hay tabla, cálculo ni
pantalla. Y dos huecos de origen:

- El Yape que el motorizado recibe en la puerta no se valida como dinero: solo
  se exige la captura (`lib/routes.ts:117-119`).
- `payment_method = 'yape'` no dice a qué cuenta entró
  (`lib/sheets/stop-bridge.ts:88-106`), así que hoy no se puede calcular «lo
  recibido en el Yape de Grupo GF».

**Además, privacidad (§29.7).** El cliente leería el nombre del motorizado en:

- el drawer: «Lo lleva Roy» (`lib/gf-delivery.ts:123-173`);
- las notas de su actividad (`stop-report.ts:246-272` y las funciones SQL de
  0185, 0196 y 0206);
- los payloads con `driver_name`;
- `logistics_requests.observation`;
- `removal_reason`;
- el correo del personal de Grupo GF como autor de cada evento
  (`orders-master-access.ts:814-842`).

Hoy no se filtra porque todos somos la misma empresa.

## 6. Decisiones abiertas

Cada una cambia el MOM. Van con recomendación.

**A. Producto y armado.** §29.2 dice que Grupo GF reserva, arma y rotula, y que
no recoge paquetes armados en otro almacén.

1. El stock del cliente se guarda en el almacén de Grupo GF y Grupo GF lo arma.
   Es lo que dice el MOM. Exige que el Almacén de Grupo GF vea esos pedidos y
   que el Almacén del cliente no los prepare también.
2. El producto es de Proveeduría Grupo GF y el cliente lo revende (la bolsa
   compartida de §29.3). Mismo trabajo que la opción 1, más saber de qué bolsa
   sale cada línea.
3. El cliente arma, rotula en su Kapta y **deja** las cajas en Grupo GF. Es lo
   más barato para la v1: no hay inventario ajeno ni armado entre
   organizaciones, y el cotejo de oficina hace de recepción. Pero cambia §29.2.

**B. ¿Asignar obliga a Grupo GF o Grupo GF acepta?** Recomiendo que **obligue**,
dentro del contrato. Grupo GF se protege con las pausas por distrito que ya
existen, y puede observar o anular con motivo. Aceptar uno por uno exige un
estado nuevo («solicitada») que el MOM no tiene.

**C. ¿A dónde paga el cliente final en la puerta?** Recomiendo que **todo** vaya
a Grupo GF (efectivo, Yape de Grupo GF y POS) y que Grupo GF liquide el neto. Si
el cliente final paga directo a la cuenta de la tienda, el reporte lo marca como
«pago directo a la tienda»: no entra al neto ni paga comisión. Para eso el
reporte debe registrar la cuenta receptora, no solo «Yape».

**D. Saldo y pago.** Un pedido pagado por adelantado no cobra nada en la puerta,
pero sí debe la tarifa: el neto del día puede salir negativo. Recomiendo una
**cuenta corriente por contrato**: cada liquidación aprobada suma su neto
(positivo o negativo), cada depósito de Grupo GF o pago del cliente resta, y se
deposita el saldo a favor con la frecuencia que pacten. Hoy no existe nada
parecido.

**E. Qué incluye «Kapta completo».** Swayp (con remitente de Kenku), Shalom,
el agente de voz (Zadarma/Telnyx) y Chatby usan **credenciales únicas de Grupo
GF** en variables de entorno (`lib/env.ts`). Un cliente que las use actuaría con
las cuentas de Grupo GF. Recomiendo apagarlas para organizaciones cliente en la
v1, hasta que sean por tienda.

## 7. Fases

Cada fase se despliega sola, no cambia nada para Aurela y Kenku, y trae sus
pruebas. Las migraciones se corren a mano antes del código (`DEPLOY.md`).

### Fase 0 — Reglas en el MOM (sin código)

- Escribir en el MOM las decisiones de §1 y §6. Ver §8.
- Probar con el primer cliente cómo conecta su Shopify: el token de app
  personalizada que usa `docs/onboarding-tienda-externa.md` o la app de Kapta
  por OAuth. Hay que verificar en Shopify que la app se pueda instalar en
  tiendas ajenas; el repo no lo dice.

### Fase 1 — Contrato con otra organización

- **Consentimiento del cliente.** Grupo GF crea una invitación: contrato en
  `draft`, con nombre del cliente y, si aplica, tarifas propias. El owner del
  cliente la acepta en los ajustes de su tienda. Recién ahí el contrato pasa a
  `active`, con `client_org_id` y `store_id` comprobados (lo exige el
  comentario de 0134:55-58). Grupo GF nunca engancha una tienda ajena por su
  cuenta.
- **Un solo Grupo GF.** El operador es único. El menú y el botón «Activar» solo
  aparecen a miembros de la organización del operador; se corrige
  `courier/page.tsx:41` (`memberships[0]`).
- **Validación por contrato.** `loadGroupGfCourierRouteCheck` encuentra el
  operador a partir del contrato vigente de la tienda; para Aurela y Kenku da lo
  mismo que hoy. Corre en el servidor, porque con la sesión del cliente no se
  ven las pausas generales (0137:39).
- **Tarifario.** El universo de distritos incluye las tiendas con contrato.
- **Campo nuevo en el contrato: quién inicia.** `cola_operador` para Aurela y
  Kenku, `tienda_asigna` para clientes. `assignment_mode` existe pero no se lee
  en ningún sitio.
- **Pruebas.** Validación entre organizaciones, invitación aceptada y rechazada,
  y que no se pueda crear un segundo operador.

### Fase 2 — Grupo GF ve solo lo que le asignaron

- **RLS.** Nueva función `auth_provider_order_ids()`: pedidos con solicitud del
  operador, para miembros de la organización del operador. Sigue el mismo
  patrón de `auth_rider_order_ids()` (0186). Se agregan políticas de lectura en
  `order_master`, `orders`, `shipments`, `order_events`,
  `dispatch_manifest_items`, `delivery_stops` y `gf_dispatch_programs`. Grupo
  GF ve los pedidos asignados, nunca el resto de la tienda.
- **Filtros por organización.** Los de §5c pasan a «tiendas con contrato» con
  un solo helper.
- **Cierre de ruta.**
  - Deja de saltarse paradas del cliente.
  - Aplica sus entregas al Master.
  - Para tiendas cliente no crea `rider_settlements` en la organización del
    cliente: eso lo reemplaza la Fase 5.
- **Pruebas.**
  - Un smoke SQL por pantalla de §5b (patrón `scripts/sql/gf_*_smoke.sql`).
  - Una prueba de aislamiento: el cliente A no ve nada del cliente B, y Grupo
    GF no ve los pedidos que el cliente no le asignó.

### Fase 3 — La tienda asigna

- **Pedidos disponibles.** Excluye las tiendas `tienda_asigna`
  (`courier/actions.ts:470-499`).
- **Mesa de ruta y Master del cliente.** La tarjeta de Grupo GF muestra
  distrito, tarifa y fecha prevista. «Ver en Grupo GF» pasa a «Asignar a Grupo
  GF Courier» (`order-drawer.tsx:845-849`, `order-route-desk.tsx:199-202`), y
  hay asignación en lote desde el Master (`orders-master.tsx:1238`).
- **Acción de servidor.**
  - Exige `master.edit` en la organización del cliente y el contrato vigente.
  - Reutiliza `takeOrdersCore`: mismas validaciones, idempotencia, tarifa
    congelada y relleno de la caja `por definir` conservando el QR.
  - Guarda `requested_by` con el usuario del cliente.
  - Escribe con la llave de servicio, porque la RLS de `logistics_requests`
    solo deja escribir al operador (0138:95-103).
- **Cancelar o reprogramar desde la tienda**, con motivo (§29.6). Propuesta
  para la v1: la tienda cancela mientras el pedido no está en una caja; después
  lo hace Grupo GF.
- **Lo que dependa de la decisión A**: Almacén entre organizaciones, o
  recepción de cajas armadas por el cliente.

### Fase 4 — Privacidad del cliente

- **Notas y payloads.** Para tiendas de otra organización, los flujos de Grupo
  GF escriben «Motorizado de Grupo GF», no su nombre. Son los de TypeScript y
  los SQL listados en §5, más `observation` y `removal_reason`. El `rider_id`
  se conserva.
- **Drawer.** Oculta nombre del motorizado y correo del personal de Grupo GF a
  quien no es del operador, y muestra «Grupo GF Courier» en vez de `propio`.
- **Prueba.** Con la sesión del cliente, ninguna consulta directa a la API
  devuelve un nombre de motorizado.

### Fase 5 — Liquidación Grupo GF ↔ tienda (v1)

- **Tablas.**
  - Liquidación diaria por contrato: cabecera y líneas por parada.
  - Correcciones append-only con motivo, como pide §14 (patrón 0093).
  - Si se aprueba D, cuenta corriente con depósitos y cobros.
- **Cálculo.** Una función SQL que devuelve una foto en JSON, como
  `rider_pay_preview` (0222). Por tienda y día, sobre las paradas de rutas de
  Grupo GF:
  - lo cobrado, por medio;
  - la tarifa congelada de la solicitud (`logistics_requests.tariff_amount`,
    vía `shipment_id`) para entregado o rechazado, con el rechazo cobrado una
    vez por pedido y ruta/día;
  - el 3.5 % sobre cada Yape recibido por Grupo GF, redondeado por operación,
    con la regla vigente (la del contrato gana a la general);
  - el neto.
- **Bloqueos.** Una ruta abierta, una parada pendiente, evidencia faltante o una
  línea sin tarifa («Sin tarifa configurada», nunca S/0).
- **Aprobación.** Humana, con `settlements.close` en la organización de Grupo
  GF, contra la versión vista y congelando el resultado (patrón
  `rider_pay_approve`, 0162).
- **Reporte de parada.** Para tiendas cliente registra la cuenta receptora
  (decisión C).
- **Lado del cliente.** Ve su liquidación, líneas y evidencias en su Kapta, solo
  lectura.
- **A definir en el MOM.** Cuándo queda cerrado financieramente el pedido del
  cliente: al aprobar su línea o al registrar el depósito.
- **v2.** Cruce automático del Yape de Grupo GF con su estado de cuenta. En la
  v1 la aprobación humana compara el total contra el estado de cuenta.

### Fase 6 — Piloto

- Actualizar `docs/onboarding-tienda-externa.md`:
  - pasos del contrato;
  - `order_prefix` de la tienda (nace vacío);
  - la lista de aislamiento ampliada: cliente A ≠ cliente B, el cliente no ve
    motorizados, Grupo GF no ve lo no asignado.
- Un cliente, pocos pedidos, un día completo hasta la liquidación aprobada.

## 8. Cambios al MOM (Fase 0)

- **§29.1–§29.2.** Tienda cliente en su propia organización; el contrato dice
  quién inicia; Aurela y Kenku siguen en cola automática. Más la decisión A.
- **§29.6.** La tienda asigna, cancela y reprograma: hasta cuándo y con qué
  motivo.
- **§29.7.** Qué ve el cliente y qué se le oculta, en concreto.
- **§29.9.**
  - Liquidación a la tienda: líneas, rechazo una vez por pedido y ruta/día,
    pedidos pagados por adelantado.
  - Cuenta receptora en la puerta.
  - Saldo (decisión D) y cierre financiero del pedido del cliente.
- **§29.10.** Grupo GF ve solo los pedidos asignados; el owner de un cliente no
  administra operadores.
- **§29.11.** El paso 5 se divide: tiendas Shopify ahora; API y Excel después.

## 9. Riesgos

- **Lecturas con la llave de servicio.** Toda lectura entre organizaciones pasa
  por el helper de «tiendas con contrato»; las pruebas con dos clientes son
  obligatorias en cada fase.
- **Conexión Shopify.** No está verificado que la app de Kapta (OAuth) se pueda
  instalar en tiendas ajenas, ni que Shopify siga permitiendo crear apps
  personalizadas desde el admin. Se prueba en la Fase 0.
- **Integraciones con credenciales globales** (decisión E).
- **Token `propio`.** Las salidas de clientes también lo llevan (§29.2). El
  cliente vería «propio» si no se traduce (Fase 4).
- **Permisos sumados entre organizaciones.** `getMasterPermissions` suma
  permisos de todas las organizaciones del usuario
  (`lib/permissions-access.ts:43-54`). Alguien que esté en Grupo GF y en un
  cliente tendría permisos cruzados en pantalla, aunque el servidor valide por
  organización.

## 10. Fuera de la v1

- Portal por API o Excel para tiendas sin Shopify (§29.11 paso 5, segunda
  parte).
- Inventario estricto y reservas por bolsa (§29.3), salvo que la decisión A lo
  exija.
- Cobro de la suscripción de Kapta a los clientes.
- GPS en el reporte (§29.7): no existe en ninguna parte todavía.
- Enlace público de seguimiento para el cliente final.
- Cruce automático del Yape de Grupo GF con su estado de cuenta.
