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

> [!WARNING]
> **Desplegar NO aplica migraciones.** El `build` es `next build` a secas: no hay
> `vercel-build`, ni `buildCommand`, ni paso de migración en ninguna parte. Cada
> migración nueva se aplica **a mano**, con el comando de arriba, y conviene
> hacerlo **antes** de que salga el código que la necesita — así el despliegue
> encuentra la base lista en vez de al revés.
>
> **Qué pasa si se olvida**, porque pasó el 19-08-2026 con la 0123: el código
> salió llamando a un RPC que no existía, el barrido del Master atrapó el error y
> siguió, y la cuarta puerta se quedó horas sin detectar un solo desfase mientras
> el informe del cron salía impecable. Un trabajo que no puede mirar se parece
> demasiado a uno que miró y no encontró nada. Desde entonces el informe de
> `/api/cron/master-reconcile` trae **`staleDoorError`** justo para distinguirlos:
> si no es `null`, la primera sospecha es una migración sin aplicar.
>
> **Y ojo con los índices sobre tablas grandes.** Un `create index` normal bloquea
> las escrituras de su tabla mientras se construye — instantáneo en el Postgres
> vacío de CI, nada instantáneo sobre `shipments` en producción. Cuando una
> migración cree índices ahí, córrelos antes por separado en su forma
> concurrente, que no bloquea, y luego el fichero completo (los encontrará
> creados y se los saltará):
>
> ```sql
> create index concurrently if not exists <nombre> on <tabla> (<columnas>);
> ```
>
> `concurrently` no puede ir dentro de una transacción, y por eso las migraciones
> no lo usan: `db/apply.sql` las aplica en bloque y fallaría.

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
   | `ALICLIK_API_BASE` | `https://api.aliclik-dev.com` (optional; **pon la de producción cuando Aliclik la entregue**) |
   | `ALICLIK_WRITE_ENABLED` | `false` por defecto. `true` habilita CREAR guías en Aliclik |
   | `SHALOM_API_KEY` | API key (`sk_…`) del wrapper de Shalom. **Global: una para todas las tiendas.** Sin ella no aparece «+ Guía Shalom» (ver 5ñ) |
   | `SHALOM_API_BASE` | `https://api.shalom-api-peru.com` (optional). **El host a secas, sin `/v1`**: el cliente ya añade la ruta, y una base con `/v1` produce `/v1/v1/…` → 404. Si no existe la variable, el valor por defecto ya es el correcto |
   | `OLVA_TRACKING_APIKEY` | La `apikey` con la que la página pública de Olva (`tracking.olvaexpress.pe`) llama a `reports.olvaexpress.pe/webservice/rest/getTrackingInformation`. **Es de Olva, no nuestra**: se captura en DevTools → Red al consultar un tracking, y la pueden rotar sin aviso. Sin ella el cron `olva-reconcile` se salta y los estados de Olva se marcan a mano (ver §12 del MOM) |
   | `OLVA_TRACKING_API_BASE` | `https://reports.olvaexpress.pe` (optional) |
   | `CHATBY_WEBHOOK_SECRET` | Secreto del «Live Chat Webhook» de Chatby. **Lo elegís vos** (`openssl rand -hex 32`), no lo emite Chatby. Va también en Chatby → Integrations → Live Chat Support → Webhook, campo *Custom Header*: `X-Webhook-Secret: <valor>`. Sin él el receptor rechaza todo (ver 5q) |
   | `META_APP_SECRET` | *App Secret* de la app de Meta — **lo emite Meta**, es el mismo que ya usa la Marketing API. Con él se verifica la firma `X-Hub-Signature-256` de cada entrega del webhook de página/Instagram. Sin él el receptor rechaza todo (ver 5s) |
   | `META_WEBHOOK_VERIFY_TOKEN` | Token del apretón de manos del webhook de Meta. **Lo elegís vos** (`openssl rand -hex 32`) y lo tecleás en el panel de Meta al dar de alta la URL. Sin él Meta **nunca activa la suscripción** y no llega nada, sin error visible (ver 5s) |

   `DATABASE_URL` is only needed for migrations; you don't have to add it to
   Vercel.
4. Deploy. The crons in `vercel.json` are picked up automatically; Vercel sends
   `Authorization: Bearer $CRON_SECRET`:
   - `/api/cron/sync` — every 5 min (reconciliation + ops snapshots). Recorre
     las tiendas activas en serie. **No barre el Master**: eso lo hace el cron de
     abajo, por el motivo que explica.
   - `/api/cron/master-reconcile` — cada 10 min, intercalado con el sync
     (`5,15,25,…`). Pone al día las filas de `order_master` que se quedaron con
     la etapa vieja. **Es un cron aparte a propósito, y es la tercera vez que
     este repositorio aprende lo mismo**: el barrido era la última línea de
     `runStoreSync`, y con las tiendas recorriéndose en serie bajo un solo
     `maxDuration`, a la segunda no le llegaba nunca. Medido el 17-08-2026:
     Kenku con 207 pedidos desfasados y 50 h de media, Aurela con cero. Ahora
     tiene reloj propio y lo reparte entre las tiendas que faltan.
     El informe por tienda dice `requested/written/failed/deferred` y el
     `budgetMs` que le tocó: **`failed` distinto de cero es un fallo**, pero
     `deferred` solo dice que no cupo y vuelve en la pasada siguiente — si no
     baja nunca, el presupuesto se quedó corto.
   - `/api/cron/telegram-summary` — daily 13:00 UTC (per-store daily summary).
   - `/api/cron/aliclik-catalog` — cada hora, en el minuto 7. Refresca el espejo
     del catálogo de Aliclik (EAN, stock por almacén, agencias Shalom). Solo
     lectura. Era diario (09:00 UTC) hasta el 2-10-2026: lo que cambiaba en
     Aliclik durante el día no se veía hasta el día siguiente y bloqueaba la
     creación de pedidos hasta que alguien sincronizaba a mano. Si falla solo la
     pasada `isAgency=true`, se guarda el resto y la elegibilidad para agencia
     queda la de la sincronización anterior (con aviso en el informe), en vez de
     marcar todo el catálogo como no apto para agencia.
   - `/api/cron/aliclik-reconcile` — cada 20 min. Red de seguridad del webhook de
     Aliclik, que llega **sin firma y sin garantía de entrega**: relee los
     pedidos de los últimos 14 días y resuelve las creaciones que se fueron en
     timeout. Si el webhook falla, un estado tarda como mucho un ciclo. Deja
     constancia de cada pasada en `aliclik_sweep_state`, que es de lo que se fía
     el cierre de abajo.
   - `/api/cron/aliclik-close` — cada 20 min, al medio de las del barrido
     (`10,30,50`). Caduca los candados de creación que ya no protegen nada
     (MOM §10.2) y persigue de una en una a las guías vivas que la ventana de 14
     días ya no alcanza — sobre todo devoluciones, que tardan semanas.
     **Es un cron aparte a propósito**: las dos tareas iban al final del barrido
     y dejaron de ejecutarse por completo cuando el recorrido empezó a agotar
     `maxDuration`. Si vuelven a fallar, el informe dice por dónde: `orphansHeld`
     explica cada candado que no se soltó y `sweepAgeMinutes` delata un barrido
     que dejó de completarse.
   - `/api/cron/aliclik-scheduled` — cada hora de 8:00 a 13:00 de Lima
     (`7 13-18 * * *` UTC). Crea la guía Aliclik de los pedidos de Provincia COD
     programados para hoy (MOM §6.2), por el mismo camino que el botón y sin
     levantar excepciones. Lo que falla avisa por Telegram, un mensaje por
     pedido, al grupo urgente de la tienda o, si no tiene, al del resumen diario.
     Solo en producción y con `ALICLIK_WRITE_ENABLED=true`; `?dry=1` cotiza y
     dice qué haría sin crear ni avisar. **Sin migración.**
   - `/api/cron/backup` — daily 08:00 UTC (~03:00 Lima). Snapshots the
     dashboard-native tables (`leads`, `lead_calls`, `shipment_calls`) to CSV in
     the private Supabase Storage bucket `db-backups` (auto-created, keeps the
     last 14), and pings Telegram. **No manual setup.** This is a lightweight
     complement to Supabase's daily backups / PITR, not a replacement — it
     covers table-level loss (bad migration, accidental DROP), not "whole
     project gone". **Restore:** download the CSV from the bucket and `COPY`/
     import it back into the table.
   - `/api/cron/invoices` — cada 10 min (a los :06, :16, …). Emite o simula las
     boletas por RUC (MOM §35). No hace nada mientras todos los RUC estén
     «Apagado»; ver la sección «Comprobantes SimpleFact por RUC».

### Pases a mano (bajo `/api/cron`, pero SIN horario)

No todo lo que vive bajo `/api/cron` es periódico. Estas rutas comparten la
autorización por `CRON_SECRET` y nada más: **no están en `vercel.json`** y no se
disparan solas. Se llaman cuando hace falta.

- `/api/cron/reprocess-vouchers` — relee los comprobantes de pago que quedaron
  en estado observado y rellena lo que falta. Existe porque la visión corre
  **una sola vez**, al subir el comprobante, y su lectura queda cacheada en la
  columna `vision`: arreglar el lector no mueve lo ya cargado.

  **El simulacro es el modo por defecto.** Sin `escribir=1` calcula todo, te
  devuelve el informe y no toca la base:

  ```
  GET /api/cron/reprocess-vouchers?secret=<CRON_SECRET>
  GET /api/cron/reprocess-vouchers?secret=<CRON_SECRET>&escribir=1
  ```

  Acepta `limit=N` para acotar la pasada. Corta por reloj a los 240 s e informa
  en `deferred` cuántos quedaron para la siguiente llamada — si ese número nunca
  baja, el presupuesto se quedó corto.

  Solo **rellena huecos**: nunca pisa un valor que ya esté, porque puede haberlo
  escrito una persona mirando la imagen. No toca `revision_admin`, donde hay
  alguien revisando. Y pega una vez a la API de Anthropic por comprobante, con
  la clave de cada tienda, así que no es gratis.

  El mismo trabajo se puede correr desde una máquina con el repo con
  `pnpm exec tsx scripts/reprocess-vouchers.ts`; la lógica está compartida en
  `lib/voucher-reprocess.ts` para que las dos formas no puedan discrepar.

> **Cron on Vercel Hobby**: the Hobby plan runs cron jobs only ~once/day, and
> caps them at two. This project declares **twelve**, nine of them sub-hourly, so
> `vercel.json` as it stands only deploys on **Pro** — where Vercel runs each one
> at its declared cadence and no external scheduler is needed.
>
> There used to be a GitHub Actions fallback here (`cron-sync.yml`) that called
> `/api/cron/sync` every five minutes for the Hobby case. **It was deleted on
> 2026-08-17, and the reason is worth keeping**: its one step began with
>
> ```bash
> if [ -z "$APP_URL" ] || [ -z "$CRON_SECRET" ]; then echo "…skipping"; exit 0; fi
> ```
>
> and neither secret was ever set. So it ran on schedule, never touched
> production, and **reported success every single time**. Months of green ticks
> for a job that did nothing — a check that cannot fail carries no information,
> and is worse than no check, because the row in Actions reads as coverage. It is
> the same defect as the `macro_version is null` query removed in #453: a door
> that cannot open still gets counted as a door.
>
> **If you ever drop to Hobby** and need the cadence back, re-add a scheduled
> workflow that POSTs to `/api/cron/sync` with `Authorization: Bearer
> $CRON_SECRET` — but make a missing secret **fail the job**, never skip it, and
> put it on the repo's **default branch** (scheduled workflows only run there).
> Note also that GitHub's scheduler does not honour `*/5` on a busy repo: the
> observed spacing was 20–40 minutes.
>
> Webhooks ingest orders in real time regardless; the cron only handles
> reconciliation, the Kapso pull and ops snapshots.

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
  ≤7 días antes del pedido) ▸ Bot. **Solo dentro de los pedidos del bot y por
  etiquetas**, que la sincronización con Shopify reescribe: aquí «Asesora»
  queda casi siempre en cero. La tarjeta «Canal de cierre» del Consolidado ya
  no usa esto desde el 14-10-2026: clasifica TODAS las ventas por
  `order_sales` (0259, MOM §17.3).
- **Corrección (14-10-2026, 0268):** desde la 0268 la cabecera del tablero
  cuenta todas las ventas (MOM §17.4). Este módulo sigue sobre los pedidos del
  bot: cuadra con el total de esos pedidos, no con la cabecera.
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

## 5f. Drip de seguimiento — no contesta (opcional)

Leads en **No responde / Buzón / Cuelga** reciben automáticamente una plantilla
de WhatsApp para reengancharlos (fuera de la ventana de 24h solo Meta-approved
templates pueden abrir conversación). Reglas fijas: **máx 2 toques** por lead
(~6h después de la gestión sin respuesta y +24h el segundo), **solo 9–20h**
hora de la tienda, nunca si el cliente respondió (`last_inbound_at`), si la
asesora agendó `next_followup_at` o si el lead tiene atención pendiente. Cada
intento queda en `drip_sends` y como nota en el timeline del lead. El toque se
consume aunque Meta rechace el envío (no se re-martilla un número roto), con
una excepción: un **tope de mensajería de Meta** (tier / rate limit) corta el
lote de esa corrida sin consumir toques — el límite es de la tienda, no del
lead, y al resetearse el tier los mismos leads vuelven a salir. Cada envío sale
por el **número por el que escribió el cliente** (`leads.wa_phone_number_id` —
clave en tiendas multinúmero como Kenku), con fallback al número default de la
tienda; un lead sin ninguno de los dos se omite sin consumir toque, así que el
default en Ajustes es opcional pero recomendado como respaldo.

- **Needs migration 0035** (`drip_template_*` en stores, `drip_touches` /
  `last_drip_at` en leads, tabla `drip_sends`). Antes de correrla el paso es un
  no-op (el toggle lee `false`).
- **Plantilla Meta**: crear en el WABA de cada tienda una plantilla con el
  nombre del cliente como única variable `{{1}}` (p.ej. `seguimiento_nr_1`,
  idioma `es`) — idealmente con botones de respuesta rápida para que la
  respuesta reabra la ventana de 24h por el flujo normal de Kapso. Los leads
  sin nombre se omiten.
- **Activación**: Ajustes → *Drip de seguimiento (no contesta)* → Habilitado +
  nombre de plantilla + idioma. Off por defecto; se puede apagar al instante
  desde el mismo lugar.
- **Verificar**: correr el cron y revisar `select * from drip_sends order by
  sent_at desc limit 20;` + la nota "📤 Drip: …" en un lead tocado. El reporte
  del cron trae `dripSent`.
- **Cede los carritos a la secuencia**: cuando la *Secuencia de carritos
  abandonados* (`cart_seq_enabled`) está activa, el drip genérico **omite los
  carritos** (`dripSkipReason` → `carrito_secuencia`) para no mandar dos
  plantillas de marketing al mismo cliente — el carrito recibe
  `carrito_abandonado_1/2` y el genérico queda solo para los no-carrito
  (Frío/Conversó/Distrito). Con la secuencia apagada, el drip sigue cubriendo
  también a los carritos (comportamiento previo).

## 5g. Olas de reencolado de carritos (automático)

Complemento del drip por el canal de LLAMADAS: un lead **con carrito** cuyo
último resultado fue "no logré contactar" (no_responde/buzon/cuelga) y lleva
**48h sin actividad** vuelve a subir con `needs_attention` — la lista lo ordena
primero y el tab "En seguimiento" muestra un **contador rojo** con los que
piden atención. **Máximo 2 olas por lead** (≈ día 2 y día 4; sin tope sería un
ping-pong infinito, porque cada gestión apaga la atención y reinicia el reloj).
Tras la ola 2: o la asesora agenda/dispone, o el auto-archivado de 7 días lo
saca. Los estados de "sí hablé" (contactado/otros productos) y los cierres
(Perdidos) nunca se reencolan; el que dijo que no y quedó marcado
"Cancelado por cliente" queda en paz.

- **Needs migration 0036** (`leads.attention_waves`). Antes de correrla el paso
  es un no-op silencioso. Siempre activo tras la migración (sin toggle); la
  primera corrida del cron ejecuta la "ola inicial" sobre el stock acumulado.
- Cada ola deja una nota en el timeline: `🔁 Reencolado automático: carrito sin
  contacto por 48h (ola 1/2)`. El reporte del cron trae `requeued`.
- El **auto-archivado de 7 días respeta la atención pendiente**: un lead con el
  marcador rojo activo (ola, respuesta nueva, seguimiento vencido) no se
  archiva en silencio — el reloj se reanuda cuando la asesora lo gestiona.

## 5h. Master de Pedidos

Sección nueva (`/dashboard/pedidos`): la vista central de control de la
operación logística de las dos tiendas. **Consolida** lo que ya producen Repro
Provincia, los reportes de couriers y Shopify — no los reemplaza. Cada pedido
tiene UN estado general (`pendiente` / `en_proceso` / `entregado` / `anulado` /
`devuelto`) y un estado operativo más específico, además del historial completo
de couriers, intentos y comentarios.

- **Needs migration 0045** (`order_master`, `order_events`) y **0046**
  (`peru_districts`). Antes de correrlas la sección carga vacía (el listado lee
  `order_master`); no rompe nada más.
- **`order_events` es append-only**: `service_role` solo tiene SELECT + INSERT y
  un trigger rechaza UPDATE/DELETE. La trazabilidad no se puede reescribir.
  `scripts/verify-db.sh` lo comprueba en cada corrida de CI.
- **El universo de pedidos se amplía.** Hasta ahora la ingesta solo guardaba los
  pedidos con `tag:kapso` (los del bot). El Master necesita todos, así que:
  - el webhook ya no descarta los pedidos sin el tag;
  - el cron hace una segunda pasada de reconciliación sin filtro, con su propio
    cursor `sync_state.source = 'shopify_all'`.

  **Las métricas no se mueven**: `recompute_daily_rollups` y
  `lib/access.ts:getOrders` siguen filtrando por `tag:kapso`, y los rollups y el
  vínculo con el lead solo se disparan para pedidos del bot.
  **Corrección (14-10-2026): sí se movieron.** Esto suponía que la etiqueta
  `kapso` que el dashboard añadía en su copia a las ventas de asesora, a los
  carritos recuperados y a la recompra automática sobreviviría. No sobrevive:
  la pasada `shopify_all` y el webhook reescriben `tags` con lo de Shopify, y
  esos pedidos salían del conteo en minutos (1 de 2.916 ventas de asesora la
  conservaba). Desde el 14-10-2026 ya no se escribe; quién cerró cada venta lo
  decide `canal_de_cierre` (0259, MOM §17.3). Y desde la 0268 (MOM §17.4) la
  cabecera, «Ventas por día» y «Por tienda» cuentan todas las ventas con
  `ventas_por_origen`; `getOrders`, `getRollups` y `recompute_daily_rollups`
  siguen con `tag:kapso` para los módulos que son del bot y lo dicen.
- **`ORDERS_SYNC_FROM` acota el histórico** (por defecto `2026-06-01`). La pasada
  nueva solo trae pedidos **creados** a partir de esa fecha, así que no arrastra
  años de pedidos cerrados. Se filtra por `created_at` y no por `updated_at`, para
  que un pedido viejo que alguien edite hoy no vuelva a entrar. Para ampliar el
  histórico basta mover la variable en Vercel y borrar el cursor:
  `delete from sync_state where source = 'shopify_all';`
  También es el piso de «Canal de cierre» (MOM §17.3), que cuenta desde el más
  tardío entre esta fecha y el día en que cada tienda empezó a usar Kapta (su
  primera venta de asesora registrada o, sin ninguna, su primer lead); con
  varias tiendas, cada una desde su propio día (desde la 0268; antes, desde la
  que empezó último). Lo mismo vale para la cabecera y «Conversión por fuente»
  (MOM §17.4). Moverla hacia atrás no amplía nada más allá de ese inicio;
  adelantarla sí recorta.
- **El Master se rellena solo.** `runStoreSync` termina con un barrido de
  reconciliación (`reconcileOrderMaster`) que crea o refresca las filas que
  falten, así que no hace falta ningún backfill manual. Las acciones de Repro
  Provincia y la importación de reportes recalculan al instante los pedidos que
  tocan; el barrido es la red de seguridad.
- **Provincia**: Shopify Perú solo entrega distrito (`city`) y departamento
  (`province`), no el nivel intermedio. `0046` crea `peru_districts` y la siembra
  con los pares distrito→provincia que los Excel de Aliclik ya dejaron en
  `shipments`. Para cubrir los distritos a los que aún no se despachó, cargar el
  ubigeo del INEI en esa tabla; mientras esté vacía, el filtro de provincia solo
  muestra las provincias conocidas.
- **La ubicación se puede corregir a mano** (needs migration **0051**). La
  dirección de Shopify sale del formulario que llenó el cliente —Shopify mismo la
  marca como problemática a menudo— y su punto del mapa suele estar desplazado.
  Desde el detalle del pedido se corrigen distrito, provincia, región, dirección,
  referencia y **coordenadas**, y aparece un enlace "Ver mapa" que usa las
  coordenadas corregidas. La corrección vive en `order_geo_overrides`, **no** en
  `orders`, así que gana sobre Shopify, sobre los reportes de courier y sobre el
  ubigeo, y sobrevive a la siguiente sincronización. Al corregir una provincia se
  ofrece recordarla para los próximos pedidos del mismo distrito, que es la forma
  barata de ir completando el ubigeo con datos reales. `order_master.geo_source`
  dice de dónde salió la ubicación vigente.
- **Permisos**: `viewer` es solo lectura en el Master (consulta, filtra, abre el
  detalle y el historial, pero no modifica). Cambiar un pedido ya cerrado
  (entregado/anulado/devuelto) exige rol admin y un motivo obligatorio, que queda
  en el historial.

## 5i. Reportes de courier (Aliclik, Shalom, Olva)

La importación deja de ser exclusiva de Aliclik. `/dashboard/envios/import` acepta
el reporte de **cualquier** courier y reconoce el formato solo (guías AUR5X →
Aliclik; columnas de agencia/fecha límite → Shalom u Olva); el operador solo
tiene que elegir el courier cuando el archivo no se reconoce.

- **Needs migration 0047** (campos de gestión y de agencia en `shipments`, más el
  rollup de agencia en `order_master`) y **0048** (metadatos del reporte en
  `import_batches`). Antes de correrlas la carga sigue funcionando en el camino
  de Aliclik; las columnas nuevas simplemente no se escriben (el código aplica
  *column step-down*).
- **Los reportes originales se conservan** en el bucket **privado**
  `courier-reports` (`<storeId>/<courier>/<sha256>-<archivo>`). Se crea solo en
  la primera carga y se fuerza a privado en cada arranque: llevan nombre,
  teléfono y dirección de clientes reales. Si el almacenamiento falla, la ingesta
  continúa —perder la copia no debe costar el reporte.
- **Re-cargar el mismo archivo no duplica nada**: los estados solo avanzan
  (`reconcileDeliveryStatus`), y la interfaz avisa si esa huella ya se había
  subido.
- **Aliclik conserva su ingesta propia** (reglas de Fenix, dirección editada a
  mano, fallback de provincia). El endpoint genérico la invoca y le añade los
  metadatos del reporte; `/api/import/aliclik` sigue existiendo y delega.
- **Añadir un courier nuevo** es un archivo en `lib/couriers/` y una línea en
  `lib/couriers/registry.ts`. Los alias de cabecera son amplios a propósito:
  cuando llegue un formato distinto, basta con añadir el alias.

## 5j. Pagos Yape y clave de recojo (Shalom)

Los envíos por Shalom se cobran en dos tiempos: un **Yape de adelanto** para
despachar y un **Yape de la diferencia** antes de entregar al cliente la clave
con la que recoge el paquete en la agencia. La clave es la llave del paquete: si
se entrega antes de cobrar, el dinero se pierde.

- **Needs migration 0049** (`order_payments`, `shalom_pickup_keys`,
  `pickup_key_views`, `pickup_key_shares`, `user_permissions`, e indicadores de
  pago/clave en `order_master`). Antes de correrla el panel no aparece y el
  Master funciona igual.
- **Requiere `ENCRYPTION_KEY`** (la misma que ya cifra los tokens de tienda): la
  clave se guarda **cifrada** con AES-256-GCM, nunca en texto plano. Si esa clave
  cambiara, las claves de recojo existentes dejarían de descifrarse.
- **La clave no es legible por SQL.** `shalom_pickup_keys` tiene RLS activo y
  **ninguna** policy, y no concede privilegios a `authenticated`: ni un
  administrador puede leerla desde la base. Solo sale por el server action, que
  comprueba permisos y condiciones y **escribe la auditoría antes** de
  descifrarla. Nunca aparece en el listado ni en exportaciones.
- **Un comprobante, un pago.** Índices únicos GLOBALES (no por tienda) sobre el
  nº de operación y sobre el sha256 del archivo, más uno de un solo adelanto y
  una sola diferencia vivos por pedido. Un comprobante *rechazado* libera su
  sitio, porque pudo ser un error de carga. Una captura recortada del mismo
  comprobante se detecta por el **nº de operación**, que `lib/vision.ts` lee de
  la imagen (el hash perceptual queda fuera de alcance: exigiría decodificar
  imágenes en el servidor).
- **`pickup_key_views` es append-only**, como `order_events`: quién vio la clave,
  cuándo, y con qué pagos validados en ese momento. No se puede borrar.
- **Permisos** (`lib/permissions.ts`, con excepciones por usuario en
  `user_permissions`): `owner`/`admin` todo; `vendedora` registra comprobantes
  pero **no** los valida ni ve la clave; `viewer` nada. Mostrar la clave sin las
  validaciones completas es una excepción de administrador con motivo
  obligatorio, y queda marcada como tal en el historial.
- **Bucket privado `yape-vouchers`** para las imágenes, subidas por URL firmada
  (mismo patrón que los adjuntos de Leads).
- **Sin nº de operación no se puede validar un pago.** Es la regla que cierra el
  hueco de la captura recortada: el índice único no puede actuar sobre un nulo, así
  que un pago sin ese número queda en *información incompleta* y la acción de
  validar lo rechaza explicando qué falta. Desde el propio pago se completa a mano
  (botón *Completar datos*), y al escribirlo se vuelve a comprobar que ese número
  no pertenezca ya a otro pedido. Un intento de reutilizarlo queda en el historial.
- **Opcional**: con `ANTHROPIC_API_KEY` configurada, cada comprobante se pasa dos
  veces por visión: una para decidir si es un Yape real (el lector que ya usa la
  alerta de Leads) y otra para **transcribir** nº de operación, monto, fecha/hora y
  pagador. Lo que el operador dejó en blanco se rellena con esa lectura, así que en
  el caso normal nadie teclea el número. Si la imagen está recortada y el número no
  se ve, la transcripción devuelve null a propósito —nunca lo adivina— y el pago
  cae en el flujo de *Completar datos*. Si la imagen no parece un Yape, el pago
  queda como *información incompleta*: nunca se rechaza solo, y cargar una imagen
  jamás equivale a validar el pago.

## 5k. Costos

Sección propia (`/dashboard/costos`), no una pestaña de Ajustes: la
especificación anticipa que crecerá hacia algo financiero más amplio. Tres
pestañas: **costos logísticos** (por tienda, courier, región, provincia o
distrito; primer intento, intentos adicionales, envío por agencia, devolución y
especiales), **costos de producto** (unitario, por tienda, proveedor y lote) y
**costos adicionales** (empaque, materiales, preparación, comisiones).

- **Needs migration 0050** (`cost_tariffs`, `product_costs`, `additional_costs`).
  Antes de correrla la sección no carga y el Master deja el costo en blanco.
- **Todo lleva vigencia y nada se edita en su sitio.** Registrar una tarifa
  cierra la anterior (le pone fecha final) y abre otra desde el día indicado, de
  modo que un cambio de precio hoy **no** reescribe lo que costaron los pedidos
  de la semana pasada. El histórico se conserva y se ve en la tabla.
- **La tarifa más específica gana**: distrito &gt; provincia &gt; región &gt;
  courier &gt; tienda &gt; general. Permite una tarifa base de la organización y
  solo las excepciones encima. Los pesos están escogidos para que un acuerdo por
  distrito no lo supere ninguna combinación de criterios más gruesos.
- **El costo se congela en la fila del Master** durante el recálculo, no se
  resuelve al pintar: resolverlo en cada lectura haría que cambiar una tarifa
  moviera cifras históricas.
- **Un concepto sin tarifa configurada NO cuenta como cero**: se reporta como
  faltante y el Master muestra el costo en blanco. Un costo ausente y un costo de
  cero no son lo mismo.
- Un pedido **anulado** en Lima no genera costo de devolución (§9: allí no hay
  retorno físico); uno **devuelto** sí.
- **Escritura solo para administradores** de la organización (RLS, mismo patrón
  que `fenix_stock`), con el permiso `costs.manage`.

## 5k-bis. Liquidaciones de motorizados

Sección propia (`/dashboard/liquidaciones`). El motorizado entrega contra
reembolso y al final del día liquida: declara qué guías entregó, cuánta plata
cobró y deposita lo recaudado. La hoja llega **en foto de cuaderno o en
Excel/CSV**, y las dos entran por el mismo sitio.

- **Needs migration 0054** (`riders`, `rider_settlements`,
  `rider_settlement_lines`, más los conceptos `motorizado_*` en `cost_tariffs`).
  Antes de correrla la sección no carga.
- **La foto se transcribe con visión** (`lib/settlement-vision.ts`, misma clave
  por tienda que los comprobantes Yape). Lo que no se lee con claridad queda
  **en blanco, nunca en cero**: un monto inventado en una liquidación es plata
  inventada. Si la lectura falla, la carga se rechaza en vez de guardar una
  liquidación vacía dada por buena.
