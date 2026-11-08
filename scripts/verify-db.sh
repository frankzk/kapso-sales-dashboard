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
echo "▶ Canal de cierre (0259): un canal por pedido, la venta registrada manda, «ayudado» solo con gestión de la misma tienda en 7 días, y RLS"
$PSQL -f "$ROOT/scripts/sql/canal_de_cierre_smoke.sql"
echo "  ✅ asesora > recompra > bot Kapso > bot externo > web > otros, cancelados aparte, día local, cada quien sus tiendas"

# SimpleFact no tiene llave de idempotencia: la misma boleta mandada dos veces
# son dos boletas ante SUNAT, y una boleta enviada no se borra. Lo que lo impide
# —el turno con candado, un solo comprobante real vivo por pedido, estados que
# solo avanzan, «real» y «manual» solo con la conexión probada, y ninguna fila
# sin que la empresa haya recibido el pago, y nada antes de «Emitir desde» salvo
# lo que pide una persona con el botón— vive en la base (0257, 0260, 0261, 0262
# y 0269, MOM §35), así que se prueba en la base y no solo en el código. La 0257
# ya corrió en producción y no se reescribe: la 0260 cambia cuatro de sus
# funciones, la 0261 trae el modo «Manual» (el turno da la fila que se pide, y
# quién la pidió), la 0262 hace que el turno vuelva a revisar el pago (un pago
# rechazado entre la lectura del código y el turno no deja fila) y la 0269 deja
# emitir con «Emitir esta boleta» lo pagado antes de «Emitir desde», desde el
# 01/10/2026 (`p_backfill`); la prueba corre cada una sobre lo que había en
# producción cuando se aplicó.
echo "▶ Comprobantes por RUC (0257, 0260, 0261, 0262 y 0269): semilla apagada, cuenta → RUC de su organización, turno con candado, uno real vivo por pedido, la 0260 sobre la 0257, el modo «Manual», el pago revisado en el turno y lo pagado antes de «Emitir desde» con el botón"
$PSQL -f "$ROOT/scripts/sql/invoices_smoke.sql"
echo "  ✅ GRUPO GF S.A.C. sembrado apagado y sin pisar al owner, real solo con token, fecha y prueba del mismo RUC, cada motivo del turno, tope del día, índice único, estados que solo avanzan, solo service_role; la 0260 cambia las cuatro funciones sin tocar datos ni triggers, y dos veces es una; la 0261 admite «Manual» con lo que exige Real, baja como Real, da la fila pedida con quién la pidió (modo_distinto si no), cuenta el tope por modo pedido, deja un solo turno que el código de hoy llama con nueve argumentos por nombre, y dos veces es una; con la 0262 el turno no da fila si lo validado no cubre el total, si un pago de la base del comprobante ya no está validado o si el prepago no es un prepago web sin comprobantes, bloquea los pagos mientras dura, cambia solo el turno en su lugar, se detiene sin la 0261 delante, y dos veces es una (los tres ERROR de su guarda se esperan); con la 0269 lo pagado antes de «Emitir desde» sale solo con p_backfill, una real pedida por una persona, el RUC en Manual, «Emitir desde» ya llegado y las dos fechas y el primer dinero (la fecha más temprana entre el comprobante y el registro de cada pago validado) desde el 01/10/2026 de Lima, con la marca en su base; el barrido, una simulada y Real siguen en antes_de_inicio; deja un solo turno, el de doce, con el cuerpo de la 0262 salvo la fecha y la base, se detiene sin la 0262 delante, y dos veces es una (los tres ERROR de su guarda se esperan)"

echo "▶ Ventas por origen y conversión por fuente (0268): día local, cancelados aparte, cohorte de 7 días por cualquier canal, ya clientas aparte, y RLS"
$PSQL -f "$ROOT/scripts/sql/ventas_por_origen_smoke.sql"
echo "  ✅ todas las ventas por día y canal, la regla del canal en una sola vista, conversión por nacimiento con 7 días, asesoras como en Productividad, cada quien sus tiendas"

