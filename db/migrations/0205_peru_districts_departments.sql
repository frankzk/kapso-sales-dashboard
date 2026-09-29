-- 0205_peru_districts_departments.sql — departamentos válidos en peru_districts.
--
-- El catálogo de distritos (0046) aprende de dos fuentes: el Excel de Aliclik
-- (`source = 'shipments'`) y la corrección manual de dirección en el Master
-- (`source = 'manual'`, «recordar para este distrito»). Medido el 29-09-2026,
-- 47 filas tenían un departamento que no es ninguno de los 25 del Perú:
--
--   · 12 del Excel sin departamento (Caraz, Reque, Saylla…).
--   · 27 manuales con la etiqueta del formulario en vez del departamento:
--     «Lima (departamento)», «Lima (provincia)», «Provincia)», «provincia)».
--   · 8 manuales con la provincia, el distrito o una errata en su lugar:
--     «huancayo», «cañete», «rioja», «Sayan», «arequira», «Chaclacayo».
--
-- El Master usa `department` como último recurso para la región del pedido
-- (lib/order-master.ts) y `courier_lima_districts` solo lo muestra; ninguno
-- filtra por él, así que corregirlo no saca ni mete distritos en ninguna lista.
-- Donde la provincia también era una etiqueta o una errata («Lima
-- (Metropolitana)», «LIMA», «ceñete»), se corrige en la misma fila.
--
-- «Shalom» no es un distrito: es la agencia donde el cliente recoge. Se borra
-- la fila; si alguien vuelve a escribirlo, el Master lo trata como distrito
-- desconocido en vez de inventarle «Lima (provincia)».
--
-- Nombres sin tilde, como el resto del catálogo («Junin», «San Martin»).
-- Idempotente: cada UPDATE fija un valor y el borrado va guardado.

update peru_districts pd
set department = v.department,
    province = coalesce(v.province, pd.province),
    updated_at = now()
from (values
  -- Excel de Aliclik sin departamento
  ('caraz',                  'Ancash',      null::text),
  ('coishco',                'Ancash',      null),
  ('yungay',                 'Ancash',      null),
  ('huamancaca chico',       'Junin',       null),
  ('huayucachi',             'Junin',       null),
  ('san agustin',            'Junin',       null),
  ('san jeronimo de tunan',  'Junin',       null),
  ('lamas',                  'San Martin',  null),
  ('oropesa - tipon',        'Cusco',       null),
  ('saylla',                 'Cusco',       null),
  ('reque',                  'Lambayeque',  null),
  ('samegua',                'Moquegua',    null),
  -- Lima Metropolitana
  ('barrios altos',          'Lima',        'Lima'),
  ('brena',                  'Lima',        'Lima'),
  ('la molina',              'Lima',        'Lima'),
  ('lima',                   'Lima',        'Lima'),
  ('lince',                  'Lima',        'Lima'),
  ('los olivos',             'Lima',        'Lima'),
  ('miraflores',             'Lima',        'Lima'),
  ('pariachi',               'Lima',        'Lima'),
  ('pueblo libre',           'Lima',        'Lima'),
  ('san juan de lurigancho', 'Lima',        'Lima'),
  ('san juan de miraflores', 'Lima',        'Lima'),
  ('san luis',               'Lima',        'Lima'),
  ('san martin de porres',   'Lima',        'Lima'),
  ('san martin de porress',  'Lima',        'Lima'),
  ('surco',                  'Lima',        'Lima'),
  ('la victoria',            'Lima',        'Lima'),
  ('san isidro',             'Lima',        'Lima'),
  ('chaclacayo',             'Lima',        'Lima'),
  ('chosica',                'Lima',        'Lima'),
  ('a chosica',              'Lima',        'Lima'),
  ('carabayllo',             'Lima',        'Lima'),
  -- Lima provincias
  ('canta',                  'Lima',        'Canta'),
  ('huarochiri',             'Lima',        'Huarochiri'),
  ('barranca',               'Lima',        'Barranca'),
  ('paramonga',              'Lima',        'Barranca'),
  ('chilca',                 'Lima',        'Cañete'),
  ('canete san vicente',     'Lima',        'Cañete'),
  ('nuevo imperial',         'Lima',        'Cañete'),
  ('sayan',                  'Lima',        'Huaura'),
  -- Callao
  ('ventanilla - shalom',    'Callao',      'Callao'),
  -- Resto del país
  ('huancayo',               'Junin',       'Huancayo'),
  ('el tambo',               'Junin',       'Huancayo'),
  ('rioja',                  'San Martin',  'Rioja'),
  ('cayma',                  'Arequipa',    'Arequipa')
) as v(district_key, department, province)
where pd.district_key = v.district_key
  and (pd.department is distinct from v.department
       or (v.province is not null and pd.province is distinct from v.province));

-- Guarda (test/migrations-safe-to-rerun.test.ts): solo la fila exacta que
-- aprendió el formulario; si alguien la corrigió a mano, no se toca.
do $$
begin
  delete from peru_districts
  where district_key = 'shalom'
    and source = 'manual'
    and department = 'Lima (provincia)';
end $$;
