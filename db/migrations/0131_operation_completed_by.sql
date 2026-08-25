-- Quién escribió a mano el nº de operación.
--
-- POR QUÉ HACE FALTA GUARDARLO. El nº de operación es lo que detecta pagos
-- duplicados: el índice único vive sobre esa columna. Cuando lo transcribe una
-- persona desde la imagen, un dígito mal copiado no se nota el día que se
-- escribe —crea un pago que no choca con nada— y sale meses después, como un
-- cobro repetido que nadie cazó o como un comprobante reutilizado en dos
-- pedidos.
--
-- La defensa contra eso no es revisar mejor: es que lo mire una segunda
-- persona. Con esta columna, `validatePayment` puede negarse cuando quien
-- valida es quien transcribió.
--
-- MEDIDO ANTES DE ESCRIBIRLA: de 13 pagos completados a mano, en 3 la misma
-- persona escribió el número y validó el pago —un 23 %—. No estaba prohibido y
-- ya pasaba.
--
-- NULO SIGNIFICA «LO LEYÓ LA MÁQUINA», NO «NO SE SABE». Si el número salió de
-- la visión no hay transcripción humana que contrastar, y exigir un segundo par
-- de ojos ahí sería fricción sin nada que proteger. Por eso el guardarraíl solo
-- actúa cuando esta columna tiene a alguien: el pase de relectura
-- (`lib/voucher-reprocess.ts`) escribe el número SIN tocarla, a propósito.
--
-- Tampoco se borra al validar: es historia de quién hizo qué, y el propio
-- guardarraíl la necesita si el pago vuelve a Observados y se valida otra vez.

alter table order_payments
  add column if not exists operation_completed_by uuid references auth.users(id);

comment on column order_payments.operation_completed_by is
  'Quién transcribió a mano el nº de operación. Nulo = lo leyó la visión. '
  'Lo usa validatePayment para exigir que valide otra persona.';

-- Para responder «¿lo escribió quien está validando?» sin recorrer la tabla.
create index if not exists order_payments_completed_by_idx
  on order_payments (operation_completed_by)
  where operation_completed_by is not null;
