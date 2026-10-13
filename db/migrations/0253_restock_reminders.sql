-- ============================================================================
-- 0253_restock_reminders.sql — recordatorio de reposición (MOM §34,
-- 13-10-2026).
--
-- QUÉ ES. Cuando a la clienta se le está por acabar lo que compró, se le manda
-- una plantilla de WhatsApp con un botón «Sí, quiero». Si lo toca, una asesora
-- la atiende: el lead sube a «Atender ahora» con lo que quiere reponer. El dueño
-- lo pidió para subir el LTV (§17.2): la recompra del mismo producto era baja
-- —4,5 % en el aceite de semilla negra, que vuelve a los ~46 días—.
--
-- CUÁNDO. Cada producto tiene sus días por unidad (`restock_products`): un
-- frasco de 30 días, comprado en dos unidades, dura 60. El recordatorio sale
-- unos días antes de que se acabe (`restock_days_before`), contados desde la
-- entrega. Un producto sin días no recibe recordatorio: así una cartera o un
-- pelador nunca reciben «se te está acabando».
--
-- A QUIÉN NO. A quien ya volvió a comprar después de esa entrega; a quien ya se
-- le recordó ese pedido; a quien pidió que no le escriban. Y a un grupo de
-- control (`restock_control_pct`, 10 % por defecto, elegido por el teléfono):
-- se registra igual pero no se le envía, para saber si el recordatorio vende o
-- si la clienta iba a volver igual.
--
-- Nace APAGADO por tienda. Escribe solo el servidor; las tablas se leen por
-- tienda.
-- ============================================================================

alter table stores
  add column if not exists restock_enabled boolean not null default false,
  add column if not exists restock_template_name text,
  add column if not exists restock_template_language text not null default 'es',
  add column if not exists restock_params text not null default 'nombre,producto',
  add column if not exists restock_phone_number_id text,
  add column if not exists restock_button_label text not null default 'Sí, quiero',
  add column if not exists restock_hour_start integer not null default 9
    check (restock_hour_start between 0 and 23),
  add column if not exists restock_hour_end integer not null default 20
    check (restock_hour_end between 1 and 24),
  add column if not exists restock_pace_count integer not null default 5
    check (restock_pace_count between 1 and 25),
  add column if not exists restock_pace_minutes integer not null default 20
    check (restock_pace_minutes between 5 and 1440),
  add column if not exists restock_days_before integer not null default 7
    check (restock_days_before between 0 and 60),
  add column if not exists restock_control_pct integer not null default 10
    check (restock_control_pct between 0 and 50);

-- Cuánto dura cada producto. La clave es el `product_id` de Shopify de la línea
-- del pedido (o el título, si la línea no lo trae). `short_name` es como se
-- nombra en el mensaje: el título de Shopify suele ser una frase entera.
create table if not exists restock_products (
  store_id uuid not null references stores(id) on delete cascade,
  product_key text not null,
  shopify_title text not null,
  short_name text not null check (length(btrim(short_name)) > 0),
  days_per_unit integer not null check (days_per_unit between 1 and 365),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (store_id, product_key)
);

-- Un registro por pedido recordado (o apartado como control) y por intento
-- fallido. `ok` es «quedó atendido»: el envío aceptado o la fila de control.
create table if not exists restock_sends (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  phone text not null,
  product_key text not null,
  product_name text not null,
  units integer not null,
  due_at timestamptz not null,
  arm text not null check (arm in ('enviado', 'control')),
  template_name text,
  ok boolean not null,
  error text,
  sent_at timestamptz not null default now(),
  replied_at timestamptz,
  reply_kind text check (reply_kind in ('boton', 'si'))
);

create unique index if not exists restock_sends_order_ok on restock_sends (order_id) where ok;
create index if not exists restock_sends_store_phone on restock_sends (store_id, phone, sent_at desc);
create index if not exists restock_sends_store_sent on restock_sends (store_id, sent_at desc);

-- Quien respondió «BAJA» a un recordatorio. No hace falta que tenga lead: muchas
-- compraron por la web y nunca escribieron.
create table if not exists contact_opt_outs (
  store_id uuid not null references stores(id) on delete cascade,
  phone text not null,
  source text not null,
  created_at timestamptz not null default now(),
  primary key (store_id, phone)
);

