#!/usr/bin/env bash
# Apply the migrations + RLS policies to a Postgres and prove two properties:
#   1. recompute_daily_rollups() (SQL) == computeDailyRollups() (TS), exactly.
#   2. RLS isolation: a store-A viewer cannot see store B, an org owner sees all,
#      and a viewer with no explicit grant sees nothing.
#
# Two modes:
#   • default        — spins up a THROWAWAY local cluster (never your Supabase).
#   • VERIFY_DB_EXTERNAL=1 — use an existing empty DB via PGHOST/PGPORT/PGUSER/
#                            PGPASSWORD/PGDATABASE (used by CI's postgres service).
#
# Requires the PostgreSQL server/client binaries + `pnpm install` already done.
#   bash scripts/verify-db.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"

if [ "${VERIFY_DB_EXTERNAL:-}" = "1" ]; then
  # --- external DB (CI service container) ---
  export PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5432}"
  export PGUSER="${PGUSER:-postgres}" PGDATABASE="${PGDATABASE:-postgres}"
  PSQL="psql -v ON_ERROR_STOP=1 -q"
  trap 'rm -rf "$TMP"' EXIT
  echo "▶ using external Postgres at $PGHOST:$PGPORT/$PGDATABASE"
else
  # --- throwaway local cluster ---
  PGBIN="${PGBIN:-}"
  if [ -z "$PGBIN" ]; then
    if command -v initdb >/dev/null 2>&1; then
      PGBIN="$(dirname "$(command -v initdb)")"
    else
      for d in /usr/lib/postgresql/*/bin /opt/homebrew/opt/postgresql@*/bin /usr/pgsql-*/bin; do
        [ -x "$d/initdb" ] && PGBIN="$d" && break
      done
    fi
  fi
  [ -n "$PGBIN" ] && [ -x "$PGBIN/initdb" ] || { echo "Postgres server binaries not found (set PGBIN)"; exit 1; }

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

  echo "▶ initdb"; run_pg "$PGBIN/initdb -D '$DATA' -U postgres -A trust" >/dev/null
  echo "▶ start (port $PORT)"
  run_pg "$PGBIN/pg_ctl -D '$DATA' -o '-p $PORT -k $RUN -c listen_addresses=' -l '$TMP/pg.log' -w start" >/dev/null
  export PGHOST="$RUN" PGPORT="$PORT" PGUSER="postgres" PGDATABASE="postgres"
  PSQL="$PGBIN/psql -v ON_ERROR_STOP=1 -q"
fi

echo "▶ apply prelude + migrations + policies"
$PSQL -f "$ROOT/scripts/sql/test_prelude.sql"
$PSQL -f "$ROOT/db/migrations/0001_init.sql"
$PSQL -f "$ROOT/db/migrations/0002_rollups.sql"
$PSQL -f "$ROOT/db/migrations/0003_refunds.sql"
$PSQL -f "$ROOT/supabase/policies.sql" 2>/dev/null
$PSQL -f "$ROOT/db/migrations/0004_leads.sql"
$PSQL -f "$ROOT/db/migrations/0005_message_timing.sql"
$PSQL -f "$ROOT/db/migrations/0006_kapso_only_orders.sql"

echo "▶ rollup parity (SQL vs TS)"
( cd "$ROOT" && ./node_modules/.bin/tsx scripts/parity-gen.ts "$TMP" )
$PSQL -f "$TMP/seed_demo.sql" >/dev/null
$PSQL -c "\copy (select date,orders_count,revenue,aov,conversations_count,conversion_rate,promo_orders,stock_validar_orders,cod_orders,agency_orders,cancelled_orders,refunded_amount,inbound_messages,response_seconds_sum,response_samples from daily_rollups where store_id='11111111-1111-1111-1111-111111111111' order by date) to '$TMP/actual_rollups.csv' with csv"
if diff -q "$TMP/expected_rollups.csv" "$TMP/actual_rollups.csv" >/dev/null; then
  echo "  ✅ rollups: SQL == TS (exact)"
