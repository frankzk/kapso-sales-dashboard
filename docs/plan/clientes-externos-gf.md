# Clientes externos de Grupo GF Courier — plan

Versión 5 · 08-10-2026 · rama `claude/ecstatic-feynman-2w64ot`

Grupo GF Courier hoy reparte solo para tiendas de su propia organización
(Aurela y Kenku). Este plan lo abre a **tiendas cliente**: negocios ajenos, con
su propia organización y su propio Shopify, que le encargan pedidos. La
especificación funcional vive en el MOM (`docs/mom/master-pedidos-v1.md`, §29);
este documento es el plan de trabajo y el registro de lo que se encontró en el
código. **Nada de esto cambia el MOM todavía**: las reglas nuevas se aprueban y
se escriben allí en la Fase 0, antes de programar (AGENTS.md).

Piloto: **noviembre de 2026**, con un cliente de **menos de 20 pedidos al
día**.

## 1. Decisiones tomadas (05-10-2026)

### Modelo

| # | Decisión |
| --- | --- |
| 1 | El cliente usa **Kapta completo** en **su propia organización**: su Master, su Shopify, su equipo. Grupo GF no es dueño de su tienda ni entra a su organización. |
| 2 | **Una sola base de datos**, separada por organización (§2). |
| 3 | **Alta por invitación.** El registro público de Kapta sigue cerrado: Grupo GF invita por correo al dueño, que entra, crea **su** organización, conecta su Shopify y acepta el contrato con un código. Grupo GF nunca es dueño de esa organización. |
| 4 | Swayp, Shalom, el agente de voz y Chatby **quedan apagados** para organizaciones cliente: usan credenciales únicas de Grupo GF (`lib/env.ts`). |

### Asignación y operación

| # | Decisión |
| --- | --- |
| 5 | **El cliente elige qué pedidos** encarga. Sus pedidos no aparecen solos en «Pedidos disponibles» como los de Aurela y Kenku. |
| 6 | **Asignar obliga.** Si el pedido cumple contrato, cobertura, tarifa y no hay pausa, queda tomado. Grupo GF puede anular con motivo. No hay estado «solicitada». |
| 7 | **La tienda cancela cuando quiera, sin costo** (§29.6), aunque el paquete esté en la caja o en la calle: vuelve al almacén y se desarma. |
| 8 | **El reintento lo decide el cliente.** Un no entregado vuelve a su Master en «Por reprogramar» y él lo reprograma con fecha. |
| 9 | **Desarmado.** Al volver al almacén, si el pedido **no tiene reprogramación registrada**, el paquete se desarma y el producto vuelve a su bolsa. Reprogramar después arma de nuevo, con guía y QR nuevos. Si ya estaba reprogramado, sale otra vez con la misma guía. Un «Reprogramado por el cliente» que el motorizado **conserva** (§29.7, 07-10-2026) cuenta como reprogramación registrada: sale en la ruta del día pedido sin volver a la oficina, y la tienda lo ve en su Master con la fecha y puede cancelarlo o cambiarla. |
| 10 | **Marca blanca.** El rótulo y los mensajes del motorizado llevan el nombre de la tienda cliente. Ya funciona así: `lib/labels/rotulo-pdf.ts:646`, `lib/rider-contact.ts`. |
| 11 | El **motorizado gana lo mismo** por un pedido de cliente que por uno de Aurela o Kenku. |

### Producto

