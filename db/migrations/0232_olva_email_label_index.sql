-- 0232_olva_email_label_index.sql — un rótulo por fila, no un PDF por fila
-- (MOM §12, «Cotejar Olva › Correos de Olva»).
--
-- POR QUÉ. Un registro de Olva con varios envíos manda UN correo con UN PDF
-- que trae un rótulo por envío («N° REGISTRO: … (1/4)», «(2/4)»…). La 0223
-- guardaba una fila por PDF (`message_id` + `file_name`) y el lector solo
-- veía el primer rótulo: 102 de los 163 rótulos de los primeros 61 correos
-- nunca se cotejaron (el del 05-10-2026, registro 202600718786, traía cuatro
-- y solo vinculó #KP138456).
--
-- `label_index` es la posición del rótulo en su PDF (la «k» de «(k/n)») y
-- `label_count` cuántos trae. Las filas que ya existen son el primer rótulo de
-- su PDF: quedan con 1. Make puede volver a mandar el mismo correo y sigue sin
-- duplicarse: la clave pasa a ser `message_id` + `file_name` + `label_index`.

alter table olva_email_labels add column if not exists label_index int not null default 1;
alter table olva_email_labels add column if not exists label_count int;

update olva_email_labels
   set label_count = coalesce(substring(raw_text from '\(\s*1\s*/\s*(\d+)\s*\)')::int, 1)
 where label_count is null;

alter table olva_email_labels drop constraint if exists olva_email_labels_message_id_file_name_key;
alter table olva_email_labels drop constraint if exists olva_email_labels_message_file_label_key;
alter table olva_email_labels add constraint olva_email_labels_message_file_label_key
  unique (message_id, file_name, label_index);

comment on column olva_email_labels.label_index is
  'Posición del rótulo en su PDF (la k de «(k/n)»): un registro con varios envíos trae un rótulo por envío.';
comment on column olva_email_labels.label_count is
  'Cuántos rótulos trae el PDF de este correo.';
