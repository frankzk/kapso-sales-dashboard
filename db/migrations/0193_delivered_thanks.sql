-- 0193_delivered_thanks.sql — agradecimiento con catálogo al entregar.
--
-- Cuando un pedido pasa a ENTREGADO se le manda a la clienta una plantilla de
-- WhatsApp: gracias por la compra y un link al catálogo privado con descuento.
-- Ver lib/delivered-thanks.ts.
--
-- POR QUÉ UNA PLANTILLA. La entrega llega días después de la última
-- conversación: la ventana de 24 h de WhatsApp está cerrada y fuera de ella
-- solo entra una plantilla aprobada por Meta. Lleva una oferta, así que es de
-- categoría MARKETING.
--
-- NACE APAGADA en todas las tiendas: hasta que la plantilla esté aprobada en la
-- WABA de cada una y alguien escriba su nombre acá, no se envía nada.

alter table stores
  add column if not exists delivered_thanks_enabled boolean not null default false,
  add column if not exists delivered_thanks_template_name text,
  add column if not exists delivered_thanks_template_language text not null default 'es',
  -- Orden de las variables del CUERPO, por tokens (como return_recovery_params).
  add column if not exists delivered_thanks_params text not null default 'nombre',
  -- Qué va en la variable del BOTÓN de URL dinámica. `telefono` = el celular
  -- de la clienta en dígitos, que es lo que el catálogo privado espera en
  -- `?wa=`. Vacío = la plantilla no lleva botón dinámico.
  add column if not exists delivered_thanks_button_param text not null default 'telefono',
  -- Número propio para este envío. NULL = el de la tienda.
  add column if not exists delivered_thanks_phone_number_id text,
  add column if not exists delivered_thanks_hour_start integer not null default 9,
  add column if not exists delivered_thanks_hour_end integer not null default 21,
  -- Una entrega más vieja que esto no se agradece: muchas se marcan en bloque
  -- al importar un reporte días después, y un «gracias» de hace una semana
  -- suena a error.
  add column if not exists delivered_thanks_max_hours integer not null default 72;

comment on column stores.delivered_thanks_button_param is
  'Token de la variable del botón URL: telefono | pedido | vacío (sin botón dinámico).';

-- ── Historial de intentos ───────────────────────────────────────────────────
-- Un envío por pedido. El índice único sobre los ACEPTADOS es la garantía: el
-- cron puede correr dos veces sobre el mismo pedido y el segundo insert choca.
-- Los rechazos se guardan igual —para saber por qué no salió— y cuentan para
-- el tope de reintentos.
create table if not exists delivered_thanks_sends (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references stores(id) on delete cascade,
  order_id      uuid not null references orders(id) on delete cascade,
  phone         text not null,
  template_name text,
  ok            boolean not null default true,
  error         text,
  sent_at       timestamptz not null default now()
);
create unique index if not exists delivered_thanks_sends_order_ok_uniq
  on delivered_thanks_sends(order_id) where ok;
create index if not exists delivered_thanks_sends_store_sent_idx
  on delivered_thanks_sends(store_id, sent_at desc);
create index if not exists delivered_thanks_sends_phone_idx
  on delivered_thanks_sends(phone, sent_at desc) where ok;

alter table delivered_thanks_sends enable row level security;
drop policy if exists delivered_thanks_sends_select on delivered_thanks_sends;
create policy delivered_thanks_sends_select on delivered_thanks_sends for select to authenticated
  using (store_id in (select auth_store_ids()));
grant select on delivered_thanks_sends to authenticated;
grant all privileges on delivered_thanks_sends to service_role;