| # | Decisión |
| --- | --- |
| 12 | **Grupo GF arma** en su almacén. El producto puede ser de Proveeduría Grupo GF (hoy, la mayoría) o del cliente guardado en Grupo GF, y un pedido puede mezclar los dos. |
| 13 | **Mapeo de SKU obligatorio** por tienda: cada SKU del Shopify del cliente es «producto Grupo GF X» o «producto propio del cliente». Un pedido con una línea sin mapear no se puede asignar. |
| 14 | **Bolsa por línea, sin control de stock** en la v1: se registra de qué bolsa sale cada línea para armar y cobrar, sin reservar ni contar. Conteo y recepción del inventario del cliente, en la v2. |
| 15 | **Catálogo visible al cliente**: nombre, SKU, precio a la tienda y foto de cada producto de Proveeduría. |
| 16 | **Precio del producto a la tienda**: un precio general por producto, con vigencia, y excepciones por contrato. |
| 17 | El producto de Proveeduría se cobra **solo en lo entregado**. Un rechazo o un no entregado lo devuelve a la bolsa sin cargo. |
| 18 | **Pérdida o daño de producto del cliente: caso a caso.** El paquete queda observado y Grupo GF registra un ajuste con motivo en la cuenta corriente. |

### Dinero

| # | Decisión |
| --- | --- |
| 19 | **Tarifa por distrito: una tabla general de externos**, aparte de la interna de Aurela y Kenku, más excepciones por contrato. Incluye IGV, igual que hoy. |
| 20 | **Comisión Yape para externos: 5 %** general, con excepción por contrato. Aurela y Kenku siguen con 3.5 %. (Confirmado el 08-10-2026.) |
| 21 | **Comisión POS**: un porcentaje por contrato, con vigencia. |
| 22 | **Todo cobro en la puerta va a Grupo GF**: efectivo, Yape de Grupo GF y POS. Si el comprador igual paga directo a la tienda, se marca «pago directo a la tienda»: no entra al neto ni paga comisión. |
| 23 | La **liquidación Grupo GF ↔ tienda** es diaria y entra en la v1. |
| 24 | **Cuenta corriente por contrato.** Cada liquidación aprobada suma su neto, positivo o negativo; cada depósito de Grupo GF o pago del cliente resta. |
| 25 | **Depósito diario** del saldo a favor al aprobar la liquidación del día. Un saldo en contra se arrastra. |
| 26 | **Deuda: suspensión manual.** Grupo GF ve el saldo y suspende el contrato cuando decide (§29.10). Nada se bloquea solo. |
| 27 | El pedido del cliente queda **cerrado financieramente al aprobar** la liquidación que lo incluye. |
| 28 | **Liquidación de solo lectura** para el cliente en la v1. Los reclamos van por fuera y Grupo GF registra el ajuste. |
| 29 | **Facturas fuera de Kapta** en la v1. Kapta muestra montos con IGV incluido y exporta el detalle. |

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
| Tienda, conexión Shopify, pedidos (`orders`, `order_master`) | Operador (`logistics_providers`), tarifas, comisiones y catálogo de Proveeduría |
| Salidas y QR (`shipments`), actividad (`order_events`) | Motorizados, rutas (`delivery_routes`), cajas (`dispatch_manifests`) |
| Pagos previos del comprador (`order_payments`) | Paradas y su evidencia (`delivery_stops`, con el `store_id` del cliente) |
| Mapeo de sus SKU | Pago a motorizados, liquidación al cliente, cuenta corriente |

El **contrato** (`logistics_service_agreements`: `provider_id`, `client_org_id`,
`store_id`) une las dos y es lo único que da acceso de una a otra. La
**solicitud** (`logistics_requests`) es el pedido concreto que el cliente
encargó, con tarifa, bolsa y precio de cada línea congelados.

## 4. Recorrido de un pedido

1. Grupo GF invita por correo al dueño. Este entra, crea su organización,
   conecta su Shopify, acepta el contrato con su código y mapea sus SKU mirando
   el catálogo de Proveeduría.
2. En la Mesa de ruta de su pedido ve Grupo GF Courier con distrito, tarifa y
   fecha prevista, y pulsa **«Asignar a Grupo GF Courier»** (uno o en lote).
3. Kapta valida contrato, cobertura, tarifa, pausas y mapeo; congela tarifa,
   bolsa y precio de cada línea; y crea la solicitud y la salida con su QR (o
   rellena la caja `por definir`).
