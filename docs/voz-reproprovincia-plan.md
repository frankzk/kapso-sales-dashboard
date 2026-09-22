# Plan técnico — Agente de voz para Reproprovincia

> **Estado: DISEÑO, no implementado.** Las reglas de negocio están en el MOM,
> §11.8 (`docs/mom/master-pedidos-v1.md`). Este documento dice cómo se
> construyen. Si algo de aquí contradice al MOM, manda el MOM y se corrige esto.

## Objetivo

Que un agente de voz (Grok Voice Agent API sobre Twilio, ambos reemplazables)
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

```
Vercel (Next.js)                          Servicio «voice-bridge» (proceso vivo)
────────────────────────────              ─────────────────────────────────────
/api/cron/voice-recovery  ──POST /calls──▶  crea llamada Twilio saliente
  elige elegibles (§11.8)                   mantiene la sesión WS con Grok
  inserta voice_calls(queued)               (wss://api.x.ai/v1/realtime)
                                            ejecuta las tools contra Kapta
/api/voice/tools/[callId]  ◀──POST──────    registrar_resultado / derivar / no_llamar
  valida token por llamada
  escribe por register_confirmation_attempt_v1

/api/webhooks/voice        ◀──POST──────    fin de llamada: transcripción,
  finaliza voice_calls                      grabación, duración, costo
  idempotente por call_id
```

**Por qué hay un servicio aparte.** Una llamada de voz es una conexión
WebSocket abierta durante minutos, tanto en la ruta SIP (`wss://api.x.ai/v1/realtime?call_id=…`
se abre y se sostiene por llamada) como en la de Media Streams. Las funciones de
Vercel duran como máximo 60 s en este proyecto y no sirven WebSockets
entrantes. El bridge es pequeño (Node, un contenedor en Fly.io o Railway, misma
región `gru1` que Vercel para latencia) y **no tiene lógica de negocio**: recibe
de Kapta qué llamar y con qué prompt, y devuelve a Kapta lo que pasó. Toda
decisión sobre el pedido vive en Kapta.

### Dos formas de conectar Twilio con Grok

| | A · SIP trunk (`sip.voice.x.ai`) | B · Media Streams + bridge de audio |
| --- | --- | --- |
| Código de audio | Ninguno: Twilio entrega el audio a xAI por SIP | El bridge convierte μ-law 8 kHz ↔ PCM y reenvía frames |
| Qué sostiene el bridge | Solo la sesión de control (`session.update`, tools) | Audio y control |
| Riesgo | Hay que confirmar en docs.x.ai el flujo **saliente** (cómo se obtiene `call_id` al originar desde Twilio) | Más código, pero el flujo saliente es el conocido de Media Streams |

Se empieza por **A** si la documentación confirma el saliente; si no, **B**. La
API es compatible con el Realtime de OpenAI, así que un bridge B escrito para
ese contrato migra cambiando base URL, clave y modelo. `docs.x.ai` no era
alcanzable desde el entorno donde se escribió este plan: la verificación es la
primera tarea de la Fase 1.

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
  add column if not exists voice_recovery_caller_id    text;          -- número Twilio E.164

