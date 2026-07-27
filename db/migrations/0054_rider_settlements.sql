-- 0054 — Liquidaciones de motorizados.
--
-- El motorizado entrega pedidos contra reembolso y al final del día "liquida":
-- declara qué guías entregó y cuánta plata recaudó, y deposita lo cobrado. Hasta
-- ahora eso vivía en papel y en WhatsApp. Esta migración le da tres tablas.
--
-- Tres decisiones que gobiernan el diseño:
--
--   1. LO DECLARADO NO PISA LO REAL. `declared_*` es lo que dijo el motorizado;
--      el estado de la guía y el monto del pedido siguen viniendo del Master. El
--      cuadre COMPARA ambos y expone la diferencia; nunca sobrescribe el Master
--      con lo que diga una hoja. Un descuadre es información, no una corrección.
--
--   2. LO QUE NO SE PUEDE VINCULAR NO SE ADIVINA. Igual que en la ingesta de
--      reportes (0048), una línea que no encuentra su pedido queda en
--      `match_status = 'review'` y la resuelve una persona. Las liquidaciones
--      llegan en foto de cuaderno: adivinar aquí es inventar plata.
--
--   3. CERRAR ES IRREVERSIBLE POR DISEÑO. Una liquidación cerrada congela el
--      pago al motorizado (`payout_amount`). Si luego cambia una tarifa o se
--      corrige una guía, el número pagado ese día no se reescribe solo: se abre
--      otra liquidación de ajuste. Mismo principio de vigencia que 0050.

-- ----------------------------------------------------------------------------
-- Motorizados.
-- ----------------------------------------------------------------------------