4. El pedido aparece en Grupo GF en «Pedidos tomados · Sin ruta», con el nombre
   de la tienda. El Almacén de Grupo GF lo arma con producto de Proveeduría o
   del cliente, según la bolsa de cada línea.
5. Sigue el camino de siempre: asignar a una caja, cotejo de oficina, recepción
   del motorizado, reparto, reporte y cierre de ruta. El comprador ve la marca
   de la tienda.
6. El cliente ve en su Master la etapa y la evidencia (foto, comprobante), sin
   nombre ni teléfono del motorizado (§29.7).
7. **Si no se entrega**, vuelve al Master del cliente en «Por reprogramar». Al
   llegar al almacén:
   - con una reprogramación ya registrada, sale otra vez con la misma guía; si
     el comprador se la pidió al motorizado y él conserva el paquete, ni
     siquiera vuelve: pasa a la ruta del día pedido;
   - sin ella, se desarma y el producto vuelve a su bolsa. Reprogramar después
     genera una solicitud y una salida nuevas.
8. Al terminar el día, Grupo GF aprueba la liquidación de esa tienda. Su neto
   pasa a la cuenta corriente, el pedido queda cerrado financieramente y se
   deposita el saldo a favor. El cliente la ve en su Kapta:

   ```text
   COD cobrado por Grupo GF
   − tarifa de entrega o rechazo   (tabla de externos o la del contrato)
   − 5 % de cada Yape recibido por Grupo GF   (o la del contrato)
   − % de cada cobro por POS                  (la del contrato)
   − precio a la tienda del producto de Proveeduría, solo en lo entregado
   = neto del día → cuenta corriente → depósito del saldo a favor
   ```

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
| Almacén (`lib/dispatch-access.ts:306-327`) | Los pedidos del cliente no entran a la cola de armado |
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

## 6. Lo que las decisiones agregan al sistema

Lo que hoy no existe y las respuestas exigen:

| Decisión | Qué hay que construir | Hoy |
| --- | --- | --- |
| 19, 20 | Precios **internos** y **de externos**: una segunda tabla general de tarifas y una segunda comisión Yape general | Una sola general por operador (0134) |
| 21 | Comisión POS con vigencia | `logistics_fee_rules.kind` solo admite `yape_commission` (0134:158) |
| 15, 16 | Catálogo de Proveeduría con precio a la tienda, vigencia y foto | No existe; `product_costs` (0050) es el costo propio de cada organización |
| 13 | Mapeo de SKU de la tienda a producto de Grupo GF | Hay el mismo patrón para Aliclik y Swayp (`aliclik_sku_map`, `swayp_sku_map`) |
| 8, 9 | No entregado de cliente: a su «Por reprogramar», no a la cola de reintento de Grupo GF; desarmado si no hay reprogramación | La cola de reintento de Grupo GF toma todos (`RETRY_QUEUE_FILTER`); el reintento conserva la salida (0192) |
| 24, 25 | Cuenta corriente y depósito diario | No hay saldos entre organizaciones |

Con menos de 20 pedidos al día, la revisión humana de cada liquidación alcanza.
El cruce automático con el estado de cuenta del Yape de Grupo GF queda para la
v2.

## 7. Fases

Cada fase se despliega sola, no cambia nada para Aurela y Kenku, y trae sus
pruebas. Las migraciones se corren a mano antes del código (`DEPLOY.md`).

### Fase 0 — Reglas en el MOM (sin código)

- La rama ya trae la rama de integración al 08-10-2026, incluidas 0230
  (recuperar en oficina), 0234 (traspaso de reprogramados) y §32 (pedido
  acompañante, solo Aliclik: no afecta). Las migraciones de este plan empiezan
  en 0235. Hay que actualizar las referencias de línea de §5, que cambiaron con
  esos commits.
