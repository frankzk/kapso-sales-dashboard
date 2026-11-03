-- ============================================================================
-- 0275_invoice_snapshots.sql — la foto del pedido para su boleta, por si Shopify
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
--     faltan. Uno de Shopify (`orders.platform`, 0274) de esa tienda, creado
--     desde `p_since` y sin comprobante real vivo, que no tiene foto y no está
--     anulado, o que tiene una foto anterior a su último cambio en Shopify
--     (`orders.updated_at`). Primero los que no tienen foto; entre ellos, los
--     que nunca fallaron antes que los que fallaron (`invoice_snapshot_attempts`);
--     después, primero los que siguen en curso (su macroetapa no es
--     «Finalizado»); y del más nuevo al más viejo. Un pedido que falló espera
--     2 minutos por cada falla seguida (30 como mucho) antes de volver.
--   · `invoice_snapshot_put(...)`: guarda una foto solo si el pedido es de
--     Shopify, de esa tienda y con ese gid, y nunca pisa una foto más nueva con
--     una más vieja. Dos pasadas que se cruzan dejan la más reciente. Tampoco
--     pisa una foto CON pedido con una que dice que Shopify no lo devolvió
--     (`{"order": null}`): la buena es la que sirve para la boleta. Al
--     guardar, borra las fallas anotadas del pedido.
--   · `invoice_snapshot_attempts` + `invoice_snapshot_failed(...)`: las fallas
--     seguidas de cada pedido (cuántas, cuándo la última y por qué, en corto y
--     sin nada de la respuesta). Un pedido que Shopify no puede leer no tapa la
--     cola de su tienda: va detrás. La función dice cuántos llegaron a
--     `p_alert` fallas seguidas (el cron se pone rojo).
--   · `invoice_snapshot_leases` + `invoice_snapshot_lease(...)` /
--     `invoice_snapshot_release(...)`: el turno de cada tienda. Dos pasadas a la
--     vez sobre la misma tienda gastarían dos veces su cupo de Shopify.
--
-- A QUIÉN NO. No toca ninguna fila de otra tabla ni cambia nada de lo que hoy
-- hace Kapta con Shopify: con Shopify funcionando, la boleta se sigue leyendo en
-- vivo y la foto no se mira. Un pedido de WooCommerce nunca tiene foto: la base
-- no la guarda y la boleta no la usa. Todo lo lee y lo escribe solo el
-- servidor (service_role), como `order_invoices`.
--
-- REQUIERE la 0257 (comprobantes) y la 0274 (`orders.platform`): se detiene
-- sin ellas, antes de crear nada.
--
-- Se aplica a mano ANTES del código (DEPLOY.md, entrada del 23-10-2026), con
-- psql en modo autocommit (cada sentencia en su propia transacción) y
-- `lock_timeout` de 3 s: crear las llaves foráneas de la tabla de fotos toma un
-- momento un candado de `orders` y `stores` que frena las escrituras (los
-- webhooks hacen cola), y así se suelta al terminar esa sentencia, no al final
-- del archivo. Las tablas nuevas de fallas y turnos no tienen llaves foráneas:
-- no tocan ningún candado de otra tabla. Es idempotente: correrla otra vez no
-- cambia nada, y si una sentencia se corta, volver a correrla entera termina
-- el trabajo.
-- ============================================================================

do $$
begin
  if to_regclass('public.order_invoices') is null then
    raise exception '0275: falta la 0257 (order_invoices). Aplicar las migraciones de comprobantes primero.';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'orders' and column_name = 'platform'
  ) then
    raise exception '0275: falta la 0274 (orders.platform). Aplicar la 0274 primero.';
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

