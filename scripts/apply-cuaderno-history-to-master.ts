/**
 * Aplica al Master, en bloque y por la puerta única (lib/master-door.ts), las
 * entregas de la historia del cuaderno que Kapta todavía tiene abiertas.
 *
 *   pnpm tsx scripts/apply-cuaderno-history-to-master.ts <org_id> <actor_user_id> [--real]
 *
 * Sin `--real` es un ensayo: cuenta por hoja y mes y no escribe nada. Con
 * `--real` guarda primero en `master_backfill_log` (0181) cómo estaba cada
 * pedido y después inserta los eventos; el `batch_id` que imprime es lo que
 * necesita `scripts/rollback-master-backfill.ts` para deshacerlo.
 *
 * Qué entra: por cada pedido de Lima con estado general pendiente o en
 * proceso, la fila más reciente de una hoja cuaderno (Reparto propio o
 * Courier externo) cuyo estado tenga efecto «entrega». Qué NO entra: pedidos
 * con alguna observación abierta (MOM §30.8), pedidos anulados en Shopify,
 * filas sin pedido. Mismas guardas que el botón «Aplicar entregas del periodo».
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^([A-Z_]+)="?([^"]*)"?$/.exec(line);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
    }
  }
}

type Row = {
  id: string;
  order_id: string;
  sheet_id: string;
  row_key: string;
  stop_id: string | null;
  values: Record<string, unknown>;
  sheet: { key: string; name: string; config: Record<string, unknown> | null; domain: { key: string } };
};

async function main() {
  loadEnv();
  const [orgId, actor, ...flags] = process.argv.slice(2);
  const real = flags.includes("--real");
  if (!orgId || !actor) {
    console.error("uso: tsx scripts/apply-cuaderno-history-to-master.ts <org_id> <actor_user_id> [--real]");
    process.exit(1);
  }
  const { createAdminSupabase } = await import("@/lib/db");
  const { applyDeliveriesToMaster } = await import("@/lib/master-door");
  const { markForEffect } = await import("@/lib/sheets/statuses");
  const admin = createAdminSupabase();

  // Estados con efecto entrega por dominio.
  const { data: statuses } = await admin
    .from("sheet_domain_statuses")
    .select("domain_id,code,effect,sheet_domains!inner(org_id,key)")
    .eq("sheet_domains.org_id", orgId);
  const entrega = new Set(
    ((statuses ?? []) as { domain_id: string; code: string; effect: string }[])
      .filter((s) => markForEffect(s.effect as "entrega") === "E" && s.effect === "entrega")
      .map((s) => `${s.domain_id}:${s.code}`),
  );

  // Filas cuaderno vinculadas, por lotes.
  const rows: Row[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin
      .from("sheet_rows")
      .select("id,order_id,sheet_id,row_key,stop_id,values,sheet:sheets!inner(key,name,config,org_id,domain_id,domain:sheet_domains!inner(key))")
      .eq("sheet.org_id", orgId)
      .in("sheet.domain.key", ["reparto_propio", "courier_externo"])
      .not("order_id", "is", null)
      .order("id")
      .range(off, off + 999);
    if (error) throw new Error(error.message);
    const chunk = (data ?? []) as unknown as (Row & { sheet: Row["sheet"] & { domain_id: string } })[];
    for (const r of chunk) {
      const code = typeof r.values.estado === "string" ? r.values.estado : null;
      if (code && entrega.has(`${r.sheet.domain_id}:${code}`)) rows.push(r);
    }
    if (chunk.length < 1000) break;
  }
  // Una fila por pedido: la de fecha más reciente.
  const byOrder = new Map<string, Row>();
  for (const r of rows) {
    const prev = byOrder.get(r.order_id);
    const f = String(r.values.fecha ?? "");
    if (!prev || f > String(prev.values.fecha ?? "")) byOrder.set(r.order_id, r);
  }
  const orderIds = [...byOrder.keys()];

  // Estado actual del Master y observaciones abiertas.
  const master = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < orderIds.length; i += 200) {
    const { data } = await admin
      .from("order_master")
      .select("order_id,store_id,general_status,operational_status,status_source,status_locked,delivered_at,delivered_courier,current_courier,macro_stage,macro_substage,coverage,orders(cancelled_at)")
      .in("order_id", orderIds.slice(i, i + 200));
    for (const m of (data ?? []) as Record<string, unknown>[]) master.set(m.order_id as string, m);
  }
  const openByOrder = new Map<string, number>();
  for (let i = 0; i < orderIds.length; i += 200) {
    const { data } = await admin.from("sheet_observations").select("order_id").eq("status", "abierta").in("order_id", orderIds.slice(i, i + 200));
    for (const o of (data ?? []) as { order_id: string }[]) openByOrder.set(o.order_id, (openByOrder.get(o.order_id) ?? 0) + 1);
  }
  const stops = new Map<string, { status: string; photo_path: string | null; voucher_path: string | null; reported_by: string | null }>();
  const stopIds = [...byOrder.values()].map((r) => r.stop_id).filter((s): s is string => Boolean(s));
  for (let i = 0; i < stopIds.length; i += 200) {
    const { data } = await admin.from("delivery_stops").select("id,status,photo_path,voucher_path,reported_by").in("id", stopIds.slice(i, i + 200));
    for (const s of (data ?? []) as { id: string; status: string; photo_path: string | null; voucher_path: string | null; reported_by: string | null }[]) stops.set(s.id, s);
  }

  const skipped: Record<string, number> = {};
  const skip = (k: string) => (skipped[k] = (skipped[k] ?? 0) + 1);
  const candidates: { row: Row; m: Record<string, unknown> }[] = [];
  for (const [orderId, row] of byOrder) {
    const m = master.get(orderId);
    if (!m) { skip("sin_master"); continue; }
    if (m.coverage !== "lima") { skip("no_lima"); continue; }
    if (!["pendiente", "en_proceso"].includes(String(m.general_status))) { skip(`ya_${m.general_status}`); continue; }
    if ((m.orders as { cancelled_at: string | null } | null)?.cancelled_at) { skip("anulado_shopify"); continue; }
    if ((openByOrder.get(orderId) ?? 0) > 0) { skip("observacion_abierta"); continue; }
    if (row.stop_id && stops.get(row.stop_id)?.status !== "entregado") { skip("parada_no_entregada"); continue; }
    candidates.push({ row, m });
  }

  const perSheetMonth = new Map<string, number>();
  for (const c of candidates) {
    const k = `${c.row.sheet.name} ${String(c.row.values.fecha ?? "s/f").slice(0, 7)}`;
    perSheetMonth.set(k, (perSheetMonth.get(k) ?? 0) + 1);
  }
  console.log(`filas con entrega: ${rows.length} · pedidos únicos: ${orderIds.length} · a aplicar: ${candidates.length}`);
  console.log("saltados:", JSON.stringify(skipped));
  for (const [k, v] of [...perSheetMonth].sort()) console.log(`  ${k}: ${v}`);
  if (!real) { console.log("ensayo: no se escribió nada. Añade --real para aplicar."); return; }

  const batchId = crypto.randomUUID();
  const snapshotPath = `/private/tmp/claude-501/-Users-sergiomini-Documents-frankz-kapso-sales-dashboard/2ce242e6-6a04-4144-ab30-ec8289719cac/scratchpad/master-backfill-${batchId}.json`;
  writeFileSync(snapshotPath, JSON.stringify(candidates.map((c) => ({ order_id: c.row.order_id, previous: c.m, row_key: c.row.row_key, sheet: c.row.sheet.key })), null, 0));
  console.log(`lote ${batchId} · snapshot en ${snapshotPath}`);

  let applied = 0;
  const rejected: Record<string, number> = {};
  for (let i = 0; i < candidates.length; i += 200) {
    const slice = candidates.slice(i, i + 200);
    // 1) bitácora del estado anterior
    const { error: logErr } = await admin.from("master_backfill_log").insert(
      slice.map(({ row, m }) => ({
        batch_id: batchId,
        order_id: row.order_id,
        store_id: m.store_id,
        sheet_id: row.sheet_id,
        row_id: row.id,
        previous_general: m.general_status,
        previous_operational: m.operational_status,
        previous_source: m.status_source,
        previous_locked: m.status_locked,
        previous_delivered_at: m.delivered_at,
        previous_courier: m.delivered_courier ?? m.current_courier,
        previous_macro_stage: m.macro_stage,
        previous_macro_substage: m.macro_substage,
        applied_status: "entregado",
        applied_courier: courierOf(row),
        applied_occurred_at: occurredAt(row),
        note: `Carga histórica del cuaderno · ${row.sheet.name} · ${row.row_key}`,
      })),
    );
    if (logErr) throw new Error(`bitácora: ${logErr.message}`);
    // 2) la puerta única
    const result = await applyDeliveriesToMaster(
      admin,
      slice.map(({ row }) => ({
        orderId: row.order_id,
        storeId: (master.get(row.order_id)?.store_id as string) ?? null,
        target: "entregado" as const,
        source: "liquidacion" as const,
        courier: courierOf(row),
        occurredAt: occurredAt(row),
        actor,
        reason: `Carga histórica del cuaderno (${row.sheet.name}, ${String(row.values.fecha ?? "")})`,
        payload: { batch_id: batchId, sheet_key: row.sheet.key, row_key: row.row_key, fecha: row.values.fecha ?? null, backfill: true },
        guard: { openObservations: openByOrder.get(row.order_id) ?? 0, stop: row.stop_id ? (stops.get(row.stop_id) ?? null) : null, requireEvidence: true },
      })),
    );
    if (result.error) throw new Error(`puerta única: ${result.error}`);
    applied += result.applied.length;
    for (const r of result.rejected) rejected[r.code] = (rejected[r.code] ?? 0) + 1;
    // 3) atar el evento a la bitácora
    const { data: events } = await admin
      .from("order_events")
      .select("id,order_id")
      .eq("kind", "status_override")
      .filter("payload->>batch_id", "eq", batchId)
      .in("order_id", slice.map((c) => c.row.order_id));
    for (const e of (events ?? []) as { id: string; order_id: string }[]) {
      await admin.from("master_backfill_log").update({ event_id: e.id }).eq("batch_id", batchId).eq("order_id", e.order_id);
    }
    console.log(`  ${Math.min(i + 200, candidates.length)}/${candidates.length}`);
  }
  console.log(`aplicados: ${applied} · rechazados por la puerta: ${JSON.stringify(rejected)} · lote: ${batchId}`);

  function courierOf(row: Row): string {
    const cfg = row.sheet.config ?? {};
    if (row.sheet.domain.key === "courier_externo") return String(cfg.courier ?? row.sheet.key.replace(/^courier_/, ""));
    return "propio";
  }
  function occurredAt(row: Row): string {
    const f = String(row.values.fecha ?? "");
    const now = new Date().toISOString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return now;
    const at = `${f}T17:00:00.000Z`;
    // Una fecha futura es un error de tecleo del cuaderno: no se entrega mañana.
    return at > now ? now : at;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