# Es un relleno de datos sobre producción (decisión del dueño, 19-10-2026): lo
# que hay que fijar es qué caja toca y qué no, porque un error no se ve hasta
# que alguien liquida.
echo "▶ Caja «por definir» del cuaderno de Grupo GF (0270): pasa a salida entregada del motorizado propio solo en el objetivo"
$PSQL -f "$ROOT/scripts/sql/cuaderno_s01_fill_smoke.sql"

# La promesa del owner (23-10-2026) es que conectar una tienda con su app
# propia no toca a Kenku, Aurela ni las tiendas cliente. La base la sostiene:
# se prueba aplicando la 0271 sobre el esquema de la 0249 con esas tiendas.
echo "▶ App propia de Shopify (0271): Kenku, Aurela y las tiendas clientes no cambian"
$PSQL -f "$ROOT/scripts/sql/shopify_app_propia_smoke.sql"

# También un relleno de datos sobre producción (23-10-2026): el día de la
# entrega en las salidas de Urpi ya rellenadas y las cajas «por definir» de
# entregas viejas de Urpi. Se fija qué salida toca, qué le escribe y qué no.
echo "▶ Salida de Urpi (0272): closed_at del día de la entrega y las cajas «por definir» de entregas viejas de Urpi, solo en el objetivo"
$PSQL -f "$ROOT/scripts/sql/urpi_salida_fecha_smoke.sql"

# Shopify cierra Kenku y Aurela el 28-10-2026 y pasan a WooCommerce (MOM §38).
# La 0274 solo prepara la base: hasta el cambio, las dos siguen en Shopify
# exactamente igual. Se prueba aplicándola sobre el esquema de la 0273 con esas
# tiendas, sus pedidos y sus borradores.
echo "▶ Base de WooCommerce (0274): Kenku, Aurela y sus pedidos no cambian; el cambio de plataforma exige credenciales"
$PSQL -f "$ROOT/scripts/sql/woocommerce_base_smoke.sql"

# Shopify cierra Kenku y Aurela el 28-10-2026 y sus pedidos se siguen
# facturando después (owner, 23-10-2026): la boleta sale de la foto que se tomó
# mientras Shopify respondía. Se fija qué pedidos la necesitan, que solo se
# guarda la de un pedido de Shopify (nunca de WooCommerce) y que solo el
# servidor la ve.
echo "▶ Foto del pedido para su boleta (0275): la lista de la regla, solo pedidos de Shopify, nunca una foto vieja sobre una nueva, solo service_role"
$PSQL -f "$ROOT/scripts/sql/invoice_snapshots_smoke.sql"
echo "  ✅ ninguna fila cambiada; la lista: de esa tienda, de Shopify con su id, desde el 29-08, sin boleta viva, sin foto y no anulado o con foto vieja, en curso primero; guarda solo un pedido de Shopify de esa tienda con su gid y su respuesta, nunca una foto vieja sobre una nueva ni una sin el pedido sobre una con él; un pedido que falla va detrás, espera y se borra al guardar; un turno por tienda; ni anon ni authenticated; dos veces es una; sin la 0274 se detiene"

# Desde el corte el bot de Kapso le pide el pedido a Kapta, que lo crea en
# WooCommerce (MOM §38.13, plan D5). El bot reintenta solo y en paralelo: lo que
# impide que dos llamadas con el mismo id creen dos pedidos es la clave única de
# la base, así que se prueba aquí y no solo en el código.
echo "▶ Pedidos del bot por Kapta (0277): un candado por (tienda, request_id), el secreto solo en sha256, solo service_role"
$PSQL -f "$ROOT/scripts/sql/bot_orders_smoke.sql"

echo ""
echo "▶ Retiro de salida GF antes de despacho (0284): atómico, auditado y solo servicio"
$PSQL -f "$ROOT/scripts/sql/gf_cancel_output_smoke.sql"

