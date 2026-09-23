/**
 * Completa Rutas hacia atrás con la historia que ya está en Liquidaciones 2
 * (MOM §29.12). Para cada fila de una hoja de Reparto propio con pedido en
 * Kapta, fecha válida y sin parada, crea (o reutiliza) la ruta cerrada del
 * motorizado ese día y su parada, y ata la fila a la parada.
 *
 *   pnpm tsx scripts/backfill-stops-from-sheets.ts <org_id> [--dry-run] [Roy Yhoni …]
 *
 * Qué NO hace, a propósito: no emite order_events, no toca el Master, no crea
 * rider_settlements ni cierres de pago. Es historia; el cierre de cada pedido
 * sigue pasando por la puerta de Liquidaciones 2 con sus guardas. Las paradas
 * de backfill se distinguen por `reported_by is null` más la nota de la ruta;
 * para ellas la guarda de evidencia no aplica (no hay foto de 2025).
 *
 * Idempotente: filas con `stop_id` se saltan; paradas existentes (ruta,
 * pedido) se reutilizan y solo se rellenan sus campos vacíos.
 *
 * Método de pago sin dato en una fila ENTREGADA: la parada exige método para
 * `entregado` (0066), así que se pone `efectivo` —lo habitual en el cuaderno—
 * y `written_payment` queda null para que se vea que no se escribió.
 */
import { existsSync, readFileSync } from "node:fs";

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^([A-Z_]+)="?([^"]*)"?$/.exec(line);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
    }
  }
}

