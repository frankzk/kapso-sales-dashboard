-- ============================================================================
-- 0167_transit_ticket_on_reply.sql — el ticket de Shalom se manda cuando la
-- clienta CONTESTA, no dentro del aviso.
--
-- POR QUÉ CAMBIA EL PLAN. El aviso (0166) iba a llevar el ticket en la cabecera
-- de una plantilla con documento (`guias_shalom_imagen`). Dos problemas: esa
-- plantilla hay que aprobarla en Meta cada vez que se toca, y la aprobada hoy
-- lleva el número de Yape ESCRITO A MANO y equivocado — dice 930 555 390 y el
-- nuestro es el 309 (1.787 cobros validados lo confirman).
--
-- Al pulsar un botón, la clienta abre la ventana de 24 h. Dentro de esa ventana
-- un documento se manda como mensaje normal: sin plantilla, sin aprobación y sin
-- número escrito a mano que pueda desalinearse. El ticket además llega cuando
-- ella está mirando el chat, no enterrado en el primer mensaje.
--
-- UNA VEZ POR GUÍA. Quien pulsa dos botones no recibe el ticket dos veces. El
-- sello vive en la fila del aviso —hay exactamente una por guía (0166)— y no en
-- la respuesta, porque la pregunta que contesta es «¿a esta guía ya se le mandó
-- su ticket?», no «¿qué pasó en este mensaje?».
-- ============================================================================

alter table shalom_transit_notifications
  add column if not exists ticket_sent_at timestamptz,
  -- Por qué no se pudo. Una guía sin `ose_id` (llegó por el Excel) o Shalom
  -- caído no son un fallo del aviso: el texto con las cuentas ya salió.
  add column if not exists ticket_error text;

comment on column shalom_transit_notifications.ticket_sent_at is
  'Cuándo se envió el ticket PDF de Shalom, al contestar la clienta. Una vez por guía.';
