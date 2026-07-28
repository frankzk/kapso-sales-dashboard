-- ============================================================================
-- 0057_aliclik_webhook_events.sql — bitácora de notificaciones de Aliclik.
--
-- CONTEXTO DE SEGURIDAD. El webhook de Aliclik NO viene firmado: la
-- documentación define el payload
--   { orderNumber, dispatchStatus, status, callStatus }
-- y ninguna cabecera de autenticación, ni HMAC, ni lista de IPs. Tampoco trae
-- timestamp, y la propia documentación avisa de que "los estados pueden llegar
-- en desorden".
--
-- La respuesta a eso es doble, y solo la primera mitad vive aquí:
--
--   1) Autenticación por secreto en la URL (?secret=…), comparado en tiempo
--      constante — el mismo patrón que el webhook de Kapso. El panel de Aliclik
--      acepta una URL libre, así que cabe.
--
--   2) EL PAYLOAD NO SE CREE. El handler no escribe el estado que llega en el
--      cuerpo: registra el evento aquí y vuelve a preguntar por
--      `GET /integration/order?orderNumber=…`, escribiendo ESA respuesta, que sí
--      trae `updatedAt` real y sirve de guarda monotónica. Así el desorden
--      desaparece y una notificación falsificada, como mucho, nos hace releer la
--      verdad desde Aliclik.
--
-- La idempotencia que pide la documentación es el índice único sobre el
-- fingerprint: reenviar el mismo estado no vuelve a disparar la lectura.
--
-- APPEND-ONLY, como order_events (0045) y pickup_key_views (0049): trigger
-- `reject_mutation` + privilegios recortados (ver 0053 — Supabase concede todo
-- por defecto, así que hay que revocar primero).
--
-- Aplicar DESPUÉS de supabase/policies.sql.
-- ============================================================================

create table if not exists aliclik_webhook_events (
  id            uuid primary key default gen_random_uuid(),
  -- Puede ser nulo: el payload solo trae el orderNumber, y si todavía no
  -- conocemos esa guía no hay tienda a la que atribuirlo. Se registra igual —
  -- un evento que no supimos ubicar es justo lo que hay que poder investigar.
  store_id      uuid references stores(id) on delete cascade,
  order_number  text not null,
  -- sha256 de orderNumber|status|callStatus|dispatchStatus. Ver lib/aliclik-track.ts.
  fingerprint   text not null,
  status        text,
  call_status   text,
  dispatch_status text,
  payload       jsonb not null default '{}'::jsonb,
  -- Qué hicimos con él: applied | duplicate | unknown_order | error
  outcome       text,
  received_at   timestamptz not null default now()
);

-- LA IDEMPOTENCIA. El mismo estado reenviado choca aquí y no releemos la API.
create unique index if not exists aliclik_webhook_events_fingerprint_uniq
  on aliclik_webhook_events(fingerprint);

create index if not exists aliclik_webhook_events_order_idx
  on aliclik_webhook_events(order_number, received_at desc);
create index if not exists aliclik_webhook_events_store_idx
  on aliclik_webhook_events(store_id, received_at desc);

alter table aliclik_webhook_events enable row level security;

drop policy if exists aliclik_webhook_events_select on aliclik_webhook_events;
create policy aliclik_webhook_events_select on aliclik_webhook_events for select to authenticated
  using (store_id in (select auth_store_ids()));

-- Append-only: ni el rol con el que escriben los server actions reescribe esto.
revoke all on aliclik_webhook_events from anon, authenticated, service_role;
grant select         on aliclik_webhook_events to authenticated;
grant select, insert on aliclik_webhook_events to service_role;

-- Segunda cerradura, además de los privilegios (reject_mutation() se define en
-- 0045_order_master.sql junto a order_events).
drop trigger if exists aliclik_webhook_events_immutable on aliclik_webhook_events;
create trigger aliclik_webhook_events_immutable
  before update or delete on aliclik_webhook_events
  for each row execute function public.reject_mutation();

comment on table aliclik_webhook_events is
  'Notificaciones de Aliclik, append-only. El payload es un disparador, no un hecho: el estado se relee de la API.';
