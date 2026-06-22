#!/usr/bin/env bash
# Spin up a throwaway Postgres cluster, apply the migrations + RLS policies, and
# prove two properties:
#   1. recompute_daily_rollups() (SQL) == computeDailyRollups() (TS), exactly.
#   2. RLS isolation: a store-A viewer cannot see store B, an org owner sees all,
#      and a viewer with no explicit grant sees nothing.
#
# Safe: only ever touches its own temp cluster — never your Supabase database.
# Requires the PostgreSQL 16 server binaries + pnpm install already done.
#
#   bash scripts/verify-db.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-}"
if [ -z "$PGBIN" ]; then
  if [ -x /usr/lib/postgresql/16/bin/initdb ]; then PGBIN=/usr/lib/postgresql/16/bin
  elif command -v initdb >/dev/null 2>&1; then PGBIN="$(dirname "$(command -v initdb)")"
  else echo "Postgres server binaries not found (set PGBIN)"; exit 1; fi
fi

TMP="$(mktemp -d)"
PORT="${PGPORT_TEST:-5455}"
DATA="$TMP/data"; RUN="$TMP/run"; mkdir -p "$DATA" "$RUN"

# Postgres refuses to run as root; when root, drive the server as a sub-user.
SU=""
if [ "$(id -u)" = "0" ]; then
  id pgtest >/dev/null 2>&1 || useradd -m pgtest
  chown -R pgtest:pgtest "$TMP"
  SU="su -s /bin/bash pgtest -c"
fi
run_pg() { if [ -n "$SU" ]; then $SU "$*"; else bash -lc "$*"; fi; }

cleanup() { run_pg "$PGBIN/pg_ctl -D '$DATA' stop -m immediate" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

echo "▶ initdb"
run_pg "$PGBIN/initdb -D '$DATA' -U postgres -A trust" >/dev/null
echo "▶ start (port $PORT)"
run_pg "$PGBIN/pg_ctl -D '$DATA' -o '-p $PORT -k $RUN -c listen_addresses=' -l '$TMP/pg.log' -w start" >/dev/null

PSQL="$PGBIN/psql -v ON_ERROR_STOP=1 -q -h $RUN -p $PORT -U postgres -d postgres"

echo "▶ apply prelude + migrations + policies"
$PSQL -f "$ROOT/scripts/sql/test_prelude.sql"
$PSQL -f "$ROOT/db/migrations/0001_init.sql"
$PSQL -f "$ROOT/db/migrations/0002_rollups.sql"
$PSQL -f "$ROOT/supabase/policies.sql" 2>/dev/null

echo "▶ rollup parity (SQL vs TS)"
( cd "$ROOT" && ./node_modules/.bin/tsx scripts/parity-gen.ts "$TMP" )
$PSQL -f "$TMP/seed_demo.sql" >/dev/null
$PSQL -c "\copy (select date,orders_count,revenue,aov,conversations_count,conversion_rate,promo_orders,stock_validar_orders,cod_orders,agency_orders from daily_rollups where store_id='11111111-1111-1111-1111-111111111111' order by date) to '$TMP/actual_rollups.csv' with csv"
if diff -q "$TMP/expected_rollups.csv" "$TMP/actual_rollups.csv" >/dev/null; then
  echo "  ✅ rollups: SQL == TS (exact)"
else
  echo "  ❌ rollup mismatch:"; diff "$TMP/expected_rollups.csv" "$TMP/actual_rollups.csv" || true; exit 1
fi

echo "▶ RLS isolation"
$PSQL -f "$ROOT/scripts/sql/rls_smoke.sql"
echo "  ✅ RLS: no cross-store leak; owner sees all; ungranted viewer sees nothing"

echo ""
echo "✅ DB verification passed."
