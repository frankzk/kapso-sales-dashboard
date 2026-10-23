-- ============================================================================
-- 0274_invoice_snapshots.sql — la foto del pedido para su boleta, por si Shopify
-- deja de responder (MOM §35.10, owner 23-10-2026).
--
-- QUÉ PASA. Shopify cierra Kenku Perú y Aurela el 28-10-2026 (UTC; se planifica
-- para el 27-10 a las 19:00 de Lima). Cada boleta vuelve a leer su pedido en
-- Shopify justo antes de emitir (`fetchOrderForInvoice`, §35.3), porque lo
-- guardado en `orders` no alcanza: descuentos, envío cobrado, impuesto y cobros
-- solo los sabe Shopify. Desde el cierre esa lectura falla siempre, y los
-- pedidos vendidos en Shopify se siguen cobrando —y facturando— después: al
-- 23-10-2026 eran 11.036 pedidos no anulados desde el 29-08 sin boleta (Kenku
-- 9.171, Aurela 1.865).
--
-- LA DECISIÓN DEL OWNER (23-10-2026): guardar ahora, mientras Shopify responde,
-- lo que esa lectura devuelve, y leer los pedidos de WooCommerce con su propio
-- lector más adelante.
--
-- QUÉ CAMBIA.
--   · `order_invoice_snapshots`: una fila por pedido de Shopify, con lo que
--     contesta ORDER_FOR_INVOICE_QUERY (lib/invoicing/shopify-order.ts) tal
--     cual (`payload` = el `data` de la respuesta: `{"order": …}`; `order` es
--     null si Shopify no lo devolvió) y cuándo se pidió (`fetched_at`). La
--     escribe el cron `/api/cron/invoice-snapshots`; la lee la boleta solo si
--     la tienda ya no tiene token o Shopify contesta por ella que ya no está.
--   · `invoice_snapshot_candidates(p_store, p_since, p_limit)`: qué pedidos le
--     faltan. Uno de Shopify (`orders.platform`, 0273) de esa tienda, creado
--     desde `p_since` y sin comprobante real vivo, que no tiene foto y no está
--     anulado, o que tiene una foto anterior a su último cambio en Shopify
--     (`orders.updated_at`). Primero los que no tienen foto; entre ellos,
--     primero los que siguen en curso (su macroetapa no es «Finalizado»); y
--     del más nuevo al más viejo.
--   · `invoice_snapshot_put(...)`: guarda una foto solo si el pedido es de
--     Shopify, de esa tienda y con ese gid, y nunca pisa una foto más nueva con
--     una más vieja. Dos pasadas que se cruzan dejan la más reciente.
--
-- A QUIÉN NO. No toca ninguna fila de otra tabla ni cambia nada de lo que hoy
-- hace Kapta con Shopify: con Shopify funcionando, la boleta se sigue leyendo en
-- vivo y la foto no se mira. Un pedido de WooCommerce nunca tiene foto: la base
-- no la guarda y la boleta no la usa. Todo lo lee y lo escribe solo el
-- servidor (service_role), como `order_invoices`.
--
-- REQUIERE la 0257 (comprobantes) y la 0273 (`orders.platform`): se detiene
-- sin ellas, antes de crear nada.
--
-- Se aplica a mano ANTES del código (DEPLOY.md, entrada del 23-10-2026). Es
-- idempotente: correrla otra vez no cambia nada.
-- ============================================================================

do $$
begin
  if to_regclass('public.order_invoices') is null then
    raise exception '0274: falta la 0257 (order_invoices). Aplicar las migraciones de comprobantes primero.';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'orders' and column_name = 'platform'
  ) then
    raise exception '0274: falta la 0273 (orders.platform). Aplicar la 0273 primero.';
  end if;
end $$;

-- ── 1. Las fotos ─────────────────────────────────────────────────────────────
create table if not exists order_invoice_snapshots (
  order_id          uuid primary key references orders(id) on delete cascade,
  store_id          uuid not null references stores(id) on delete cascade,
  shopify_order_gid text not null
                      check (shopify_order_gid ~ '^gid://shopify/Order/[0-9]+$'),
  -- El `data` de la respuesta tal cual: `{"order": {…}}`, o `{"order": null}`
  -- si Shopify no devolvió el pedido.
  payload           jsonb not null
                      check (jsonb_typeof(payload) = 'object' and payload ? 'order'
                             and jsonb_typeof(payload->'order') in ('object', 'null')),
  fetched_at        timestamptz not null
);

create unique index if not exists order_invoice_snapshots_store_gid_uniq
  on order_invoice_snapshots (store_id, shopify_order_gid);

comment on table order_invoice_snapshots is
  'MOM §35.10 (owner 23-10-2026): lo que contestó ORDER_FOR_INVOICE_QUERY para un pedido de Shopify, guardado mientras Shopify respondía. La boleta lo usa solo si la tienda ya no tiene token o Shopify contesta 401/402/403/404/423 por ella. Solo service_role.';
