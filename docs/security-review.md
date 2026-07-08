# Revisión de seguridad — Kapso Sales Dashboard

Auditoría de blindaje previa a onboardear dueños externos. Cubre 5 vectores
(aislamiento entre tenants, inyección/SSRF/XSS, manejo de secretos, flujos de
auth/OAuth, hardening web/infra) + dependencias.

> **Documento interno.** Es un mapa de remediación; quítalo o mantenlo privado
> antes de cualquier publicación del repo.

## Veredicto general

La **lógica de negocio y el aislamiento entre tenants están bien construidos**:
cifrado AES-256-GCM correcto, ningún secreto llega al cliente ni a los logs, RLS
consistente (no se encontró ninguna forma de que un tenant lea/escriba órdenes,
leads o credenciales de otro), OAuth de Shopify sólido (state + HMAC + dominio
validado), sin inyección SQL ni XSS de DOM, repo sin secretos commiteados.

**El grueso de las brechas está en el perímetro** (headers, rate limiting) y en
un par de validaciones de entrada que faltan. Nada es un RCE de un disparo, pero
en conjunto dejan la plataforma clickjackeable, con XSS amplificable y barata de
tirar por DoS. Es "un PR de config te sube de D a B".

## Estado de remediación (este PR)

| # | Hallazgo | Sev | Estado |
|---|---|---|---|
| A1 | Headers de seguridad (CSP/HSTS/X-Frame/nosniff/…) | Alta | ✅ Arreglado (`next.config.ts`) |
| A2 | Rate limiting | Alta | ⏳ **Acción tuya en Vercel** (pasos abajo) |
| A3 | SSRF por `shopify_domain` | Alta | ✅ Arreglado (validación `isValidShopDomain`) |
| A4 | Open redirect en `/auth/callback` | Alta | ✅ Arreglado (redirect solo same-origin) |
| M1 | Rol `viewer` puede escribir | Media | ⏳ Pendiente (necesita prueba del flujo vendedora) |
| M2 | Proxy de media (key en redirect, sniff, tamaño) | Media | ✅ Arreglado |
| M3 | Import sin tope de tamaño/filas | Media | ✅ Arreglado (8 MB / 50k filas) |
| B1 | `meta_ads`/`whatsapp_numbers` cross-tenant | Baja | ✅ Arreglado (migración `0034` + admin client) |
| B2 | Formula injection en CSV | Baja | ✅ Arreglado (`lib/csv.ts` + test) |
| B3 | Cron comparación no-constante | Baja | ✅ Arreglado (`timingSafeEqual`) |
| B4 | Respuestas 500 con `e.message` | Baja | ⏳ Pendiente (opcional) |
| B5 | `exchangeCodeForSession` sin chequear error | Baja | ✅ Arreglado |
| B6 | Roles admin globales, no por-org | Baja | ⏳ Pendiente |
| B7 | Deps moderadas (postcss/uuid) | Baja | ⏳ Pendiente (ver abajo) |
| B8 | Cookies legibles por JS (Supabase SSR) | Baja | ➖ Riesgo aceptado (mitigado por CSP A1) |

> **Requiere migración:** aplica `db/migrations/0034_scope_label_tables.sql` en
> Supabase (SQL Editor) al desplegar, igual que la `0033`.

### A2 — Cómo activar el rate limiting (Vercel, sin código)
En el proyecto de Vercel → **Firewall** → **Rate Limiting** → crea reglas:
1. Path `/(api/webhooks/.*)` → límite p. ej. **60 req/min por IP** (protege el
   flood/brute-force del `?secret=` de los webhooks).
2. Path `/(api/import/.*)` → **10 req/min por IP** (protege el import pesado).
3. (Opcional) `/login` y `/auth/.*` → **20 req/min por IP** además del límite de
   Supabase.
Alternativa por código: `@upstash/ratelimit` + Upstash Redis, llamando al inicio
de cada handler con clave `storeId`+IP. La regla de Firewall es más rápida y no
requiere infra nueva.