- **Dos niveles de lectura de hoja.** Adaptadores con nombre en
  `lib/settlements/` para los formatos conocidos, y un lector genérico por alias
  de cabecera (`lib/settlement-sheet.ts`) para todo lo demás — así se puede
  cargar la hoja de un coordinador nuevo sin escribir código. El formato se
  detecta por contenido; si nadie lo reconoce, se usa el genérico.
- **Axel Courier** (`lib/settlements/axel.ts`), Lima Metropolitana. Su reporte
  diario tiene cuatro rarezas que el adaptador conoce: su columna `CLIENTE` es
  la **tienda** (AURELA), no el cliente; **no trae guía ni nº de pedido**, así
  que se empareja por nombre y distrito; su `GANANCIA` es la **comisión que Axel
  se cobra** por entrega (S/ 10 en Lima, S/ 13 en Puente Piedra, S/ 18 en
  Cajamarquilla), y se la cobran incluso en algunas entregas fallidas
  (`CAIDA COBRO`, `RECHAZO`); y la hoja trae **varios bloques acumulativos** del
  mismo día, cada uno con su `TOTAL COBRADO`. Las filas de total, `RECAUDADO` y
  `COMISION` se descartan — colarlas duplicaría la plata del día — pero la
  comisión de POS sí se captura, porque también se descuenta del depósito.
- **El depósito esperado es lo cobrado MENOS la comisión.** Axel cobra
  S/ 2,219.73, se queda S/ 146.00 y deposita S/ 2,073.73. Sin restar la comisión
  el cuadre marcaría un faltante todos los días por el importe exacto de lo que
  legítimamente se quedan. Las comisiones de líneas sin vincular cuentan igual:
  el courier se las queda, y dejarlas fuera haría que el cuadre del depósito
  cambiara al vincular una línea.
- **Emparejar por nombre es el último recurso y es estricto**: solo vincula
  cuando queda UN candidato, acotado a los días alrededor de la liquidación, y
  desempatando por distrito. Tolera que el courier trunque el nombre a lo que
  cabe en la celda ("Ana María Cárd"). Dos homónimos sin distrito que los separe
  van a revisión — un nombre no es un identificador.
- **Lo declarado nunca pisa lo real.** El estado de la guía y el monto del
  pedido siguen viniendo del Master; el cuadre solo COMPARA y nombra la
  diferencia. Que la hoja diga "entregado" no marca el pedido como entregado.
- **Son dos cuadres, no uno**, y se muestran por separado: *¿lo declarado
  coincide con el Master?* y *¿depositó lo que él mismo declaró?*. Un motorizado
  puede declarar bien y depositar de menos, o al revés.
- **Lo que no se puede vincular no se adivina**: una línea sin guía reconocible
  queda en revisión y la resuelve una persona. Vincular mal mueve plata de un
  pedido a otro y el cuadre deja de significar nada.
- **El pago al motorizado usa el motor de Costos**, con sus mismas dos reglas
  (vigencia y especificidad): conceptos `motorizado_entrega`,
  `motorizado_visita` y `motorizado_devolucion`, que se configuran en
  `/dashboard/costos`. **Sin tarifa vigente ese día no se puede cerrar**: un
  concepto sin tarifa no cuenta como cero.
- **Descontar el faltante es opcional y explícito.** Por defecto NO se descuenta:
  que un faltante se cobre o se perdone es decisión de la empresa. Cuando se
  activa, el pago nunca baja de cero.
- **Cerrar es irreversible por diseño**: congela `payout_amount`. Si después
  cambia una tarifa o se corrige una guía, ese número no se reescribe — se abre
  una liquidación de ajuste. Cerrar con descuadre exige confirmación y queda
  anotado en la nota.
- **Permisos**: `settlements.manage` (cargar y corregir vínculos, lo tiene
  vendedora) y `settlements.close` (congelar el pago, solo admin/owner).
- Subir dos veces el mismo archivo **no duplica nada**: se corta por hash y
  devuelve la liquidación que ya existía.

## 5k-bis-2. Liquidaciones 2 (hojas por dominio)

`/dashboard/liquidaciones-2`. Hojas configurables sobre los pedidos, con
dominios (Pedidos, Catálogos, Reparto propio, Courier externo, Consolidado,
Indicadores), estados por dominio con equivalencia a los estados de Kapta,
historial por celda y observaciones de cuadre. Plan e iteraciones en
`docs/plan/liquidaciones-2.md`; reglas en el MOM §30.

1. **Migración `0184_liquidaciones2_hojas.sql`**, a mano, antes del código.
   Crea nueve tablas nuevas y no toca ninguna existente.
2. La primera visita de un admin/owner siembra la organización: dominios,
   estados, el catálogo de zonas (979 distritos del Excel) y una hoja de
   Pedidos y de Consolidado por tienda. Idempotente: el botón «Crear hojas que
   falten» repite lo mismo para una tienda conectada después.
3. **Permisos**: `sheets.edit` (vendedora, admin, owner) edita celdas y
   observaciones; `sheets.manage` (admin, owner) configura hojas, columnas,
   estados y alias.
4. Las hojas de Pedidos y Consolidado se leen con el service role de
   `order_master` (0053) filtrando por las tiendas accesibles; el resto de
   tablas tiene RLS propia.
5. **Reparto propio.** Una hoja por motorizado de `riders` más las históricas
   (Gera, Marcos). Importación desde la pantalla (`/api/sheets/import`, xlsx o
   csv en el formato de bloques del Excel, hasta 25 MB) o por script:
   `pnpm tsx scripts/import-reparto.ts <org_id> <dir> [Roy …]`, donde `<dir>`
   tiene un `matrix_<Hoja>.json` por hoja (volcado con openpyxl, porque el
   libro completo pesa 30 MB). Idempotente. La historia del Excel se cargó el
   16-09-2026.
6. **Courier externo con cuaderno.** Alexis y Urpi tienen hoja en el dominio
   Courier externo con `config.layout = "cuaderno"`: se importan igual que un
   motorizado (misma ruta y mismo script, claves `courier_alexis` y
   `courier_urpi`) pero con el vocabulario de estados del courier.

7. **Cierre por pedido** (MOM §30.8). Desde una hoja cuaderno, «Aplicar» por
   fila o «Aplicar entregas del periodo al Master» escribe `order_events`
   `status_override` con `source = liquidacion` y recalcula el Master, igual
   que Liquidaciones. Exige `master.edit`. Filas con observación abierta,
   pedidos anulados o ya entregados no se tocan. Sin camino de devolución.
8. **Observaciones automáticas** al importar y al editar: monto que difiere del
   total en más de S/ 0,50 y pedido anulado/devuelto en Kapta. Nunca dos
   abiertas por fila y campo. La causa «cobro digital sin comprobante validado»
   existió un día y se retiró (MOM §30.8); la **migración
   `0186_sheet_observation_reason_pago.sql`** deja su motivo en el catálogo.
9. **Foto del cuaderno**: `/api/sheets/import` acepta jpeg/png/webp/gif hasta
   8 MB y usa la misma visión que Liquidaciones (clave de la tienda o
   `ANTHROPIC_API_KEY`). Si la foto no trae fecha, la pantalla la pide.
10. **Pantalla del motorizado** (`/reparto/cuaderno`, MOM §30.9). Migración
   `0187_sheets_rider_rls.sql` a mano antes del código: acota la lectura de
   las tablas de hojas a la propia cuando el único rol es `motorizado`. Alta de
   un motorizado: ficha en Liquidaciones → Motorizados con su correo; invitación
   desde Equipo con rol `motorizado` (o membresía a mano); `riders.user_id`
   atado a ese usuario; y su hoja de Reparto propio creada con «Crear hojas que
   falten» en Liquidaciones 2 (la crea por ficha). Entra con Google o enlace por
   correo, igual que el equipo, **o con usuario y contraseña** (19-09-2026):
   para el motorizado sin correo se crea un usuario corto (`roy`, que Auth
   guarda como `roy@motorizados.kapta.local`) con
   `pnpm tsx scripts/rider-user.ts create <ficha> --usuario <u>`; ese comando
   hace también la membresía y el atado de la ficha. Alta, cambio de
   contraseña, baja y comprobación en
   [`docs/runbooks/motorizados-acceso.md`](docs/runbooks/motorizados-acceso.md).
   Requiere el proveedor Email activo en Supabase; no manda correos. Un
   usuario solo motorizado que abra `/dashboard` va a parar a su cuaderno. La foto del comprobante va al
   bucket privado `delivery-proofs`, ruta `cuaderno/<hoja>/<fila>/`.

11. **Convergencia con Rutas** (19-09-2026, MOM §29.12). **Migración
   `0180_stop_written_status.sql`** a mano antes del código: `delivery_stops`
   gana `written_status`, `written_status_code`, `written_payment`; `sheet_rows`
   gana `stop_id`. La parada es la verdad: la hoja de Reparto propio se
   sincroniza desde ella (al reportar, al cerrar ruta y al abrir la hoja del
   mes), las ediciones de la hoja se escriben primero en la parada por
   `lib/stop-report.ts`, y la única puerta al Master es `lib/master-door.ts`.
   La pantalla del motorizado es solo `/reparto` (`/reparto/cuaderno`
   redirige). Los límites de efectivo del proveedor ya rechazan asignaciones.
12. **Backfill de la historia a Rutas**: `pnpm tsx
   scripts/backfill-stops-from-sheets.ts <org_id> [--dry-run] [Roy …]` crea
   rutas cerradas y paradas desde las filas históricas con pedido de las hojas
   de Reparto propio (idempotente; no toca el Master). Corrido el 19-09-2026.

13. **Ponerse al día con el Master en bloque, y poder deshacerlo.** Migración
    `0181_master_backfill_log.sql` (bitácora). `pnpm tsx
    scripts/apply-cuaderno-history-to-master.ts <org_id> <actor_user_id>
    [--real]` aplica por la puerta única (`lib/master-door.ts`) las entregas
    del cuaderno que Kapta aún tiene abiertas en Lima: sin `--real` es un
    ensayo con conteo por hoja y mes. Con `--real` guarda antes, por pedido,
    el estado previo del Master y el evento insertado, e imprime un
    `batch_id`. `pnpm tsx scripts/rollback-master-backfill.ts <batch_id>
    --real` borra los eventos del lote, recalcula y marca `reverted_at`,
    avisando de los pedidos que no volvieron al estado previo porque otro
    evento posterior los movió. Mismas guardas que el botón de la pantalla:
    observación abierta, anulado en Shopify, parada no entregada. Fechas
    futuras del cuaderno se acotan a hoy. Primer lote corrido el 19-09-2026.

## 5k-quater. Despacho en dos pasos (Grupo GF Courier)

MOM §29.13; auditoría en `docs/plan/despacho-crm.md`.

1. **Migración `0182_manifest_item_not_picked.sql`**, a mano, antes del código:
   columnas `pickup_declined_*` en los ítems de la caja y el RPC
   `gf_rider_decline`. Smoke en `scripts/sql/gf_rider_decline_smoke.sql`.
2. Pestaña «Despacho del día» en `/dashboard/courier` (predeterminada), en
   **modo escaneo**: motorizado + día de la caja y un QR por paquete que toma,
   asigna y coteja en oficina de una vez (`scanAssignToRider`), con lista viva
   y bandeja «escanear primero». La lista con selección múltiple queda plegada.
   Cotejar por motorizado en la misma pantalla, con quitar y mover entre cajas
   (`moveManifestItem`, evento `dispatch_route_reassigned`). «Pedidos
   disponibles» y «Pedidos tomados» salen de la barra y quedan bajo «⋯ Más
   vistas» como vista anterior: Despacho trae teléfono y fecha en la fila,
   búsqueda por teléfono, «2.º intento», los excluidos con motivo («sin
   condiciones»), el picker de filtros, las tiles de métricas y los estados
   de cada paquete en Cajas de hoy (`loadCourierOperations` expone `blocked`).
3. `/reparto` abre en «Recibir mi caja» mientras haya una carga cotejada y no
   recibida; «No lo recojo» exige motivo. El bloque «Recibir mi carga» de la
   pantalla vieja desapareció.
3b. **Migración `0183_provider_rider_pickup_check.sql`**, a mano, antes del
   código: flag `logistics_providers.rider_pickup_check_required`, RPC
   `gf_assign_custody` y guard de ítems relajado para el cotejo opcional. Con
   el flag en `false` (valor de producción desde el 19-09-2026, pedido por la
   operación) basta con asignar: la custodia pasa al motorizado en el acto y
   `/reparto` muestra la ruta; «Recibir mi caja» no aparece. Para volver a
   exigir la verificación:
   (hoy el modo `exigir`, ver 3c).
   **Migración `0184_gf_one_load_per_day.sql`** (a mano, antes del código):
   con el flag apagado hay una sola carga por motorizado y día; las
   asignaciones posteriores se suman a ella ya en custodia
   (`gf_dispatch_load_open`, `gf_add_item_in_custody`). Smoke:
   `scripts/sql/gf_one_load_smoke.sql`.
   Se lee en un solo sitio (`riderPickupMode`,
   `lib/grupo-gf-courier-route-access.ts`); la cabecera de «Despacho del día»
   lo muestra. Smoke: `scripts/sql/gf_assign_custody_smoke.sql`.
3c. **Migración `0185_provider_rider_pickup_mode.sql`**, a mano, antes del
   código: reemplaza el booleano por `logistics_providers.rider_pickup_mode`
   (`exigir` | `confirmar` | `ninguno`; migra `true`→`exigir`,
   `false`→`ninguno`), añade `delivery_stops.pickup_confirmed`, los RPC
   `gf_rider_confirm_pickup`, `gf_supervisor_withdraw` y
   `gf_withdraw_in_custody`, y redefine `gf_assign_custody`,
   `gf_dispatch_load_open`, `gf_add_item_in_custody`, `gf_rider_decline` y el
   guard de ítems para los tres modos. **Producción quedó en `confirmar`**
   (19-09-2026, decisión de la operación) con un UPDATE aparte tras la
   migración. Cambiar de modo no requiere desplegar:
   `update logistics_providers set rider_pickup_mode = 'exigir'    where code = 'grupo-gf-courier';`
   `update logistics_providers set rider_pickup_mode = 'confirmar' where code = 'grupo-gf-courier';`
   `update logistics_providers set rider_pickup_mode = 'ninguno'   where code = 'grupo-gf-courier';`
   En `confirmar`, `/reparto` muestra cada parada «Por confirmar» con «Lo
   llevo» / «No lo llevo» y «Confirmar todos» en la cabecera; «Despacho del
   día» muestra confirmados/asignados y «Sin confirmar por Roy · N» con
   quitar/mover. Smoke: `scripts/sql/gf_pickup_mode_smoke.sql`.
4. `components/scan-action.tsx` es el único gesto de escaneo/foto; la mesa de
   despacho (`DispatchWorkspace`) y la estación de almacén conservan su escáner
   propio por ahora.
5. «Actividad» del Master etiqueta los hitos del despacho; `?abrir=<pedido>&seccion=historial`
   abre el drawer en esa pestaña.

## 5k-ter. Rutas de reparto (motorizados propios)

Sección propia (`/dashboard/rutas`) para el coordinador y una pantalla aparte
(`/reparto`) para el motorizado, pensada para un teléfono con una mano y mala
señal. Invierte la dirección del módulo anterior: en vez de RECONSTRUIR el día
leyendo una hoja, la entrega se DECLARA en el momento y la liquidación cae sola
al cerrar. La carga por foto/Excel sigue viva para los couriers externos.

- **Needs migration 0056** (`delivery_routes`, `delivery_stops`,
  `delivery_stop_events`, rol `motorizado`, `riders.user_id`).
- **El motorizado es un usuario de verdad**, con el mismo correo y enlace mágico
  que el equipo. No hay una segunda autenticación casera que mantener. Se le da
  acceso con un botón desde Rutas, que crea el usuario, lo hace `motorizado` de
  la organización y lo ata a su ficha — en un solo paso, para que no quede
  nunca un usuario sin ficha entrando a una pantalla vacía.
- **Solo ve sus paradas, y lo garantiza la base.** Las políticas filtran por
  `riders.user_id = auth.uid()`; no existe una consulta que le devuelva la ruta
  de otro, aunque alguien manipule la petición. Y solo ve la ruta cuando ya se
  le entregó: una que se está armando no le aparece a medio hacer.
- **Tres estados con una razón cada uno**: `planificada` (no la ve; se añaden y
  quitan paradas), `en_curso` (está en su teléfono; lo reportado ya no se
  borra), `cerrada` (generó su liquidación).
- **Lo que reporta es una declaración, no la verdad.** Escribe en la parada, NO
  en el Master: que marque "entregado" no cierra el pedido. El cuadre compara
  ambas versiones, igual que con la hoja de un courier.
- **Validación compartida.** `validateStopReport` corre en el móvil (aviso
  inmediato, sin gastarle datos) y en el servidor (la que manda). Una entrega
  exige método de cobro, monto y foto; cobrar por Yape exige la captura; una no
  entrega exige motivo del catálogo; y declarar dinero en una no-entrega se
  rechaza por contradictorio.
- **Una parada reportada se corrige, no se reescribe**: cada reporte deja su
  rastro en `delivery_stop_events`, con autor y hora. Es dinero.
- **Cerrar la ruta crea la liquidación** con las líneas YA vinculadas a su
  pedido — sin cola de revisión, porque no hay que adivinar de quién es cada
  fila. El efectivo declarado sale de lo que reportó cobrar; si al contar el
  dinero sale otra cosa, esa diferencia es justo lo que el cuadre del depósito
  enseña. El POS no cuenta como plata a depositar: lo cobra el terminal.
- **El pago usa el motor de Costos.** Una tarifa plana de S/ 8.50 es una tarifa
  `motorizado_entrega` sin ámbito: se configura una vez, lleva vigencia, y si
  sube no reescribe lo que se pagó antes. Las visitas fallidas se pagan solo si
  hay tarifa `motorizado_visita` configurada — no tenerla es una postura válida.
- **Fotos en bucket privado** (`delivery-proofs`), subidas aparte del reporte
  para que una caída de red no le borre el formulario.
- **Needs migration 0057** además de la 0056. Corrige dos cosas que solo se ven
  al contrastar el diseño con cómo se reparte de verdad:
  - **La ruta es del motorizado y del día, no de la tienda.** Sale con paquetes
    de Aurela y de Kenku en la misma vuelta; con una ruta por tienda vería dos
    listas para un solo viaje. La tienda vive en cada parada
    (`delivery_stops.store_id`, que viene del pedido) y **cerrar una ruta mixta
    produce una liquidación por cada tienda**, porque el dinero se cuadra por
    separado. Un viaje, varias cuentas.
  - **Cerrar la ruta mueve el Master.** Con un courier externo el estado real lo
    trae su reporte; con motorizado propio no viene nadie detrás, así que sin
    esto un pedido entregado se quedaba "pendiente" para siempre y el cuadre lo
    marcaba como *cobro sin entrega* en TODAS sus paradas. Al cerrar, las
    entregas pasan a `entregado` por el camino de siempre (`order_events` +
    recálculo), con un humano revisando antes de que sea oficial.
- **Qué pasa con lo no entregado, según el motivo.** Solo `rechazado` cierra el
  pedido (a `anulado`): el cliente lo vio y no lo quiso. Los demás motivos
  —no contesta, no estaba, reprogramado, sin dinero, dirección errada— **no
  tocan el pedido**, que sigue vivo para reintentarlo otro día. Cerrar un pedido
  por error cuesta una venta; dejarlo abierto solo cuesta otra visita.
- **Los pedidos ya asignados no reaparecen**: al armar una ruta se excluyen los
  que ya van en la de otro motorizado ese día, mirando TODAS las rutas del día
  y no solo las de una tienda — si no, dos saldrían con el mismo paquete.

## 5k-quater. Reintentos y tasa de entrega

Lo que ataca el dolor real: los pedidos que no llegan a entregarse. Vive dentro
de `/dashboard/rutas`, al armar la ruta del día.

- **Needs migration 0058** (`rider_settlements.direct_collected`).
- **Trae los no entregados solo.** Un pedido que ayer no contestó aparece como
  candidato a reintento, con cuántas veces falló y por qué la última. Sin esto
  se queda esperando a que alguien se acuerde, y nadie se acuerda.
- **Dos preguntas distintas, y confundirlas sale caro** (`lib/retries.ts`):
  *¿este pedido merece otra visita?* (depende del motivo) y *¿este cliente
  recibe alguna vez?* (se mide por teléfono, a través de TODOS sus pedidos).
- **Lo que NO se reintenta tal cual**: `direccion_errada` (volver al mismo sitio
  equivocado cuesta otro flete y falla igual — hay que corregir la dirección
  antes) y `rechazado` (no es un reintento, es una venta perdida).
- **Riesgo alto** a los 3 intentos, o cuando el cliente acumula 2+ pedidos y
  **ninguno** llegó a entregarse. Un cliente que sí recibió alguna vez **nunca**
  sube a riesgo alto por su historial: sabemos que la dirección existe y que
  abre la puerta, así que bloquearlo costaría una venta buena.
- **Marca, ordena y avisa; no decide.** Lo bloqueado sale arriba, luego el
  riesgo alto, y "Traer los N sin pendientes" añade de golpe solo los limpios.
  Despachar lo marcado siempre es una decisión de una persona.
