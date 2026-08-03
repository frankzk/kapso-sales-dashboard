-- Cobertura por COORDENADA (migración 0100). Se ejecuta sobre el clúster
-- desechable, después de aplicar todas las migraciones, y reutiliza la
-- org/tienda del fixture de rls_smoke.sql (org 3333…, store aaaa…).
--
-- POR QUÉ ESTA PRUEBA. La cobertura COD dejó de decidirse solo por el nombre del
-- distrito —que Shopify escribe como la ciudad ("Puerto Maldonado") y Aliclik
-- como el distrito ("Tambopata"), y nunca casan— y ahora también por cercanía a
-- un punto donde Aliclik ya entregó COD. Es lógica delicada (haversine, caja de
-- bounding, aislamiento por org, precedencia de reglas) que vive en SQL; si se
-- rompe, cientos de pedidos con entrega a domicilio se mandan a recoger a una
-- agencia, o al revés. Esta prueba fija el comportamiento.

\set store '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''
\set org '''33333333-3333-3333-3333-333333333333'''

-- Un punto COD en Puerto Maldonado (Madre de Dios), para esta org.
delete from aliclik_cod_points where org_id = :org;
insert into aliclik_cod_points(org_id, lat, lng) values (:org, -12.59, -69.19);

do $$
declare
  v_store uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
begin
  -- 1. Nombre que NO casa ninguna tarifa, pero la coordenada cae sobre el punto:
  --    la cobertura la salva la cercanía.
  if order_coverage_for(v_store,'Madre de Dios','Tambopata','Puerto Maldonado',
                        -12.5928,-69.1913,current_date) <> 'provincia_cod' then
    raise exception 'cerca de punto COD debería ser provincia_cod';
  end if;

  -- 2. Dentro del umbral (≈9 km) sigue contando.
  if order_coverage_for(v_store,'Madre de Dios','Tambopata','Puerto Maldonado',
                        -12.65,-69.25,current_date) <> 'provincia_cod' then
    raise exception '9 km debería seguir siendo provincia_cod';
  end if;

  -- 3. Lejos (≈63 km) es agencia de verdad: la coordenada NO inventa cobertura.
  if order_coverage_for(v_store,'Madre de Dios','Tambopata','Puerto Maldonado',
                        -13.16,-69.19,current_date) <> 'agencia' then
    raise exception 'lejos del punto COD debería ser agencia';
  end if;

  -- 4. Sin coordenada y sin tarifa por nombre: cae a agencia, no adivina.
  if order_coverage_for(v_store,'Madre de Dios','Tambopata','Puerto Maldonado',
                        null,null,current_date) <> 'agencia' then
    raise exception 'sin coordenada debería ser agencia';
  end if;

  -- 5. La coordenada clasifica AUNQUE no haya distrito legible.
  if order_coverage_for(v_store,'Madre de Dios','Tambopata','',
                        -12.5928,-69.1913,current_date) <> 'provincia_cod' then
    raise exception 'sin distrito pero cerca debería ser provincia_cod';
  end if;

  -- 6. Cañete es agencia por regla comercial, aunque haya un punto COD encima.
  if order_coverage_for(v_store,'Lima','Cañete','San Vicente de Cañete',
                        -12.5928,-69.1913,current_date) <> 'agencia' then
    raise exception 'Cañete debe ganar como agencia aun con punto cerca';
  end if;

  -- 7. Aislamiento por org: otra org no ve este punto.
  if aliclik_cod_point_near('00000000-0000-0000-0000-0000000000bb',
                            -12.5928,-69.1913,10.0) then
    raise exception 'una org no debe ver los puntos COD de otra';
  end if;

  -- 8. La firma vieja de 5 argumentos sigue viva (sin desempate por cercanía).
  if order_coverage_for(v_store,'Madre de Dios','Tambopata','Puerto Maldonado',
                        current_date) <> 'agencia' then
    raise exception 'la firma 5-arg debe seguir clasificando sin coordenada';
  end if;
end $$;

-- No dejar rastro para las pruebas siguientes.
delete from aliclik_cod_points where org_id = :org;

select 'coverage_smoke ok' as resultado;
