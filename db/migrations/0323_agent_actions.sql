-- ============================================================================
-- 0323_agent_actions.sql — lo que el agente de IA (Grok) puede hacer en Kapta:
-- notas, WhatsApp a la clienta y guías de Aliclik (MOM §42.9, parte 3;
-- 08-11-2026).
--
-- POR QUÉ. El owner decidió (08-11-2026) que el agente haga tres cosas, con
-- frenos que pone Kapta haga lo que haga el agente:
--   · notas en el pedido: solas desde el primer día (riesgo bajo);
--   · WhatsApp a la clienta (solo dentro de las 24 h) y guías de Aliclik: con
--     un interruptor por organización Apagado / Simulación / Activo, como las
--     demás automatizaciones (§40); una semana en Simulación revisando lo que
--     habría hecho y después Activo, con topes diarios. Mientras tanto, lo que
--     el owner le pida en el chat y apruebe ahí se hace de verdad.
--
-- QUÉ GUARDA.
--   · `agent_action_settings`: por organización, la posición de WhatsApp y de
--     guías (nace en Simulación) y sus topes por día de Lima (20 y 10).
--   · `agent_actions`: cada acción que pide el agente: qué, sobre qué pedido,
--     desde dónde («chat» o «rutina», lo declara el agente), con qué texto o
--     guía, y qué pasó (prevista, simulada, hecha, rechazada, con error o
--     incierta). La vista previa deja un código de un solo uso de 10 minutos
--     (se guarda su sha256) que se canjea para ejecutar. Es también el registro
--     de los topes, de «una vez y no más» y de la revisión de la Simulación.
--     Guarda el texto que el agente quiso mandar: es lo que hay que revisar.
--
-- SOLO EL SERVIDOR, SIN LLAVES FORÁNEAS, como la 0314. Nadie borra.
--
-- Se aplica a mano ANTES del código (DEPLOY.md, entrada del 08-11-2026). Sin
-- ella las herramientas de escritura contestan que falta la migración; las de
-- lectura siguen igual. Es idempotente.
-- ============================================================================

-- ── 1. Interruptores y topes por organización ───────────────────────────────
create table if not exists agent_action_settings (
  org_id              uuid primary key,
  whatsapp_mode       text not null default 'simulacion' check (whatsapp_mode in ('apagado', 'simulacion', 'activo')),
  guide_mode          text not null default 'simulacion' check (guide_mode in ('apagado', 'simulacion', 'activo')),
  whatsapp_daily_cap  integer not null default 20 check (whatsapp_daily_cap between 1 and 200),
  guide_daily_cap     integer not null default 10 check (guide_daily_cap between 1 and 100),
  updated_at          timestamptz not null default now(),
  updated_by          uuid
);

comment on table agent_action_settings is
  'MOM §42.9: posición (apagado/simulacion/activo) y tope diario de WhatsApp y de guías Aliclik del agente de IA, por organización. Sin fila = Simulación con los topes de fábrica. Solo service_role.';

-- ── 2. Cada acción del agente ────────────────────────────────────────────────
create table if not exists agent_actions (
  id            uuid primary key default gen_random_uuid(),
  token_id      uuid not null,
  org_id        uuid not null,
  store_id      uuid not null,
  order_id      uuid not null,
  -- Con los permisos de quién (el creador del token).
  acting_user   uuid not null,
  action        text not null check (action in ('nota', 'whatsapp', 'guia_aliclik')),
  origin        text not null check (origin in ('chat', 'rutina')),
  status        text not null check (status in ('prevista', 'en_curso', 'simulada', 'hecha', 'rechazada', 'error', 'incierta')),
  -- La posición del interruptor cuando se resolvió.
  mode          text check (mode is null or mode in ('apagado', 'simulacion', 'activo')),
  -- Lo que se quiso hacer: el texto de la nota o del mensaje (normalizado en
  -- `body_key` para «nunca el mismo texto dos veces»), o la guía cotizada.
  body          text check (body is null or length(body) <= 2000),
  body_key      text check (body_key is null or body_key ~ '^[0-9a-f]{64}$'),
  details       jsonb not null default '{}'::jsonb,
  -- El código de confirmación de la vista previa (sha256), de un solo uso.
  code_hash     text unique check (code_hash is null or code_hash ~ '^[0-9a-f]{64}$'),
  code_expires_at timestamptz,
  error_code    text check (error_code is null or error_code ~ '^[a-z_]{2,40}$'),
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

create index if not exists agent_actions_org_action_idx on agent_actions (org_id, action, resolved_at desc);
create index if not exists agent_actions_order_idx on agent_actions (order_id, action, resolved_at desc);

comment on table agent_actions is
  'MOM §42.9: cada acción pedida por el agente de IA (nota, WhatsApp, guía Aliclik), con su vista previa (código sha256 de un solo uso), su origen declarado (chat/rutina), su resultado y el texto que quiso mandar. Sirve para topes, «una vez y no más» y revisar la Simulación. Solo service_role; nadie borra.';

-- ── 3. Solo el servidor, sin borrar ──────────────────────────────────────────
alter table agent_action_settings enable row level security;
revoke all on agent_action_settings from anon, authenticated, service_role;
grant select, insert, update on agent_action_settings to service_role;
alter table agent_actions enable row level security;
revoke all on agent_actions from anon, authenticated, service_role;
grant select, insert, update on agent_actions to service_role;
