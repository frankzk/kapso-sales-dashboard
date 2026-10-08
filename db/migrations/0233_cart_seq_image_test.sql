-- 0233_cart_seq_image_test.sql — prueba A/B: el mensaje 1 de carrito
-- abandonado con la foto del producto (docs/carritos-secuencia-whatsapp.md).
--
-- POR QUÉ. Desde el 20-07-2026 todos los mensajes de carrito salieron iguales
-- (solo texto), así que no hay con qué comparar si una imagen sube el cierre.
-- Con la prueba encendida, cada carrito que tiene foto en el espejo de
-- catálogo (`shopify_product_images`) se sortea 50/50 por su `draft_order_gid`:
-- «imagen» recibe la plantilla aprobada con cabecera de imagen y la foto del
-- producto que dejó; «control», la de siempre. Solo el mensaje 1 —el que
-- convierte más—; el mensaje 2 sale igual para los dos.
--
-- `cart_seq_sends.variant` guarda el brazo de cada envío (null = fuera de la
-- prueba: prueba apagada, mensaje 2 o carrito sin foto) e `image_url` la foto
-- que se mandó. `cart_image_test_results` lee el resultado: pedido no anulado
-- con ese teléfono en los 7 días siguientes al mensaje 1, separado por quién
-- cerró con la misma regla que «Atribución de ventas» (lib/metrics.ts).

alter table stores add column if not exists cart_seq_image_test_enabled boolean not null default false;
alter table stores add column if not exists cart_seq_image_template_1_name text;
alter table stores add column if not exists cart_seq_image_template_1_language text;
alter table stores add column if not exists cart_seq_image_test_started_at timestamptz;

alter table cart_seq_sends add column if not exists variant text;
alter table cart_seq_sends add column if not exists image_url text;

alter table cart_seq_sends drop constraint if exists cart_seq_sends_variant_check;
alter table cart_seq_sends add constraint cart_seq_sends_variant_check
  check (variant is null or variant in ('imagen', 'control'));

create index if not exists cart_seq_sends_variant_idx
  on cart_seq_sends (store_id, sent_at) where variant is not null;

comment on column stores.cart_seq_image_test_enabled is
  'Prueba A/B del mensaje 1 de carrito con la foto del producto (0233).';
comment on column stores.cart_seq_image_template_1_name is
  'Plantilla aprobada igual a la del mensaje 1 pero con cabecera de imagen.';
comment on column stores.cart_seq_image_test_started_at is
  'Cuándo se encendió la prueba: los resultados cuentan desde aquí.';
comment on column cart_seq_sends.variant is
  'Brazo de la prueba de imagen: imagen | control; null = fuera de la prueba.';

-- Resultado por brazo y por quién cerró. Un carrito = su primer envío con
-- variante; convierte si hay un pedido NO anulado con ese teléfono en los 7
-- días siguientes. Quién cerró: «asesora» si el pedido lleva venta_manual o
-- carrito_recuperado; «bot_asistido» si una asesora tocó al lead en los 7
-- días previos al pedido; si no, «bot».
create or replace function public.cart_image_test_results(p_store_id uuid, p_since timestamptz default null)
returns table (variant text, carritos bigint, convertidos bigint, bot bigint, bot_asistido bigint, asesora bigint, ventas numeric)
language sql stable
set search_path = public
as $$
  with carts as (
    select distinct on (s.draft_order_gid) s.store_id, s.phone, s.draft_order_gid, s.variant, s.sent_at t0
    from cart_seq_sends s
    where s.store_id = p_store_id and s.ok and s.touch = 1 and s.variant is not null
      and (p_since is null or s.sent_at >= p_since)
    order by s.draft_order_gid, s.sent_at
  ), conv as (
    select c.*, o.id order_id, o.created_at oc, o.tags, o.total_amount
    from carts c
    left join lateral (
      select o.* from orders o
      where o.store_id = c.store_id and o.customer_phone = c.phone and o.cancelled_at is null
        and o.created_at > c.t0 and o.created_at <= c.t0 + interval '7 days'
      order by o.created_at limit 1
    ) o on true
  ), ch as (
    select v.*,
      case when v.order_id is null then null
        when v.tags && array['venta_manual', 'carrito_recuperado'] then 'asesora'
        when exists (
          select 1 from lead_calls lc join leads l on l.id = lc.lead_id
          where l.store_id = v.store_id and l.phone = v.phone and lc.vendedora is not null
            and lc.occurred_at <= v.oc and lc.occurred_at >= v.oc - interval '7 days'
        ) then 'bot_asistido'
        else 'bot' end canal
    from conv v
  )
  select ch.variant, count(*), count(order_id),
    count(*) filter (where canal = 'bot'), count(*) filter (where canal = 'bot_asistido'),
    count(*) filter (where canal = 'asesora'), coalesce(sum(total_amount), 0)
  from ch group by ch.variant order by ch.variant;
$$;

revoke all on function public.cart_image_test_results(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.cart_image_test_results(uuid, timestamptz) to service_role;
