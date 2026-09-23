# Plan técnico — Agente de voz para Reproprovincia

> **Estado: DISEÑO, no implementado.** Las reglas de negocio están en el MOM,
> §11.8 (`docs/mom/master-pedidos-v1.md`). Este documento dice cómo se
> construyen. Si algo de aquí contradice al MOM, manda el MOM y se corrige esto.

## Objetivo

Que un agente de voz (Grok Voice Agent API sobre Zadarma, ambos reemplazables)
llame a los pedidos en **Reproprovincia activa** que cumplen §11.8, les proponga
el reenvío desde la bodega Swayp de su ciudad, y deje sobre el pedido **los
mismos hechos que dejaría una asesora**, por la misma función y con la misma
idempotencia. Cero estados nuevos; una bitácora de llamadas nueva.

## Qué ya existe y se reutiliza

| Pieza | Dónde | Cómo se usa |
| --- | --- | --- |
| Elegibilidad de recuperación | `recoveryOutcome`, `recoveryWindow`, `guideClosedAt` en `lib/reproprovincia.ts` | Condiciones 1 y 2 de §11.8. No se reimplementa. |
| Motivo del courier | `motivoDelCourier` (§11.7) | Condición 4: excluye rechazo en puerta. |
| Ficha previa a la llamada | La del drawer del Master (§8.1) | Se serializa al prompt: pedido, producto, dirección, historial resumido, antecedentes. |
| Antecedentes | Mismo cálculo de la ficha (§8) | Condición 6. |
| Stock Swayp por ciudad | Conteo de Swayp (§11, «De dónde sale el stock») | Condición 3. |
| Registro de intento | `register_confirmation_attempt_v1` (0122) | Toda escritura del agente sobre el pedido. Gana `p_source`. |
| Descarte | `discardRecovery` en `lib/recovery-discard.ts` | Solo con `voice_recovery_can_discard = true`. |
| Ajustes por tienda | Patrón de `return_recovery_*` (0112, `lib/store-settings.ts`) | Los `voice_recovery_*` se añaden igual. |
| Cron autenticado | `app/api/cron/coverage-push/route.ts` (secreto en cabecera, comparación en tiempo constante) | Plantilla para `/api/cron/voice-recovery`. |
| Resumen diario | `lib/daily-summary.ts` (§17.1) | Suma «aceptados sin salida». |

## Arquitectura

**xAI no origina llamadas.** Su API SIP documenta recibir llamadas, transferir
una activa y colgar; no hay «crear llamada saliente». Por eso la que marca es
la telefonía: Zadarma tiene un número peruano (`+51 1 705 8243`) desviado al
SIP de xAI, donde contesta el agente guardado en la consola (hoy «Akemi /
Kenku Order Confirmation»; para Reproprovincia va un agente propio con el
guion de §11.8), y un API de callback que llama primero al cliente y, cuando
contesta, conecta la otra pata:

```
Kapta (Vercel)                     Zadarma                      xAI
──────────────────────             ─────────────────            ───────────────
/api/cron/voice-recovery
  elige elegibles (§11.8)
  inserta voice_calls(queued)
  GET /v1/request/callback/  ───▶  llama al cliente (to)
    from = +5117058243              cliente contesta
    to   = +51 9…                   llama a +5117058243  ───▶  desvío SIP
    predicted = 1                                              contesta el agente

/api/voice/tools/…         ◀──────────────────────────────────  tools del agente
  ata la llamada a su fila                                      (webhook HTTP)
  escribe por register_confirmation_attempt_v1

/api/webhooks/voice        ◀──────────────────────────────────  fin de llamada,
  finaliza voice_calls     ◀──  estadísticas / grabación        transcripción
```

`predicted=1` importa: sin él Zadarma llamaría primero al agente, que
contestaría al instante y empezaría a saludar a un teléfono que todavía suena.
Con él, el cliente contesta y **oye silencio o tono los segundos que tarde la
segunda pata en conectar**; ese retraso se mide en la Fase 1 y, si pasa de dos
o tres segundos, el saludo del agente lo absorbe («¿Aló? Buenas tardes, le
habla…»).

