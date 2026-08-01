-- 0089_order_master_mom_counts.sql
-- Devuelve todos los conteos del MOM en una sola consulta agrupada. La función
-- respeta el RLS de order_master porque usa SECURITY INVOKER.

create or replace function public.order_master_mom_counts(p_store_ids uuid[])
returns table (
  macro_stage text,
  macro_substage text,
  total bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    om.macro_stage,
    om.macro_substage,
    count(*)::bigint as total
  from public.order_master as om
  where om.store_id = any(p_store_ids)
  group by om.macro_stage, om.macro_substage;
$$;

revoke all on function public.order_master_mom_counts(uuid[]) from public, anon;
grant execute on function public.order_master_mom_counts(uuid[]) to authenticated, service_role;

comment on function public.order_master_mom_counts(uuid[]) is
  'Conteos agrupados por macroetapa y subetapa del MOM, respetando RLS.';

create or replace function public.order_master_agency_summary(p_store_ids uuid[])
returns table (
  total bigint,
  disponibles bigint,
  proximos_a_vencer bigint,
  retorno_iniciado bigint,
  devueltos bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*)::bigint,
    count(*) filter (
      where om.general_status <> 'devuelto'
        and om.pickup_state in ('disponible_para_recojo', 'pendiente_de_recojo')
    )::bigint,
    count(*) filter (
      where om.general_status <> 'devuelto'
        and om.agency_expires_at is not null
        and om.agency_expires_at <= now() + interval '3 days'
    )::bigint,
    count(*) filter (
      where om.general_status <> 'devuelto'
        and om.pickup_state = 'retorno_iniciado'
    )::bigint,
    count(*) filter (where om.general_status = 'devuelto')::bigint
  from public.order_master as om
  where om.store_id = any(p_store_ids)
    and (om.pickup_state is not null or om.shipping_mode = 'agency');
$$;

revoke all on function public.order_master_agency_summary(uuid[]) from public, anon;
grant execute on function public.order_master_agency_summary(uuid[]) to authenticated, service_role;

comment on function public.order_master_agency_summary(uuid[]) is
  'Resumen exacto de pedidos en agencia para el encabezado del Master.';

create index if not exists order_master_mom_stage_movement_idx
  on public.order_master(store_id, macro_stage, last_movement_at desc nulls first, order_created_at desc);

create index if not exists order_master_mom_substage_movement_idx
  on public.order_master(store_id, macro_substage, last_movement_at desc nulls first, order_created_at desc);
