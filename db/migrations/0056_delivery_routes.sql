-- 0056 — Rutas de reparto: el motorizado propio reporta desde su teléfono.
--
-- Hasta ahora la liquidación se RECONSTRUÍA a posteriori, leyendo una hoja o un
-- cuaderno (0054/0055). Con motorizados propios se puede hacer al revés: que la
-- entrega se declare en el momento y la liquidación caiga sola al cerrar el día.
-- La carga por archivo sigue viva para los couriers externos, que es donde no
-- hay más remedio.
--
-- Cuatro decisiones gobiernan el diseño:
--
--   1. EL MOTORIZADO ES UN USUARIO DE VERDAD, no un enlace con token. Entra con
--      el mismo correo y enlace mágico que el equipo, y `riders.user_id` lo ata
--      a su ficha. Así el acceso se revoca como cualquier otro y no hay una
--      segunda autenticación casera que mantener y auditar.
--
--   2. SOLO VE SUS PARADAS, y lo garantiza la base, no la interfaz. Las
--      políticas de abajo filtran por `riders.user_id = auth.uid()`: aunque
--      alguien manipule la petición, no existe una consulta que le devuelva la
--      ruta de otro.
--
--   3. LO QUE REPORTA ES UNA DECLARACIÓN, no la verdad. Escribe en la parada,
--      NO en el Master. El pedido lo sigue moviendo el flujo de siempre, y el
--      cuadre compara ambos — igual que con la hoja de un courier. Un motorizado
--      que marca "entregado" no cierra un pedido por su cuenta.
--
--   4. UNA PARADA REPORTADA NO SE BORRA. Se puede corregir, y cada corrección
--      queda con su autor y su hora. Es dinero: hace falta saber quién dijo qué.

-- ----------------------------------------------------------------------------
-- El motorizado entra al sistema.
-- ----------------------------------------------------------------------------

alter table memberships drop constraint if exists memberships_role_check;
alter table memberships add constraint memberships_role_check
  check (role in ('owner', 'admin', 'viewer', 'vendedora', 'motorizado'));

-- Ata la ficha del motorizado (0054) con su usuario. Nulo = todavía no tiene
-- acceso a la web; se le da de alta y liquida igual.
alter table riders
  add column if not exists user_id uuid references auth.users(id) on delete set null;

create unique index if not exists riders_user_idx
  on riders(user_id) where user_id is not null;

comment on column riders.user_id is
  'Usuario con el que entra a /reparto. Nulo = no reporta desde la web.';

-- ----------------------------------------------------------------------------
-- La ruta del día.
-- ----------------------------------------------------------------------------

create table if not exists delivery_routes (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  store_id     uuid not null references stores(id) on delete cascade,
  rider_id     uuid not null references riders(id) on delete cascade,
  route_date   date not null,
  status       text not null default 'planificada' check (status in (
                 'planificada', -- se está armando; el motorizado aún no la ve
                 'en_curso',    -- entregada al motorizado, ya reporta
                 'cerrada'      -- terminó el día; generó su liquidación
               )),
  -- Liquidación que generó al cerrarse. Es el puente con 0054: la ruta cerrada
  -- no vuelve a calcularse, se convierte en una liquidación como cualquier otra.
  settlement_id uuid references rider_settlements(id) on delete set null,
  note         text,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  started_at   timestamptz,
  closed_at    timestamptz,
  -- Un motorizado no puede tener dos rutas el mismo día en la misma tienda: si
  -- se le añaden paradas, se añaden a la que ya tiene.
  constraint delivery_routes_unique_day unique (store_id, rider_id, route_date)
);

create index if not exists delivery_routes_rider_idx
  on delivery_routes(rider_id, route_date desc);
create index if not exists delivery_routes_store_idx
  on delivery_routes(store_id, route_date desc);

-- ----------------------------------------------------------------------------
-- Las paradas: un pedido que hay que entregar.
-- ----------------------------------------------------------------------------

create table if not exists delivery_stops (
  id             uuid primary key default gen_random_uuid(),
  route_id       uuid not null references delivery_routes(id) on delete cascade,
  order_id       uuid not null references orders(id) on delete cascade,
  -- Orden en que se le muestran. No es una ruta optimizada: es el orden que el
  -- coordinador decide, y el motorizado puede saltárselo.
  seq            int not null default 0,
  status         text not null default 'pendiente' check (status in (
                   'pendiente',
                   'entregado',
                   'no_entregado'
                 )),
  /* Lo que el motorizado declara al reportar. */
  payment_method text check (payment_method in ('efectivo', 'yape', 'pos', 'sin_cobro')),
  collected_amount numeric(12, 2),
  -- Motivo cuando no entregó, del catálogo de la interfaz (no contestó,
  -- rechazó, dirección errada, reprogramado…).
  outcome_reason text,
  note           text,
  /* Respaldos en bucket privado. */
  photo_path     text,   -- foto de la entrega
  voucher_path   text,   -- captura del Yape, cuando cobró así
  reported_at    timestamptz,
  reported_by    uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- El mismo pedido no puede estar dos veces en la misma ruta.
  constraint delivery_stops_unique_order unique (route_id, order_id),
  -- Una parada entregada tiene que decir CÓMO se cobró. Sin esto, una entrega
  -- sin método de pago dejaría un agujero silencioso en la liquidación.
  constraint delivery_stops_delivered_has_method
    check (status <> 'entregado' or payment_method is not null),
  -- Y una parada reportada tiene que decir cuándo se reportó.
  constraint delivery_stops_reported_has_time
    check (status = 'pendiente' or reported_at is not null)
);

create index if not exists delivery_stops_route_idx on delivery_stops(route_id, seq);
create index if not exists delivery_stops_order_idx on delivery_stops(order_id);

