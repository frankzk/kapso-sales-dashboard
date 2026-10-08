// Aplicar la hoja revisada (MOM §29.7, 08-10-2026): pasa a la ruta los
// reprogramados que el motorizado conserva y reporta cada parada por el único
// camino de reporte (lib/stop-report.ts), en modo cuaderno.
//
// Se revalida TODO contra la base de ahora, no contra la de cuando se leyó la
// foto: entre leer y aplicar alguien pudo reportar una parada o recibir una
// devolución. Una fila que ya no cuadra se salta con su motivo; las demás se
// aplican. La importación se marca aplicada ANTES de escribir, así dos clics
// (o dos personas) no cargan la misma hoja dos veces; si algo falla, se vuelve
// a leer la hoja y lo ya reportado sale como «Ya reportada».

import { createAdminSupabase } from "@/lib/db";
import { getAdminOrgs } from "@/lib/access";
import { resolveAgentName } from "@/lib/agent-names";
import { limaDateKey } from "@/lib/aliclik-geo";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { writeStopReport } from "@/lib/stop-report";
import { loadNotebookContext, type NotebookStopRef, type NotebookTarget } from "@/lib/notebook-import-access";
import { notebookStopNote, outcomeCode, type NotebookDecision, type NotebookOutcome, type PlanRow } from "@/lib/notebook-import";

export interface NotebookApplyRow {
  index: number;
  item: number | null;
  orderName: string | null;
  ok: boolean;
  carried?: boolean;
  error?: string;
}

export interface NotebookApplyResult {
  reported: number;
  carried: number;
  failed: number;
  skipped: number;
  rows: NotebookApplyRow[];
  routeId: string | null;
}

/** Hasta `limit` tareas a la vez: cada reporte recalcula el Master de su pedido. */
async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

type Task = {
  decision: NotebookDecision;
  row: PlanRow;
  outcome: NotebookOutcome;
  carry: { shipmentId: string; orderId: string } | null;
  stop: NotebookStopRef | null;
  manualStop: boolean;
};

