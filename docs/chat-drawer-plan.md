# Plan — Chat de WhatsApp (Kapso) embebido en el drawer de Leads

> **Estado: IMPLEMENTADO (v1, v2 y v3).** El drawer lee el hilo, responde dentro
> de las 24 h desde el número correcto, y fuera de la ventana ofrece el catálogo
> de plantillas aprobadas de la tienda. Lo de abajo es el diseño original; las
> notas de cada fase dicen dónde quedó.

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

### v1 — Leer el hilo (lo nuevo de mayor valor) — ✅ IMPLEMENTADO

> `loadLeadConversation` (`app/dashboard/leads/actions.ts`), burbujas y polling en
> `components/leads-drawer.tsx`, y `mergeConversationMessages`
> (`lib/conversation-merge.ts`). El drawer se extrajo de `components/leads.tsx` a
> su propio archivo, así que las rutas de abajo quedaron desfasadas.

- **Server action** `loadConversation(leadId)`: `authorizeLead` → `getStoreCreds(storeId)`
  → `listMessages(kapso, { conversationId: lead.kapso_conversation_id, limit })` →
  normaliza a `{ dir, text, at, image?, mediaUrl?, status }[]` → devuelve.
- **UI**: panel de burbujas en el drawer (entrante izquierda / saliente verde),
  imágenes/vouchers inline, hora + leído, con polling mientras está abierto.
- Si el lead no tiene `kapso_conversation_id` (carrito web sin chat) → no hay hilo;
  se mantiene el affordance de llamada que ya existe.
- *Archivos:* `app/dashboard/leads/actions.ts`, `components/leads.tsx`, `lib/kapso.ts` (mapeo).

### v2 — Responder dentro de 24h (casi listo) — ✅ IMPLEMENTADO

> Incluida la corrección marcada con ⚠️ arriba: `sendLeadMessage` recibe
> `phoneNumberId` y responde **desde el número del hilo activo**, con fallback al
> default de la tienda. Ya no envía desde el default a secas.

- Reusar `sendLeadMessage`, **corrigiendo** el número de envío a
  `lead.wa_phone_number_id` (fallback al default de la tienda).
- Envío optimista (aparece al instante en el hilo) + confirmación en el siguiente poll.
- *Archivos:* `actions.ts`, `components/leads.tsx`.

### v3 — Responder en frío con plantillas — ✅ IMPLEMENTADO

Salió **sin `listTemplates(store)`**, que era la mitad del plan. Ver «A confirmar»
más abajo: no hay de dónde listarlas.

- `sendWhatsappTemplate` ya existía en `lib/kapso.ts` y lo usaban las cuatro
  automatizaciones (drip, carritos, browse/winback, recuperación de devueltos).
  No hizo falta escribirlo: v3 es el mismo envío con el asesor decidiendo.
- **El catálogo se configura, no se lista**: tabla `wa_reply_templates` (0113),
  una fila por plantilla aprobada, administrada en Ajustes → Plantillas de
  respuesta.
- Selector + variables editables + preview en el composer cuando la ventana está
  cerrada, sustituyendo el aviso sin salida que había antes.
- Los parámetros llegan **pre-rellenados del lead y se dejan corregir**. Es la
  diferencia con el cron, que aborta cuando un dato falta: acá el que falta lo
  completa quien está mirando el chat.
- *Archivos:* `db/migrations/0113_wa_reply_templates.sql`,
  `lib/wa-reply-templates.ts` (puro, compartido cliente/servidor),
  `app/dashboard/leads/actions.ts` (`listLeadTemplates` / `sendLeadTemplate`),
  `components/leads-drawer.tsx` (`TemplateComposer`),
  `app/dashboard/[storeId]/settings/actions.ts` + `components/store-settings.tsx`.

## A confirmar al construir — resuelto

1. **URL de la imagen** — resuelto en v1: el transcripto se pide con
   `fields=kapso(default)` y cada mensaje trae su `media_url` estable
   (`fetchConversationTranscript`).
2. **Endpoint de plantillas** — **no existe uno usable.** Kapso expone
   `/whatsapp/phone_numbers`, `/conversations` y `/messages`, más un proxy a Meta
   acotado a `POST /meta/whatsapp/v24.0/{phoneNumberId}/messages`. Listar
   plantillas en Meta es `GET /{waba_id}/message_templates`, y **el WABA id no se
   guarda en ninguna parte** del repo (`KapsoPhoneNumber` no lo trae).

   Consecuencia: el catálogo se escribe a mano en Ajustes contra lo aprobado en
   Meta. El coste es que un nombre mal escrito solo se descubre al enviar, y por
   eso Ajustes valida lo que puede sin salir a la red — formato del nombre
   (minúsculas, dígitos, guion bajo), formato del idioma, tokens conocidos, y que
   el cuerpo declare tantos `{{n}}` como variables configuradas.

   Si algún día aparece el WABA id o un endpoint de Kapso, esto se cambia por un
   listado en vivo sin tocar el envío: `sendLeadTemplate` ya recibe el nombre y el
   idioma de una fila, venga de donde venga.

## Verificación

- **Unit:** mapeo de mensajes (entrante/saliente/imagen); selección del número de
  envío por `wa_phone_number_id`; gating del composer por ventana de 24h.
- **Unit (v3):** `test/wa-reply-templates.test.ts` — orden de los tokens (es lo
  único que ata cada token a su `{{n}}`), pre-relleno con huecos, validación que
  **nombra el campo que falta** en vez de dejar que Meta responda `#132018`, y
  render del preview dejando el hueco a la vista cuando el valor falta.
- **Manual multitienda:** abrir un lead de **Aurela** y otro de **Kenku** → cada
  hilo trae su propia conversación; al responder, el mensaje sale **desde el número
  correcto de cada tienda**. El catálogo de plantillas tampoco se cruza: es por
  tienda, y son WABAs distintas.
- **Ventana:** lead con último inbound <24h → texto libre habilitado; >24h → solo
  plantilla.

### Pendiente de probar contra Meta real

El envío de v3 **no se ha ejercitado contra la WABA de producción** en este
cambio: no hay plantilla cargada todavía en ninguna de las dos tiendas, y mandar
una de prueba a una clienta real no es una verificación aceptable. Lo que sí está
probado es todo lo que no sale a la red — resolución, validación y preview.

Al cargar la primera plantilla conviene mirar el primer envío: si Meta devuelve
`132001` el nombre no coincide, y si devuelve `132018` es el número de parámetros
lo que no coincide con el cuerpo aprobado.

## Reuso (no reinventar)

- `lib/kapso.ts`: `listMessages`, `sendWhatsappText`, `fetchLastInboundAt`,
  `msgText`/`msgDirection`/`msgTimeMs`/`msgIsImage`.
- `app/dashboard/leads/actions.ts`: `loadLeadDetail`, `getLeadWindow`,
  `sendLeadMessage`, `authorizeLead`.
- `lib/ingest.ts`: `getStoreCreds`.
- `components/leads.tsx`: `LeadDrawer`, `WhatsappComposer` (extender, no reescribir).