- Escribir en el MOM las decisiones de §1. Ver §8.
- Probar con el primer cliente cómo conecta su Shopify: el token de app
  personalizada que usa `docs/onboarding-tienda-externa.md` o la app de Kapta
  por OAuth. Hay que verificar en Shopify que la app se pueda instalar en
  tiendas ajenas; el repo no lo dice.
- **Fuera del software, antes del piloto:** un contrato escrito con el cliente.
  Debe cubrir la custodia del efectivo, la responsabilidad por pérdidas y el
  uso de los datos de sus compradores (Ley 29733).

### Fase 1 — Contrato y precios de externos

- **Invitación con código** (decisión 3).
  - Grupo GF invita por correo al dueño (invitación de Supabase Auth, con el
    registro público cerrado).
  - Grupo GF crea el contrato en `draft`, con nombre del cliente y sus
    excepciones de precio si las hay.
  - El owner del cliente pega el código en los ajustes de su tienda.
  - Recién ahí el contrato pasa a `active`, con `client_org_id` y `store_id`
    comprobados (lo exige el comentario de 0134:55-58).
  - Grupo GF nunca engancha una tienda ajena por su cuenta.
- **Un solo Grupo GF.** El operador es único. El menú y el botón «Activar» solo
  aparecen a miembros de la organización del operador; se corrige
  `courier/page.tsx:41` (`memberships[0]`).
- **Validación por contrato.** `loadGroupGfCourierRouteCheck` encuentra el
  operador a partir del contrato vigente de la tienda; para Aurela y Kenku da lo
  mismo que hoy. Corre en el servidor, porque con la sesión del cliente no se
  ven las pausas generales (0137:39).
- **Precios de externos.**
  - Tarifas y comisiones generales distinguen interno y externo.
  - Resolución: excepción del contrato → general de externos → (solo internos)
    general interna.
  - El tarifario muestra las dos tablas, y el universo de distritos incluye las
    tiendas con contrato.
  - Comisión Yape de externos al 5 % y comisión POS por contrato, ambas con
    vigencia.
- **Campo nuevo en el contrato: quién inicia.** `cola_operador` para Aurela y
  Kenku, `tienda_asigna` para clientes. `assignment_mode` existe pero no se lee
  en ningún sitio.
- **Integraciones apagadas** para organizaciones cliente (decisión 4): Swayp,
  Shalom, agente de voz y Chatby no se ofrecen ni se ejecutan para sus tiendas.
- **Pruebas.**
  - Validación entre organizaciones; invitación aceptada, rechazada y con código
    vencido.
  - Que no se pueda crear un segundo operador.
  - Resolución de precios interna y externa.
  - Que una tienda cliente no dispare ninguna de esas integraciones.

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
    cliente: eso lo reemplaza la Fase 5. El pago del motorizado no cambia
    (decisión 11).
- **Pruebas.**
  - Un smoke SQL por pantalla de §5b (patrón `scripts/sql/gf_*_smoke.sql`).
  - Una prueba de aislamiento: el cliente A no ve nada del cliente B, y Grupo
    GF no ve los pedidos que el cliente no le asignó.

### Fase 3 — Catálogo, asignación y reintentos

- **Catálogo de Proveeduría.**
  - Productos con nombre, SKU, foto y precio a la tienda (decisiones 15 y 16).
  - Precio general con vigencia y excepciones por contrato, el mismo patrón que
    las tarifas.
  - El cliente lo ve en su Kapta, solo lectura.
- **Mapeo de SKU** por tienda (decisión 13), editable por el cliente, con la
  foto del producto de Grupo GF al lado para no equivocarse.