echo "▶ WooCommerce venta terminada con retorno pendiente (0285): fuente intacta, recepción e inventario, un turno, recuperación y recepción GF"
$PSQL -f "$ROOT/scripts/sql/woo_sale_return_smoke.sql"
echo "▶ Pago validado: monto positivo obligatorio (0287), incompletos y retiro de validación"
$PSQL -f "$ROOT/scripts/sql/payment_positive_amount_smoke.sql"
echo "▶ Atender todos los pendientes de Lima (0288): cobertura, etapas, tienda, candado e historial"
$PSQL -f "$ROOT/scripts/sql/lima_attention_all_pending_smoke.sql"
echo "▶ Por llamar y reintentos (0289): fechas, límites, historial, contador, citas y RLS"
$PSQL -f "$ROOT/scripts/sql/lead_call_queue_smoke.sql"

echo "▶ Agencia: cohorte pendiente, checkout, validación, fechas Lima, deduplicación y RLS (0290)"
$PSQL -f "$ROOT/scripts/sql/agency_unpaid_cohort_smoke.sql"
echo "▶ Reintentos con señal real de 7 días (0291): históricos retirados, mensajes, carritos, citas, reservas e historial"
$PSQL -f "$ROOT/scripts/sql/lead_retry_recent_signal_smoke.sql"

echo "▶ Hoja del motorizado: incluir sin reporte anterior, custodia, auditoría, lote atómico y permisos (0292)"
$PSQL -f "$ROOT/scripts/sql/gf_notebook_missing_reports_smoke.sql"

echo "▶ Bloques de Leads por asesora (0295): cobertura, permisos, reservas, citas y respaldo"
$PSQL -f "$ROOT/scripts/sql/team_lead_blocks_smoke.sql"

echo "▶ Bloques para asesoras administradoras (0299): cola restringida, supervisión, reservas y permisos intactos"
$PSQL -f "$ROOT/scripts/sql/lead_routing_admin_smoke.sql"