comment on column delivery_stops.collected_amount is
  'Lo que el motorizado declara haber cobrado. NO toca el Master: el cuadre de '
  'la liquidación lo compara con el total del pedido.';

-- ----------------------------------------------------------------------------
-- Historial de reportes: una parada se corrige, no se reescribe en silencio.
-- ----------------------------------------------------------------------------

create table if not exists delivery_stop_events (
  id          uuid primary key default gen_random_uuid(),
  stop_id     uuid not null references delivery_stops(id) on delete cascade,
  status      text not null,
  payment_method text,
  collected_amount numeric(12, 2),
  outcome_reason text,
  note        text,
  occurred_at timestamptz not null default now(),
  actor       uuid references auth.users(id) on delete set null
);

create index if not exists delivery_stop_events_stop_idx
  on delivery_stop_events(stop_id, occurred_at desc);

comment on table delivery_stop_events is
  'Cada reporte de una parada, incluidas las correcciones. Append-only: es '
  'dinero, y hace falta saber quién dijo qué y cuándo.';

-- ----------------------------------------------------------------------------
-- La liquidación puede nacer de una ruta.
-- ----------------------------------------------------------------------------

alter table rider_settlements drop constraint if exists rider_settlements_source_check;
alter table rider_settlements add constraint rider_settlements_source_check
  check (source in ('foto', 'hoja', 'manual', 'ruta'));

-- ----------------------------------------------------------------------------
-- RLS.
--
-- Dos públicos con reglas distintas sobre las mismas tablas:
--   - el equipo (admin/coordinador) ve y arma las rutas de sus tiendas;
--   - el motorizado ve SOLO las suyas, y solo cuando ya se le entregaron
--     ('en_curso' o 'cerrada'): una ruta que aún se está armando no debe
--     aparecerle a medio hacer.
-- ----------------------------------------------------------------------------

alter table delivery_routes      enable row level security;
alter table delivery_stops       enable row level security;
alter table delivery_stop_events enable row level security;

-- ¿La ruta es de quien pregunta, como motorizado?
create or replace function public.auth_rider_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from riders where user_id = auth.uid() limit 1;
$$;

revoke all on function public.auth_rider_id() from public, anon;
grant execute on function public.auth_rider_id() to authenticated;

drop policy if exists delivery_routes_select on delivery_routes;
create policy delivery_routes_select on delivery_routes for select to authenticated
  using (
    store_id in (select auth_store_ids())
    or (rider_id = auth_rider_id() and status in ('en_curso', 'cerrada'))
  );

drop policy if exists delivery_routes_write on delivery_routes;
create policy delivery_routes_write on delivery_routes for all to authenticated
  using (org_id in (select auth_admin_org_ids()))
  with check (org_id in (select auth_admin_org_ids()));

drop policy if exists delivery_stops_select on delivery_stops;
create policy delivery_stops_select on delivery_stops for select to authenticated
  using (
    route_id in (
      select id from delivery_routes
       where store_id in (select auth_store_ids())
          or (rider_id = auth_rider_id() and status in ('en_curso', 'cerrada'))
    )
  );

-- El motorizado SÍ escribe, pero solo en las paradas de SU ruta en curso. No
-- puede crear paradas ni borrarlas: eso es armar la ruta, y no es suyo.
drop policy if exists delivery_stops_report on delivery_stops;
create policy delivery_stops_report on delivery_stops for update to authenticated
  using (
    route_id in (
      select id from delivery_routes
       where rider_id = auth_rider_id() and status = 'en_curso'
    )
  )
  with check (
    route_id in (
      select id from delivery_routes
       where rider_id = auth_rider_id() and status = 'en_curso'
    )
  );

drop policy if exists delivery_stops_write on delivery_stops;
create policy delivery_stops_write on delivery_stops for all to authenticated
  using (
    route_id in (
      select id from delivery_routes where org_id in (select auth_admin_org_ids())
    )
  )
  with check (
    route_id in (
      select id from delivery_routes where org_id in (select auth_admin_org_ids())
    )
  );

drop policy if exists delivery_stop_events_select on delivery_stop_events;
create policy delivery_stop_events_select on delivery_stop_events for select to authenticated
  using (
    stop_id in (
      select s.id from delivery_stops s join delivery_routes r on r.id = s.route_id
       where r.store_id in (select auth_store_ids())
          or (r.rider_id = auth_rider_id() and r.status in ('en_curso', 'cerrada'))
    )
  );

drop policy if exists delivery_stop_events_insert on delivery_stop_events;
create policy delivery_stop_events_insert on delivery_stop_events for insert to authenticated
  with check (
    stop_id in (
      select s.id from delivery_stops s join delivery_routes r on r.id = s.route_id
       where r.org_id in (select auth_admin_org_ids())
          or (r.rider_id = auth_rider_id() and r.status = 'en_curso')
    )
  );

-- El historial no se corrige: es el registro de las correcciones.
drop policy if exists delivery_stop_events_immutable on delivery_stop_events;
create policy delivery_stop_events_immutable on delivery_stop_events for update to authenticated
  using (false);

-- El motorizado necesita leer su propia ficha para que la app sepa quién es.
drop policy if exists riders_select on riders;
create policy riders_select on riders for select to authenticated
  using (org_id in (select auth_org_ids()) or user_id = auth.uid());

grant select on delivery_routes, delivery_stops, delivery_stop_events to authenticated;
grant insert, update, delete on delivery_routes, delivery_stops to authenticated;
grant insert on delivery_stop_events to authenticated;
grant all privileges on delivery_routes, delivery_stops, delivery_stop_events to service_role;
