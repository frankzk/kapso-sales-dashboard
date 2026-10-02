-- ============================================================================
-- 0214_auto_order_trials.sql — Prueba de pedidos automáticos de recompra.
--
-- POR QUÉ (02-10-2026). Un cliente que ya recibió un pedido y arma un carrito
-- nuevo 7+ días después vuelve a la cola de llamadas (0207 / #785). La pregunta
-- del negocio es si ese carrito se puede convertir en pedido SIN llamar: el
-- formulario COD ya trae producto, cantidad y dirección. Antes de automatizarlo
-- se mide con un grupo cerrado (~30 carritos elegidos a mano) cuántos de esos
-- pedidos se entregan, contra la tasa de los pedidos de recompra normales.
--
-- CÓMO. Cada fila es UN carrito autorizado para generarse solo. El cron
-- (lib/auto-order-trials.ts, paso 1d de runStoreSync) toma las `pendiente`,
-- las vuelve a validar (lead sin gestionar, carrito abierto y vigente, sin
-- pedido posterior del mismo teléfono) y completa el borrador en Shopify sin
-- tocar precios ni productos. Si la fila trae dirección, se la pone al pedido
-- (grupo B: el carrito traía "-" y se usa la dirección donde ya se entregó).
-- Nada entra aquí solo: las filas las inserta una persona.
--
-- `auto_order_trial_results` cruza cada fila con el Master para medir.
-- ============================================================================

create table if not exists auto_order_trials (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references stores(id) on delete cascade,
  lead_id           uuid references leads(id) on delete set null,
  draft_order_gid   text not null,              -- el carrito que se completa
  draft_name        text,                       -- "#D98585", para leer la tabla
  cohort            text not null,              -- "exp-recompra-1": va como tag en Shopify
  grupo             text not null,              -- A | B | C (qué regla prueba la fila)
  -- Dirección a poner en el pedido. Toda nula = se respeta la del carrito.
  address1          text,
  referencia        text,
  district          text,
  province          text,
  status            text not null default 'pendiente',
  reason            text,                       -- por qué se omitió o falló
  order_gid         text,
  shopify_order_id  text,                       -- numérico, para cruzar con orders
  order_name        text,
  created_at        timestamptz not null default now(),
  claimed_at        timestamptz,
  processed_at      timestamptz,
  constraint auto_order_trials_status_chk
    check (status in ('pendiente', 'procesando', 'generado', 'omitido', 'error')),
  constraint auto_order_trials_grupo_chk check (grupo in ('A', 'B', 'C')),
  unique (store_id, draft_order_gid, cohort)
);
create index if not exists auto_order_trials_pending_idx
  on auto_order_trials(store_id, created_at) where status = 'pendiente';

alter table auto_order_trials enable row level security;
drop policy if exists auto_order_trials_select on auto_order_trials;
create policy auto_order_trials_select on auto_order_trials for select to authenticated
  using (store_id in (select auth_store_ids()));
-- Cada fila se convierte en un pedido real: solo el servidor escribe. Supabase
-- da por defecto INSERT/UPDATE/DELETE a anon y authenticated en las tablas
-- nuevas (ver 0213); sin política de escritura RLS ya los frena, y el revoke lo
-- deja dicho por si alguien agrega una política después.
revoke all on auto_order_trials from anon, authenticated;
grant select on auto_order_trials to authenticated;
grant all privileges on auto_order_trials to service_role;

-- Resultado por pedido. RLS del que consulta (security_invoker): cada uno ve
-- solo sus tiendas, igual que en las tablas de origen.
create or replace view auto_order_trial_results with (security_invoker = true) as
select t.cohort,
       t.grupo,
       t.store_id,
       t.draft_name,
       t.status,
       t.reason,
       t.order_name,
       t.processed_at,
       om.coverage,
       om.general_status,
       om.macro_stage,
       om.delivered_at,
       om.returned_at
  from auto_order_trials t
  left join orders o
    on o.store_id = t.store_id and o.shopify_order_id = t.shopify_order_id
  left join order_master om on om.order_id = o.id;

revoke all on auto_order_trial_results from anon, authenticated;
grant select on auto_order_trial_results to authenticated;
grant select on auto_order_trial_results to service_role;
