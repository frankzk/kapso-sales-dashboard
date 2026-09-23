-- 0175_olva_notices.sql — los dos avisos de WhatsApp de Olva: «va en camino» y
-- «ya llegó a la oficina», con el saldo, igual que los de Shalom (0166, 0170).
--
-- EL HUECO. Desde la 0174 Kapta sabe cuándo un envío de Olva sale de Lima y
-- cuándo llega a la oficina de destino. Lo sabía y no se lo decía a nadie: la
-- clienta que dio S/ 20 de adelanto se enteraba de que su paquete estaba en la
-- oficina cuando alguien se lo escribía a mano, y el saldo se cobraba chat por
-- chat. Con Shalom eso ya lo hace la cola de avisos; Olva devuelve a los 6 días
-- —no a los 28—, así que aquí urge más.
--
-- MISMA COLA, MISMO ENVÍO, MISMOS BOTONES. La cola `shalom_transit_notifications`
-- gana una columna `courier`: la unique (shipment_id, kind) ya garantiza un
-- aviso de cada tipo por guía, y una guía es de un solo courier. Lo que cambia
-- por courier es la PLANTILLA —Meta aprueba cada texto por separado, y los de
-- Shalom nombran a Shalom y llevan su código corto—, así que cada uno tiene
-- nombre de plantilla, interruptor y orden de variables propios. El número, el
-- idioma, el horario, las cuentas de cobro y la respuesta al «Link de pago»
-- son de la tienda y se comparten con los avisos de Shalom.
--
-- OLVA NO TIENE CÓDIGO CORTO NI TICKET. Sus variables por omisión son las de
-- Shalom sin `codigo`; el ticket en cabecera no existe para Olva.

alter table shalom_transit_notifications
  add column if not exists courier text not null default 'shalom';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'shalom_transit_notifications_courier_check'
  ) then
    alter table shalom_transit_notifications
      add constraint shalom_transit_notifications_courier_check
      check (courier in ('shalom', 'olva'));
  end if;
end $$;

comment on column shalom_transit_notifications.courier is
  'De qué courier es la guía del aviso. Decide la plantilla; la cola, el envío '
  'y los botones de cobro son los mismos.';

alter table stores
  add column if not exists olva_transit_template_enabled boolean not null default false,
  add column if not exists olva_transit_template_name    text,
  add column if not exists olva_transit_params           text
    not null default 'nombre,guia,producto,agencia,total,adelanto,saldo,yape',
  add column if not exists olva_arrival_template_enabled boolean not null default false,
  add column if not exists olva_arrival_template_name    text,
  add column if not exists olva_arrival_params           text
    not null default 'nombre,guia,producto,agencia,total,adelanto,saldo';

comment on column stores.olva_transit_template_enabled is
  'Aviso de «va en camino» para guías de Olva. Independiente del de Shalom.';
comment on column stores.olva_transit_params is
  'Orden de variables de la plantilla de tránsito de Olva. Los mismos tokens '
  'que Shalom menos `codigo`: Olva no tiene código corto. `guia` es el tracking '
  'de Olva («2552504-26»).';
comment on column stores.olva_arrival_template_enabled is
  'Aviso de «ya llegó a la oficina» para guías de Olva. El plazo de Olva son 6 '
  'días, así que `vence` —si se usa— se calcula con 6 y no con 28.';
