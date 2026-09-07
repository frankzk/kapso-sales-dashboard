-- ============================================================================
-- 0149 — Un punto COD lo siembra una ENTREGA, no una cotización.
--
-- EL CASO. Tumbes salía «Provincia COD» y la operación lo despacha por agencia.
-- Aliclik no ha entregado NUNCA un paquete en Tumbes: sus dos únicas guías allí
-- —#KP125436 y #KP125474, ambas del 31-jul— se anularon sin salir. Las cuatro
-- entregas reales del departamento son de Shalom.
--
-- POR QUÉ EL SISTEMA CREÍA LO CONTRARIO. `refresh_aliclik_cod_points` dice en su
-- propio comentario que arma el mapa de «dónde Aliclik ya ENTREGÓ a domicilio»,
-- pero la consulta solo exigía que la guía tuviera cotización
-- (`quoted_delivery_cost is not null`). Aliclik cotizó Tumbes a S/ 18,50 al
-- crear esas dos guías, y con eso quedaron sembrados dos puntos a 6 km de la
-- dirección. Desde entonces todo pedido de Tumbes cae dentro del radio de 10 km.
--
-- Cotizar no es entregar. El comentario afirmaba un hecho que el código no
-- comprobaba, que es la forma exacta del bug que este repositorio arrastra.
--
-- MEDIDO ANTES DE CAMBIARLO, sobre los 954 puntos del mapa:
--
--   con entrega real                          764
--   sin entrega, guías todavía en curso        76
--   SOLO fracasos (anuladas/devueltas)        103
--
-- Y la comprobación que decide: ¿qué regiones se quedan sin cobertura al exigir
-- la entrega? SOLO TUMBES. Arequipa, Trujillo, Chiclayo, Piura, Huancayo y
-- Juliaca conservan sus puntos, porque allí una dirección fallida está rodeada
-- de cientos de entregas buenas — por eso NO se borran «los puntos que
-- fracasaron», que en esas ciudades sería ruido: se cambia qué siembra un punto.
-- Las demás regiones que perdían todo son cadenas sucias en minúscula, y una que
-- es el nombre de una persona metido en el campo «región».
--
-- LOS 76 «EN CURSO» TAMBIÉN SALEN, y es la dirección prudente: no se declara
-- cobertura COD hasta que Aliclik entregue una vez de verdad. Se arregla solo en
-- cuanto la primera guía de esa zona llegue, sin que nadie toque nada.
-- ============================================================================

create or replace function refresh_aliclik_cod_points(p_org_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from aliclik_cod_points p
  where p_org_id is null or p.org_id = p_org_id;

  insert into aliclik_cod_points (org_id, lat, lng)
  select distinct
    st.org_id,
    round(s.latitude::numeric, 2)::double precision,
    round(s.longitude::numeric, 2)::double precision
  from shipments s
  join stores st on st.id = s.store_id
  where s.latitude is not null
    and s.longitude is not null
    and coverage_norm(s.courier) like '%ali%'
    -- LA LÍNEA DEL ARREGLO. Sin ella, una guía creada y anulada el mismo día
    -- deja el punto puesto para siempre y arrastra a todo el departamento.
    and s.delivery_status = 'entregado'
    and (p_org_id is null or st.org_id = p_org_id)
    and (
      s.quoted_delivery_cost is not null
      or exists (
        select 1
        from cost_tariffs t
        where t.org_id = st.org_id
          and t.concept = 'primer_intento'
          and coverage_norm(t.courier) not in ('shalom', 'olva', 'olva courier')
          and t.district is not null
          and (t.effective_to is null or t.effective_to >= current_date)
          and coverage_norm(t.district) = coverage_norm(s.district)
      )
    )
  on conflict do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function refresh_aliclik_cod_points(uuid) is
  'Mapa de zonas donde Aliclik ENTREGÓ COD a domicilio. Exige delivery_status = entregado: una guía cotizada y anulada no prueba cobertura (0149).';

-- Reconstruir el mapa con la regla nueva. Sin esto, los puntos viejos —los 190
-- que ninguna entrega respalda— seguirían en la tabla hasta el próximo refresco.
select refresh_aliclik_cod_points(null);

-- ---------------------------------------------------------------------------
-- Y el cinturón, por encima del tirante: Tumbes es agencia, dicho a mano.
--
-- Con el arreglo de arriba Tumbes ya cae en `agencia` sola —sin puntos y sin
-- tarifa, la función termina ahí—, así que esto es redundante HOY. Se pone
-- igual porque el override se consulta primero y no depende de que el mapa esté
-- fresco.
--
-- CUBRE SOLO LOS TRES NOMBRES REALES. El campo distrito llega sucio desde el
-- checkout —«Polleria brada», «Calle las letras», «AAHH pampa grande por la
-- quebrada el nieto»— y esos no se pueden enumerar. Quien de verdad cubre el
-- departamento entero es el arreglo del mapa, que trabaja por coordenada.
--
-- SI ALGÚN DÍA ALICLIK CUBRE TUMBES, hay que borrar estas filas: el override
-- gana por delante de todo lo demás y taparía la cobertura nueva.
-- ---------------------------------------------------------------------------
insert into district_coverage (store_id, district, coverage, note)
values
  (null, 'tumbes', 'agencia',
   'Aliclik nunca entregó en Tumbes: sus dos guías (31-jul-2026) se anularon. Las entregas reales son de Shalom. Ver 0149.'),
  (null, 'zarumilla', 'agencia',
   'Departamento de Tumbes, sin cobertura COD de Aliclik. Ver 0149.'),
  (null, 'corrales', 'agencia',
   'Departamento de Tumbes, sin cobertura COD de Aliclik. Ver 0149.')
on conflict (coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid), district)
do nothing;
