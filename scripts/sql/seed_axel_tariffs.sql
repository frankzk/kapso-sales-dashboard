-- Tarifario logístico de Axel Courier (Lima Metropolitana y Callao).
--
-- ORIGEN. Hoja "tarifario_axel_courier_completo_distritos_zonas.xlsx", derivada
-- de las liquidaciones diarias de Axel (evidencia del 17 al 25/07/2026 y
-- anteriores). El importe es la columna GANANCIA del reporte: lo que Axel SE
-- COBRA por entrega y descuenta del depósito — es decir, nuestro flete. Ver
-- lib/settlements/axel.ts, rareza nº 3.
--
-- Tres decisiones que explican la forma de estas filas:
--
--   1. SOLO `primer_intento`. La hoja da un único número por distrito: lo que
--      cuesta llevar el paquete. No dice qué cobra Axel por un segundo intento
--      ni por una devolución, y un costo inventado es peor que uno ausente:
--      `computeLogisticsCost` devuelve los conceptos sin tarifa en `missing`,
--      que es exactamente lo que queremos ver hasta que Axel los declare.
--
--   2. ÁMBITO POR DISTRITO, SIN PROVINCIA NI REGIÓN — igual que el tarifario de
--      Aliclik. En `order_master` la provincia de un pedido de Lima está casi
--      siempre en NULL y la región se escribe de seis maneras ("Lima",
--      "Lima (provincia)", "Lima (departamento)"…). Acotar por provincia haría
--      que `specificity()` descartara la tarifa en la mayoría de los pedidos.
--      El `courier = 'axel'` ya la acota a los envíos de Axel, así que un
--      distrito homónimo de otra región (Miraflores de Arequipa) no la alcanza.
--
--   3. ALIAS COMO FILAS PROPIAS. `sameLabel()` ignora mayúsculas y tildes, pero
--      no sabe que "Surco" es "Santiago de Surco" ni que "Cercado de Lima" es
--      "Lima". Los pedidos reales traen esas grafías, así que cada alias va
--      como una fila más con el mismo importe. Lo mismo con las zonas que Axel
--      cobra distinto (Huaycán, Chosica, Musa…): no son distritos oficiales,
--      pero es lo que el reporte escribe en la columna DISTRITO.
--
-- Lo que la hoja trae y NO se carga, por no ser un costo por distrito fiable:
--   · Ancón — figura en el tarifario sin importe.
--   · "Gálvez" (S/ 12) — la propia hoja lo marca "Por mapear".
--   · "Callao - Santa F…" (S/ 12) — nombre truncado en el reporte.
--   · "Cercado de Lima — PAGO POS" (S/ 13) — recargo por medio de pago, no por
--     geografía; el motor de costos no resuelve por forma de cobro.
--
-- Donde la hoja se contradice manda la tarifa PREDOMINANTE de "Zonas
-- especiales", no el registro aislado: San Juan de Lurigancho 10 (no 12/13),
-- Carabayllo 13 (no 10) y Villa María del Triunfo 10 (no 12).
--
-- Idempotente: cierra cualquier tarifa vigente de Axel para el mismo ámbito
-- antes de insertar, que es la misma regla que aplica upsertTariff() — una
-- tarifa no se edita, se reemplaza dejando cerrada la anterior.

\set org  '''7c4cb666-f6b5-432e-822d-fee06b61821b'''
\set desde '''2026-07-29'''

begin;

create temporary table axel_tarifas(district text, amount numeric) on commit drop;

insert into axel_tarifas(district, amount) values
  -- Lima Metropolitana (distritos oficiales)
  ('Ate', 10), ('Barranco', 10), ('Breña', 10), ('Carabayllo', 13),
  ('Chaclacayo', 18), ('Chorrillos', 10), ('Comas', 10), ('El Agustino', 10),
  ('Independencia', 10), ('Jesús María', 10), ('La Molina', 10),
  ('La Victoria', 10), ('Lima', 10), ('Lince', 10), ('Los Olivos', 10),
  ('Lurigancho', 12), ('Lurín', 15), ('Magdalena del Mar', 10),
  ('Miraflores', 10), ('Pueblo Libre', 10), ('Puente Piedra', 13),
  ('Rímac', 10), ('San Borja', 10), ('San Isidro', 10),
  ('San Juan de Lurigancho', 10), ('San Juan de Miraflores', 10),
  ('San Luis', 10), ('San Martín de Porres', 10), ('San Miguel', 10),
  ('Santa Anita', 10), ('Santiago de Surco', 10), ('Surquillo', 10),
  ('Villa El Salvador', 10), ('Villa María del Triunfo', 10),
  -- Callao
  ('Callao', 10), ('Bellavista', 10), ('Carmen de la Legua-Reynoso', 10),
  ('La Perla', 10), ('La Punta', 10), ('Ventanilla', 13), ('Mi Perú', 15),
  -- Zonas que Axel cobra aparte dentro de un distrito
  ('Salamanca', 10),        -- Ate
  ('Santa Clara', 15),      -- Ate
  ('Huaycán', 15),          -- Ate
  ('Pariachi', 15),         -- Ate
  ('Musa', 13),             -- La Molina
  ('Huachipa', 15),         -- Lurigancho
  ('Cajamarquilla', 18),    -- Lurigancho
  ('Chosica', 20),          -- Lurigancho
  ('Oquendo', 12),          -- Callao
  -- Alias: cómo escriben el distrito los pedidos reales
  ('Cercado de Lima', 10),      -- = Lima
  ('Surco', 10),                -- = Santiago de Surco
  ('Ate Vitarte', 10),          -- = Ate
  ('Vitarte', 10),              -- = Ate
  ('Magdalena', 10),            -- = Magdalena del Mar
  ('Lurigancho-Chosica', 12),   -- nombre oficial de Lurigancho: tarifa general
  ('Carmen de la Legua', 10);   -- = Carmen de la Legua-Reynoso

-- Cierra lo vigente del mismo ámbito el día anterior. Sin esto, dos tarifas
-- abiertas a la vez harían que el costo dependiera del orden de lectura.
update cost_tariffs t
   set effective_to = (:desde::date - 1), updated_at = now()
  from axel_tarifas a
 where t.org_id = :org::uuid
   and t.courier = 'axel'
   and t.concept = 'primer_intento'
   and t.store_id is null
   and t.region is null
   and t.province is null
   and t.district = a.district
   and t.effective_to is null
   and t.effective_from <= (:desde::date - 1);

-- Una tarifa que empezaría después de quedar cerrada sería invisible: se borra.
delete from cost_tariffs t
 using axel_tarifas a
 where t.org_id = :org::uuid
   and t.courier = 'axel'
   and t.concept = 'primer_intento'
   and t.store_id is null
   and t.region is null
   and t.province is null
   and t.district = a.district
   and t.effective_to is null
   and t.effective_from > (:desde::date - 1);

insert into cost_tariffs
  (org_id, store_id, courier, region, province, district,
   concept, amount, currency, effective_from, note, source)
select :org::uuid, null, 'axel', null, null, a.district,
       'primer_intento', a.amount, 'PEN', :desde::date,
       'Tarifario Axel Courier (columna GANANCIA de sus liquidaciones, jul-2026).',
       'manual'
  from axel_tarifas a;

commit;
