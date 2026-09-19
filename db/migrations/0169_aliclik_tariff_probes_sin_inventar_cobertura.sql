-- El sondeo de tarifas de Aliclik deja de inventar cobertura.
--
-- QUÉ PASABA. `aliclik_tariff_probes` elige distritos de pedidos pendientes, el
-- cron les pide una cotización y, si Aliclik devuelve un precio, se escribe una
-- tarifa. Pero la cobertura del pedido la decide esa misma matriz de tarifas
-- (`order_coverage_for`), así que UNA COTIZACIÓN BASTABA PARA CONVERTIR UN
-- DISTRITO DE AGENCIA EN PROVINCIA COD, sin que nadie hubiera entregado nunca
-- ahí y sin que nadie se enterara.
--
-- Lo destapó Caravelí el 19-09-2026: tarifa creada por sondeo el 17-09, cero
-- envíos de Aliclik en su historia, y la entrega de Aliclik más cercana a 247 km.
-- Sus 8 envíos reales salieron por Shalom. Medido en ese momento, el mismo patrón
-- alcanzaba a seis lugares (Caravelí, Huaura, Olmos, Sicuani/Canchis,
-- Huancavelica y Azángaro) y a seis cadenas que ni siquiera son distritos.
--
-- DOS FILTROS, Y NINGUNO ADIVINA.
--
-- 1. LO QUE NO ES UN DISTRITO. La clienta escribe la referencia en ese campo y
--    acabábamos cotizando «frente al grifo amazonas» o «2do puente de la av. 28
--    de julio». Se descartan las cadenas con palabras de referencia o tipos de
--    vía, que ningún distrito del Perú lleva en su nombre.
--
--    LA LISTA ES CORTA A PROPÓSITO, y dos ejemplos dicen por qué. «Puente» NO
--    entra: Puente Piedra es un distrito de verdad. Y la primera versión de esto
--    descartaba cualquier cadena con un dígito, hasta que la prueba contra los
--    110 distritos con entrega real de Aliclik enseñó que se llevaba por delante
--    «26 de Octubre», distrito de Piura con 44 entregas. Cambiar un error por
--    otro no es arreglarlo.
--
--    Verificado al escribirlo: 0 de esos 110 distritos caen por este filtro.
--
-- 2. LO QUE YA SABEMOS QUE NO ATIENDE. Un distrito con entregas reales de
--    agencia y CERO envíos de Aliclik no se sondea: su cotización no sería una
--    novedad sino la repetición del error. Lo que se pierde con esto está dicho:
--    si Aliclik abre cobertura ahí algún día, el sondeo no lo va a descubrir
--    solo. Se arregla como se arregló Tumbes, con una fila en `district_coverage`
--    o una tarifa cargada a mano — que es el camino correcto para una decisión
--    comercial, en vez de que la tome un cron de madrugada.

create or replace function aliclik_tariff_probes(p_store_id uuid, p_limit int)
returns table (district text, lat double precision, lng double precision, pending bigint)
language sql
stable
security definer
set search_path = public
as $$
  with pend as (
    select om.district,
           om.latitude,
           om.longitude,
           row_number() over (partition by om.district order by om.order_created_at desc) as rn,
           count(*) over (partition by om.district) as pending
    from order_master om
    where om.store_id = p_store_id
      and om.guide_code is null
      and om.general_status in ('pendiente', 'en_proceso')
      and om.district is not null
      and om.latitude is not null
      and om.longitude is not null
      -- Filtro 1: esto no es un distrito, es un trozo de dirección.
      and coverage_norm(om.district) !~
        '(^| )(frente|grifo|cuadra|paradero|altura|costado|espalda|referencia|lote|mz|manzana|av|avenida|jr|jiron|calle|pasaje|psje)( |$)'
  ),
  -- Filtro 2: entregas reales por courier, para no sondear donde ya consta que
  -- Aliclik no llega. Se mira la ENTREGA, no la guía creada: una guía anulada no
  -- prueba cobertura (es lo que pasó con Tumbes, ver 0149).
  entregas as (
    select coverage_norm(sh.district) as district,
           count(*) filter (where sh.courier = 'aliclik') as aliclik,
           count(*) filter (where sh.courier <> 'aliclik' and sh.delivery_status = 'entregado') as agencia_entregados
    from shipments sh
    where sh.district is not null
    group by 1
  ),
  quoted as (
    select lower(btrim(t.district)) as district, max(t.effective_from) as last_quoted
    from cost_tariffs t
    where t.source = 'aliclik' and t.district is not null
    group by 1
  )
  select p.district, p.latitude, p.longitude, p.pending
  from pend p
  left join quoted q on q.district = lower(btrim(p.district))
  left join entregas e on e.district = coverage_norm(p.district)
  where p.rn = 1
    and not (coalesce(e.aliclik, 0) = 0 and coalesce(e.agencia_entregados, 0) > 0)
  order by (q.last_quoted is not null), q.last_quoted asc nulls first, p.pending desc
  limit p_limit;
$$;

revoke all on function aliclik_tariff_probes(uuid, int) from public, anon, authenticated;