### M1 — Por qué quedó pendiente
Bloquear la escritura del rol `viewer` toca la ruta de autorización de leads/
envíos. Hacerlo mal podría **bloquear a una vendedora legítima**, y no hay tests
del flujo de ventas para verificarlo. Recomendado: agregar un helper
`requireWriter` (rol ∈ {owner, admin, vendedora} en la org de la tienda) en
`authorizeLead`/`authorizeShipment` para las acciones con efecto externo
(`closeSale`/`generateOrder`, `sendLeadMessage`, `sendLeadMedia`), con una prueba
que confirme que una vendedora sí puede y un viewer no.

### B7 — Dependencias
`postcss <8.5.10` (dentro de Next) y `uuid` (dentro de `exceljs`), ambas
moderadas y de build-time. Corre `pnpm update` cuando actualices Next/exceljs, o
fija con `pnpm.overrides` tras probar el build (evita forzar `uuid` a v11 sin
verificar que `exceljs` no rompe).

---

## Prioridad ALTA — arreglar antes de abrir a dueños externos

### A1. Faltan todos los headers de seguridad · `next.config.ts`
No hay CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy ni
Permissions-Policy. Consecuencias: el dashboard es **clickjackeable**; sin CSP no
hay defensa ante XSS (y como las cookies de sesión de Supabase son legibles por
JS, un XSS = robo de sesión); sin `nosniff` el proxy de media puede MIME-sniffear
un blob a HTML ejecutable. **Fix:** bloque `headers()` en `next.config.ts` +
`poweredByHeader:false` (una sola archivo).

### A2. Sin rate limiting en ningún endpoint · webhooks / login / import / media
Los webhooks (`/api/webhooks/{shopify,flow,kapso}/[storeId]`) hacen trabajo de
DB/HMAC por request antes de rechazar; con un `storeId` (UUID en la URL) se pueden
inundar → agotar conexiones de Supabase + costo de Vercel, y el `?secret=` de
Kapso/Flow es fuerza-brutable sin throttle. Login/magic-link dependen solo del
límite de Supabase. **Fix:** reglas de **Vercel Firewall** en `/api/webhooks/*` y
`/api/import/*` (sin código) y/o `@upstash/ratelimit` por `storeId`+IP dentro de
cada handler.

### A3. SSRF por `shopify_domain` sin validar al crear tienda · `app/dashboard/actions.ts:95`
Al conectar una tienda solo se limpia el esquema/ruta, pero **no** se llama a
`isValidShopDomain()` (que sí se usa en el flujo OAuth). Un owner/admin puede
poner `shopify_domain = 169.254.169.254` / `localhost:6379` / `metadata.internal`
y el servidor hace `fetch https://<eso>/admin/...` en la creación y en cada sync,
devolviendo parte de la respuesta en los mensajes de error (SSRF con exfiltración
por error, limitado a HTTPS). **Fix:** validar `isValidShopDomain(shopify_domain)`
antes del insert + `check` constraint en la columna.

### A4. Open redirect en `/auth/callback` · `app/auth/callback/route.ts:10-19`
`next` se toma tal cual de `redirectedFrom`/`next` y va a
`redirect(new URL(next, origin))`; valores como `//evil.com` o `https://evil.com`
resuelven fuera de origen → redirect abierto **no autenticado** para phishing.
**Fix:** aceptar solo rutas del mismo origen:
`const next = /^\/(?!\/)/.test(raw) ? raw : "/dashboard";`

---

## Prioridad MEDIA

### M1. El rol `viewer` puede ejecutar escrituras · `leads/actions.ts:228`, `envios/actions.ts:58`
`authorizeLead`/`authorizeShipment` validan **visibilidad** (RLS), no **rol**. Un
`viewer` con `user_store_access` (operación normal de equipo) pasa RLS y puede
`registerCall`, `closeSale`/`generateOrder` (¡crea órdenes reales en Shopify!),
`sendLeadMessage`/`sendLeadMedia` (envía WhatsApp a clientes). "viewer = solo
lectura" solo se cumple en la UI. **Fix:** helper `requireWriter` que exija rol ∈
{owner, admin, vendedora} para la org de la tienda objetivo.

