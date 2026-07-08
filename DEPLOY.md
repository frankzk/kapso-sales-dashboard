# Deployment runbook

Turnkey checklist to put the dashboard live on **Supabase + Vercel**. The steps
below are the ones that need a browser/computer (creating projects, OAuth,
pasting credentials). Everything else (code, migrations, tests, CI) is already
done.

Estimated time once you have the accounts: **~20–30 min**.

---

## 0. Generate the two infra secrets

```bash
openssl rand -base64 32   # → ENCRYPTION_KEY (AES-256-GCM key for token encryption)
openssl rand -hex 32      # → CRON_SECRET
```

Keep these somewhere safe. `ENCRYPTION_KEY` must never change after stores are
connected (it decrypts their tokens).

## 1. Create the Supabase project

1. supabase.com → New project. Choose a region close to your users.
2. **Project Settings → API**: copy
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (server-only!)
3. **Project Settings → Database → Connection string (URI)** → `DATABASE_URL`
   (use the direct connection or the session pooler for migrations).

## 2. Apply the schema + RLS

From a machine with `psql`:

```bash
psql "$DATABASE_URL" -f db/apply.sql
```

This runs `0001_init`, `0002_rollups`, `0003_refunds` and `supabase/policies.sql`
(idempotent). Supabase already provides the `authenticated` / `service_role`
roles and the `auth` schema, so it just works.

## 3. Configure Auth

**Authentication → Providers**

- **Email**: enable. (Magic links work out of the box with Supabase's email; for
  production volume configure your own SMTP under Project Settings → Auth.)
- **Google**: enable, paste a Google OAuth **Client ID/Secret**
  (Google Cloud Console → Credentials → OAuth client, type *Web application*).
  In Google, add the authorized redirect URI:
  `https://<YOUR-PROJECT>.supabase.co/auth/v1/callback`.

**Authentication → URL Configuration**

- **Site URL**: `https://<your-vercel-domain>`
- **Redirect URLs**: add
  - `https://<your-vercel-domain>/auth/callback`
  - `http://localhost:3000/auth/callback` (for local dev)

> SMTP note: if you don't configure SMTP, the team "invite by email" flow falls
> back to creating the user without sending mail — they can still sign in with a
> magic link. Configure SMTP to actually send invites.

## 4. Deploy to Vercel

1. vercel.com → New Project → import `frankzk/kapso-sales-dashboard`.
2. Framework preset: **Next.js** (auto-detected). Build command/output default.
3. **Environment Variables** (Production + Preview):

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | from step 1 |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | from step 1 |
   | `SUPABASE_SERVICE_ROLE_KEY` | from step 1 (server-only) |
   | `ENCRYPTION_KEY` | from step 0 |
   | `CRON_SECRET` | from step 0 |
   | `NEXT_PUBLIC_SITE_URL` | `https://<your-vercel-domain>` |
   | `SHOPIFY_API_VERSION` | `2025-01` (optional) |
   | `KAPSO_API_BASE` | `https://api.kapso.ai/platform/v1` (optional) |

   `DATABASE_URL` is only needed for migrations; you don't have to add it to
   Vercel.
4. Deploy. The cron in `vercel.json` (`/api/cron/sync` every 5 min) is picked up
   automatically; Vercel sends `Authorization: Bearer $CRON_SECRET`.

> **Cron on Vercel Hobby**: the Hobby plan runs cron jobs only ~once/day. If you
> need the 5-min cadence without Pro, use the included GitHub Actions fallback
> (`.github/workflows/cron-sync.yml`): add repo **secrets** `APP_URL`
> (your deployed URL) and `CRON_SECRET`, and make sure the workflow is on the
> repo's **default branch** (scheduled workflows only run there). Webhooks ingest
> orders in real time regardless; the cron only handles reconciliation, the Kapso
> pull and ops snapshots.

## 5. First login + connect a store