### El problema que esta arquitectura introduce: atar la llamada al pedido

Con un bridge propio, Kapta abría la sesión y le decía al modelo, por
`session.update`, de qué pedido iba la llamada. Con el agente guardado en la
consola de xAI, **cada llamada entra igual**: el agente no sabe a quién llamó
Kapta. Hay que averiguarlo desde dentro de la llamada, y el MOM (§11.8, «La
llamada se ata al pedido ANTES de marcar») exige que la atadura sea a la fila
de `voice_calls` que Kapta escribió antes de pedir el callback, no a un pedido
buscado por teléfono.

Tres formas, de mejor a peor, y **cuál sirve lo decide una prueba, no este
documento**:

1. **El número del cliente llega a xAI como caller ID de la segunda pata.** Si
   el desvío de Zadarma conserva el número de origen, la primera tool del
   agente (`identificar_llamada`) manda ese número y Kapta devuelve la fila
   `dialing` de ese teléfono y tienda, que es única porque el cron no encola
   dos llamadas al mismo teléfono a la vez. La ficha del pedido vuelve en la
   respuesta y el agente sigue el guion con ella.
2. **Llega el número de Zadarma, no el del cliente.** Entonces todas las
   llamadas se ven iguales y solo queda atar por tiempo: Kapta mantiene **una
   llamada en curso por número de agente** (`dialing` → la única candidata), y
   la tool devuelve esa. Sirve para el piloto (30 llamadas al día caben en
   serie) y no escala; escalar sería un segundo número desviado o la opción 3.
3. **Bridge propio con sesión por llamada.** Kapta pide a Zadarma que conecte
   la segunda pata a un SIP nuestro en vez de al de xAI, y un servicio vivo
   abre `wss://api.x.ai/v1/realtime?call_id=…` y manda `session.update` con la
   ficha. Es el diseño anterior de este plan: más código y un proceso fuera de
   Vercel, pero la atadura es exacta. Se cae aquí solo si 1 y 2 fallan o si
   las tools del agente guardado no pueden llamar a un webhook nuestro.

En las tres, si la tool no encuentra fila, el agente dice que hubo un error,
se despide y no gestiona: la fila queda `sin_resultado` y el pedido sigue en
la cola (§11.8).

### Cómo vuelven los resultados

También depende de lo que ofrezca el agente guardado:

- **Tools por webhook** (lo que este plan asume): el agente llama
  `registrar_resultado` y Kapta escribe en el acto. Es lo que hay que
  confirmar en la consola de xAI antes de la Fase 2.
- **Solo transcripción al final**: si el agente guardado no puede invocar
  webhooks, Kapta recibe o consulta la transcripción al cerrar la llamada y un
  segundo paso la clasifica en uno de los resultados de §11.8 antes de
  escribir. Es peor —una capa más que puede equivocarse— y obligaría a que
  «acepta» pase por revisión humana durante todo el piloto. Se documenta para
  no descubrirlo tarde.

Los datos de la llamada (duración, grabación, costo) los da Zadarma por su
API de estadísticas y su notificación de fin de llamada; la transcripción, xAI.
Las dos se cruzan por la fila de `voice_calls`.

## Modelo de datos (migración `0165_voice_calls.sql`)

