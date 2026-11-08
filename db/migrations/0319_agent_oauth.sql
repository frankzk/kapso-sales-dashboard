-- ============================================================================
-- 0319_agent_oauth.sql — conectar un agente de IA a Kapta con OAuth, sin copiar
-- tokens (MOM §42.8, 08-11-2026).
--
-- POR QUÉ. Grok Bot guardó el token de Kapta como secreto, pero no tiene cómo
-- mandarlo en la cabecera `Authorization` de un servidor MCP propio, y le pidió
-- al owner que el conector tenga OAuth: «así podré añadirlo por su dirección y
-- tú aprobarás el acceso sin copiar tokens». Es la autorización de MCP
-- (especificación 2025-06-18): metadatos del recurso (RFC 9728) y del servidor
-- de autorización (RFC 8414), registro dinámico del cliente (RFC 7591) y código
-- de autorización con PKCE S256.
--
-- QUÉ GUARDA.
--   · `agent_oauth_clients`: cada agente que se registró solo (Grok, u otro
--     cliente MCP): su nombre y las direcciones a las que Kapta puede devolver
--     el código. Registrarse no da acceso a nada: el acceso lo da una persona.
--   · `agent_oauth_codes`: el código de un solo uso que Kapta entrega cuando
--     una persona con `automations.manage` pulsa «Permitir», con las tiendas y
--     herramientas que eligió. Se guarda su sha256; vence a los 10 minutos; se
--     canjea una vez por un token de `agent_tokens` (0314) con PKCE.
--   · `agent_tokens.oauth_client_id`: el token nacido de ese canje dice de qué
--     cliente vino. Se ve y se revoca en Conector de IA como cualquier otro.
--
-- SOLO EL SERVIDOR y SIN LLAVES FORÁNEAS, como la 0314.
--
-- Se aplica a mano ANTES del código (DEPLOY.md, entrada del 08-11-2026). Sin
-- ella, el registro y el canje contestan 503 y el token manual sigue igual. Es
-- idempotente.
-- ============================================================================

-- ── 1. Los clientes registrados ─────────────────────────────────────────────
create table if not exists agent_oauth_clients (
  client_id      text primary key check (client_id ~ '^kcli_[A-Za-z0-9_-]{22}$'),
  client_name    text not null check (length(btrim(client_name)) between 1 and 100),
  redirect_uris  text[] not null check (cardinality(redirect_uris) between 1 and 10),
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz
);

-- El tope de registros por hora mira los más recientes.
create index if not exists agent_oauth_clients_created_idx on agent_oauth_clients (created_at desc);

comment on table agent_oauth_clients is
  'MOM §42.8: clientes OAuth de agentes de IA (registro dinámico, RFC 7591): nombre y redirect_uris. Registrarse no da acceso: lo da una persona con automations.manage en /oauth/authorize. Solo service_role.';

-- ── 2. Los códigos de autorización ───────────────────────────────────────────
create table if not exists agent_oauth_codes (
  code_hash       text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  client_id       text not null,
  redirect_uri    text not null,
  -- PKCE S256: base64url del sha256 del verificador, 43 caracteres.
  code_challenge  text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  user_id         uuid not null,
  org_id          uuid not null,
  store_ids       uuid[] not null check (cardinality(store_ids) between 1 and 50),
  scopes          text[] not null check (
    cardinality(scopes) between 1 and 20
    and scopes <@ array['pedidos.leer', 'conversaciones.leer', 'politicas.leer',
                        'pedidos.nota', 'whatsapp.enviar', 'aliclik.crear_guia']::text[]
  ),
  label           text not null check (length(btrim(label)) between 1 and 80),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  used_at         timestamptz,
  -- El token que se entregó al canjearlo: si el código se vuelve a presentar,
  -- ese token se revoca (RFC 6749 §4.1.2).
  token_id        uuid,
  constraint agent_oauth_codes_expiry_ck check (expires_at > created_at and expires_at <= created_at + interval '15 minutes')
);

comment on table agent_oauth_codes is
  'MOM §42.8: códigos OAuth de un solo uso (sha256), 10 minutos, con PKCE S256, las tiendas y herramientas que aprobó la persona; se canjean por un agent_tokens. Solo service_role.';

-- ── 3. De qué cliente vino un token ──────────────────────────────────────────
alter table agent_tokens add column if not exists oauth_client_id text;

-- ── 4. Solo el servidor ──────────────────────────────────────────────────────
alter table agent_oauth_clients enable row level security;
revoke all on agent_oauth_clients from anon, authenticated, service_role;
grant select, insert, update on agent_oauth_clients to service_role;
alter table agent_oauth_codes enable row level security;
revoke all on agent_oauth_codes from anon, authenticated, service_role;
grant select, insert, update on agent_oauth_codes to service_role;
