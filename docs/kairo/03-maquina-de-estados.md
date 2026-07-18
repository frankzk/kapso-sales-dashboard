# 03 · Máquina de estados y reglas de negocio

Todo lo de este documento es **portable tal cual** (original: `lib/leads.ts`,
`lib/leads-ingest.ts`). Aquí está cada regla aprendida en producción —
incluidas las que se corrigieron después de errores reales (marcadas 🔥).

## Catálogo de estados

Cada estado tiene `{ code, label, category, source, callable }`.
`source: 'auto'` = solo el sistema lo pone; `'manual'` = lo pone la vendedora.
`callable` = aparece en la cola de llamadas.

| Categoría | Estado | Origen | Notas |
| --- | --- | --- | --- |
| **won** | `pedido_generado` | auto | La orden llegó de la tienda |
| **won** | `ya_tiene_pedido` | auto | Ya tenía orden previa al lead |
| **hot** | `yape_por_verificar`* | auto, callable | Pago adelantado detectado — verificar voucher |
| **hot** | `casi_cierra` | auto, callable | Handoff del bot: cliente a punto de comprar |
| **open** | `nuevo` | auto, callable | Recién ingresado, sin gestionar |
| **open** | `contactado_dejo_wsp` | manual, callable | |
| **open** | `no_responde` | manual, callable | |
| **open** | `cuelga` | manual, callable | |
| **open** | `buzon` | manual, callable | |
| **open** | `otros_productos` | manual, callable | |
| **open** | `sin_stock` | manual, callable | |
| **open** | `repetido` | manual, callable | |
| **open** | `volver_a_llamar` | manual, callable | |
| **lost** | `cancelado_cliente` | manual | |
| **lost** | `cancelado` | manual | También lo usa el auto-archivado |
| **lost** | `ya_compro_otro_lado` | manual | |
| **lost** | `solo_informacion` | manual | |
| **lost** | `solo_miraba` | manual | |
| **lost** | `fuera_de_ciudad` | manual | |
| **lost** | `lista_negra` | manual | |
| **lost** | `nr_no_existe` | manual | Número no existe |
| **lost** | `nr_extranjero` | manual | Número extranjero |
| **lost** | `duplicado` | auto | Dedup |

\* Para Costa Rica renombrar a `sinpe_por_verificar` (ver doc 05).

## Reglas de transición (las 4 leyes)

1. **`deriveAutoState`** — al ingresar/actualizar por ingesta:
   orden ⇒ `won/pedido_generado`; duplicado ⇒ `lost/duplicado`;
   handoff ⇒ `hot` (estado según razón); si no ⇒ `open/nuevo`.
2. **Un estado `manual` NUNCA es sobreescrito por la ingesta.** Si la
   vendedora dispuso el lead, el sync no lo toca (`nextLeadState` devuelve
   null). Excepción: una señal de compra nueva (orden real) sí gana.
3. **`won` es pegajoso**: no se puede degradar manualmente mientras la orden
   siga activa (`canDispositionLead`). Si la orden se cancela, se libera.
4. **Reapertura de perdidos/ganados con carrito**: un evento nuevo del cliente
   (mensaje inbound posterior) puede reabrir un lead `lost` con carrito, y un
   carrito nuevo reabre un `won` viejo (guards `shouldReopenLostCart` /
   `shouldReopenWonCart`).

## Mapeo handoff → estado (adaptar a Icomfly)

El bot, al pedir humano, envía una **razón**. Mapeo original
(`HANDOFF_REASON_STATUS`): razones tipo `validacion_logistica`,
"casi cierra" ⇒ `casi_cierra`; razones que matchean pago adelantado
(`YAPE_REASON_RE`) ⇒ `yape_por_verificar`. **Al portar**: inventariar las
razones reales que emite el bot de Kairo en Icomfly y rehacer esta tabla.
El pago adelantado tiene además `yapeKind`: distingue `pago` (adelanto) de
`agencia` (pago contra agencia de envío).

## Ejes derivados (no son columnas; se calculan al leer)

- **Segmento** (`leadSegment`): `carrito` (dejó carrito) > `distrito` (dio
  ubicación) > `converso` (≥N mensajes inbound) > `frio`. Prioriza la cola.
- **Cola** (`QueueState`): `sin_llamar` (nunca gestionado) vs `seguimiento`.
- **Gestión** (`LeadGestion`): `sin_llamar | nr | buzon_cuelga | contactados |
  sin_stock` — buckets para filtros.
- **Ventana 24h de WhatsApp** (`leadWindowInfo` sobre `last_inbound_at`):
  `fresca` (<12h) | `por_vencer` (12–20h) | `critica` (20–24h) | `cerrada`
  (>24h ⇒ solo plantillas). La UI colorea por urgencia.
- **Pestañas del tablero** (`LEAD_VIEWS`): `por_llamar` | `yape`(=pagos) |
  `seguimientos` | `ganados` | `perdidos`, cada una con su filtro+orden.

## Reglas automáticas del cron (cada 5 min)

Orden de ejecución en `runStoreSync` — respetarlo, hay dependencias:

1. **Sync órdenes** de la tienda → `linkOrdersToLeads` (match por teléfono
   normalizado) → leads pasan a `won`.
