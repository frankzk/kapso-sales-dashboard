# Funciones de Kapso — copia de respaldo

Las funciones de este directorio **no se ejecutan desde este repo**. Corren en
Kapso (Cloudflare Workers) y se editan en `app.kapso.ai → Functions`. Esto es una
**copia de referencia**, no la fuente de verdad.

## Por qué existe

Las funciones desplegadas en Kapso contienen código que **no está en el repo de
funciones** que maneja el CLI (`kapso push` / `kapso pull`). En concreto, el
bloque `postStoreHandoff` —el que conecta el bot con la cola "⚡ Atender ahora"
de este dashboard— se agregó editando la función en la consola web y nunca se
commiteó.

Consecuencia: **un `kapso push` desde una copia local desactualizada sobrescribe
la versión desplegada y borra ese bloque sin aviso.** La cola dejaría de llenarse
y no habría ningún error visible — solo silencio.

Guardar el código acá no evita ese borrado. Es un **seguro**: permite darse
cuenta y restaurar. El arreglo de verdad es reconciliar lo desplegado con el repo
de funciones de Kapso.

## Qué hay y qué falta

| Función | Tienda | Estado |
|---|---|---|
| `aurela-notify-team.js` | Aurela | ✅ copia del desplegado, **con el gate de `reason` ya aplicado** |
| `kenku-notify-team.js` | Kenku Perú | ✅ copia del desplegado |
| `aurela-check-coverage.js` | Aurela | ✅ copia del desplegado (lock_version 78) |
| `check-coverage` | Kenku Perú | ❌ **falta** — otro proyecto, otra API key |

⚠️ **Falta el `check-coverage` de Kenku.** Está desplegado en un proyecto Kapso
distinto, con su propia API key. Hay que copiarlo desde `app.kapso.ai →
(proyecto Kenku) → Functions → check-coverage → Code`. Las dos tiendas usan
motivos distintos —Aurela manda `bot_silent`; el de Kenku hay que confirmarlo,
se cree que es `esperando respuesta`— así que la copia de Aurela **no sirve** de
referencia para la otra.

## Cómo se conectan con el dashboard

Ambas funciones hacen `POST` al webhook de su tienda:

```
POST {STORE_WEBHOOK_URL}
X-Webhook-Secret: {STORE_WEBHOOK_SECRET}
X-Kapso-Signature: <HMAC-SHA256 hex del cuerpo>   (opcional)

{
  "event": "workflow.execution.handoff",
  "phone_number": "51987654321",     // solo dígitos
  "conversation_id": "…",
  "reason": "reclamo",               // sin reason NO es un handoff
  "context_summary": "…"             // se ve como "RESUMEN DEL BOT" en el drawer
}
```

Del lado del dashboard lo recibe `app/api/webhooks/kapso/[storeId]/route.ts`, que
acepta el secreto por header `X-Webhook-Secret` o por `?secret=`.

Los secrets son **por función** en Kapso: `STORE_WEBHOOK_URL` y
`STORE_WEBHOOK_SECRET` hay que cargarlos en cada función que postee (notify-team
y check-coverage), aunque ya estén en otra.

## Cómo llega el watchdog al dashboard (leído del código de Aurela)

`postWaitingAlert` postea un cuerpo que **no lleva cabecera `X-Webhook-Event`**:

```js
{
  event: "conversation.waiting",     // ← no es "workflow.execution.handoff"
  phone_number: c.phone || "",
  conversation_id: c.id || "",
  reason: "bot_silent",
  context_summary: "…",
  minutes_waiting: 12
}
```

Ese `event` no coincide con ningún prefijo conocido, así que
`classifyKapsoEvent` cae a inferir por la FORMA del cuerpo — y como trae
`reason`, lo clasifica como **handoff**. Va a `applyHandoff`, que es lo correcto.
Conviene saberlo: el enrutado depende de que el payload traiga `reason`, no del
nombre del evento.

### El teléfono puede venir vacío, y ya pasó

En `watchdogSweep`: `phone: convo.phone_number || ""`. **No hay ningún guard que
exija teléfono** — si la conversación viene sin `phone_number`, se postea
`phone_number: ""` igual.

Y eso no es teórico: es exactamente el caso de la migración de identidad de Meta.
Un cliente que adopta un *username* de WhatsApp deja de compartir su número, así
que `convo.phone_number` llega ausente. El watchdog postea sin teléfono, y como
`postWaitingAlert` **tampoco manda el BSUID**, el handoff quedaba sin ninguna
identidad y el dashboard lo descartaba en silencio.

Lo detectó la superficie de anomalías (migración 0107) el día que se encendió:

```
source: handoff · reason: sin_identidad
sample: {"reason":"esperando respuesta","conversationId":"31513f90-…"}
```

**Ya está cubierto del lado del dashboard**: desde el PR #405, un handoff sin
teléfono ni BSUID se empareja por `kapso_conversation_id`, que este payload sí
trae. Mejorarlo del lado de Kapso —mandar el BSUID en `postWaitingAlert`— haría
que además funcione cuando el lead todavía no existe, pero no es urgente.
