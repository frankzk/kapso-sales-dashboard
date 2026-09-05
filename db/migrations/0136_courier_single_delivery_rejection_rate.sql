-- ============================================================================
-- 0136_courier_single_delivery_rejection_rate.sql
-- Grupo GF Courier cobra exactamente el mismo importe distrital cuando una
-- parada termina entregada o rechazada por el cliente. Conservamos la columna
-- rejection_amount por compatibilidad, pero deja de ser una tarifa editable.
-- ============================================================================

update logistics_district_tariffs
set rejection_amount = delivery_amount
where rejection_amount is distinct from delivery_amount;

alter table logistics_district_tariffs
  drop constraint if exists logistics_tariffs_same_delivery_rejection_amount;

alter table logistics_district_tariffs
  add constraint logistics_tariffs_same_delivery_rejection_amount
  check (rejection_amount = delivery_amount);

comment on column logistics_district_tariffs.rejection_amount is
  'Copia técnica de delivery_amount: entrega y rechazo cobran la misma tarifa distrital.';