### M2. Proxy de media: fuga de key + sin `nosniff`/`attachment` · `app/api/leads/[leadId]/media/route.ts`
Tres cosas: (a) con `redirect:"follow"` y `X-API-Key`, si `app.kapso.ai` redirige
a un CDN, la **Kapso key** viaja a ese host (undici no la quita en cross-origin);
(b) reenvía el `content-type` de upstream sin `X-Content-Type-Options: nosniff` ni
`Content-Disposition: attachment` → un blob `text/html`/`svg` se ejecuta inline en
el mismo origen; (c) sin tope de tamaño/tiempo. **Fix:** redirect manual quitando
la key fuera del allowlist (como ya hace `fetchKapsoImageBase64`), + `nosniff` +
`attachment` + tope de `Content-Length`.

### M3. Import XLSX/CSV sin tope de tamaño ni de filas (zip-bomb) · `app/api/import/aliclik/route.ts`, `lib/xlsx.ts`
Se acepta el archivo sin validar tamaño y `ExcelJS.load()` descomprime todo en
memoria; un XLSX-bomba dentro del límite ~4.5MB de Vercel puede inflar a cientos
de MB → OOM, con ventana de 2 min (`maxDuration=120`). DoS por usuario
autenticado. **Fix:** rechazar `file.size > ~5MB`, capear filas (p. ej. 50k) antes
de parsear.

---

## Prioridad BAJA (defensa en profundidad)

- **B1. `meta_ads` y `whatsapp_numbers` con RLS `using(true)`** (`0011`, `0012`):
  cualquier autenticado puede leer nombres de campañas/adsets y números de
  WhatsApp de **todos** los tenants (metadata de baja sensibilidad, sin gasto ni
  tokens). Fix: scopear la policy o resolver esos nombres vía admin client.
- **B2. Formula injection en export CSV** (`lib/csv.ts`): celdas que empiezan con
  `= + - @` se ejecutan al abrir en Excel/Sheets. Fix: prefijar con `'`.
- **B3. Comparación no-constante + secreto en query en cron** (`api/cron/*`): usar
  `timingSafeEqual` (como ya hacen los webhooks) y preferir header sobre `?secret=`.
- **B4. Respuestas 500 devuelven `e.message`** (webhooks/cron): eco de detalle
  interno a un caller semi-confiable. Fix: mensaje genérico + log server-side.
- **B5. `exchangeCodeForSession` ignora el error** (`auth/callback`): un canje
  fallido igual redirige (mitigado por el guard de `/dashboard`). Fix: chequear y
  mandar a `/login?error=auth`.
- **B6. Roles admin chequeados globalmente, no por-org** (`leads/actions.ts:438,459`,
  `envios/actions.ts:488,565`): admin de org A actuando sobre datos de org B donde
  es vendedora. Contenido a data ya accesible. Fix: chequear rol en la org objetivo.
- **B7. Dependencias moderadas**: `postcss <8.5.10` (dentro de Next) y `uuid`
  (dentro de `exceljs`) — riesgo real bajo (build-time). Fix: `pnpm update` /
  `overrides`.
- **B8. Cookies de sesión legibles por JS** (inherente al SSR de Supabase): no se
  puede hacer httpOnly sin cambiar el modelo; se compensa con CSP (A1). Riesgo
  aceptado documentado.

---

## Lo que quedó verificado como sólido (sin acción)

- Cifrado AES-256-GCM correcto (IV aleatorio por mensaje, auth tag verificado,
  key de 32 bytes validada). Secretos nunca al cliente ni a logs.
- OAuth de Shopify: state/CSRF en cookie httpOnly, HMAC en tiempo constante,
  dominio `*.myshopify.com` validado, ownership re-verificado.
- Aislamiento entre tenants: todas las tablas con datos tienen RLS scopeada; toda
  escritura con service-role pasa antes por `requireStoreAdmin`/`requireOrgAdmin`
  o un `authorize*` respaldado por RLS. Sin cross-tenant en órdenes/leads/creds.
- Webhook de Kapso por-tienda: compare constante, sin enumeración, no bypasseable.
- Sin inyección SQL (funciones `SECURITY DEFINER` con `search_path` fijo, queries
  parametrizadas). Sin `dangerouslySetInnerHTML`. Sin CORS permisivo. Sin secretos
  en `NEXT_PUBLIC_*` ni commiteados.
