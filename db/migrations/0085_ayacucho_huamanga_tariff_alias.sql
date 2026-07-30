-- Aliclik registra la tarifa de la capital de Ayacucho con distrito
-- "Ayacucho", mientras los pedidos de Shopify/ubigeo llegan como:
--   región Ayacucho / provincia Huamanga / distrito Huamanga.
--
-- No se duplica una fila de S/16.50: se declara una equivalencia operativa para
-- que el pedido herede siempre la tarifa vigente de Aliclik y sus futuros
-- cambios de precio.

create or replace function cost_tariff_district_matches(
  p_tariff_district text,
  p_region text,
  p_province text,
  p_district text
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select
    coverage_norm(p_tariff_district) = coverage_norm(p_district)
    or (
      coverage_norm(p_region) = 'ayacucho'
      and coverage_norm(p_province) = 'huamanga'
      and coverage_norm(p_district) = 'huamanga'
      and coverage_norm(p_tariff_district) = 'ayacucho'
    );
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
      and (
        t.district is null
        or cost_tariff_district_matches(
          t.district,
          p_region,
          p_province,
          p_district
        )
      )
  ) then
    return 'provincia_cod';
  end if;

  return 'agencia';
end;
$$;

revoke all on function cost_tariff_district_matches(text, text, text, text)
  from public, anon, authenticated;
grant execute on function cost_tariff_district_matches(text, text, text, text)
  to service_role;

revoke all on function order_coverage_for(uuid, text, text, text, date)
  from public, anon, authenticated;
grant execute on function order_coverage_for(uuid, text, text, text, date)
  to service_role;

-- Corrige solo los pedidos afectados. Evita recalcular todo el histórico
-- durante la migración; el trigger de 0083 conservará la clasificación en
-- las sincronizaciones siguientes.
update order_master
set coverage = order_coverage_for(
  store_id,
  region,
  province,
  district,
  current_date
)
where coverage_norm(region) = 'ayacucho'
  and coverage_norm(province) = 'huamanga'
  and coverage_norm(district) = 'huamanga';
