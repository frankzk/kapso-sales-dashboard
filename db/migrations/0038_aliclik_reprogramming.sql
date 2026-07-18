-- 0038_aliclik_reprogramming.sql — source fields used to decide whether the
-- original Aliclik guide can still be reprogrammed before falling back to Fenix.
-- Kept separate from reroute_attempts, which is the dashboard's call counter.

alter table shipments add column if not exists aliclik_attempts integer;
alter table shipments add column if not exists aliclik_service_date date;

create index if not exists shipments_aliclik_reprogram_idx
  on shipments (courier, aliclik_service_date, aliclik_attempts)
  where courier = 'aliclik' and status_category in ('pending', 'in_route');