alter table restock_products enable row level security;
alter table restock_sends enable row level security;
alter table contact_opt_outs enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'restock_products' and policyname = 'restock_products_select') then
    create policy restock_products_select on restock_products for select to authenticated
      using (store_id in (select auth_store_ids()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'restock_sends' and policyname = 'restock_sends_select') then
    create policy restock_sends_select on restock_sends for select to authenticated
      using (store_id in (select auth_store_ids()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'contact_opt_outs' and policyname = 'contact_opt_outs_select') then
    create policy contact_opt_outs_select on contact_opt_outs for select to authenticated
      using (store_id in (select auth_store_ids()));
  end if;
end $$;

revoke all on restock_products, restock_sends, contact_opt_outs from anon, authenticated;
grant select on restock_products, restock_sends, contact_opt_outs to authenticated;
grant all privileges on restock_products, restock_sends, contact_opt_outs to service_role;

-- Las líneas de pedido traen el `product_id` de Shopify, pero las que arma el
-- bot como línea suelta traen solo el título: en Aurela, el pelador aparece 371
-- veces con id y 89 sin él. Un producto se configura UNA vez (por su id) y se le
-- reconoce también por su título; si no, la mitad de sus clientas no recibiría
-- el recordatorio.
create or replace function public.restock_line_matches(
  p_key text,
  p_title text,
  p_line_id text,
  p_line_title text
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select (p_line_id is not null and p_key = p_line_id)
      or (p_line_title is not null and (p_key = p_line_title
          or lower(btrim(p_title)) = lower(btrim(p_line_title))));
$$;

-- Los pedidos entregados cuyo producto se acaba ahora: el recordatorio vence
-- (entrega + unidades × días por unidad − días antes) dentro de la ventana, la
-- clienta no volvió a comprar después de esa entrega y el pedido no tiene ya su
-- recordatorio. Por pedido, el producto que se acaba primero.
create or replace function public.restock_candidates(
  p_store_id uuid,
  p_now timestamptz,
  p_days_before integer,
  p_window_days integer,
  p_limit integer
)
returns table (
  order_id uuid,
  order_name text,
  customer_name text,
  customer_phone text,
  delivered_at timestamptz,
  product_key text,
  product_name text,
  units integer,
  due_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  with lineas as (
    select om.order_id, om.order_name, om.customer_name, om.customer_phone, om.delivered_at,
           nullif(li->>'product_id', '') as line_id,
           nullif(btrim(li->>'title'), '') as line_title,
           greatest(coalesce((li->>'quantity')::numeric::integer, 1), 1) as qty
      from public.order_master om
      join public.orders o on o.id = om.order_id
     cross join lateral jsonb_array_elements(
             case when jsonb_typeof(o.line_items) = 'array' then o.line_items else '[]'::jsonb end) li
     where om.store_id = p_store_id
       and om.general_status = 'entregado'
       and om.delivered_at is not null
       and om.delivered_at < p_now
       and om.delivered_at > p_now - interval '400 days'
       and om.customer_phone is not null
  ), por_producto as (
    select l.order_id, l.order_name, l.customer_name, l.customer_phone, l.delivered_at,
           rp.product_key, rp.short_name, rp.days_per_unit, sum(l.qty)::integer as units
      from lineas l
      -- Una línea, un producto: si dos filas la reconocen, gana la del id.
      join lateral (
        select r.product_key, r.short_name, r.days_per_unit
          from public.restock_products r
         where r.store_id = p_store_id
           and public.restock_line_matches(r.product_key, r.shopify_title, l.line_id, l.line_title)
         order by (r.product_key = l.line_id) desc nulls last
         limit 1
      ) rp on true
     group by l.order_id, l.order_name, l.customer_name, l.customer_phone, l.delivered_at,
              rp.product_key, rp.short_name, rp.days_per_unit
  ), vencen as (
    -- La ventana va ANTES de elegir el producto: si el pedido trae dos y el que
    -- se acabó primero ya quedó atrás, el otro igual tiene su recordatorio.
    select p.*, p.delivered_at + make_interval(days => p.units * p.days_per_unit - p_days_before) as vence
      from por_producto p
  ), primero as (
    select distinct on (v.order_id) v.*
      from vencen v
     where v.vence <= p_now
       and v.vence > p_now - make_interval(days => p_window_days)
     order by v.order_id, v.vence
  )
  select f.order_id, f.order_name, f.customer_name, f.customer_phone, f.delivered_at,
         f.product_key, f.short_name, f.units, f.vence
    from primero f
   where not exists (
       select 1 from public.order_master o2
        where o2.store_id = p_store_id
          and o2.customer_phone = f.customer_phone
          and o2.order_id <> f.order_id
          and o2.order_created_at > f.delivered_at
          and o2.general_status <> 'anulado')
     and not exists (select 1 from public.restock_sends s where s.order_id = f.order_id and s.ok)
   order by f.vence desc
   limit p_limit;
$$;

revoke all on function public.restock_candidates(uuid, timestamptz, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.restock_candidates(uuid, timestamptz, integer, integer, integer) to service_role;

-- Lo que se vendió en los últimos días, por producto, para elegir en Ajustes
-- cuáles reciben recordatorio. Las líneas sin id se suman al producto con id
-- del mismo título.
create or replace function public.restock_product_catalog(p_store_id uuid, p_since timestamptz)
returns table (product_key text, title text, pedidos integer, unidades integer)
language sql
stable
security invoker
set search_path = public
as $$
  with lineas as (
    select o.id as order_id,
           nullif(li->>'product_id', '') as line_id,
           nullif(btrim(li->>'title'), '') as line_title,
           greatest(coalesce((li->>'quantity')::numeric::integer, 1), 1) as qty
      from public.orders o
     cross join lateral jsonb_array_elements(
             case when jsonb_typeof(o.line_items) = 'array' then o.line_items else '[]'::jsonb end) li
     where o.store_id = p_store_id
       and o.created_at >= p_since
  ), id_por_titulo as (
    select distinct on (lower(line_title)) lower(line_title) as t, line_id
      from lineas
     where line_id is not null and line_title is not null
     group by lower(line_title), line_id
     order by lower(line_title), count(*) desc
  )
  select coalesce(l.line_id, i.line_id, l.line_title) as product_key,
         mode() within group (order by l.line_title) as title,
         count(distinct l.order_id)::integer,
         sum(l.qty)::integer
    from lineas l
    left join id_por_titulo i on l.line_id is null and i.t = lower(l.line_title)
   where coalesce(l.line_id, l.line_title) is not null
   group by 1
   order by 3 desc
   limit 80;
$$;

revoke all on function public.restock_product_catalog(uuid, timestamptz) from public, anon;
grant execute on function public.restock_product_catalog(uuid, timestamptz) to authenticated, service_role;

-- Lo que se lee en Ajustes: por grupo, cuántas clientas, cuántas respondieron
-- y cuántas compraron (y recibieron) en los 30 días siguientes.
create or replace function public.restock_results(p_store_id uuid, p_since timestamptz)
returns table (arm text, clientas integer, respondieron integer, compraron integer, entregados integer)
language sql
stable
security invoker
set search_path = public
as $$
  select s.arm,
         count(*)::integer,
         (count(*) filter (where s.replied_at is not null))::integer,
         (count(*) filter (where exists (
            select 1 from public.order_master o
             where o.store_id = s.store_id and o.customer_phone = s.phone
               and o.order_id <> s.order_id
               and o.order_created_at between s.sent_at and s.sent_at + interval '30 days'
               and o.general_status <> 'anulado')))::integer,
         (count(*) filter (where exists (
            select 1 from public.order_master o
             where o.store_id = s.store_id and o.customer_phone = s.phone
               and o.order_id <> s.order_id
               and o.order_created_at between s.sent_at and s.sent_at + interval '30 days'
               and o.general_status = 'entregado')))::integer
    from public.restock_sends s
   where s.store_id = p_store_id and s.ok and s.sent_at >= p_since
   group by s.arm;
$$;

revoke all on function public.restock_results(uuid, timestamptz) from public, anon;
grant execute on function public.restock_results(uuid, timestamptz) to authenticated, service_role;
