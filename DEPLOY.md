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
   | `ALICLIK_API_BASE` | `https://api.aliclik-dev.com` (optional; **pon la de producción cuando Aliclik la entregue**) |
   | `ALICLIK_WRITE_ENABLED` | `false` por defecto. `true` habilita CREAR guías en Aliclik |
   | `SHALOM_API_KEY` | API key (`sk_…`) del wrapper de Shalom. **Global: una para todas las tiendas.** Sin ella no aparece «+ Guía Shalom» (ver 5ñ) |
   | `SHALOM_API_BASE` | `https://api.shalom-api-peru.com` (optional). **El host a secas, sin `/v1`**: el cliente ya añade la ruta, y una base con `/v1` produce `/v1/v1/…` → 404. Si no existe la variable, el valor por defecto ya es el correcto |

   `DATABASE_URL` is only needed for migrations; you don't have to add it to
   Vercel.
4. Deploy. The crons in `vercel.json` are picked up automatically; Vercel sends
   `Authorization: Bearer $CRON_SECRET`:
   - `/api/cron/sync` — every 5 min (reconciliation + ops snapshots).
   - `/api/cron/telegram-summary` — daily 13:00 UTC (per-store daily summary).
   - `/api/cron/aliclik-catalog` — diario 09:00 UTC. Refresca el espejo del
     catálogo de Aliclik (EAN, stock por almacén, agencias Shalom). Solo lectura.
   - `/api/cron/aliclik-reconcile` — cada 20 min. Red de seguridad del webhook de
     Aliclik, que llega **sin firma y sin garantía de entrega**: relee los
     pedidos de los últimos 14 días y resuelve las creaciones que se fueron en
     timeout. Si el webhook falla, un estado tarda como mucho un ciclo.
   - `/api/cron/backup` — daily 08:00 UTC (~03:00 Lima). Snapshots the
     dashboard-native tables (`leads`, `lead_calls`, `shipment_calls`) to CSV in
     the private Supabase Storage bucket `db-backups` (auto-created, keeps the
     last 14), and pings Telegram. **No manual setup.** This is a lightweight
     complement to Supabase's daily backups / PITR, not a replacement — it
     covers table-level loss (bad migration, accidental DROP), not "whole
     project gone". **Restore:** download the CSV from the bucket and `COPY`/
     import it back into the table.

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
- **`ORDERS_SYNC_FROM` acota el histórico** (por defecto `2026-06-01`). La pasada
  nueva solo trae pedidos **creados** a partir de esa fecha, así que no arrastra
  años de pedidos cerrados. Se filtra por `created_at` y no por `updated_at`, para
  que un pedido viejo que alguien edite hoy no vuelva a entrar. Para ampliar el
  histórico basta mover la variable en Vercel y borrar el cursor:
  `delete from sync_state where source = 'shopify_all';`
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

- **Requiere migración 0059** antes de activar cualquier interfaz de escaneo.
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
