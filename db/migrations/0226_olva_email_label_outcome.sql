-- 0226_olva_email_label_outcome.sql — qué hizo cada correo de Olva al llegar
-- (MOM §12, «Cotejar Olva › Correos de Olva»).
--
-- POR QUÉ. «Correos de Olva» lista cada rótulo que llegó del buzón y si
-- encontró su pedido. Hasta ahora el resultado solo quedaba escrito en
-- `match_note`, una frase para personas: distinguir «lo vinculó este correo»
-- de «ya estaba vinculado» obligaba a leer el texto. `outcome` lo guarda tal
-- cual lo decidió /api/webhooks/olva-email:
--
--   vinculado      el correo le puso el tracking a su salida
--   ya_vinculado   el tracking ya estaba en una salida al llegar
--   sugerido       ninguna salida casó, pero UN pedido abierto tiene ese teléfono
--   ambiguo        casó con varias salidas, o no se pudo escribir
--   sin_pareja     ninguna salida ni pedido
--   ilegible       no se leyó el tracking del rótulo
--
-- Las filas anteriores se rellenan con las mismas frases que escribía el
-- webhook (`lib/olva/email-log.ts`, `labelOutcome`, hace lo mismo con una
-- fila que llegue sin `outcome`).

alter table olva_email_labels add column if not exists outcome text;

update olva_email_labels set outcome = case
  when olva_tracking is null or parse_error is not null then 'ilegible'
  when linked_shipment_id is not null and match_note ilike 'Ya estaba%' then 'ya_vinculado'
  when linked_shipment_id is not null then 'vinculado'
  when suggested_order_name is not null then 'sugerido'
  when match_note ilike 'Coincide con varias%' then 'ambiguo'
  else 'sin_pareja'
end
where outcome is null;

alter table olva_email_labels drop constraint if exists olva_email_labels_outcome_check;
alter table olva_email_labels add constraint olva_email_labels_outcome_check
  check (outcome is null or outcome in ('vinculado', 'ya_vinculado', 'sugerido', 'ambiguo', 'sin_pareja', 'ilegible'));

-- La pestaña filtra por la cuenta que envía (el RUC de «ENVIA»).
create index if not exists olva_email_labels_sender_created_idx
  on olva_email_labels (sender_doc, created_at desc);

comment on column olva_email_labels.outcome is
  'Qué hizo el correo al llegar: vinculado, ya_vinculado, sugerido, ambiguo, sin_pareja o ilegible.';
