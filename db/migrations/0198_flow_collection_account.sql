-- La pasarela Flow es una cuenta de cobro nuestra, y no tiene celular.
--
-- #KP136181 quedó en «Revisión solicitada» con el aviso de cuenta receptora que
-- no coincide: la constancia de Flow dice «Pagado a: Aurela Kenku», y esa
-- cuenta no estaba en la lista. Es la nuestra: una sola cuenta de Flow para las
-- dos marcas, con ese nombre (lo confirmó scripts/flow-probe.mjs contra la
-- cuenta de producción el 12-09-2026).
--
-- No se podía dar de alta porque la 0126 exige los tres dígitos del celular, y
-- la constancia de una pasarela no enseña ninguno. Ahora el celular puede ser
-- NULO, y eso quiere decir «esta cuenta no cobra con celular», no «falta el
-- dato». La comparación (lib/yape-recipient.ts) lo trata así:
--
--   · Su única señal es el nombre: entero la verifica, recortado la deja en
--     contraste manual.
--   · Un celular leído la DESMIENTE: su constancia no muestra ninguno, así que
--     un comprobante con celular no es de esta cuenta.
--
-- Sigue en pie la regla que no se puede romper (0126): una tienda sin cuentas no
-- acusa a nadie. Esto solo añade una cuenta; no afloja ninguna comparación.

alter table store_collection_accounts
  alter column phone_last_digits drop not null;

comment on column store_collection_accounts.phone_last_digits is
  'Últimos 3 dígitos del celular de la cuenta. NULL = la cuenta no cobra con '
  'celular (una pasarela como Flow): su única señal es el nombre.';

-- El índice único de la 0126 va por celular, y con NULL no protege nada: dos
-- NULL no chocan. Las cuentas sin celular no se repiten por NOMBRE.
create unique index if not exists store_collection_accounts_no_phone_uniq
  on store_collection_accounts (store_id, lower(label))
  where phone_last_digits is null;

-- En todas las tiendas, como la semilla de la 0126: es la misma empresa y la
-- misma cuenta de Flow para Aurela y para Kenku.
insert into store_collection_accounts (store_id, label, aliases, phone_last_digits, note)
select s.id, 'Aurela Kenku', '{}'::text[], null, 'Pasarela de pagos Flow'
from stores s
where not exists (
  select 1
  from store_collection_accounts a
  where a.store_id = s.id
    and a.phone_last_digits is null
    and lower(a.label) = lower('Aurela Kenku')
);