echo "▶ Manifiesto de devolución (0307): una abierta por motorizado, recepción y línea juntas, faltantes al cerrar, lo cerrado no cambia"
$PSQL -f "$ROOT/scripts/sql/return_manifests_smoke.sql"
echo "  ✅ recibe con la recepción de siempre; anulado en la tienda a inventario; sin reporte no se recibe; cerrar anota las que faltan; RLS de solo lectura"
echo "▶ Lista de pago adelantado (0309): una alta viva por celular, celular canónico, alta que no se reescribe, baja con motivo y RLS"
$PSQL -f "$ROOT/scripts/sql/prepay_list_smoke.sql"
echo "  ✅ una sola alta viva por organización y celular; la baja queda como historia y no se reabre; la regla nace apagada; cada quien lee su organización y nadie escribe"
echo "▶ Llamar con Anura (0310): anexo por persona y por org, estado con su rango, una llamada viva por persona, cdrid único y RLS"
$PSQL -f "$ROOT/scripts/sql/anura_click2dial_smoke.sql"
echo "  ✅ anexos de 2 a 6 dígitos únicos por persona y por anexo; el modo fija el pedido; la grabación guardada con ruta; anexos por org, llamadas por tienda, bitácora solo del servidor y nadie escribe"
echo "▶ Teléfono de Anura dentro de Kapta (0311): ajustes SIP por org, clave SIP cifrada por anexo, clave rechazada y RLS"
$PSQL -f "$ROOT/scripts/sql/anura_kapta_phone_smoke.sql"
echo "  ✅ wss solo a anura.pe y sin puerto; la clave cifrada sigue al anexo (quitarlo o cambiarle el número la borra, apagarlo no); rechazada con fecha y motivo; los ajustes los lee la org y la clave nadie desde el navegador"
# La 0312 solo cambia CÓMO lead_routing_scope encuentra sus filas: la prueba
# vuelve a poner el cuerpo de la 0299 dentro de su transacción y exige la misma
# respuesta para cada asesora, tienda y lead.
echo "▶ lead_routing_scope sin recorrer leads entera (0312): misma respuesta que la 0299, lead suelto = cola entera, índices y permisos"
$PSQL -f "$ROOT/scripts/sql/lead_routing_scope_perf_smoke.sql"
echo "  ✅ 357 casos idénticos a la 0299 (actora × tiendas × cola, cada lead y uno inexistente; un lead suelto ya no cuenta ganados/perdidos); un lead suelto se bloquea igual que en la cola; índices de llamadas, carritos, paradas, conversación de Kapso y order_gid; una reconciliación de Yapes por tienda cada 10 s; solo service_role, stable, invoker"
echo "▶ Líneas compartidas de Anura (0313): línea sin dueña, número único en la org, casilla por persona, una llamada viva por línea y por persona, RLS"
$PSQL -f "$ROOT/scripts/sql/anura_line_pool_smoke.sql"
echo "  ✅ línea compartida sin dueña y anexo propio con dueña; un número es una sola cosa en la org; «Puede llamar con Anura» una por persona; dos llamadas vivas nunca comparten línea ni persona; terminada, la línea queda libre; las entrantes no ocupan líneas; la org lee y nadie escribe"
echo "▶ Conector de IA (0314): token solo como sha256 y único, pista corta, tiendas y permisos con rango, registro sin texto libre y solo el servidor"
$PSQL -f "$ROOT/scripts/sql/agent_tokens_smoke.sql"
echo "  ✅ el hash es único y nunca el token en claro; permisos de la lista cerrada (los de escritura ya existen); el registro guarda códigos, no lo que se preguntó; revocar deja el registro; anon y authenticated ni leen ni escriben"
echo "▶ Políticas escritas por tienda (0315): versión de la base, historial automático, tienda y autor fijos, retirada final, rangos y solo el servidor"
$PSQL -f "$ROOT/scripts/sql/store_policies_smoke.sql"
echo "  ✅ nace en la versión 1 y cada cambio suma uno (aunque se mande otra); cada versión queda en el historial, también la retirada; la tienda, la organización y el autor no cambian; retirada no se edita ni se deshace; el servidor no borra ni escribe el historial; el navegador no ve nada"
echo "▶ Confirmación por Chatby: ubicación aproximada (0316): posición que nace apagada, punto solo con «calle», el edificio intacto y RLS"
$PSQL -f "$ROOT/scripts/sql/chatby_approx_location_smoke.sql"
echo "  ✅ apagado / simulación / activo y nada más; una fila de la 0301 sigue igual; «calle» con sus dos coordenadas y un rechazo sin punto; ok/latitude/longitude no cambian; la org lee la posición, nadie la cambia ni lee la caché de Google desde el navegador"
echo "▶ Confirmación por Chatby: pedir sola la dirección o la ubicación (0318): posición que nace apagada, sus tres valores y RLS"
$PSQL -f "$ROOT/scripts/sql/chatby_auto_ask_smoke.sql"
echo "  ✅ apagado / simulación / activo y nada más, nunca nulo; la ubicación aproximada (0316) no cambia; la org lee la posición y nadie la cambia desde el navegador"
echo "▶ OAuth del conector de IA (0319): client_id con forma, código como sha256 con PKCE S256 y vencimiento corto, permisos cerrados, token con su cliente y solo el servidor"
$PSQL -f "$ROOT/scripts/sql/agent_oauth_smoke.sql"
echo "  ✅ client_id kcli_ y redirect_uris con rango; el código nunca en claro, desafío de 43 y a lo sumo 15 minutos; permisos de la lista cerrada; el token dice de qué cliente vino; el servidor marca usado pero no borra; el navegador no ve nada"
echo "▶ Fila del rastreo de Shalom (0321): sello de cuándo se preguntó, racha de not_found, sellos que no mueven updated_at e índice de la fila"
$PSQL -f "$ROOT/scripts/sql/shalom_checked_at_smoke.sql"
echo "  ✅ nacen sin sello y con la racha en cero, que no baja de cero; los sellos del rastreo no mueven updated_at (last_report_at y un cambio real sí); la nunca preguntada va primero"
echo "✅ DB verification passed."