else
  echo "  ❌ rollup mismatch:"; diff "$TMP/expected_rollups.csv" "$TMP/actual_rollups.csv" || true; exit 1
fi

echo "▶ RLS isolation"
$PSQL -f "$ROOT/scripts/sql/rls_smoke.sql"
echo "  ✅ RLS: no cross-store leak; owner sees all; ungranted viewer sees nothing"

# The checks above only need 0001–0006. Everything from 0007 on is applied here,
# in order, so the whole chain is proven to run on a fresh database — and so the
# append-only guarantees below can be asserted against the real schema.
echo "▶ remaining migrations (0007 → latest)"
for f in $(ls "$ROOT"/db/migrations/*.sql | sort); do
  case "$(basename "$f")" in 000[1-6]_*) continue ;; esac
  $PSQL -f "$f" >/dev/null
done
echo "  ✅ all migrations apply on a fresh database"
echo "▶ Liquidaciones 2: un motorizado solo ve su hoja (0179)"
$PSQL -f "$ROOT/scripts/sql/sheets_rider_smoke.sql"
echo "  ✅ motorizado acotado a su hoja; owner y viewer ven las de su org"
echo "▶ Master para el motorizado: solo los pedidos de sus rutas (0186)"
$PSQL -f "$ROOT/scripts/sql/rider_master_smoke.sql"
echo "  ✅ motorizado lee del Master solo sus paradas; owner sigue viendo todo"

# La cobertura COD se decide por coordenada además de por nombre (0100). Es
# lógica geoespacial hecha a mano (haversine, sin PostGIS): esta prueba fija que
# la cercanía a un punto COD clasifica bien y que las reglas de precedencia y el
# aislamiento por org se respetan.
echo "▶ cobertura por coordenada"
$PSQL -f "$ROOT/scripts/sql/coverage_smoke.sql" >/dev/null
echo "▶ order_master_stale (0123, 0240, 0241): el desfase se ve aunque sea ANTIGUO o RECIÉN recalculado, y solo lo pide el servidor"
$PSQL -f "$ROOT/scripts/sql/order_master_stale_smoke.sql"
echo "▶ membership_roles (0250): los roles se suman también en la base y se van con la membresía"
$PSQL -f "$ROOT/scripts/sql/membership_roles_smoke.sql"
# Qué escritura cuenta como cambio (0204): un sello de lectura de la API o un
# recálculo sin cambios no pueden mover `updated_at`, o vuelve la cascada de
# recálculos y recargas del Master. Y la búsqueda con índice no ve más que la RLS.
echo "▶ Master liviano (0204): sellos y recálculos sin cambios no mueven updated_at"
$PSQL -f "$ROOT/scripts/sql/master_liviano_smoke.sql"
echo "  ✅ solo un cambio real mueve updated_at; la búsqueda respeta las tiendas de cada quien"

echo "  ✅ cerca de un punto COD → provincia_cod; lejos → agencia; Cañete y aislamiento por org intactos"

# Un distrito de Lima escrito en la casilla del departamento sacaba al pedido de
# Lima (0130). Lo delicado es la mitad que NO cambia: Bellavista, La Victoria e
# Independencia existen fuera de Lima y no pueden colarse en el reparto local.
echo "▶ región que nombra un distrito de Lima (0130)"
$PSQL -f "$ROOT/scripts/sql/lima_region_smoke.sql"

# order_events is the audit trail of the Master de Pedidos: it must be
# impossible to rewrite history, even for the role the server actions use.
echo "▶ auditoría inmutable + clave de recojo + unicidad del Yape"
$PSQL -f "$ROOT/scripts/sql/append_only_smoke.sql"
echo "  ✅ auditoría inmutable, clave de recojo sin lectura directa y comprobante Yape único"

# De quién es una venta se decide UNA vez (0132). El fallo que motivó la tabla no
# fue nadie reasignando a mano: fue un número que se recalculaba y cambiaba de
# dueña solo. Por eso la garantía tiene que estar en la base, no en el código.
echo "▶ la venta no se traspasa (0132)"
$PSQL -f "$ROOT/scripts/sql/order_sales_smoke.sql" >/dev/null
echo "  ✅ sin UPDATE ni DELETE, la primera dueña gana y el backfill se calla si duda"

# Los conteos de las pestañas de Leads viven ahora en SQL (0059) y en ningún
# sitio más: esta prueba compara la función con los filtros originales, uno a uno.
echo "▶ paridad de los conteos de la cola de Leads"
$PSQL -f "$ROOT/scripts/sql/lead_queue_counts_smoke.sql"
echo "  ✅ lead_queue_counts == los siete filtros originales, y la firma se mueve al tocar un lead"

# OJO: esta comprobación corre SOBRE UNA BASE VACÍA, y ahí un `delete` destructivo
# y uno inofensivo son indistinguibles — los dos borran cero filas. El 24-08-2026
# el purgado de una vez de 0006 llegó a producción por pegar este mismo bundle, y
# lo abortó el trigger append-only de order_events. Lo que vigila que ninguna
# migración borre datos a nivel de migración es test/migrations-safe-to-rerun.ts,
# que mira el fuente; esto solo prueba que el esquema levanta.
#
# db/apply_bundled.sql es lo que se pega en el SQL Editor de Supabase para
# levantar el esquema entero de cero. Se generaba a mano y llevaba meses
# derivando —le faltaba más de la mitad de las migraciones— porque nada lo
# comprobaba. Estas dos comprobaciones son las que faltaban: que esté al día
# respecto a db/migrations/, y que de verdad aplique sobre una base VACÍA.
echo "▶ db/apply.sql y db/apply_bundled.sql al día"
( cd "$ROOT" && node scripts/gen-apply.mjs --check )

echo "▶ el bundle aplica sobre una base limpia"
$PSQL -c "drop database if exists bundle_check" >/dev/null
$PSQL -c "create database bundle_check" >/dev/null
$PSQL -d bundle_check -f "$ROOT/scripts/sql/test_prelude.sql" >/dev/null
$PSQL -d bundle_check -f "$ROOT/db/apply_bundled.sql" >/dev/null
$PSQL -c "drop database bundle_check" >/dev/null
echo "  ✅ apply_bundled.sql levanta el esquema completo desde cero"

echo "▶ automático Aliclik → Swayp: reserva, cupo, evidencia y RLS"
$PSQL -f "$ROOT/scripts/sql/swayp_auto_smoke.sql"

# Las llamadas de pedido (§11.8) y las del agente de leads (0247, MOM §33)
# comparten `voice_calls`: lo que impide que una se tome por la otra son las
# reglas de la base, así que se prueban aquí y no solo en el código.
echo "▶ agente de voz para leads (0247): pedidos y leads no se mezclan en voice_calls"
$PSQL -f "$ROOT/scripts/sql/voice_lead_smoke.sql"
echo "  ✅ cada fila es de un pedido o de un lead, con los resultados de su carril; el candado Swayp no corre por un lead; una sola llamada de leads abierta"

echo "▶ doble cotejo de despacho"
$PSQL -f "$ROOT/scripts/sql/dispatch_smoke.sql"
echo "  ✅ la custodia solo cambia después de cotejar el 100 % dos veces"

echo "▶ GF: cargas adicionales, recepción por usuario y ruta de reparto única"
$PSQL -f "$ROOT/scripts/sql/gf_route_loads_smoke.sql"
echo "▶ «No lo recojo» (0182): el rechazo sale de la carga y la custodia pasa con los aceptados"
$PSQL -f "$ROOT/scripts/sql/gf_rider_decline_smoke.sql"
echo "  ✅ rechazo con rastro, sin parada, salida libre para otra caja"
echo "▶ verificación del motorizado como flag (0183): con false basta con asignar"
$PSQL -f "$ROOT/scripts/sql/gf_assign_custody_smoke.sql"
echo "  ✅ flag true no entrega custodia al asignar; flag false sí, crea paradas y admite cotejo posterior"
echo "▶ una carga por motorizado y día con el flag apagado (0184)"
$PSQL -f "$ROOT/scripts/sql/gf_one_load_smoke.sql"
echo "  ✅ dos asignaciones → una carga, una ruta, paradas sin duplicar; con el flag encendido, carga adicional"
echo "▶ modo confirmar: «lo llevo» / «no lo llevo» sobre la caja en custodia (0185)"
$PSQL -f "$ROOT/scripts/sql/gf_pickup_mode_smoke.sql"
echo "  ✅ asignar da custodia con paradas por confirmar; confirmar marca el ítem; rechazar retira, borra la parada y libera el paquete; el supervisor quita solo lo no confirmado"
echo "▶ «Recibir en oficina» (0188): un no entregado sale de la caja en custodia, también en exigir"
$PSQL -f "$ROOT/scripts/sql/gf_return_to_office_smoke.sql"
echo "  ✅ sale con rastro, custodia a la empresa, solicitud a por asignar; la parada se conserva; un rechazo también vuelve a por asignar (0206)"
echo "▶ «Sacar con salida nueva» (0248): la caja que el motorizado todavía tiene queda en devolución y el pedido sale con otra"
$PSQL -f "$ROOT/scripts/sql/gf_replace_output_smoke.sql"
echo "  ✅ la S01 pasa a retorno sin salir de la caja; la solicitud pasa a la S02; su parada ya no cambia; al recibirla vuelve a stock sin volver a por asignar; tope de cinco"
echo "▶ caja abierta durante el cotejo (0196): se suma en paralelo y sale al 100 % o con la diferencia retirada"
$PSQL -f "$ROOT/scripts/sql/gf_parallel_box_smoke.sql"
echo "  ✅ misma caja durante el cotejo; lo nuevo reabre oficina; se recibe lo verificado; custodia al 100 % o al retirar la diferencia; carga 2 solo tras la custodia"
echo "▶ pago del motorizado: el rechazo antes del 28/09 no exige foto (0197)"
$PSQL -f "$ROOT/scripts/sql/rider_pay_rejection_photo_smoke.sql"
echo "  ✅ rechazo del 27/09 sin foto no frena el pago; el del 28/09 sí; entrega sin foto y Yape sin captura cuentan siempre"
echo "▶ pago del motorizado: lo cargado desde el cuaderno no exige foto (0222)"
$PSQL -f "$ROOT/scripts/sql/rider_pay_notebook_photo_smoke.sql"
echo "  ✅ entrega y rechazo del cuaderno sin foto no frenan el pago y se pagan; la entrega de la app sin foto y el Yape sin captura sí cuentan"
echo "▶ el reprogramado que el motorizado conserva pasa a su ruta siguiente (0234)"
$PSQL -f "$ROOT/scripts/sql/gf_carry_over_smoke.sql"
echo "  ✅ sale de la caja anterior con rastro, entra cotejado en una carga en custodia con su parada pendiente; no contesta, anulado y repetidos no pasan; todo o nada"
echo "▶ «Repro Lima» (0251): un caso abierto por pedido, candado, llamadas append-only y fecha que pidió el cliente"
$PSQL -f "$ROOT/scripts/sql/repro_lima_smoke.sql"
echo "  ✅ caso perezoso único, episodio, candado de 10 min, cuatro resultados, idempotencia, RLS por tienda"
echo "▶ LTV : CPA (0252): clientas nuevas por mes de primera entrega, valor a cada horizonte, gasto por moneda y RLS"
$PSQL -f "$ROOT/scripts/sql/ltv_cohorts_smoke.sql"
echo "  ✅ solo entregados desde la primera compra, teléfono por sus 9 dígitos, gasto por mes y moneda, cada quien sus tiendas"
echo "▶ Recordatorio de reposición (0255): quién vence hoy, línea sin id por su título, uno por pedido, resultados por grupo y RLS"
$PSQL -f "$ROOT/scripts/sql/restock_reminders_smoke.sql"
echo "  ✅ unidades × días − días antes, ventana, quien volvió a comprar no, uno por pedido, control aparte, cada quien sus tiendas"
echo "▶ Repro Lima «Todos» (0256): Lima sin Finalizado por etapa y subetapa, días de Lima, solo service_role"
$PSQL -f "$ROOT/scripts/sql/lima_open_counts_smoke.sql"
echo "  ✅ igual a un GROUP BY directo, sin Finalizado ni Provincia, borde de medianoche de Lima, authenticated sin permiso"

# SimpleFact no tiene llave de idempotencia: la misma boleta mandada dos veces
# son dos boletas ante SUNAT, y una boleta enviada no se borra. Lo que lo impide
# —el turno con candado, un solo comprobante real vivo por pedido, estados que
# solo avanzan, «real» y «manual» solo con la conexión probada, y ninguna fila
# sin que la empresa haya recibido el pago, y nada antes de «Emitir desde» salvo
# lo que pide una persona con el botón— vive en la base (0257, 0260, 0261, 0262
# y 0266, MOM §35), así que se prueba en la base y no solo en el código. La 0257
# ya corrió en producción y no se reescribe: la 0260 cambia cuatro de sus
# funciones, la 0261 trae el modo «Manual» (el turno da la fila que se pide, y
# quién la pidió), la 0262 hace que el turno vuelva a revisar el pago (un pago
# rechazado entre la lectura del código y el turno no deja fila) y la 0266 deja
# emitir con «Emitir esta boleta» lo pagado antes de «Emitir desde», desde el
# 01/10/2026 (`p_backfill`); la prueba corre cada una sobre lo que había en
# producción cuando se aplicó.
echo "▶ Comprobantes por RUC (0257, 0260, 0261, 0262 y 0266): semilla apagada, cuenta → RUC de su organización, turno con candado, uno real vivo por pedido, la 0260 sobre la 0257, el modo «Manual», el pago revisado en el turno y lo pagado antes de «Emitir desde» con el botón"
$PSQL -f "$ROOT/scripts/sql/invoices_smoke.sql"
echo "  ✅ GRUPO GF S.A.C. sembrado apagado y sin pisar al owner, real solo con token, fecha y prueba del mismo RUC, cada motivo del turno, tope del día, índice único, estados que solo avanzan, solo service_role; la 0260 cambia las cuatro funciones sin tocar datos ni triggers, y dos veces es una; la 0261 admite «Manual» con lo que exige Real, baja como Real, da la fila pedida con quién la pidió (modo_distinto si no), cuenta el tope por modo pedido, deja un solo turno que el código de hoy llama con nueve argumentos por nombre, y dos veces es una; con la 0262 el turno no da fila si lo validado no cubre el total, si un pago de la base del comprobante ya no está validado o si el prepago no es un prepago web sin comprobantes, bloquea los pagos mientras dura, cambia solo el turno en su lugar, se detiene sin la 0261 delante, y dos veces es una (los tres ERROR de su guarda se esperan); con la 0266 lo pagado antes de «Emitir desde» sale solo con p_backfill, una real pedida por una persona, el RUC en Manual y las dos fechas desde el 01/10/2026 de Lima, con la marca en su base; el barrido, una simulada y Real siguen en antes_de_inicio; deja un solo turno, el de doce, con el cuerpo de la 0262 salvo la fecha y la base, se detiene sin la 0262 delante, y dos veces es una (los tres ERROR de su guarda se esperan)"

echo ""
echo "✅ DB verification passed."
