-- Controlled first installation/reinstallation. Prebuild indexes concurrently.
-- Run only in the planned release window, BEFORE serving the new application.
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/master_read_scaling_install.sql
-- Failure rolls back this transaction; it never drops source orders/history.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local application_name = 'master-scaling-install';

\ir master_read_scaling_indexes.sql

\ir ../../db/migrations/0203_master_read_scaling.sql
commit;
