-- 0199_gf_dispatch_programs.sql — programar la salida de un pedido de Lima
-- sin tomarlo (MOM §29.6 y §29.13; decisión de Frankz, 29-09-2026).
--
-- «Si quiero dejar un pedido programado para otro día, o para un día en
-- especial, cuando llegue ese día ¿cómo sé cuál es la lista de los
-- programados?» Hasta aquí el calendario de Despacho del día TOMABA el pedido
-- para guardar la fecha (la fecha vivía en `logistics_requests.scheduled_for`)
-- y nada lo volvía a listar ese día. El 28-09 #KP137430 se retiró de la caja
-- de Yhoni con «Es para el 2/10» y la fecha quedó solo en ese texto.
--
-- Programar ahora solo GUARDA LA FECHA: el pedido sigue disponible, sin
-- reservar tarifa ni salida. Ese día aparece en «Programados hoy», el primer
-- apartado de la cola. Una fila por pedido: la última programación manda y el
-- historial queda en `order_events` (`dispatch_programmed`,
-- `dispatch_program_cleared`, `dispatch_program_overridden`). Siempre con
-- actor y motivo (§29.6).
--
-- La fila se borra cuando el pedido entra en la caja de un motorizado: la
-- programación ya se cumplió. Si entra en la caja de OTRO día, la pantalla
-- avisa y pide confirmar antes; lo confirmado queda como
-- `dispatch_program_overridden`.

create table if not exists gf_dispatch_programs (
  order_id      uuid primary key references orders(id) on delete cascade,
  store_id      uuid not null references stores(id) on delete cascade,
  scheduled_for date not null,
  reason        text not null check (char_length(btrim(reason)) between 3 and 200),
  set_by        uuid references auth.users(id) on delete set null,
  set_at        timestamptz not null default now()
);

create index if not exists gf_dispatch_programs_store_day_idx
  on gf_dispatch_programs(store_id, scheduled_for);

comment on table gf_dispatch_programs is
  'Fecha de salida programada de un pedido de Lima en Despacho del día, sin tomarlo. Se borra al entrar en una caja.';

alter table gf_dispatch_programs enable row level security;
drop policy if exists gf_dispatch_programs_select on gf_dispatch_programs;
create policy gf_dispatch_programs_select on gf_dispatch_programs for select to authenticated
  using (store_id in (select auth_store_ids()));
grant select on gf_dispatch_programs to authenticated;
grant all privileges on gf_dispatch_programs to service_role;

-- ── ¿Salió a reparto alguna vez? ────────────────────────────────────────────
-- «Cómo sé cuáles pedidos no han salido ni una sola vez, versus los que han
-- salido alguna vez.» La chapa «salida previa» leía `shipments.dispatched_at`,
-- que ningún pedido de la cola tenía: Grupo GF no lo llena y
-- `gf_return_to_office` lo vuelve a null. Medido el 29-09-2026: 0 de 1.863.
--
-- Una salida a reparto es, por pedido y cualquiera sea el courier:
--   · en `order_events`: «Lo llevo» (`pickup_checked`), el reporte en la
--     puerta (`stop_reported`), el paquete recibido de vuelta en oficina
--     (`returned_to_office`) o entregado sin «Lo llevo»
--     (`delivered_unconfirmed_pickup`). `custody_transferred` NO: en el modo
--     «confirmar» la custodia pasa al asignar, antes de que el paquete salga;
--   · una parada reportada de las rutas anteriores a Grupo GF;
--   · una salida de otro courier con `dispatched_at`.
-- Crear o anular un rótulo no es salir (§29.2). La lista de eventos es
-- `DEPARTURE_EVENT_KINDS` (lib/dispatch-day.ts): se cambian juntas.
--
-- Una sola llamada para toda la cola (~1.900 pedidos): por lotes de 100 eran
-- ~60 consultas en serie al abrir Despacho del día. SECURITY INVOKER: con un
-- usuario, las políticas de cada tabla siguen mandando.
create or replace function public.gf_order_departures(p_order_ids uuid[])
returns table(order_id uuid, last_departure_at timestamptz)
language sql stable set search_path = public as $$
  select x.order_id, max(x.at) as last_departure_at
  from (
    select e.order_id, e.occurred_at as at
      from order_events e
     where e.order_id = any(p_order_ids)
       and e.kind in ('pickup_checked', 'stop_reported', 'returned_to_office', 'delivered_unconfirmed_pickup')
    union all
    select d.order_id, d.reported_at
      from delivery_stops d
     where d.order_id = any(p_order_ids)
       and d.reported_at is not null
    union all
    select s.order_id, s.dispatched_at
      from shipments s
     where s.order_id = any(p_order_ids)
       and s.dispatched_at is not null
  ) x
  group by x.order_id
$$;

revoke all on function public.gf_order_departures(uuid[]) from public, anon;
grant execute on function public.gf_order_departures(uuid[]) to authenticated, service_role;
