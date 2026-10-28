-- No se cambia la revisión de pagos históricos ni se infieren importes.
-- NOT VALID conserva los registros previos para revisión humana; toda nueva
-- validación/escritura tiene que respetar la regla, por cualquier puerta.
alter table public.order_payments
  add constraint order_payments_validated_positive_amount
  check (validation_status <> 'validado' or
    (amount is not null and amount > 0 and amount::text not in ('NaN','Infinity','-Infinity')))
  not valid;
