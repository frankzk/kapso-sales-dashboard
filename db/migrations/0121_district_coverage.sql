-- ============================================================================
-- 0121_district_coverage.sql — excepciones de cobertura por distrito, editables.
--
-- EL PROBLEMA. Qué cobertura tiene un distrito es una decisión COMERCIAL, no
-- geográfica: Pucusana y Chaclacayo están dentro de la provincia de Lima y el
-- clasificador los da por reparto propio, pero la operación los atiende por
-- agencia. Hasta hoy eso solo se podía cambiar tocando código —la lista vive en
-- `is_lima_metropolitana`— así que cada distrito nuevo era un despliegue.
--
-- QUÉ NO ES ESTA TABLA. No es un catálogo de los 1.870 distritos del país ni una
-- copia de la lista de Lima Metropolitana. Nace VACÍA y solo guarda lo que se
-- aparta de la regla general, por tres razones:
--
--   1. Sembrarla con los 51 distritos de Lima/Callao crearía una TERCERA copia
--      de esa lista —ya está en `is_lima_metropolitana` (SQL) y en
--      `LIMA_METROPOLITANA` (TS)—. Este repositorio lleva media docena de
--      incidentes causados por dos definiciones de lo mismo divergiendo; añadir
--      una más para «poder verla» sale carísimo.
--   2. Vacía, el día del despliegue el comportamiento es EXACTAMENTE el de hoy.
--      No hay que revisar 51 filas para comprobar que nada cambió.
--   3. Lo que se quiere editar son las excepciones. Las 51 no se tocan nunca.
--
-- La pantalla enseña, para el distrito que se busque, qué dice hoy la regla
-- general y permite apartarse de ella. Ver la fila es innecesario; ver la
-- RESPUESTA es lo que hace falta.
--
-- DÓNDE MANDA. `order_coverage_for` es la definición canónica de la cobertura
-- (0104): el Master se la pregunta a la base en vez de recalcularla en TS
-- justamente porque tener dos definiciones fue el bug que motivó aquella
-- migración. Por eso la excepción se consulta ACÁ DENTRO y en primer lugar, por
-- delante de Cañete, de Lima Metropolitana y del mapa de tarifas. Ponerla solo
-- en TypeScript la habría dejado sin efecto: la base gana.
--
-- ALCANCE. `store_id` nulo = vale para todas las tiendas, que es como está hoy
-- la clasificación. Una fila con tienda gana sobre la global, para el día en que
-- Kenku y Aurela difieran en un destino; hoy no ocurre y no hace falta llenar
-- nada por tienda.
-- ============================================================================

create table if not exists district_coverage (
  id uuid primary key default gen_random_uuid(),
  -- NULL = todas las tiendas. Una fila con tienda gana sobre la global.
  store_id uuid references stores(id) on delete cascade,
  -- Normalizado con `coverage_norm`: sin tildes, minúsculas, sin puntuación.
  -- Se guarda ya normalizado para que la búsqueda sea una igualdad y no una
  -- función sobre cada fila.
  district text not null,
  coverage text not null check (coverage in ('lima', 'provincia_cod', 'agencia')),
  -- Por qué. Una excepción sin motivo es indistinguible de un error de dedo
  -- dentro de seis meses.
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

-- Una sola regla por distrito y alcance. El `coalesce` mete a la fila global en
-- el mismo índice que las de tienda, que es lo que impide dos globales del
-- mismo distrito contradiciéndose.
create unique index if not exists district_coverage_scope_uniq
  on district_coverage (coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid), district);

comment on table district_coverage is
  'Excepciones de cobertura por distrito. Vacía = manda la regla general de order_coverage_for. Solo se guarda lo que se aparta de ella.';
comment on column district_coverage.store_id is
  'NULL = todas las tiendas. Una fila con tienda gana sobre la global.';
comment on column district_coverage.district is
  'Distrito ya normalizado con coverage_norm (sin tildes, minúsculas).';

alter table district_coverage enable row level security;

-- Lectura para la sesión —la pantalla de ajustes la lista— y escritura solo por
-- el servidor, igual que el resto de la configuración de tienda.
drop policy if exists district_coverage_read on district_coverage;
create policy district_coverage_read on district_coverage for select to authenticated using (true);

grant select on district_coverage to authenticated;
grant select, insert, update, delete on district_coverage to service_role;

-- ── La regla, dentro de la definición canónica ─────────────────────────────
--
-- Va PRIMERO, antes que Cañete y que Lima Metropolitana: es una decisión
-- explícita de la operación y tiene que poder contradecir a cualquiera de las
-- reglas automáticas — para eso existe. La fila de tienda gana sobre la global
-- (`order by store_id nulls last` con el filtro de alcance).
create or replace function order_coverage_for(
  p_store_id uuid,
  p_region text,
  p_province text,
  p_district text,
  p_lat double precision,
  p_lng double precision,
  p_day date default current_date
)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_org_id uuid;
  v_region text := coverage_norm(p_region);
  v_province text := coverage_norm(p_province);
  v_district text := coverage_norm(p_district);
  v_override text;
begin
  -- Excepción explícita del distrito (0121). Manda sobre todo lo demás.
  if v_district <> '' then
    select dc.coverage into v_override
      from district_coverage dc
     where dc.district = v_district
       and (dc.store_id is null or dc.store_id = p_store_id)
     order by dc.store_id nulls last
     limit 1;
    if v_override is not null then
      return v_override;
    end if;
  end if;

  if v_province = 'canete' or v_district = 'canete' or v_district like '% canete' then
    return 'agencia';
  end if;

  if is_lima_metropolitana(p_region, p_province, p_district) then
    return 'lima';
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

  if aliclik_cod_point_near(v_org_id, p_lat, p_lng, 10.0) then
    return 'provincia_cod';
  end if;

  if v_district = '' then
    return 'por_revisar';
  end if;

  return 'agencia';
end;
$function$;

comment on function order_coverage_for(uuid, text, text, text, double precision, double precision, date) is
  'Cobertura canónica del pedido. Orden: excepción de district_coverage (0121) > Cañete > Lima Metropolitana > tarifas COD > punto COD cercano > agencia.';

-- El caso que motivó la tabla: Pucusana se atiende por agencia aunque el ubigeo
-- lo ponga en la provincia de Lima.
insert into district_coverage (store_id, district, coverage, note)
values (null, coverage_norm('Pucusana'), 'agencia',
        'Decision operativa: el reparto propio no llega; sale por agencia.')
on conflict do nothing;