-- ── 2. Las fallas de cada pedido y el turno de cada tienda ──────────────────
-- Sin llaves foráneas a propósito: crearlas tomaría otra vez el candado de
-- `orders` y `stores`. Una fila de un pedido borrado no estorba: solo se lee
-- unida a `orders`.
create table if not exists invoice_snapshot_attempts (
  order_id        uuid primary key,
  store_id        uuid not null,
  fail_count      integer not null check (fail_count > 0),
  last_attempt_at timestamptz not null,
  -- Por qué, en corto y sin nada de la respuesta («Shopify contestó HTTP 503.»).
  last_error      text check (last_error is null or length(last_error) <= 200)
);

create table if not exists invoice_snapshot_leases (
  store_id uuid primary key,
  holder   uuid not null,
  until    timestamptz not null
);

comment on table invoice_snapshot_attempts is
  'MOM §35.10: fallas seguidas de la foto de un pedido (lo que Shopify no pudo contestar de ESE pedido, o lo que estaba en vuelo cuando la tienda falló). Ordena la lista de invoice_snapshot_candidates para que un pedido que falla no tape la cola. Se borra al guardar su foto. Solo service_role.';
comment on table invoice_snapshot_leases is
  'MOM §35.10: el turno de cada tienda en el cron invoice-snapshots; vence solo (until) si la pasada muere sin soltarlo. Solo service_role.';

-- ── 3. Solo el servidor ──────────────────────────────────────────────────────
alter table order_invoice_snapshots enable row level security;
revoke all on order_invoice_snapshots from anon, authenticated;
grant all privileges on order_invoice_snapshots to service_role;
alter table invoice_snapshot_attempts enable row level security;
revoke all on invoice_snapshot_attempts from anon, authenticated;
grant all privileges on invoice_snapshot_attempts to service_role;
alter table invoice_snapshot_leases enable row level security;
revoke all on invoice_snapshot_leases from anon, authenticated;
grant all privileges on invoice_snapshot_leases to service_role;

-- ── 4. Qué pedidos les falta su foto ─────────────────────────────────────────
-- Entra un pedido de la tienda `p_store` que:
--   · es de Shopify según `orders.platform` (0274), con su id numérico de
--     Shopify (no `manual-…` ni `wc-…`);
--   · se creó desde `p_since` (el cron manda el 29-08-2026 00:00 UTC: el cierre
--     menos los 60 días que mira el barrido de boletas, `invoice_candidates`,
--     0260). Sin `p_since`, nada;
--   · no tiene comprobante real vivo (emitiendo, emitida, en duda o externa);
--   · no tiene foto y no está anulado, o tiene una foto anterior a su último
--     cambio en Shopify: así la foto queda con lo último que dijo Shopify;
--   · si falló antes, ya esperó 2 minutos por cada falla seguida (30 como
--     mucho) desde la última.
-- Primero los que no tienen foto; después, los que fallaron menos veces
-- seguidas (los que nunca fallaron, primero: uno que siempre falla no tapa la
-- cola); después, primero los que siguen en curso (sin macroetapa o con una que
-- no es «Finalizado»); y del más nuevo al más viejo, a lo más `p_limit`.
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
  left join invoice_snapshot_attempts a on a.order_id = o.id
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
    and (
      a.order_id is null
      or a.last_attempt_at <= now() - least(a.fail_count * interval '2 minutes', interval '30 minutes')
    )
  order by (s.order_id is not null),
           coalesce(a.fail_count, 0),
           (m.macro_stage is not distinct from 'finalizado'),
           o.created_at desc,
           o.id
  limit greatest(coalesce(p_limit, 0), 0)
