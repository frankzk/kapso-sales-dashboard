# 04 · Contrato del adaptador CRM (Icomfly)

Todo el sistema consume el CRM a través de **una sola capa** (hoy
`lib/kapso.ts`). Para Kairo se escribe `lib/icomfly.ts` implementando este
contrato. Si Icomfly no ofrece alguna capacidad, hay **niveles de servicio
degradados** (§ Niveles) — el módulo funciona igual con menos features.

## Formas normalizadas (el "seam" del sistema)

```ts
// Lo mínimo que el adaptador debe producir por conversación:
type LeadSeed = {
  phone: string;                 // normalizado (506########)
  wa_id?: string;
  name?: string;
  crm_conversation_id: string;
  wa_phone_number_id?: string;   // si hay multi-número
  first_seen_at?: string;        // ISO
  last_interaction_at?: string;  // ISO
};

// Mensaje normalizado (alimenta parsers, drawer y enriquecimiento):
type ConversationMessage = {
  id: string;
  direction: "inbound" | "outbound";  // outbound = bot/negocio
  timestamp: number;                  // epoch ms
  text?: string;
  mediaKind?: "image" | "audio" | "video" | "document" | "sticker";
  mediaUrl?: string;                  // URL estable (se sirve vía proxy propio)
  caption?: string;
  template?: string;                  // nombre de plantilla si aplica
  referral?: {                        // Meta CTWA, si el CRM lo expone
    source_id?: string; headline?: string; ctwa_clid?: string;
  };
};
```

**Lección del original**: los payloads de CRM son inconsistentes (timestamps
como unix-string/segundos/ms/ISO; dirección como `direction`/`is_inbound`/
`from_me`). Escribir normalizadores defensivos pequeños (`msgTimeMs`,
`msgDirection`, `msgText`, …) y **testearlos con payloads reales** capturados
de Icomfly.

## Interfaz del adaptador

```ts
interface CrmAdapter {
  // ── Lectura (polling del cron) ─────────────────────────────
  listConversations(opts: {
    createdAfter?: string; lastActiveAfter?: string; cursor?: string;
  }): Promise<{ items: CrmConversation[]; nextCursor?: string }>;
  listMessages(conversationId: string, opts?: { cursor?: string }):
    Promise<{ items: ConversationMessage[]; nextCursor?: string }>;

  // ── Derivados de lectura ───────────────────────────────────
  conversationToLeadSeed(conv: CrmConversation): LeadSeed | null;
  fetchConversationTranscript(conversationId: string):
    Promise<ConversationMessage[]>;                 // para el drawer
  fetchLastInboundAt(phone: string): Promise<string | null>; // ventana 24h
  findConversationIdByPhone(phone: string): Promise<string | null>;

  // ── Envío (composer del drawer + drip + plantillas) ────────
  sendText(phoneNumberId: string, to: string, body: string):
    Promise<{ providerMessageId?: string }>;
  sendTemplate(phoneNumberId: string, to: string,
    template: { name: string; language: string; params?: string[] }):
    Promise<{ providerMessageId?: string }>;
  sendMedia?(kind: "image"|"document"|"video", ...): Promise<...>; // opcional

  // ── Webhooks (tiempo real) ─────────────────────────────────
  classifyEvent(headers: Headers, body: unknown):
    | { kind: "handoff"; conversationId: string; phone: string;
        contactName?: string; reason?: string; contextSummary?: string }
    | { kind: "conversation"; event: "ended"|"inactive"|"created"; conv: CrmConversation }
    | { kind: "message_status"; statuses: Array<{
        providerMessageId: string;
        status: "sent"|"delivered"|"read"|"failed";
        errorCode?: string; errorMessage?: string; timestamp?: number }> }
    | { kind: "skip" };

  // ── Opcionales (best-effort en el original) ────────────────
  listWhatsappNumbers?(): Promise<Array<{ phone_number_id: string; name?: string; display_phone?: string }>>;
  getPhoneHealth?(phoneNumberId: string): Promise<unknown>;
  fetchMediaBase64?(url: string): Promise<{ data: string; mime: string }>; // para visión de vouchers
}
```

