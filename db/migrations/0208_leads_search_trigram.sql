-- 0208: accelerate the three ILIKE '%fragment%' passes used by searchLeads.
-- Plain B-tree indexes cannot serve substring searches. Keep the query,
-- ordering, store scope and RLS unchanged (including numeric names/usernames).
--
-- Live rollout: provision these indexes one at a time with CREATE INDEX
-- CONCURRENTLY before applying this idempotent migration (see DEPLOY.md).
-- If the connection only supports transactional DDL, provision ONE index per
-- transaction with lock_timeout=250ms and statement_timeout=1000ms; abort on
-- timeout and use a direct connection for CONCURRENTLY instead of raising it.
-- Production 2026-10-01: all three completed within these bounded transactions.
-- Transactional migration runners use the definitions below on fresh databases.
-- Patterns shorter than three characters still use the planner's fallback.
create extension if not exists pg_trgm;

create index if not exists leads_search_phone_idx
  on public.leads using gin (phone gin_trgm_ops);
create index if not exists leads_search_name_idx
  on public.leads using gin (name gin_trgm_ops);
create index if not exists leads_search_username_idx
  on public.leads using gin (username gin_trgm_ops);