create table voice_calls (
  id               uuid primary key default gen_random_uuid(),
  store_id         uuid not null references stores(id) on delete cascade,
  order_id         uuid not null references orders(id) on delete cascade,
  shipment_id      uuid references shipments(id) on delete set null,   -- la guía fallida que abrió la recuperación
  provider         text not null default 'grok',
  provider_call_id text,                                              -- call_id de xAI
  twilio_call_sid  text,
  phone            text not null,
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
hasta lo que quede del tope, inserta `voice_calls(queued)` con token por llamada
y llama al bridge. En modo sombra (`VOICE_RECOVERY_DRY_RUN=1`) inserta con
`status = 'cancelled'` y `error = 'dry_run'`: la cola se ve en el drawer sin
que suene ningún teléfono.

El botón **«Llamar con el agente»** del drawer hace lo mismo para un pedido,
con `triggered_by = usuario`, y solo con `voice_recovery_enabled`. Pasa por la
misma elegibilidad: si el pedido no entra, el botón dice por qué.

## Contrato con el bridge

`POST {BRIDGE_URL}/calls` (cabecera `Authorization: Bearer VOICE_BRIDGE_SECRET`):

```json
{
  "voice_call_id": "…",
  "to": "+51…",
  "from": "+51…",
  "tool_token": "…",
  "tools_url": "https://kapta…/api/voice/tools/{voice_call_id}",
  "events_url": "https://kapta…/api/webhooks/voice",
  "max_duration_s": 240,
  "voice_id": "…",
  "instructions": "…prompt compilado…",
  "tools": [ …esquema de abajo… ]
}
```

El bridge no guarda nada más allá de la llamada en curso. Si Kapta no responde
a una tool, el agente lo dice («ahora mismo no puedo registrarlo») y la llamada
termina como `sin_resultado`.

### Tools que ve el modelo

```json
[
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

`/api/voice/tools/[voiceCallId]` valida el token (hash en `voice_calls`),
que la llamada esté `in_progress`, y traduce a hechos según la tabla de §11.8:

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

`POST /api/webhooks/voice` (firma HMAC con `VOICE_BRIDGE_SECRET`): cierra la
fila con transcripción, grabación, duración, costo y `status`. Si terminó sin
que el modelo llamara `registrar_resultado`, `outcome = 'sin_resultado'` y **no
se toca el pedido**. Idempotente por `provider_call_id`.

## El prompt (esqueleto)

Se compila en `lib/voice-recovery-prompt.ts` desde la ficha; las pruebas fijan
que nunca contiene el código de guía y siempre el nombre del pedido de Shopify.

```
Eres el asistente virtual de {tienda}. Hablas español de Perú, con trato de
usted, frases cortas. Estás llamando a {nombre} por su pedido {pedido_shopify}
({producto} x {cantidad}, S/ {monto}, contra entrega), que el courier no pudo
entregar en {distrito}, {ciudad}.

Empieza EXACTAMENTE con: "{saludo_legal_aprobado}"

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

## Guardarraíles técnicos

- **Secretos** en `lib/env.ts`: `XAI_API_KEY`, `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, `VOICE_BRIDGE_URL`, `VOICE_BRIDGE_SECRET`,
  `VOICE_RECOVERY_DRY_RUN`. La clave de xAI vive **solo en el bridge**.
- **Un token por llamada** para las tools, con hash en la fila y caducidad al
  cerrar la llamada. El bridge nunca tiene credenciales de Kapta de largo
  plazo.
- **Candado por pedido** al escribir: la RPC ya toma `pg_advisory_xact_lock`
  por `order_id`; el cron además no encola un pedido con una `voice_calls`
  abierta (`queued`, `dialing`, `in_progress`).
- **Llamadas colgadas**: un barrido marca `failed` toda fila `in_progress` con
  más de 10 minutos, sin tocar el pedido.
- **Sin PII en logs**: los logs del bridge llevan `voice_call_id`, nunca
  teléfono ni transcripción.
- **Tope duro en el bridge**: `max_duration_s` corta la llamada aunque el modelo
  no se despida.

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
| 1 · Verificación | Confirmar en docs.x.ai el flujo saliente SIP o elegir Media Streams; número Twilio peruano con bundle regulatorio; prueba de voz en español peruano con 10 llamadas internas; texto legal aprobado | sí (nada en el repo) |
| 2 · Fundaciones | Migración 0165; `p_source` y `p_payload_extra` en la RPC; `lib/voice-recovery.ts` puro con pruebas; ajustes de tienda; cron en modo sombra; columna «Agente» leyendo `voice_calls` | sí, `DRY_RUN=1` |
| 3 · Bridge | Servicio `voice-bridge` (repo aparte o `services/voice-bridge`), tools y webhook en Kapta, botón manual del drawer | sí, `enabled` apagado |
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
- `test/voice-recovery-prompt.test.ts`: nunca código de guía; siempre nombre de
  Shopify; saludo legal al principio; sin saludo no compila.
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

## Verificaciones pendientes antes de la Fase 2

1. Flujo saliente con SIP en docs.x.ai (cómo se obtiene `call_id` al originar
   desde Twilio) y si xAI exige TLS/SRTP en el trunk.
2. Caller ID peruano en Twilio: bundle regulatorio y tiempos.
3. Precio por minuto de Grok voice y de Twilio Perú, para la última fila de la
   tabla de métricas.
4. Texto legal del saludo (grabación y tratamiento de datos) aprobado por el
   owner.
5. Si Grok no rinde en español de provincia: la misma arquitectura sirve para
   ElevenLabs Agents u otro proveedor compatible con el contrato de tools; el
   bridge cambia, Kapta no.
