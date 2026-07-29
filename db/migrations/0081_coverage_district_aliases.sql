-- 0081 — El distrito de Lima como lo escribe la gente, no como lo llama el INEI.
--
-- Un pedido con región "Lima" y distrito "Surco" salía Provincia COD. La lista
-- de la 0079 tiene los 43 nombres oficiales, y "Santiago de Surco" es uno de
-- ellos; "Surco" a secas no existe en el ubigeo. Como el distrito casi nunca se
-- elige de una lista —lo escribe la clienta por WhatsApp o la asesora al armar
-- el pedido— llegan siglas (SJL, SMP, VMT), nombres viejos (Ate Vitarte,
-- Cercado de Lima), centros poblados tratados como distrito (Huachipa, que es
-- Lurigancho) y referencias enteras ("A 2 cuadras del mercado de Magdalena").
--
-- Y un segundo caso, más frecuente todavía: región "Lima (departamento)" con un
-- distrito de Lima Metropolitana (Miraflores, Los Olivos, San Isidro…). Es una
-- contradicción, y la gana el distrito: el desplegable de Shopify ofrece
-- "Lima (provincia)" y "Lima (departamento)" sin explicar cuál es cuál, mientras
-- que el distrito lo escribe la clienta. Ninguno de esos nombres existe en el
-- departamento de Lima fuera de la metropolitana — salvo San Luis, que también
-- es un distrito de Cañete, y por eso queda excluido.

-- Los 43 distritos de Lima Metropolitana + los 7 del Callao, en un solo lugar.
create or replace function lima_districts()
returns text[]
language sql
immutable
parallel safe
as $$
  select array[
    'ancon','ate','barranco','brena','carabayllo','chaclacayo','chorrillos',
    'cieneguilla','comas','el agustino','independencia','jesus maria',
    'la molina','la victoria','lima','lince','los olivos','lurigancho','lurigancho chosica',
    'lurin','magdalena del mar','miraflores','pachacamac','pucusana',
    'pueblo libre','puente piedra','punta hermosa','punta negra','rimac',
    'san bartolo','san borja','san isidro','san juan de lurigancho',
    'san juan de miraflores','san luis','san martin de porres','san miguel',
    'santa anita','santa maria del mar','santa rosa','santiago de surco',
    'surquillo','villa el salvador','villa maria del triunfo',
    'bellavista','callao','carmen de la legua reynoso','la perla','la punta',
    'mi peru','ventanilla'
  ];
$$;

-- Cómo escribe la gente cada distrito.
create or replace function lima_district_aliases()
returns table(term text, district text)
language sql
immutable
parallel safe
as $$
  values
    ('agustino', 'el agustino'),
    ('ate vitarte', 'ate'),
    ('cercado', 'lima'),
    ('cercado de lima', 'lima'),
    ('carmen de la legua', 'carmen de la legua reynoso'),
    ('chosica', 'lurigancho'),
    ('colonial', 'lima'),
    ('el cercado', 'lima'),
    ('huachipa', 'lurigancho'),
    ('jesus', 'jesus maria'),
    ('la colonial', 'lima'),
    ('lima cercado', 'lima'),
    ('magdalena', 'magdalena del mar'),
    ('molina', 'la molina'),
    ('pantanos de villa', 'chorrillos'),
    ('puente de piedra', 'puente piedra'),
    ('s j l', 'san juan de lurigancho'),
    ('s j m', 'san juan de miraflores'),
    ('s m p', 'san martin de porres'),
    ('san juan de lurigancho sjl', 'san juan de lurigancho'),
    ('san martin de porras', 'san martin de porres'),
    ('sanjuan de lurigancho', 'san juan de lurigancho'),
    ('sanjuan de miraflores', 'san juan de miraflores'),
    ('santa beatriz', 'lima'),
    ('santa maria de huachipa', 'lurigancho'),
    ('sjl', 'san juan de lurigancho'),
    ('sjm', 'san juan de miraflores'),
    ('smp', 'san martin de porres'),
    ('surco', 'santiago de surco'),
    ('surco viejo', 'santiago de surco'),
    ('ves', 'villa el salvador'),
    ('villa maria', 'villa maria del triunfo'),
    ('vitarte', 'ate'),
    ('vmt', 'villa maria del triunfo');
