-- Ciclo automático de recontacto (MOM §6.1).
--
-- Un pedido Por confirmar que nadie volvió a llamar y al que nadie le pactó
-- fecha se quedaba veintitrés días con 1/7 días de gestión: su recordatorio de
-- dos horas vencía el primer día y ahí se hundía, en Vencidos, sin volver a
-- aparecer nunca en la cola de Hoy. El ciclo lo devuelve al trabajo cada N días
-- contados desde el último contacto.
--
-- `confirmation_cycle_due_on` es DERIVADA y vive aparte de
-- `confirmation_next_contact_on`: esa la pactó una persona en una llamada y el
-- MOM la trata como hecho; esta la calcula Kapta y se recalcula sola en cada
-- barrido del Master.

alter table stores
  add column if not exists confirmation_cycle_days smallint not null default 3;

comment on column stores.confirmation_cycle_days is
  'Días entre recontactos automáticos cuando el intento no dejó fecha pactada (MOM §6.1).';

alter table stores
  drop constraint if exists stores_confirmation_cycle_days_check;
alter table stores
  add constraint stores_confirmation_cycle_days_check
  check (confirmation_cycle_days between 1 and 30);

alter table order_master
  add column if not exists confirmation_cycle_due_on date;

comment on column order_master.confirmation_cycle_due_on is
  'Día en que el pedido vuelve a la cola por ciclo automático: último contacto + confirmation_cycle_days. Nulo si hay fecha pactada o si nadie lo ha contactado.';

create index if not exists order_master_confirmation_cycle_idx
  on order_master(store_id, confirmation_cycle_due_on, order_created_at desc)
  where macro_stage = 'por_confirmar' and confirmation_cycle_due_on is not null;

-- Relleno inicial con la MISMA regla que el barrido: último contacto + ciclo de
-- la tienda, en calendario de Lima. Sin esto la cola queda a medias hasta que el
-- reconciliador vaya recalculando pedido por pedido, que es justo el rato en que
-- alguien miraría «Hoy» y lo vería vacío. El siguiente barrido reescribe estos
-- mismos valores: la columna es derivada y no guarda ninguna decisión humana.
update order_master m
set confirmation_cycle_due_on =
      (m.confirmation_last_contact_at at time zone 'America/Lima')::date
      + coalesce(s.confirmation_cycle_days, 3)
from stores s
where s.id = m.store_id
  and m.macro_stage = 'por_confirmar'
  and m.confirmation_next_contact_on is null
  and m.confirmation_last_contact_at is not null;
