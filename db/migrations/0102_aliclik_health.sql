-- 0102 — Semáforo de salud de la API de Aliclik.
--
-- Un cron sondea la API de cotización cada 5 min (solo 7am–11pm Perú) y deja
-- aquí el resultado. El drawer lee la última fila por org y pinta un foco:
-- verde (operativo), rojo (fallos) o gris (sin sonda reciente = de noche o cron
-- caído). Es append-only: sirve para el foco hoy y para un histórico/uptime
-- mañana sin cambiar nada.

create table if not exists aliclik_health_checks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  checked_at timestamptz not null default now(),
  -- 'operativo' | 'fallos'. El gris NO se guarda: se deduce de la frescura.
  status text not null check (status in ('operativo', 'fallos')),
  probes_total integer not null,
  probes_ok integer not null,
  latency_ms integer,
  -- Resultado por punto de referencia, para el histórico.
  detail jsonb not null default '[]'::jsonb
);

-- El drawer pide "la última de esta org": este índice la sirve directo.
create index if not exists aliclik_health_checks_org_recent
  on aliclik_health_checks (org_id, checked_at desc);

revoke all on table aliclik_health_checks from public, anon, authenticated;
grant select on table aliclik_health_checks to authenticated;
grant all on table aliclik_health_checks to service_role;

alter table aliclik_health_checks enable row level security;

-- Lectura: un miembro de la org ve la salud de SU org. La salud no es un dato
-- sensible, pero se cierra por org con el mismo helper que el resto del esquema.
drop policy if exists aliclik_health_read on aliclik_health_checks;
create policy aliclik_health_read on aliclik_health_checks
  for select
  using (org_id in (select auth_org_ids()));

-- Escritura: solo el cron (service_role), que salta RLS. Nadie más inserta.
