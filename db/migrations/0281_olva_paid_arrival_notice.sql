-- ============================================================================
-- 0281_olva_paid_arrival_notice.sql — «Ya llegó, recógelo con tu DNI» para la
-- clienta de Olva que YA PAGÓ (MOM §12, «El aviso de llegada para pagados de
-- Olva», decisión del owner del 25-10-2026).
--
-- EL HUECO. El aviso de llegada es de COBRO y no sale a quien ya no debe nada
-- (`noticeSkipReason`: «ya pagó todo» / «pagado en el checkout»). En Shalom se
-- sostiene porque la clienta ya tiene su clave y el mensaje de la clave le dijo
-- «cuando llegue, preséntala con tu DNI». Olva no tiene clave: la clienta de
-- Olva que pagó completo NUNCA se enteraba de que su paquete llegó, y Olva lo
-- devuelve a los 6 días (#KP141593, #KP142910, #KP140003).
--
-- UNA PLANTILLA MÁS, NO UN AVISO MÁS. Sale en la MISMA fila de la cola que el
-- aviso de llegada (`kind = 'disponible'`): al enviar, si la clienta ya no debe
-- nada, se usa esta plantilla en vez de omitir. Así la unique
-- `(shipment_id, kind)` sigue garantizando un solo aviso de llegada por guía, y
-- quien recibió el de cobro y pagó después no recibe un segundo. Por eso esta
-- migración no toca la cola: solo la config de la tienda.
--
-- NACE APAGADO hasta que el owner cree la plantilla en Kapso y Meta la apruebe.
-- Apagado, la fila se omite como hoy, con el motivo diciendo que falta esto.
--
-- EL CÓDIGO NO LA NECESITA PARA ARRANCAR: sin las columnas el aviso cuenta como
-- apagado (select * → undefined) y Ajustes no enseña el bloque.
-- ============================================================================

alter table stores
  add column if not exists olva_paid_arrival_template_enabled boolean not null default false,
  add column if not exists olva_paid_arrival_template_name    text default 'guias_olva_llegada_pagado',
  add column if not exists olva_paid_arrival_params           text not null
    default 'nombre,producto,agencia,guia,vence';

comment on column stores.olva_paid_arrival_template_enabled is
  'Aviso «ya llegó, recógelo con tu DNI» de Olva para quien ya no debe saldo '
  '(0281). Sustituye a la omisión del aviso de llegada; sin botones ni cobro. '
  'Nace apagado.';
comment on column stores.olva_paid_arrival_params is
  'Orden de variables del aviso para pagados. Sin importes (total, adelanto, '
  'saldo, yape no se admiten). `vence` se calcula a 6 días de la llegada.';
