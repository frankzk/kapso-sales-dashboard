-- Un distrito de Lima escrito en el campo de REGIÓN sacaba al pedido de Lima.
--
-- `is_lima_metropolitana` tenía una salida en seco:
--
--     -- Región de otro departamento: no es Lima, aunque el distrito se llame
--     -- igual que uno de Lima (Independencia/Huaraz, La Victoria/Chiclayo…).
--     if coverage_norm(p_region) <> '' then
--       return false;
--     end if;
--
-- La regla es correcta para lo que dice defender: una región que nombra OTRO
-- departamento. El hueco es que trataba igual a una región que no nombra ningún
-- departamento, sino un DISTRITO de Lima Metropolitana. «Chaclacayo», «Ate»,
-- «La Molina», «HUACHIPA» — alguien escribe el distrito o el barrio donde va el
-- departamento, y el pedido se cae de Lima sin que nada avise.
--
-- Se destapó persiguiendo dos pedidos que la 0129 NO arregló: `#KP127256`, con
-- `shippingAddress.province = "Chaclacayo"` puesto por Shopify, y `#KP127130`,
-- con una corrección MANUAL del equipo que puso `region = "HUACHIPA"`. Dos
-- fuentes distintas, el mismo agujero, y ninguna de las dos pasa por
-- `peru_districts`: por eso corregir la tabla no los movió.
--
-- LA REGLA NUEVA. Si la región resuelve a un distrito de Lima Metropolitana
-- —con los alias ya existentes, que es como «HUACHIPA» llega a `lurigancho`—,
-- se lee como un distrito mal colocado y el pedido es Lima.
--
-- LO QUE NO CAMBIA, Y POR QUÉ IMPORTA. Los nombres ambiguos siguen fuera:
-- Bellavista, Independencia, La Victoria, Miraflores, Pueblo Libre, San Luis,
-- San Miguel y Santa Rosa existen en Lima Y en otros departamentos, y son
-- exactamente los casos que el comentario de arriba nombraba. Esa lista ya vivía
-- en esta función, escrita a mano en la rama «sin región». Se saca a
-- `lima_ambiguous_districts()` para que las DOS ramas lean la misma: duplicarla
-- habría sido plantar la siguiente divergencia con las manos.
--
-- Tampoco cambia nada para «Lima», «Callao» ni sus variantes: `lima_region_kind`
-- las resuelve antes y no llegan a la rama nueva. Se comprobó que los únicos
-- nombres de distrito de Lima que chocan con un departamento peruano son
-- justamente «lima» y «callao», así que no hay ningún «San Martín» que se cuele.
--
-- MEDIDO EN PRODUCCIÓN, sobre las 16 650 filas del Master: cambian 12.
--
--   abiertos (5)     Ate · Chaclacayo · HUACHIPA · La Molina · Lurigancho ·
--                    puente piedra
--   finalizados (7)  Carabayllo · la molina · Lurigancho chosica · Pachacamac ·
--                    San Juan de Lurigancho (×2)
--
-- Las doce son inequívocamente Lima Metropolitana; no hay un solo falso positivo
-- en toda la historia. Y la lista de ambiguos se gana el sitio con una fila
-- real: un pedido con región Y distrito «bellavista» y sin provincia, que sigue
-- sin clasificarse como Lima porque de verdad no se sabe.
--
-- Los candidatos por el texto de la región eran 13, no 12: Pucusana también
-- nombra un distrito metropolitano, pero tiene una excepción explícita en
-- `district_coverage` que lo fija en `agencia`, y esa manda sobre todo lo demás
-- (§19). El caso confirma que el orden de precedencia funciona: la regla nueva
-- no atropella una decisión tomada a mano.
--
-- El refresco arrastra además 2 filas que NO son de esta migración —dos pedidos
-- a Coronel Portillo (Ucayali) con `agencia` guardado y `provincia_cod` en la
-- función, porque la excepción de ese distrito se creó DESPUÉS de su último
-- cálculo—. Es justamente el desfase que el refresco existe para cerrar; se deja
-- dicho aquí para que nadie lo lea como un efecto de la regla nueva.
--
-- SE REFRESCAN TAMBIÉN LOS FINALIZADOS, al contrario que en las excepciones de
-- `district_coverage` (§19). No es la misma situación: allí una persona decide a
-- mano reclasificar un distrito y sería raro que eso reescribiera historia; aquí
-- se corrige la definición canónica, y una `coverage` guardada que ya no
-- coincide con la función es el desfase que este repo lleva media docena de
-- incidentes pagando. Además `coverage` describe cómo ES el destino, no lo que
-- se hizo con el pedido, así que ponerla al día hace el histórico más fiel — y
-- los análisis de cobertura por región dejan de arrastrar el error.

create or replace function lima_ambiguous_districts()
returns text[]
language sql
immutable
parallel safe
as $$
  -- Distritos de Lima cuyo nombre se repite en otro departamento. Con uno de
  -- estos a secas no se puede afirmar que el destino sea Lima.
  select array[
    'bellavista','independencia','la victoria','miraflores','pueblo libre',
    'san luis','san miguel','santa rosa'
  ];
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
  v_region_as_district text;
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

  if coverage_norm(p_region) <> '' then
    -- La región no nombra ningún departamento: nombra un DISTRITO de Lima
    -- Metropolitana. Es el distrito escrito una casilla más arriba de la que
    -- le tocaba, y el destino es Lima. Sin búsqueda dentro del texto: se exige
    -- que la región SEA el distrito (o uno de sus alias), no que lo contenga.
    v_region_as_district := resolve_lima_district(p_region, false);
    if v_region_as_district is not null
       and v_region_as_district <> all(lima_ambiguous_districts()) then
      return true;
    end if;

    -- Región de otro departamento: no es Lima, aunque el distrito se llame
    -- igual que uno de Lima (Independencia/Huaraz, La Victoria/Chiclayo…).
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
  return v_district <> all(lima_ambiguous_districts());
end;
$$;

revoke all on function lima_ambiguous_districts() from public, anon, authenticated;
revoke all on function is_lima_metropolitana(text, text, text) from public, anon, authenticated;
grant execute on function lima_ambiguous_districts() to service_role;
grant execute on function is_lima_metropolitana(text, text, text) to service_role;

select refresh_order_coverage(null);
