-- ============================================================================
-- 0313_anura_line_pool.sql — «Llamar con Anura»: líneas compartidas (un pool
-- de anexos) y la casilla «Puede llamar con Anura» (MOM §8.7, 08-11-2026).
--
-- QUÉ ES. Hasta la 0312 cada anexo de Anura era de UNA persona. Decisión del
-- owner (08-11-2026): «¿no puede ser algo dinámico… el anexo asignado
-- aleatoriamente?» → sí. La org tiene unas pocas líneas compartidas (empieza
-- con 3; el plan de Anura permite hasta 10, y esto sirve para cualquier N) y
-- quien tiene la casilla «Puede llamar con Anura» toma una LIBRE al llamar.
-- La línea solo se usa con el teléfono dentro de Kapta (fase 2): Kapta la
-- reserva, el navegador se registra con la clave de ESA línea y recién
-- entonces pide el Click2Dial con ella.
--
-- QUÉ AGREGA (aditiva: no reescribe ninguna fila).
--   * `anura_extensions.pool`: la fila es una línea compartida. Una línea
--     compartida no tiene dueña (`user_id` null); un anexo propio sí. Se
--     quita el `not null` de `user_id` y lo sostiene el chequeo
--     `anura_extensions_pool_owner_ck`. Sigue `unique (org_id, extension)`:
--     un número es O una línea compartida O el anexo de una persona. El
--     anexo propio sigue funcionando igual (quien lo tiene llama con él).
--   * `anura_callers`: la casilla «Puede llamar con Anura» por persona y org.
--     La leen los miembros de la org; la escribe solo el servidor.
--   * `anura_calls.reserved_at` / `dialed_at`: cuándo Kapta reservó una línea
--     compartida (al entregar su clave) y cuándo pidió de verdad el
--     Click2Dial. Una reserva que nunca llegó a pedirse se suelta sola a los
--     60 s («La llamada no llegó a pedirse.») y no deja hecho en el pedido.
--     Una fila sin `reserved_at` es una llamada de antes o con anexo propio.
--   * `anura_calls_one_active_per_extension`: una línea nunca tiene dos
--     llamadas vivas a la vez, aunque dos asesoras pidan en el mismo
--     instante. Se suma a `anura_calls_one_active_per_user` (0310), que
--     sigue: una llamada viva por persona.
--
-- Lectura por RLS (solo lectura): las líneas y las casillas, los miembros de
-- la org. Escribe solo el servidor (service_role). Correrla otra vez no
-- cambia nada.
-- ============================================================================

-- --- Líneas compartidas --------------------------------------------------------

alter table public.anura_extensions add column if not exists pool boolean not null default false;
alter table public.anura_extensions alter column user_id drop not null;

alter table public.anura_extensions drop constraint if exists anura_extensions_pool_owner_ck;
alter table public.anura_extensions add constraint anura_extensions_pool_owner_ck check (
  (pool and user_id is null) or (not pool and user_id is not null)
);

comment on column public.anura_extensions.pool is
  'Línea compartida (0313): sin dueña; la toma quien tiene «Puede llamar con Anura» al llamar, si está libre.';

create index if not exists anura_extensions_pool_idx on public.anura_extensions (org_id) where pool;

-- --- «Puede llamar con Anura» --------------------------------------------------

create table if not exists public.anura_callers (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  enabled     boolean not null default true,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint anura_callers_user_uniq unique (org_id, user_id)
);

comment on table public.anura_callers is
  '«Puede llamar con Anura» (0313): quién toma una línea compartida al llamar. Lo marca en Ajustes quien administra tiendas.';

drop trigger if exists anura_callers_touch on public.anura_callers;
create trigger anura_callers_touch before update on public.anura_callers
  for each row execute function public.touch_updated_at();

alter table public.anura_callers enable row level security;
drop policy if exists anura_callers_read on public.anura_callers;
create policy anura_callers_read on public.anura_callers
  for select to authenticated using (org_id in (select auth_org_ids()));

revoke all on public.anura_callers from anon, authenticated;
grant select on public.anura_callers to authenticated;
grant all on public.anura_callers to service_role;

-- --- La reserva de una línea ---------------------------------------------------

alter table public.anura_calls add column if not exists reserved_at timestamptz;
alter table public.anura_calls add column if not exists dialed_at timestamptz;

comment on column public.anura_calls.reserved_at is
  'Kapta reservó una línea compartida para esta llamada (0313). Null: llamada con anexo propio o de antes de la 0313.';
comment on column public.anura_calls.dialed_at is
  'Kapta pidió el Click2Dial (0313). Una reserva sin esto a los 60 s se suelta sola y no es un intento de contacto.';

-- Una línea, una llamada viva. Antes de crear el índice se comprueba que hoy
-- no haya dos vivas en el mismo anexo (no se reescribe nada para arreglarlo:
-- si las hay, el cron de Anura las cierra o se cierran a mano y se vuelve a
-- correr la migración).
do $dup$
begin
  if exists (
    select 1
    from public.anura_calls
    where status_rank < 100 and mode in ('pedido', 'prueba') and extension is not null
    group by org_id, extension
    having count(*) > 1
  ) then
    raise exception '0313: hay un anexo con dos llamadas de Anura vivas a la vez. Espera a que el cron de Anura las cierre (o ciérralas) y vuelve a correr la migración.';
  end if;
end
$dup$;

create unique index if not exists anura_calls_one_active_per_extension
  on public.anura_calls (org_id, extension)
  where status_rank < 100 and mode in ('pedido', 'prueba') and extension is not null;

-- La línea que menos se usó primero: la última llamada de cada anexo.
create index if not exists anura_calls_extension_recent_idx
  on public.anura_calls (org_id, extension, requested_at desc) where extension is not null;
