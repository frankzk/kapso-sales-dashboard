# 01 · Arquitectura y alcance

## Qué hace el módulo de Leads (resumen funcional)

Seguimiento comercial de conversaciones de WhatsApp que **no** terminaron en
orden: cada teléfono que habla con el bot se convierte en un **lead** con
estado, categoría, señales (distrito, carrito, pago adelantado), historial de
gestiones (llamadas/notas), asignación a vendedoras, seguimientos programados
y métricas de productividad. Las vendedoras trabajan un tablero con pestañas
(Por llamar / Pagos por verificar / Seguimientos / Ganados / Perdidos), abren
un drawer con el chat de WhatsApp embebido, registran la gestión y el sistema
se encarga del resto (auto-archivado, re-encolado, drip de plantillas,
alertas Telegram).

## Flujo de datos

```
CRM (Kapso hoy / Icomfly en Kairo)
  ├─ webhook tiempo real ──▶ /api/webhooks/<crm>/[storeId]?secret=…
  │     · handoff del bot        → lead "hot" (necesita humano)
  │     · conversación terminada → lead "open" (abandono)
  │     · estado de mensaje      → actualiza whatsapp_outbox
  └─ polling (cron cada 5 min) ─▶ /api/cron/sync
        · lista conversaciones + mensajes
        · normaliza → LeadSeed → upsert en `leads` (dedup por store+phone)
        · enriquece: distrito, carrito, conteo inbound, fuente (anuncio Meta),
          detección de pago adelantado (texto + visión LLM sobre vouchers)
                     │
                     ▼
   Postgres: leads, lead_calls, conversations, whatsapp_outbox, drip_sends
                     │  (RLS por tienda; ingesta escribe con service role)
                     ▼
   Tablero de Leads (UI) · Insights · Productividad · Resumen Telegram
                     │
   Tienda (Shopify) ─┘ órdenes enlazadas por teléfono → lead pasa a "won"
```

Principio clave: **no se consulta al CRM en vivo para pintar el tablero**. El
tablero lee la BD propia. El CRM solo se consulta en vivo para (a) el chat del
drawer (transcript bajo demanda) y (b) enviar mensajes.

## Inventario de portabilidad

### ✅ Portable tal cual (re-implementar idéntico en Kairo)

| Pieza | Archivo original | Qué es |
| --- | --- | --- |
| Modelo de datos | `db/migrations/0004…0037` | Ver `02-modelo-de-datos.md` |
| Máquina de estados | `lib/leads.ts` | Estados, categorías, transiciones, ventanas 24h, colas — ver `03-maquina-de-estados.md` |
| Reglas automáticas | `lib/leads-ingest.ts` | Auto-archivado 7 días, seguimientos vencidos, drip, olas de atención |
| Acceso a datos del tablero | `lib/leads-access.ts` | Vistas/pestañas, orden y filtros por vista, paginación >1000 filas |
| Insights | `lib/leads-insights.ts` | Burndown del día, tendencia 7 días, conversión por asesora — todo reconstruido de timestamps, sin jobs de snapshot |
| Productividad | `lib/productivity.ts` | Atribución last-touch por `lead_calls`, heatmap horario |
| Outbox de WhatsApp | `lib/whatsapp-outbox.ts` | Máquina de estados de envíos (pending→sent→delivered→read / failed+retry) |
| Telegram | `lib/telegram.ts`, `lib/daily-summary.ts` | Resumen diario por bot de Telegram |
| UI completa | `components/leads.tsx`, `leads-drawer.tsx`, `leads-insights.tsx` | Tablero, filtros facetados, drawer con chat |
| Parsers de chat | `parseOrderSignals`, `detectYapePayment`, `extractReferral` en `lib/kapso.ts` | La lógica es portable una vez los mensajes están normalizados; los regex son de español y sirven para CR con ajustes de moneda |

### 🔁 Reemplazar por adaptador Icomfly

