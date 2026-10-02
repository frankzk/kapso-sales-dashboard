-- Server-only lease/status for automatic reads. Existing store RLS and grants
-- remain in force: authenticated users can read but cannot update these fields.
alter table public.urpi_programming_sources
  add column if not exists last_auto_attempt_at timestamptz,
  add column if not exists last_auto_success_at timestamptz,
  add column if not exists last_auto_error text,
  add column if not exists auto_sync_token uuid,
  add column if not exists auto_sync_until timestamptz;

create index if not exists urpi_sources_auto_due
  on public.urpi_programming_sources(month, last_auto_attempt_at nulls first);