2. **Sync conversaciones** del CRM → upsert `conversations` →
   `syncStoreLeads`: dedup por teléfono, upsert de leads vía `nextLeadState`,
   enriquecimiento (distrito, carrito, inbound_count, fuente, pago
   adelantado).
3. **`flagOverdueFollowups`** — seguimientos vencidos (`next_followup_at` en
   el pasado) ⇒ `needs_attention = true` (suben al tope de la cola).
4. **Drip de seguimiento** (`sendSeguimientoDrip`, si la tienda lo activó):
   - Elegibles: estados `no_responde | buzon | cuelga`.
   - Máx **2 toques** por lead: toque 1 a las **6h** del último contacto,
     toque 2 a las **24h**.
   - Solo en horario laboral **9:00–20:00 hora local**; máx **25 envíos por
     corrida** (protege el rate limit).
   - Envía plantilla Meta aprobada; registra en `drip_sends` y en
     `lead_calls` (kind `system`).
5. **`flagCartAttentionWaves`** — leads con carrito en `nr/buzon/cuelga`
   sin actividad 48h ⇒ re-encolar con `needs_attention`, máximo **2 olas**
   (`attention_waves`), para no perseguir eternamente.
6. **`archiveStaleLeads` — auto-archivado a los 7 días** sin interacción:
   leads `open`/`hot` ⇒ `lost/cancelado` + fila de auditoría en `lead_calls`.
   🔥 **Exclusiones aprendidas** (bug corregido en producción):
   - NO archivar `yape_por_verificar` (pago en verificación),
   - NO archivar leads con `next_followup_at` programado,
   - NO archivar leads con `needs_attention = true`.

## Claim / asignación

- "**Tomar lead**": `claimed_by/claimed_at` con **TTL de 10 minutos** — evita
  que dos vendedoras llamen al mismo lead; expira solo.
- **Rotación de pagos por verificar** (Yape/SINPE): el sistema **ofrece** el
  lead a una asesora presente (`payment_offered_to/_at`); ella puede
  **pasarlo** (se agrega a `payment_passed[]` y rota a la siguiente); un admin
  puede **asignarlo** directo. Si queda desatendido fuera de horario ⇒
  **alerta Telegram** (`payment_alert_sent_at` evita duplicados).

## Acciones manuales (server actions)

- `registerCall(leadId, status, note?)` — registra gestión + aplica estado.
  Si el estado ∈ `{casi_cierra, volver_a_llamar}` ⇒ agenda seguimiento
  automático (`defaultFollowupAt`): si es antes de las 16:00 ⇒ hoy 18:00;
  si no ⇒ mañana 10:00.
- `closeSale(leadId, items…)` — venta manual COD: crea orden sintética
  (id `manual-…`, tag `venta_manual`) ⇒ `won`.
- `recoverCart(leadId)` — completa el draft order de la tienda ⇒ `won`.
- `confirmLeadWon`, `claimLead`, `releaseLead`, `passPayment`,
  `assignPayment`.
- Razones de pérdida = los estados de categoría `lost` (no hay tabla aparte).

## Parsers de chat (portables; ajustar regex por país)

Corren sobre mensajes ya normalizados (`ConversationMessage`):

- **`parseOrderSignals`** — extrae **distrito** (respuesta a la pregunta de
  ubicación del bot → eco del bot → "soy de …" espontáneo, con filtros
  anti-ruido: muletillas, cosas-que-no-son-lugar 🔥 bug corregido: el eco del
  bot metía frases como distrito) y **carrito** (ancla en el regex del total
  `ORDER_TOTAL_RES` + líneas de ítems). Ajustar moneda S/ → ₡ (doc 05).
- **`detectYapePayment`** — pago adelantado por texto/caption
  ("ya pagué", "te yapeé"...). Reescribir para SINPE Móvil.
- **Visión LLM sobre vouchers**: imágenes sin texto se pasan a un modelo de
  visión (Claude) que responde si es un comprobante; se deduplica en una
  tabla de auditoría (`*_vision_checks`) para no re-analizar.
- **`extractReferral`** — objeto `referral` de Meta CTWA en el mensaje ⇒
  `source='meta_ad'`, `ad_id`, `ad_headline`, `ctwa_clid`. First-touch:
  si el lead ya tiene fuente, no se sobreescribe.
- 🔥 **Guard anti-eco del bot**: el enriquecimiento **solo rellena campos
  null** y no toca leads que ya tienen draft real de la tienda — evita que
  texto del bot pise datos buenos.

## Insights y productividad (fórmulas)

- **Burndown del día**: cuántos `sin_llamar` quedaban a cada hora del turno
  (8:00–20:00), reconstruido de `created_at` de leads y `occurred_at` de la
  primera gestión. Sin snapshots: todo se deriva de timestamps.
- **Tendencia 7 días**: entrados vs gestionados vs ganados por día.
- **Conversión por asesora**: leads ganados / leads gestionados, atribución
  **last-touch** (última `lead_calls` con vendedora antes del won).
- **Productividad**: chips por tienda con denominador ("AUR 5/30" = 5
  gestionados de 30 asignados); heatmap de gestiones por hora (8–20).

## Resumen diario Telegram

Cron diario (08:00 hora local) por tienda con `telegram_bot_token` +
`telegram_chat_id`: órdenes del día, ventas, leads entrados/gestionados.
Alertas inmediatas solo para pagos por verificar desatendidos.
