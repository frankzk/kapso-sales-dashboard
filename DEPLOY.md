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
4. Deploy. The cron in `vercel.json` (`/api/cron/sync` every 15 min) is picked up
   automatically; Vercel sends `Authorization: Bearer $CRON_SECRET`.

## 5. First login + connect a store

1. Open the site → **Login** (Google or magic link).
2. You'll be prompted to **create an organization** (you become its owner).
3. **Conectar tienda**, providing the per-store credentials (encrypted at rest,
   never stored in the repo or env):
   - **Shopify Admin API access token** — from a Shopify *custom app*
     (Settings → Apps and sales channels → Develop apps → your app → API
     credentials → Admin API access token, `shpat_…`). Scopes needed:
     `read_orders` (and `read_products` if you want richer product data).
   - **Shopify API secret key** — same app → *API secret key*. Used to verify
     webhook HMAC. (Without it, webhooks can't be verified.)
   - **Kapso API key** — Kapso dashboard → Integrations → API keys.
   - **WhatsApp phone number id** + Kapso project id (optional but enables the
     funnel + operational family).
4. On save, the app validates the token, **registers** `orders/create` +
   `orders/updated` webhooks pointing at
   `https://<your-domain>/api/webhooks/shopify/<storeId>`, and runs an initial
   **backfill** of `tag:kapso` orders.

## 6. Invite your team

**Equipo** → invite by email with a role:
- **owner / admin**: see every store in the org.
- **viewer**: only the stores you explicitly grant (checkboxes per store).

## 7. Post-deploy verification

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
- Webhook HMAC is verified with the **per-store** Shopify API secret.
- Cron is protected by `CRON_SECRET`; ingestion writes via the service role.
- RLS restricts every read to the caller's accessible stores.