```sql
alter table stores
  add column if not exists voice_recovery_enabled      boolean not null default false,
  add column if not exists voice_recovery_auto         boolean not null default false,
  add column if not exists voice_recovery_can_discard  boolean not null default false,
  add column if not exists voice_recovery_daily_cap    integer not null default 30,
  add column if not exists voice_recovery_max_attempts integer not null default 2,
  add column if not exists voice_recovery_max_age_days integer not null default 7,
  add column if not exists voice_recovery_hour_start   integer not null default 9,
  add column if not exists voice_recovery_hour_end     integer not null default 20,
  add column if not exists voice_recovery_greeting     text,          -- aviso legal aprobado; sin él no se llama
  add column if not exists voice_recovery_voice_id     text,          -- voz del proveedor
  add column if not exists voice_recovery_caller_id    text,          -- número que ve el cliente (E.164)
  add column if not exists voice_recovery_agent_number text;          -- número desviado a xAI (+5117058243)

create table voice_calls (
  id               uuid primary key default gen_random_uuid(),
  store_id         uuid not null references stores(id) on delete cascade,
  order_id         uuid not null references orders(id) on delete cascade,
  shipment_id      uuid references shipments(id) on delete set null,   -- la guía fallida que abrió la recuperación
  provider         text not null default 'grok',
  provider_call_id text,                                              -- call_id de xAI
  telephony_call_id text,                                             -- id del callback / pbx_call_id de Zadarma
  mode             text not null default 'real' check (mode in ('real','test')),
  phone            text not null,                                     -- en `test`, el del probador
  status           text not null check (status in ('queued','dialing','in_progress','completed','failed','no_answer','cancelled')),
  outcome          text check (outcome in ('sin_respuesta','se_deja_mensaje','volver_a_contactar','acepta','no_quiere','no_llamar','deriva','sin_resultado')),
  outcome_payload  jsonb not null default '{}'::jsonb,                -- dirección leída, fecha, motivo dicho, qué pidió
  triggered_by     uuid references auth.users(id) on delete set null, -- null = barrido
  tool_token_hash  text not null,                                     -- token por llamada para /api/voice/tools
  queued_at        timestamptz not null default now(),
  started_at       timestamptz,
  ended_at         timestamptz,
  duration_s       integer,
  transcript       jsonb,                                             -- [{role, text, at}]
  recording_url    text,
  cost_usd         numeric(8,4),
  error            text
);
create unique index voice_calls_provider_call_uniq on voice_calls(provider, provider_call_id) where provider_call_id is not null;
create index voice_calls_store_day_idx on voice_calls(store_id, queued_at desc);
create index voice_calls_order_idx on voice_calls(order_id, queued_at desc);
-- RLS: select por tienda (auth_store_ids()), escritura solo service_role.
```

`register_confirmation_attempt_v1` gana `p_source text default 'manual'` y lo
escribe en `order_events.source`. Ningún llamador existente cambia. El agente
pasa `'agente_voz'`, `p_actor = null` (la función ya cae a
`confirmation_fallback_user` para asignar tareas) y en `p_note` el resumen de la
llamada; el `voice_call_id` va dentro del `payload` que construye la función,
así que gana también `p_payload_extra jsonb default '{}'` que se fusiona.

**Retención.** La transcripción se conserva con el historial (§2, principio 5).
La grabación se borra a los `VOICE_RECORDING_RETENTION_DAYS` (30) por un barrido
del cron de backup; el enlace queda nulo y la transcripción sigue.

## Cola y barrido

`lib/voice-recovery.ts`, funciones puras y probadas:

- `voiceRecoveryEligible(input) → { eligible: true } | { eligible: false, reason }`
  con las nueve condiciones de §11.8, cada una con su `reason` para poder
  contar por qué queda fuera cada pedido (la condición 8 se mide así).
- `orderVoiceQueue(rows)`: fecha pactada por el agente primero, luego
  `closed_at` descendente.
- `dailyCapRemaining(calls, cap, limaDate)`, `withinHours(now, start, end)`.

`/api/cron/voice-recovery`, cada 20 minutos dentro del horario
(`vercel.json`): por tienda con `voice_recovery_auto`, calcula la cola, toma
hasta lo que quede del tope, inserta `voice_calls(queued)` y pide el callback a
Zadarma (`GET /v1/request/callback/` con `from` = número del agente, `to` =
cliente, `predicted=1`, firmado con la clave de la tienda). Mientras la
atadura sea por tiempo (opción 2 de la arquitectura), el cron **no encola una
segunda llamada si hay una `dialing` o `in_progress` en esa tienda**. En modo
sombra (`VOICE_RECOVERY_DRY_RUN=1`) inserta con `status = 'cancelled'` y
`error = 'dry_run'`: la cola se ve en el drawer sin que suene ningún teléfono.