- **Asignar desde la tienda.**
  - **Pedidos disponibles** excluye las tiendas `tienda_asigna`
    (`courier/actions.ts:470-499`).
  - **Mesa de ruta y Master del cliente.** La tarjeta de Grupo GF muestra
    distrito, tarifa y fecha prevista. «Ver en Grupo GF» pasa a «Asignar a Grupo
    GF Courier» (`order-drawer.tsx:845-849`, `order-route-desk.tsx:199-202`), y
    hay asignación en lote desde el Master (`orders-master.tsx:1238`).
  - **Acción de servidor:**
    - exige `master.edit` en la organización del cliente, el contrato vigente
      y todas las líneas mapeadas;
    - reutiliza `takeOrdersCore`: mismas validaciones, idempotencia, tarifa
      congelada y relleno de la caja `por definir` conservando el QR;
    - congela además bolsa y precio de cada línea;
    - guarda `requested_by` con el usuario del cliente;
    - escribe con la llave de servicio, porque la RLS de `logistics_requests`
      solo deja escribir al operador (0138:95-103).
- **Cancelar desde la tienda**, sin costo y en cualquier momento (decisión 7).
  Si el paquete está en una caja o en la calle, vuelve al almacén y se desarma.
- **Reintento del cliente** (decisiones 8 y 9).
  - Un no entregado de tienda cliente va a «Por reprogramar» en su Master y no
    a la cola de reintento de Grupo GF.
  - El cliente reprograma con fecha.
  - Si el comprador pidió otro día y el motorizado conserva el paquete, el
    traspaso a su ruta siguiente (`gf_carry_over`, 0234) registra la
    reprogramación en el Master de la tienda con esa fecha.
  - Al recibirlo en oficina (`gf_return_to_office`):
    - con reprogramación, conserva la salida (0192);
    - sin ella, se desarma: la solicitud se cierra y el producto vuelve a su
      bolsa.
  - Reprogramar después crea una solicitud y una salida nuevas, con tarifa y
    precio vigentes ese día.
- **Almacén de Grupo GF.**
  - Ve en su cola los pedidos asignados (`getWarehouseStationData`, rótulos),
    con la bolsa de cada línea a la vista.
  - Registra el desarmado.
  - En el Almacén del cliente, esos pedidos aparecen como «Lo arma Grupo GF» y
    no se preparan ahí.

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
  - **Cuenta corriente** append-only (decisión 24). Movimientos:
    - neto de una liquidación aprobada (+ o −);
    - depósito de Grupo GF al cliente;
    - pago del cliente a Grupo GF;
    - ajuste con motivo, por ejemplo una pérdida (decisión 18).

    El saldo es la suma; nada se edita.
- **Cálculo.** Una función SQL que devuelve una foto en JSON, como
  `rider_pay_preview` (0222). Por tienda y día, sobre las paradas de rutas de
  Grupo GF, la fórmula de §4:
  - lo cobrado, por medio y cuenta receptora;
  - la tarifa congelada de la solicitud (`logistics_requests.tariff_amount`,
    vía `shipment_id`) para entregado o rechazado, con el rechazo cobrado una
    vez por pedido y ruta/día;
  - las comisiones Yape y POS vigentes, redondeadas por operación;
  - el precio congelado del producto de Proveeduría, solo en lo entregado
    (decisión 17);
  - el neto.
- **Bloqueos.** Una ruta abierta, una parada pendiente, evidencia faltante o una
  línea sin tarifa («Sin tarifa configurada», nunca S/0).
- **Aprobación.** Humana, con `settlements.close` en la organización de Grupo
  GF, contra la versión vista y congelando el resultado (patrón
  `rider_pay_approve`, 0162). Al aprobar:
  - el neto entra a la cuenta corriente;
  - cada pedido de la liquidación queda cerrado financieramente en el Master
    del cliente (decisión 27).
- **Depósito diario** (decisión 25). Grupo GF registra la transferencia del
  saldo a favor con su constancia. Un saldo en contra se arrastra al día
  siguiente.
- **Reporte de parada.** Para tiendas cliente registra la cuenta receptora
  (decisión 22): efectivo, Yape de Grupo GF, POS de Grupo GF o pago directo a la
  tienda.
