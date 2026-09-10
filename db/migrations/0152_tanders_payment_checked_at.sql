-- ============================================================================
-- 0152_tanders_payment_checked_at.sql — que el barrido de cobros Tanders mire
-- TODAS las guías, no siempre las mismas 60.
--
-- EL CASO. El 10-09-2026, con el extractor ya arreglado, el barrido validaba
-- cobros de verdad… pero solo de 60 guías. Había 238 candidatas y la consulta
-- corta en 60 SIN ORDEN NINGUNO: PostgREST devuelve las que le da la gana, así
-- que las mismas entraban una y otra vez y el resto no se miraba nunca. El
-- pedido #AUR176448 —entregado en Tanders el 09-09, con su Yape de S/ 129
-- verificado— no estaba entre esas 60 y no iba a estarlo jamás.
--
-- Las guías en ruta agravan el problema: nunca escriben una fila de
-- comprobación (no hay constancia que comprobar todavía), así que siguen
-- siendo candidatas para siempre y compiten cada pasada por los mismos 60
-- sitios. Sin un orden, la cola no avanza: es hambre, no atraso.
--
-- El sello de CUÁNDO SE MIRÓ arregla eso. Se escribe en cada pasada, se haya
-- encontrado constancia o no, y el barrido ordena por él con las nunca miradas
-- primero: mismo patrón que el barrido de estados (`last_report_at`), que ya
-- funcionaba. Con 60 por pasada cada dos horas, las 238 se recorren enteras en
-- unas ocho horas y ninguna se queda fuera.
-- ============================================================================

alter table shipments
  -- Última vez que el barrido de cobros preguntó por esta guía. Es "cuándo se
  -- miró", NO "cuándo se validó": una guía en ruta también deja sello, que es
  -- justo lo que permite pasar a la siguiente.
  add column if not exists payment_checked_at timestamptz;

comment on column shipments.payment_checked_at is
  'Última pasada del barrido de cobros Tanders sobre esta guía (haya habido constancia o no). Ordena la cola para que ninguna se quede sin mirar.';

-- Nulls first: la que nunca se miró es la que más urge.
create index if not exists shipments_tanders_payment_queue_idx
  on shipments(payment_checked_at nulls first)
  where courier = 'tanders';
