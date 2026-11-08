-- ============================================================================
-- 0314_agent_tokens.sql — el conector de Kapta para agentes de IA (MOM §42,
-- 08-11-2026).
--
-- POR QUÉ. El dueño quiere un bot de Grok (Grok Bot de xAI) que consulte
-- pedidos, conversaciones y políticas de Kenku y Aurela sin pasar por el
-- navegador. Grok se conecta a un servidor MCP por URL y manda un token en la
-- cabecera `Authorization: Bearer …` (docs.x.ai, «Remote MCP Tools»). Kapta
-- expone ese servidor en `POST /api/mcp` (app/api/mcp/route.ts) y estas dos
-- tablas son su puerta y su registro.
--
-- QUÉ GUARDA.
--   · `agent_tokens`: un token por agente, de una organización. Lo crea en
--     Automatizaciones › Conector de IA quien tiene `automations.manage`; se
--     muestra UNA vez y se guarda solo su sha256. Dice qué tiendas ve
--     (`store_ids`, dentro de la organización) y qué herramientas puede usar
--     (`scopes`). Actúa con los accesos de quien lo creó (`created_by`): si esa
--     persona deja de ver una tienda o sale de la organización, el token deja de
--     verla también. Revocarlo (`revoked_at`) lo apaga en el acto.
--   · `agent_tool_calls`: una fila por llamada a una herramienta: qué token,
--     qué herramienta, qué tienda y pedido, si salió bien y cuánto tardó. SIN
--     lo que se preguntó ni lo que se contestó (ni teléfonos ni nombres). Sirve
--     para el tope por minuto y para revisar qué hizo cada agente.
--
-- SIN LLAVES FORÁNEAS, como la 0277: crearlas tomaría un candado de `stores` y
-- de `organizations`, que el panel lee en cada consulta. Se validan en el
-- código al crear el token y en cada llamada.
--
-- Se aplica a mano ANTES del código (DEPLOY.md, entrada del 08-11-2026). Sin
-- ella `/api/mcp` contesta 503 y la pantalla lo dice. Es idempotente.
-- ============================================================================

-- ── 1. Los tokens ────────────────────────────────────────────────────────────
create table if not exists agent_tokens (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  -- Quién lo creó: el token ve y hace solo lo que esta persona puede.
  created_by    uuid not null,
  -- El nombre que se le da en la pantalla («Grok Bot · atención»).
  label         text not null check (length(btrim(label)) between 1 and 80),
  token_hash    text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  -- Los primeros caracteres del token (`kagt_AbCd`), para reconocerlo en la
  -- lista sin guardar el resto.
  token_hint    text not null check (token_hint ~ '^kagt_[A-Za-z0-9_-]{4}$'),
  store_ids     uuid[] not null check (cardinality(store_ids) between 1 and 50),
  scopes        text[] not null check (
    cardinality(scopes) between 1 and 20
    and scopes <@ array['pedidos.leer', 'conversaciones.leer', 'politicas.leer',
                        'pedidos.nota', 'whatsapp.enviar', 'aliclik.crear_guia']::text[]
  ),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid,
  last_used_at  timestamptz,
  last_tool     text check (last_tool is null or last_tool ~ '^[a-z_]{2,40}$')
);

create index if not exists agent_tokens_org_idx on agent_tokens (org_id, created_at desc);

comment on table agent_tokens is
  'MOM §42: tokens del conector MCP (/api/mcp) para agentes de IA (Grok Bot). Uno por agente, de una organización, guardado solo como sha256. store_ids y scopes limitan lo que ve y hace; actúa con los accesos de created_by. Solo service_role.';

-- ── 2. El registro de llamadas ───────────────────────────────────────────────
create table if not exists agent_tool_calls (
  id           bigint generated always as identity primary key,
  token_id     uuid not null,
  tool         text not null check (tool ~ '^[a-z_]{2,40}$'),
  store_id     uuid,
  order_id     uuid,
  ok           boolean not null,
  -- El código del fallo (`no_encontrado`, `sin_permiso`…), sin datos de la clienta.
  error_code   text check (error_code is null or error_code ~ '^[a-z_]{2,40}$'),
  duration_ms  integer check (duration_ms is null or duration_ms >= 0),
  created_at   timestamptz not null default now()
);

-- El tope por minuto cuenta las llamadas recientes del token; la pantalla lista
-- las últimas.
create index if not exists agent_tool_calls_token_created_idx
  on agent_tool_calls (token_id, created_at desc);

comment on table agent_tool_calls is
  'MOM §42: una fila por llamada a una herramienta del conector MCP: token, herramienta, tienda, pedido, resultado y duración. Sin argumentos ni respuestas (ni teléfonos ni nombres). Solo service_role.';

-- ── 3. Solo el servidor ──────────────────────────────────────────────────────
alter table agent_tokens enable row level security;
revoke all on agent_tokens from anon, authenticated;
grant all privileges on agent_tokens to service_role;
alter table agent_tool_calls enable row level security;
revoke all on agent_tool_calls from anon, authenticated;
grant all privileges on agent_tool_calls to service_role;