| Pieza | Archivo original | Reemplazo |
| --- | --- | --- |
| Cliente CRM completo | `lib/kapso.ts` | `lib/icomfly.ts` — ver contrato en `04-contrato-adaptador-crm.md` |
| Ruta de webhook | `app/api/webhooks/kapso/[storeId]/route.ts` | `/api/webhooks/icomfly/[storeId]` (misma auth: secreto por tienda, comparación tiempo constante, fallback `CRON_SECRET`) |
| Proxy de media | `app/api/leads/[leadId]/media/route.ts` | Igual patrón: allowlist de hosts de Icomfly, redirects manuales que quitan la API key fuera del allowlist |
| Clasificación de eventos | `classifyKapsoEvent`, `parseHandoffPayload` | Mapear los eventos reales de Icomfly a los 3 tipos: `handoff` / `conversation` / `message_status` |
| Mapeo razón-handoff→estado | `HANDOFF_REASON_STATUS`, `YAPE_REASON_RE` en `lib/leads.ts` | Remapear a las razones que emita el bot en Icomfly |
| Columnas/credenciales | `kapso_conversation_id`, `kapso_api_key_enc`, etc. | Renombrar genérico: `crm_conversation_id`, `crm_api_key_enc` (recomendado) o `icomfly_*` |
| Normalización de teléfono | `lib/phone.ts` (agrega `51` a móviles peruanos) | Versión CR: `506` + 8 dígitos — ver `05-checklist-costa-rica.md` |

### 🟡 Depende de la tienda de Kairo (decidir si aplica)

| Pieza | Notas |
| --- | --- |
| Enlace lead↔orden Shopify | Si Kairo también vende por Shopify, portar `linkOrdersToLeads` (match por teléfono normalizado) y el estado `won` automático. Si usa otra plataforma, el adaptador de órdenes es análogo al de CRM. |
| Draft orders / carritos COD | Específico de Releasit COD en Shopify. Portar solo si aplica. |
| Yape (pago adelantado Perú) | En CR el equivalente es **SINPE Móvil**. La maquinaria (detección por texto + visión de vouchers + rotación de asignación + alertas) es portable; cambian los regex y el nombre. Ver `05-checklist-costa-rica.md`. |
| Fuentes Meta CTWA | Portable si corren anuncios click-to-WhatsApp; el referral llega en el payload del mensaje (verificar que Icomfly lo exponga). |
| Flow de Shopify (browse abandonment / winback) | Fuente de leads independiente del CRM; portar solo si Kairo tiene esos flujos. |

## Multi-tenancy y seguridad (portar el patrón completo)

- `organizations → memberships (owner/admin/viewer/vendedora) → stores` +
  `user_store_access`; **RLS** filtra todo por `store_id`.
- La ingesta (webhooks/cron) escribe con **service role** (bypassa RLS); la UI
  solo lee bajo RLS.
- Credenciales del CRM **cifradas AES-256-GCM por tienda** en columnas `_enc`
  (nunca en `.env`); `ENCRYPTION_KEY` es el único secreto de infraestructura.
- Webhook autenticado con **secreto por tienda** (rotable desde Ajustes),
  comparación en tiempo constante; idempotencia vía tabla `webhook_events`
  con `unique (store_id, webhook_id)`.
- Cron protegido por `CRON_SECRET` (`Authorization: Bearer` o `?secret=`).

Si Kairo.ai es mono-tienda hoy, **mantén igual el diseño multi-tienda**: el
costo es marginal y ya está probado (este repo corre varias tiendas aisladas).

## Stack original (referencia)

Next.js (App Router, TS) + Supabase (Postgres/Auth/RLS) + Tailwind + Recharts
+ Vitest; deploy en Vercel con crons (`*/5` sync, diario Telegram). Si Kairo
usa otro stack, la spec sigue sirviendo: el 90% del valor está en el modelo de
datos + reglas de `03-maquina-de-estados.md`, que son independientes del
framework.