El botón **«Llamar con el agente»** del drawer hace lo mismo para un pedido,
con `triggered_by = usuario`, y solo con `voice_recovery_enabled`. Pasa por la
misma elegibilidad: si el pedido no entra, el botón dice por qué.

## Contrato con el agente guardado

El agente vive en la consola de xAI con el guion de abajo y estas tools
apuntando a Kapta. Kapta no sostiene ninguna sesión: recibe llamadas HTTP del
agente durante la conversación y una notificación al final. Si una tool no
responde, el agente lo dice («ahora mismo no puedo registrarlo»), se despide y
la llamada termina como `sin_resultado`.

### Tools que ve el modelo

`identificar_llamada` va primero y es la que ata la llamada a su fila (ver
arquitectura). Devuelve la ficha compilada —nombre, pedido de Shopify,
producto, monto, dirección, ciudad— o `{"encontrada": false}`.

```json
[
  {
    "name": "identificar_llamada",
    "description": "Llamar al inicio, antes de hablar del pedido. Devuelve de qué pedido es esta llamada.",
    "parameters": { "type": "object", "properties": { "numero_cliente": { "type": "string", "description": "Caller ID si lo tienes; vacío si no" } } }
  },
  {
    "name": "registrar_resultado",
    "description": "Registra cómo terminó la llamada. Llamar UNA vez, al final.",
    "parameters": {
      "type": "object",
      "required": ["resultado"],
      "properties": {
        "resultado": { "type": "string", "enum": ["sin_respuesta", "se_deja_mensaje", "volver_a_contactar", "acepta", "no_quiere"] },
        "proximo_contacto": { "type": "string", "description": "YYYY-MM-DD, obligatorio con volver_a_contactar" },
        "direccion_confirmada": { "type": "string" },
        "referencia": { "type": "string" },
        "rango_entrega": { "type": "string", "description": "mañana / tarde / día" },
        "motivo_no_quiere": { "type": "string" },
        "resumen": { "type": "string", "description": "Dos frases, para la línea de tiempo" }
      }
    }
  },
  {
    "name": "derivar_a_persona",
    "description": "El cliente pide algo que no puedes dar: precio, cambio, pago, hora exacta, otro pedido.",
    "parameters": { "type": "object", "required": ["que_pidio"], "properties": { "que_pidio": { "type": "string" } } }
  },
  {
    "name": "no_llamar",
    "description": "El cliente pide que no lo llamen más.",
    "parameters": { "type": "object", "properties": {} }
  }
]
```

`/api/voice/tools/[tool]` valida la firma del agente (secreto compartido en
cabecera, comparación en tiempo constante), resuelve la fila con
`identificar_llamada` y la deja `in_progress`; las demás tools exigen una fila
`in_progress` y traducen a hechos según la tabla de §11.8:

| `resultado` | Escribe |
| --- | --- |
| `sin_respuesta`, `se_deja_mensaje` | RPC con ese resultado |
| `volver_a_contactar` | RPC con fecha; rechaza fecha pasada (misma regla que `registerConfirmationAttempt`) |
| `acepta` | RPC `confirmado` con `payload_extra = {reenvio: 'swayp', direccion_confirmada, referencia, rango_entrega}` |
| `no_quiere` | con `can_discard`: `discardRecovery(source agente_voz)`; sin él: solo `voice_calls` |
| `derivar_a_persona` | marca `outcome = 'deriva'` y guarda `que_pidio`; el resultado final lo pone `registrar_resultado` con la nota «deriva a persona: …» |
| `no_llamar` | `outcome_payload.no_llamar = true`; la elegibilidad lo lee por teléfono y tienda |

Todo con `operation_id = voice_call_id`: la RPC devuelve `duplicate: true` al
segundo intento y no escribe dos veces.

### Fin de llamada