1. Open the site → **Login** (Google or magic link).
2. You'll be prompted to **create an organization** (you become its owner).
3. **Conectar tienda**, providing the per-store credentials (encrypted at rest,
   never stored in the repo or env):
   - **Shopify Admin API access token** — from a Shopify *custom app*
     (Settings → Apps and sales channels → Develop apps → your app → API
     credentials → Admin API access token, `shpat_…`). Scopes needed:
     `read_orders`, `read_draft_orders`, `write_draft_orders`, `read_products`,
     `read_customers`.
     The draft scopes power the abandoned-cart / Releasit COD feature (read
     open/completed drafts and let "Generar pedido" complete a draft into an
     order); `read_products` powers the order form's catalog picker (productos
     reales con stock + precio); `read_customers` powers the leads drawer's
     "Pedidos anteriores" (Shopify can't search orders by phone, so we resolve
     the customer by phone and read their orders — the local table is kapso-only).
     - *Alternative — "Install on Shopify" (OAuth):* create a Shopify app, set
       its redirect URL to `{NEXT_PUBLIC_SITE_URL}/api/shopify/callback`, scopes
       `read_orders,read_draft_orders,write_draft_orders,read_products,read_customers`,
       and add `SHOPIFY_APP_API_KEY` + `SHOPIFY_APP_API_SECRET`
       to Vercel. Then create the store with the token blank and click
       **Instalar con Shopify** in store **Ajustes** — the token is captured,
       encrypted, webhooks registered and backfill run automatically.
     - *Existing stores must re-grant the draft + product + customer scopes:* re-run
       `/api/shopify/install?storeId=<id>` (OAuth, or click **Reconectar con
       Shopify** in store **Ajustes**) or paste a custom-app token that already
       includes them. Until then the abandoned-cart feature stays empty (the draft
       sync logs a scope error, non-breaking), the order form's catalog picker
       returns nothing (falls back to manual items), and the leads drawer's
       "Pedidos anteriores" stays empty (degrades gracefully).
   - **Shopify API secret key** — same app → *API secret key*. Used to verify
     webhook HMAC. (Without it, webhooks can't be verified.)
   - **Kapso API key** — Kapso dashboard → Integrations → API keys.
   - **WhatsApp phone number id** + Kapso project id (optional but enables the
     funnel + operational family).
4. On save, the app validates the token, **registers** `orders/create` +
   `orders/updated` + `draft_orders/create|update|delete` webhooks pointing at
   `https://<your-domain>/api/webhooks/shopify/<storeId>`, and runs an initial
   **backfill** of `tag:kapso` orders.

## 5b. Abandoned browse (Búsquedas abandonadas) via Shopify Flow

A second, lower-intent web source: a Shopify Flow that fires on **"Customer left
online store"** posts the identified visitor + the product they viewed to the
dashboard, creating a `🔎 Búsqueda abandonada` lead — only when a phone is
present, and only if no lead already exists for that phone (it never downgrades a
WhatsApp / cart / campaign lead).

1. **Set the per-store secret.** Generate one (`openssl rand -base64 24`), then in
   **Ajustes de la tienda → Rotar credenciales**, paste it into *Secreto webhook
   de Shopify Flow (búsquedas)*. Store the same value as a Shopify **secret** for
   the Flow action.
2. **Build the Flow** (Shopify Admin → Settings → Flow): trigger *Customer left
   online store* → action **Send HTTP request**:
   - **POST** `https://<your-domain>/api/webhooks/flow/<storeId>`
   - Headers `Content-Type: application/json` and
     `X-RecoverOps-Secret: {{ the secret from step 1 }}`.
   - Body (Liquid) carrying at least: `source: "abandoned_browse"`,
     `abandonment.id`, `customer.phone`
     (`{{ customer.defaultPhoneNumber.phoneNumber }}`), `customer.name`,
     `productsViewed[]`, `productsAddedToCart[]`, `sentAt`.
   - **Optional but recommended** — to classify by district, also send the saved
     address: `customer.defaultAddress.city` (→ distrito), `.province`,
     `.address1`. Without it, browse-only leads land in *Frío* with the viewed
     product shown for context.
3. **Validate.** `GET https://<your-domain>/api/webhooks/flow/<storeId>` →
   `{ ok: true }`. Trigger a real browse → the lead appears in *Por llamar* with
   the `🔎 Búsqueda` chip; the server logs `[flow-webhook]` with the payload
   *shape* (booleans/counts, no PII). Re-delivering the same `abandonment.id` does
   not duplicate; a phone that already has a lead is left untouched.

## 5c. Winback (Recuperación de clientes, 60 días) via Shopify Flow

A re-engagement message for customers with **no new purchase in ~60 days**: a
Shopify Flow posts the lapsed customer to the same Flow webhook with
`source: "winback"` and the dashboard fires the Meta-approved WhatsApp template
(discount coupon + store-link button). It is a **pure send** — no lead is
created; if the customer replies, the normal Kapso inbound flow takes over.

1. **Create + approve the template** (Kapso → Templates), e.g.
   `recuperacion_60d_1` with `{{1}}` = customer first name and a static URL
   button (a `https://<storefront>/discount/<CODE>` link auto-applies the coupon).
2. **Configure it in Settings** (Ajustes de la tienda → *Recuperación de
   clientes*): enable + template name + language. Uses the same
   *Secreto webhook de Shopify Flow* as §5b (set it up first if missing).
3. **Build the Flow** (Shopify Admin → Flow): trigger **Order created** →
   **Wait 60 days** → **Condition** "customer has not ordered since" (e.g.
   `customer.lastOrderId == order.id` / `numberOfOrders` unchanged) → action
   **Send HTTP request**:
   - **POST** `https://<your-domain>/api/webhooks/flow/<storeId>`
   - Headers `Content-Type: application/json` and
     `X-RecoverOps-Secret: {{ the §5b secret }}`.
   - Body (Liquid):
     ```json
     {
       "source": "winback",
       "event": "winback_60d",
       "order": { "id": "{{ order.id }}" },
       "customer": {
         "id": "{{ order.customer.id }}",
         "name": "{{ order.customer.firstName }}",
         "phone": "{{ order.customer.defaultPhoneNumber.phoneNumber }}"
       },
       "sentAt": "{{ "now" | date: "%Y-%m-%dT%H:%M:%S%z" }}"
     }
     ```
4. **Semantics.** Idempotent per order cycle (`winback-<order.id>`): Flow
   retries dedupe; a customer who buys again and lapses again enters a new
   cycle (new order id) and gets the next message — intended. The send is
   skipped (event still recorded) when the config is disabled, the phone is
   missing, or there's no name for `{{1}}`. If the phone has a lead, the send
   is logged on its Historial as a `system` entry.

## 6. Invite your team

**Equipo** → invite by email with a role:
- **owner / admin**: see every store in the org.
- **viewer**: only the stores you explicitly grant (checkboxes per store).

## 5d. Ventas por fuente y cierre (atribución auditable)

The store dashboard's **"Ventas por fuente y cierre"** module attributes every
active order to exactly ONE acquisition source and ONE closing channel, so the
buckets always reconcile to the headline net revenue (Σ fuentes = Σ canales =
total). It's the audit tool — click a source to see its orders (código, fecha,
neto, canal, cupón) and sanity-check the assignment.