$$;
revoke all on function invoice_snapshot_candidates(uuid, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function invoice_snapshot_candidates(uuid, timestamptz, integer)
  to service_role;

-- ── 5. Guardar una foto ──────────────────────────────────────────────────────
-- true si la guardó. false, sin escribir nada, si el pedido no es de Shopify
-- (`orders.platform`), no es de esa tienda, el gid no es el suyo, la respuesta
-- no tiene la forma de arriba o trae otro pedido, la hora no se entiende, ya
-- hay una foto igual de nueva o más, o la que hay trae el pedido y la nueva
-- dice que Shopify no lo devolvió (`{"order": null}`): una foto buena nunca se
-- pierde por una lectura que no lo trajo. Si la guardó, borra las fallas
-- anotadas del pedido.
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
   where s.fetched_at < excluded.fetched_at
     and not (jsonb_typeof(s.payload->'order') = 'object'
              and jsonb_typeof(excluded.payload->'order') = 'null');
  if not found then
    return false;
  end if;
  -- Ya tiene foto: sus fallas anteriores no cuentan más.
  delete from invoice_snapshot_attempts where order_id = p_order;
  return true;
end $$;
revoke all on function invoice_snapshot_put(uuid, uuid, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function invoice_snapshot_put(uuid, uuid, text, jsonb, timestamptz)
  to service_role;

-- ── 6. Anotar las fallas de unos pedidos ────────────────────────────────────
-- Suma una falla seguida a cada pedido de `p_orders` que sea de la tienda
-- `p_store` (los de otra tienda no se tocan), con la hora y el motivo en corto.
-- Devuelve cuántos de ellos llegaron a `p_alert` fallas seguidas o más.
create or replace function invoice_snapshot_failed(
  p_store uuid,
  p_orders uuid[],
  p_detail text,
  p_alert integer
) returns integer
language plpgsql security invoker set search_path = public as $$
declare
  v_alert integer;
begin
  with mine as (
    select o.id from orders o
     where o.store_id = p_store and o.id = any(coalesce(p_orders, '{}'::uuid[]))
  ), up as (
    insert into invoice_snapshot_attempts as a (order_id, store_id, fail_count, last_attempt_at, last_error)
    select m.id, p_store, 1, now(), left(p_detail, 200) from mine m
    on conflict (order_id) do update
       set store_id        = excluded.store_id,
           fail_count      = a.fail_count + 1,
           last_attempt_at = excluded.last_attempt_at,
           last_error      = excluded.last_error
    returning a.fail_count
  )
  select count(*) filter (where fail_count >= greatest(coalesce(p_alert, 1), 1)) into v_alert from up;
  return coalesce(v_alert, 0);
end $$;
revoke all on function invoice_snapshot_failed(uuid, uuid[], text, integer)
  from public, anon, authenticated;
grant execute on function invoice_snapshot_failed(uuid, uuid[], text, integer)
  to service_role;

-- ── 7. El turno de una tienda ───────────────────────────────────────────────
-- true si `p_holder` se quedó con el turno de `p_store` por `p_seconds`
-- segundos (estaba libre, vencido o ya era suyo); false si otra pasada lo tiene.
create or replace function invoice_snapshot_lease(
  p_store uuid,
  p_holder uuid,
  p_seconds integer
) returns boolean
language plpgsql security invoker set search_path = public as $$
begin
  if p_store is null or p_holder is null or coalesce(p_seconds, 0) <= 0 then
    return false;
  end if;
  insert into invoice_snapshot_leases as l (store_id, holder, until)
  values (p_store, p_holder, now() + make_interval(secs => p_seconds))
  on conflict (store_id) do update
     set holder = excluded.holder,
         until  = excluded.until
   where l.until < now() or l.holder = excluded.holder;
  return found;
end $$;
revoke all on function invoice_snapshot_lease(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function invoice_snapshot_lease(uuid, uuid, integer)
  to service_role;

-- Suelta el turno, solo si es de `p_holder`.
create or replace function invoice_snapshot_release(
  p_store uuid,
  p_holder uuid
) returns void
language sql security invoker set search_path = public as $$
  delete from invoice_snapshot_leases where store_id = p_store and holder = p_holder
$$;
revoke all on function invoice_snapshot_release(uuid, uuid)
  from public, anon, authenticated;
grant execute on function invoice_snapshot_release(uuid, uuid)
  to service_role;
