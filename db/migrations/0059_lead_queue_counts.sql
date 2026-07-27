-- ============================================================================
-- 0059_lead_queue_counts.sql — que abrir Leads deje de costar ocho recorridos
-- de la tabla.
--
-- QUÉ PASABA. Cada carga de /dashboard/leads (y cada refresco en vivo, que era
-- cada 30 s) lanzaba SIETE `count(*)` exactos sobre `leads` — uno por pestaña —
-- más el recorrido de la cola. Con ~2.500 leads por tienda eso es ocho pasadas
-- por lo mismo, en paralelo pero todas compitiendo por el mismo disco, cada
-- medio minuto y por cada asesora con la pestaña abierta. El panel se sentía
-- "reeeelento" sin que ninguna consulta fuera, por sí sola, lenta.
--
-- QUÉ HACE. `lead_queue_counts` calcula los siete conteos en UN solo recorrido
-- con `count(*) filter (...)`, y de paso devuelve la FIRMA de la cola
-- (`total` + `last_change`). La firma es lo que permite que el refresco en vivo
-- pregunte "¿cambió algo?" en una consulta barata en vez de recargar la página
-- entera cada 30 s cuando casi nunca hay nada nuevo.
--
-- Los filtros son copia EXACTA de los de lib/leads-access.ts, incluida la
-- semántica de `status <> 'yape_por_verificar'` (que en SQL, y en PostgREST,
-- deja fuera las filas con status NULL). Si divergen, las pestañas mienten.
--
-- `security invoker` (el valor por defecto, explícito aquí porque importa): la
-- función se ejecuta con los privilegios de quien llama, así que la RLS de
-- `leads` sigue aplicando y nadie cuenta leads de tiendas que no puede ver.
--
-- Los índices son para que ese único recorrido —y el orden de la cola— no
-- tengan que ordenar la tabla entera en memoria. Se crean sin CONCURRENTLY:
-- `leads` es de miles de filas, no de millones, y el bloqueo dura milisegundos.
--
-- Idempotente. No toca datos. Aplicar DESPUÉS de supabase/policies.sql.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Índices de la cola
-- ----------------------------------------------------------------------------

-- "Por llamar" ordena por needs_attention desc, last_interaction_at desc, id.
-- Sin este índice cada página del drenado re-ordenaba TODA la cola de la tienda.
-- El predicado parcial es el mismo `category in ('open','hot')` de la vista.
create index if not exists leads_queue_order_idx
  on leads (store_id, needs_attention desc, last_interaction_at desc, id)
  where category in ('open', 'hot');

-- "⚡ Atender ahora": needs_attention + handoff_at dentro de la ventana fresca.
create index if not exists leads_store_handoff_idx
  on leads (store_id, handoff_at desc)
  where needs_attention;

-- `status` participa en cuatro de los siete conteos (yape, sin llamar, y las dos
-- exclusiones), y no tenía índice propio por tienda.
create index if not exists leads_store_status_idx
  on leads (store_id, status);

-- ----------------------------------------------------------------------------
-- Conteos + firma en una sola consulta
-- ----------------------------------------------------------------------------

create or replace function public.lead_queue_counts(
  p_store_id       uuid,
  p_handoff_cutoff timestamptz,
  p_now            timestamptz
)
returns table (
  por_llamar   bigint,
  handoff      bigint,
  yape         bigint,
  seguimientos bigint,
  ganados      bigint,
  perdidos     bigint,
  sin_llamar   bigint,
  -- Firma de la cola: con estos dos el cliente sabe si merece la pena recargar.
  -- `total` capta altas y bajas; `last_change` (que mantiene el trigger
  -- `leads_touch`) capta cualquier edición de una fila existente.
  total        bigint,
  last_change  timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*) filter (
      where category in ('open', 'hot') and status <> 'yape_por_verificar'
    ),
    count(*) filter (
      where needs_attention and handoff_at >= p_handoff_cutoff
    ),
    count(*) filter (where status = 'yape_por_verificar'),
    count(*) filter (
      where next_followup_at is not null and next_followup_at <= p_now
    ),
    count(*) filter (where category = 'won'),
    count(*) filter (where category = 'lost'),
    count(*) filter (where category in ('open', 'hot') and status = 'nuevo'),
    count(*),
    max(updated_at)
  from public.leads
  where store_id = p_store_id;
$$;

comment on function public.lead_queue_counts(uuid, timestamptz, timestamptz) is
  'Los 7 conteos de las pestañas de Leads + la firma de la cola, en un solo recorrido. security invoker: la RLS de leads sigue mandando.';

-- Supabase concede EXECUTE a public por defecto en cada función nueva; se quita
-- y se concede solo a quien la necesita (mismo criterio que 0053).
revoke all on function public.lead_queue_counts(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.lead_queue_counts(uuid, timestamptz, timestamptz) to authenticated, service_role;