create table if not exists riders (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  -- Nulo = trabaja para todas las tiendas de la organización.
  store_id       uuid references stores(id) on delete cascade,
  -- Courier al que pertenece, cuando viene de uno (Aliclik, Fenix…). Nulo = propio.
  courier        text,
  full_name      text not null,
  doc_number     text,
  phone          text,
  active         boolean not null default true,
  note           text,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Un mismo DNI no puede estar dos veces en la organización: es lo que evita que
-- se dupliquen las liquidaciones de una persona escrita de dos maneras.
create unique index if not exists riders_doc_idx
  on riders(org_id, doc_number) where doc_number is not null;
create index if not exists riders_name_idx on riders(org_id, lower(full_name));

comment on table riders is
  'Motorizados que reparten contra reembolso y liquidan lo cobrado.';

-- ----------------------------------------------------------------------------
-- Liquidaciones.
-- ----------------------------------------------------------------------------

create table if not exists rider_settlements (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  store_id       uuid not null references stores(id) on delete cascade,
  -- Nulo mientras nadie haya confirmado de quién es la hoja: el nombre leído de
  -- la foto es una pista, no una identidad.
  rider_id       uuid references riders(id) on delete set null,
  rider_name_raw text,
  settlement_date date not null,
  -- De dónde salió: foto de cuaderno leída por visión, u hoja del courier.
  source         text not null check (source in ('foto', 'hoja', 'manual')),
  file_path      text,
  file_sha256    text,
  -- Lo que el motorizado DECLARA haber recaudado y depositado.
  declared_cash  numeric(12, 2) not null default 0,
  declared_yape  numeric(12, 2) not null default 0,
  status         text not null default 'borrador' check (status in (
                   'borrador',      -- recién subida, sin revisar
                   'cuadrada',      -- revisada y sin diferencias
                   'con_descuadre', -- revisada y con diferencias abiertas
                   'cerrada'        -- congelada, con el pago fijado
                 )),
  -- Lo que se le paga al motorizado por este día. Se congela al cerrar.
  payout_amount  numeric(12, 2),
  note           text,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  closed_at      timestamptz,
  closed_by      uuid references auth.users(id) on delete set null,
  -- Cerrar exige haber fijado el pago: una liquidación cerrada sin número no
  -- sirve de nada y sería un agujero silencioso en el módulo de Costos.
  constraint rider_settlements_closed_has_payout
    check (status <> 'cerrada' or (payout_amount is not null and closed_at is not null))
);

-- Subir dos veces el mismo archivo es el error más común; se corta por hash.
create unique index if not exists rider_settlements_sha_idx
  on rider_settlements(org_id, file_sha256) where file_sha256 is not null;
create index if not exists rider_settlements_lookup_idx
  on rider_settlements(store_id, settlement_date desc);
create index if not exists rider_settlements_rider_idx
  on rider_settlements(rider_id, settlement_date desc);

comment on column rider_settlements.declared_cash is
  'Efectivo declarado por el motorizado. Lo real se compara contra el Master.';
comment on column rider_settlements.payout_amount is
  'Pago al motorizado, congelado al cerrar. No se recalcula si cambia la tarifa.';

-- ----------------------------------------------------------------------------
-- Líneas de la liquidación: una por guía declarada.
-- ----------------------------------------------------------------------------

create table if not exists rider_settlement_lines (
  id              uuid primary key default gen_random_uuid(),
  settlement_id   uuid not null references rider_settlements(id) on delete cascade,
  -- Nulo mientras no se vincule con un pedido real.
  order_id        uuid references orders(id) on delete set null,
  guide_code      text,
  order_name      text,
  -- Lo que dice la hoja, literal y normalizado.
  declared_status text,
  declared_amount numeric(12, 2),
  match_status    text not null default 'review' check (match_status in (
                    'ok',         -- vinculada a un pedido
                    'review',     -- no se pudo vincular: la resuelve una persona
                    'sin_pedido'  -- alguien decidió que no corresponde a ninguno
                  )),
  raw             jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists rider_settlement_lines_batch_idx
  on rider_settlement_lines(settlement_id);
create index if not exists rider_settlement_lines_order_idx
  on rider_settlement_lines(order_id) where order_id is not null;
-- La misma guía no puede declararse dos veces en la misma liquidación: sería
-- cobrar dos veces por una entrega.
create unique index if not exists rider_settlement_lines_guide_idx
  on rider_settlement_lines(settlement_id, lower(guide_code)) where guide_code is not null;

comment on column rider_settlement_lines.declared_amount is
  'Monto que el motorizado dice haber cobrado por esta guía.';

-- ----------------------------------------------------------------------------
-- Tarifas de pago al motorizado: se apoyan en cost_tariffs (0050), con su
-- vigencia y su especificidad ya probadas. Solo hay que abrir los conceptos.
-- ----------------------------------------------------------------------------

alter table cost_tariffs drop constraint if exists cost_tariffs_concept_check;
alter table cost_tariffs add constraint cost_tariffs_concept_check
  check (concept in (
    'primer_intento',
    'intento_adicional',
    'envio_agencia',
    'devolucion',
    'especial',
    -- Pago AL motorizado (0054). Son costos como cualquier otro: llevan fecha de
    -- vigencia y ámbito, así que viven en la misma tabla en vez de duplicar el
    -- motor de resolución.
    'motorizado_entrega',
    'motorizado_visita',
    'motorizado_devolucion'
  ));

-- ----------------------------------------------------------------------------
-- RLS. Lectura para quien ve la tienda; escritura para admins de la
-- organización. Las líneas heredan el permiso de su liquidación.
-- ----------------------------------------------------------------------------

alter table riders                 enable row level security;
alter table rider_settlements      enable row level security;
alter table rider_settlement_lines enable row level security;

drop policy if exists riders_select on riders;
create policy riders_select on riders for select to authenticated
  using (org_id in (select auth_org_ids()));
drop policy if exists riders_write on riders;
create policy riders_write on riders for all to authenticated
  using (org_id in (select auth_admin_org_ids()))
  with check (org_id in (select auth_admin_org_ids()));

drop policy if exists rider_settlements_select on rider_settlements;
create policy rider_settlements_select on rider_settlements for select to authenticated
  using (store_id in (select auth_store_ids()));
drop policy if exists rider_settlements_write on rider_settlements;
create policy rider_settlements_write on rider_settlements for all to authenticated
  using (org_id in (select auth_admin_org_ids()))
  with check (org_id in (select auth_admin_org_ids()));

drop policy if exists rider_settlement_lines_select on rider_settlement_lines;
create policy rider_settlement_lines_select on rider_settlement_lines for select to authenticated
  using (settlement_id in (
    select id from rider_settlements where store_id in (select auth_store_ids())
  ));
drop policy if exists rider_settlement_lines_write on rider_settlement_lines;
create policy rider_settlement_lines_write on rider_settlement_lines for all to authenticated
  using (settlement_id in (
    select id from rider_settlements where org_id in (select auth_admin_org_ids())
  ))
  with check (settlement_id in (
    select id from rider_settlements where org_id in (select auth_admin_org_ids())
  ));

grant select on riders, rider_settlements, rider_settlement_lines to authenticated;
grant insert, update, delete on riders, rider_settlements, rider_settlement_lines to authenticated;
grant all privileges on riders, rider_settlements, rider_settlement_lines to service_role;
