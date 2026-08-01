-- 0091 — Cañete es operación Agencia, nunca reparto Lima.
--
-- Shopify puede guardar una dirección de Cañete bajo "Lima (provincia)". Esa
-- etiqueta normalmente significa Lima Metropolitana, por lo que la regla
-- general clasificaba el pedido como Lima y habilitaba couriers como Tanders.
-- La decisión operativa del MOM es explícita: Cañete siempre se atiende por
-- agencia, incluso si existe una tarifa COD histórica que coincida.

create or replace function is_lima_metropolitana(
  p_region text,
  p_province text,
  p_district text
)
returns boolean
language plpgsql
immutable
parallel safe
as $$
declare
  v_kind text := lima_region_kind(p_region);
  v_province text := coverage_norm(p_province);
  v_raw_district text := coverage_norm(p_district);
  v_district text;
begin
  -- Una provincia del departamento de Lima no puede transformarse en Lima
  -- Metropolitana solo porque Shopify haya elegido "Lima (provincia)".
  if v_province = any(array[
    'barranca','cajatambo','canete','canta','huaral','huarochiri','huaura','oyon','yauyos'
  ]) or v_raw_district = 'canete' or v_raw_district like '% canete' then
    return false;
  end if;

  if v_kind in ('metropolitana', 'callao') then
    return true;
  end if;

  v_district := resolve_lima_district(p_district, v_kind is not null);

  if v_kind = 'departamento' then
    return v_district is not null and v_district <> 'san luis';
  end if;
  if v_kind = 'lima' then
    return v_district is not null;
  end if;
  if coverage_norm(p_region) <> '' then
    return false;
  end if;
  if v_district is null then
    return false;
  end if;
  if v_province in ('lima', 'lima metropolitana') or v_province like '%callao%' then
    return true;
  end if;
  return v_district <> all(array[
    'bellavista','independencia','la victoria','miraflores','pueblo libre',
    'san luis','san miguel','santa rosa'
  ]);
end;
$$;

create or replace function order_coverage_for(
  p_store_id uuid,
  p_region text,
  p_province text,
  p_district text,
  p_day date default current_date
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_region text := coverage_norm(p_region);
  v_province text := coverage_norm(p_province);
  v_district text := coverage_norm(p_district);
begin
  -- Regla comercial explícita. Debe ganar incluso a una tarifa histórica.
  if v_province = 'canete' or v_district = 'canete' or v_district like '% canete' then
    return 'agencia';
  end if;

  if is_lima_metropolitana(p_region, p_province, p_district) then
    return 'lima';
  end if;
  if v_district = '' then
    return 'por_revisar';
  end if;

  select org_id into v_org_id from stores where id = p_store_id;

  if exists (
    select 1
    from cost_tariffs t
    where t.org_id = v_org_id
      and t.concept = 'primer_intento'
      and t.courier is not null
      and coverage_norm(t.courier) not in ('shalom', 'olva', 'olva courier')
      and (t.region is not null or t.province is not null or t.district is not null)
      and t.effective_from <= p_day
      and (t.effective_to is null or t.effective_to >= p_day)
      and (t.store_id is null or t.store_id = p_store_id)
      and (t.region is null or coverage_norm(t.region) = v_region)
      and (t.province is null or coverage_norm(t.province) = v_province)
      and (t.district is null or coverage_norm(t.district) = v_district)
  ) then
    return 'provincia_cod';
  end if;

  return 'agencia';
end;
$$;

revoke all on function is_lima_metropolitana(text, text, text) from public, anon, authenticated;
revoke all on function order_coverage_for(uuid, text, text, text, date)
  from public, anon, authenticated;
grant execute on function is_lima_metropolitana(text, text, text) to service_role;
grant execute on function order_coverage_for(uuid, text, text, text, date) to service_role;

select refresh_order_coverage(null);
