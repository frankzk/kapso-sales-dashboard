-- 0201_swayp_inventory_sync_runs.sql — registro de cada sincronización del
-- stock contra el inventario de Swayp (MOM, «El mismo conteo, leído por API»).
--
-- Fase 3: el sync corre solo, cada hora, sin nadie mirando. Un cron que falla
-- en silencio es peor que el Excel: el stock se vuelve a separar de Swayp y
-- nadie se entera. Cada corrida —automática o con el botón— deja una fila con
-- qué hizo o por qué no pudo, y la pantalla de Stock Swayp muestra la última.
--
-- `resumen` es el resultado por ciudad (bajan/suben/altas/sin vincular/
-- unidades) y las ciudades que el cron se negó a tocar. El detalle de cada
-- cambio vive, como siempre, en el kardex (`fenix_stock_movements`).

create table if not exists swayp_inventory_sync_runs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  source      text not null check (source in ('cron', 'manual')),
  ok          boolean not null,
  error       text,
  resumen     jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists swayp_inventory_sync_runs_org_idx
  on swayp_inventory_sync_runs(org_id, created_at desc);

comment on table swayp_inventory_sync_runs is
  'Cada sincronización de fenix_stock contra el inventario de Swayp por API: automática (cron) o manual, con su resultado o su error.';

alter table swayp_inventory_sync_runs enable row level security;
drop policy if exists swayp_inventory_sync_runs_select on swayp_inventory_sync_runs;
create policy swayp_inventory_sync_runs_select on swayp_inventory_sync_runs for select to authenticated
  using (org_id in (select auth_org_ids()));
grant select on swayp_inventory_sync_runs to authenticated;
grant all privileges on swayp_inventory_sync_runs to service_role;
