-- 0107 — Anomalías de ingesta: hacer visible el trabajo que se descarta.
--
-- POR QUÉ. El modo de fallo recurrente de este sistema no es el error ruidoso,
-- es el descarte silencioso. Solo en `lib/` hay 58 `catch` que se tragan la
-- excepción (35 documentados como "best-effort") más los `return null` de las
-- rutas de ingesta. Cada uno es un sitio donde se puede perder trabajo sin que
-- nadie se entere, y en una sola jornada aparecieron dos casos reales: ~25
-- conversaciones diarias que no generaban lead, y handoffs rechazados por falta
-- de teléfono que nunca subían a "Atender ahora".
--
-- El precedente es `sinTelefono`: el ÚNICO sitio instrumentado. Gracias a él se
-- pudo fechar al día el inicio de la migración de identidad de Meta (23 días en
-- cero exacto, luego 1, 3, 11, 16, 20, 29) y decidir con números en vez de
-- intuición. Esta tabla generaliza ese contador.
--
-- ES UN DETECTOR DE CAMBIOS, NO UN LOG. Lo que importa no es "hay 25 descartes"
-- —eso puede ser lo normal— sino "ayer 0, hoy 25". Por eso se AGREGA por día en
-- vez de guardar un registro por evento: un log por evento crece sin fin, nadie
-- lo lee, y esconde justamente el salto que sí importa.
--
-- QUÉ NO CUBRE, para no confiarse: solo detecta trabajo DESCARTADO. Un camino
-- que devuelve un resultado equivocado sin descartar nada (como un filtro que no
-- empareja y hace re-derivar un estado) no pasa por aquí — eso lo atrapan los
-- tests, no esta tabla.

create table if not exists ingest_anomalies (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  -- Día LOCAL de la operación, no UTC: en Lima (UTC-5) el corte UTC cae a las
  -- 7 de la tarde y partiría en dos la jornada de trabajo, que es justo la
  -- unidad en la que se compara "ayer vs hoy".
  dia date not null,
  -- Qué camino descartó. p. ej. 'leads_sync', 'handoff', 'conversation_event'.
  source text not null,
  -- Por qué. p. ej. 'sin_identidad', 'enrich_falló', 'kapso_error'.
  reason text not null,
  count integer not null default 1,
  -- UN ejemplo del día, el primero. Sirve para reproducir sin guardar todo.
  sample jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (store_id, dia, source, reason)
);

-- La lectura es siempre "los últimos N días de estas tiendas".
create index if not exists ingest_anomalies_store_dia
  on ingest_anomalies (store_id, dia desc);

/**
 * Anota una anomalía sumando al contador del día.
 *
 * Va como función y no como upsert desde el cliente porque PostgREST no sabe
 * expresar `count = count + n`: sin esto haría falta leer-modificar-escribir, que
 * con dos procesos del cron solapados pierde cuentas en silencio — el mismo
 * problema que la tabla viene a resolver.
 *
 * `sample` conserva el PRIMERO del día (coalesce sobre el existente): un ejemplo
 * estable sirve para reproducir; uno que cambia en cada llamada no.
 */
create or replace function public.note_ingest_anomaly(
  p_store_id uuid,
  p_source text,
  p_reason text,
  p_count integer default 1,
  p_sample jsonb default null
) returns void
language sql
security definer
set search_path = public
as $$
  insert into ingest_anomalies (store_id, dia, source, reason, count, sample)
  values (
    p_store_id,
    (now() at time zone 'America/Lima')::date,
    p_source,
    p_reason,
    greatest(p_count, 1),
    p_sample
  )
  on conflict (store_id, dia, source, reason) do update
    set count = ingest_anomalies.count + greatest(p_count, 1),
        last_seen_at = now(),
        sample = coalesce(ingest_anomalies.sample, excluded.sample);
$$;

revoke all on function public.note_ingest_anomaly(uuid, text, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.note_ingest_anomaly(uuid, text, text, integer, jsonb) to service_role;

revoke all on table ingest_anomalies from public, anon, authenticated;
grant select on table ingest_anomalies to authenticated;
grant all on table ingest_anomalies to service_role;

alter table ingest_anomalies enable row level security;

-- Lectura: un miembro ve las anomalías de las tiendas que ya puede ver. No es
-- dato sensible, pero se cierra con el mismo helper que el resto del esquema.
-- Escritura: solo el ingestor (service_role, que salta RLS) vía la función.
drop policy if exists ingest_anomalies_read on ingest_anomalies;
create policy ingest_anomalies_read on ingest_anomalies
  for select
  using (store_id in (select auth_store_ids()));