export async function applyNotebookImport(
  importId: string,
  decisions: NotebookDecision[],
  userId: string,
): Promise<{ ok: true; result: NotebookApplyResult } | { ok: false; status: number; error: string }> {
  const admin = createAdminSupabase();
  const { data: imp } = await admin
    .from("rider_notebook_imports")
    .select("id,org_id,rider_id,route_date,status,plan,transcription")
    .eq("id", importId)
    .maybeSingle();
  const row = imp as { id: string; org_id: string; rider_id: string; route_date: string; status: string; plan: PlanRow[] } | null;
  const orgs = await getAdminOrgs();
  if (!row || !orgs.some((o) => o.org_id === row.org_id)) return { ok: false, status: 404, error: "No encontramos esa hoja." };
  if (row.status !== "leida") return { ok: false, status: 409, error: "Esta hoja ya se aplicó. Si falta algo, vuelve a leer la foto: lo ya reportado no se repite." };

  // Se marca aplicada antes de escribir: dos clics no cargan dos veces.
  const { data: claimed } = await admin
    .from("rider_notebook_imports")
    .update({ status: "aplicada", applied_at: new Date().toISOString(), applied_by: userId })
    .eq("id", importId)
    .eq("status", "leida")
    .select("id");
  if (!claimed?.length) return { ok: false, status: 409, error: "Otra persona acaba de aplicar esta hoja." };

  const { data: rider } = await admin.from("riders").select("full_name").eq("id", row.rider_id).maybeSingle();
  const riderName = ((rider as { full_name?: string | null } | null)?.full_name ?? "").trim() || "el motorizado";
  const routeFor = async () => {
    const { data } = await admin
      .from("delivery_routes")
      .select("id,status")
      .eq("org_id", row.org_id)
      .eq("rider_id", row.rider_id)
      .eq("route_date", row.route_date)
      .maybeSingle();
    return data as { id: string; status: string } | null;
  };
  const route = await routeFor();
  const target: NotebookTarget = {
    orgId: row.org_id, riderId: row.rider_id, riderName, routeDate: row.route_date,
    routeId: route?.id ?? null, routeStatus: route?.status ?? null, storeId: null,
  };
  const plan = Array.isArray(row.plan) ? row.plan : [];
  const { ctx, stops } = await loadNotebookContext(target, plan.map((r) => r.line), admin);

  const results: NotebookApplyRow[] = [];
  const fail = (r: PlanRow | undefined, index: number, error: string) =>
    results.push({ index, item: r?.line.item ?? null, orderName: r?.match.orderName ?? r?.line.order ?? null, ok: false, error });

  // 1. Qué se puede aplicar, contra la base de ahora.
  const used = new Set<string>();
  const tasks: Task[] = [];
  let skipped = 0;
  for (const decision of decisions) {
    const r = plan.find((p) => p.index === decision.index);
    if (decision.action === "omitir") { skipped++; continue; }
    if (!r) { fail(r, decision.index, "Esa fila no está en la hoja leída."); continue; }
    if (!decision.outcome) { fail(r, decision.index, "Elige qué pasó antes de cargarla."); continue; }
    // A mano solo se asigna una fila que no cruzó con nada (sin código o con
    // un código que no existe); lo anulado o de otra caja no se carga.
    const manualStop = Boolean(decision.stopId) && (r.match.kind === "sin_codigo" || r.match.kind === "no_existe");
    if (decision.action === "reportar") {
      const stopId = manualStop ? decision.stopId! : r.match.kind === "pendiente" ? r.match.stopId : null;
      const stop = stopId ? stops.get(stopId) ?? null : null;
      if (!stop) { fail(r, decision.index, "Esta fila no tiene una parada de la ruta a la que reportarse."); continue; }
      if (stop.status !== "pendiente") { fail(r, decision.index, "La parada ya no está pendiente: alguien la reportó después de leer la hoja."); continue; }
      if (used.has(stop.id)) { fail(r, decision.index, "Otra fila de la hoja ya se carga en esa parada."); continue; }
      used.add(stop.id);
      tasks.push({ decision, row: r, outcome: decision.outcome, carry: null, stop, manualStop });
      continue;
    }
    // pasar_y_reportar
    const carry = r.match.kind === "arrastre" ? ctx.carry.find((c) => c.shipmentId === r.match.shipmentId) ?? null : null;
    if (!carry) { fail(r, decision.index, `Ya no es un reprogramado que ${riderName} conserva en una caja anterior.`); continue; }
    if (used.has(carry.shipmentId)) { fail(r, decision.index, "Otra fila de la hoja ya pasa ese paquete."); continue; }
    used.add(carry.shipmentId);
    tasks.push({ decision, row: r, outcome: decision.outcome, carry: { shipmentId: carry.shipmentId, orderId: carry.orderId }, stop: null, manualStop: false });
  }

  // 2. Los reprogramados que conserva pasan a esta ruta, ya cotejados: todo o nada.
  const carryTasks = tasks.filter((t) => t.carry);
  let carried = 0;
  if (carryTasks.length) {
    const { error } = await admin.rpc("gf_carry_over", {
      p_rider_id: row.rider_id,
      p_to_date: row.route_date,
      p_shipment_ids: carryTasks.map((t) => t.carry!.shipmentId),
      p_actor: userId,
    });
    if (error) {
      for (const t of carryTasks) fail(t.row, t.decision.index, `No se pudo pasar a la ruta: ${error.message}`);
    } else {
      carried = carryTasks.length;
      const fresh = await routeFor();
      const { data: newStops } = fresh
        ? await admin
          .from("delivery_stops")
          .select("id,order_id,route_id,photo_path,voucher_path,status")
          .eq("route_id", fresh.id)
          .in("order_id", carryTasks.map((t) => t.carry!.orderId))
        : { data: [] };
      const byOrder = new Map(((newStops ?? []) as NotebookStopRef[]).map((s) => [s.order_id, s]));
      for (const t of carryTasks) t.stop = byOrder.get(t.carry!.orderId) ?? null;
    }
  }

  // 3. Cada parada, por el único camino de reporte, en modo cuaderno.
  const routeNow = await routeFor();
  const loadedBy = (await resolveAgentName(userId, admin)) ?? "Kapta";
  const loadedOn = limaDateKey();
  const reportable = tasks.filter((t) => t.stop && (!t.carry || carried));
  for (const t of tasks) if (t.carry && carried && !t.stop) fail(t.row, t.decision.index, "Pasó a la ruta, pero no apareció su parada: repórtala a mano.");
  const outcomes = await pool(reportable, 4, async (t) => {
    const written = t.row.interpretation.written || null;
    const rowForNote = t.manualStop
      ? { ...t.row, match: { ...t.row.match, via: null, kind: "pendiente" as const } }
      : t.row;
    const note = notebookStopNote({ riderName, routeDate: row.route_date, row: rowForNote, outcome: t.outcome, loadedBy, loadedOn });
    const res = await writeStopReport(
      admin,
      {
        stopId: t.stop!.id,
        status: t.outcome.status,
        paymentMethod: t.outcome.status === "entregado" ? t.outcome.method : null,
        collectedAmount: t.outcome.status === "entregado" ? t.outcome.amount : null,
        outcomeReason: t.outcome.status === "no_entregado" ? t.outcome.reason : null,
        note: t.manualStop ? `${note} Fila sin pedido en la hoja; quien cargó la asignó a esta parada.` : note,
        actor: userId,
        writtenStatus: written,
        writtenStatusCode: outcomeCode(t.outcome),
        writtenPayment: t.outcome.status === "entregado" ? written : null,
        notebook: { riderName, importId },
      },
      { stop: t.stop!, routeStatus: routeNow?.status },
    );
    return { t, res };
  });
  let reported = 0;
  for (const { t, res } of outcomes) {
    if (res.ok) {
      reported++;
      results.push({ index: t.decision.index, item: t.row.line.item, orderName: t.row.match.orderName ?? t.row.line.order, ok: true, carried: Boolean(t.carry) });
    } else {
      fail(t.row, t.decision.index, res.error);
    }
  }
  // Lo que pasó de ruta y no se pudo reportar igual cambió de caja: su etapa se recalcula.
  const carriedUnreported = outcomes.filter(({ t, res }) => t.carry && !res.ok).map(({ t }) => t.carry!.orderId);
  if (carriedUnreported.length) await recomputeOrderMasterSafe(admin, carriedUnreported).catch(() => undefined);

  results.sort((a, b) => a.index - b.index);
  const result: NotebookApplyResult = {
    reported,
    carried,
    failed: results.filter((r) => !r.ok).length,
    skipped,
    rows: results,
    routeId: routeNow?.id ?? null,
  };
  await admin.from("rider_notebook_imports").update({ result, route_id: routeNow?.id ?? null }).eq("id", importId);
  return { ok: true, result };
}