type Row = { id: string; sheet_id: string; order_id: string; row_key: string; values: Record<string, unknown> };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const [orgId, ...only] = args.filter((a) => !a.startsWith("--"));
  if (!orgId) {
    console.error("uso: tsx scripts/backfill-stops-from-sheets.ts <org_id> [--dry-run] [Roy Yhoni …]");
    process.exit(1);
  }
  const { createAdminSupabase } = await import("@/lib/db");
  const { domainStatusToStop, sheetPaymentToStop } = await import("@/lib/sheets/stop-bridge");
  const { effectsForDomain } = await import("@/lib/sheets/reparto-import-db");
  const admin = createAdminSupabase();

  const { data: sheets } = await admin
    .from("sheets")
    .select("id,name,key,domain_id,config,sheet_domains!inner(key)")
    .eq("org_id", orgId)
    .eq("sheet_domains.key", "reparto_propio");
  const list = ((sheets ?? []) as unknown as { id: string; name: string; key: string; domain_id: string; config: Record<string, unknown> | null }[])
    .filter((s) => !only.length || only.some((n) => s.key === `reparto_${n.toLowerCase()}`));
  console.log(`${dryRun ? "[dry-run] " : ""}${list.length} hojas de Reparto propio`);

  const totals = { routesCreated: 0, stopsCreated: 0, stopsReused: 0, rowsLinked: 0, rowsSkippedNoRider: 0, rowsSkippedNoOrder: 0, rowsSkippedBadDate: 0 };
  for (const sheet of list) {
    const riderId = str(sheet.config?.rider_id);
    const effects = await effectsForDomain(admin, sheet.domain_id);
    // Filas candidatas: con pedido y sin parada.
    const rows: Row[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await admin
        .from("sheet_rows")
        .select("id,sheet_id,order_id,row_key,values")
        .eq("sheet_id", sheet.id)
        .is("stop_id", null)
        .not("order_id", "is", null)
        .order("row_key")
        .range(off, off + 999);
      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as Row[]));
      if ((data ?? []).length < 1000) break;
    }
    const { count: noOrder } = await admin.from("sheet_rows").select("id", { count: "exact", head: true }).eq("sheet_id", sheet.id).is("order_id", null);
    totals.rowsSkippedNoOrder += noOrder ?? 0;
    if (!riderId) {
      totals.rowsSkippedNoRider += rows.length;
      console.log(`- ${sheet.name}: sin ficha de motorizado (config.rider_id), ${rows.length} filas con pedido se quedan en la hoja; ${noOrder ?? 0} sin pedido`);
      continue;
    }
    const byDate = new Map<string, Row[]>();
    for (const r of rows) {
      const fecha = str(r.values.fecha);
      if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        totals.rowsSkippedBadDate += 1;
        continue;
      }
      byDate.set(fecha, [...(byDate.get(fecha) ?? []), r]);
    }
    // Tienda de cada pedido.
    const orderIds = [...new Set(rows.map((r) => r.order_id))];
    const storeOf = new Map<string, string>();
    for (let i = 0; i < orderIds.length; i += 300) {
      const { data } = await admin.from("orders").select("id,store_id").in("id", orderIds.slice(i, i + 300));
      for (const o of (data ?? []) as { id: string; store_id: string }[]) storeOf.set(o.id, o.store_id);
    }
    let sheetRoutes = 0;
    let sheetStops = 0;
    let sheetReused = 0;
    for (const [fecha, dayRows] of [...byDate].sort()) {
      const firstStore = storeOf.get(dayRows[0]!.order_id);
      if (!firstStore) continue;
      let routeId: string | null = null;
      const { data: existingRoute } = await admin
        .from("delivery_routes")
        .select("id")
        .eq("org_id", orgId)
        .eq("rider_id", riderId)
        .eq("route_date", fecha)
        .limit(1)
        .maybeSingle();
      if (existingRoute) routeId = existingRoute.id as string;
      else if (!dryRun) {
        const closedAt = new Date(`${fecha}T23:59:59-05:00`).toISOString();
        const { data: created, error } = await admin
          .from("delivery_routes")
          .insert({
            org_id: orgId,
            store_id: firstStore,
            rider_id: riderId,
            route_date: fecha,
            status: "cerrada",
            started_at: `${fecha}T13:00:00.000Z`,
            closed_at: closedAt,
            note: "Completada desde el cuaderno histórico (Liquidaciones 2)",
          })
          .select("id")
          .single();
        if (error || !created) throw new Error(`No se pudo crear la ruta ${sheet.name} ${fecha}: ${error?.message}`);
        routeId = created.id as string;
        sheetRoutes += 1;
      } else {
        sheetRoutes += 1;
      }
      const existingStops = new Map<string, { id: string; written_status: string | null; written_payment: string | null; note: string | null }>();
      if (routeId) {
        const { data: stops } = await admin.from("delivery_stops").select("id,order_id,written_status,written_payment,note").eq("route_id", routeId);
        for (const st of (stops ?? []) as { id: string; order_id: string; written_status: string | null; written_payment: string | null; note: string | null }[]) existingStops.set(st.order_id, st);
      }
      for (const r of dayRows) {
        const v = r.values;
        const estado = str(v.estado);
        const target = domainStatusToStop(estado, estado ? (effects.get(estado) ?? null) : null);
        const status = target?.status ?? "pendiente";
        const isDelivered = status === "entregado";
        let method = sheetPaymentToStop(str(v.metodo_pago));
        if (isDelivered && !method) method = "efectivo";
        const efectivo = num(v.efectivo);
        const aCobrar = num(v.a_cobrar);
        const collected = isDelivered ? (method === "efectivo" ? (efectivo ?? aCobrar) : method === "sin_cobro" ? 0 : aCobrar) : null;
        const note = [str(v.observacion_1), str(v.observacion_2)].filter(Boolean).join(" · ") || null;
        const puntoNum = /(\d+)\s*$/.exec(str(v.punto) ?? "")?.[1];
        const existing = existingStops.get(r.order_id);
        let stopId: string | null = existing?.id ?? null;
        if (existing) {
          sheetReused += 1;
          if (!dryRun) {
            const patch: Record<string, unknown> = {};
            if (!existing.written_status && str(v.estado_reportado)) patch.written_status = str(v.estado_reportado);
            if (!existing.written_status && estado) patch.written_status_code = estado;
            if (!existing.written_payment && str(v.metodo_pago_reportado)) patch.written_payment = str(v.metodo_pago_reportado);
            if (!existing.note && note) patch.note = note;
            if (Object.keys(patch).length) await admin.from("delivery_stops").update(patch).eq("id", existing.id);
          }
        } else if (!dryRun && routeId) {
          const { data: created, error } = await admin
            .from("delivery_stops")
            .insert({
              route_id: routeId,
              order_id: r.order_id,
              store_id: storeOf.get(r.order_id) ?? firstStore,
              seq: puntoNum ? Number(puntoNum) : 0,
              status,
              payment_method: isDelivered ? method : null,
              collected_amount: collected,
              outcome_reason: status === "no_entregado" ? target?.outcome_reason ?? "otro" : null,
              note,
              written_status: str(v.estado_reportado),
              written_status_code: estado,
              written_payment: str(v.metodo_pago_reportado),
              reported_at: status === "pendiente" ? null : `${fecha}T17:00:00.000Z`,
              reported_by: null,
            })
            .select("id")
            .single();
          if (error || !created) throw new Error(`No se pudo crear la parada ${sheet.name} ${fecha} ${r.row_key}: ${error?.message}`);
          stopId = created.id as string;
          existingStops.set(r.order_id, { id: stopId, written_status: str(v.estado_reportado), written_payment: str(v.metodo_pago_reportado), note });
          sheetStops += 1;
        } else {
          sheetStops += 1;
        }
        if (!dryRun && stopId) {
          const { error } = await admin.from("sheet_rows").update({ stop_id: stopId }).eq("id", r.id);
          if (error) {
            // Otra fila del mismo día ya apunta a esa parada (pedido repetido en el día): se deja sin vínculo.
            if (error.code !== "23505") throw new Error(`No se pudo atar la fila ${r.row_key}: ${error.message}`);
          } else totals.rowsLinked += 1;
        } else if (dryRun && stopId !== undefined) totals.rowsLinked += 1;
      }
    }
    totals.routesCreated += sheetRoutes;
    totals.stopsCreated += sheetStops;
    totals.stopsReused += sheetReused;
    console.log(`- ${sheet.name}: ${rows.length} filas con pedido y sin parada · rutas ${sheetRoutes} · paradas nuevas ${sheetStops}, reutilizadas ${sheetReused} · sin pedido en Kapta ${noOrder ?? 0}`);
  }
  console.log(`${dryRun ? "[dry-run] " : ""}TOTAL: rutas ${totals.routesCreated}, paradas nuevas ${totals.stopsCreated}, reutilizadas ${totals.stopsReused}, filas atadas ${totals.rowsLinked}, sin ficha ${totals.rowsSkippedNoRider}, sin pedido ${totals.rowsSkippedNoOrder}, fecha inválida ${totals.rowsSkippedBadDate}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
