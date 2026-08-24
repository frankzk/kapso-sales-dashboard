-- Ocho distritos con la geografía inventada.
--
-- `peru_districts` se llena a mano y nadie valida lo que se escribe. Ocho filas
-- acabaron con el DEPARTAMENTO copiado del propio distrito —`Pachacamac`,
-- `Pucusana`, `HUACHIPA`, `Chancay`, `Huaral`, `Lurigancho chosica`,
-- `Barranca`— y una con la geografía de otra región entera: Pacasmayo, que es
-- de La Libertad, decía `Callao` en provincia Y en departamento.
--
-- No es cosmético. `lib/order-master.ts` usa esta tabla para rellenar la región
-- del pedido, y esa región entra a `order_coverage_for` → `is_lima_metropolitana`
-- → `lima_region_kind`. Un departamento inventado no coincide con nada y el
-- distrito se cae de Lima; «Callao» sí coincide, y arrastra a Pacasmayo DENTRO
-- de Lima.
--
-- Medido con order_coverage_for sobre las dos tiendas, antes y después:
--
--   pacasmayo            lima          -> agencia   (La Libertad tratada como Lima)
--   lurigancho           provincia_cod -> lima
--   lurigancho chosica   provincia_cod -> lima
--   chaclacayo           provincia_cod -> lima
--   pachacamac           agencia       -> lima
--   chancay              agencia       -> agencia   (correcto de casualidad)
--   huaral               agencia       -> agencia   (correcto de casualidad)
--   paramonga paramonga  agencia       -> agencia   (correcto de casualidad)
--
-- Las tres últimas ya acertaban, pero por accidente: un departamento que no
-- empareja con nada da el mismo resultado que uno correcto FUERA de Lima
-- Metropolitana. Se corrigen igual, porque el acierto por accidente deja de
-- serlo en cuanto alguien añada una tarifa con alcance por departamento.
--
-- El alcance real es menor que la tabla de arriba: en el Master la región de
-- Shopify GANA a la de esta tabla (order-master.ts, prioridad de `region`), así
-- que el departamento inventado solo llegaba a los pedidos cuya dirección de
-- Shopify venía sin provincia. Son 7 pedidos. La provincia sí se usa en más
-- casos, y ahí `Pucusana` para Chaclacayo o `Callao` para Pacasmayo se leían en
-- pantalla tal cual.
--
-- Convención de la tabla: Lima Metropolitana se escribe `Lima` / `Lima`, que es
-- lo que `lima_region_kind` resuelve a 'lima' y deja que el distrito decida.
--
-- No se toca `district`: `district_key` es la clave de unión y cambiar el texto
-- visible no arregla ninguna cobertura. «Paramonga Paramonga» sigue duplicado.

update peru_districts as p
   set province   = f.province,
       department = f.department,
       source     = 'manual',
       updated_at = now()
  from (values
    -- Pacasmayo es de La Libertad, no del Callao.
    ('pacasmayo',           'Pacasmayo', 'La Libertad'),
    -- Paramonga: distrito de la provincia de Barranca, departamento de Lima.
    ('paramonga paramonga', 'Barranca',  'Lima'),
    -- Chancay es distrito de la provincia de Huaral.
    ('chancay',             'Huaral',    'Lima'),
    ('huaral',              'Huaral',    'Lima'),
    -- Los cuatro que sí son Lima Metropolitana.
    ('lurigancho',          'Lima',      'Lima'),
    ('lurigancho chosica',  'Lima',      'Lima'),
    ('pachacamac',          'Lima',      'Lima'),
    ('chaclacayo',          'Lima',      'Lima')
  ) as f(district_key, province, department)
 where p.district_key = f.district_key;
