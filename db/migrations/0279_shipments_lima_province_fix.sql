-- La provincia de las cajas de Lima que copiaron una provincia imposible
-- (25-10-2026, MOM §19.0, `mom-v1.32`).
--
-- `peru_districts` va por NOMBRE de distrito y se llenaba con «Recordar esta
-- provincia» al corregir una ubicación a mano, marcado por defecto. Los nombres
-- se repiten en el Perú y lo aprendido pisó a los de Lima:
--
--   21-10-2026  miraflores    → arequipa   (de un pedido de Miraflores de Arequipa, #KP143187)
--   19-10-2026  independencia → HUARAZ     (con departamento «Lima», que no existe)
--   ≤ 18-10     san miguel    → san roman  (San Miguel de Puno, sobre San Miguel de Lima)
--
-- y otros con el propio distrito puesto de provincia («comas», «lince», «la
-- molina», «miraflores»…). Una salida guarda la provincia que copió del Master
-- al crearse, así que el rótulo de KP143872-S01 salió «Miraflores / arequipa»
-- con el pedido ya corregido. La cobertura nunca cambió: todas son de Lima.
--
-- El código ya no lo deja pasar (lib/district-learning.ts: `districtLearnVerdict`,
-- `learnedDistrictFits`, `guideProvinceFits`, `printedProvince`). Esto arregla
-- lo ya guardado en `shipments`, con LA MISMA regla:
--
--   · el departamento de la caja es Lima o el Callao (`lima_region_kind`);
--   · el distrito es de Lima Metropolitana o el Callao, sin buscar dentro del
--     texto (`resolve_lima_district(…, false)`);
--   · la provincia no es una de las diez de Lima ni el Callao.
--
-- La provincia pasa a «Lima», o a «Callao» si el distrito o el departamento son
-- del Callao. Medido el 25-10-2026 en producción: 253 cajas.
--
--   san roman   86   comas      63   miraflores  32   arequipa   21
--   lince       21   huaraz      8   la molina    7   bellavista  6
--   pucusana     5   chosica     2   pachacamac   2
--
-- Solo la provincia: ni el distrito, ni la región, ni el estado, ni ningún hecho
-- del historial. Correrla dos veces no cambia nada (lo corregido ya cumple la
-- regla y deja de entrar). El Master se recalcula solo con `mom-v1.32`.

update shipments s
set province = case
      when lima_region_kind(s.region) = 'callao'
        or resolve_lima_district(s.district, false) in
           ('bellavista', 'callao', 'carmen de la legua reynoso', 'la perla', 'la punta', 'mi peru', 'ventanilla')
      then 'Callao'
      else 'Lima'
    end
where s.province is not null
  and coverage_norm(s.province) <> ''
  and lima_region_kind(s.region) is not null
  and resolve_lima_district(s.district, false) is not null
  and coverage_norm(s.province) not in (
    'lima', 'lima provincia', 'lima metropolitana', 'lima departamento',
    'callao', 'provincia constitucional del callao',
    'barranca', 'cajatambo', 'canta', 'canete', 'huaral', 'huarochiri',
    'huaura', 'oyon', 'yauyos'
  );