`POST /api/webhooks/voice` recibe dos avisos y los cruza por la fila: el de
xAI con la transcripción (si el agente guardado lo ofrece; si no, se consulta
por API) y el de Zadarma (`NOTIFY_END`) con duración, grabación y costo. Si
terminó sin que el modelo llamara `registrar_resultado`, `outcome =
'sin_resultado'` y **no se toca el pedido**. Un cliente que no contestó llega
solo por Zadarma (la segunda pata nunca se marcó): se registra
`sin_respuesta` desde ahí, sin pasar por el agente. Idempotente por
`telephony_call_id` y `provider_call_id`.

## El prompt: el saludo lleva el pedido, y el pedido lo trae la primera tool

El agente guardado no sabe a quién llamó Kapta cuando descuelga. Para que el
saludo sea «le llamo por su pedido de {producto}» y no «¿me dice su número de
pedido?», el prompt le ordena **llamar a `identificar_llamada` antes de
hablar** y saludar con lo que la tool devuelve. La ficha viaja en la respuesta
de la tool, no en el prompt: el prompt es el mismo para todas las llamadas y
vive en la consola de xAI.

`identificar_llamada` devuelve, cuando encuentra la fila:

```json
{
  "encontrada": true,
  "nombre": "Wilfredo",
  "pedido": "#KP126722",
  "producto": "Set de Pelador de Verduras + Abridor Premium",
  "cantidad": 1,
  "monto": "S/ 99",
  "distrito": "Callería",
  "ciudad": "Pucallpa",
  "direccion": "Jr. Los Pinos 123, frente al mercado",
  "motivo_courier": "no contestó al motorizado",
  "modo": "real"
}
```

El costo de hacerlo así es un segundo de silencio más al descolgar, sumado al
de la segunda pata del callback. Se mide en la prueba 2 de la Fase 1; si el
total pasa de tres segundos, el saludo empieza con un «¿Aló?» que lo absorbe.

Prompt del agente (en la consola de xAI, no en Kapta):

```
Eres Akemi, asistente virtual de {tienda}. Hablas español de Perú, con trato
de usted, frases cortas. No finges ser una persona.

AL CONECTAR, ANTES DE DECIR NADA, llama a identificar_llamada. No saludes
hasta tener su respuesta.
- Si devuelve encontrada = false: di "Disculpe, hubo un error de nuestro
  lado, le escribiremos por WhatsApp. Que tenga buen día." y cuelga. No
  registres nada.
- Si devuelve la ficha, saluda EXACTAMENTE así, rellenando con la ficha:
  "{saludo_legal_aprobado}. Le llamo por su pedido de {producto}, que el
  courier no pudo entregar en {distrito}. Queremos reenviárselo desde
  {ciudad}, contra entrega y sin costo adicional. ¿Todavía desea recibirlo?"

Objetivo: saber si todavía quiere el pedido.
- Si SÍ: lee la dirección registrada ("{direccion}") y pregunta si sigue
  siendo esa; pide una referencia y si prefiere mañana o tarde. Di que se lo
  reenvían desde su ciudad, contra entrega, sin costo adicional, y que le
  avisarán por WhatsApp el día del reparto. Luego registrar_resultado(acepta).
- Si NO: pregunta con respeto por qué, agradece, despídete.
  registrar_resultado(no_quiere, motivo_no_quiere).
- Si pide otro día: acuerda una fecha concreta y registrar_resultado(volver_a_contactar).
- Si contesta otra persona: deja un recado corto. registrar_resultado(se_deja_mensaje).
- Si pide descuento, cambio de producto, pagar por adelantado, una hora exacta,
  o habla de otro pedido: di que una asesora le escribirá por WhatsApp,
  derivar_a_persona(que_pidio), y cierra con el resultado que corresponda.
- Si pide que no lo llamen más: no_llamar(), despídete.

Nunca: pidas dinero, datos de tarjeta o Yape; prometas una hora; inventes
información; menciones códigos de guía; llames "pedido devuelto" a nada — di
"no se pudo entregar". Si a los 3 minutos no hay resultado, despídete y registra.
```

## Modo prueba: un pedido real, tu teléfono, y nada se escribe

Para ensayar la conversación hace falta un pedido con ficha de verdad, y el
MOM prohíbe inventar pedidos (§2, principio 3). La solución es separar **de
qué pedido habla el agente** de **a qué teléfono llama** y de **si escribe**:

- `voice_calls.mode` toma `real` o `test`. En `test`, la fila apunta a un
  pedido real en Reproprovincia (hay cientos) pero `phone` es el del probador,
  y **las tools registran el resultado solo en `outcome` y `outcome_payload`
  de la fila; no llaman a la RPC ni a `discardRecovery`**. El pedido no se
  entera de que existió la llamada. La transcripción sí se guarda, que es lo
  que se quiere revisar.
- Se lanza con `POST /api/internal/voice/test-call` (secreto interno, como
  `aliclik-egress`), cuerpo `{ order_id, phone }`. Inserta la fila en `test`,
  pide el callback a Zadarma y devuelve el `voice_call_id`. El agente que
  contesta, la tool que identifica y el webhook de fin son **los mismos** que
  en producción: lo único distinto es el destinatario y que no se escribe.
- La cola del drawer muestra las filas `test` con una etiqueta, y no cuentan
  para el tope diario ni para las métricas.

Este endpoint es de la Fase 2, antes que el cron. Es lo primero que se
construye porque es lo que permite escuchar al agente con una ficha de verdad
sin haber terminado nada más.

### Ensayar antes de tener el endpoint

Las pruebas 1 a 5 de la Fase 1 no necesitan Kapta. Para que el agente ya
salude con un producto en esas pruebas, `identificar_llamada` puede apuntar
a un **mock que devuelve siempre la misma ficha**: un webhook de Make con
respuesta JSON fija (dos minutos de configurar, y Make ya está en uso), o un
request bin con respuesta personalizada. Cuando exista el endpoint de Kapta,
se cambia la URL de la tool en la consola y nada más.

El mock ya existe (22-09-2026): escenario de Make «Voz · identificar_llamada
(mock Reproprovincia)» en el equipo My Team, webhook
`https://hook.us1.make.com/yfoo4l15mlrvtwnarr2qcqxew6mblqg9`. Acepta cualquier
método y cuerpo y responde siempre la ficha del pedido #KP135098 de Kenku
(Cusco, Aceite de Semilla Negra x3, S/ 298) con `modo: "test"`, más
`ventana_horaria`, `fecha_minima` y `dias_restantes` para el guion de
reprogramación. Para cambiar la ficha se edita el cuerpo del módulo «Webhook
response»; para apagarlo se desactiva el escenario.

Hay un segundo mock para la tool de cierre, «Voz · registrar_gestion (mock)»,
en `https://hook.us1.make.com/py1repp3lwe81n6m6dpjlw17p8vpr2tt`: acepta lo
que el agente mande, responde `{"ok": true, "modo": "test"}` y **guarda cada
petición en el historial del escenario**, que es donde se lee qué resultado y
qué campos registró el agente en cada llamada de prueba (prueba 4 de la
Fase 1).

Lo que se aprende con el mock: si el agente respeta «tool antes de hablar»,
cuánto silencio añade, y cómo suena el saludo con un producto real en la
boca. Lo que NO se aprende: la atadura por caller ID (prueba 3), que necesita
que la tool reciba el número y alguien lo mire.

## Guardarraíles técnicos

- **Secretos** en `lib/env.ts`: `ZADARMA_KEY`, `ZADARMA_SECRET`,
  `VOICE_TOOLS_SECRET` (el que el agente manda en cada tool), `XAI_API_KEY`
  (solo para leer transcripciones), `VOICE_RECOVERY_DRY_RUN`.
- **Las tools solo escriben sobre una fila `in_progress`** y una fila solo pasa
  a `in_progress` por `identificar_llamada`. Una llamada que xAI reciba fuera
  de Kapta (alguien marca al número a mano) no encuentra fila y no escribe.
- **Candado por pedido** al escribir: la RPC ya toma `pg_advisory_xact_lock`
  por `order_id`; el cron además no encola un pedido con una `voice_calls`
  abierta (`queued`, `dialing`, `in_progress`).
- **Llamadas colgadas**: un barrido marca `failed` toda fila `dialing` o
  `in_progress` con más de 10 minutos, sin tocar el pedido.
