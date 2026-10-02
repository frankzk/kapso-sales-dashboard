-- 0218_olva_portal_cotejo.sql — «Cotejar Olva»: leer del portal de clientes de
-- Olva los envíos que la empresa registró y pegarles su tracking a las salidas
-- de Kapta que no lo tienen (MOM §12, «Cotejar Olva»).
--
-- POR QUÉ. Sin tracking Kapta no rastrea el envío ni le avisa a la clienta.
-- Del 22-09 al 02-10-2026 ninguna de las 28 salidas de Olva lo tuvo: había que
-- teclearlo a mano y nadie lo hacía. El portal (atc.olvaexpress.pe →
-- «Seguimiento de envíos») sí lista todos los envíos de la cuenta, con su
-- destinatario y su dirección.
--
-- CREDENCIALES. Las del portal de clientes, por tienda, como las de Shalom Pro:
-- el usuario en claro, la contraseña cifrada (`lib/crypto`, nunca vuelve al
-- navegador) y el RUC de la cuenta, que el portal pide en cada consulta. Si
-- dos tiendas despachan con la misma cuenta, basta con ponerlas en una: el
-- cotejo mira las salidas de todas las tiendas de la organización.
--
-- BITÁCORA. Cada cotejo —el automático, el del botón y el de pegar la
-- respuesta a mano— deja una fila con lo que trajo, lo que vinculó y lo que
-- dejó para revisar. La pantalla enseña la última.

alter table stores
  add column if not exists olva_portal_username     text,
  add column if not exists olva_portal_password_enc text,
  add column if not exists olva_portal_ruc          text
    check (olva_portal_ruc is null or olva_portal_ruc ~ '^\d{11}$');

comment on column stores.olva_portal_username is
  'Usuario del portal de clientes de Olva (atc.olvaexpress.pe). Para «Cotejar Olva».';
comment on column stores.olva_portal_password_enc is
  'Contraseña del portal de clientes de Olva, cifrada con lib/crypto.';
comment on column stores.olva_portal_ruc is
  'RUC de la cuenta de Olva: el portal lo pide como «documento» en cada consulta.';

create table if not exists olva_portal_runs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  store_id    uuid references stores(id) on delete set null,
  source      text not null check (source in ('cron', 'manual', 'pegado')),
  desde       date,
  hasta       date,
  ok          boolean not null,
  error       text,
  fetched     integer not null default 0,
  linked      integer not null default 0,
  resumen     jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists olva_portal_runs_org_idx
  on olva_portal_runs(org_id, created_at desc);

comment on table olva_portal_runs is
  'Cada cotejo de los envíos del portal de Olva contra las salidas de Kapta: qué trajo, qué vinculó y qué quedó por revisar.';

alter table olva_portal_runs enable row level security;
drop policy if exists olva_portal_runs_select on olva_portal_runs;
create policy olva_portal_runs_select on olva_portal_runs for select to authenticated
  using (org_id in (select auth_org_ids()));
grant select on olva_portal_runs to authenticated;
grant all privileges on olva_portal_runs to service_role;