$$;

/*
 * Términos reconocibles DENTRO de una frase más larga, del más largo al más
 * corto para que "san juan de lurigancho" gane antes de que "lurigancho" —que
 * también está en la lista— se lo lleve.
 *
 * Quedan fuera los demasiado genéricos: aparecen en cualquier dirección
 * ("Av. Colonial", "casa de Jesús", "Zárate"). Como distrito exacto se siguen
 * resolviendo; solo no se buscan sueltos.
 */
create or replace function lima_search_terms()
returns table(term text, district text)
language sql
immutable
parallel safe
as $$
  select t.term, t.district
  from (
    select d as term, d as district from unnest(lima_districts()) as d
    union all
    select a.term, a.district from lima_district_aliases() a
  ) t
  where t.term <> all(array[
    'ancon','ate','brena','cercado','comas','jesus','lima','lince','lurin','rimac'
  ])
  order by length(t.term) desc;
$$;

/*
 * El distrito de Lima Metropolitana / Callao al que apunta el texto, o null.
 *
 * `p_search_in_text` busca el nombre dentro de una frase y solo se activa cuando
 * la región ya sitúa el pedido en Lima: fuera de ahí, "Independencia" o
 * "La Victoria" dentro de una referencia mandarían un pedido de Áncash o de
 * Chiclayo al reparto propio.
 */
create or replace function resolve_lima_district(
  p_district text,
  p_search_in_text boolean default false
)
returns text
language plpgsql
immutable
parallel safe
as $$
declare
  v_district text := coverage_norm(p_district);
  v_alias text;
  v_hit text;
begin
  if v_district = '' then
    return null;
  end if;
  if v_district = any(lima_districts()) then
    return v_district;
  end if;

  select a.district into v_alias from lima_district_aliases() a where a.term = v_district;
  if v_alias is not null then
    return v_alias;
  end if;

  if not p_search_in_text then
    return null;
  end if;

  select s.district into v_hit
  from lima_search_terms() s
  where v_district like s.term || ' %'
     or v_district like '% ' || s.term
     or v_district like '% ' || s.term || ' %'
  limit 1;

  return v_hit;
end;
$$;

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
  v_district text;
begin
  if v_kind in ('metropolitana', 'callao') then
    return true;
  end if;

  -- Con la región ya dentro del departamento de Lima, el texto del distrito se
  -- puede leer con confianza: no hay otro departamento con el que confundirlo.
  v_district := resolve_lima_district(p_district, v_kind is not null);

  -- "Lima (departamento)" con un distrito metropolitano: gana el distrito.
  -- San Luis es la excepción — también es un distrito de Cañete.
  if v_kind = 'departamento' then
    return v_district is not null and v_district <> 'san luis';
  end if;

  -- Región "Lima" a secas: el distrito desempata entre la metropolitana y el
  -- resto del departamento (Huaral, Cañete, Yauyos…).
  if v_kind = 'lima' then
    return v_district is not null;
  end if;

  -- Región de otro departamento: no es Lima, aunque el distrito se llame igual
  -- que uno de Lima (Independencia/Huaraz, La Victoria/Chiclayo…).
  if coverage_norm(p_region) <> '' then
    return false;
  end if;

  -- Sin región: la provincia manda si es concluyente; si no, solo un distrito
  -- cuyo nombre no se repita en otro departamento.
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

revoke all on function lima_districts() from public, anon, authenticated;
revoke all on function lima_district_aliases() from public, anon, authenticated;
revoke all on function lima_search_terms() from public, anon, authenticated;
revoke all on function resolve_lima_district(text, boolean) from public, anon, authenticated;
revoke all on function is_lima_metropolitana(text, text, text) from public, anon, authenticated;
grant execute on function lima_districts() to service_role;
grant execute on function lima_district_aliases() to service_role;
grant execute on function lima_search_terms() to service_role;
grant execute on function resolve_lima_district(text, boolean) to service_role;
grant execute on function is_lima_metropolitana(text, text, text) to service_role;

select refresh_order_coverage(null);