- **Sin PII en logs**: los logs llevan `voice_call_id`, nunca teléfono ni
  transcripción.
- **Tope duro de duración**: se configura en el agente de xAI y, por si acaso,
  en el callback de Zadarma; el guion se despide a los tres minutos.

## Interfaz

- **Ajustes de la tienda**: bloque «Agente de voz · Reproprovincia» con los
  interruptores, topes, horario, voz, caller ID y el saludo legal. Sin saludo,
  el interruptor `enabled` no se puede encender.
- **Cola de Reproprovincia** (Master, chip «Por recuperar», y Envíos): columna
  «Agente» con el estado de la última llamada (`hoy 10:12 · no contestó`,
  `acepta reenvío · crear salida Swayp`, `propone descartar: “…”`,
  `el agente ya llamó 2 veces`). Los «acepta» van primero.
- **Drawer**: botón «Llamar con el agente»; en la línea de tiempo, cada hecho
  del agente con actor «Agente de voz» y enlace «Ver transcripción», que abre
  la transcripción y el audio bajo RLS.
- **Resumen diario del owner** (§17.1): llamadas, contestadas, aceptados,
  aceptados sin salida a 24 h, descartes propuestos.

## Fases y entregables

| Fase | Entrega | Se puede desplegar sin llamar a nadie |
| --- | --- | --- |
| 1 · Verificación | Las cinco pruebas de abajo, en orden; texto legal aprobado | sí (nada en el repo) |
| 2 · Fundaciones | Migración 0165; `p_source` y `p_payload_extra` en la RPC; `lib/voice-recovery.ts` puro con pruebas; **`test-call` y las tools en modo `test`** (lo primero, para ensayar con ficha real); ajustes de tienda; cron en modo sombra; columna «Agente» leyendo `voice_calls` | sí, `DRY_RUN=1` |
| 3 · Integración | Cliente de Zadarma (callback firmado, notificación de fin, estadísticas), endpoints de tools y webhook, agente de Reproprovincia en la consola de xAI con el guion de abajo, botón manual del drawer | sí, `enabled` apagado |
| 4 · Piloto semana 1 | Una tienda, `enabled` encendido, `auto` apagado; llamadas a mano desde el drawer; se escuchan todas | no |
| 5 · Piloto semana 2 | `auto` encendido con tope 30; revisión diaria de descartes propuestos | no |
| 6 · Decisión | Tabla de métricas de §11.8 contra la línea base; encender `can_discard` si procede; segunda tienda | — |

Cada fase es un PR contra la rama de integración (AGENTS.md); la migración se
aplica a mano antes del código que la necesita (`DEPLOY.md`).

## Pruebas (vitest)

- `test/voice-recovery-eligible.test.ts`: un caso por condición de §11.8 que la
  excluye, uno que pasa todas, y el orden de la cola.
- `test/voice-recovery-outcomes.test.ts`: por cada `resultado` de la tool, qué
  llama y con qué; `sin_resultado` y resultado desconocido no llaman nada;
  `no_quiere` con y sin `can_discard`; fecha pasada rechazada.
- `test/voice-recovery-prompt.test.ts`: la respuesta de `identificar_llamada`
  nunca lleva código de guía y siempre el nombre de Shopify; sin saludo legal
  configurado la tool devuelve `encontrada: false`.
- Modo `test`: cada tool sobre una fila `test` deja `outcome` y no llama a la
  RPC ni al descarte; una fila `test` no cuenta para el tope diario.
- `test/reproprovincia.test.ts` (ampliar): `confirmed` con `source agente_voz`
  no cambia el resultado de `recoveryOutcome`.
- `test/order-macro-stage.test.ts` (ampliar): ese mismo evento no mueve
  `macro_stage`/`macro_substage` de un pedido `pendiente_nuevo_courier`.
- Idempotencia de la RPC con `p_source`: prueba SQL en el mismo estilo que las
  de 0122, dos llamadas con el mismo `operation_id`, un evento.
