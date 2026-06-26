# Plan — Chat de WhatsApp (Kapso) embebido en el drawer de Leads

> **Estado: PLANIFICADO — no implementado.** Documento de referencia para más
> adelante. La feature de carritos abandonados (draft orders) ya está en
> producción; esto es el siguiente paso opcional.

## Objetivo

Que el asesor, al abrir un lead en el drawer, **vea toda la conversación de
WhatsApp y responda ahí mismo**, sin salir del dashboard ni abrir Kapso aparte —
respetando las ventanas de 24h, sincronizado 100% con Kapso, y **multitienda de
raíz** (cada chat ligado a su tienda y su número real).

## Qué ya existe hoy (sobre lo que se construye)

- El drawer **ya envía** un WhatsApp libre dentro de la ventana de 24h
  (`WhatsappComposer` → `sendLeadMessage` en `app/dashboard/leads/actions.ts` →
  `sendWhatsappText` en `lib/kapso.ts`).
- El dashboard **ya sabe leer mensajes** de Kapso: `listMessages(opts, { conversationId })`
  (`lib/kapso.ts`) + helpers `msgText` / `msgDirection` / `msgTimeMs` / `msgIsImage`.
- La ventana de 24h se consulta en vivo: `getLeadWindow(leadId)` (`actions.ts`) →
  `fetchLastInboundAt` (`lib/kapso.ts`).
- **Lo que falta:** pintar el hilo (las burbujas) en el drawer, responder desde el
  número correcto, y plantillas para responder fuera de 24h.

## Garantía multitienda (requisito central)

Cada chat queda atado a su tienda real por 4 llaves que **ya viven en el dato**,
sin mezclar nada entre tiendas:

| Pieza | De dónde sale | Garantía |
|-------|---------------|----------|
| Proyecto Kapso | `getStoreCreds(lead.store_id).kapso_api_key` | El hilo se pide con el API key **de esa tienda** |
| Conversación | `lead.kapso_conversation_id` | Trae solo los mensajes **de ese cliente** |
| Número que responde | `lead.wa_phone_number_id` | Se contesta **desde el número al que el cliente escribió**, no un default |
| Acceso del usuario | RLS por tienda (`authorizeLead`) | Un vendedor solo ve chats de **sus tiendas** |

> ⚠️ **Corrección necesaria:** `sendLeadMessage` hoy envía desde el número
> *default* de la tienda (`creds.whatsapp_phone_number_id`). Para multitienda /
> multinúmero correcto debe enviar desde `lead.wa_phone_number_id` (con fallback
> al default). Se corrige en la v2.

## Sincronización 100% con Kapso

- **Leer = en vivo.** Al abrir el drawer se llama `listMessages(conversation_id)`
  contra Kapso. La fuente de verdad es Kapso, **no** una copia en nuestra BD → sin
  drift. (No se persisten los mensajes; se renderiza lo que Kapso devuelve.)
- **Mientras el drawer está abierto:** polling cada ~5–8 s para traer mensajes
  nuevos (mismo patrón que ya usa `getLeadWindow`).
- **Tiempo real de fondo:** los webhooks de Kapso que ya se ingieren
  (`ingestConversationEvent`) siguen actualizando el estado del lead.

## Ventanas horarias (regla de WhatsApp, parametrizada)

El composer cambia según `getLeadWindow`:
- **Dentro de 24h** → caja de texto libre (ya funciona hoy).
- **Fuera de 24h** → se desactiva el texto libre y aparece un **selector de
  plantillas aprobadas** de esa tienda. El indicador "● Ventana 24h · Nh Nm" del
  diseño avisa en qué modo está.

## Fases (incrementales, cada una usable por sí sola)

### v1 — Leer el hilo (lo nuevo de mayor valor)
- **Server action** `loadConversation(leadId)`: `authorizeLead` → `getStoreCreds(storeId)`
  → `listMessages(kapso, { conversationId: lead.kapso_conversation_id, limit })` →
  normaliza a `{ dir, text, at, image?, mediaUrl?, status }[]` → devuelve.
- **UI**: panel de burbujas en el drawer (entrante izquierda / saliente verde),
  imágenes/vouchers inline, hora + leído, con polling mientras está abierto.
- Si el lead no tiene `kapso_conversation_id` (carrito web sin chat) → no hay hilo;
  se mantiene el affordance de llamada que ya existe.
- *Archivos:* `app/dashboard/leads/actions.ts`, `components/leads.tsx`, `lib/kapso.ts` (mapeo).

### v2 — Responder dentro de 24h (casi listo)
- Reusar `sendLeadMessage`, **corrigiendo** el número de envío a
  `lead.wa_phone_number_id` (fallback al default de la tienda).
- Envío optimista (aparece al instante en el hilo) + confirmación en el siguiente poll.
- *Archivos:* `actions.ts`, `components/leads.tsx`.

### v3 — Responder en frío con plantillas (lo que falta de cero)
- `listTemplates(store)` + `sendWhatsappTemplate({ phoneNumberId, to, name, variables })`
  vía el mismo proxy Meta de Kapso (`POST /meta/whatsapp/v24.0/{phoneNumberId}/messages`
  con `type: "template"`).
- Selector de plantilla + variables en el composer cuando la ventana está cerrada.
- *Archivos:* `lib/kapso.ts` (2 funciones nuevas), `actions.ts`, `components/leads.tsx`.

## A confirmar al construir (no bloquean el diseño)

1. **URL de la imagen** en el objeto de mensaje de Kapso (para pintar vouchers):
   Kapso marca `kapso.has_media` / `media_data.content_type`; falta ver si expone
   una URL directa o si la media se baja por un endpoint aparte.
2. **Endpoint de plantillas** de Kapso para listarlas por número (existe el
   concepto de templates en Kapso; confirmar el listado y el formato de variables).

## Verificación

- **Unit:** mapeo de mensajes (entrante/saliente/imagen); selección del número de
  envío por `wa_phone_number_id`; gating del composer por ventana de 24h.
- **Manual multitienda:** abrir un lead de **Aurela** y otro de **Kenku** → cada
  hilo trae su propia conversación; al responder, el mensaje sale **desde el número
  correcto de cada tienda**.
- **Ventana:** lead con último inbound <24h → texto libre habilitado; >24h → solo
  plantilla.

## Reuso (no reinventar)

- `lib/kapso.ts`: `listMessages`, `sendWhatsappText`, `fetchLastInboundAt`,
  `msgText`/`msgDirection`/`msgTimeMs`/`msgIsImage`.
- `app/dashboard/leads/actions.ts`: `loadLeadDetail`, `getLeadWindow`,
  `sendLeadMessage`, `authorizeLead`.
- `lib/ingest.ts`: `getStoreCreds`.
- `components/leads.tsx`: `LeadDrawer`, `WhatsappComposer` (extender, no reescribir).
