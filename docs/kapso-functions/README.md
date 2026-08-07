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
| `kenku-check-coverage.js` | Kenku Perú | ✅ copia del desplegado (lock_version 25) |

Las cuatro funciones tienen copia. **Sigue siendo una copia de referencia, no la
fuente de verdad**: si alguien edita en la consola, esto queda viejo sin avisar.

## Las dos `check-coverage` DIVERGIERON

No son la misma función con otra configuración: el watchdog se implementó dos
veces y por caminos distintos. Al tocar una, no asumir que la otra hace lo mismo.

| | Aurela | Kenku |
|---|---|---|
| Función que avisa al dashboard | `postWaitingAlert` | `postWaitingToStore` |
| `event` del POST | `conversation.waiting` | `workflow.execution.handoff` |
| `reason` | `bot_silent` | `esperando respuesta` |
| `minutes_waiting` en el POST | sí | no (solo en Telegram) |
| Barrido mínimo | 10 min | 2 min |
| Tope de alertas por barrido | 6 | 10 |
| Números vigilados | 2 | 3 |

Aurela manda un evento propio (`conversation.waiting`) que el dashboard clasifica
como handoff **por la forma del cuerpo**, no por el nombre; Kenku imita
directamente el contrato de `notify-team`. Los dos funcionan, pero por motivos
distintos.

**Ninguna de las dos manda BSUID ni username**, y ninguna exige teléfono: las dos
hacen `phone: convo.phone_number || ""` sin ningún `continue` que descarte al
candidato sin número. Ver más abajo.

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

En `watchdogSweep` de **las dos** tiendas: `phone: convo.phone_number || ""`.
**No hay ningún guard que exija teléfono** — si la conversación viene sin
`phone_number`, se postea la cadena vacía igual. (Kenku además la pasa por
`.replace(/[^\d]/g, "")`, que sobre una cadena vacía sigue siendo vacía.)

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

Ese `reason` identifica el origen sin ambigüedad: **`esperando respuesta` es de
KENKU**. Aurela usa `bot_silent`.

**Ya está cubierto del lado del dashboard**: desde el PR #405, un handoff sin
teléfono ni BSUID se empareja por `kapso_conversation_id`, que los dos payloads
sí traen. Mandar el BSUID desde Kapso haría que además funcione cuando el lead
todavía no existe, pero no es urgente.

⚠️ El comentario de `postWaitingToStore` en Kenku dice *"el dashboard deduplica
por teléfono"*. **Eso dejó de ser cierto**: desde las migraciones 0105/0107 la
identidad puede ser el teléfono, el BSUID o la conversación. Es justo la
suposición que hizo que estos avisos se perdieran.

## Números que el watchdog NO vigila

`WATCHDOG_PHONE_IDS` está **hardcodeado** en las dos funciones. Un número
conectado que no esté en esa lista no genera alerta: ni Telegram, ni cola
"Atender ahora". Silencio, sin error.

En Kenku la lista cubre 3 de los 5 números del proyecto —y uno de los 3 es el
sandbox—, así que quedan fuera dos números **de producción, conectados y con
`inbound_processing_enabled: true`**:

| Número | phone_number_id |
|---|---|
| Kenku 630 | `1241670942359671` |
| Kenku 600 | `1117623181444547` |

**No es un descuido: están reservados a propósito** para un proceso aparte que
todavía no arrancó. Medido el 7-ago-2026, cada uno tiene UNA conversación, ambas
del 9 de julio y con 28 segundos de diferencia — una prueba de conexión, no
clientes. Ningún cliente real está escribiendo a un número sin vigilar.

⚠️ **Pero cuando ese proceso arranque, ojo con el sync de leads**: `syncStoreLeads`
llama a `fetchAllConversationsRich` SIN filtro de número, deliberadamente (ver el
comentario en lib/leads-ingest.ts: filtrar por `phone_number_id` una vez dejó
fuera leads legítimos). Consecuencia: **toda conversación del proyecto Kapso se
convierte en lead**, sin importar por qué número entró.

Si el proceso aislado vive en el MISMO proyecto Kapso, sus conversaciones van a
aparecer en la cola de Leads, contar en "sin llamar", mover el gráfico de
conversión y entrar en la exportación de Audiencia Meta. Lo limpio es un proyecto
Kapso aparte; si no se puede, hace falta una lista de EXCLUSIÓN explícita en el
sync — nunca un filtro positivo, que es lo que ya rompió una vez.

Para volver a medirlo:

```sql
select phone_number_id, count(*) as conversaciones, max(last_message_at) as ultima
from conversations
where started_at > now() - interval '30 days'
group by 1 order by 2 desc;
```
