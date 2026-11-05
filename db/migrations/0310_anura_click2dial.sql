-- ============================================================================
-- 0310_anura_click2dial.sql — «Llamar con Anura», fase 1 (Click2Dial).
--
-- QUÉ ES. Desde la ficha del pedido la asesora pide la llamada y Anura hace
-- sonar SU teléfono de Anura (la terminal principal de su anexo); cuando ella
-- contesta, Anura marca a la clienta. Kapta no tiene teléfono en el navegador
-- en esta fase ni guarda usuarios o claves SIP. Anura avisa cada llamada
-- (START, TALK, END) a /api/webhooks/anura y, al terminar, Kapta copia la
-- grabación a su Storage privado: el enlace de Anura vence a los 30 minutos.
--
-- QUÉ CREA.
--   * `anura_extensions`: el anexo de Anura de cada persona, por organización
--     (una sola central para la org: Kenku y Aurela comparten la cuenta). Uno
--     por persona y uno por anexo dentro de la org. Sin anexo no hay botón.
--   * `anura_calls`: una fila por llamada. Nace `solicitada` al pedirla y la
--     mueven los avisos de Anura; el rango solo sube (un aviso repetido o
--     fuera de orden no la retrocede). Una sola llamada activa por persona.
--     Las entrantes quedan como hecho informativo (`modo = entrante`).
--   * `anura_webhook_events`: la bitácora de avisos (30 días), con el
--     teléfono enmascarado. Solo el servidor: guarda el enlace temporal de la
--     grabación, que se usa para reintentar la copia.
--   * El bucket privado `anura-recordings` (si existe el esquema de Storage).
--
-- LO QUE NO HACE. La llamada es un HECHO: no mueve la gestión del pedido (el
-- resultado se sigue registrando en la mesa de confirmación, MOM §6.1, como
-- en §8.5) y no entra en «Gestión por persona». Al terminar, el servidor deja
-- `anura_call` en `order_events`, igual que `browser_call`.
--
-- Lectura por RLS (solo lectura): los anexos, los miembros de la org; las
-- llamadas, quien ve la tienda del pedido. Escribe solo el servidor
-- (service_role). No cambia datos. Correrla otra vez no cambia nada.
-- ============================================================================

create table if not exists public.anura_extensions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  -- El anexo de la central de Anura: de 2 a 6 dígitos («101»).
  extension   text not null check (extension ~ '^[0-9]{2,6}$'),
  active      boolean not null default true,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint anura_extensions_user_uniq unique (org_id, user_id),
  constraint anura_extensions_extension_uniq unique (org_id, extension)
);

comment on table public.anura_extensions is
  'Anexo de Anura de cada persona por organización («Llamar con Anura», fase 1). Lo asigna en Ajustes quien administra tiendas.';

drop trigger if exists anura_extensions_touch on public.anura_extensions;
create trigger anura_extensions_touch before update on public.anura_extensions
  for each row execute function public.touch_updated_at();

create table if not exists public.anura_calls (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  -- La tienda del pedido. Null en una prueba (no es de ningún pedido y así
  -- nadie más lee el número que se escribió) y en una entrante (no se une a
  -- ningún pedido en la fase 1).
  store_id           uuid references public.stores(id) on delete cascade,
  -- Borrar el pedido borra sus llamadas, como el resto de sus hijos (0251,
  -- 0306): `set null` chocaría con `anura_calls_mode_ck`.
  order_id           uuid references public.orders(id) on delete cascade,
  -- Quien la pidió; en una entrante, la dueña del anexo que contestó.
  user_id            uuid references auth.users(id) on delete set null,
  -- pedido: desde la ficha · prueba: desde Ajustes, no es intento de ningún
  -- pedido · entrante: la avisó Anura, nadie la pidió desde Kapta.
  mode               text not null check (mode in ('pedido', 'prueba', 'entrante')),
  direction          text not null check (direction in ('out', 'in')),
  extension          text check (extension is null or extension ~ '^[0-9]{2,6}$'),
  -- Saliente: el número marcado (9 dígitos, sin 51), el mismo que guarda el
  -- historial de §8.5. Entrante: el que llamó, ENMASCARADO (`98••••321`).
  phone              text,
  status             text not null default 'solicitada' check (status in (
                       'solicitada', 'sonando', 'en_curso',
                       'contestada', 'no_contestada', 'ocupado', 'fallida', 'perdida')),
  -- 0 solicitada · 10 sonando · 20 en_curso · 100 final. Solo sube.
  status_rank        smallint not null default 0 check (status_rank in (0, 10, 20, 100)),
  -- El `cdrid` de Anura: llega en el primer aviso (Click2Dial no da id).
  anura_call_id      text,
  -- El `status` crudo del END (ANSWER, BUSY, NOANSWER, CONGESTION…).
  anura_status       text,
  bill_seconds       integer check (bill_seconds is null or bill_seconds >= 0),
  answer_extension   text,
  was_recorded       boolean,
  -- Por qué no se habló o no salió, en palabras que la asesora entiende.
  failure_reason     text,
  -- Se cerró sola porque Anura no avisó nada (60 s) o no avisó el final.
  closed_by_timeout  boolean not null default false,
  -- La grabación: sin_grabacion · pendiente (hay enlace, falta copiarla) ·
  -- guardada (en `anura-recordings`) · vencida (pasaron 30 min sin copiarla).
  recording_status   text not null default 'sin_grabacion' check (recording_status in (
                       'sin_grabacion', 'pendiente', 'guardada', 'vencida')),
  recording_path     text,
  recording_expires_at timestamptz,
  recording_attempts integer not null default 0,
  recording_error    text,
  requested_at       timestamptz not null default now(),
  started_at         timestamptz,
  answered_at        timestamptz,
  ended_at           timestamptz,
  last_event_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint anura_calls_rank_ck check (
    (status = 'solicitada' and status_rank = 0)
    or (status = 'sonando' and status_rank = 10)
    or (status = 'en_curso' and status_rank = 20)
    or (status in ('contestada', 'no_contestada', 'ocupado', 'fallida', 'perdida') and status_rank = 100)
  ),
  constraint anura_calls_mode_ck check (
    (mode = 'pedido' and order_id is not null and store_id is not null and direction = 'out')
    or (mode = 'prueba' and order_id is null and direction = 'out')
    or (mode = 'entrante' and order_id is null and direction = 'in')
  ),
  constraint anura_calls_recording_ck check (
    (recording_status = 'guardada') = (recording_path is not null)
  )
);

