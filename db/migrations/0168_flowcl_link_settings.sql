-- 0168_flowcl_link_settings.sql — el «Link de pago» del aviso Shalom, cobrado
-- de verdad por Flow.cl.
--
-- QUÉ CAMBIA. Hasta hoy el botón «Link de pago» contestaba con un texto fijo
-- configurado a mano (`stores.shalom_transit_payment_link`), y si no había
-- texto caía al número de Yape. Con esto, cuando la tienda tiene Flow.cl
-- configurado, se crea una orden de cobro POR EL SALDO QUE DEBE EN ESE
-- MOMENTO y se le manda el link que la cobra. El pago vuelve por el webhook
-- que ya existe (`app/api/webhooks/flowcl`, 0160/0161) y aparece como
-- comprobante en `order_payments`.
--
-- POR QUÉ UN INTERRUPTOR APARTE DE LAS CREDENCIALES. Tener la cuenta de Flow
-- configurada no es lo mismo que querer que un robot emita cobros solo. El
-- interruptor nace apagado; mientras lo esté, el botón contesta como hoy.
--
-- POR QUÉ UN EMAIL DE RESPALDO. `payment/create` exige un email del pagador y
-- nuestros pedidos casi nunca lo traen: de los 7.585 de los últimos 30 días,
-- 340 tenían email (4,5 %). El resto entra por WhatsApp, donde nadie pide un
-- correo. Sin un email de la tienda al que mandar el comprobante, el 95 % de
-- los cobros no se podría ni crear. Se usa el del cliente cuando existe.
--
-- POR QUÉ CADUCA. Un link vivo es una orden cobrable. Si la clienta paga
-- S/ 50 por Yape y el saldo baja, el link viejo sigue cobrando el importe
-- viejo: lo único que lo cierra es que caduque. 48 h por omisión — suficiente
-- para quien paga al recibir el aviso, corto para que un link olvidado no
-- cobre de más dentro de dos semanas.

alter table stores
  add column if not exists flowcl_link_enabled    boolean not null default false,
  add column if not exists flowcl_link_email      text,
  add column if not exists flowcl_link_ttl_hours  integer not null default 48,
  add column if not exists flowcl_link_yape_only  boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'stores_flowcl_link_ttl_hours_check'
  ) then
    alter table stores
      add constraint stores_flowcl_link_ttl_hours_check
      check (flowcl_link_ttl_hours between 1 and 720);
  end if;
end $$;

comment on column stores.flowcl_link_enabled is
  'Si el botón «Link de pago» del aviso Shalom crea un cobro real en Flow.cl. '
  'Apagado: contesta con el texto configurado o con el Yape, como antes.';
comment on column stores.flowcl_link_email is
  'Email del pagador que se le manda a Flow cuando el pedido no trae uno '
  '(el 95 % de los casos). Es el buzón de la tienda, no el del cliente.';
comment on column stores.flowcl_link_ttl_hours is
  'Horas hasta que la orden de Flow caduca. Un link vivo cobra el importe con '
  'el que nació, aunque el saldo ya haya bajado.';
comment on column stores.flowcl_link_yape_only is
  'Forzar el medio 170 (Yape One Shot) en vez de enseñar la página de '
  'selección de Flow. Ver FLOW_MEDIO_YAPE_ONE_SHOT en lib/flow/types.ts.';

-- Buscar el link vivo de un pedido es lo que se hace en CADA pulsación del
-- botón, y es lo que evita crear dos cobros por lo mismo.
create index if not exists flowcl_links_order_live_idx
  on flowcl_payment_links (order_id, kind, created_at desc)
  where status = 'creado';
