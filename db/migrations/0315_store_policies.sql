-- ============================================================================
-- 0315_store_policies.sql — las políticas escritas por tienda que lee el agente
-- de IA (MOM §42.6, parte 2; 08-11-2026).
--
-- POR QUÉ. El owner decidió que el agente (Grok Bot) consulte «las dos»
-- políticas: las que Kapta calcula (el adelanto mínimo, la cobertura del
-- distrito: 0314 y `consultar_politicas`) y las que cada tienda escribe —cambios,
-- devoluciones, garantías, horarios…—, que hoy no viven en ningún sitio del
-- sistema. Esta migración les da su lugar.
--
-- QUÉ GUARDA.
--   · `store_policies`: una política por fila, de una tienda: título, texto,
--     desde qué día vale (`valid_from`, día de Lima) y hasta cuál
--     (`valid_until`, opcional), de dónde sale (`source`, opcional), quién la
--     creó y quién la cambió por última vez. Retirarla (`retired_at`) es final:
--     una retirada ya no se edita. La tienda, la organización y el autor no
--     cambian nunca.
--   · `store_policy_versions`: cada versión guardada, la escribe la base sola
--     (disparador) al crear, editar o retirar. Es la respuesta a «¿qué decía
--     la política el día que el agente se lo dijo a la clienta?». Nadie la
--     edita ni la borra: ni el servidor.
--
-- SOLO EL SERVIDOR, como la 0314: la pantalla (Automatizaciones › Conector de
-- IA, `automations.manage`) y el agente leen y escriben con service_role
-- después de comprobar el permiso y las tiendas. Sin llaves foráneas, como la
-- 0314 y la 0277: se validan en el código.
--
-- Se aplica a mano ANTES del código (DEPLOY.md, entrada del 08-11-2026). Sin
-- ella la pantalla lo dice y `consultar_politicas` devuelve solo las
-- calculadas. Es idempotente.
-- ============================================================================

-- ── 1. Las políticas ─────────────────────────────────────────────────────────
create table if not exists store_policies (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  store_id     uuid not null,
  title        text not null check (length(btrim(title)) between 2 and 80),
  body         text not null check (length(btrim(body)) between 2 and 4000),
  -- Días de Lima. Sin `valid_until`, vale hasta que se retire.
  valid_from   date not null,
  valid_until  date check (valid_until is null or valid_until >= valid_from),
  -- De dónde sale («la página de cambios de la web», «acuerdo con Shalom»…).
  source       text check (source is null or length(btrim(source)) between 1 and 200),
  created_by   uuid not null,
  created_at   timestamptz not null default now(),
  updated_by   uuid not null,
  updated_at   timestamptz not null default now(),
  version      integer not null default 1 check (version >= 1),
  retired_at   timestamptz,
  retired_by   uuid,
  constraint store_policies_retired_ck check ((retired_at is null) = (retired_by is null))
);

create index if not exists store_policies_store_idx on store_policies (store_id, valid_from desc);

comment on table store_policies is
  'MOM §42.6: políticas escritas por tienda (cambios, devoluciones, garantías…) que lee el agente de IA en consultar_politicas. Valen de valid_from a valid_until (días de Lima); retirada es final. Cada versión queda en store_policy_versions. Solo service_role.';

-- ── 2. Sus versiones ─────────────────────────────────────────────────────────
create table if not exists store_policy_versions (
  id           bigint generated always as identity primary key,
  policy_id    uuid not null,
  version      integer not null,
  title        text not null,
  body         text not null,
  valid_from   date not null,
  valid_until  date,
  source       text,
  edited_by    uuid not null,
  edited_at    timestamptz not null,
  retired_at   timestamptz,
  constraint store_policy_versions_once unique (policy_id, version)
);

comment on table store_policy_versions is
  'MOM §42.6: cada versión guardada de una política escrita (al crear, editar o retirar), escrita por el disparador de store_policies. Nadie la edita ni la borra.';

-- ── 3. Lo que la base sostiene ───────────────────────────────────────────────
-- Antes de guardar: la versión la pone la base (1 al crear, +1 al cambiar), y
-- también la hora; la tienda, la organización y el autor no cambian; una
-- retirada no se toca más.
create or replace function store_policies_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
    new.updated_by := new.created_by;
    new.updated_at := new.created_at;
    if new.retired_at is not null then
      raise exception 'store_policies: una política nace sin retirar' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.org_id is distinct from old.org_id or new.store_id is distinct from old.store_id
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'store_policies: la tienda, la organización y el autor no cambian' using errcode = 'check_violation';
  end if;
  if old.retired_at is not null then
    raise exception 'store_policies: una política retirada no se edita' using errcode = 'check_violation';
  end if;
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;

create or replace trigger store_policies_guard before insert or update on store_policies
  for each row execute function store_policies_guard();

-- Después de guardar: la versión queda escrita. SECURITY DEFINER para que el
-- servidor no necesite (ni tenga) permiso de escribir el historial a mano.
create or replace function store_policies_snapshot()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into store_policy_versions (policy_id, version, title, body, valid_from, valid_until, source, edited_by, edited_at, retired_at)
  values (new.id, new.version, new.title, new.body, new.valid_from, new.valid_until, new.source,
          coalesce(new.retired_by, new.updated_by), coalesce(new.retired_at, new.updated_at), new.retired_at);
  return null;
end $$;

create or replace trigger store_policies_snapshot after insert or update on store_policies
  for each row execute function store_policies_snapshot();

revoke all on function store_policies_snapshot() from public;

-- ── 4. Solo el servidor ──────────────────────────────────────────────────────
-- `revoke all` también de service_role: los privilegios por omisión de Supabase
-- le dan todo a cada tabla nueva, borrar incluido. Una política no se borra: se
-- retira.
alter table store_policies enable row level security;
revoke all on store_policies from anon, authenticated, service_role;
grant select, insert, update on store_policies to service_role;
alter table store_policy_versions enable row level security;
revoke all on store_policy_versions from anon, authenticated, service_role;
grant select on store_policy_versions to service_role;