- Cron: `auto` apagado no encola; tope diario se respeta por una unidad;
  fuera de horario no encola; pedido con llamada abierta no se encola.

## Métricas (consultas base)

```sql
-- Contestadas / realizadas, por tienda y semana
select store_id, date_trunc('week', queued_at) as semana,
       count(*) filter (where status in ('completed','no_answer','failed')) as realizadas,
       count(*) filter (where outcome not in ('sin_respuesta','sin_resultado') and outcome is not null) as contestadas,
       count(*) filter (where outcome = 'acepta') as aceptaron
from voice_calls group by 1, 2;

-- Aceptados con salida Swayp ≤ 48 h
-- (en `shipments` el courier de Swayp se llama `fenix`, como en el resto del código)
select vc.id, vc.order_id,
       exists (select 1 from shipments s where s.order_id = vc.order_id
                 and s.courier = 'fenix' and s.created_at between vc.ended_at and vc.ended_at + interval '48 hours') as con_salida
from voice_calls vc where vc.outcome = 'acepta';

-- Aceptados sin salida a 24 h (para el resumen diario)
-- misma consulta con 24 h y con_salida = false y ended_at < now() - interval '24 hours'
```

## Fase 1: las cinco pruebas, en orden

Cada una responde una pregunta que decide el diseño. No se pasa a la siguiente
sin anotar el resultado aquí.

1. **¿Contesta el agente?** Llamar desde un celular al `01 705 8243`. Si
   contesta el agente guardado con su saludo, Zadarma → desvío SIP → xAI está
   bien. Anotar cuántos segundos tarda en contestar.
2. **¿Funciona la llamada saliente?** Desde Postman o un script, pedir a
   Zadarma `GET /v1/request/callback/` con `from` = `+5117058243`, `to` = tu
   celular, `predicted=1`. Contestas tú y debe entrar el agente. Anotar el
   **silencio entre que contestas y oyes al agente**: decide si el saludo
   necesita absorber el retraso.
3. **¿Qué número ve xAI?** En esa misma llamada, que el agente diga en voz
   alta el caller ID que recibió, o leerlo de la transcripción/logs de xAI.
   Si es tu celular, la atadura es la opción 1 de la arquitectura; si es el
   número de Zadarma, la opción 2 (una llamada a la vez). Probar también qué
   pasa si Zadarma tiene activado «mostrar número del que llama» en el desvío.
4. **¿El agente guardado puede llamar a un webhook nuestro?** Configurar en la
   consola de xAI una tool que apunte a un endpoint de prueba (un request bin
   basta) y pedirle al agente que la use. Si no puede, el plan cae a «solo
   transcripción al final» o al bridge propio; las dos están descritas arriba.
5. **¿Cómo llega la transcripción y el fin de llamada?** Comprobar si xAI
   manda webhook o hay que consultarla por API con el `call_id`, y activar en
   Zadarma la notificación `NOTIFY_END` y la grabación hacia un endpoint de
   prueba.

Después de las cinco, además:

- Precio por minuto de las dos patas de Zadarma (móvil peruano + fijo de Lima)
  y de Grok voice, para la última fila de la tabla de métricas.
- Texto legal del saludo (grabación y tratamiento de datos) aprobado por el
  owner.
- Si Grok no rinde en español de provincia: el mismo diseño sirve para
  ElevenLabs Agents u otro proveedor que conteste por SIP y llame webhooks; el
  desvío de Zadarma cambia de destino, Kapta no.

## Lo que este diseño no resuelve todavía

- **Buzón de voz.** Zadarma no distingue un buzón de una persona; el agente
  hablará con la grabación del buzón hasta que note que nadie responde. El
  guion le dice que corte a los diez segundos sin respuesta humana y registre
  `sin_respuesta`; se mide en el piloto cuántas llamadas «contestadas» duran
  menos de quince segundos, que es la firma de un buzón.
- **Concurrencia.** Con la atadura por tiempo, una llamada a la vez por tienda.
  Con 30 llamadas al día de tres minutos cabe de sobra; si se quiere más,
  segundo número o bridge propio.
