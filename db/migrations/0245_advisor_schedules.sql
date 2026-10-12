-- ============================================================================
-- 0245_advisor_schedules.sql — la meta de horas por semana y el horario de cada
-- persona del equipo de venta, para Productividad.
--
-- DECISIÓN DEL OWNER (12-10-2026): con asesoras en remoto hace falta saber que
-- cumplen su horario y sus horas de la semana (48 h). Se eligió:
--
--   * Las horas que cuentan son las ACTIVAS, las mismas que ya calcula
--     Productividad: bloques entre la primera y la última acción, cortados en
--     pausas de más de 45 minutos. No se registra la presencia.
--   * Meta y horario POR PERSONA, editables en Equipo › Horarios.
--   * En Productividad, la semana en curso contra la meta (columna y panel).
--
-- QUÉ GUARDA. Una fila por persona y organización:
--
--   * `weekly_hours`: la meta de la semana (48 por defecto).
--   * `days`: los días que trabaja, ISO (1 = lunes … 7 = domingo); la meta se
--     reparte por igual entre ellos.
--   * `start_time` / `end_time`: el horario, opcional. Con horario, Productividad
--     marca la primera actividad tarde y la última antes de la salida; sin él,
--     solo compara horas.
--
-- Quien no tiene fila usa la meta por defecto (48 h, lunes a sábado, sin
-- horario): así la columna dice algo desde el primer día.
--
-- Solo la leen y la escriben el servidor (`service_role`) tras comprobar el rol:
-- la escribe un owner/admin desde Equipo y la lee Productividad, donde una
-- vendedora solo recibe la suya.
--
-- Idempotente: correrla dos veces no cambia nada. Sin `begin`/`commit` propios,
-- como el resto de migraciones: dentro del bundle concatenado cortarían el script.
-- ============================================================================

create table if not exists advisor_schedules (
  org_id       uuid not null references organizations(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  weekly_hours numeric(4,1) not null default 48
               check (weekly_hours >= 0 and weekly_hours <= 84),
  days         smallint[] not null default '{1,2,3,4,5,6}'
               check (days <@ '{1,2,3,4,5,6,7}'::smallint[]),
  start_time   time,
  end_time     time,
  updated_by   uuid references auth.users(id) on delete set null,
  updated_at   timestamptz not null default now(),
  primary key (org_id, user_id),
  -- El horario va entero o no va: una entrada sin salida no se puede juzgar.
  constraint advisor_schedules_window_ck check (
    (start_time is null and end_time is null)
    or (start_time is not null and end_time is not null and start_time < end_time)
  )
);

comment on table advisor_schedules is
  'Meta de horas por semana y horario de cada persona del equipo de venta (Productividad). Solo el servidor.';

alter table advisor_schedules enable row level security;
revoke all on advisor_schedules from anon, authenticated;
grant all privileges on advisor_schedules to service_role;
