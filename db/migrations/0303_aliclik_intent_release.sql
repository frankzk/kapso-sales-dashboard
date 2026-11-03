-- ============================================================================
-- 0303_aliclik_intent_release.sql — una guía de Aliclik anulada suelta el
-- candado de creación (MOM §10.2, owner 03-11-2026).
--
-- POR QUÉ. El candado de 0056 admite una sola intención viva por pedido y
-- excluye solo `failed`. Una intención `sent` quedaba viva para siempre, aunque
-- su guía terminara anulada: el pedido ya no podía volver a salir por Aliclik.
-- Eso bloquea la cadena de reintentos de Lima (AUTOECOM → ALIDRIVER, §9.5).
-- Caso: #KP200108, guía AUTOECOM AUR5X510805505383 anulada el 02-11.
--
-- QUÉ CAMBIA.
--   * `released_at` / `released_reason`: cuándo y por qué una intención dejó de
--     contar para el candado. La fila no cambia de estado (sigue `sent`), así
--     que el historial y la salud de Aliclik la leen igual que antes.
--   * El único parcial excluye además las intenciones soltadas. Se crea el
--     nuevo antes de borrar el viejo (el pedido nunca queda sin candado) y
--     toma el nombre del viejo, para que volver a correr el paquete entero no
--     intente recrear en 0056 el índice viejo sobre filas ya soltadas.
--
-- Quién suelta: `createAliclikGuideFor` (lib/aliclik-guide.ts), justo antes de
-- escribir la nueva intención y solo si Aliclik reportó su guía devuelta o anulada
-- (`releasableIntents`, lib/aliclik-intent-release.ts). Nunca un `pending`.
--
-- No cambia datos. Correrla otra vez no cambia nada.
-- ============================================================================

alter table public.aliclik_order_requests
  add column if not exists released_at timestamptz,
  add column if not exists released_reason text;

comment on column public.aliclik_order_requests.released_at is
  'Cuándo la intención dejó de contar para el candado porque su guía quedó anulada o transferida en Aliclik (MOM §10.2). La fila conserva su estado.';
comment on column public.aliclik_order_requests.released_reason is
  'Por qué se soltó el candado: la guía y su estado final.';

create unique index if not exists aliclik_order_requests_live_uniq_v2
  on public.aliclik_order_requests(order_id)
  where status <> 'failed' and released_at is null;

drop index if exists public.aliclik_order_requests_live_uniq;

alter index if exists public.aliclik_order_requests_live_uniq_v2
  rename to aliclik_order_requests_live_uniq;