- **Lado del cliente.** Ve en su Kapta, solo lectura, su liquidación, líneas,
  evidencias, cuenta corriente y depósitos, con exportación para facturar
  (decisión 29).
- **Lado de Grupo GF.** Saldo de cada cliente a la vista y suspensión manual
  del contrato (decisión 26).

### Fase 6 — Piloto (noviembre 2026)

- Actualizar `docs/onboarding-tienda-externa.md`:
  - invitación por correo con el registro cerrado (hoy pide abrirlo), código
    del contrato y mapeo de SKU;
  - `order_prefix` de la tienda (nace vacío);
  - la lista de aislamiento ampliada: cliente A ≠ cliente B, el cliente no ve
    motorizados, Grupo GF no ve lo no asignado.
- Un cliente, menos de 20 pedidos al día, una semana completa con
  liquidaciones y depósitos diarios aprobados.

## 8. Cambios al MOM (Fase 0)

- **§29.1–§29.2.**
  - Tienda cliente en su propia organización, con alta por invitación.
  - El contrato dice quién inicia; Aurela y Kenku siguen en cola automática.
  - Asignar obliga.
  - Integraciones apagadas para clientes.
- **§29.3.**
  - Catálogo de Proveeduría y bolsa por línea a partir del mapeo de SKU.
  - Precio a la tienda.
  - Desarmado al volver sin reprogramación.
  - Producto cobrado solo en lo entregado.
- **§29.4.** Reprogramar después de desarmar crea una salida nueva (ya lo dice
  para «debe desarmarse»; se agrega el caso del cliente).
- **§29.6.** La tienda asigna, cancela sin costo en cualquier momento y decide
  el reintento.
- **§29.7.**
  - Para clientes, «Reprogramado conserva el paquete armado» solo si la
    reprogramación existe al volver.
  - Qué ve el cliente y qué se le oculta.
  - Marca blanca.
- **§29.8.** Tarifas y comisiones internas y de externos: Yape 5 % y POS por
  contrato.
- **§29.9.**
  - Liquidación a la tienda con la fórmula de §4.
  - Cuenta receptora en la puerta.
  - Cuenta corriente y depósito diario.
  - Cierre financiero al aprobar.
  - Pérdidas como ajuste.
  - Facturación fuera de Kapta.
- **§29.10.**
  - Grupo GF ve solo los pedidos asignados.
  - El owner de un cliente no administra operadores.
  - Suspensión manual por deuda con el saldo a la vista.
- **§29.11.** El paso 5 se divide: tiendas Shopify ahora; API y Excel después.

## 9. Riesgos

- **Lecturas con la llave de servicio.** Toda lectura entre organizaciones pasa
  por el helper de «tiendas con contrato»; las pruebas con dos clientes son
  obligatorias en cada fase.
- **Conexión Shopify.** No está verificado que la app de Kapta (OAuth) se pueda
  instalar en tiendas ajenas, ni que Shopify siga permitiendo crear apps
  personalizadas desde el admin. Se prueba en la Fase 0.
- **Sin control de stock** (decisión 14). Un pedido puede asignarse sin producto
  y enterarse al armar, igual que hoy con Aurela y Kenku.
- **Yape sin validar.** En la v1, el Yape de la puerta se acepta con su captura y
  la aprobación humana compara contra el estado de cuenta. Con más volumen hace
  falta el cruce automático.
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
- Conteo de stock, reservas y recepción o retiro del inventario del cliente
  (§29.3).
- Reclamos del cliente dentro de Kapta.
- Valor declarado por SKU para compensar pérdidas.
- Facturación electrónica.
- Cruce automático del Yape de Grupo GF con su estado de cuenta.
- Cobro de la suscripción de Kapta a los clientes.
- GPS en el reporte (§29.7): no existe en ninguna parte todavía.
- Enlace público de seguimiento para el comprador.
