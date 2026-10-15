-- ============================================================================
-- 0266_order_master_dispatched_with.sql — «Salió con»: con quién salió de
-- verdad cada pedido (MOM §9.3, 15-10-2026, pedido de Frankz).
--
-- POR QUÉ. El filtro «Courier» mira el courier vigente y el último, y para
-- Grupo GF solo dice «Propio». No responde con quién se intentó: ¿Roy, Alexis,
-- Yhoni, Tanders, Urpi? Esta columna guarda a todos.
--
-- QUÉ GUARDA. Códigos, sin repetir: `gf:<Nombre>` por cada motorizado de
-- Grupo GF que tuvo una parada reportada con el pedido (o lo lleva ahora),
-- `gf` si salió con Grupo GF sin parada conocida, y el código del courier
-- externo cuya guía llegó a salir (`aliclik`, `fenix` = Swayp, `tanders`,
-- `urpi`, `shalom`, `olva`…). La escribe el recálculo del pedido
-- (lib/dispatched-with.ts); `mom-v1.30` la rellena para todos.
--
-- `master_facets` la devuelve como opciones del filtro: los nombres de los
-- motorizados salen de los datos, no de una lista escrita a mano.
-- ============================================================================

alter table order_master add column if not exists dispatched_with text[] not null default '{}';

create index if not exists order_master_dispatched_with_idx
  on order_master using gin (dispatched_with);

create or replace function public.master_facets(p_store_ids uuid[])
returns jsonb
language sql
stable
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'operational', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct operational_status as v
        from order_master where store_id = any(p_store_ids) and operational_status is not null
      ) q
    ), '[]'::jsonb),
    'courier', coalesce((
      select jsonb_agg(v order by v) from (
        select current_courier as v from order_master
        where store_id = any(p_store_ids) and current_courier is not null
        union
        select last_courier as v from order_master
        where store_id = any(p_store_ids) and last_courier is not null
      ) q
    ), '[]'::jsonb),
    'region', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct region as v from order_master
        where store_id = any(p_store_ids) and region is not null
      ) q
    ), '[]'::jsonb),
    'province', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct province as v from order_master
        where store_id = any(p_store_ids) and province is not null
      ) q
    ), '[]'::jsonb),
    'district', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct district as v from order_master
        where store_id = any(p_store_ids) and district is not null
      ) q
    ), '[]'::jsonb),
    'coverage', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct coverage as v from order_master
        where store_id = any(p_store_ids) and coverage is not null
      ) q
    ), '[]'::jsonb),
    'pickup', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct pickup_state as v from order_master
        where store_id = any(p_store_ids) and pickup_state is not null
      ) q
    ), '[]'::jsonb),
    'dispatched_with', coalesce((
      select jsonb_agg(v order by v) from (
        select distinct unnest(dispatched_with) as v from order_master
        where store_id = any(p_store_ids)
      ) q
    ), '[]'::jsonb)
  );
$function$;
