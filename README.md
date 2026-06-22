# Kapso Sales Dashboard

Panel de ventas **multi-tienda / multi-usuario** para bots de WhatsApp en
[Kapso](https://kapso.ai) que crean órdenes en Shopify. Kapso entrega analítica
operativa; este panel agrega la analítica de **ventas** propia: ingresos,
embudo de conversión (conversaciones → órdenes), desglose de negocio y salud
operativa — todo por tienda y consolidado.

> Estado: **Fase 1** — scaffold, modelo de datos + RLS, librerías core
> (crypto, Shopify, Kapso, métricas), ingesta (webhooks + cron), auth y
> dashboards de las 4 familias de métricas.

## Stack

- **Next.js 16** (App Router, TypeScript) — UI + API routes + server actions
- **Supabase** — Postgres + Auth (Google + magic link) + RLS
- **Recharts** — gráficos
- **Tailwind CSS v4** — estilos
- **Vitest** — tests unitarios
- Deploy en **Vercel** (cron incluido)

## Arquitectura de datos

No se consulta a Shopify/Kapso en vivo desde el dashboard. Se mantiene una
**base de datos propia** alimentada por ingesta:

```
Shopify  ──webhook orders/create|updated──▶  /api/webhooks/shopify/[storeId]
Shopify  ──backfill/reconciliación (cron)──▶  /api/cron/sync  (query: tag:kapso)
Kapso    ──pull conversaciones/mensajes────▶  /api/cron/sync  (Platform API)
                                              │
                                              ▼
                         Postgres (orders, conversations, ops_snapshots)
                                              │
                                   recálculo  ▼
                                       daily_rollups
                                              │
                                              ▼
                         Dashboards (lib/metrics.ts) — por tienda + consolidado
```

El enlace orden ↔ conversación se hace con los `note_attributes` que el bot
escribe en cada orden Shopify: `kapso_conversation_id`, `kapso_phone_number_id`,
`source=whatsapp-bot`.

## Modelo de acceso (multi-tenant)

`organizations` → `memberships` (rol `owner`/`admin`/`viewer`) → `stores`,
con acceso fino por tienda vía `user_store_access`. **RLS** filtra cada tabla
con `store_id`/`org_id` por las tiendas accesibles del usuario autenticado:

- `owner`/`admin` de una organización ven todas sus tiendas.
- `viewer` ve solo las tiendas que le fueron concedidas explícitamente.

La ingesta (webhooks/cron) escribe con la **service role key** (bypassa RLS);
el dashboard solo **lee** bajo RLS.

## Seguridad

- **Tokens cifrados en reposo.** El Shopify Admin API token, el Shopify API
  secret (para HMAC de webhooks) y la Kapso API key se cifran con **AES-256-GCM**
  (`lib/crypto.ts`) usando `ENCRYPTION_KEY` y se guardan en la BD. Se descifran
  solo en el servidor, bajo demanda. **Nunca** viajan al cliente ni se commitean.
- **Las credenciales por tienda se cargan en runtime** en la pantalla *Conectar
  tienda*; no están en `.env`, en el repo ni en el código. El hosting solo
  recibe secretos de infraestructura (`ENCRYPTION_KEY`, claves Supabase,
  `CRON_SECRET`).
- **HMAC de webhooks** verificado (`X-Shopify-Hmac-Sha256`, comparación en
  tiempo constante) con el secreto **por tienda** descifrado.
- **Idempotencia** de webhooks con `webhook_events (store_id, topic, shopify_id)`.
- **Cron protegido** por `CRON_SECRET`.

## Las 4 familias de métricas (`lib/metrics.ts`)

1. **Ventas** — # órdenes, ingresos (S/), AOV, serie por día, por tienda y
   comparativa vs. periodo previo.
2. **Embudo / conversión** — conversaciones (Kapso) vs. órdenes
   (`source=whatsapp-bot`) → tasa por tienda/día; enlace fino por
   `kapso_conversation_id`.
3. **Desglose de negocio** — % promo (tag `promo-whatsapp`), # `stock-por-validar`,
   contraentrega vs. agencia, top productos (de `line_items`), patrón por
   fecha/hora.
4. **Operativo Kapso** (best-effort) — salud del número
   (`GET /whatsapp/phone_numbers/{id}/health`), errores/latencia
   (`GET /api_logs`), actividad 24h (derivada de conversaciones/mensajes),
   capturado en `ops_snapshots`.

## Integraciones

### Shopify Admin GraphQL
`https://{shop}.myshopify.com/admin/api/{version}/graphql.json`, header
`X-Shopify-Access-Token`. Webhooks `orders/create` y `orders/updated` apuntan a
`/api/webhooks/shopify/[storeId]`. Reconciliación/backfill con
`orders(query: "tag:kapso updated_at:>=<cursor>")`.

### Kapso Platform API
Base `https://api.kapso.ai/platform/v1`, header `X-API-Key`. Endpoints usados
(confirmados con la doc oficial):

| Uso | Endpoint |
| --- | --- |
| Conversaciones | `GET /whatsapp/conversations` (cursor; filtros `phone_number_id`, `status`, `created_after`, `last_active_after`) |
| Mensajes | `GET /whatsapp/messages` (cursor; filtros `conversation_id`, `direction`, …) |
| Salud del número | `GET /whatsapp/phone_numbers/{phone_number_id}/health` |
| Logs / errores / latencia | `GET /api_logs` (`errors_only`, `status_code`, `period`) |

La familia operativa es **best-effort**: si un endpoint no está disponible para
un proyecto, se deriva de conversaciones/mensajes y se marca como tal.

## Puesta en marcha

```bash
pnpm install
cp .env.example .env.local      # completa los secretos de infraestructura
# Aplica el esquema + RLS a tu base Supabase:
psql "$DATABASE_URL" -f db/migrations/0001_init.sql
psql "$DATABASE_URL" -f db/migrations/0002_rollups.sql
psql "$DATABASE_URL" -f supabase/policies.sql
pnpm seed                        # (opcional) datos demo
pnpm dev
```

### Variables de entorno
Ver `.env.example`. Solo secretos de infraestructura + config no-secreta:
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `ENCRYPTION_KEY`, `CRON_SECRET`,
`NEXT_PUBLIC_SITE_URL`, `SHOPIFY_API_VERSION`, `KAPSO_API_BASE`.

```bash
# Genera ENCRYPTION_KEY (32 bytes base64) y CRON_SECRET:
openssl rand -base64 32
openssl rand -hex 32
```

## Tests

```bash
pnpm test          # vitest run
pnpm typecheck     # tsc --noEmit
```

Cubre: round-trip de cifrado AES-GCM (+ detección de manipulación), verificación
HMAC de Shopify, mapeo orden Shopify→`orders` (REST y GraphQL), construcción de
queries Kapso/Shopify y cálculo de cada familia de métricas.

## Estructura

```
app/
  (auth)/login            # login (Google + magic link)
  auth/callback           # intercambio de código OAuth/OTP
  dashboard/              # layout protegido + selector tienda/fechas
    page.tsx              # consolidado
    [storeId]/page.tsx    # detalle por tienda (4 familias)
    stores/new            # onboarding "Conectar tienda"
  api/
    webhooks/shopify/[storeId]/route.ts
    cron/sync/route.ts
lib/   db, crypto, shopify, kapso, metrics, types, env
db/migrations/*.sql
supabase/policies.sql
scripts/seed.ts
test/*.test.ts
```
