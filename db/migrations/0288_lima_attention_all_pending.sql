-- Atender gestiona todos los pendientes de Lima sin inventar un fallo.
-- Misma RPC, permisos, candado y contrato; no cambia pedidos, stock ni casos existentes.

create or replace function public.lima_repro_claim(
  p_order uuid,
  p_store uuid,
  p_actor uuid,
  p_episode text,
  p_episode_at timestamptz default null,
  p_ttl_minutes integer default 10,
  p_reopen boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_case lima_repro_cases%rowtype;
  v_open boolean;
  v_until timestamptz;
  v_last lima_repro_cases%rowtype;
begin
  if p_actor is null then
    raise exception 'Falta quién atiende el caso.';
  end if;
  if p_ttl_minutes is null or p_ttl_minutes not between 1 and 15 then
    raise exception 'El candado dura entre 1 y 15 minutos.';
  end if;
  if p_episode is null or char_length(p_episode) not between 3 and 160 then
    raise exception 'Falta el episodio del pedido.';
  end if;
  if not exists (select 1 from orders where id = p_order and store_id = p_store) then
    raise exception 'El pedido no pertenece a la tienda indicada.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('lima_repro:' || p_order::text, 0));

  -- La cobertura y la etapa se releen bajo el candado, antes de cerrar o crear casos.
  if not exists (
    select 1 from order_master m join orders o on o.id = m.order_id
     where m.order_id = p_order and m.store_id = p_store
       and o.cancelled_at is null and m.coverage = 'lima'
       and (
         (p_episode = 'attention:' || p_order::text
          and m.macro_stage in ('por_confirmar', 'preparacion', 'por_despachar', 'en_curso')
          and not (m.macro_stage = 'en_curso' and coalesce(m.macro_substage, '') = 'por_reprogramar_lima'))
         or (p_episode not like 'attention:%'
             and m.macro_stage = 'en_curso' and m.macro_substage = 'por_reprogramar_lima')
       )
  ) then
    if p_episode like 'attention:%' then
      raise exception 'Este pedido ya no está pendiente de entrega en Lima.';
    end if;
    raise exception 'Este pedido ya no está en «Por reprogramar Lima».';
  end if;

  select * into v_case
    from lima_repro_cases
   where order_id = p_order and closed_at is null
   for update;
  v_open := found;

  if v_open and v_case.episode_key <> p_episode then
    if not ((p_episode = 'attention:' || p_order::text) <> (v_case.episode_key = 'attention:' || p_order::text))
       and (p_episode_at is null or p_episode_at <= v_case.episode_at) then
      raise exception 'El pedido cambió mientras lo abrías: vuelve a intentarlo.';
    end if;
    update lima_repro_cases
       set closed_at = now(), close_reason = case when p_episode = 'attention:' || p_order::text then 'fuera_de_etapa' else 'nuevo_intento' end, claimed_by = null, claimed_until = null
     where id = v_case.id;
    v_open := false;
  end if;



  if not v_open then
    select * into v_last
      from lima_repro_cases
     where order_id = p_order and closed_at is not null
     order by closed_at desc, opened_at desc
     limit 1;
    if found and v_last.close_reason = 'desarmar_cerrar' and v_last.episode_key = p_episode
       and not coalesce(p_reopen, false) then
      return jsonb_build_object('claimed', false, 'needs_reopen', true);
    end if;
    insert into lima_repro_cases (store_id, order_id, episode_key, episode_at, opened_by)
    values (p_store, p_order, p_episode, coalesce(p_episode_at, now()), p_actor)
    returning * into v_case;
  end if;

  if v_case.claimed_by is not null and v_case.claimed_by <> p_actor and v_case.claimed_until > now() then
    return jsonb_build_object(
      'case_id', v_case.id, 'claimed', false,
      'holder', v_case.claimed_by, 'until', v_case.claimed_until);
  end if;

  v_until := now() + make_interval(mins => p_ttl_minutes);
  update lima_repro_cases set claimed_by = p_actor, claimed_until = v_until where id = v_case.id;
  return jsonb_build_object('case_id', v_case.id, 'claimed', true, 'until', v_until);
end;
$$;

revoke all on function public.lima_repro_claim(uuid, uuid, uuid, text, timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.lima_repro_claim(uuid, uuid, uuid, text, timestamptz, integer, boolean) to service_role;
