-- 0223_olva_email_labels.sql — el rótulo que Olva manda por correo al
-- registrar cada envío, leído (MOM §12, «Cotejar Olva»).
--
-- POR QUÉ. El portal de Olva no da el documento ni el teléfono del
-- destinatario; el PDF del correo «Registro exitoso … - Registro Nro …» sí.
-- Un escenario de Make vigila el buzón, saca el PDF y lo manda a
-- /api/webhooks/olva-email, que lo lee y lo guarda aquí. Con el teléfono y el
-- DNI se encuentra la salida que ni la dirección ni el nombre encuentran (la
-- clienta registrada en Kapta como «Carlos Carlos», el envío a la oficina).
--
-- Una fila por PDF de cada correo (`message_id` + `file_name`): Make puede
-- volver a mandar el mismo correo y no debe duplicarse. Se guarda también el
-- texto leído, para corregir el lector sin pedir los correos otra vez.
--
-- `linked_shipment_id` dice a qué salida le puso el tracking este rótulo;
-- `suggested_order_name`, el pedido que tiene ese teléfono pero todavía no
-- tiene salida de Olva (no se crea sola: lo confirma una persona).

create table if not exists olva_email_labels (
  id                    uuid primary key default gen_random_uuid(),
  message_id            text not null,
  file_name             text not null default '',
  received_at           timestamptz,
  subject               text,
  registro              text,
  olva_tracking         text,
  olva_emision          text,
  sender_doc            text,
  recipient_name        text,
  recipient_doc         text,
  recipient_phone       text,
  address               text,
  reference             text,
  ubigeo                text,
  label_date            date,
  raw_text              text,
  parse_error           text,
  linked_shipment_id    uuid references shipments(id) on delete set null,
  suggested_order_name  text,
  match_note            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (message_id, file_name)
);

create index if not exists olva_email_labels_tracking_idx
  on olva_email_labels (olva_emision, olva_tracking);
create index if not exists olva_email_labels_created_idx
  on olva_email_labels (created_at desc);

comment on table olva_email_labels is
  'Rótulos de Olva llegados por correo (Make → /api/webhooks/olva-email): tracking, documento y teléfono del destinatario, para el cotejo.';

-- Datos personales del destinatario: solo el servidor (service_role) los lee.
alter table olva_email_labels enable row level security;
grant all privileges on olva_email_labels to service_role;