- **La liquidación de un courier también mueve el Master** (botón "Aplicar al
  Master"). Sin esto las entregas de Axel — todo Lima Metropolitana — se
  quedaban en "pendiente" para siempre y el cuadre las marcaba como *cobro sin
  entrega*. Solo `EFECTIVO`/`PAGO POS` marcan entregado y `RECHAZO` anula; lo
  demás deja el pedido vivo. No reescribe lo que el Master ya sabe.
- **El Yape y el POS del cliente NO son deuda del motorizado.** Caen a la cuenta
  de la empresa y nunca pasan por sus manos. Se guardan aparte
  (`direct_collected`) y se descuentan de lo que debe depositar; contarlos le
  habría sacado un faltante inventado todos los días, por el importe exacto de
  lo que cobró por esos canales.

## 5l. Clave de Anthropic por tienda

La lectura de comprobantes Yape usaba una única `ANTHROPIC_API_KEY` de entorno, así
que el gasto de las dos tiendas caía en la misma cuenta. Ahora **cada tienda tiene
su propia clave** y paga lo suyo.

- **Needs migration 0052** (`stores.anthropic_api_key_enc`, `stores.anthropic_model`).
- Se configura en **Ajustes de la tienda → Lectura de comprobantes Yape**. La clave
  se guarda **cifrada** (AES-256-GCM, misma `ENCRYPTION_KEY` que el resto de
  secretos) y en blanco significa "no la cambies", como los demás secretos.
- El **modelo también es por tienda**: se puede abaratar una sin tocar la otra ni
  redesplegar.
- `ANTHROPIC_API_KEY` del entorno **sigue funcionando como respaldo** para las
  tiendas sin clave propia, así que nada deja de funcionar al aplicar la migración.
- Afecta a los dos usos de visión: la alerta de *Yape/Shalom por verificar* en Leads
  y la transcripción del comprobante en el Master.
- Sin clave (ni de tienda ni de entorno) la detección se queda solo en el texto del
  mensaje y el equipo escribe a mano el nº de operación — que sigue siendo
  obligatorio para poder validar un pago.

## 5m. Privilegios por defecto de Supabase (corrección)

**Needs migration 0053.** Es obligatoria si se aplicó cualquiera de la 0045 a la
0052; no toca datos y es idempotente.

Supabase deja configurado en el esquema `public`:

```sql
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
```

Es decir, **cada tabla nueva nace con todos los privilegios** para los tres
roles, así que un `grant select, insert ... to service_role` no resta nada: solo
añade sobre un permiso que ya era total. Dos cosas que las migraciones nuevas
documentaban no eran ciertas hasta la 0053:

- `order_events` y `pickup_key_views` se declaran **append-only**, pero
  conservaban UPDATE/DELETE por privilegio. El trigger `reject_mutation` sí los
  bloqueaba —la inmutabilidad nunca estuvo rota— pero la segunda cerradura, la
  que el propio comentario de la migración prometía, no existía.
- `shalom_pickup_keys` se declara ilegible. RLS activo **sin** policy ya deniega
  a `authenticated`, así que la clave tampoco estuvo expuesta; pero el privilegio
  de SELECT seguía concedido, o sea a una policy de distancia de exponerla.

La 0053 hace `revoke all` sobre las tablas sensibles y vuelve a conceder solo lo
necesario. Comprobación en producción (debe dar 0):

```sql
select count(*) from information_schema.role_table_grants
 where table_schema = 'public'
   and ((table_name in ('order_events','pickup_key_views')
         and grantee in ('anon','authenticated','service_role')
         and privilege_type in ('UPDATE','DELETE','TRUNCATE'))
     or (table_name = 'shalom_pickup_keys'
         and grantee in ('anon','authenticated')));
```

`postgres` (dueño de las tablas) conserva todo y eso es normal: no es un rol al
que se llegue desde la API.

**Por qué no lo detectaron las pruebas.** El Postgres desechable de
`scripts/verify-db.sh` no traía las *default privileges* de Supabase, así que la
aserción pasaba en CI y fallaba en producción. `scripts/sql/test_prelude.sql`
ahora las replica, y `append_only_smoke.sql` comprueba los privilegios además de
los triggers — se verificó quitando la 0053 a propósito y confirmando que el
smoke falla. **Cualquier tabla nueva en `public` debe revocar explícitamente lo
que no quiera conceder.**

## 5n. Tanders — crear guías desde el Master

Tanders es un courier de Lima que **convive** con Aliclik, Shalom y Olva; no los
reemplaza. La diferencia es la dirección del flujo: los otros entran por reporte
(un Excel que se sube), Tanders **sale** — se le crea el pedido por API desde el
drawer del Master y devuelve el código de guía.

- **Needs migration 0058** (`stores.tanders_*`, `shipments.label_url`,
  `shipments.tanders_raw`) y **0062** (`shipments.tanders_order_id`).
- **El código de guía es el N° de seguimiento, no el id de su API.** Tanders
  devuelve dos identificadores y solo uno sirve para buscar: `id` es un cuid
  interno que no aparece en ninguna pantalla suya, y `aliclikOrderNumber`
  ("TANDER1785…") es lo que su panel muestra como *N° SEGUIMIENTO*. El segundo va
  en `guide_code`; el cuid, en `tanders_order_id`, porque es la clave de su API.
- El nombre del campo no es casualidad: **Tanders sincroniza cada pedido hacia
  Aliclik** (`aliclikSyncStatus: "SYNCED"`) y adopta el número que este genera.
  La reconciliación de guías Aliclik está acotada a `created_via = 'aliclik_api'`,
  así que no toca las guías Tanders — pero si esos envíos aparecieran en los
  reportes de Aliclik de la tienda, la ingesta crearía una **segunda fila** para
  el mismo paquete. Conviene comprobarlo tras la primera importación.
- Se configura en **Ajustes de la tienda → Tanders**: usuario, contraseña y el
  almacén de origen (dirección + latitud + longitud). Tanders **no emite API
  keys**, así que se usa la misma cuenta de su web; la contraseña se guarda
  cifrada (AES-256-GCM) como el resto de secretos.
- **Autenticación**: `POST /auth/login` en cada uso. Su access token dura 15
  minutos, así que cachear un refresh token de 7 días no compensa el estado que
  habría que persistir y rotar.
- **Caja XXS y 100 g fijos**, por decisión de la operación: el catálogo no tiene
  pesos por producto, así que cualquier cálculo sería inventado.
- **El punto del mapa es obligatorio y no se resuelve solo.** Tanders no acepta
  una dirección de texto y Shopify no entrega coordenadas. Si el pedido ya tiene
  un punto (corrección manual de la 0051 o reporte de courier) se pre-llena; si
  no, el operador pega el enlace de Google Maps y el modal muestra el enlace al
  punto elegido para verificarlo **antes** de despachar. Esto evita depender de
  una API key de Google facturada.
- **La nota lleva la referencia Y la nota del pedido de Shopify**, en ese orden.
  Son dos campos distintos: la referencia viene del formulario COD ("entre tal y
  tal avenida") y la nota del pedido es donde el equipo apunta a mano lo que
  averiguó al llamar —el enlace de Google Maps del cliente, un horario, una
  advertencia—. Se pide **en vivo** a Shopify al abrir el modal, porque es un
  campo que un humano edita segundos antes de despachar; la copia sincronizada
  queda de respaldo si Shopify no responde. Si una repite a la otra se manda una
  sola vez.
- La consulta GraphQL de pedidos **no pedía `note`**, así que ese campo no
  existía en `orders.raw` para ningún pedido. Ahora se pide, y los pedidos van
  incorporándolo a medida que se sincronizan.
- **El monto a cobrar sale en 0** cuando el pedido ya está pagado
  (`payment_state = 'pago_completo'`): mandar el total haría que el repartidor le
  cobre al cliente algo que ya pagó.
- **Sin reintentos automáticos** salvo un 401. Un timeout o un 500 puede haber
  creado la guía igual; reintentar a ciegas despacharía dos veces el mismo
  paquete. El mensaje de error pide verificar en tanders.app antes de reintentar.
- Si Tanders crea la guía pero falla el insert local, el error **incluye el
  código** para registrarla a mano: la guía existe y perderla de vista es peor.
- **El rótulo lo componemos nosotros.** Tanders NO tiene endpoint de PDF: su
  panel arma el rótulo en el navegador y lo descarga. Su API solo ofrece
  `GET /external/generate-qr?text=…` (otro host, sin auth) y
  `PATCH /orders/me/{id}/label {generated:true}`, que enciende el "✓ Rótulo
  generado" de su interfaz. La página `/dashboard/pedidos/rotulos?ids=a,b,c`
  arma los rótulos —una hoja por envío, Ctrl+P para PDF— con el QR generado en
  local (el QR codifica literalmente el N° de seguimiento, así que no hace falta
  su endpoint) y los datos de `tanders_raw`, que es lo que Tanders tiene de
  verdad. **Needs migration 0063** (`shipments.label_generated_at`).
- Al abrir el rótulo se llama a su `PATCH` para que su panel quede marcado: es el
  único guardarraíl contra imprimir dos etiquetas del mismo paquete, y solo sirve
  si los dos sistemas coinciden. Es best-effort — si su API falla, el rótulo se
  imprime igual y el aviso dice qué guías quedaron sin marcar allá.
- **La etiqueta PDF no viene al crear**: `labelGeneratedAt` llega en null porque
  el pedido nace PENDING y el PDF se genera después. Se descarga desde
  tanders.app.
- **Saldo insuficiente**: según la operación, Tanders no deja registrar. Se
  traduce a un mensaje explícito para el 402/403.

## 5ñ. Leads — que la cola cargue rápido

El panel de Leads se sentía lento sin que ninguna consulta fuera lenta por sí
sola: era el goteo. Cada carga —y cada refresco en vivo, que iba cada 30 s por
cada asesora con la pestaña abierta— lanzaba siete `count(*)` exactos sobre
`leads` más el recorrido completo de la cola, y el navegador volvía a montar las
miles de filas enteras.

- **Needs migration 0059** (`lead_queue_counts` + tres índices sobre `leads`).
  Es aditiva: no toca datos y los índices tardan milisegundos a este tamaño de
  tabla. **La app funciona sin ella**: si la función no existe, los contadores
  caen solos al camino anterior (los siete conteos) — solo se pierde la mejora,
  no la pestaña. Aplicarla igualmente, que es de donde sale la mayor parte del
  ahorro.
- **El refresco en vivo ya no recarga a ciegas.** Pregunta primero por la firma
  de la cola (`total` + `last_change`) y solo recarga si cambió. Con la cola
  quieta, una pestaña abierta pasa de recargar 120 veces por hora a ninguna, y
  aun así se refresca sola cada 5 minutos como red de seguridad.
- **La lista se pinta por tramos** (60 filas y más al bajar). Los contadores, el
  gráfico y la exportación de audiencia siguen calculándose sobre el universo
  completo: lo que cambia es cuántas filas existen en el DOM, no los números.
- **Verificación**: `bash scripts/verify-db.sh` compara la función con los siete
  filtros originales uno a uno (`scripts/sql/lead_queue_counts_smoke.sql`). Si
  alguna pestaña mostrara un número que no cuadra con su lista, esa prueba es lo
  primero que hay que mirar.

## 5o. Shalom por API — crear preguías desde el Master

Shalom ya estaba en el sistema, pero **solo de entrada**: su reporte Excel se
sube y lo parsea el adaptador de agencia (`lib/couriers/agency.ts`). Esto abre la
dirección contraria — crear la preguía por API antes de que exista ningún
reporte — a través del wrapper **api.shalom-api-peru.com**, que automatiza
`pro.shalom.pe`.

Los dos caminos **conviven**: la guía creada acá vive en `shipments` con
`courier='shalom'` y `guide_code` = la `guia`, así que el reporte del día
siguiente cruza con ella por número de guía como con cualquier otro envío. No
hay que dejar de subir el Excel.

- **Needs migration 0061** (`stores.shalom_*`, `shipments.shalom_codigo` /
  `shalom_ose_id` / `shalom_order_id` / `shalom_serie` / `shalom_raw`).
  **Ya aplicada en producción**, cuando el fichero se llamaba `0059`: nació en
  paralelo a la 0059 de Leads y se renumeró al mergear, porque dos migraciones
  no pueden compartir número. No hay que volver a aplicarla, y si se aplica no
  pasa nada — es `add column if not exists` de principio a fin. Al ser puramente
  aditiva se pudo aplicar antes de desplegar el código: las columnas quedan sin
  que nadie las lea.
- Los dos secretos nuevos de `stores` heredan la postura del resto de esa tabla
  (`shopify_token_enc`, `kapso_api_key_enc`, `tanders_password_enc`…): `anon` no
  llega por RLS, y un usuario autenticado con acceso a la tienda ve el **texto
  cifrado**, inútil sin `ENCRYPTION_KEY`, que solo existe en el servidor. La
  clave de recojo NO va ahí: vive en `shalom_pickup_keys`, que es ilegible
  incluso para un administrador (0049 + 0053).
- Permiso propio **`shalom.create_guide`**. Ojo con la vecindad: los otros
  `shalom.*` son del flujo de cobro Yape y de la clave de recojo. Crear la guía
  **no** da acceso a ver claves.

### Dos credenciales, en dos sitios distintos

1. La **API key del wrapper** (`sk_…`) es de la cuenta de **Kapso**, no del
   cliente: **una sola sirve para todas las tiendas**. Va en el entorno como
   `SHALOM_API_KEY` (`SHALOM_API_BASE` para el host). Se pide por WhatsApp al
   proveedor (948 997 674) y **vence**: cuando caduque, todas las tiendas dejan
   de poder crear guías a la vez y renovarla es cambiar solo esa variable, sin
   tocar la configuración de ninguna tienda. Sin ella el botón «+ Guía Shalom»
   simplemente no aparece.
2. El **email + password de `pro.shalom.pe`** identifican la cuenta que emite la
   guía ⇒ van **por tienda**, en Ajustes de la tienda, con la contraseña cifrada
   AES-256-GCM. **Pueden repetirse entre tiendas**: dos tiendas de la misma
   empresa suelen despachar con la misma cuenta de Shalom.

Además, por tienda: la **agencia de origen** (`origin_terminal_id`, de
`GET /v1/agencies`) y opcionalmente el **producto por defecto**. El catálogo de
productos es por cuenta, así que el id no es universal — el modal lista los
reales.

Los mensajes de error distinguen de quién es el problema: falta `SHALOM_API_KEY`
(del servidor) es distinto de falta la cuenta de Shalom Pro (de la tienda).

### La primera llamada tarda ~90 segundos

El wrapper hace un login real contra el panel de Shalom la primera vez de cada
cuenta: entre 90 s y 2 min. Por eso:

- El token `ssk_…` (TTL **2 horas**) se **cachea cifrado en la tienda**
  (`shalom_session_token_enc`). En serverless la memoria del proceso no
  sobrevive entre invocaciones, así que un caché en módulo no serviría de nada.
- **El token es de la cuenta, no de la tienda.** Cuando varias tiendas de la
  misma organización comparten la cuenta de Shalom Pro, el login se paga **una
  sola vez**: al conectar se reutiliza el token fresco de una tienda hermana si
  existe, y el token recién emitido se guarda en todas las que usan ese mismo
  email. Acotado a la misma `org_id` — el email ya prueba que es la misma cuenta,
  pero no hay razón para que un token cruce una frontera de organización.
- Conectar es un **paso explícito del modal** («Conectar con Shalom»), con su
  aviso de que puede tardar 2 minutos. Es una *lectura*: se puede reintentar sin
  riesgo. La segunda guía del día ya no lo paga.
- `app/dashboard/pedidos/page.tsx` declara **`maxDuration = 300`**; con el
  límite por defecto esa llamada se cortaría sola.
- Cambiar el email o la contraseña en Ajustes **invalida el token cacheado** en
  el acto, en vez de esperar a que la próxima guía falle con un 401.

### Crear la orden no es idempotente — y eso manda sobre el diseño

`POST /v1/orders` crea una guía **real y cobrable**, no hay sandbox y no hay
clave de idempotencia. En consecuencia:

- **Cero reintentos automáticos**, ni siquiera con un 401 — a diferencia del
  cliente de Tanders. Si el primer POST llegó, el segundo emite una segunda
  guía cobrable.
- Ante un corte se **verifica en lugar de reintentar**: se listan las órdenes
  recientes (`GET /v1/orders`) y se busca la guía por **documento del
  destinatario + clave de recojo**. Si aparece exactamente una, se adopta y el
  aviso dice que se recuperó. Si hay dos coincidencias no se adopta ninguna:
  adoptar la equivocada es peor que pedir que un humano mire.
- Si no se puede verificar, el mensaje es explícito: revisar en `pro.shalom.pe`
  **antes** de reintentar.
- Si Shalom crea la guía pero falla el insert local, el error **incluye guía y
  código** para registrarla a mano.
- Si la guía se creó por error, se borra con `DELETE /v1/orders/{id}` mientras no
  haya sido recibida en agencia. Ese `{id}` es el de `GET /v1/orders`, **no** el
  `ose_id` ni la `guia` (por eso hay tres columnas y no una).

### De qué vía nació cada salida — **needs migration 0108**

`shipments.created_via` distingue las dos vías del drawer: `shalom_pro_api` (la
guía la emite la integración, el caso normal) y `shalom_pro_manual` (ya existía
en `pro.shalom.pe` y se copió a mano). Los valores viven en `lib/shalom/origin.ts`
y ningún insert debe escribirlos sueltos: `test/shalom-origin.test.ts` exige que
**toda** inserción de salida de ese fichero declare su origen.

Hizo falta porque durante las primeras 185 guías solo la vía de contingencia
marcaba la columna y la vía normal no, así que `created_via` quedaba nulo — el
mismo valor que una guía importada del reporte. Mirando la columna parecía que el
drawer no se había usado nunca, cuando en realidad lo habían usado cuatro
personas. La 0108 rellena esas filas y **no adivina**: solo toca las que tienen
`shalom_ose_id` (identificador que devuelve la API al crear y que el reporte
Excel no trae) y `shalom_raw` sin la clave `source`. Es idempotente.

### Los estados: `/api/cron/shalom-reconcile`, cada 30 min

Shalom **no tiene webhook**, y la vía de entrada por reporte Excel —que existe y
funciona— **nunca se usó para Shalom en esta operación**: se comprobó en la base,
0 guías de Shalom ingeridas por reporte frente a ~3.000 de Aliclik. Sin nada que
las alimentara, las guías creadas por API se quedaban congeladas en el estado con
el que nacían, y el Master decía «pendiente» para siempre — que no es un dato
sino un vacío disfrazado.

Lo que lo hace barato es que **el «modo estado» del rastreo se contenta con la
API key global**: no pide credenciales de Shalom Pro, así que no hay login de
~90 s, no hay sesión que renovar y **una sola llamada cubre guías de cualquier
tienda a la vez**. Y `POST /v1/tracking/batch` acepta 50 guías por request con un
`custom_id` que devuelve verbatim, así que se manda el id del envío y el
resultado se correlaciona sin adivinar.

El mapeo de los siete hitos vive en `lib/shalom/tracking.ts`, puro y testeado.
**Gana el hito más avanzado**, no el último que traiga fecha: un envío entregado
sigue trayendo `registrado`, así que leerlos como banderas sueltas daría el
estado más atrasado. Dos decisiones que no son obvias:

- **`destino` no es entregado.** Llegar a la agencia de destino deja la guía
  `disponible_para_recojo` y **viva** (`pendiente`): el paquete espera al
  cliente. Es el mismo criterio que ya usaba el adaptador de reportes.
- **`reparto` gana a `destino`**, porque solo puede ocurrir después. En una
  entrega en agencia es `null` para siempre.

Solo se escribe cuando el estado cambia de verdad. Sin esa comparación, cada
pasada tocaría cada fila, ensuciaría el `updated_at` que el Master usa para
ordenar por movimiento y llenaría la línea de tiempo de eventos idénticos.

Las guías terminales dejan de consultarse, y el techo por pasada son 20 batches
(1.000 guías) para no comerse el cupo de 60 req/min, que es **compartido entre
todas las tiendas**.

> `GET /v1/tracking` también tiene modo detallado con `order`, pero sus bloques
> `origen`, `destino`, `remitente`, `destinatario` y `comprobante` llegan vacíos
> desde julio de 2026 — lo avisa el propio proveedor. No se pide: el estado sale
> entero de `status`.

### Los estados de Olva: `/api/cron/olva-reconcile`, cada 30 min

Olva **no tiene API para clientes**. Lo que existe es la llamada que hace su
página pública de seguimiento —un `GET` a
`reports.olvaexpress.pe/webservice/rest/getTrackingInformation?tracking=…&emision=…&apikey=…&details=1`—
con una apikey fija que la página publica en su JavaScript. `lib/olva/client.ts`
repite exactamente esa llamada, con `Origin` y `Referer` de la página. La apikey
va en `OLVA_TRACKING_APIKEY`; se captura desde DevTools → Red al consultar
cualquier tracking en `tracking.olvaexpress.pe` (la petición
`getTrackingInformation`, la de ~1,5 kB; la otra, `searchInfo`, no trae el
historial).

**Qué pasa cuando Olva la rote.** El cron empieza a recibir 401/403 —o un HTML
en vez de JSON— y lo trata como «Olva cambió algo»: cuenta el fallo en
`errors`, **no toca ningún estado** y el marcado a mano del drawer sigue
mandando. Se captura la apikey nueva, se cambia la variable, y listo: no hay
código que tocar.

Solo entran las salidas de Olva **con tracking registrado** (columna
`olva_tracking`, 0174): el número se pega en el drawer, en la salida, desde
**Salidas y guías**. El mapeo de estados vive en `lib/olva/tracking.ts`, puro y
probado con dos respuestas reales; **manda el estado que Olva declara vigente**
(`nombre_estado_tracking`), no el hito más avanzado — en un envío real, un
operador fue asignado antes de que el paquete se confirmara en la tienda de
destino, y la escalera habría tapado tres días de mostrador. Un estado que Kapta
no conoce se guarda crudo y sale en el informe como `estadosSinTraducir`, con un
tracking de muestra para ir a mirarlo: es la lista de lo que hay que añadir al
traductor.

`CONFIRMACION EN TIENDA` fija `agency_arrived_at` y `agency_expires_at` a
**6 días** (Olva devuelve a los 6, Shalom a los 28), con lo que «Próximo a
vencer» funciona igual que para Shalom.

### Anular una guía

Crear emite una guía real y cobrable de un clic, así que deshacerlo no puede ser
otro clic a su lado. El botón **Anular**, junto a la guía en el drawer, va en dos
pasos: el primero cambia el botón por una pregunta con el número de guía delante,
y solo el segundo llama a Shalom.

Solo aparece mientras Shalom todavía deja borrar — guía creada por API,
`delivery_status = pendiente` y el paquete aún en `pendiente_de_envio`. En cuanto
llegó a la agencia, el botón desaparece: a partir de ahí se gestiona allá. Esa
comprobación es cortesía de interfaz y **el servidor la revalida entera**, porque
un botón que no se pinta no es una autorización.

Tres detalles que importan:

- El `{id}` del borrado es el de `GET /v1/orders` (`shalom_order_id`), **no** el
  `ose_id` ni la guía. Es el motivo de que haya tres columnas y no una.
- Anular **sí** renueva la sesión y reintenta, a diferencia de crear: borrar es
  idempotente, y un segundo `POST /v1/orders` sería una segunda guía cobrable.
- Se marca anulada acá **después** de que Shalom confirme. Al revés dejaría una
  guía viva en Shalom y anulada en el panel, que es la peor de las dos mentiras.
  Si Shalom borra y el update local falla, el error lleva la guía para corregirlo
  a mano.

### El rótulo y el código corto

Shalom identifica cada envío con **dos** cosas, y su panel muestra las dos: el
número de orden (`89861708`, que es lo que guardamos como `guide_code`) y un
**código corto** (`77PH`). Con solo el número largo hay que abrir cada envío en
`pro.shalom.pe` para saber cuál es cuál, así que el corto (`shalom_codigo`) se
arrastra hasta el drawer y se muestra al lado.

El **rótulo** se sirve desde el propio panel: `/api/shalom/label/{shipmentId}`
pide el PDF a Shalom y lo devuelve, así que se imprime sin entrar a su web. La
ruta autoriza por RLS —solo lo ve quien ya puede ver ese envío— y es una lectura,
así que renueva la sesión y reintenta sola si el token murió.

Ojo: **solo las guías creadas por API tienen rótulo aquí.** Las que llegaron por
el reporte Excel no tienen `shalom_ose_id` —nacieron en el panel de Shalom— y su
rótulo hay que bajarlo de allá. El enlace no aparece para esas, y si alguien
llega a la ruta a mano, responde diciendo exactamente eso.

### La clave de recojo nace con la guía

`pickup_code` lo elegimos nosotros, así que la clave **se genera en el servidor**
y se guarda cifrada en `shalom_pickup_keys` (0049) — la misma tabla que antes
llenaba un administrador copiándola del panel de Shalom. El circuito de Yape →
validación → revelar la clave **no cambia**: sigue siendo la única vía de verla y
sigue auditado.

- La clave **no viaja al cliente** ni aparece en la línea de tiempo del pedido,
  salvo para un rol que ya tiene `shalom.view_pickup_key`.
- Se evitan las claves que Shalom rechaza (4 dígitos iguales, escaleras
  ascendentes) y, al generar, también las descendentes.

### El documento del destinatario es manual

Shalom identifica al destinatario por DNI/RUC/CE y **Shopify no lo pide**: es el
único dato que el operador escribe siempre. `GET /v1/persons/search` autocompleta
nombre, apellidos y teléfono si el cliente ya envió antes por Shalom. Los
apellidos se sugieren partiendo el nombre del pedido por la convención peruana
(los dos últimos tokens), pero quedan editables porque falla con apellidos
compuestos.

### Probar la conexión

La forma normal es el botón **Probar conexión** en *Ajustes de la tienda →
Shalom · crear preguías por API*. Corre en el servidor, es solo lectura y prueba
las dos mitades por separado, que es lo que importa porque las arregla gente
distinta:

1. La **API key global** contra el directorio de agencias, que no toca la cuenta
   de nadie. Si falla, el problema es del despliegue.
2. La **cuenta de Shalom Pro de la tienda**, pidiendo el token. Es la parte lenta
   (~90 s la primera vez, de ahí el `maxDuration = 300` en la página de ajustes).

Si las dos pasan, lista los **productos de la cuenta con sus ids** — que es de
donde sale el «tipo de paquete por defecto», porque el catálogo es por cuenta y
los ids de la documentación no valen. Al lado hay un buscador de agencias para
conseguir el **id de la agencia de origen**, que no se puede averiguar de otra
forma. Probar deja además la sesión caliente: la primera guía después ya no
espera.

**Si sale un 404, no es la API key.** Un 404 significa que la ruta no existe en
el host configurado, así que Shalom ni siquiera llegó a mirar la cabecera de
autenticación: la key puede estar perfecta. Pasó en producción la primera vez que
se probó — el mensaje decía «la API key del wrapper no funciona» y mandó a pedirle
una key nueva al proveedor cuando lo que sobraba era un `/v1` en
`SHALOM_API_BASE`. Ahora el error nombra la URL exacta que intentó y pide revisar
esa variable; el 401/403 sigue siendo el que sí acusa a la key.

### La sonda, para cuando no hay despliegue

`scripts/shalom-probe.mjs` hace lo mismo desde una terminal, y además puede crear
una guía real. Sirve para validar una API key **antes** de desplegar nada, que es
justo el caso de una key de prueba a punto de vencer. Es solo lectura salvo que
se le pase `--create`:

```bash
# Valida la API key sin tocar la cuenta de ningún cliente
SHALOM_API_KEY='sk_…' node scripts/shalom-probe.mjs

# Además: sesión, productos, tarifas y órdenes de la cuenta
SHALOM_API_KEY='sk_…' SHALOM_PRO_EMAIL='…' SHALOM_PRO_PASSWORD='…' \
  node scripts/shalom-probe.mjs
```

Con `--create` emite una guía real e imprime el `curl` de borrado. El volcado va
a `scripts/.shalom-probe.json` (ignorado por git, con secretos enmascarados).

### Probado contra la API real (27/07/2026)

`scripts/shalom-probe.mjs` corrió contra la cuenta real y pasó entero: la API key
global contra el directorio de agencias, el login de Shalom Pro (**60 s**, dentro
de la ventana esperada), el catálogo de productos y el listado de órdenes. No se
creó ninguna guía (sin `--create`). Lo que salió de ahí:

- **Los ids de producto de esta cuenta** son `3` (Sobre), `1096` (Caja Paquete
  XXS), `1090` (XS), `5` (S), `1093` (M) y `2` (L). No coinciden con los de la
  documentación del proveedor, que es justo por lo que el catálogo se lista desde
  la cuenta y no se cablea. **Esta operación despacha siempre con el `1096`**, que
  es el valor a poner como *tipo de paquete por defecto* en Ajustes.
- **El catálogo repite un id.** `id=2` viene dos veces: «Caja Paquete L» y «Otra
  Medida». Como el payload solo lleva `product_id`, la API tampoco puede
  distinguirlos: elegir «Otra Medida» en el modal manda el mismo `2` que «Caja
  Paquete L», y el resumen muestra el primero de los dos. No afecta mientras el
  producto por defecto sea el `1096`; si algún día hay que usar el `2`, hay que
  aclararlo con el proveedor antes.
- **`GET /readyz` responde 503** mientras `/healthz` responde 200 y todas las
  rutas reales responden 200. Parece reflejar la disponibilidad de `pro.shalom.pe`
  aguas arriba y no la del wrapper. No sirve como semáforo de despliegue.

### Límites conocidos

- **60 requests/minuto por API key, pero el cupo es compartido.** La cabecera
  `X-RateLimit-Limit` confirma los 60 que documenta el proveedor. Lo que
  despista es el `remaining`: la primera llamada de una sonda recién arrancada
  ya mostraba **14 disponibles**, no 59. No es que el techo sea más bajo — es
  que **la API key es una sola para todas las tiendas** (es de la cuenta de
  Kapso, ver arriba), así que el contador refleja lo que gasta *todo el mundo*
  a la vez, no lo que gasta quien mira.
  Consecuencias prácticas: el cupo que ves no es tuyo, puede estar casi agotado
  sin que hayas hecho nada, y a medida que entren más tiendas habrá que vigilar
  esa cabecera. La búsqueda de agencias rebota 450 ms para no gastarlo
  tecleando. Y conviene no encadenar sondas: agotarlo devuelve un error que se
  parece bastante al de una key vencida, que es un síntoma muy confundible.
- **Servicio de cobranza (`collection_service`) no implementado.** Requiere una
  cuenta bancaria registrada en Shalom Pro y en esta operación el cobro va por
  Yape con clave de recojo, que es justamente el flujo que ya existe. `payer`
  (quién paga el flete) sí es elegible, y por defecto es `sender`: el cliente ya
  pagó el envío junto con el producto.
- **Carga masiva (`/v1/orders/bulk`) no implementada**: el Master crea guías de a
  una desde el drawer.
- `GET /v1/tracking` devuelve `origen`, `destino`, `remitente`, `destinatario` y
  `comprobante` **vacíos** desde julio de 2026 (el propio proveedor lo avisa). No
  construir nada sobre esos campos.

## 5ñ-bis. Tanders — validar la constancia de pago de cada entrega

Tanders sube dos evidencias por entrega: la foto del paquete y el **comprobante
del pago**, que el repartidor yapea a Grupo GF SAC. Ese segundo comprobante es el
que dice si el dinero llegó, y hasta ahora nadie lo miraba uno por uno.

- **Needs migration 0084** (`shipments.payment_check_state`, tabla
  `tanders_payment_checks`).
- **Cron `/api/cron/tanders-payments`**, cada 2 h. Barre las guías Tanders vivas
  de los últimos 8 días: pregunta su estado, y si Tanders la da por entregada
  baja la constancia de pago, la lee y guarda el veredicto.
- **El orden es la regla del negocio**: que Tanders diga "entregado" NO basta.
  La guía pasa a `entregado` en el Master **solo si el cobro valida**. Una
  entrega sin cobro confirmado se queda donde está y espera a que alguien mire.
- **Se aceptan dos medios**: Yape **o transferencia BCP**, los dos con los que el
  repartidor remite. El lector de `lib/vision.ts` no sirve acá porque pregunta
  "¿es un comprobante Yape?" y rechazaría un BCP legítimo; por eso
  `lib/tanders/payment-vision.ts` tiene su propio prompt.
- **Es un cron y no un botón** porque la constancia aparece cuando el repartidor
  entrega, a cualquier hora y sin que nadie mire el Master.
- **Qué comprueba**: que sea un Yape real, **a Grupo GF SAC**, por el monto de la
  guía. Un pago a otra cuenta es dinero que no llegó; un monto distinto es un
  cobro mal hecho. Tolerancia de S/ 0.50 para el redondeo del comprobante.
- **Bloquea.** Mientras el estado no sea `validado` (o `revisado`), el pedido no
  se da por cobrado. Solo `tanders.review_payment` —owner/admin— puede darlo por
  bueno a mano, y **exige motivo**: el rechazo dijo por escrito qué no cuadraba,
  así que la aceptación tiene que decir por escrito por qué se acepta igual.
- **`pendiente` y `rechazado` son distintos a propósito.** Pendiente es "todavía
  no lo sé" (no hay constancia, o el lector falló); rechazado es "esto está mal".
  Marcar un timeout del modelo como rechazo mandaría al equipo a investigar un
  fraude que no existe. Los dos bloquean; solo uno acusa.
- **La separación entrega/pago va por la RUTA de la imagen.** Tanders sube las
  constancias de pago a `files_payment/<N° seguimiento>/…` y la foto de la
  entrega a otra carpeta, así que el discriminante no depende de cómo se llamen
  las claves de su JSON. Si no encuentra ninguna, devuelve vacío y la
  comprobación queda pendiente: pasar la foto de un paquete por el lector de
  comprobantes y decidir un cobro con eso sería peor que no decidir.
- El **nº de operación** se guarda indexado: un mismo comprobante reutilizado en
  dos entregas es exactamente lo que esta validación debe atrapar.
- Idempotente: una guía ya validada no se reanaliza, así que ejecutarlo de más no
  gasta llamadas al modelo.
- **Revisión en seco**: `/dashboard/pedidos/cobros-tanders` (permiso
  `tanders.review_payment`). Lee las constancias y muestra la imagen al lado de
  lo que el modelo leyó de ella, sin escribir nada. Con dinero de por medio, la
  primera pasada la revisa un humano antes de dejar que el veredicto mueva guías
  a "entregado".
- El barrido vive en `lib/tanders/payment-sweep.ts`, **compartido** por el cron y
  por esa revisión: si fueran dos implementaciones, mirar los veredictos en seco
  no probaría nada sobre lo que hace el cron de verdad.
## 5o. MOM Fase 1 — macroetapas sombra e identidad de salidas

- **Requiere migración 0086** antes de activar cualquier interfaz de escaneo.
- La migración asigna a cada guía vinculada un consecutivo por pedido
  (`KP123-S01`, `KP123-S02`) y un `qr_token` opaco diferente.
- `general_status` y `operational_status` continúan siendo productivos. Los
  campos `macro_stage`, `macro_substage` y `macro_reasons` son un cálculo en
  paralelo para validación; no cambian las pestañas actuales.
- Código y migración son compatibles en ambos órdenes: si el código se despliega
  antes, el recálculo omite temporalmente las columnas MOM; si la migración se
  aplica primero, sus valores por defecto se reemplazan en el siguiente barrido
  del Master.
- Después de aplicar 0059, ejecutar/revisar un ciclo de sincronización y
  comprobar una muestra real:
  - Lima nuevo → `preparacion / por_generar_rotulo`.
  - Provincia nuevo → `por_confirmar / sin_llamar`.
  - Guía sin despacho → `preparacion / por_armar`.
  - Entregado COD sin liquidación integrada → `por_cerrar / pendiente_liquidacion`.
- No imprimas todavía el nuevo QR desde producción: la pantalla de doble cotejo
  y transferencia de custodia pertenece a la Fase 2.

## 5p. MOM Fase 2 — mesa de despacho y doble cotejo

- **Requiere migración 0087** antes de abrir `/dashboard/pedidos/despacho`.
- La mesa acepta el QR opaco, el código `KP…-S01` o la guía del courier. La
  cámara es opcional: un lector USB o la escritura manual usan el mismo campo.
- Almacén marca el paquete `listo_despacho`; Daysi/equipo lo incorpora y coteja
  dentro de una ruta; el motorizado vuelve a escanear todo al recoger.
- Crear o compartir la ruta no marca despacho. La custodia cambia únicamente al
  completar el segundo cotejo al 100 %.
- Si falta una caja se retira expresamente de la ruta con motivo. Los demás
  paquetes pueden salir solo después de que el manifiesto actualizado vuelva a
  estar completo.
- Revisar primero una ruta pequeña en producción y comprobar su historial en el
  Master antes de usarla con todos los couriers.

## 5q. Chatby — capturar la conversación del Live Chat

- **Requiere migración 0104** antes de activar el webhook.
- Chatby (white-label de uChat) **no expone lectura de mensajes por API**: sus
  endpoints de conversación devuelven agregados y el modelo `Subscriber` solo
  trae `last_message_at`/`last_message_type`. El texto llega únicamente por este
  webhook, y **no hay forma de pedir el histórico**: lo que no se capture
  mientras está apagado se pierde para siempre. Por eso conviene activarlo
  aunque la interfaz que lo consuma todavía no exista.
- Generá el secreto (`openssl rand -hex 32`), cargalo como `CHATBY_WEBHOOK_SECRET`
  y en Chatby → **Integrations → Live Chat Support → Webhook**:

  | Campo | Valor |
  |---|---|
  | Webhook URL | `{NEXT_PUBLIC_SITE_URL}/api/webhooks/chatby` |
  | Custom Header | `X-Webhook-Secret: <CHATBY_WEBHOOK_SECRET>` |

- Antes de darle a *Save*, un **GET a la misma URL** confirma que la ruta existe
  y que el secreto ya está cargado (`configured: true`), sin revelarlo. Sin ese
  GET, la única forma de comprobar la configuración sería esperar a que un
  cliente escriba.
- ⚠️ **Medido en producción (2026-08-05): este webhook NO cubre WhatsApp.** Con
  el bot pausado se mandaron dos mensajes entrantes de WhatsApp y no hubo
  ninguna entrega — en los logs de Vercel no aparece **ni una** petición a la
  ruta en ese minuto. No es configuración: el ping de validación del *Save* sí
  llegó y sí escribió fila con esa misma URL y cabecera. «Live Chat» en Chatby
  significa su **widget web**.
  El receptor se conserva igual porque el paso **External Request** del flow
  builder, que sí corre sobre WhatsApp, puede POSTear a esta misma ruta con la
  misma cabecera.
- **Límites del webhook, no nuestros**: solo manda mensajes **entrantes** y solo
  con el **bot pausado**. La fase en que el bot conversa no llega. Los salientes
  se emiten desde el dashboard vía `POST /subscriber/send-content` con
  `send_as_agent: 1`, y el hilo se arma mezclando las dos mitades.
- Se configura **por cuenta, no por bot**: un único webhook para Aurela y Kenku.
  Por eso `chatby_webhook_log` todavía no tiene `store_id` — resolver la tienda
  exige saber qué trae el payload, y escribirlo a ciegas pondría la conversación
  en la tienda equivocada.
- Es una bitácora **append-only y sin pérdida**: guarda el JSON entero tal como
  llegó, incluso si no es JSON válido. La tabla definitiva se rellena desde acá.

## 5r. Anomalías de ingesta — ver lo que se descarta

- **Requiere migración 0107** (`ingest_anomalies` + `note_ingest_anomaly`).
- Sin ella no se rompe nada: `noteAnomaly` se traga su propio fallo a propósito
  (el medidor no puede tumbar lo que mide), así que el indicador simplemente no
  aparece hasta que se aplique.
- Se ve en **Tiendas**, como «Anomalías de ingesta · últimos 7 días»: una fila
  por (camino, motivo) con hoy, ayer y el total del período.
  **Lo que importa es el salto, no el nivel**: 25 descartes pueden ser lo normal;
  «ayer 0, hoy 25» es lo que hizo falta para fechar la migración de identidad de
  Meta al día. Por eso la tabla ordena por lo que pasa HOY y no por lo que más
  acumula — un motivo con 200 la semana pasada y 0 hoy ya no es noticia.
- **No va en la cabecera de Leads**, donde estuvo un día: esa línea la leen las
  asesoras todo el tiempo buscando trabajo accionable («sin llamar», «atender
  ahora»), y un contador de diagnóstico ahí es ruido en lo único que miran.
  Tiendas además ya redirige a las vendedoras, así que queda fuera de su vista
  sin necesidad de un permiso aparte.
- Se agrega **por día y por (tienda, camino, motivo)**, no un registro por
  evento: un log por evento crece sin fin, nadie lo lee y esconde el salto.
- **Qué cubre**: trabajo DESCARTADO — conversaciones que no generan lead,
  handoffs rechazados, pasos best-effort que fallan. **Qué no cubre**: un camino
  que devuelve un resultado equivocado sin descartar nada. Eso lo atrapan los
  tests, no esta tabla.
- Consulta directa cuando haga falta el detalle:

  ```sql
  select dia, source, reason, count, sample, last_seen_at
  from ingest_anomalies
  where dia > current_date - 14
  order by dia desc, count desc;
  ```

## 5s. Comentarios de Facebook e Instagram — la sonda

- **Requiere migración 0124** (`meta_social_webhook_log`).
- **Es una SONDA, no una función.** Guarda cada entrega entera y no interpreta
  nada más allá del sobre. No responde comentarios, no toca leads ni pedidos, y
  no enseña nada en la interfaz. Si mañana se apaga, no queda rastro en el
  negocio.
- **Para qué**: antes de construir la bandeja de comentarios hay tres preguntas
  que hoy son opinión y que ninguna documentación contesta con certeza —
  **cuántos comentarios al día**, **cuántos son sobre anuncios**, y sobre todo
  **si los de anuncios llegan siquiera**. Las fuentes se contradicen, y como el
  volumen del negocio está casi todo en anuncios, esa duda decide si el proyecto
  entero tiene sentido. De paso se aprende la forma real del payload, que es lo
  que después se convierte en el parser sin adivinar un campo.
- **Dos variables, y se olvida una**:

  | Variable | Quién la emite | Para qué |
  |---|---|---|
  | `META_APP_SECRET` | Meta (es el App Secret de tu app) | Firma cada entrega: HMAC-SHA256 del cuerpo en `X-Hub-Signature-256` |
  | `META_WEBHOOK_VERIFY_TOKEN` | **Vos** (`openssl rand -hex 32`) | Solo el apretón de manos inicial — sin él Meta nunca activa la suscripción |

- En la app de Meta → **Webhooks**, dar de alta:

  | Campo | Valor |
  |---|---|
  | Callback URL | `{NEXT_PUBLIC_SITE_URL}/api/webhooks/meta-social` |
  | Verify Token | `<META_WEBHOOK_VERIFY_TOKEN>` |
  | Campos | `feed` en **Page** · `comments` en **Instagram** |

- Antes de darle a *Verify and Save*, un **GET a la misma URL** (sin `hub.mode`)
  confirma que la ruta existe y que **las dos** variables están cargadas, sin
  revelarlas. Es el mismo GET de Chatby y por el mismo motivo: la alternativa
  sería esperar a que alguien comente y ver si llegó algo.
- **No es por tienda**, y no por descuido: Meta configura el webhook por **app**,
  así que una sola URL cubre Aurela y Kenku. Por eso `meta_social_webhook_log`
  todavía no tiene `store_id` — la tienda saldrá de `entry[].id`, que es
  justamente uno de los datos que la sonda viene a recoger. Escribirla a ciegas
  mandaría los comentarios de una tienda a la bandeja de la otra.
- **Probablemente no necesita App Review**: son páginas propias y app propia, y
  los permisos se conceden sobre activos propios. La revisión de Meta hace falta
  para operar sobre activos de terceros. Confirmarlo al configurar.
- Qué preguntarle a los datos después de una semana:

  ```sql
  select date_trunc('day', received_at) as dia,
         object_type,
         unnest(fields) as campo,
         count(*)
  from meta_social_webhook_log
  group by 1, 2, 3
  order by 1 desc, 4 desc;
  ```

## 5t. Cobros equivocados — la alerta que faltaba conectar

- **Requiere migración 0127** (`shipments.collect_alert_sent_at`).
- **Qué avisa**, por el mismo canal de Telegram que el resumen de las 8 y los
  Yape sin atender:

  | Caso | Ejemplo |
  |---|---|
  | La guía cobra MÁS que el total | el fallo original de la 0060: S/ 447 por un pedido de S/ 298 |
  | La guía cobra algo sobre un pedido **ya pagado** | pago en el checkout, y el motorizado sigue con orden de cobrar |

- **Por qué hacía falta.** La 0060 ya guardaba `reported_collect_amount` —lo que
  el courier declara que cobrará, refrescado cada 20 minutos— y decía que
  persistirlo «convierte esa pasada en un detector permanente». Pero
  `collectAmountMismatch` **solo lo llamaba su propio test**: el dato se recogía
  y no lo miraba nadie. Con las pruebas en verde todo el tiempo.
- Corre dentro de `/api/cron/sync`, detrás de la alerta de Yapes y con el mismo
  trato: **best-effort**, un fallo de Telegram nunca tumba la sincronización.
- **No avisa** de pedidos entregados, devueltos o anulados: ahí ya no hay nada
  que evitar. Y **re-avisa como mucho cada 3h** mientras el descuadre siga vivo —
  sin ese freno, un cron de 20 minutos genera setenta alertas por pedido y el
  canal deja de leerse justo cuando importa.
- Requiere que la tienda tenga Telegram configurado (`telegram_bot_token` +
  `telegram_chat_id`). Sin eso no hace nada, en silencio.
- **Lo que esto NO arregla:** Aliclik sigue calculando su importe desde los
  precios de línea sin preguntar si el pedido está pagado. Esta alerta es la red,
  no la solución — pero es la red que cubre el caso mientras no se toque su
  contrato (cambiarlo a ciegas es el fallo que documenta la 0060).

## 5u. Cómo se cobró el pedido, en el Master — y el drawer «No encontrado»

- **Requiere migración 0128** (`order_master.financial_status`,
  `order_master.total_refunded`). **Aplícala ANTES de desplegar**, no después.
- **Qué pasa si se despliega el código sin ella.** `getOrderMasterDetail` pide
  esas dos columnas en su `select`. Si no existen, PostgREST responde `42703` y
  el drawer de CUALQUIER pedido queda en blanco. Se vio en producción el 24/08:
  la migración salió detrás del código y el panel decía **«No encontrado.»** sobre
  pedidos que la tabla de atrás seguía enseñando en la misma pantalla.
- El mensaje engañaba porque el `error` de PostgREST se descartaba y un `data`
  en null se leía como «este pedido no existe». Ya no: la lectura que falla
  lanza `OrderMasterReadError` y el drawer enseña el error de la base con su
  código, que es lo que distingue una migración pendiente de un permiso o de un
  corte de red. Un `null` sin error —el único caso que sí es un pedido que no
  está— sigue diciendo «No encontrado.».
- **Comprobación después de aplicarla**: abre un pedido cualquiera desde el
  Master. Si el drawer carga, la columna está. Si enseña un texto con un código
  entre corchetes, ese código dice exactamente qué falta.
- **Sin backfill a propósito**: las filas viejas quedan en `financial_status`
  NULL, que no cuenta como pagado, y el barrido las va poniendo al día.

## 5v. Aviso de guía Shalom en tránsito por WhatsApp — y las cuentas que ve el cliente

Cuando el rastreo de Shalom registra `en_transito`, Kapta manda la plantilla
aprobada (`guias_shalom`) con guía, código, agencia, producto y resumen de pago,
y contesta sola los tres botones con las cuentas de la tienda (MOM §12). Nace
**apagado** por tienda.

1. **Migración `0166_shalom_transit_whatsapp.sql`**, a mano, antes del código
   (§2). Crea las columnas `shalom_transit_*` en `stores`, la tabla
   `store_payment_methods` (con las siete cuentas de hoy sembradas en cada
   tienda), la cola `shalom_transit_notifications` y `wa_auto_replies`. Sin
   ella el cron sigue funcionando: la cola falla en silencio hacia el informe
   (`avisos.errors`) y no se manda nada.
2. **Kapso tiene que entregar `whatsapp.message.received` al webhook de la
   tienda** (`/api/webhooks/kapso/<storeId>`), además de los eventos de
   conversación y de estado que ya manda. Hasta ahora ese evento se descartaba;
   sin él, los botones no llegan y la clienta pulsa al vacío. Comprobarlo
   pulsando un botón de prueba y mirando `wa_auto_replies`: si no aparece fila
   ni anomalía `inbound_message`, el evento no está llegando.
3. **Ajustes → Aviso de guía Shalom en tránsito**: nombre de la plantilla
   (`guias_shalom`), idioma, orden de variables (el de ejemplo es el aprobado),
   horario, y encender. «Ticket de Shalom en cabecera» solo con una plantilla
   aprobada con cabecera de documento (`guias_shalom_imagen`); con la de texto,
   Meta rechaza el envío.
4. **Ajustes → Cuentas de cobro que ve el cliente**: revisar la semilla y
   marcar el Yape principal. Conviene que sea una de las cuentas contra las que
   se verifican comprobantes (0126), o el pago quedará en revisión.

**Qué mirar después.** El informe de `/api/cron/shalom-reconcile` trae
`avisos: { encolados, sent, failed, skipped, deferred, errors }`. `skipped`
con la tienda apagada es lo esperado; `failed` trae el motivo en la fila
(`shalom_transit_notifications.error`). En el pedido, el envío aparece en la
línea de tiempo como `whatsapp_template`.

**El bot de Kapso NO debe contestar esos botones.** Las cuentas viven ahora en
Kapta; si el bot también responde a «Pagar con Yape» con una cuenta escrita a
mano, la clienta recibe dos mensajes y, el día que la cuenta cambie, uno de los
dos estará mal. Ver `docs/kapso-functions/README.md`.

### 5v.1 El botón «Link de pago» cobrando por Flow.cl

Encendido, ese botón crea una orden de cobro en Flow.cl **por el saldo del
momento** y manda el link. El pago vuelve por el webhook que ya existía desde
la 0160/0161 y aparece como comprobante `diferencia` **ya validado** — la
única excepción a que todo comprobante pase por revisión, porque aquí la
evidencia es la respuesta firmada de la pasarela y no la foto de una
pantalla. `validated_by` queda en NULL y la línea de tiempo lo explica.

1. **Migración `0168_flowcl_link_settings.sql`**, a mano, antes del código.
   Solo añade columnas a `stores` y un índice: no toca ningún cobro existente.
2. **Ajustes → Flow.cl (pasarela)**: API key, secret key y **secreto del
   webhook** de la tienda. El secreto no se configura en el panel de Flow —
   viaja en `urlConfirmation` de cada cobro—, así que basta con inventarlo aquí:
   `crypto.randomUUID()` en la consola del navegador sirve.

   > **El secreto no se rota a media tarde.** Queda grabado dentro de la
   > `urlConfirmation` de cada cobro EN EL MOMENTO DE CREARLO. Cambiarlo deja a
   > todos los links vivos avisando con el secreto viejo: el webhook los
   > rechaza con 401, el dinero entra en Flow y no aparece en el pedido. Si hay
   > que cambiarlo, primero se deja vencer lo vivo (`flowcl_payment_links` con
   > `status='creado'` y `expires_at` en el futuro).
3. **`NEXT_PUBLIC_SITE_URL` tiene que ser la URL pública real.** De ahí salen
   `urlConfirmation` y `urlReturn`. Con el valor por omisión
   (`http://localhost:3000`) el cobro se crea y el pago no vuelve nunca.
4. **Ajustes → Cobro por Flow.cl en el botón «Link de pago»**: email de
   respaldo (obligatorio en la práctica: el 95 % de los pedidos no trae email),
   horas de vencimiento y medio de pago. Encender al final.
5. **Una prueba real con un importe pequeño antes de encenderlo del todo.** El
   comportamiento de Flow ante importes con decimales no está comprobado contra
   la API real (`lib/flow/client.ts` lo dice desde la sonda de 2026-09-12); el
   saldo de un pedido casi siempre los tiene.

**Qué mirar después.** `flowcl_payment_links`: un link por pulsación es
esperado solo la primera vez —después se reenvía el mismo mientras el importe
no cambie—. Filas en `anulado` con `last_status->>'create_error'` son cobros
que Flow rechazó; con `status='pagado'` y `register_error` relleno, dinero que
entró y no se pudo anotar como comprobante: eso hay que mirarlo a mano.

**El riesgo que no desaparece.** Un link vivo cobra el importe con el que
nació. Si la clienta paga parte por Yape, el siguiente botón crea uno nuevo por
lo que falta, pero el viejo sigue en su chat hasta que vence. Las horas de
vencimiento son lo único que lo acota.

## 7. Post-deploy verification

### WhatsApp delivery lifecycle

- Apply migration **0037** (`whatsapp_outbox`) before deploying the application.
  It is additive and does not lock or rewrite existing leads/messages.
- In Kapso, point the WhatsApp status events `sent`, `delivered`, `read` and
  `failed` to the existing per-store endpoint
  `/api/webhooks/kapso/[storeId]?secret=<STORE_WEBHOOK_SECRET>`. Transcript
  polling also repairs a missed webhook in the background.
- Send one test message and confirm its row advances in order in
  `whatsapp_outbox`. A provider-declared failure must show **Reintentar**; a
  network-ambiguous result must show **Estado por confirmar** and must not offer
  an unsafe automatic retry.

- **Health**: `curl https://<domain>/api/health` → `{ "ok": true, … }` (public,
  no secrets) confirms the deployment is serving.
- **Backfill parity**: in Shopify Admin, filter orders by `tag:kapso` for a date
  range and compare the count with the sum of `ordenes` in «Resumen diario del
  bot CSV» for the same range. They should match. (Since 0268 the headline
  «Pedidos» counts ALL orders, MOM §17.4: compare it with the Master instead.)
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

## Región de las funciones

`vercel.json` fija `"regions": ["gru1"]` (São Paulo). El motivo es la base de
datos: el proyecto de Supabase está en `sa-east-1` (São Paulo) y las funciones
corrían en `iad1` (Virginia), que es el valor por defecto de Vercel — cada
consulta cruzaba el hemisferio, y el panel hace muchas por pantalla. El equipo
además opera desde Perú, más cerca de São Paulo.

Contrapartida: Shopify, Kapso y Meta quedan más lejos. Son llamadas menos
frecuentes y casi siempre en segundo plano (crons, webhooks), así que el saldo
debería ser positivo. Revertir es borrar la clave `regions`.

> **Cuidado al editar `vercel.json`:** su esquema NO admite claves desconocidas
> y **tampoco comentarios**. Una clave de más hace que Vercel rechace el fichero
> y el despliegue falle *antes* de compilar, sin logs de build — y bloquea
> también los despliegues siguientes de cualquier rama. `test/vercel-config.test.ts`
> lo comprueba en CI; documenta aquí los porqués, no dentro del JSON.

## Aliclik — crear guías desde el Master

Permite crear el pedido en Aliclik (contraentrega) desde `/dashboard/pedidos` en
vez de cargarlo a mano en su panel, y recibir sus cambios de estado.

**Alta.** Aliclik entrega el token tras un proceso de alta por correo (ver su
documentación). Es un Bearer token por integración.

**Configuración**, en Ajustes → «Aliclik · crear guías por API»:

1. Pega el token en «Rotar credenciales» → *Token de integración de Aliclik*.
2. «Probar conexión» — solo lectura, confirma token y host.
3. «Sincronizar catálogo» — trae EAN, stock y almacén, y auto-mapea los SKU de
   Shopify que coinciden exactamente. Los que no, se mapean a mano.
4. Genera el secreto de webhook y pega la URL resultante en «Webhook de
   notificaciones» del panel de Aliclik.
5. Pon el interruptor «Crear guías en Aliclik» en *Habilitado*.
6. En el entorno, `ALICLIK_WRITE_ENABLED=true`.

**Hacen falta las dos llaves (5 y 6)**: crear una guía es irreversible y con
ventanas de cancelación estrictas. Sin ambas, el panel cotiza pero no crea.

### Lo que hay que saber antes de encenderlo

- **Las coordenadas son el cuello de botella.** Aliclik exige `lat`/`lng` para
  cotizar y crear, y Shopify no las entrega. En la base de producción, **ninguno**
  de los pedidos pendientes sin guía tenía coordenada. El panel las pide pegando
  el enlace de Google Maps que manda la clienta. Un enlace acortado
  (`maps.app.goo.gl`) no sirve: hay que abrirlo y copiar la URL larga.
- **La cotización detecta direcciones mal ubicadas.** Muestra el distrito que
  Aliclik deduce del pin junto al nuestro; si no coinciden, el reparto irá donde
  apunta el pin. Cotizar es gratis y no escribe nada: conviene hacerlo en lote
  antes de encender la creación, para medir cuántos pedidos son creables.
- **Cancelar tiene una trampa.** `POST /order/cancel` responde 201 aunque NO
  cancele: si el pedido no está confirmado, Aliclik solo le añade una nota. El
  panel lo distingue y lo muestra en ámbar, nunca como éxito.
- **El webhook no viene firmado.** Aliclik no define HMAC ni cabecera de
  autenticación, así que el secreto de la URL es la única barrera. Además, el
  aviso se trata como disparador y no como dato: al recibirlo se relee el estado
  con `GET /integration/order`, cuyo `updatedAt` protege del desorden que la
  propia documentación advierte.
- **Dos identificadores por envío.** La API devuelve `ALC000…` y el Excel trae
  `AUR5X…` para el mismo paquete. La guía se crea con el `ALC…` provisional y
  adopta el `AUR5X…` cuando llega el reporte, sobre la misma fila. Por eso no
  aparecen guías duplicadas.
- **Un intento vivo por pedido.** Un doble clic, dos operadoras o un reintento
  chocan contra un índice único antes de llegar a Aliclik. Si una creación se va
  en timeout **no la reintentes**: el pedido pudo haberse creado y el cron de
  reconciliación lo vincula solo.

### Por qué las llamadas a Aliclik salen por Edge

**`api.aliclik-dev.com` no es alcanzable desde las funciones Node.** Cloudflare
desafía las peticiones que salen de IPs de centro de datos de AWS y responde 403
con su página "Just a moment"; la API de Aliclik nunca llega a verlas. Se
comprobó desde `iad1` (Virginia) y desde `gru1` (São Paulo): mismo 403.

Lo que sí funciona es salir por el runtime **Edge** de Vercel, que corre en otra
red. La misma petición, con el mismo token, responde 200. Por eso existe
`app/api/internal/aliclik-egress/route.ts` y por eso `env.aliclikEgress()`
devuelve `edge` **por defecto**: no es una preferencia, es la única vía que
llega.

- **"Probar conexión"** (Ajustes → Aliclik) prueba **las dos salidas** de un
  clic y reporta ambas. Sirve para saber si la directa vuelve a funcionar.
- `ALICLIK_EGRESS=direct` vuelve a la salida directa, para el día en que Aliclik
  ajuste su WAF y se quiera quitar el salto intermedio.

La ruta interna **no es un proxy abierto**: el host de destino sale de la
configuración y nunca de la petición, solo admite rutas `/integration/*`, y
exige el secreto interno (`CRON_SECRET`). Sin esa última cerradura estaríamos
ofreciendo a cualquiera un relé para saltarse su propio bloqueo.

Esto no evade nada: no se falsifica ninguna huella ni se resuelve ningún
desafío. Solo cambia desde qué red sale la petición, igual que elegir la región.

### Pendiente de confirmar con Aliclik

- URL de **producción** (la documentación solo publica el host de desarrollo) y
  si el token difiere entre entornos.
- Si `GET /integration/order` o el Excel exponen el código `AUR5X` de un pedido
  creado por API: hoy la reconciliación se apoya en teléfono + nº de pedido.
- Si `products[].price` es unitario o subtotal de línea.
- Límites de cuota, y si el webhook admite firma o IPs fijas.

### 22-09-2026 · «Recibir en oficina» (0188)

1. **Migración `0188_gf_return_to_office.sql`**, a mano, antes del código:
   `psql "$DATABASE_URL" -f db/migrations/0188_gf_return_to_office.sql`.
   Redefine el guard de ítems para admitir el retiro autorizado también en
   modo `exigir` y crea `gf_return_to_office`. Sin ella, «Recibir en oficina»
   responde que la función no existe.
2. Resolver `mom-v1.15`: el cron reconcilia el histórico solo.

### 22-09-2026 · Rechazo en puerta recibido en oficina (0189)

1. **Migración `0189_gf_return_rejected.sql`**, a mano, antes del código.
   Redefine `gf_return_to_office`: un rechazo queda devuelto y cancela la
   solicitud en vez de volver a «por asignar».
2. Resolver `mom-v1.16`: el cron reconcilia el histórico solo.

### 28-09-2026 · La pasarela Flow como cuenta de cobro (0198)

1. **Migración `0198_flow_collection_account.sql`**, a mano:
   `psql "$DATABASE_URL" -f db/migrations/0198_flow_collection_account.sql`.
   Permite una cuenta de cobro sin celular y da de alta «Aurela Kenku»
   (pasarela Flow) en todas las tiendas. Sin ella, las constancias de Flow
   siguen en «cuenta receptora no coincide».
2. El orden no importa: el código anterior descarta una cuenta sin celular como
   «mal cargada», y el nuevo sin la migración simplemente no la tiene.
3. La regla de la nota del Yape (el nombre de la clienta leído como receptor)
   no necesita migración: se recalcula al mirar, y los comprobantes ya
   cargados se destraban solos.

### 29-09-2026 · Sync automático del stock contra Swayp (0201)

1. **Migración `0201_swayp_inventory_sync_runs.sql`**, a mano y ANTES del
   código: `psql "$DATABASE_URL" -f db/migrations/0201_swayp_inventory_sync_runs.sql`.
   Crea el registro de corridas. Sin ella el sync escribe igual, pero la
   corrida no queda registrada y Stock Swayp no muestra cómo le fue.
2. **Variables en Vercel (Production)**, ninguna es secreta:
   - `SWAYP_INVENTORY_RUC` — RUC de la empresa en Swayp (header `user`).
   - `SWAYP_INVENTORY_COMPANY_ID` — id de la empresa en Swayp (`idCompany`).
   - `SWAYP_INVENTORY_ORG_ID` — la organización de Kapta dueña de ese stock.
   Ya creadas el 29-09-2026.
3. **La credencial es la de las guías** (`SWAYP_TOKEN`/`SWAYP_EMAIL`): el sync
   lee `GET {SWAYP_API_BASE}/v1/integrations/products`, que trae cada producto
   con su stock por bodega (confirmado el 29-09-2026). No hay credencial nueva
   que pedir ni guardar. `SWAYP_INVENTORY_RUC`/`SWAYP_INVENTORY_COMPANY_ID`
   sólo prellenan el respaldo con token del panel.
4. **Migración `0203_drop_swayp_inventory_sessions.sql`**, DESPUÉS de que salga
   el código que ya no las usa: borra `swayp_inventory_sessions` y
   `swayp_extension_keys` (0202), de un intento previo con la sesión del panel
   y una extensión de Chrome, retirado el mismo día. Estaban vacías.
5. El cron (`/api/cron/swayp-inventory`, a los :40 de cada hora) sincroniza
   sólo si pasaron ≥ 20 h desde el último sync bueno; si no, responde
   `al_dia`. Sin `SWAYP_TOKEN`/`SWAYP_EMAIL` o `SWAYP_INVENTORY_ORG_ID`
   responde `sin_credencial` con lo que falta.

### 29-09-2026 · Estado de las guías Swayp leído de su API

1. **Sin migración ni variables nuevas**: usa la credencial de las guías
   (`SWAYP_TOKEN`/`SWAYP_EMAIL`) y las columnas de 0080 (`swayp_state`,
   `swayp_synced_at`).
2. El cron `/api/cron/swayp-status` (a los :22 y :52) lee con
   `GET /v2/guias/{guia}` cada guía Swayp viva (`pendiente`/`en_ruta`), las
   nunca leídas primero, hasta 200 por pasada, y aplica el `estado` por la misma
   puerta que el webhook. Deja en el log una línea `[swayp-status]` con los
   conteos (leídas, cambiaron, desconocidos, errores y sus motivos), sin guías
   ni pedidos.
3. La primera pasada mueve el atraso de golpe (el 29-09 eran ~130 guías con
   estado viejo) y recalcula su Master; el resolver sube a `mom-v1.21`, así que
   el resto del Master se reconcilia en las horas siguientes como siempre.
4. Si Swayp responde 429 o la credencial falla, el barrido se detiene y lo dice
   (`detenido`); lo pendiente va en la pasada siguiente.

### 30-09-2026 · En Lima, lo que no se entrega se reprograma (0206, `mom-v1.23`)

1. **Migración `0206_gf_return_rejected_reprograms.sql`**, a mano, antes del
   código. Redefine `gf_return_to_office` (deshace la 0189): un «Rechazó el
   pedido» recibido en oficina vuelve a «por asignar» como los demás motivos,
   en vez de quedar devuelto y cancelar la solicitud. Solo cambia la función.
2. Resolver `mom-v1.23`: el cron reconcilia el histórico solo. Una guía de
   cualquier courier de Lima anulada después de salir abre la recuperación, y
   el rechazo del motorizado propio va a «Por reprogramar Lima».
3. El cierre de ruta y Liquidaciones ya no anulan el pedido por un rechazo:
   solo Shopify anula.

### 04-10-2026 · Validar pagos con el estado de cuenta de Yape (0224, MOM §16.2)

1. **Migración `0224_yape_statement.sql`**, a mano y ANTES del código:
   `psql "$DATABASE_URL" -f db/migrations/0224_yape_statement.sql`. Crea
   `yape_statement_imports`, `yape_statement_movements` y
   `yape_statement_matches`. Sin ella el webhook falla al guardar el reporte y
   no valida nada.
2. **Variable en Vercel (Production)**: `YAPE_MOVEMENTS_WEBHOOK_SECRET`, un
   valor largo y aleatorio (`openssl rand -hex 24`). Es el mismo que va en la
   cabecera `x-yape-movements-secret` del escenario de Make. Sin ella el
   endpoint responde 401 a todo, que es lo seguro: lo que entra por ahí VALIDA
   pagos.
3. **Escenario de Make «Kapta · Estado de cuenta Yape (Outlook → Kapta)»**, el
   gemelo del de los rótulos de Olva: vigila el buzón Fkc@monono.pe con
   `from:notificaciones@yape.pe`, saca los adjuntos `.xlsx` y los manda por
   multipart a `/api/webhooks/yape-movements` (campos `messageId`, `subject`,
   `receivedAt`, `fileName`, `file`). Se crea **inactivo**: se enciende después
   de los pasos 1 y 2, o Make recibe 404/401 y lo acaba pausando.
4. **Primera prueba en simulacro**, con el reporte que haya a mano:
   `curl -F messageId=prueba -F fileName=reporte.xlsx -F file=@YAPE_REPORTE_MOVIMIENTOS_04102026.xlsx -H "x-yape-movements-secret: $SECRETO" "https://kapso-sales-dashboard.vercel.app/api/webhooks/yape-movements?simulacro=1"`.
   Responde qué validaría (`validados`) y por qué omitió el resto (`omitidos`)
   sin escribir nada. El simulacro no relee las horas de los cobros de courier,
   así que esos salen como `sin_hora` hasta la primera corrida real.
5. **La primera corrida real** relee la constancia de los cobros de courier
   pendientes sin hora (unos 40 el 04-10: una llamada de visión por cada uno,
   con la clave de la tienda) antes de cruzar. Lo que no quepa en el tiempo
   entra en el siguiente reporte.
6. **Qué mirar después**: `select * from yape_statement_imports order by
   created_at desc limit 5;` — `validated` y `report` (validados, omitidos por
   motivo, errores). Cada pago validado así tiene un evento `payment` con
   fuente `estado_yape` y el movimiento en `payload`.

### 05-10-2026 · Alerta urgente de comprobante repetido (0226)

1. **Migración `0226_repeated_voucher_alert.sql`**, a mano, antes del código:
   amplía `collection_alerts.kind` con `comprobante_repetido`, añade
   `dedupe_key` (una abierta por comprobante) y `stores.urgent_telegram_chat_id`.
   Sin ella, levantar la alerta falla (en silencio: el cobro igual queda
   bloqueado).
2. **Permiso por persona** «Alerta de comprobante repetido» desde Equipo a
   quienes deben verla en Kapta.
3. **Grupo de Telegram** con esas personas y el bot de la tienda; su chat id en
   Ajustes → Telegram → Alertas urgentes («Buscar grupos» lo encuentra).

### 10-10-2026 · App de Shopify para tiendas cliente, primera parte (0249, MOM §29.15.9)

Segunda app de Shopify, pública y oculta, para las tiendas de organizaciones
cliente de Grupo GF. Aurela y Kenku siguen con la app actual (§5); nada de lo
suyo cambia.

1. **Migración `0249_shopify_client_app.sql`**, a mano y ANTES del código:
   `psql "$DATABASE_URL" -f db/migrations/0249_shopify_client_app.sql`.
   Añade `stores.shopify_app` (`interna` por defecto, así que las tiendas de hoy
   quedan como están) y `stores.shopify_uninstalled_at`, y crea
   `shopify_pending_installs` y `shopify_privacy_requests`. Sin ella, la
   desinstalación de una tienda falla al escribir la fecha y la búsqueda de
   tiendas conectadas de la app nueva responde error.
   **Ya aplicada en producción el 12-10-2026**, en dos pasos del historial de
   Supabase: `0245_shopify_client_app` y `0245_shopify_client_app_revoke_defaults`
   (el `revoke` a `anon` y `authenticated` se añadió después; el fichero ya lo
   trae completo). Allí quedó con el nombre `0245_…`: el fichero pasó a ser la
   `0249` porque la `0245` a la `0248` ya estaban tomadas en la integración. Es
   la misma migración; no se vuelve a correr.
2. **La app «Kapta» en el Dev Dashboard** (organización Grupo GF SAC), distinta
   de «kapso-sales-dashboard-aurelape». **Creada el 12-10-2026**; la versión
   `kapta-3` es la que tiene todo. Su configuración completa:

   ```toml
   client_id = "…"            # el de la app; no va al repositorio
   name = "Kapta"
   application_url = "https://kapso-sales-dashboard.vercel.app/api/shopify/clientes/entrada"
   embedded = false           # Kapta abre en su pestaña; incrustada no hay login ni OAuth

   [build]
   automatically_update_urls_on_dev = false

   [webhooks]
   api_version = "2026-10"

     [[webhooks.subscriptions]]
     compliance_topics = [ "customers/data_request", "customers/redact", "shop/redact" ]
     uri = "https://kapso-sales-dashboard.vercel.app/api/shopify/clientes/cumplimiento"

   [access_scopes]
   # = SHOPIFY_CLIENT_APP_SCOPES: los de la app interna más write_orders
   scopes = "read_customers,write_draft_orders,read_draft_orders,read_orders,write_orders,read_products"
   optional_scopes = [ ]
   use_legacy_install_flow = false   # instalación gestionada por Shopify

   [auth]
   redirect_urls = [
     "https://kapso-sales-dashboard.vercel.app/api/shopify/clientes/callback"
   ]
   ```

   - **Los webhooks de privacidad no se pueden poner desde el formulario** del
     Dev Dashboard (ni al crear ni en «Crear versión»). Se suben con la CLI:
     `npm init @shopify/app@latest` → «Build an extension-only app» → org
     Grupo GF SAC → «No, connect it to an existing app» → Kapta. Eso deja una
     carpeta con `shopify.app.toml`; se deja igual al bloque de arriba y se
     corre `shopify app deploy`, revisando el resumen antes de confirmar.
   - **La plantilla trae ejemplos que NO deben subirse:** bloques
     `[metaobjects.app.faq…]`, `[product.metafields.app.faq…]`, `[sidekick]` y
     `[access.admin]` en el toml, y las extensiones `extensions/app-home` y
     `extensions/app-tools`. Se borran antes del `deploy` («Extensions: None»
     en el resumen).
   - **Nunca `shopify app dev`** con esta app: cambia las URLs por un túnel
     temporal.
   - **Alcances:** cada uno tiene que poder justificarse en la revisión.
     `write_orders` sirve para corregir la dirección de un pedido ya creado y
     etiquetarlo. Si se cambian, cambiar también `SHOPIFY_CLIENT_APP_SCOPES`.
   - **Distribución**: pública, visibilidad **oculta**. Es definitivo. **No**
     enviar a revisión todavía: falta la segunda parte (anonimizar y entregar
     datos, registro de accesos).
   - **Datos protegidos de clientes** (nombre, teléfono y dirección del
     comprador): se piden aparte, con la justificación «entrega contraentrega».
3. **Variables en Vercel** (Production), copiadas directo del Dev Dashboard,
   nunca por chat ni al repositorio:
   - `SHOPIFY_CLIENT_APP_API_KEY` = Client ID de la app nueva.
   - `SHOPIFY_CLIENT_APP_API_SECRET` = Client secret de la app nueva.
   Sin ellas, la entrada y el callback responden «app no configurada» y los
   avisos de privacidad reciben 401.
4. **Prueba con una tienda de desarrollo** (no con Aurela ni Kenku: esas están
   con la app interna y la app nueva las rechaza a propósito):
   - instalar la app desde el enlace de instalación del Dev Dashboard;
   - Shopify pide autorizar y vuelve a Kapta, que cae en
     `/dashboard/conectar-shopify` con el dominio de la tienda (sin sesión
     abierta, pasa antes por el login y el panel lo devuelve ahí);
   - elegir la organización y «Conectar tienda»: la tienda queda creada, con
     webhooks de pedidos y `app/uninstalled`, y empieza la sincronización;
   - abrir la app otra vez desde el admin de Shopify: entra directo al
     dashboard de esa tienda;
   - desinstalar: la tienda pasa a `disabled`, sin token y con
     `shopify_uninstalled_at`.
5. **Qué mirar después**:
   `select topic, shop_domain, status, received_at from shopify_privacy_requests order by received_at desc limit 20;`
   — cada aviso de privacidad queda `pendiente` hasta la segunda parte. Shopify
   da 30 días para cumplirlos.
6. **Webhook de una tienda cliente** que diga `app/uninstalled` en
   `webhook_events` con la tienda aún activa: el webhook llegó pero no se
   desactivó; revisar la fila de `stores`.

### 11-10-2026 · Recordatorio de recojo, día 3 y día 7 en la agencia (0242, MOM §12)

1. **Migración `0242_pickup_reminder.sql`**, a mano y ANTES del código:
   `psql "$DATABASE_URL" -f db/migrations/0242_pickup_reminder.sql`. Amplía el
   `check` de `shalom_transit_notifications.kind` con `recordatorio_d3` y
   `recordatorio_d7`, añade `shalom_transit_notifications.header_image_url` y
   en `stores` los interruptores (apagados), plantillas, orden de variables e
   imagen de respaldo del recordatorio. Sin ella, los crons de Shalom y Olva
   siguen funcionando y reportan el error en `errors`; no se encola nada.
2. **Las plantillas en Meta**, en la WABA del número de los avisos:
   `guias_shalom_recordatorio` y `guias_olva_recordatorio`, idioma `es`,
   **cabecera de IMAGEN**, cuerpo con cinco variables en este orden: nombre,
   agencia, guía, saldo, fecha límite; y los tres botones de respuesta rápida
   de siempre («Pagar con Yape», «Transferencia / Depósito», «Link de pago»).
3. **Con la plantilla aprobada**, Ajustes → Avisos de guía Shalom →
   «Recordatorio de recojo»: comprobar nombre y orden
   (`nombre,agencia,guia,saldo,vence`), poner una **imagen de respaldo** (JPG o
   PNG por https) para los pedidos sin foto de catálogo, y encender. Lo mismo
   en Avisos de guía Olva cuando su plantilla esté aprobada.
4. **`NEXT_PUBLIC_SITE_URL` tiene que ser la URL pública real**: de ahí sale
   la foto del producto (`/api/wa-image/...`) que Meta baja al enviar.

**Qué mirar después.** El informe de `/api/cron/shalom-reconcile` (y de
`olva-reconcile`) trae `recordatorios: { tiendas, guias, encolados, porTope,
motivos }`. El primer encendido en Kenku tiene ~140 guías por recordar (93
ya en el día 7 o más; medido el 11-10-2026): entran de a 10 por tienda
(`porTope` cuenta las que esperan) y salen con el tope diario de siempre, así
que la tanda tarda uno o dos días. Cada envío queda en
la línea de tiempo («Recordatorio de recojo (día 3)…») y la foto que viajó en
`shalom_transit_notifications.header_image_url`.

### 12-10-2026 · Horas de la semana por asesora (0245)

1. **Migración `0245_advisor_schedules.sql`**, a mano y antes del código:
   `psql "$DATABASE_URL" -f db/migrations/0245_advisor_schedules.sql`. Crea
   `advisor_schedules` (meta de horas por semana, días y horario de cada
   persona; solo el servidor la lee y la escribe). Sin ella, Productividad
   carga igual y usa la meta por defecto (48 h, lunes a sábado, sin horario),
   pero Equipo › Horarios no puede guardar y lo dice. **Ya aplicada en
   producción** el 12-10-2026, pegando el SQL en el editor de Supabase.
2. **Cargar el horario de cada asesora** en Equipo › Horarios (owner o admin):
   meta de la semana, días que trabaja y, si tiene, su horario de entrada y
   salida. Con horario, Productividad marca la primera actividad tarde y la
   última antes de la salida (10 minutos de gracia).

### 12-10-2026 · Agente de voz para leads, piloto Biru (0247, MOM §33)

1. **Migración `0247_voice_lead_calls.sql`**, a mano y ANTES del código:
   `psql "$DATABASE_URL" -f db/migrations/0247_voice_lead_calls.sql`. Agrega a
   `voice_calls` a qué llama cada fila (`purpose`: `order` por defecto, o
   `lead`), `lead_id` y `lead_context`; `order_id` queda nulo solo en las de
   lead; los resultados se validan por carril. Además `leads.contact_opt_out_at`,
   los ajustes `stores.voice_lead_*` (apagados) y el trigger
   `swayp_auto_voice_interlock` solo para llamadas con pedido. **El orden
   importa también para Reproprovincia**: el código nuevo filtra sus llamadas
   por `purpose` (atadura de las tools, tope diario, «Gestión por persona»,
   «Llamando ahora»), y sin la columna esas lecturas fallan y el agente de
   pedidos deja de llamar. **Ya aplicada en producción** el 12-10-2026,
   pegando el SQL en el editor de Supabase (las 1.068 llamadas que había
   quedaron `purpose = 'order'`).
2. **Secretos en Vercel (Production)**. Se generan en tu máquina
   (`openssl rand -hex 24`) y se pegan directo en Vercel y en ElevenLabs:
   **nunca en un chat**, ni en un ticket.
   - `VOICE_LEADS_TOOLS_SECRET`: firma el inicio de conversación y las dos
     tools del agente de leads. **Distinto** de `VOICE_TOOLS_SECRET` y de
     `VOICE_TOOLS_SECRET_ELEVENLABS`: si es igual a uno de ellos, Kapta lo trata
     como vacío y rechaza todo (un secreto compartido abriría las tools de un
     agente al otro).
   - `ELEVENLABS_WEBHOOK_SECRET`: el secreto HMAC que ElevenLabs genera al crear
     el webhook «post-call». Sin él, `/api/voice/elevenlabs/post-call` responde
     401 y no se guardan transcripciones; el resto funciona igual.
3. **El agente en ElevenLabs**: **ya creado** el 12-10-2026 («Agente de leads
   · Kenku Biru (piloto)»), con guion, primer mensaje, las tools
   `consultar_cobertura` y `registrar_resultado_lead`, el webhook de inicio
   (`/api/voice/leads/inicio`) y los ajustes de `docs/voz-leads-agente.md`.
   Se presenta como Nicol. `VOICE_LEADS_TOOLS_SECRET` ya está en Vercel y, como
   secreto del workspace `kapta_voice_leads`, en la cabecera `x-voice-secret`
   de las dos tools y del inicio (12-10-2026). Falta, si se quiere, el
   post-call. **Guion con `{{aviso}}`** (13-10-2026): va en la rama
   `sin-ficha-por-regla` del agente y se une a la principal **después** del
   deploy que manda la variable `aviso` desde `/api/voice/leads/inicio`
   (`docs/voz-leads-agente.md` §3). **Hecho el 13-10-2026**, con el deploy de
   #946 ya en producción.
4. **El número**, después del agente: un número propio del agente de leads
   importado en ElevenLabs por SIP trunk, aceptando solo las direcciones de
   Telnyx (`192.76.120.0/24`, `64.16.250.0/24`), y asignado al agente de leads.
   **Hecho el 12-10-2026**: el +1 645 654 0729, comprado en Telnyx, importado
   como «Nicol Leads Telnyx» (solo entrada, cifrado de medios «Allowed», sin
   usuario ni contraseña), igual que el número de Reproprovincia. Recién
   entonces, en Vercel, y redeploy:
   - `TELNYX_LEADS_SIP_URI`: la puerta SIP de ese número, con el formato de
     `TELNYX_ELEVENLABS_SIP_URI`
     (`sip:+16456540729@sip.rtc.elevenlabs.io:5061;transport=tls`). **Puesta
     el 12-10-2026.** Sin ella no se llama a ningún lead: el aviso de Telnyx
     corta el tramo, nunca lo manda al agente de Reproprovincia.
   - `TELNYX_LEADS_FROM_NUMBER` (opcional): el número que ve el lead. Vacío =
     el mismo `TELNYX_FROM_NUMBER` de Reproprovincia, que es como sale el
     piloto mientras llega el número peruano (decisión del owner, 12-10-2026).
     El +1 645 de la puerta no va aquí: el lead nunca lo ve.
   - **Ya en producción**: la variable se puso a las 16:51 y los deploys de
     main de las 17:00 y las 17:08 (12-10-2026) ya la leen. Si Ajustes todavía
     dice «Falta preparar la línea del agente», redeploy.
5. **El barrido** `/api/cron/voice-leads` ya está en `vercel.json` (cada cinco
   minutos, desfasado dos del de Reproprovincia). Solo corre en producción y
   sin tiendas con el agente encendido no hace nada. La cola se mira sin llamar
   ni escribir con
   `GET /api/cron/voice-leads?dry=1&storeId=<uuid>` y
   `Authorization: Bearer <CRON_SECRET>`: la mira como si el agente estuviera
   encendido y devuelve cuántos entran y cuántos quedan fuera por cada motivo.
6. **Encendido por tienda** (Ajustes → «Agente de voz · Leads (piloto)»),
   con la puerta del paso 4 ya en producción, en este orden: campaña, producto
   y oferta; «Probar en mi teléfono» desde el drawer de un lead; el porcentaje de control (queda fijo en el primer
   sorteo); y recién entonces «Agente de leads» y «Llamadas automáticas». Los
   pasos completos y la campaña de Biru están en `docs/voz-leads-agente.md`.

**Marcha atrás.** Apagar «Llamadas automáticas» (o «Agente de leads») detiene
el barrido. El sorteo del grupo de control queda guardado y nada se borra.

**Qué mirar después.** Cada pasada escribe una línea `[voice-leads] {…}` en los
logs de Vercel, sin nombres ni teléfonos: qué hizo cada tienda (`llamada`,
`cola_vacia`, `fuera_de_horario`, `tope_diario`, `agente_ocupado`,
`sin_configurar`, `manual`, `apagado`, `error`), el tamaño de la cola, las exclusiones por motivo, los
brazos sorteados y los «Atender ahora» repuestos. El tablero del piloto está en
la misma sección de Ajustes.

### 12-10-2026 · Distritos sin el «de» (0246) y «Sacar con salida nueva» (0248, `mom-v1.26`)

1. **Migración `0246_district_aliases_sin_de.sql`**, a mano, antes o después
   del código: `psql "$DATABASE_URL" -f db/migrations/0246_district_aliases_sin_de.sql`.
   Solo redefine `lima_district_aliases()` («San Juan Lurigancho», «Pachamamac»,
   «Cercado delima»…). La cola de Grupo GF usa los alias de TypeScript y se
   desbloquea con el despliegue; la base los usa en la cobertura y en el pago
   del motorizado en vivo. **Ya aplicada en producción** el 12-10-2026.
2. **Migración `0248_gf_replace_output.sql`**, a mano y ANTES del código:
   `psql "$DATABASE_URL" -f db/migrations/0248_gf_replace_output.sql`. Crea
   `gf_output_replaced` y `gf_replace_output`, redefine `gf_return_to_office`
   (la 0206 más la rama «a stock») y `gf_carry_over` (la 0234 sin la caja
   reemplazada —por su evento— y con los candados del lote primero), y crea
   los triggers
   `delivery_stops_guard_replaced` y `dispatch_items_guard_replaced_route`. Sin
   ella, «Sacar con salida nueva» falla y deshace la salida nueva que había
   creado: no deja salidas huérfanas. **Ya aplicada en producción** el
   12-10-2026, antes del código. En el historial de Supabase figura dos veces:
   `0247_gf_replace_output` y, al renumerarla tras llegar a `main` la
   `0247_voice_lead_calls`, `0248_gf_replace_output` (la misma, idempotente;
   solo cambia el número en los comentarios); sin efecto sobre el código anterior (en
   producción no había ninguna salida propia en `retorno` ni devuelta dentro
   de una caja).
3. **Después del despliegue**, el cron recalcula el Master por la versión
   `mom-v1.26`. Con la foto del 12-10-2026 no hay ninguna salida reemplazada
   (`output_replaced`); cambian pocos pedidos: los que tienen una parada del
   cuaderno anterior a la salida a la que se atribuía.

### 12-10-2026 · Repro Lima y fecha que pidió el cliente (0251)

Se escribió como `0249` y pasó a `0251` al traer main: la `0249` es la app de
Shopify para tiendas cliente y la `0250`, los roles que se acumulan.

1. **Migración `0251_lima_repro.sql`**, a mano y ANTES del código:
   `psql "$DATABASE_URL" -f db/migrations/0251_lima_repro.sql`. Agrega
   `delivery_stops.requested_date` con el CHECK
   `delivery_stops_requested_date_ck` (la fecha solo existe en un «No
   entregado · Reprogramado»), crea `lima_repro_cases` y `lima_repro_calls`
   (lectura por tienda, escritura solo del servidor, llamadas append-only) y
   las RPC `lima_repro_claim` y `lima_repro_record`. **El orden importa**: el
   código nuevo lee `requested_date` en `STOP_COLUMNS`
   (lib/routes-access.ts). Sin la columna, `getRouteDetail` devuelve la ruta
   **vacía y sin ningún error** (`stopRows ?? []`): /reparto, Coordinación,
   «Reparto y liquidación» de Despacho del día y Rutas muestran rutas sin
   paradas, y todo reporte de parada falla. Repro Lima tampoco puede tomar un
   caso. `lima_repro_claim` lleva `p_reopen` (el segundo clic de «Volver a
   atender», MOM §9.5) y el código lo manda siempre. La migración no lleva
   ningún `drop`: con uno, `apply_migration` de Supabase se queda esperando
   hasta cortarse a los 60 s sin aplicar nada (pasó con la 0248 y con el
   primer intento de esta). Los triggers son `create or replace` y las
   políticas se crean si faltan; el archivo es idempotente. Una base de prueba
   que tuviera la firma de seis parámetros (sin `p_reopen`) la borra a mano
   antes de correrlo.
   **Ya aplicada en producción el 13-10-2026** (historial
   `20261013024826 0251_lima_repro`, con `set local lock_timeout = '15s'`
   delante). Los cuerpos de `lima_repro_claim` y `lima_repro_record` son los
   del archivo (md5 igual), el CHECK quedó validado sobre las 5664 paradas y
   el código anterior sigue funcionando: no escribe `requested_date`.
2. Sin subir versión ni recálculo: el resolver no lee nada de esto
   (`MOM_RESOLUTION_VERSION` sigue en `mom-v1.26`). Los casos nacen solos al
   primer gesto en Repro Lima: no hay backfill.
3. **Qué mirar después**:
   - el reporte del motorizado ya no programa. Ningún `dispatch_programmed`
     nuevo con el motivo del reporte:
     `select count(*) from order_events where kind = 'dispatch_programmed' and payload->>'reason' like 'Reprogramado por el cliente (reporte%' and occurred_at > '<hora del despliegue>';`
     tiene que dar 0. Los programas que ya creó #908 se respetan: salen en
     «Por decidir» como «Fecha del motorizado sin confirmar»;
   - Por decidir + Llamar después + Programados + Cerrados ≈ el mosaico «Por
     reprogramar Lima» del Master;
   - el primer programa con motivo «Repro Lima:» aparece en «Programados» de
     Despacho del día.
4. **Marcha atrás**: PRIMERO
   `alter table public.delivery_stops drop constraint if exists delivery_stops_requested_date_ck;`
   y DESPUÉS revertir el código. El `writeStopReport` anterior no conoce
   `requested_date`: al pasar una parada con fecha de «Reprogramado» a
   «Entregado» o a otro motivo violaría el CHECK y el reporte fallaría. Las
   tablas, las RPC y la columna no molestan al código anterior y se quedan.

### 13-10-2026 · Repro Lima, entrega 1c: «Reintentos por salir» en Almacén

Entrega 1c: sin migración. La última sigue siendo la 0251; no hay variables de
entorno ni RPC nuevas, y `MOM_RESOLUTION_VERSION` sigue en `mom-v1.26`. El
apartado solo lee (MOM §9.5): no programa, no cierra casos ni escribe eventos.
La página no lo lee al pintar en el servidor: la estación lo pide después de
cargar, y mientras llega la tarjeta se ve en esqueleto.

1. **Qué mirar después**, solo lectura: sin casos de Repro Lima, los programas
   de pedidos de la etapa con fecha de mañana o anterior son las filas de la
   lista. El 13-10-2026 eran 6, todas en la zona «Hoy» y vencidas, con la
   chapa roja «Vencido · era para el …»:
   `select count(*) from gf_dispatch_programs p join order_master m on m.order_id = p.order_id where m.macro_stage = 'en_curso' and m.macro_substage = 'por_reprogramar_lima' and p.scheduled_for <= '<mañana>';`
2. **Antes del primer día** (plan del 11-10-2026): contar las cajas reales del
   estante y rotular las bandejas fijas, una por día de recepción y una «sin
   fecha / más de 7 días».
3. **Despacho GF** limpia los programas viejos con «Quitar la fecha»: el
   13-10-2026, 13 de 14 estaban vencidos y 6 estaban en pedidos fuera de la
   etapa.

### 14-10-2026 · Repro Lima «Todos» (0256)

Una quinta tarjeta en Repro Lima, «Todos · por entregar»: los pedidos de Lima
sin estado final por etapa y subetapa del Master (MOM §9.5). Solo lee: no
escribe, no abre casos ni toma el candado. Sin variables de entorno nuevas.

1. **Migración `0256_lima_open_counts.sql`**, a mano y ANTES del código:
   `psql "$DATABASE_URL" -f db/migrations/0256_lima_open_counts.sql`. Crea una
   sola función, `order_master_lima_open_counts(uuid[], date)`: los pedidos de
   `order_master` con `coverage = 'lima'` y sin «Finalizado», agrupados por
   tienda, macroetapa y subetapa, con cuántos llevan más de 7 y de 30 días de
   Lima desde `macro_since`. `security invoker` y solo para `service_role`
   (revocada a `public`, `anon` y `authenticated`). Sin índice nuevo (usa
   `order_master_store_coverage_idx`, unos 18 ms sobre ~8,3k filas) y sin
   ningún `drop` ni `begin`/`commit`: es `create or replace` y se puede
   repetir. Se aplica también con `apply_migration` de Supabase.
   **Ya aplicada en producción el 14-10-2026** (historial
   `20261014131234 0256_lima_open_counts`). Comprobado ese día: 8.358 pedidos (1.968 por
   entregar y 6.390 por cerrar), y `anon` y `authenticated` no la pueden
   ejecutar.
2. **Comprobar en producción**, solo lectura:
   - `select sum(total) from order_master_lima_open_counts(array(select id from stores)::uuid[], (now() at time zone 'America/Lima')::date);`
     da unos 8,3k (el 14-10-2026: 1.940 por entregar y 6.393 por cerrar);
   - `select has_function_privilege('authenticated', 'public.order_master_lima_open_counts(uuid[], date)', 'execute');`
     tiene que dar `false` (y lo mismo con `anon`).
3. Sin backfill, sin cambio del resolver y sin subir versión:
   `MOM_RESOLUTION_VERSION` sigue en `mom-v1.26`.
4. **Si el código sale antes que la migración**, la tarjeta «Todos» no
   aparece y el resto de Repro Lima sigue igual. En los logs de Vercel se ve
   `repro-lima: conteo de Todos` con el código del error (`PGRST202`: falta la
   función). Aplicar la migración y la tarjeta aparece en la siguiente carga.
5. **Antes de subir**: `npm test`, `npm run typecheck`,
   `bash scripts/verify-db.sh` (clúster desechable) y `next build`. A mano a
   360, 768 y 1280 px: en el teléfono las cuatro listas en 2×2 y «Todos» en
   una fila entera debajo; desde 1024 px, la quinta columna; nada se desplaza
   de lado; y «Atrás» desde el Master vuelve a «Todos» (`?vista=todos`).

**Marcha atrás.** Revertir el código basta. La función no molesta al código
anterior y se queda.

### 14-10-2026 · Comprobantes SimpleFact por RUC (MOM §35) — needs migrations 0257, 0260, 0261 and 0262

Kapta emite, en la cuenta de SimpleFact de la empresa que recibió el dinero, la
boleta de un pedido ya cobrado: un RUC por cuenta de cobro (MOM §35). **Sale
apagado**: la 0257 da de alta GRUPO GF S.A.C. (RUC 20556792829, subdominio
`grupogf`) en «Apagado» y sin token, y mientras todos los RUC estén apagados el
barrido no lee pedidos ni llama a SimpleFact. **Sin variables de entorno
nuevas**: el token se cifra con la misma `ENCRYPTION_KEY` de los tokens de
tienda y el cron usa `CRON_SECRET`. Lo que solo pasa en producción —el barrido
que emite y «Emitir esta boleta»— lo decide `VERCEL_ENV`, que pone Vercel. Sin
cambio del resolver: `MOM_RESOLUTION_VERSION` sigue en `mom-v1.26`.

**15-10-2026 · el modo «Manual» (0261).** Decisión del owner: un paso a mano
entre la simulación y lo automático. En «Manual» el barrido solo simula, y quien
tiene «Boletas y facturas» emite pedido por pedido con «Emitir esta boleta» en
el panel «Comprobante» del drawer, con los mismos candados que el barrido en
Real (MOM §35.7). El encendido pasa a ser Simulación → Manual (las primeras
boletas reales, una a una, revisadas en SimpleFact) → Real (pasos 7, 9 y 10).
**Producción al 15-10-2026**: la 0257 y la 0260 aplicadas, GRUPO GF S.A.C. en
«Simulación» con el token probado y ningún comprobante. La 0261 y la 0262 son
nuevas y van en los pasos 3 y 4, en ese orden y antes del código.

**15-10-2026 · la revisión de «Emitir esta boleta» (0262).** Una boleta enviada
no se borra, así que se cerró lo que podía mandar una que nadie pidió:
- el turno vuelve a revisar, en la base, que la empresa recibió el pago: que
  lo validado cubre el total, o que el prepago web lo es de verdad, y que los
  pagos del comprobante siguen validados (`sin_pago_completo`,
  `prepago_con_comprobantes`), con los pagos del pedido bloqueados mientras
  dura (0262, paso 4; MOM §35.3 y §35.4);
- lo que se envía es lo que la persona confirmó: `emitInvoiceNow` compara el
  RUC y el total confirmados con su propia lectura, la misma con que arma la
  boleta (`pedido_cambio`, MOM §35.7);
- solo producción emite: en una vista previa —que comparte la base y la llave
  de cifrado— no hay botón, ni en el panel ni en Ajustes, y la acción lo
  rechaza antes de leer nada (MOM §35.7);
- un `en_duda` se libera recién 30 minutos después de quedar en duda; registrar
  su serie sigue siendo inmediato (MOM §35.4);
- en Ajustes, lo que contestó «Emitir» se queda a la vista después del
  refresco de la página (MOM §35.7).

1. **Migración `0257_invoices.sql`.** **Ya aplicada en producción el
   14-10-2026**: no se vuelve a pegar ni se edita. Lo que cambió después —los
   arreglos de la revisión adversaria— va en la 0260 (paso 2): producción no
   vuelve a correr la 0257, y lo que se le escribiera nunca le llegaría. En una
   base nueva se aplica a mano y ANTES del código: pegar el archivo en el
   editor SQL de Supabase (o
   `psql "$DATABASE_URL" -f db/migrations/0257_invoices.sql`). Crea
   `invoice_issuers`, `store_collection_accounts.invoice_issuer_id` (con el
   trigger que rechaza un RUC de otra organización), `order_invoices` (con el
   índice de un solo comprobante real vivo por pedido y el trigger que no deja
   editar ni borrar lo emitido), `invoice_order_checks`, la función
   `invoice_claim` (el turno), y siembra GRUPO GF S.A.C. Las tres tablas quedan
   sin policies y revocadas a `anon` y `authenticated`, y el turno solo lo
   ejecuta `service_role`: solo lo usa el servidor.
   Es idempotente, y la semilla no pisa una asignación que el owner ya haya
   cambiado. El `alter table` y los `drop trigger` sobre
   `store_collection_accounts` toman un candado breve de esa tabla: si se queda
   esperando, cortar y repetir con `set lock_timeout = '15s';` delante.
   **Comprobar**, solo lectura:
   - `select ruc, legal_name, simplefact_subdomain, mode, token_enc is null as sin_token, emit_from, daily_limit from invoice_issuers;`
     — recién aplicada, una fila por organización que cobra en la cuenta
     ···309: `20556792829`, `grupogf`, `apagado`, `sin_token = true`, sin
     «Emitir desde» y tope 40;
   - `select s.name, a.label, a.phone_last_digits, i.ruc from store_collection_accounts a join stores s on s.id = a.store_id left join invoice_issuers i on i.id = a.invoice_issuer_id order by s.name, a.label;`
     — en cada tienda de esa organización, **dos** cuentas con `20556792829`:
     «Grupo GF S.A.C.» ···309 y «Aurela Kenku» (la pasarela Flow, sin
     celular). Las cuentas personales de los dueños, con `ruc` nulo;
   - `select has_table_privilege('authenticated', 'public.invoice_issuers', 'select');`
     tiene que dar `false` (y lo mismo con `anon`, `order_invoices` e
     `invoice_order_checks`);
   - `select has_function_privilege('authenticated', 'public.invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb)', 'execute');`
     tiene que dar `false` (y lo mismo con `anon`). Esa firma de nueve
     argumentos existe hasta la 0261, que la borra: después se comprueba la de
     once (paso 3).
2. **Migración `0260_invoices_hardening.sql`**, a mano, sobre la 0257 y ANTES
   de que el código con `invoice_candidates` llegue a `main`. **Ya aplicada en
   producción**: no se vuelve a pegar ni se edita. En una base nueva: pegar el
   archivo en el editor SQL de Supabase (o
   `psql "$DATABASE_URL" -f db/migrations/0260_invoices_hardening.sql`). Son los
   arreglos de la revisión adversaria (MOM §35.3, §35.4 y §35.6), que se habían
   escrito dentro de la 0257 cuando esta ya había corrido en producción.
   Escribe las funciones `invoice_claim` (el turno) e `invoice_candidates` (qué
   pedidos mira el barrido), y las de los triggers `invoice_issuers_touch` y
   `order_invoices_guard`:
   - `invoice_claim`: el turno vuelve a sacar de los pagos de la base cuándo
     quedó pagado el pedido, y no da el turno con un pago vivo sin validar
     (`pagos_en_revision`) ni con una fecha anterior a «Emitir desde»
     (`antes_de_inicio`);
   - `invoice_candidates`, nueva: los pedidos que el barrido revisa en cada
     pasada; solo la ejecuta `service_role`;
   - `invoice_issuers_touch`: un token, un subdominio o un RUC nuevo borra
     también el motivo de la prueba anterior (`check_error`);
   - `order_invoices_guard`: borrar la cuenta de una persona deja en blanco
     quién registró, pidió el reintento o resolvió, y solo dentro de esa
     cascada.

   Solo `create or replace function` y sus permisos: no toca datos (el RUC en
   simulación, sus cuentas y los comprobantes quedan como están), no recrea
   triggers (siguen llamando a las mismas funciones) y no toma candados de
   tablas. Es idempotente. Se puede aplicar ya, con el código que hoy está en
   producción: ese código pide el mismo turno, con los mismos parámetros, y ya
   conoce `pagos_en_revision` y `antes_de_inicio`; `invoice_candidates` no la
   llama. **Si el código llega antes, el barrido dice `sin_migracion` y no
   simula ni emite nada hasta aplicarla**: cada pasada responde 200 con
   `"skipped":"sin_migracion"`, sin errores, y el panel «Comprobante» y Ajustes
   se ven como siempre. Aplicada, la pasada siguiente sigue sola.
   **Comprobar** (en una base nueva, recién aplicada), solo lectura:
   - `select to_regprocedure('public.invoice_candidates(uuid, text, timestamptz, integer, text[], uuid)') is not null;`
     tiene que dar `true`;
   - `select pg_get_functiondef('public.order_invoices_guard()'::regprocedure) like '%pg_trigger_depth()%';`
     tiene que dar `true` (y lo mismo con
     `pg_get_functiondef('public.invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb)'::regprocedure) like '%pagos_en_revision%'`
     y con
     `pg_get_functiondef('public.invoice_issuers_touch()'::regprocedure) like '%check_error := null%'`).
     La del turno, con la firma de nueve argumentos, sirve solo antes de la
     0261: después esa firma no existe y la consulta falla («does not exist»);
     se comprueba la de once, que también trae `pagos_en_revision` (paso 3);
   - `select has_function_privilege('authenticated', 'public.invoice_candidates(uuid, text, timestamptz, integer, text[], uuid)', 'execute');`
     tiene que dar `false` (y lo mismo con `anon`);
   - `select ruc, mode, emit_from, checked_ruc, check_error from invoice_issuers;`
     y `select count(*) from order_invoices;` dicen lo mismo que antes de
     aplicarla.
3. **Migración `0261_invoices_manual.sql`**, a mano, sobre la 0260 y ANTES de
   que el código con «Manual» (el que pide el turno con `p_mode` y
   `p_created_by`) llegue a `main`: pegar el archivo en el editor SQL de
   Supabase, que la corre entera en una transacción (con `psql`, siempre con
   `-1`: `psql -1 "$DATABASE_URL" -f db/migrations/0261_invoices_manual.sql`;
   sin `-1` cada sentencia va sola y hay un instante sin `invoice_claim` entre
   el `drop` de la firma vieja y el `create` de la nueva).
   Trae el modo «Manual» (MOM §35.8):
   - `invoice_issuers_mode_check` (ahora con nombre) admite `manual`, y
     `invoice_issuers_real_ready` le exige a Manual lo mismo que a Real: token,
     «Emitir desde» y una prueba de conexión que leyó el mismo RUC;
   - `invoice_issuers_touch`: un token, un subdominio o un RUC nuevo, o una
     prueba repetida que no confirma el RUC, baja Manual a Simulación, como
     baja Real;
   - `invoice_claim` con dos argumentos nuevos, con valor por defecto:
     `p_mode` (la fila que se pide: `simulacion`, `real` o nulo) y
     `p_created_by` (quién pulsó «Emitir esta boleta»). Sin `p_mode`, lo de
     siempre; con un modo en que el RUC no está, `modo_distinto`; con el RUC en
     Manual, una fila real solo con quién la pidió. El tope del
     día cuenta las filas del modo pedido. Borra la firma de nueve argumentos y
     crea la de once, solo para `service_role`.

   No toca filas: el RUC sigue en Simulación y nada pasa a Manual solo. Es
   idempotente, y el editor SQL la corre en una sola transacción. Los dos
   CHECK toman un candado breve de `invoice_issuers`: si se queda esperando,
   cortar y repetir con `set lock_timeout = '15s';` delante. **Se puede
   aplicar ya, con el código que hoy está en producción**: ese código pide el
   turno con los nueve argumentos de siempre, por nombre, y los dos nuevos
   quedan en nulo —el turno hace lo de antes—; no conoce «Manual», así que no
   deja elegirlo ni barre un RUC en Manual. **Si el código llega antes que la
   0261, no se emite nada de más y nada se pone rojo**: la base no admite
   Manual y Ajustes lo dice al intentar el cambio («La base todavía no admite
   el modo Manual: falta aplicar la migración 0261.»); sin un RUC en Manual no
   hay botón, y el barrido de Simulación y de Real pide el turno como siempre,
   sin `p_mode`, contra el de la 0260, y sigue igual. Si aun así algo pidiera
   el turno con `p_mode` o `p_created_by`, no se reserva ni se envía nada:
   «Emitir esta boleta» contesta «Falta aplicar la migración 0261 de
   comprobantes (invoice_claim con p_mode y p_created_by).», y el barrido,
   `"skipped":"sin_migracion"`. **Comprobar**, solo lectura:
   - `select to_regprocedure('public.invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid)') is not null, to_regprocedure('public.invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb)') is null;`
     tiene que dar `true` y `true`: queda solo el turno de once argumentos;
   - `select pg_get_functiondef('public.invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid)'::regprocedure) like '%modo_distinto%';`
     tiene que dar `true` (y lo mismo con `like '%pagos_en_revision%'`, que
     trae de la 0260, y con
     `pg_get_functiondef('public.invoice_issuers_touch()'::regprocedure) like '%(''real'', ''manual'')%'`);
   - `select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.invoice_issuers'::regclass and conname in ('invoice_issuers_mode_check', 'invoice_issuers_real_ready') order by 1;`
     — dos filas, y las dos nombran `'manual'`;
   - `select has_function_privilege('authenticated', 'public.invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid)', 'execute');`
     tiene que dar `false` (y lo mismo con `anon`; con `service_role`, `true`);
   - `select ruc, mode, emit_from, checked_ruc, check_error from invoice_issuers;`
     y `select count(*) from order_invoices;` dicen lo mismo que antes de
     aplicarla.
4. **Migración `0262_invoices_claim_coverage.sql`**, a mano, DESPUÉS de la 0261
   y ANTES de la primera boleta real: antes de pulsar «Emitir esta boleta» y
   antes de pasar un RUC a «Real». Pegar el archivo en el editor SQL de
   Supabase, que la corre en una transacción (con `psql`:
   `psql -1 -v ON_ERROR_STOP=1 "$DATABASE_URL" -f db/migrations/0262_invoices_claim_coverage.sql`).
   Cambia solo `invoice_claim` (MOM §35.3 y §35.4), con `create or replace` y
   la misma firma de once argumentos de la 0261: la misma función, con sus
   permisos y sus valores por defecto. Lo nuevo:
   - justo después de `pagos_en_revision`, el turno revisa con los pagos y el
     pedido guardados que la empresa recibió el pago: sin prepago, que lo
     validado cubra el total que se va a emitir (`sin_pago_completo`); con
     prepago, que no quede un pago vivo (`prepago_con_comprobantes`) y que el
     pedido sea de verdad un prepago web —pagado, por el checkout y sin
     reembolsos— (`sin_pago_completo`); y en los dos, que cada pago de la base
     del comprobante siga validado y sea de ese pedido (`sin_pago_completo`);
   - bloquea los pagos del pedido (`for share`) mientras dura el turno: quien
     rechace u observe un pago de ese pedido en ese instante espera a que el
     turno termine.

   No toca filas, ni triggers, ni otra función, y no toma candados de tablas.
   Es idempotente. **Va después de la 0261**: si sigue el turno de nueve
   argumentos, o falta el de once, se detiene con «La 0262 va después de la
   0261: aplica primero db/migrations/0261_invoices_manual.sql.» y no cambia
   nada. **Si alguien vuelve a correr la 0261 después, hay que volver a correr
   la 0262**: la 0261 reescribe el turno sin esta revisión, y nada lo avisa.
   **Con la 0269 aplicada, lo que se vuelve a correr después de la 0261 es la
   0269 (no la 0262)**: la 0262 pasaría su guarda y dejaría los dos turnos, el
   de once y el de doce, y la llamada por nombre del código seguiría fallando
   (sección «15-10-2026 · 0269», más abajo).
   **Se puede aplicar ya, con el código que hoy está en producción** (con la
   0261 delante): ese código pide el turno con los nueve argumentos por nombre
   y ya manda en `p_basis` si es prepago web y el id de cada pago, que es lo
   que el turno revisa: lo bien pagado sigue dando su fila. **Si el código
   llega antes que la 0262, nada se pone rojo y nada lo avisa**: el código no
   la nombra, el barrido y «Emitir esta boleta» siguen como con la 0261, y el
   turno no vuelve a revisar el pago; un pago rechazado mientras se relee
   Shopify se colaría en una boleta real. Por eso no se pulsa «Emitir esta
   boleta» ni se pasa un RUC a «Real» hasta aplicarla (en «Simulación», a lo
   más queda la simulada de un pedido que dejó de estar pagado).
   **Comprobar**, solo lectura:
   - `select pg_get_functiondef('public.invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid)'::regprocedure) like '%sin_pago_completo%';`
     tiene que dar `true` (y lo mismo con `like '%for share%'`); con solo la
     0261, da `false`;
   - `select count(*) from pg_proc where proname = 'invoice_claim' and pronamespace = 'public'::regnamespace;`
     tiene que dar `1`: un solo turno;
   - `select has_function_privilege('authenticated', 'public.invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid)', 'execute');`
     tiene que dar `false` (y lo mismo con `anon`; con `service_role`, `true`);
   - `select ruc, mode, emit_from, checked_ruc, check_error from invoice_issuers;`
     y `select count(*) from order_invoices;` dicen lo mismo que antes de
     aplicarla.
5. **Desplegar.** El cron `/api/cron/invoices` ya está en `vercel.json`, cada
   10 minutos (`6,16,26,…`), y solo emite en producción. «Emitir esta boleta»
   y el «Emitir» de Ajustes, tampoco fuera de ella: una vista previa comparte
   la base y `ENCRYPTION_KEY` con producción, y desde ella saldría una boleta
   real. En una vista previa el panel no tiene el botón y, donde lo habría,
   dice «Emitir solo funciona en producción: este despliegue es una vista
   previa.»; Ajustes no ofrece «Emitir» y, con un RUC en «Manual», dice lo
   mismo; y la acción lo rechaza antes de leer nada. Con todos los RUC en
   «Apagado» cada pasada deja en los logs de Vercel una línea `[invoices] {…}`
   con `"skipped":"sin_ruc_encendido"`, y no lee pedidos ni llama a SimpleFact.
   **Si el código sale antes que las migraciones** no se emite nada y el cron
   no se pone rojo: cada pasada responde 200 con `"skipped":"sin_migracion"`
   en la línea `[invoices] {…}`. Sin la 0257, además, el panel «Comprobante»
   del drawer no aparece y Ajustes dice «No se pudieron leer los RUC de la
   organización.»; sin la 0260, el panel y Ajustes se ven, pero el barrido no
   simula ni emite; sin la 0261, ver el paso 3, y sin la 0262, el paso 4.
   Aplicar lo que falte y la pasada siguiente pasa a `sin_ruc_encendido`, o
   barre los RUC encendidos.
   Solo cuenta como `sin_migracion` lo que crean la 0257 y la 0260: si lo que
   falta es otra tabla o función (`orders`, `order_payments`, `order_master`…),
   el cron responde 502 con el error en `errors`, y eso no se arregla aplicando
   una migración de comprobantes: la base está rota y hay que mirarla.
6. **El token: lo pone el owner, y solo en Ajustes.** Regenerar en SimpleFact
   el token de la cuenta `grupogf`: **el anterior quedó expuesto en una captura
   y no se usa**. Pegar el nuevo **solo** en Ajustes de la tienda → «Boletas y
   facturas» (pide `stores.manage` y `invoices.manage`, que solo da el owner):
   nunca en un chat, un ticket, Vercel ni el editor SQL. Ajustes solo dice
   «Configurado». Pulsar «Probar conexión»: lee las ventas de la cuenta, no
   emite nada, y tiene que confirmar el RUC 20556792829. Si dice otro RUC, el
   token es de otra empresa; si dice que la cuenta no tiene ventas con
   archivos, no se puede pasar a Manual ni a Real hasta que tenga una.
7. **Simulación.** Poner el RUC en «Simulación» con «Emitir desde» de hoy (si
   quedó atrás, la base la mueve sola al momento del cambio). Cada pasada arma
   la boleta exacta de cada pedido que entraría y la guarda como `simulada`,
   hasta el tope del día, **sin llamar a SimpleFact**. Revisar unos días, en
   Ajustes (lo de hoy y los últimos comprobantes) y en el panel «Comprobante»
   del drawer: el RUC, los ítems, el total y los motivos de lo que no entró.
   En SQL, solo lectura:
   - `select status, count(*) from order_invoices where mode = 'simulacion' group by 1;`
   - `select reason, count(*) from invoice_order_checks where mode = 'simulacion' group by 1 order by 2 desc;`
   - `select order_name, total, request->>'notes', request->'items' from order_invoices where mode = 'simulacion' order by created_at desc limit 10;`

   **Los prepagos web por Flow tienen que salir** (MOM §35.9): Kapta nunca vio
   el texto que pone Shopify en la pasarela de una transacción de Flow. Si
   hubo prepagos web desde «Emitir desde» y ninguno sale como `simulada` —todos
   quedan en `pago_web_no_confirmado`—, ese texto es otro: se ajusta la regla
   (`lib/invoicing/shopify-order.ts`) antes de pasar a Manual. Solo lectura:
   - `select count(*) from order_invoices i join order_master m on m.order_id = i.order_id where i.mode = 'simulacion' and m.payment_gateway = 'checkout';`
   - `select c.reason, count(*) from invoice_order_checks c join order_master m on m.order_id = c.order_id where c.mode = 'simulacion' and m.payment_gateway = 'checkout' group by 1 order by 2 desc;`
8. **Con el contador**: confirmar que una boleta hasta S/ 700 va a «CLIENTES
   VARIOS» con DNI `00000000`, sin correo ni celular, y el umbral de S/ 700:
   por encima, la boleta se emite a mano con el DNI y se registra en el panel
   con «Ya tiene comprobante» (MOM §35.5).
9. **Manual: las primeras boletas reales, una a una** (MOM §35.7). Pasar el
   RUC a «Manual» en Ajustes. La base lo rechaza sin token, sin «Emitir desde»
   o sin una prueba de conexión que leyó el mismo RUC, y «Emitir desde» se
   mueve al momento del cambio: el barrido no emite nada pagado antes. Un
   pedido pagado desde el 01/10/2026 y antes de ese momento solo sale con
   «Emitir esta boleta» y la casilla «Revisé en SimpleFact y este pedido no
   tiene boleta» (sección «15-10-2026 · 0269», más abajo). El barrido sigue
   simulando, nunca le pide a SimpleFact una venta, y concilia lo que quede en
   duda. Antes, la 0262 aplicada (paso 4). Para emitir, en producción —una
   vista previa no emite (paso 5)—: abrir el pedido, panel «Comprobante»,
   «Emitir esta boleta» (o «Emitir» en su simulada, en Ajustes → últimos
   comprobantes); leer la confirmación —el total, «CLIENTES VARIOS» y el RUC—
   y pulsar «Sí, emitir». Pide `invoices.manage`, que solo da el owner. Si el
   pedido cambió desde que se abrió (el RUC o el total), no emite y pide
   volver a abrirlo. En Ajustes, lo que contesta se queda a la vista después
   del refresco de la página, y ese pedido no vuelve a tener «Emitir»: para
   intentar otra vez se abre el pedido. Revisar cada boleta en SimpleFact
   **antes de emitir la siguiente**: serie, total, ítems con el IGV incluido y
   la nota «Pedido #KP… · Kapta ‹ref›». En Kapta, solo lectura:
   `select status, ruc_mismatch, created_by is not null as con_quien, count(*) from order_invoices where mode = 'real' group by 1, 2, 3;`
   — en Manual, toda boleta real con `con_quien = true` (la pidió una
   persona), nada en `emitiendo` por más de unos minutos, ningún
   `ruc_mismatch`, y cada `en_duda` conciliado solo o revisado por una persona
   (MOM §35.4). Un `en_duda` con «Sin respuesta de SimpleFact: búscala por su
   nota…» lo dejó así la pasada porque nadie lo iba a conciliar. **Un
   `en_duda` se busca en SimpleFact por su nota «Kapta ‹ref›» antes de
   tocarlo**, y se resuelve en el panel «Comprobante» del pedido (pide
   `invoices.manage`):
   - **Si está**, «Sí está en SimpleFact: registrar su serie», con la serie y
     el número con que salió (`B…` si es boleta) y dónde se encontró. Queda
     `emitida` y Kapta no emite otra. No se corrige después: revisar la serie
     antes de confirmar.
   - **Si no está**, «No está en SimpleFact: volver a intentar», con lo que se
     revisó, y solo pasados 30 minutos desde que quedó en duda: SimpleFact
     puede tardar en listar una boleta que sí recibió. Hasta entonces el botón
     está deshabilitado y el panel dice desde qué hora («Podrás liberarla
     desde las ‹HH:MM› (hora de Lima)…»), y el servidor tampoco la libera; «Sí
     está…» no espera. Pasa a `error`. En Manual la pasada no lo vuelve a
     intentar: vuelve el botón, y se emite otra vez con «Emitir esta boleta».
     En Real lo vuelve a intentar la pasada siguiente, si el pedido sigue
     cumpliendo las reglas.
     **Liberar una que existe es emitir otra**: ante la duda, se busca de
     nuevo y no se libera.
10. **Real.** Pasar el RUC a «Real»: desde entonces el barrido emite solo y el
   botón desaparece. La base pide lo mismo que para Manual, y «Emitir desde»
   se mueve al momento del cambio: **lo pagado durante Manual que nadie emitió
   con el botón no sale en Real**. Se emite antes de cambiar, o a mano en
   SimpleFact y se registra con «Ya tiene comprobante» (MOM §35.4). En Kapta,
   solo lectura:
   `select status, ruc_mismatch, count(*) from order_invoices where mode = 'real' group by 1, 2;`
   — nada en `emitiendo` por más de unos minutos, ningún `ruc_mismatch`, y
   cada `en_duda` conciliado solo o resuelto como en el paso 9.
11. **Pasada en seco, a mano.** La corre el owner o quien opera, no un agente:
   `GET /api/cron/invoices?dry=1` con `Authorization: Bearer <CRON_SECRET>` (y
   `&storeId=<uuid>` para una sola tienda). Revisa, relee en Shopify y arma la
   boleta, pero no escribe nada en la base ni llama a SimpleFact: devuelve, por
   RUC, cuántos pedirían turno (`would_claim`; en Manual, simulaciones) y los
   motivos de los demás. Con todos los RUC en «Apagado» responde
   `"skipped":"sin_ruc_encendido"`: sirve desde el paso 7.

**Antes de subir**: `npm test`, `npm run typecheck`, `bash scripts/verify-db.sh`
(clúster desechable; corre `scripts/sql/invoices_smoke.sql`, que también corre
la 0260 sobre la 0257 tal como corrió en producción, la 0261 sobre las dos y la
0262 sobre la 0261) y `next build`.

**Marcha atrás.** Poner cada RUC en «Apagado» (Ajustes → «Boletas y
facturas», o `update invoice_issuers set mode = 'apagado';`): el barrido deja
de leer y de emitir en la pasada siguiente. Con este código, un comprobante
que haya quedado en `emitiendo` más de 10 minutos pasa a `en_duda` al empezar
una pasada, sin llamar a SimpleFact, y lo revisa una persona. No hace falta
revertir el código. Lo emitido no se borra —ya está en SUNAT—: una boleta que
no correspondía la anula una persona con nota de crédito en SimpleFact (MOM
§35.9). Las tablas no molestan al código anterior y se quedan. La 0260 tampoco
se revierte: el código anterior pide el mismo turno y no llama a
`invoice_candidates`. La 0261 tampoco: el código anterior pide el turno con los
nueve argumentos por nombre, y el de once los acepta. La 0262 tampoco: el
código anterior manda en `p_basis` si es prepago web y el id de cada pago, y lo
bien pagado sigue dando su fila.

**Antes de volver al código anterior** (el de `main` antes de estos commits,
0f7c79c6): ese código no conoce «Manual» y lo trata como «Apagado»; solo
concilia los RUC en «Real»; no pasa a `en_duda` un `emitiendo` que nadie
concilia; y su panel no tiene «Sí está en SimpleFact: registrar su serie». Con
él, una fila real en `emitiendo` o `en_duda` de un RUC que no está en «Real»
se queda así para siempre, bloqueando su pedido sin que nadie la vea. Por eso,
con este código todavía desplegado y en este orden:
1. Bajar a «Simulación» todo RUC en «Manual» (Ajustes, o
   `update invoice_issuers set mode = 'simulacion' where mode = 'manual';`):
   desde ahí nadie emite a mano. Un RUC que siga en «Real» se baja también
   (a «Apagado», como arriba, o a «Simulación»): la cuenta del punto 4 es de
   todas las filas reales.
2. Esperar una pasada de este código que empiece al menos 10 minutos después
   del último «Emitir esta boleta» (su línea `[invoices] {…}` en los logs de
   Vercel): pasa a `en_duda` cada `emitiendo` sin respuesta, sin llamar a
   SimpleFact (`sin_respuesta`). Con el RUC en «Simulación», la conciliación
   ya no busca sus boletas: las ve una persona.
3. Resolver a mano cada `en_duda`, como en el paso 9: buscarlo en SimpleFact
   por su nota «Kapta ‹ref›»; si está, «Sí está en SimpleFact: registrar su
   serie»; si no, «No está en SimpleFact: volver a intentar», pasados los 30
   minutos.
4. Comprobar, solo lectura,
   `select count(*) from order_invoices where mode = 'real' and status in ('emitiendo', 'en_duda');`
   — tiene que dar `0`. Recién entonces volver al código anterior.

**Qué mirar después.** Cada pasada escribe una línea `[invoices] {…}` en los
logs de Vercel, sin clientas, teléfonos ni token: por RUC, `simuladas`,
`emitidas`, `en_duda`, `errores`, `conciliadas`, `pendientes`, los motivos y
por qué se detuvo (`stopped`). El `mode` de cada RUC es el suyo: uno en
`"manual"` cuenta `simuladas` (el barrido) y concilia lo que emitió una persona
(`conciliadas`, `en_duda`), y nunca `emitidas`. `errors` no vacío pone el cron
en rojo (502). `sin_respuesta` cuenta los `emitiendo` que la pasada pasó a
`en_duda` porque nadie los iba a conciliar: cada uno se busca en SimpleFact por
su nota y se resuelve en el panel como en el paso 9. `"lleno":{"real":true}` (o
`"simulacion"`) dice que `invoice_candidates` devolvió los 500 pedidos de ese
modo: lo más viejo pendiente no se miró en esa pasada. No pone el cron en
rojo, pero si se repite hay que ver qué llena la lista (por ejemplo, con
`select reason, count(*) from invoice_order_checks where mode = 'real' group by 1 order by 2 desc;`).
Un token rechazado (401 o 403), una cuenta que no responde (404 o 405) o una
venta con archivos de otro RUC apaga el RUC solo y borra su prueba de
conexión, también cuando sale de «Emitir esta boleta». Ajustes lo dice en rojo:
«Apagado por Kapta: ‹motivo›. Prueba la conexión antes de volver a Real o a Manual.». Para
volver a Real hay que corregir lo que falló (el token o el subdominio) y pulsar
«Probar conexión» de nuevo. Lo mismo para volver a Manual.

### 15-10-2026 · «Emitir esta boleta» para lo pagado antes de «Emitir desde» (0269, MOM §35)

Decisión del owner (15-10-2026). Con el RUC en «Manual», «Emitir esta boleta»
también sirve para un pedido pagado **antes** de «Emitir desde», si se pagó
desde el **01/10/2026 00:00 (hora de Lima)**: el último pago registrado y
también el primer dinero, la fecha más temprana entre la del comprobante
(`order_payments.paid_at`, cuándo se movió la plata) y la de registro de cada
pago validado. Un pago cuyo comprobante dice 29/09 y que entró a Kapta el
01/10 no pasa. Antes de Kapta las boletas se
emitían a mano en SimpleFact, y Kapta no sabe si ese pedido ya tiene la suya:
por eso la confirmación pide marcar «Revisé en SimpleFact y este pedido no
tiene boleta», y sin esa marca no emite. Una boleta de más es pagar el
impuesto dos veces. **El barrido nunca va hacia atrás**: en Simulación, en
Manual y en Real, lo pagado antes de «Emitir desde» sigue en
`antes_de_inicio`. «Emitir desde» no cambia: Ajustes sigue sin aceptar una
fecha pasada, y un cambio de modo la sigue moviendo al momento del cambio. Con
«Emitir desde» en el futuro, nada pagado antes de él sale, ni con el botón. Sin
variables de entorno nuevas; `MOM_RESOLUTION_VERSION` no cambia.

**En producción ya está aplicada (15-10-2026, editor SQL de Supabase).** Se
aplicó con el número 0267, antes de que main tomara ese número para
«Programar envío» (`0267_order_master_dispatch_scheduled_on.sql`); la 0268 es
«Ventas por origen», así que el archivo pasó a 0269, con el mismo contenido.
Como se corrió desde el editor, no figura en el historial de migraciones de
Supabase. Comprobada el mismo día: queda solo el turno de doce argumentos, con
su cuerpo igual al del archivo y `execute` solo para `service_role`. No hace
falta volver a correrla.

1. **Migración `0269_invoices_backfill.sql`**, a mano, DESPUÉS de la 0262 y
   ANTES del código que manda `p_backfill`. Pegar el archivo en el editor SQL
   de Supabase, que la corre en una transacción (con `psql`:
   `psql -1 -v ON_ERROR_STOP=1 "$DATABASE_URL" -f db/migrations/0269_invoices_backfill.sql`;
   sin `-1` hay un instante sin `invoice_claim` entre el `drop` de la firma de
   once y el `create` de la de doce). Cambia solo `invoice_claim`: borra la
   firma de once argumentos y crea la de doce, con un argumento nuevo al
   final, `p_backfill boolean default false`, y el cuerpo de la 0262 tal cual
   salvo dos cosas:
   - la fecha: lo pagado antes de «Emitir desde» pasa solo con `p_backfill`,
     una fila real, el RUC en Manual, quién la pidió (`p_created_by`) y las
     dos fechas de pago —la del código y la de la base— desde el 01/10/2026
     00:00 de Lima, y el primer dinero también: la fecha más temprana entre
     `paid_at` y `registered_at` de los pagos validados (sin ellos, la fecha
     del pedido). Y solo con «Emitir desde» ya llegado
     (`v_iss.emit_from <= now()`). Sin «Emitir desde» o sin fecha de pago,
     `antes_de_inicio`, como siempre;
   - la fila que sale así lleva en su base `pagado_antes_de_emitir_desde: true`.

   El turno sigue solo para `service_role`. No toca filas, ni triggers, ni otra
   función, y no toma candados de tablas. Es idempotente: si en alguna base ya
   se corrió una versión anterior de la 0269 (sin el primer dinero, o sin
   mirar que «Emitir desde» ya llegó), se vuelve a correr y el turno queda con
   los dos (`like '%v_first%'` y `like '%v_iss.emit_from <= now()%'`, abajo).
   **Va después de la 0262**: si sigue el turno de nueve argumentos, o no hay
   ni el de once ni el de doce, se detiene con «La 0269 va después de la 0262:
   aplica primero db/migrations/0261_invoices_manual.sql y
   db/migrations/0262_invoices_claim_coverage.sql.» y no cambia nada. **Si
   alguien vuelve a correr la 0261 después, hay que volver a correr la 0269**:
   quedan dos turnos, el de once y el de doce, y la llamada por nombre del
   código falla por ambigua: no emite ni simula nada hasta volver a correr la
   0269. La 0262 sola, después de la 0269, se detiene en su guarda y no
   cambia nada.
   **Se puede aplicar ya, con el código que hoy está en producción**: ese
   código pide el turno por nombre, con nueve u once argumentos, y con un solo
   turno esas llamadas van al de doce con `p_backfill` en falso: hace lo mismo
   que antes. **Si el código llega antes que la 0269, nada se emite de más y
   nada se pone rojo**: lo pagado desde «Emitir desde» se emite como siempre
   (el código no manda `p_backfill` en un pedido normal), y un pedido pagado
   antes contesta `sin_migracion`, nombrando la 0269, sin reservar ni enviar
   nada. Aplicarla y volver a pulsar.
   **Comprobar**, solo lectura:
   - `select pg_get_function_identity_arguments(oid) from pg_proc where proname = 'invoice_claim' and pronamespace = 'public'::regnamespace;`
     — una sola fila, que termina en `p_created_by uuid, p_backfill boolean`;
   - `select to_regprocedure('public.invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid)') is null;`
     tiene que dar `true`: el de once ya no está;
   - `select pg_get_functiondef('public.invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid, boolean)'::regprocedure) like '%pagado_antes_de_emitir_desde%';`
     tiene que dar `true` (y lo mismo con `like '%v_first%'`, el primer
     dinero, con `like '%v_iss.emit_from <= now()%'`, «Emitir desde» ya
     llegado, y con `like '%sin_pago_completo%'` y `like '%for share%'`, que
     trae de la 0262);
   - `select has_function_privilege('authenticated', 'public.invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid, boolean)', 'execute');`
     tiene que dar `false` (y lo mismo con `anon`; con `service_role`, `true`);
   - `select ruc, mode, emit_from, checked_ruc, check_error from invoice_issuers;`
     y `select count(*) from order_invoices;` dicen lo mismo que antes de
     aplicarla.
2. **Desplegar** el código. Desde ahí, en un pedido pagado desde el 01/10 y
   antes de «Emitir desde» (con su primer dinero también desde el 01/10), con
   el RUC en «Manual», el panel «Comprobante» (y «Emitir» en Ajustes →
   últimos comprobantes) ofrece «Emitir esta boleta», y la confirmación dice
   cuándo se pagó, desde cuándo emite el RUC y, si es de otro momento, cuándo
   se hizo el primer pago. **Antes de marcar la casilla, buscar el pedido en
   SimpleFact** (por su número, su total y su fecha, desde la del primer
   pago): si ya tiene boleta, no se emite; se registra con «Ya tiene
   comprobante». Si el panel se relee con la confirmación abierta y cambia el
   RUC, el total o las fechas, la confirmación se cierra y la casilla se
   desmarca: se vuelve a abrir y a revisar. En una vista previa no hay botón,
   como siempre.

**Qué mirar después**, solo lectura:
`select order_name, paid_at, mode, status, created_by is not null as con_quien from order_invoices where basis ? 'pagado_antes_de_emitir_desde' order by created_at desc;`
— cada fila `real`, con `con_quien = true` y `paid_at` desde el 01/10/2026
05:00 UTC; nada en `emitiendo` por más de unos minutos. Y el primer dinero de
cada una, también desde el 01/10/2026 05:00 UTC:
`select i.order_name, min(least(coalesce(p.paid_at, p.registered_at), p.registered_at)) as primer_dinero from order_invoices i join order_payments p on p.order_id = i.order_id and p.validation_status = 'validado' where i.basis ? 'pagado_antes_de_emitir_desde' group by 1 order by 2;`
Revisar cada una en SimpleFact, como las demás de Manual.

**Antes de subir**: `bash scripts/verify-db.sh` corre
`scripts/sql/invoices_smoke.sql`, que también corre la 0269 sobre la 0262 (dos
veces), con la 0261 corrida otra vez después, y su guarda sin la 0262 delante.

**Marcha atrás.** Lo emitido no se borra: ya está en SUNAT, y una boleta que no
correspondía se anula con nota de crédito en SimpleFact (MOM §35.9). Para que
nadie más emita hacia atrás basta con no pulsar el botón en esos pedidos, o
bajar el RUC a «Simulación». No hace falta revertir la 0269: el código
anterior pide el turno por nombre, sin `p_backfill`, y el de doce lo acepta con
`p_backfill` en falso. Si aun así se quiere volver al turno de la 0262, en una
sola transacción:
`psql -1 -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "drop function invoice_claim(uuid, uuid, uuid, uuid, numeric, timestamptz, text, jsonb, jsonb, text, uuid, boolean);" -f db/migrations/0261_invoices_manual.sql -f db/migrations/0262_invoices_claim_coverage.sql`
(la 0261 recrea el turno de once y la 0262 le pone la revisión del pago).
Desde ahí, el código nuevo contesta `sin_migracion` en lo pagado antes de
«Emitir desde», y lo demás sigue igual.

### 15-10-2026 · Intentos del motorizado propio y filtro de intentos (`mom-v1.27`)

Sin migraciones, variables de entorno ni RPC nuevas. `MOM_RESOLUTION_VERSION`
sube a `mom-v1.27`: el cron `master-reconcile` recalcula las filas y la columna
de intentos pasa a sumar las paradas de Grupo GF (MOM §9.3, «Intentos de
entrega»). No cambia etapas ni costos. Con la foto del 15-10-2026, 487 pedidos
con un «No entregado» de motorizado propio tenían `attempt_count = 0`.

**Qué mirar después.** Cuando el cron termine,
`select count(*) from order_master where macro_version <> 'mom-v1.27';` da `0`,
y #KP140941 dice 2 intentos (3 si la salida del 15/10 ya se reportó).

### 15-10-2026 · Intentos de Urpi en el Master (0265, `mom-v1.28`) y canal de venta (0264)

- **0264** (ya aplicada en producción antes del #977): `order_master.sales_channel`
  y su relleno.
- **0265 antes del código**: `order_master_stale` mira también la última
  escritura de `urpi_report_rows`. Misma firma y permisos; `create or replace`,
  sin `drop`.
- `MOM_RESOLUTION_VERSION` sube a `mom-v1.28`: el cron recalcula y la columna de
  intentos suma los de Urpi (entregado, cancelado, reprogramado). No cambia
  etapas ni costos.

**Qué mirar después.** #KP131545 dice 1 intento cuando su fila tenga
`macro_version = 'mom-v1.28'`.

### 15-10-2026 · Intentos de Swayp y Tanders (`mom-v1.29`)

Sin migraciones. `MOM_RESOLUTION_VERSION` sube a `mom-v1.29`: la columna de
intentos suma las visitas que se deducen de los estados de Swayp (Novedad,
Entregada, Devolución) y de Tanders (Delivered, Returning, Returned). No cambia
etapas ni costos.

### 15-10-2026 · «Salió con» y paradas del cuaderno en los intentos (0266, `mom-v1.30`)

- **0266 antes del código**: `order_master.dispatched_with` (text[], índice
  GIN) y `master_facets` con la clave `dispatched_with`. `create or replace`,
  sin `drop`; el recálculo escribe la columna, así que tiene que existir antes.
- `MOM_RESOLUTION_VERSION` sube a `mom-v1.30`: el cron rellena «Salió con» y
  suma a los intentos de Grupo GF las paradas del cuaderno histórico. No cambia
  etapas ni costos.

### 14-10-2026 · Canal de cierre de todas las ventas (0259, MOM §17.3)

La tarjeta «Canal de cierre» del Consolidado y de la página de cada tienda deja
de mirar solo los pedidos con `kapso` y clasifica TODAS las ventas por quién
las cerró: asesora (`order_sales`) > recompra automática > bot de Kapso > bot de
carritos externo > la clienta sola en la web (EasySell) > otros, con la marca
«ayudado por asesora». Y «Generar pedido», la captura del carrito recuperado
sin asesora y la recompra automática dejan de escribir `kapso` /
`cod_recuperado` / `auto_recompra` en la copia local: registran la fila solo si
el webhook no la trajo, tal como viene de Shopify.

1. **Migración `0259_canal_de_cierre.sql`**, a mano y ANTES del código:
   `psql "$DATABASE_URL" -f db/migrations/0259_canal_de_cierre.sql`. Crea solo
   la función de lectura `canal_de_cierre(uuid[], date, date)` (SECURITY
   INVOKER, ejecutable por `authenticated` y `service_role`). No escribe datos,
   no toma bloqueos sobre tablas y no lleva `drop`. Medida en producción como
   el owner, 30 días y dos tiendas: 0,32 s, con los índices que ya existen.
   **Sin ella el código no se rompe**: la tarjeta vuelve a la vista anterior
   (solo pedidos del bot) con un aviso de que falta la migración y sin cifra
   de cabecera («—»), porque ese porcentaje es justo el número equivocado.
   **Ya aplicada en producción el 14-10-2026** con `apply_migration` (historial
   `20261014172812 0257_canal_de_cierre`: se aplicó con ese número y el mismo
   día se renumeró a 0258, porque la integración ya tenía `0257_invoices.sql`,
   y el 15-10 a 0259, porque llegó `0258_restock_reply_sweep.sql`; la función
   es la misma y no hay que volver a aplicarla). Comprobado ese día: el cuerpo de la
   función es idéntico al del archivo (mismo md5), `anon` no la puede ejecutar,
   y como el owner, con RLS, del 14-09 al 13-10 ve las dos tiendas en 0,27 s con
   los mismos pedidos por canal que la tabla del MOM §17.3 (solo cambian los
   que se cancelaron después de medirla).
2. **Qué cambia en las cifras**:
   - «Canal de cierre» pasa de «0 % lo cerró una asesora» a la parte real. Con
     el periodo 14-09 → 13-10-2026: asesora 2.651 pedidos y S/ 481.451 de
     S/ 1.181.080 en total (≈ 41 %).
   - Las cifras de arriba (Ingresos, Pedidos, Conversión) siguen siendo solo
     del bot (§5h; con la 0268, Ingresos, Pedidos y Ticket pasan a todas las
     ventas y la Conversión sigue siendo del bot, ahora «Conversión del bot»;
     ver su entrada), pero ya no suben unos minutos con cada venta de asesora: la
     etiqueta `kapso` que les ponía el botón duraba hasta la siguiente
     sincronización. Es más correcto; el cambio es pequeño y se nota sobre
     todo en el día en curso.
   - La tarjeta cuenta desde que Kapta tiene todos los pedidos
     (`ORDERS_SYNC_FROM`, 2026-06-01) y las ventas de las asesoras de cada
     tienda (su primera fila de `order_sales` o, sin ninguna, su primer lead:
     25-06 y 04-07-2026 en las dos tiendas de hoy). Antes, una venta de asesora
     caería en «Web» u «Otros». En el Consolidado cuenta desde la tienda que
     empezó último (hoy, 04-07-2026) y el aviso la nombra (**corrección, mismo
     día, 0268:** cada tienda cuenta desde su propio día, ver su entrada). Un periodo que empieza
     antes se cuenta desde ese día y la tarjeta lo dice; uno entero anterior
     vuelve a la vista de respaldo con su aviso. Una tienda que todavía no usa
     Kapta queda fuera del conteo, nombrada; si no se puede leer desde cuándo
     usa Kapta una tienda, la tarjeta muestra el error.
   - En el panel de «Fuente», el bloque que se llamaba «Canal de cierre» pasa a
     llamarse «Cierre de los pedidos del bot, por etiquetas» y remite a la
     tarjeta: es el mismo cálculo de siempre, solo sobre pedidos del bot.
   - Limitación conocida: un carrito de EasySell que completa el bot de Kapso
     por WhatsApp cuenta como «Web», porque Shopify no le deja ninguna marca
     del bot. Para separarlo, el workflow del bot tendría que etiquetar el
     borrador antes de completarlo (MOM §17.3).
   - Si al generar el pedido Shopify contesta que el borrador ya estaba
     completado, la venta se registra sobre el pedido real del borrador y no
     sobre una fila inventada `draft-<id>`, que la contaba dos veces.
3. **Qué mirar después**:
   - la tarjeta muestra «Todas las ventas de la tienda» y su total se parece a
     los pedidos del Master del mismo periodo, no a los S/ ~100k del bot;
   - ninguna venta nueva de asesora queda con `kapso` en `orders`:
     `select count(*) from orders o join order_sales v on v.order_id = o.id where o.created_at > '<hora del despliegue>' and 'kapso' = any(o.tags);`
     tiene que dar 0, salvo que el borrador reusado ya trajera `kapso` de
     Shopify;
   - los pedidos generados desde el drawer conservan sus productos con SKU
     después del webhook (antes nuestra copia los pisaba con líneas sin id).
4. **Marcha atrás**: revertir el código basta; la función puede quedarse (es
   de lectura y nadie más la llama). Si se quiere quitar:
   `drop function if exists public.canal_de_cierre(uuid[], date, date);`

### 14-10-2026 · Ventas del periodo por origen y conversión por fuente (0268, MOM §17.4)

Las cifras de cabecera (Ingresos, Pedidos, Ticket promedio), «Ventas por día»
y «Por tienda» dejan de contar solo los pedidos con `kapso` y cuentan TODAS las
ventas de la tienda, partidas por quién las cerró con la regla de «Canal de
cierre». «Conversión» pasa a llamarse «Conversión del bot». Nace la tarjeta
«Conversión por fuente»: de los leads que llegaron en el periodo, cuántos
compraron en sus primeros 7 días, por fuente. Cada tienda cuenta desde su
propio día en Kapta, también en «Canal de cierre».

0. **Los dos índices, a mano y PRIMERO**, fuera de una transacción (`psql`
   en modo normal; `apply_migration` no sirve porque envuelve en transacción),
   uno por uno:
   `create index concurrently if not exists leads_store_first_seen_idx on public.leads (store_id, first_seen_at);`
   `create index concurrently if not exists leads_store_created_sin_first_seen_idx on public.leads (store_id, created_at) where first_seen_at is null;`
   Un `create index` normal bloquearía las escrituras de `leads` mientras se
   construye. La migración los vuelve a pedir con `if not exists`, que entonces
   no los construye, pero toma por un instante un bloqueo de escritura sobre
   `leads`; por eso la migración pone `lock_timeout = '5s'` en esas dos líneas y
   falla en limpio si tuviera que esperar (se reintenta). Son de columnas simples a propósito: la app lee como
   `authenticated`, bajo RLS, y Postgres no lleva al índice un rango sobre
   `coalesce(first_seen_at, created_at)`. Comprobar que quedaron válidos:
   `select indexrelid::regclass, indisvalid from pg_index where indexrelid in ('public.leads_store_first_seen_idx'::regclass, 'public.leads_store_created_sin_first_seen_idx'::regclass);`
   → `t` en los dos (si uno da `f`, `drop index concurrently` de ese y
   repetirlo).
1. **Migración `0268_ventas_por_origen.sql`**, a mano y ANTES del código:
   `psql "$DATABASE_URL" -f db/migrations/0268_ventas_por_origen.sql`. Crea la
   vista `pedidos_canal` (con la sesión de quien mira; `authenticated` solo
   puede leerla y `anon` nada), rehace `canal_de_cierre` encima de ella —mismo
   resultado que la 0259, la regla del canal pasa a vivir en un solo lugar— y
   crea las funciones de lectura `ventas_por_origen` y `conversion_por_fuente`
   (SECURITY INVOKER, sin `anon`). No escribe datos y no lleva `drop`. Solo
   necesita la 0259 delante; no depende de la 0264 a la 0267 (Master), que
   llevan número menor solo porque llegaron antes a la integración, ni de la
   0269 (comprobantes). Medido
   en producción como el owner, 30 días, con la primera versión de la consulta:
   la cohorte de `conversion_por_fuente`, 0,39 s recorriendo los 59.598 leads.
   La versión final parte el nacimiento en dos rangos de columnas simples y
   materializa las tiendas, para que bajo RLS los rangos de `leads` y de
   `orders` vayan por índice. Medido en una base de prueba con la cadena entera
   de migraciones, 60.000 leads y unos 440.000 pedidos, como el owner bajo RLS
   y sin JIT (producción lo tiene apagado): `conversion_por_fuente` de 465 a
   66 ms, `ventas_por_origen` de 110 a 69 ms y `canal_de_cierre` de 198 a 88 ms,
   con el mismo resultado byte a byte; antes leía todos los pedidos y todos
   los leads de la tienda en cada llamada. (Después, la cohorte dejó fuera las
   filas que Kapta crea desde su propio pedido, MOM §17.4: eso sí cambia
   «Orgánico», a propósito.)
   **Sin ella el código no se rompe**: la cabecera, «Ventas por día» y «Por
   tienda» vuelven a la vista anterior —«Ingresos del bot», «Pedidos del bot»…—
   con un aviso arriba de las cifras («Falta aplicar la migración 0268…»), y
   «Conversión por fuente» dice lo mismo. «Canal de cierre» sigue con la 0259.
   **No está aplicada en producción**: necesita la autorización del owner.
2. **Qué cambia en las cifras**:
   - La cabecera sube unas once veces: del 14-09 al 13-10-2026 pasa de cerca de
     600 pedidos del bot a 6.622 pedidos y S/ 1.181.080. Es el mismo total que
     «Canal de cierre»: cuadran entre sí.
   - El cambio contra el periodo anterior solo aparece si cada tienda contaba
     el periodo anterior entero (con las tiendas de hoy, cuando el periodo
     anterior empieza el 04-07-2026 o después); si no, «sin comparar: el
     anterior no tiene todas las ventas».
   - «Conversión del bot» es pedidos del canal «Bot de Kapso» ÷
     conversaciones: casi igual que la «Conversión» de antes (las ventas de
     asesora ya no conservaban `kapso`, §5h), ahora con el nombre que dice lo
     que mide.
   - «Ventas por día» parte cada día por grupo de cierre; «Por tienda» suma
     todas las ventas de cada tienda, con la parte de la asesora; «Canal de
     cierre» gana el cambio contra el periodo anterior por canal.
   - «Conversión por fuente», medido en el mes: Anuncios de Meta 6,3 %, Carritos
     COD 30,2 %, Orgánico 9,4 %, Web de Facebook 15,9 %, Búsquedas abandonadas
     3,6 % (MOM §17.4). Junto, el cierre de las asesoras, como en Productividad
     pero con leads distintos por tienda.
   - Con varias tiendas, cada una cuenta desde su propio día en Kapta (antes
     «Canal de cierre» recortaba todas al día de la que empezó último) y un aviso
     arriba de las cifras nombra cada tienda que cuenta desde otra fecha.
   - Siguen siendo solo del bot, y lo dicen: «Conversión del bot», Productos,
     Fuente, Embudo y su salud, los ingresos de Carritos y de Números de
     WhatsApp, Desglose de negocio, Integridad y Patrón de horas. «Resumen diario CSV»
     se llama ahora «Resumen diario del bot CSV» (el mismo archivo).
3. **Qué mirar después**:
   - «Ingresos» de la cabecera es igual al total de «Canal de cierre» del mismo
     periodo y se parece a los pedidos del Master, no a los S/ ~100k del bot;
   - con una tienda recortada (un periodo de junio, por ejemplo), el aviso
     azul nombra la tienda y el día, y no hay cambio contra el anterior;
   - que la cohorte va por los índices nuevos bajo RLS. `explain` de la
     función no sirve (solo muestra un `Result`: Postgres no la expande); se
     mira la consulta de la cohorte, como el owner:
     `begin; select set_config('request.jwt.claims', '{"sub":"<uid del owner>","role":"authenticated"}', true); set local role authenticated; explain analyze select count(*) from public.leads where store_id = '<tienda>' and first_seen_at >= '<desde>T00:00-05' and first_seen_at < '<hasta + 1>T00:00-05'; rollback;`
     → `Index Cond` sobre `leads_store_first_seen_idx` con el rango de fechas.
4. **Marcha atrás**: revertir el código basta; las funciones y la vista pueden
   quedarse (son de lectura). Para quitarlas, primero devolver `canal_de_cierre`
   a la 0259 y después borrar lo demás:
   `psql "$DATABASE_URL" -f db/migrations/0259_canal_de_cierre.sql`,
   `drop function if exists public.ventas_por_origen(uuid[], date, date);`,
   `drop function if exists public.conversion_por_fuente(uuid[], date, date);`,
   `drop view if exists public.pedidos_canal;` y, si se quiere,
   `drop index concurrently if exists public.leads_store_first_seen_idx;` y
   `drop index concurrently if exists public.leads_store_created_sin_first_seen_idx;`.

### 16-10-2026 · Programar envío (0267)

- **0267 antes del código**: `order_master.dispatch_scheduled_on` (date) e
  índice parcial. El recálculo la escribe; sin la columna el upsert fallaría.
- Sin cambio de versión: nadie había programado un envío, así que no hay nada
  que rellenar. Los pedidos la toman cuando alguien programa.

### 15-10-2026 · Arreglos de la auditoría del atraso de Lima (sin migración)

Sin migraciones, variables de entorno, RPC ni crons nuevos.
`MOM_RESOLUTION_VERSION` **no** sube (`mom-v1.30`): el resolver no cambia.

- **Costo logístico** (MOM §14): cuando falta una tarifa, el recálculo guarda
  `order_master.logistics_cost` vacío y no S/ 0. Como la versión no sube, las
  filas ya guardadas en S/ 0 cambian en su próximo recálculo; «Conciliar
  liquidación» no espera a eso, porque recalcula el pedido al guardar.
- **Puerta a «entregado»** (MOM §11.4): lee `orders.cancelled_at` en cada
  llamada (lotes de 200). Si esa lectura falla no escribe nada, y el cierre de
  la ruta dice «No se pudo actualizar el Master: …».
- **Barrido de cobros Tanders** (MOM §9.4): al final de cada pasada de
  `/api/cron/tanders-payments` crea, como mucho, 20 fichas `pendiente_revision`
  para las guías validadas que se quedaron sin ficha. Unas 200 entran en las
  primeras ~11 pasadas, y cada una necesita la firma de una persona en Validar
  pagos.

**Qué mirar después.** La próxima pasada del barrido trae `sinFicha` y
`fichasRecuperadas` en su informe. Terminar la ruta de Yhoni del 01/10
(`00bd7063`) nombra a #KP137541 en «Ojo:» y lo deja anulado.

### 21-10-2026 · Grupo GF cobra lo de su Tarifario (`mom-v1.31`) y la caja S01 del cuaderno (0270)

Dos decisiones del owner del 19-10-2026 (MOM §14, §29.8, §30.8). Sin variables
de entorno, RPC ni crons nuevos.

1. **Migración `0270_cuaderno_s01_fill.sql`, a mano y ANTES del código.**
   **Ya aplicada en producción el 22-10-2026** (conteo previo 575, `NOTICE` y
   comprobación: 575 salidas y 575 eventos, los 575 pedidos en «Pendiente de
   liquidación», ninguno en Finalizado). Es un relleno de datos, no de
   esquema: la caja S01 «por definir» de los pedidos que el cuaderno de Alexis
   o de Reparto propio da por entregados pasa a salida entregada de Grupo GF
   Courier (courier `propio`, `created_via` y `delivered_source`
   `cuaderno_gf`, `dispatched_at` = `closed_at` = el día del cuaderno a las
   17:00Z), con un evento `route_output_filled` por salida. Conserva
   consecutivo, `output_code`, QR, preparación y custodia, y **no cierra
   ninguna liquidación**: los pedidos dejan «Salida adicional activa» y pasan a
   «Pendiente de liquidación». Sin `drop` ni `begin`/`commit`; correrla otra
   vez escribe 0 filas. Quien la aplica pone la transacción y el freno:

   ```bash
   psql "$DATABASE_URL" <<'SQL'
   begin;
   set local lock_timeout = '15s';
   \i db/migrations/0270_cuaderno_s01_fill.sql
   commit;
   SQL
   ```

   El `NOTICE` «0270: N caja(s) «por definir» pasaron a salida entregada de
   Grupo GF» tiene que dar lo mismo que el conteo previo. Va antes del código
   porque el recálculo no depende de él: el `UPDATE` mueve
   `shipments.updated_at`, `order_master_stale` da esos pedidos por desfasados
   y el barrido los recalcula con el código que haya; al salir `mom-v1.31` se
   recalculan otra vez. El día de su costo es el de su último movimiento, y el
   relleno (el `UPDATE` y su evento) lo lleva al día en que se aplica: con
   `mom-v1.31` toman la tarifa del Tarifario vigente ese día si su distrito la
   tiene, también los 308 con día del cuaderno anterior al 31-08-2026 (punto 4).

   **Conteo previo** (solo lectura; el 21-10-2026, 575: 432 de Kenku Peru y 143
   de Aurela, días del cuaderno del 10-08 al 15-09-2026). Es el mismo filtro de
   la migración, el mismo con el que se midieron las 575; si sale distinto, son
   cambios de datos desde el 21-10 (cajas resueltas o anuladas a mano, filas de
   hoja posteriores que lo contradicen, pedidos que el barrido sacó o metió en
   «Salida adicional activa»): revisar la diferencia antes de aplicar:

   ```sql
   with pop as (
     select om.order_id, om.store_id, om.order_name
       from order_master om
       join orders o on o.id = om.order_id
      where om.coverage = 'lima'
        and om.macro_stage = 'por_cerrar'
        and om.macro_substage = 'salida_adicional_activa'
        and om.status_source = 'manual'
        and o.cancelled_at is null
   ),
   -- Las salidas vivas, como en la auditoría y en `planOwnSalida`.
   live as (
     select x.id, x.order_id, x.output_code, x.courier, x.created_via, x.delivery_status, x.custody_state,
            x.custody_transferred_at, x.preparation_state, x.ready_at, x.created_at
       from shipments x
       join pop p on p.order_id = x.order_id
      where x.delivery_status in ('pendiente', 'en_ruta')
        and x.returned_at is null
        and coalesce(x.custody_state, '') <> 'devuelto'
   ),
   a as (
     select distinct on (l.order_id) l.*, count(*) over (partition by l.order_id) as n_live
       from live l
      order by l.order_id, l.created_at desc
   ),
   ov as (
     select distinct on (e.order_id) e.order_id, lower(btrim(e.courier)) as rider, e.new_status,
            e.payload->>'fecha' as fecha, e.occurred_at
       from order_events e
       join pop p on p.order_id = e.order_id
      where e.kind = 'status_override'
      order by e.order_id, e.occurred_at desc, e.created_at desc
   ),
   target as (
     select p.order_id, p.store_id, a.id as shipment_id, ov.rider, ov.fecha,
            -- `manualRouteGuideCode(order_name, id, 'propio')` (lib/shipment-output.ts).
            'MOM-' || coalesce(
              nullif(regexp_replace(regexp_replace(upper(regexp_replace(btrim(coalesce(p.order_name, '')), '^#+', '')),
                                                   '[^A-Z0-9_-]+', '', 'g'), '_+', '-', 'g'), ''),
              upper(left(a.id::text, 8))
            ) || '-PROPIO-' || upper(left(a.id::text, 8)) as guide_code
       from pop p
       join a on a.order_id = p.order_id
       join ov on ov.order_id = p.order_id
      where a.n_live = 1
        and a.courier = 'por_definir'
        and a.created_via = 'mom_manual_route'
        and a.delivery_status = 'pendiente'
        and coalesce(a.custody_state, 'empresa') = 'empresa'
        and a.custody_transferred_at is null
        and a.preparation_state = 'listo_despacho'
        and ov.new_status = 'entregado'
        and ov.rider in ('alexis', 'propio')
        and ov.fecha ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
        and ov.fecha <= '2026-10-21'
        and not exists (select 1 from shipments y where y.order_id = p.order_id and y.delivery_status = 'entregado')
        and not exists (select 1 from urpi_report_rows r where r.order_id = p.order_id)
        and (ov.occurred_at at time zone 'America/Lima')::date >= (a.created_at at time zone 'America/Lima')::date - 30
        and ov.occurred_at >= coalesce(a.ready_at, a.created_at) - interval '1 day'
        and not exists (
          select 1
            from sheet_rows r
            join sheets sh on sh.id = r.sheet_id
            join sheet_domain_statuses st on st.domain_id = sh.domain_id and st.code = r.values->>'estado'
           where r.order_id = p.order_id
             and r.values->>'fecha' > ov.fecha
             and st.effect in ('devolucion', 'anulacion', 'sin_salida')
        )
   )
   select coalesce(st.name, 'TOTAL') as tienda, count(*) as cajas,
          count(*) filter (where t.rider = 'alexis') as alexis,
          count(*) filter (where t.rider = 'propio') as propio,
          min(t.fecha) as desde, max(t.fecha) as hasta
     from target t
     join stores st on st.id = t.store_id
    group by rollup (st.name)
    order by st.name nulls last;
   ```

   **Comprobación después** (solo lectura): `eventos_0270` = `salidas_0270` =
   el `NOTICE`, `con_fecha_rara` = 0 y el conteo previo, otra vez, en 0.
   Cuando el barrido o `mom-v1.31` los recalculen, los pedidos están en «Por
   cerrar · Pendiente de liquidación» y `desfasados` baja a 0:

   ```sql
   -- 1) Lo que escribió: tantas salidas como eventos, y el conteo previo en 0.
   select (select count(*) from order_events e
            where e.kind = 'route_output_filled' and e.payload->>'backfill' = 'true'
              and e.payload ? 'rider' and e.courier = 'propio') as eventos_0270,
          (select count(*) from shipments s
            where s.created_via = 'cuaderno_gf' and s.courier = 'propio' and s.delivery_status = 'entregado'
              and exists (select 1 from order_events e where e.shipment_id = s.id and e.kind = 'route_output_filled'
                           and e.payload->>'backfill' = 'true')) as salidas_0270,
          (select count(*) from shipments s
            where s.created_via = 'cuaderno_gf'
              and (s.closed_at is null or s.dispatched_at is distinct from s.closed_at
                   or to_char(s.closed_at at time zone 'UTC', 'HH24:MI') <> '17:00')) as con_fecha_rara;
   -- 2) Dónde quedaron los pedidos, cuando el barrido (o mom-v1.31) los recalcule:
   --    Por cerrar · Pendiente de liquidación; «desfasados» baja a 0.
   select om.macro_stage, om.macro_substage, count(*) as pedidos,
          count(*) filter (where s.updated_at > om.recomputed_at) as desfasados
     from shipments s
     join order_master om on om.order_id = s.order_id
    where s.created_via = 'cuaderno_gf'
      and exists (select 1 from order_events e where e.shipment_id = s.id and e.kind = 'route_output_filled'
                   and e.payload->>'backfill' = 'true')
    group by 1, 2
    order by 3 desc;
   ```

2. **El código.** Desde aquí, «Aplicar al Master» de Liquidaciones 2 y la carga
   histórica (`scripts/apply-cuaderno-history-to-master.ts`) rellenan la caja
   al aplicar la entrega (`lib/own-salida.ts`), con las mismas condiciones
   (también la de `cuaderno_contradicho`: una fila posterior de cualquier hoja
   que lo da por devuelto, anulado o sin salida lo deja para revisar). Las dos
   acotan a hoy una fecha futura del cuaderno.
   `scripts/rollback-master-backfill.ts` no deshace ese relleno.
3. **Grupo GF cobra lo de su Tarifario.** El costo logístico de «propio» sale
   de `logistics_district_tariffs` (Grupo GF Courier › Tarifario), no de
   `cost_tariffs`: la tarifa del distrito vigente el día del costo (el último
   movimiento, como con cualquier courier), la del contrato de la tienda si la
   hay, por el primer intento y cada intento adicional de sus propias salidas
   (no los de Aliclik o Swayp; hoy solo el primero), sin devolución aparte. El
   Master lee con la clave de servicio `logistics_providers` (código
   `grupo-gf-courier`),
   `logistics_service_agreements` y `logistics_district_tariffs` (0134 y 0136,
   ya en producción) y las recuerda cinco minutos por instancia, como
   `cost_tariffs`; una lectura que falla no se recuerda y el aviso dice «No se
   pudo leer…». Los demás couriers no cambian.
4. **`MOM_RESOLUTION_VERSION` sube a `mom-v1.31`**: el cron recalcula poco a
   poco todo el Master. Para «propio», `logistics_cost` pasa a la tarifa del
   distrito si su último movimiento es del 31-08-2026 en adelante (las 44
   tarifas rigen desde ese día) y queda vacío si es anterior, si el distrito no
   se reconoce o si no tiene tarifa. Los S/ 0 viejos de «propio» desaparecen.
   Un pedido de Grupo GF cuyo último movimiento es anterior al 31-08-2026 sigue
   «falta tarifa» (el aviso nombra ese día y desde cuándo rige la del
   distrito) y no se concilia mientras su último movimiento siga antes de esa
   fecha: la pantalla del Tarifario no abre vigencias anteriores a la que rige
   (`saveDistrictTariff`), y cubrir esos días es una decisión del owner que
   pediría un cambio de datos. Pero cualquier movimiento posterior del pedido
   («Observar liquidación», un comentario, el relleno de la 0270) lleva el día
   del costo a ese día: toma la tarifa vigente entonces y el siguiente
   «Conciliar liquidación» pasa. Si eso vale o el bloqueo tiene que aguantar
   hasta que el owner decida, es punto suyo (MOM §14).

   **Qué mirar después** (solo lectura, cuando termine el barrido):

   ```sql
   select macro_version, (logistics_cost is not null) as con_costo, count(*)
     from order_master
    where coverage = 'lima' and macro_stage = 'por_cerrar'
      and 'pendiente_liquidacion' = any(macro_reasons)
      and (current_courier = 'propio' or delivered_courier = 'propio' or last_courier = 'propio'
           or exists (select 1 from unnest(dispatched_with) c where c = 'gf' or c like 'gf:%'))
    group by 1, 2
    order by 1, 2;
   ```

   Con `mom-v1.31`, para «propio» quedan con costo los que se movieron por
   última vez del 31-08-2026 en adelante y tienen distrito con tarifa, y sin él
   los demás. Medido el 22-10-2026 por último movimiento: de los 2.833 pedidos
   de Grupo GF en «Pendiente de liquidación», 1.044 son del 31-08-2026 en
   adelante (esperado: con costo, salvo distrito sin tarifa) y 1.789 anteriores
   (esperado: sin costo). Hoy los 2.833 muestran S/ 0 y ninguno se concilia
   (Costos no tiene tarifas de «propio»). Los ~575 de la 0270 se suman a los
   que tienen costo si su distrito tiene tarifa: su último movimiento es el día
   en que se aplicó.

**Marcha atrás.** Para la tarifa basta revertir el código: las filas en
`mom-v1.31` no coinciden con la versión anterior y el cron las vuelve a
calcular con `cost_tariffs`. La 0270 no se deshace sola: las salidas
rellenadas se reconocen por su `route_output_filled` con
`payload.backfill = true`.

### 23-10-2026 · Tiendas con su app propia de Shopify (0271, MOM §36)

Conectar «Súper Human Perú» con la app que su propia organización de Shopify
creó en el Dev Dashboard («app propia»): Shopify ya no deja crear apps
personalizadas en el admin, y la app pública «Kapta» no está revisada. La app
propia pide su token con su Client ID y su Client secret (*client credentials
grant*) y cada token dura ~24 h; Kapta lo renueva cada hora (cron) y antes de
usarlo.

**Kenku y Aurela no cambian.** Siguen con la app interna, su token y sus
webhooks; las tiendas `clientes`, igual. Nada de esto las desconecta, les
registra webhooks ni les cambia el token, y la 0271 no actualiza ninguna fila.
Sin variables de entorno nuevas: el Client ID y el Client secret son de cada
tienda, se escriben en Kapta y nunca van a Vercel, al chat ni al repositorio.

1. **Migración `0271_shopify_app_propia.sql`, a mano y ANTES del código.**
   Amplía `stores_shopify_app_check` a `('interna', 'clientes', 'propia')`;
   añade `stores.shopify_client_id`, `shopify_client_secret_enc` (cifrado como
   los demás `*_enc`), `shopify_token_expires_at`, `shopify_token_renewed_at`,
   `shopify_token_error`, `shopify_token_retry_at` (el freno de la renovación
   al usar), `shopify_webhook_secret_prev_enc` (el Client secret anterior tras
   rotarlo, cifrado) y `shopify_webhook_secret_prev_set_at`; y pone
   `stores_own_app_columns_check` (esas ocho columnas solo tienen valor en una
   tienda `propia`) y `stores_own_app_shop_uniq` (un dominio, una sola tienda
   con app propia).
   Sin grants nuevos: la fila la protege la RLS de siempre. Sin ella, la
   conexión con app propia responde «falta la migración 0271» y el cron
   contesta `sin_migracion`; las tiendas de hoy siguen igual.

   **Antes** (solo lectura; anotar la huella):

   ```sql
   -- a) Un solo CHECK de la lista de apps, el de la 0249: 'interna' y 'clientes'.
   select conname, pg_get_constraintdef(oid)
     from pg_constraint
    where conrelid = 'stores'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%shopify_app%';
   -- b) Tiendas por app y estado (Kenku Peru y Aurela: interna, active).
   select shopify_app, status, count(*) from stores group by 1, 2 order by 1, 2;
   -- c) La huella de lo que la 0271 promete no tocar (sin mostrar secretos).
   select md5(string_agg(concat_ws('|', id, name, shopify_domain, shopify_app, status,
                                   md5(coalesce(shopify_token_enc, '')),
                                   md5(coalesce(shopify_webhook_secret_enc, '')),
                                   shopify_uninstalled_at), ',' order by id)) as huella
     from stores;
   ```

   **Aplicar.** Toma un momento el candado exclusivo de `stores` (cambia dos
   CHECK y crea un índice). Mientras lo espera, todo lo que lee `stores` hace
   cola detrás: cada consulta del dashboard y cada webhook de Kenku y Aurela.
   Por eso el `lock_timeout` es corto, **3 s**: si una consulta larga tiene la
   tabla, la migración se corta sola (`canceling statement due to lock
   timeout`), no cambia nada, y se vuelve a correr el mismo bloque unos
   segundos después, las veces que haga falta:

   ```bash
   psql "$DATABASE_URL" <<'SQL'
   begin;
   set local lock_timeout = '3s';
   \i db/migrations/0271_shopify_app_propia.sql
   commit;
   SQL
   ```

   **Después** (solo lectura):

   ```sql
   -- 1) Las piezas nuevas: el CHECK con 'interna', 'clientes' y 'propia',
   --    stores_own_app_columns_check y el índice parcial.
   select conname, pg_get_constraintdef(oid)
     from pg_constraint
    where conrelid = 'stores'::regclass
      and conname in ('stores_shopify_app_check', 'stores_own_app_columns_check');
   select indexdef from pg_indexes where tablename = 'stores' and indexname = 'stores_own_app_shop_uniq';
   -- 2) Ninguna tienda cambió: la huella (c) tiene que dar lo mismo que antes.
   --    Si no, comparar fila por fila: una desinstalación o una reconexión en
   --    medio también la mueve.
   -- 3) Las columnas nuevas, vacías en todas (0 hasta conectar la primera propia).
   select count(*) from stores
    where shopify_client_id is not null or shopify_client_secret_enc is not null
       or shopify_token_expires_at is not null or shopify_token_renewed_at is not null
       or shopify_token_error is not null or shopify_token_retry_at is not null
       or shopify_webhook_secret_prev_enc is not null or shopify_webhook_secret_prev_set_at is not null;
   ```

   Correrla otra vez no hace nada: no vuelve a validar la tabla ni toca filas.

2. **El código**, por el camino de siempre (rama de integración → `main` por
   fast-forward). Trae el cron `/api/cron/shopify-own-app-tokens` en
   `vercel.json`, cada hora, protegido con `CRON_SECRET` como los demás.
   Mientras no haya una tienda propia no renueva nada. Comprobar en Vercel →
   Crons que aparece, y que una llamada sin el secreto responde 401.

3. **Conectar «Súper Human Perú».**
   - En la organización de Shopify de la tienda → Dev Dashboard: crear la app,
     darle los alcances `read_orders`, `read_draft_orders`,
     `write_draft_orders`, `read_products`, `read_customers` y `write_orders`
     (los de `SHOPIFY_CLIENT_APP_SCOPES`), publicar la versión e instalarla en
     la tienda. Revisar que tenga acceso a los datos protegidos de clientes
     (nombre, teléfono, dirección y correo): si los pedidos llegan sin datos
     del comprador, es eso.
   - En Kapta: «Conectar con app propia de Shopify» (el primer formulario de
     «Conectar tienda»; **no** el de «Crear tienda con token de Admin API»),
     con el dominio `*.myshopify.com`, el Client ID, el Client secret y la
     organización. Copiar el secreto directo del Dev Dashboard al campo; nunca
     por chat. Si dice que la tienda ya está en Kapta, no se tocó nada: mirar
     con la consulta de abajo (sin filtrar por app) qué fila tiene ese dominio.
     Si dice que «ya está en esta organización, sin acceso a Shopify», es el
     paso 5.
   - Si Kapta dice que faltan alcances, añadirlos en una versión nueva de la
     app, instalarla otra vez y volver a conectar.

   **Qué mirar después:**

   ```sql
   select name, shopify_app, status, shopify_client_id is not null as con_client_id,
          shopify_token_expires_at, shopify_token_renewed_at, shopify_token_error
     from stores
    where shopify_app = 'propia';
   ```

   Recién conectada: `active`, vencimiento a ~24 h y sin error. Unas 12 h
   después el cron la renueva: `shopify_token_renewed_at` avanza y el
   vencimiento vuelve a quedar a ~24 h. Un `shopify_token_error` que no se
   borra en la hora siguiente es un problema de la app (secreto rotado, app
   desinstalada, alcances quitados): el texto dice cuál. Si el texto son
   permisos que faltan, el token se renovó igual (Ajustes lo titula «Faltan
   permisos en la app»). Y otra vez la huella (c) y el conteo (b) de las
   tiendas `interna` y `clientes`: no cambian.

4. **Rotar el Client secret de una tienda propia** (cuando haga falta, MOM
   §36.4), en este orden: rotarlo en el Dev Dashboard; pegar el nuevo en
   Ajustes → Shopify → «Credenciales de la app» → «Probar y guardar»; revocar
   el anterior en el Dev Dashboard; y pulsar «Ya revoqué el secreto anterior».
   Mientras tanto Kapta acepta los webhooks de pedidos y borradores firmados
   con el anterior, hasta 48 h; un `app/uninstalled` firmado solo con el
   anterior se rechaza con 401 y la tienda sigue activa (MOM §36.4). Si se
   cambia el Client ID (otra app), Kapta registra los webhooks de la nueva:
   después, desinstalar la anterior de la tienda.

5. **Si al conectar Kapta dice que la tienda «ya está en esta organización,
   sin acceso a Shopify»** (MOM §36.2): alguien la creó con «Crear tienda con
   token de Admin API» y quedó `interna` sin token. «Conectar con app propia»
   no la toca; la convierte soporte, a mano, y solo esa fila:

   ```sql
   -- a) La fila (solo lectura): de esa organización, interna y sin token.
   select id, org_id, name, shopify_app, status, shopify_token_enc is null as sin_token
     from stores
    where lower(shopify_domain) = lower('<tienda>.myshopify.com');
   -- b) Pasarla a app propia (el id de a).
   update stores set shopify_app='propia' where id='<id>' and shopify_app='interna' and shopify_token_enc is null;
   ```

   Tiene que decir `UPDATE 1`. `UPDATE 0` es que la fila tiene token o ya no
   es `interna`: no seguir (Kenku y Aurela tienen token, así que el `where`
   nunca las toma). Si falla por `stores_own_app_shop_uniq`, ya hay otra
   tienda propia con ese dominio: no seguir. Después, en Kapta, alguien con
   «Administrar tiendas»: Ajustes de esa tienda → Shopify → «Credenciales de
   la app» → el Client ID y el Client secret → «Probar y guardar». Pide el
   token, guarda las credenciales y, si la tienda está activa o en pausa,
   registra sus webhooks (pedidos, borradores y `app/uninstalled`) y dice
   «Credenciales probadas y guardadas, y los webhooks registrados»: no hay app
   anterior, no se desinstala nada; si está deshabilitada, el aviso dice que
   se active y se re-registren. Luego
   «Sincronizar ahora». Entre el `update` y «Probar y guardar», el cron puede
   anotar «Faltan el Client ID o el Client secret…» en `shopify_token_error`:
   se borra al guardar. Comprobar con la consulta de «Qué mirar después» del
   paso 3.

**Marcha atrás.** Revertir el código basta: las tiendas propias dejan de
renovar y su token vence en menos de 24 h; Kenku, Aurela y las tiendas
`clientes` no lo notan. La 0271 puede quedarse: con las columnas vacías y el
CHECK más amplio no cambia nada para ellas. Si hubiera que quitarla, primero
el código, y solo con `select count(*) from stores where shopify_app = 'propia'`
en 0:

```sql
begin;
alter table stores drop constraint if exists stores_own_app_columns_check;
drop index if exists stores_own_app_shop_uniq;
alter table stores drop constraint stores_shopify_app_check;
alter table stores add constraint stores_shopify_app_check check (shopify_app in ('interna', 'clientes'));
alter table stores
  drop column shopify_client_id,
  drop column shopify_client_secret_enc,
  drop column shopify_token_expires_at,
  drop column shopify_token_renewed_at,
  drop column shopify_token_error,
  drop column shopify_token_retry_at,
  drop column shopify_webhook_secret_prev_enc,
  drop column shopify_webhook_secret_prev_set_at;
commit;
```

### 23-10-2026 · La salida de Urpi lleva el día de la entrega, y las cajas viejas de Urpi (0272)

MOM §30.11 y §4. Sin variables de entorno, RPC ni crons nuevos.
`MOM_RESOLUTION_VERSION` **no** sube (`mom-v1.31`): el resolver no cambia, y los
pedidos que toca la 0272 se recalculan por el desfase.

1. **El código.** Al rellenar la caja «por definir» como salida de Urpi
   (`urpiSalidaRow`, `lib/urpi-salida.ts`) escribe también `closed_at` = el día
   de la fila más reciente de Urpi del pedido —la «Entregado» de la que sale la
   entrega del Master— a las 17:00Z. Hasta aquí no lo escribía y el Master
   tomaba como día de la entrega el del relleno. Si esa fila no trae fecha, la
   salida se rellena sin `closed_at`, como antes.
2. **Migración `0272_urpi_salida_fecha.sql`, a mano y DESPUÉS del código.**
   **Pendiente de aplicar en producción.** Después, para que ninguna salida
   nueva de Urpi quede sin `closed_at` entre una cosa y otra (si se aplica
   antes, correrla otra vez tras el despliegue completa las que se rellenaron en
   medio). Es un relleno de datos, no de esquema, en dos pasos:
   1. a las salidas `created_via = urpi_report` entregadas y sin `closed_at`,
      `closed_at` = el día de la fila más reciente de Urpi del pedido a las
      17:00Z, si esa fila es «Entregado» y tiene fecha. Sin evento: no
      sobrescribe ningún hecho (estaba vacío) y la salida ya tiene el
      `route_output_filled` de su relleno;
   2. la caja «por definir» de los pedidos que Urpi entregó y el marcado
      automático no alcanzó (antes de la ventana de 60 días) pasa a salida de
      Urpi entregada, con la regla del botón (`planUrpiSalida`: última fila
      «Entregado» con fecha, ninguna salida de Urpi entregada, la «por definir»
      de ruta manual como única salida viva, pendiente, en la empresa y nunca
      transferida) y solo si el pedido está entregado en Kapta y no anulado en
      Shopify. Escribe lo mismo que el código (courier `urpi`, `created_via` y
      `delivered_source` `urpi_report`, la guía `MOM-<pedido>-URPI-<id>`,
      `dispatched_at` = el primer intento y `closed_at` = la entrega, a las
      17:00Z), con las guardas del UPDATE de `writeCourierGuide`, y un
      `route_output_filled` por salida con `payload` {outputCode,
      previousCourier, backfill, urpi_row, fecha}. Conserva consecutivo,
      `output_code`, QR, preparación y custodia, y **no cierra ninguna
      liquidación**.

   Sin `drop` ni `begin`/`commit`; correrla otra vez escribe 0 filas. Quien la
   aplica pone la transacción y el freno:

   ```bash
   psql "$DATABASE_URL" <<'SQL'
   begin;
   set local lock_timeout = '15s';
   \i db/migrations/0272_urpi_salida_fecha.sql
   commit;
   SQL
   ```

   Da dos `NOTICE`: «0272: N salida(s) de Urpi con el día de la entrega» tiene
   que dar el conteo previo 1, y «0272: N caja(s) «por definir» pasaron a
   salida de Urpi entregada», el `se_rellenan` del conteo previo 2.

   **Conteo previo 1** (solo lectura; el 23-10-2026, **107**, con días del
   reporte del 24-08 al 21-10-2026). Es el mismo filtro del paso 1. Si sale
   más, son salidas que el código viejo rellenó desde el 23-10; si sale menos,
   salidas cuya última fila de Urpi ya no es «Entregado» con fecha (un intento
   posterior) o que alguien cerró a mano: revisar la diferencia antes de
   aplicar:

   ```sql
   with latest as (
     select distinct on (r.order_id) r.order_id, r.result_code, r.report_date
       from urpi_report_rows r
      where r.order_id is not null
      order by r.order_id, r.urpi_row desc
   )
   select count(*) as salidas, min(l.report_date) as desde, max(l.report_date) as hasta
     from shipments s
     join latest l on l.order_id = s.order_id
    where s.created_via = 'urpi_report'
      and s.delivery_status = 'entregado'
      and s.closed_at is null
      and l.result_code = 'entregado'
      and l.report_date is not null;
   ```

   **Conteo previo 2** (solo lectura; el 23-10-2026, **32**, reportes del
   10-08 al 22-08-2026; `cajas` = `se_rellenan`). Es el mismo filtro del paso 2.
   El `NOTICE` tiene que dar `se_rellenan`; si es menor que `cajas`, la
   diferencia son cajas con el courier escrito distinto o cuya guía ya existe,
   que tampoco rellena el código y se miran a mano. Si sale distinto de 32, son
   cambios de datos desde el 23-10 (cajas pasadas con el botón, anuladas o
   despachadas a mano, intentos nuevos de Urpi): revisar la diferencia antes de
   aplicar:

   ```sql
   with latest as (
     select distinct on (r.order_id) r.order_id, r.urpi_row, r.result_code, r.report_date
       from urpi_report_rows r
      where r.order_id is not null
      order by r.order_id, r.urpi_row desc
   ),
   first_try as (
     select r.order_id, min(r.report_date) as first_on
       from urpi_report_rows r
      where r.order_id is not null
        and r.report_date is not null
      group by r.order_id
   ),
   pop as (
     select om.order_id, om.store_id, om.order_name, l.urpi_row, l.report_date as delivered_on, f.first_on
       from latest l
       join first_try f on f.order_id = l.order_id
       join order_master om on om.order_id = l.order_id
       join orders o on o.id = om.order_id
      where l.result_code = 'entregado'
        and l.report_date is not null
        and om.general_status = 'entregado'
        and o.cancelled_at is null
        and not exists (select 1 from shipments y where y.order_id = om.order_id and y.courier = 'urpi' and y.delivery_status = 'entregado')
   ),
   live as (
     select x.id, x.order_id, x.courier, x.created_via, x.delivery_status, x.custody_state, x.custody_transferred_at,
            count(*) over (partition by x.order_id) as n_live
       from shipments x
       join pop p on p.order_id = x.order_id
      where x.delivery_status in ('pendiente', 'en_ruta')
        and x.returned_at is null
        and coalesce(x.custody_state, '') <> 'devuelto'
   ),
   target as (
     select p.*, l.id as shipment_id, l.courier,
            -- `manualRouteGuideCode(order_name, id, 'urpi')` (lib/shipment-output.ts).
            'MOM-' || coalesce(
              nullif(regexp_replace(regexp_replace(upper(regexp_replace(btrim(coalesce(p.order_name, '')), '^#+', '')),
                                                   '[^A-Z0-9_-]+', '', 'g'), '_+', '-', 'g'), ''),
              upper(left(l.id::text, 8))
            ) || '-URPI-' || upper(left(l.id::text, 8)) as guide_code
       from pop p
       join live l on l.order_id = p.order_id
      where l.n_live = 1
        and lower(btrim(l.courier)) = 'por_definir'
        and l.created_via = 'mom_manual_route'
        and l.delivery_status = 'pendiente'
        and coalesce(l.custody_state, 'empresa') = 'empresa'
        and l.custody_transferred_at is null
   )
   -- `cajas`: la regla de `planUrpiSalida`; `se_rellenan`: además las guardas
   -- del UPDATE (courier escrito tal cual y guía sin usar), lo que da el NOTICE.
   select coalesce(st.name, 'TOTAL') as tienda, count(*) as cajas,
          count(*) filter (where t.courier = 'por_definir'
                             and not exists (select 1 from shipments z where z.courier = 'urpi' and z.guide_code = t.guide_code)) as se_rellenan,
          min(t.delivered_on) as desde, max(t.delivered_on) as hasta
     from target t
     join stores st on st.id = t.store_id
    group by rollup (st.name)
    order by st.name nulls last;
   ```

   **Comprobación después** (solo lectura): `eventos_0272` = `cajas_0272` = el
   segundo `NOTICE`, `sin_dia_o_raras` = 0 (si no, son salidas de Urpi cuya
   última fila no es «Entregado» con fecha, que el paso 1 no toca) y los dos
   conteos previos, otra vez, en 0 (el segundo, en `se_rellenan`). Cuando el barrido los recalcule, `desfasados` baja a 0, el día de la
   entrega del Master es el del reporte y las 32 cajas están en «Por cerrar ·
   Pendiente de liquidación» (o donde las lleve su liquidación), ninguna en
   «Salida adicional activa»:

   ```sql
   -- 1) Lo que escribió.
   select (select count(*) from order_events e
            where e.kind = 'route_output_filled' and e.courier = 'urpi'
              and e.payload->>'backfill' = 'true' and e.payload ? 'urpi_row') as eventos_0272,
          (select count(*) from shipments s
            where s.created_via = 'urpi_report' and s.courier = 'urpi' and s.delivery_status = 'entregado'
              and exists (select 1 from order_events e where e.shipment_id = s.id and e.kind = 'route_output_filled'
                           and e.payload->>'backfill' = 'true' and e.payload ? 'urpi_row')) as cajas_0272,
          (select count(*) from shipments s
            where s.created_via = 'urpi_report' and s.delivery_status = 'entregado'
              and (s.closed_at is null or to_char(s.closed_at at time zone 'UTC', 'HH24:MI') <> '17:00'
                   or s.dispatched_at > s.closed_at)) as sin_dia_o_raras;
   -- 2) Dónde quedaron, cuando el barrido los recalcule: «desfasados» baja a 0
   --    y «dia_del_reporte» = «pedidos».
   select (exists (select 1 from order_events e where e.shipment_id = s.id and e.kind = 'route_output_filled'
                    and e.payload->>'backfill' = 'true' and e.payload ? 'urpi_row')) as caja_0272,
          om.macro_stage, om.macro_substage, count(*) as pedidos,
          count(*) filter (where s.updated_at > om.recomputed_at) as desfasados,
          count(*) filter (where om.delivered_at = s.closed_at) as dia_del_reporte
     from shipments s
     join order_master om on om.order_id = s.order_id
    where s.created_via = 'urpi_report' and s.delivery_status = 'entregado'
    group by 1, 2, 3
    order by 1, 4 desc;
   ```

**Qué cambia en el Master.** El `delivered_at` de esos pedidos pasa del día del
relleno al del reporte de Urpi, y «Liquidación vencida» (Urpi, a los 3 días,
§17.1) se mide desde ese día: una entrega sin liquidar puede pasar a vencida
antes de lo que mostraba. Las 32 cajas dejan «Salida adicional activa». El
`UPDATE` (y en el paso 2, su evento) mueve el último movimiento —el día al que
se imputa el costo, §14— al día en que se aplica, como en la 0270: si Urpi
tiene tarifa en Costos › Costos logísticos, se toma la vigente ese día (el
16-10-2026 no tenía ninguna). Por lo mismo, los pedidos cuya última señal era de
antes del corte salen de «Sin movimiento por 60 días» (§17.1) sin que nadie los
haya trabajado. Quedan fuera, como en el flujo de Urpi, los 13
pedidos con la misma caja que no están entregados en Kapta (12 anulados en
Shopify).

**Marcha atrás.** Revertir el código solo hace que los rellenos nuevos vuelvan a
salir sin `closed_at`. La 0272 no se deshace sola: las cajas del paso 2 se
reconocen por su `route_output_filled` con `payload.backfill = true` y
`payload.urpi_row`; las fechas del paso 1 no llevan rastro propio (estaban
vacías y el código las escribe igual desde este cambio).
