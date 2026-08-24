-- `is_lima_metropolitana` cuando la REGIÓN trae un distrito, no un departamento
-- (migración 0128). Se ejecuta sobre el clúster desechable, después de aplicar
-- todas las migraciones.
--
-- POR QUÉ ESTA PRUEBA. La función tenía una salida en seco —«región no vacía y
-- que no suena a Lima ⇒ no es Lima»— pensada para regiones que nombran OTRO
-- departamento. Trataba igual a las que nombran un DISTRITO de Lima, que es lo
-- que pasa cada vez que alguien escribe «Chaclacayo» o «HUACHIPA» donde va el
-- departamento: el pedido se caía de Lima en silencio y se despachaba como
-- provincia. Lo delicado del arreglo no es reconocer el distrito — es NO
-- reconocer de más: si esto se pasa de listo, un pedido a Bellavista de Sullana
-- o a Independencia de Huaraz acaba en el reparto local de Lima.

do $$
begin
  ------------------------------------------------------------------ el arreglo
  -- 1. El distrito escrito en la casilla del departamento: es Lima.
  if not is_lima_metropolitana('Chaclacayo', null, 'Chaclacayo') then
    raise exception 'una región que nombra un distrito de Lima debe ser Lima';
  end if;

  -- 2. Vale también por alias: HUACHIPA resuelve a Lurigancho.
  if not is_lima_metropolitana('HUACHIPA', 'Lima (provincia)', 'Lurigancho') then
    raise exception 'los alias de distrito deben valer también en la región';
  end if;

  -- 3. El distrito NO tiene por qué ser legible: si la región ya dice
  --    Chaclacayo, una calle en el campo del distrito no lo saca de Lima.
  if not is_lima_metropolitana('La Molina', null, 'Santa Patricia III ETAPA') then
    raise exception 'la región sola debe bastar cuando nombra un distrito';
  end if;

  --------------------------------------------------------- lo que NO se toca
  -- 4. Nombres que existen en Lima Y fuera: siguen sin bastar. Es la mitad
  --    importante — la que evita mandar Sullana al reparto de Lima.
  if is_lima_metropolitana('bellavista', null, 'bellavista') then
    raise exception 'Bellavista es ambiguo: no debe clasificarse como Lima';
  end if;
  if is_lima_metropolitana('La Victoria', null, 'La Victoria') then
    raise exception 'La Victoria es ambiguo (Chiclayo): no debe ser Lima';
  end if;
  if is_lima_metropolitana('Independencia', null, 'Independencia') then
    raise exception 'Independencia es ambiguo (Huaraz): no debe ser Lima';
  end if;

  -- 5. Un departamento de verdad sigue mandando, aunque el distrito se llame
  --    igual que uno de Lima.
  if is_lima_metropolitana('La Libertad', 'Trujillo', 'La Victoria') then
    raise exception 'un departamento real no debe caer en Lima';
  end if;
  if is_lima_metropolitana('Ancash', 'Huaraz', 'Independencia') then
    raise exception 'Independencia de Huaraz no es Lima';
  end if;

  -- 6. La región nueva no puede abrirse por búsqueda dentro del texto: se exige
  --    que la región SEA el distrito (o un alias), no que lo mencione. Una
  --    región que solo nombra el distrito de pasada no dice dónde entregar.
  --    («Ate» no serviría de ejemplo: `lima_search_terms()` ya lo excluye de la
  --    búsqueda suelta por genérico, así que no distinguiría un modo del otro.)
  if is_lima_metropolitana('Cerca de Chaclacayo', null, 'x') then
    raise exception 'la región no debe resolverse buscando dentro del texto';
  end if;
  if is_lima_metropolitana('zona La Molina alta', null, 'x') then
    raise exception 'la región no debe resolverse buscando dentro del texto';
  end if;

  ------------------------------------------------- las ramas de siempre
  -- 7. Lima y Callao siguen resolviéndose antes de llegar a la rama nueva.
  if not is_lima_metropolitana('Lima (Metropolitana)', null, null) then
    raise exception 'Lima Metropolitana debe seguir siendo Lima';
  end if;
  if not is_lima_metropolitana('Callao', 'Callao', 'Bellavista') then
    raise exception 'Callao debe seguir siendo Lima';
  end if;

  -- 8. «Lima (departamento)» + distrito metropolitano: gana el distrito, con San
  --    Luis como excepción porque también es de Cañete.
  if not is_lima_metropolitana('Lima (departamento)', null, 'Miraflores') then
    raise exception 'departamento de Lima + distrito metropolitano es Lima';
  end if;
  if is_lima_metropolitana('Lima (departamento)', null, 'San Luis') then
    raise exception 'San Luis debe seguir siendo la excepción de Cañete';
  end if;

  -- 9. Región "Lima" a secas: el distrito desempata. Huaral no es metropolitana.
  if is_lima_metropolitana('Lima', 'Huaral', 'Huaral') then
    raise exception 'Huaral no es Lima Metropolitana';
  end if;

  -- 10. Sin región, la provincia manda; y sin nada concluyente, no se inventa.
  if not is_lima_metropolitana(null, 'Lima', 'Ate') then
    raise exception 'sin región, provincia Lima debe bastar';
  end if;
  if is_lima_metropolitana(null, null, 'Bellavista') then
    raise exception 'sin región ni provincia, un nombre ambiguo no es Lima';
  end if;

  -- 11. La lista de ambiguos es UNA: las dos ramas leen la misma función. Si
  --     alguien vuelve a escribirla a mano en una de ellas, esto lo caza.
  if (select count(*) from unnest(lima_ambiguous_districts())) <> 8 then
    raise exception 'lima_ambiguous_districts() cambió de tamaño sin querer';
  end if;
end $$;

select 'lima_region_smoke ok' as resultado;