## Qué necesitamos saber de Icomfly (cuestionario)

Responder esto ANTES de implementar — define el nivel de servicio:

1. **¿Tiene API REST para listar conversaciones y mensajes?** ¿Con qué
   autenticación (API key / OAuth) y qué paginación (cursor / páginas)?
2. **¿Emite webhooks?** ¿Cuáles eventos? En particular:
   - ¿handoff / "necesita agente" del bot? ¿incluye razón y contexto?
   - ¿fin/inactividad de conversación?
   - ¿estados de entrega de mensajes (sent/delivered/read/failed)?
   - ¿permite configurar la URL + un secreto por cuenta?
3. **¿Puedo enviar mensajes por API?** ¿Texto libre dentro de la ventana 24h?
   ¿Plantillas Meta aprobadas (nombre + idioma + parámetros)? ¿Media?
4. **¿Cómo entrega el teléfono del cliente?** (formato: con/sin `+`, con/sin
   código de país) — define la normalización.
5. **¿Expone URLs de media** (imágenes/vouchers)? ¿Son estables? ¿Requieren
   la API key? (necesario para el proxy de media y la visión de vouchers).
6. **¿Expone el `referral` de Meta CTWA** en el primer mensaje? (necesario
   para atribución de anuncios).
7. **¿Multi-número?** ¿Un `phone_number_id` o equivalente por línea?
8. **¿El bot de Icomfly escribe algo en las órdenes de la tienda** (nota,
   atributo, tag) que permita enlazar orden ↔ conversación? Si no, el enlace
   es solo por teléfono (que ya funciona bien).

## Niveles de servicio según capacidades de Icomfly

| Nivel | Requiere de Icomfly | Qué funciona |
| --- | --- | --- |
| **A — mínimo** | Solo webhooks (o solo polling) de conversaciones | Tablero completo, estados, gestiones, seguimientos, auto-archivado, insights, productividad, Telegram. Sin chat embebido ni envío. |
| **B — estándar** | A + API de lectura de mensajes | + Chat en el drawer (solo lectura), enriquecimiento por parsers (distrito, carrito, pago adelantado), ventana 24h real. |
| **C — completo** | B + API de envío (texto y plantillas) + webhook de estados | + Composer en el drawer, outbox con ✓/✓✓/reintentos, drip automático de plantillas. Paridad total con el panel actual. |

Si Icomfly no da ni webhooks ni API (solo su propia UI web), el plan B es
ingesta por **exportes CSV** periódicos (este repo ya tiene un patrón de
importación en `app/api/import/aliclik` que sirve de referencia) — se pierde
tiempo real pero el tablero y las reglas siguen sirviendo.

## Patrón de webhook (portar tal cual)

- Ruta `/api/webhooks/icomfly/[storeId]?secret=<secretoPorTienda>`.
- Secreto por tienda cifrado (`crm_webhook_secret_enc`), generado desde
  Ajustes, mostrado una sola vez; comparación en **tiempo constante**;
  fallback a `CRON_SECRET` global solo si la tienda no definió el suyo.
- **Idempotencia**: registrar `(store_id, webhook_id)` en `webhook_events`
  antes de procesar; re-entregas responden 200 `{duplicate:true}`.
- `GET` a la ruta = ping `{ok:true}` para probar la URL al configurarla.
- Responder 200 rápido; el trabajo pesado va al cron.

## Proxy de media (portar tal cual)

`/api/leads/[leadId]/media?url=…`: autenticado (sesión + RLS del lead),
**allowlist de hosts** de Icomfly, sigue redirects manualmente quitando la
API key si sale del allowlist (guard SSRF), allowlist de content-types.
Nunca exponer la URL cruda del CRM al navegador.
