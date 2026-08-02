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
| `aurela-notify-team.js` | Aurela | ✅ copia del código desplegado |
| `kenku-notify-team.js` | Kenku Perú | ✅ copia del código desplegado |
| `check-coverage` (watchdog) | ambas | ❌ **falta** — nunca se capturó |

⚠️ **`check-coverage` es la que más importa y no está acá.** Es la que contiene
el watchdog de "clientes esperando respuesta" (`maybeRunWatchdog` /
`watchdogSweep`), que hoy alimenta el grueso de la cola. Para completar el
respaldo hay que copiar su código desde `app.kapso.ai → Functions →
check-coverage → Code`, en **las dos** tiendas (están desplegadas por separado y
usan motivos distintos: Aurela manda `bot_silent`, Kenku `esperando respuesta`).

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

## Pendiente conocido

**Aurela no tiene el gate de `reason`.** Su `postStoreHandoff` postea también en
el flujo de voucher, que no manda motivo, y eso ensucia `handoff_at` con eventos
que no son handoffs (en producción quedaron leads con `handoff_reason` NULL).
Kenku ya lo tiene. El parche, dentro de `postStoreHandoff` y justo después de
`if (!url) return;`:

```js
  // El flujo de voucher no manda `reason`: no es un handoff, no va al dashboard.
  const reason = String(payload.reason || "").trim();
  if (!reason) return;
```

…y usar esa variable en el cuerpo (`reason,` en lugar de volver a leer
`payload.reason`).

El dashboard ya está blindado por su lado: un POST sin motivo no reclasifica un
lead existente. El gate es para no ensuciar el dato de origen.
