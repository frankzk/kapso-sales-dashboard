#!/usr/bin/env bash
# Prueba 0228_urpi_report.sql en un cluster de Postgres DESECHABLE (nunca en
# Supabase): RLS por tienda/organización, historial por cambio, vínculo manual
# que ninguna lectura pisa y pedidos siempre de la misma organización.
#   bash scripts/verify-urpi-report.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-}"
if [ -z "$PGBIN" ]; then
  if command -v initdb >/dev/null 2>&1; then PGBIN="$(dirname "$(command -v initdb)")"
  else for d in /usr/lib/postgresql/*/bin /opt/homebrew/opt/postgresql@*/bin; do [ -x "$d/initdb" ] && PGBIN="$d" && break; done; fi
fi
[ -n "$PGBIN" ] && [ -x "$PGBIN/initdb" ] || { echo "Postgres server binaries not found (set PGBIN)"; exit 1; }
TMP="$(mktemp -d)"; DATA="$TMP/data"; RUN="$TMP/run"; mkdir -p "$DATA" "$RUN"
SU=""
if [ "$(id -u)" = "0" ]; then id pgtest >/dev/null 2>&1 || useradd -m pgtest; chown -R pgtest:pgtest "$TMP"; SU="su -s /bin/bash pgtest -c"; fi
run_pg() { if [ -n "$SU" ]; then $SU "$*"; else bash -lc "$*"; fi; }
cleanup() { run_pg "$PGBIN/pg_ctl -D '$DATA' stop -m immediate" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
run_pg "$PGBIN/initdb -D '$DATA' -U postgres -A trust" >/dev/null
run_pg "$PGBIN/pg_ctl -D '$DATA' -o '-p 5466 -k $RUN -c listen_addresses=' -l '$TMP/pg.log' -w start" >/dev/null
PGOPTIONS="-c client_min_messages=warning" "$PGBIN/psql" -h "$RUN" -p 5466 -U postgres -d postgres -v ON_ERROR_STOP=1 -q -t -f "$ROOT/scripts/sql/verify_urpi_report.sql"
