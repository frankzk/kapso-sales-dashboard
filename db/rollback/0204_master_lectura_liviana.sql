-- ============================================================================
-- Deshace 0204_master_lectura_liviana.sql. SOLO si algo sale mal después de
-- aplicarla: no es una migración y `gen-apply` no la recoge (vive fuera de
-- db/migrations a propósito).
--
-- Vuelve exactamente a como estaba antes de 0204:
--   * los dos triggers `*_touch` usan otra vez `touch_updated_at()`, que mueve
--     `updated_at` en cada escritura;
--   * la política de motorizados vuelve a la expresión de 0186;
--   * `order_master_search` desaparece — el código del Master ya cae solo al
--     camino anterior cuando la función no existe (ver `getOrderMasterPage`);
--   * el fillfactor vuelve al de fábrica.
--
-- Los dos índices de `recomputed_at` se recrean APARTE y en su forma
-- concurrente, que no bloquea las escrituras y no puede ir en una transacción:
--
--   create index concurrently if not exists order_master_recomputed_idx
--     on public.order_master (recomputed_at);
--   create index concurrently if not exists order_master_store_recomputed_idx
--     on public.order_master (store_id, recomputed_at);
--
-- (Medido el 29-09-2026: `order_master_stale` iba más rápido SIN ellos, así que
-- recrearlos solo hace falta si se quiere el estado anterior exacto.)
-- ============================================================================

create or replace trigger shipments_touch before update on public.shipments
  for each row execute function public.touch_updated_at();

create or replace trigger order_master_touch before update on public.order_master
  for each row execute function public.touch_updated_at();

alter policy order_master_select_rider on public.order_master
  using (order_id in (select public.auth_rider_order_ids()));

drop function if exists public.order_master_search(uuid[], text);
drop function if exists public.shipments_touch_updated_at();
drop function if exists public.order_master_touch_updated_at();

alter table public.order_master reset (fillfactor);
