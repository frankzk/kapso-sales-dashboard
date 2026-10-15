-- 0264_order_master_sales_channel.sql — el canal de venta de cada pedido, para
-- filtrar el Master por cómo se generó (MOM §3, «Pedido», 15-10-2026, pedido de
-- Frankz).
--
-- QUÉ ES. Todos los pedidos nacen en Shopify, pero no por el mismo camino, y lo
-- dicen sus etiquetas: el formulario COD de la web, un carrito abandonado que se
-- completó, una asesora desde Leads, el chatbot de WhatsApp (Kapso), el bot de
-- carritos o el catálogo privado. Un pedido tiene UN canal; con marcas de dos
-- gana quien cerró la venta antes que la herramienta donde quedó escrita.
--
-- QUIÉN LA ESCRIBE. El recálculo del pedido (lib/order-master.ts) con
-- `salesChannel` (lib/sales-channel.ts). `order_sales_channel` es la misma regla
-- en SQL y solo sirve para rellenar lo que ya existe al aplicar esta migración;
-- test/sales-channel.test.ts comprueba que las dos digan lo mismo.
--
-- El Master filtra en la base y pagina, así que el filtro necesita la columna.

alter table order_master add column if not exists sales_channel text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'order_master_sales_channel_check') then
    alter table order_master add constraint order_master_sales_channel_check
      check (sales_channel in ('asesora', 'chatbot', 'bot_carritos', 'catalogo', 'web_carrito', 'web_formulario', 'otro'));
  end if;
end $$;

create or replace function order_sales_channel(p_tags text[], p_kapso_conversation_id text)
returns text
language sql
immutable
set search_path = public
as $$
  with t as (
    select coalesce(array(select lower(btrim(x)) from unnest(coalesce(p_tags, '{}'::text[])) x), '{}'::text[]) as lt
  )
  select case
    when lt && array['venta_manual', 'carrito_recuperado'] then 'asesora'
    when nullif(p_kapso_conversation_id, '') is not null or lt && array['kapso', 'whatsapp'] then 'chatbot'
    when lt && array['carrito recuperado', 'bot', 'bot (whatsapp_cloud)'] then 'bot_carritos'
    when lt && array['catalogo-wsp'] then 'catalogo'
    when lt && array['easysell-abandoned-checkout', 'abandoned_checkout_releasit_cod_form'] then 'web_carrito'
    when lt && array['easysell_cod_form'] then 'web_formulario'
    else 'otro'
  end
  from t
$$;

-- Relleno de lo existente. Re-aplicarla no cambia nada: solo escribe la fila
-- cuyo canal es distinto del que dice la regla.
update order_master om
   set sales_channel = order_sales_channel(o.tags, o.kapso_conversation_id)
  from orders o
 where o.id = om.order_id
   and om.sales_channel is distinct from order_sales_channel(o.tags, o.kapso_conversation_id);

create index if not exists order_master_store_sales_channel_idx
  on order_master(store_id, sales_channel);