- **Source** precedence: winback (used a coupon AND got the recuperación-60d
  template ≤30 días antes) ▸ the customer's lead source (Meta Ads / carrito /
  búsqueda / orgánico) ▸ "Sin atribuir" (order whose phone has no lead — pure web
  checkout / histórico, surfaced on purpose).
- **Closing channel**: Asesora (closed via the dashboard: `venta_manual` /
  `carrito_recuperado`) ▸ Bot asistido (an advisor logged activity on the lead
  ≤7 días antes del pedido) ▸ Bot.
- **ROAS** on the Meta row = attributed revenue / Meta ad spend for the range
  (live from the Marketing API; shows "—" if Meta isn't connected).
- Needs **migration 0030** (`discount_codes` on orders + `winback_sends`). Before
  it runs, the module still renders — winback just can't be detected and coupons
  are ignored; both fill in once orders re-sync after the migration.
- The same source breakdown is appended to the daily **Telegram** summary.

## 5e. Comprobante Yape por visión (opcional)

The **"Yape/Shalom por verificar"** alert fires when a customer pays the advance.
The text/caption detector already catches the explicit cases ("ya pagué", "nº de
operación", or a bot confirmation). A **silent voucher image** (a screenshot sent
with no words) can only be told apart from an unrelated capture by reading it — so
an optional vision check (Claude) inspects the image before firing.

- **Opt-in via env** (Vercel → Project → Settings → Environment Variables):
  - `ANTHROPIC_API_KEY` — enables the vision check. **Without it, detection stays
    text/caption-only** (the safe default: a bare screenshot never trips the
    alert). This is the only required var.
  - `YAPE_VISION_MODEL` — optional; defaults to `claude-opus-4-8`. Set it to a
    cheaper model (e.g. `claude-haiku-4-5`) to lower per-image cost — this is a
    simple per-image classification, so a smaller model is usually plenty.
- **Needs migration 0031** (`yape_vision_checks`) — dedup + audit so each image is
  analyzed **once ever**. Before it runs (or if absent), the check still works but
  can't dedup; with a key set it re-analyzes each run, so apply the migration.
- **What counts as a voucher**: the model must see the Yape interface/logo plus the
  payment indicators (monto, fecha/hora, destinatario "Grupo GF SAC", estado "Pago
  realizado"/"Transferencia exitosa"/"Yapeaste", nº de operación). Only images sent
  **after** the bot asked for the adelanto/voucher are checked; the run is bounded
  (≤12 new images/run) and the verdict is recorded in `yape_vision_checks`
  (`is_voucher`, `indicators`, `model`) for auditing.

## 7. Post-deploy verification

- **Health**: `curl https://<domain>/api/health` → `{ "ok": true, … }` (public,
  no secrets) confirms the deployment is serving.
- **Backfill parity**: in Shopify Admin, filter orders by `tag:kapso` for a date
  range and compare the count with the dashboard's order count for the same
  range. They should match.
- **Webhook**: create a test order in Shopify (or re-trigger a webhook) → it
  appears in the dashboard within seconds; re-delivering it does not duplicate.
- **Cron**: `curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/sync`
  → returns a JSON report; rollups refresh.
- **RLS**: log in as a viewer granted only store A → confirm store B is not
  visible. (The CI `db` job already proves this at the database level.)

## Security recap

- Per-store Shopify/Kapso credentials are **AES-256-GCM encrypted** in the DB and
  decrypted only server-side. They are never in the repo, env, or client.
- Webhook HMAC is verified with the **per-store** Shopify API secret. The Shopify
  Flow webhook (abandoned browse) uses a **per-store shared secret**
  (`X-RecoverOps-Secret`), compared in constant time.
- The **Kapso lead webhook** (`/api/webhooks/kapso/[storeId]`) authenticates with
  a **per-store secret** (`?secret=…`, set in *Ajustes → Rotar credenciales →
  Secreto webhook de Kapso*), compared in constant time. Once a store sets its
  own secret, only that secret is accepted for it — the shared `CRON_SECRET` no
  longer authorizes writes to that store, so one tenant cannot inject leads into
  another. Stores that haven't set a secret yet keep the `CRON_SECRET` fallback
  for backward compatibility; **set a per-store secret before onboarding
  third-party store owners.**
- Cron is protected by `CRON_SECRET`; ingestion writes via the service role.
- RLS restricts every read to the caller's accessible stores.