comment on table public.anura_calls is
  'Una fila por llamada de Anura (Click2Dial). La mueven los avisos de Anura; el rango solo sube. Escribe solo el servidor.';

-- Un mismo `cdrid` es una sola llamada por org: un aviso repetido no crea otra.
create unique index if not exists anura_calls_cdr_uniq
  on public.anura_calls (org_id, anura_call_id) where anura_call_id is not null;
-- Una sola llamada activa por persona (la base lo sostiene aunque lleguen dos
-- clics a la vez o haya dos pestañas).
create unique index if not exists anura_calls_one_active_per_user
  on public.anura_calls (user_id)
  where status_rank < 100 and mode in ('pedido', 'prueba') and user_id is not null;
create index if not exists anura_calls_order_idx
  on public.anura_calls (order_id, requested_at desc) where order_id is not null;
create index if not exists anura_calls_org_idx
  on public.anura_calls (org_id, requested_at desc);

drop trigger if exists anura_calls_touch on public.anura_calls;
create trigger anura_calls_touch before update on public.anura_calls
  for each row execute function public.touch_updated_at();

create table if not exists public.anura_webhook_events (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  received_at  timestamptz not null default now(),
  event        text,
  direction    text,
  anura_status text,
  anura_call_id text,
  custom1      text,
  call_id      uuid references public.anura_calls(id) on delete set null,
  -- aplicado · repetido (no cambió nada) · ignorado · error.
  outcome      text not null check (outcome in ('aplicado', 'repetido', 'ignorado', 'error')),
  detail       text,
  -- El aviso con los teléfonos ENMASCARADOS y sin el enlace de la grabación.
  payload      jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  -- El enlace de la grabación (vence a los 30 min): solo para copiarla.
  recording_url text
);

comment on table public.anura_webhook_events is
  'Bitácora de avisos de Anura (30 días; teléfonos enmascarados). Solo el servidor.';

create index if not exists anura_webhook_events_org_idx
  on public.anura_webhook_events (org_id, received_at desc);
create index if not exists anura_webhook_events_call_idx
  on public.anura_webhook_events (call_id, received_at desc) where call_id is not null;

alter table public.anura_extensions enable row level security;
alter table public.anura_calls enable row level security;
alter table public.anura_webhook_events enable row level security;

drop policy if exists anura_extensions_read on public.anura_extensions;
create policy anura_extensions_read on public.anura_extensions
  for select to authenticated using (org_id in (select auth_org_ids()));
drop policy if exists anura_calls_read on public.anura_calls;
create policy anura_calls_read on public.anura_calls
  for select to authenticated using (store_id in (select auth_store_ids()));
-- anura_webhook_events: sin política. La lee el servidor después de
-- comprobar `stores.manage`.

revoke all on public.anura_extensions, public.anura_calls, public.anura_webhook_events from anon, authenticated;
grant select on public.anura_extensions, public.anura_calls to authenticated;
grant all on public.anura_extensions, public.anura_calls, public.anura_webhook_events to service_role;

-- El bucket privado de las grabaciones. En Supabase existe `storage.buckets`;
-- en una base sin Storage (la de pruebas) se salta. El código también lo crea
-- si falta (`createBucket`, privado).
do $bucket$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('anura-recordings', 'anura-recordings', false)
    on conflict (id) do nothing;
  end if;
end
$bucket$;