comment on column order_invoice_snapshots.payload is
  'El data de la respuesta de ORDER_FOR_INVOICE_QUERY tal cual: {"order": …}; order es null si Shopify no devolvió el pedido. Sin datos de la clienta: la consulta no los pide.';
comment on column order_invoice_snapshots.fetched_at is
  'Cuándo se pidió a Shopify (el inicio de la llamada). Una foto anterior a orders.updated_at se vuelve a tomar.';

-- ── 2. Solo el servidor ──────────────────────────────────────────────────────
alter table order_invoice_snapshots enable row level security;
revoke all on order_invoice_snapshots from anon, authenticated;
grant all privileges on order_invoice_snapshots to service_role;

-- ── 3. Qué pedidos les falta su foto ─────────────────────────────────────────
-- Entra un pedido de la tienda `p_store` que:
--   · es de Shopify según `orders.platform` (0273), con su id numérico de
--     Shopify (no `manual-…` ni `wc-…`);
--   · se creó desde `p_since` (el cron manda el 29-08-2026 00:00 UTC: el cierre
--     menos los 60 días que mira el barrido de boletas, `invoice_candidates`,
--     0260). Sin `p_since`, nada;
--   · no tiene comprobante real vivo (emitiendo, emitida, en duda o externa);
--   · no tiene foto y no está anulado, o tiene una foto anterior a su último
--     cambio en Shopify: así la foto queda con lo último que dijo Shopify.
-- Primero los que no tienen foto; después, primero los que siguen en curso
-- (sin macroetapa o con una que no es «Finalizado»); y del más nuevo al más
-- viejo, a lo más `p_limit`.
create or replace function invoice_snapshot_candidates(
  p_store uuid,
  p_since timestamptz,
  p_limit integer
) returns table (order_id uuid, shopify_order_id text, refresh boolean)
language sql stable security invoker set search_path = public as $$
  select o.id, o.shopify_order_id, (s.order_id is not null) as refresh
  from orders o
  left join order_invoice_snapshots s on s.order_id = o.id
  left join order_master m on m.order_id = o.id
  where o.store_id = p_store
    and o.platform = 'shopify'
    and o.shopify_order_id ~ '^[0-9]+$'
    and o.created_at >= p_since
    and not exists (
      select 1 from order_invoices i
      where i.order_id = o.id and i.mode = 'real'
        and i.status in ('emitiendo', 'emitida', 'en_duda', 'externa')
    )
    and (
      (s.order_id is null and o.cancelled_at is null)
      or (s.order_id is not null and o.updated_at > s.fetched_at)
    )
  order by (s.order_id is not null),
           (m.macro_stage is not distinct from 'finalizado'),
           o.created_at desc,
           o.id
  limit greatest(coalesce(p_limit, 0), 0)
$$;
revoke all on function invoice_snapshot_candidates(uuid, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function invoice_snapshot_candidates(uuid, timestamptz, integer)
  to service_role;

-- ── 4. Guardar una foto ──────────────────────────────────────────────────────
-- true si la guardó. false, sin escribir nada, si el pedido no es de Shopify
-- (`orders.platform`), no es de esa tienda, el gid no es el suyo, la respuesta
-- no tiene la forma de arriba o trae otro pedido, la hora no se entiende, o ya
-- hay una foto igual de nueva o más.
create or replace function invoice_snapshot_put(
  p_order uuid,
  p_store uuid,
  p_gid text,
  p_payload jsonb,
  p_fetched_at timestamptz
) returns boolean
language plpgsql security invoker set search_path = public as $$
begin
  if p_fetched_at is null or p_fetched_at > now() + interval '5 minutes' then
    return false;
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or not (p_payload ? 'order')
     or jsonb_typeof(p_payload->'order') not in ('object', 'null') then
    return false;
  end if;
  -- Un pedido que Shopify devolvió tiene que ser este.
  if jsonb_typeof(p_payload->'order') = 'object' and (p_payload->'order'->>'id') is distinct from p_gid then
    return false;
  end if;
  if not exists (
    select 1 from orders o
     where o.id = p_order
       and o.store_id = p_store
       and o.platform = 'shopify'
       and o.shopify_order_id ~ '^[0-9]+$'
       and p_gid = 'gid://shopify/Order/' || o.shopify_order_id
  ) then
    return false;
  end if;

  insert into order_invoice_snapshots as s (order_id, store_id, shopify_order_gid, payload, fetched_at)
  values (p_order, p_store, p_gid, p_payload, p_fetched_at)
  on conflict (order_id) do update
     set store_id          = excluded.store_id,
         shopify_order_gid = excluded.shopify_order_gid,
         payload           = excluded.payload,
         fetched_at        = excluded.fetched_at
   where s.fetched_at < excluded.fetched_at;
  return found;
end $$;
revoke all on function invoice_snapshot_put(uuid, uuid, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function invoice_snapshot_put(uuid, uuid, text, jsonb, timestamptz)
  to service_role;
