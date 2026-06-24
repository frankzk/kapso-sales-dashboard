-- Apply the full schema + RLS in order, in one command:
--   psql "$DATABASE_URL" -f db/apply.sql
-- (\ir paths are relative to this file.)
\echo 'Applying 0001_init.sql'
\ir migrations/0001_init.sql
\echo 'Applying 0002_rollups.sql'
\ir migrations/0002_rollups.sql
\echo 'Applying 0003_refunds.sql'
\ir migrations/0003_refunds.sql
\echo 'Applying RLS policies'
\ir ../supabase/policies.sql
\echo 'Applying 0004_leads.sql'
\ir migrations/0004_leads.sql
\echo 'Applying 0005_message_timing.sql'
\ir migrations/0005_message_timing.sql
\echo 'Applying 0006_kapso_only_orders.sql'
\ir migrations/0006_kapso_only_orders.sql
\echo 'Applying 0007_lead_signals.sql'
\ir migrations/0007_lead_signals.sql
\echo 'Applying 0008_lead_source.sql'
\ir migrations/0008_lead_source.sql
\echo 'Applying 0009_lead_inbound.sql'
\ir migrations/0009_lead_inbound.sql
\echo 'Done.'
