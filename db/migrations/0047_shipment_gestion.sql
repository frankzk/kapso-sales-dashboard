-- ============================================================================
-- 0047_shipment_gestion.sql — campos de gestión logística y de agencia sobre
-- `shipments`.
--
-- La especificación (§8) pide registrar, POR CADA gestión logística: courier,
-- nº de intento, fecha de asignación, de despacho, de salida a reparto, estado
-- reportado, resultado, motivo de no entrega, fecha de reprogramación, fecha de
-- cierre, guía, observaciones, usuario y fuente del reporte.
--
-- Una "gestión logística" es, en la práctica, una guía asignada a un courier —
-- que es exactamente lo que `shipments` ya modela (0022). Por eso se extiende
-- esa tabla en vez de crear una paralela: duplicar las guías obligaría a
-- sincronizar dos fuentes de verdad y rompería Repro Provincia, que es su dueño.
--
-- Hasta esta migración, lib/order-master.ts DERIVA estas fechas del historial de
-- `shipment_calls` (el primer paso a "en_ruta" es el despacho, etc.). Con las
-- columnas explícitas, el dato reportado por el courier manda sobre lo derivado;
-- el código ya contempla ambos casos con el patrón de "column step-down", así
-- que esta migración se puede aplicar antes o después del deploy.
--
-- También abre `shipments` al flujo de AGENCIA (Shalom / Olva, §10), que hasta
-- ahora no existía en el sistema: esos couriers solo aparecían como texto libre
-- en el módulo de Leads.
-- ============================================================================

alter table shipments
  -- Fechas de la gestión, tal como las reporta el courier.
  add column if not exists assigned_at          timestamptz,
  add column if not exists dispatched_at        timestamptz,
  add column if not exists out_for_delivery_at  timestamptz,
  add column if not exists rescheduled_at       timestamptz,
  add column if not exists closed_at            timestamptz,
  add column if not exists returned_at          timestamptz,
  -- Qué dijo el reporte, literal, antes de normalizarlo a delivery_status. Es lo
  -- que permite auditar por qué el sistema decidió lo que decidió.
  add column if not exists reported_status      text,
  add column if not exists non_delivery_reason  text,
  -- De dónde salió el último dato: aliclik | fenix | shalom | olva | manual | api
  add column if not exists source               text,
  -- Flujo de agencia (§10).
  add column if not exists agency_branch        text,
  add column if not exists agency_arrived_at    timestamptz,
  add column if not exists agency_expires_at    timestamptz,
  -- Sub-estado del recojo; los valores válidos son los del catálogo de estados
  -- operativos de lib/order-status.ts (enviado_a_agencia, registrado_en_agencia,
  -- en_transito, disponible_para_recojo, cliente_notificado, pendiente_de_recojo,
  -- proximo_a_vencer, retorno_iniciado). Sin CHECK, igual que delivery_status
  -- (ver 0028): el catálogo vive en el código, que es donde se puede versionar.
  add column if not exists pickup_state         text;

comment on column shipments.reported_status is
  'Estado tal como lo reportó el courier, sin normalizar (auditoría).';
comment on column shipments.pickup_state is
  'Sub-estado del flujo de agencia (Shalom/Olva). Catálogo en lib/order-status.ts.';
comment on column shipments.agency_expires_at is
  'Fecha límite de recojo en agencia; pasada, el pedido pasa a "próximo a vencer".';

-- El monitoreo de agencia (§10) es una cola por sí misma: pedidos disponibles
-- para recojo y próximos a vencer. Índice parcial para no escanear las guías de
-- reparto normal, que son la mayoría.
create index if not exists shipments_pickup_state_idx
  on shipments(store_id, pickup_state) where pickup_state is not null;
create index if not exists shipments_agency_expiry_idx
  on shipments(agency_expires_at) where agency_expires_at is not null;
create index if not exists shipments_returned_idx
  on shipments(store_id, returned_at) where returned_at is not null;

-- Backfill de lo que ya se puede saber sin inventar nada:
--   * assigned_at — cuándo entró la guía al sistema.
--   * source      — el courier que la trajo.
update shipments
   set assigned_at = coalesce(assigned_at, created_at),
       source      = coalesce(source, courier)
 where assigned_at is null or source is null;

-- ----------------------------------------------------------------------------
-- El rollup del Master también necesita el dato de agencia: el listado filtra y
-- ordena por "disponible para recojo", "días en agencia" y "próximo a vencer"
-- (§10), y eso se resuelve en una sola tabla o no se resuelve.
-- ----------------------------------------------------------------------------

alter table order_master
  add column if not exists pickup_state      text,
  add column if not exists agency_branch     text,
  add column if not exists agency_arrived_at timestamptz,
  add column if not exists agency_expires_at timestamptz;

create index if not exists order_master_pickup_idx
  on order_master(store_id, pickup_state) where pickup_state is not null;
create index if not exists order_master_expiry_idx
  on order_master(agency_expires_at) where agency_expires_at is not null;
