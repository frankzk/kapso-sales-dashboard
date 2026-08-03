import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { chunk } from "@/lib/access";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { latestReportDeliveryDate, reportDeliveryClosedAt } from "@/lib/report-dates";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Corrige la FECHA DE ENTREGA de las guías reenganchadas por el backfill.
//
// EL PROBLEMA. Las guías que entraron por reporte nunca tuvieron `closed_at`.
// Al reengancharlas, el Master deriva la fecha de entrega de `updated_at` —que
// el propio backfill tocó HOY— y 1.112 pedidos entregados en junio/julio
// aparecen "entregados hoy", inflando las métricas del día.
//
// LA FECHA REAL está en el Excel original, guardado en `import_rows`
// ("FECHA ENTREGA"). Se escribe en `closed_at`, que es el primer campo que mira
// `deliveredAt`, y se recalcula el Master. Idempotente: una guía con `closed_at`
// ya puesto deja de ser candidata.
//
// ALCANCE ACOTADO al backfill (`match_method='report_backfill'`) a propósito: no
// se tocan fechas históricas de guías que ya venían con su cronología.

const BATCH = 400;

function secretEquals(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  const bearer = req.headers.get("authorization");
  if (bearer?.startsWith("Bearer ") && secretEquals(bearer.slice(7), secret)) return true;
  return secretEquals(req.nextUrl.searchParams.get("secret"), secret);
}

async function run(req: NextRequest) {
  if (!authorized(req)) return new NextResponse("unauthorized", { status: 401 });

  const admin = createAdminSupabase();
  const limit = Math.min(
    2000,
    Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? BATCH) || BATCH),
  );
  const apply = req.nextUrl.searchParams.get("apply") === "true";

  // 1. Guías del backfill, entregadas, sin fecha de cierre.
  const { data: shipRows, error: shipErr } = await admin
    .from("shipments")
    .select("id,order_id")
    .eq("match_method", "report_backfill")
    .eq("delivery_status", "entregado")
    .is("closed_at", null)
    .limit(limit);
  if (shipErr) return NextResponse.json({ ok: false, error: shipErr.message }, { status: 500 });
  const ships = (shipRows ?? []) as { id: string; order_id: string | null }[];
  if (!ships.length) {
    return NextResponse.json({ ok: true, apply, scanned: 0, fixed: 0, noDate: 0 });
  }

  // 2. Sus filas de import con la FECHA ENTREGA cruda (puede haber varias).
  const datesByShip = new Map<string, string[]>();
  for (const batch of chunk(ships.map((s) => s.id), 200)) {
    const { data, error } = await admin
      .from("import_rows")
      .select("shipment_id,raw")
      .in("shipment_id", batch);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    for (const r of (data ?? []) as { shipment_id: string; raw: Record<string, unknown> }[]) {
      const value = r.raw?.["FECHA ENTREGA"];
      const list = datesByShip.get(r.shipment_id) ?? [];
      list.push(typeof value === "string" ? value : "");
      datesByShip.set(r.shipment_id, list);
    }
  }

  // 3. Plan: por guía, la entrega más reciente de sus reportes.
  const updates: { id: string; orderId: string | null; closedAt: string }[] = [];
  let noDate = 0;
  for (const s of ships) {
    const date = latestReportDeliveryDate(datesByShip.get(s.id) ?? []);
    if (!date) {
      noDate += 1;
      continue;
    }
    updates.push({ id: s.id, orderId: s.order_id, closedAt: reportDeliveryClosedAt(date) });
  }

  if (!apply) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      scanned: ships.length,
      wouldFix: updates.length,
      noDate,
      hint: "Añade ?apply=true para ejecutar.",
    });
  }

  // 4. Escribir closed_at (guard: solo si sigue null) y recalcular.
  let fixed = 0;
  const failures: string[] = [];
  const affectedOrders: string[] = [];
  for (const u of updates) {
    const { error, count } = await admin
      .from("shipments")
      .update({ closed_at: u.closedAt }, { count: "exact" })
      .eq("id", u.id)
      .is("closed_at", null);
    if (error) {
      failures.push(`${u.id}: ${error.message}`);
      continue;
    }
    if (count && count > 0) {
      fixed += 1;
      if (u.orderId) affectedOrders.push(u.orderId);
    }
  }
  for (const batch of chunk(affectedOrders, 200)) {
    await recomputeOrderMasterSafe(admin, batch);
  }

  return NextResponse.json({
    ok: true,
    dryRun: false,
    scanned: ships.length,
    fixed,
    recomputed: affectedOrders.length,
    noDate,
    failures: failures.slice(0, 20),
    failureCount: failures.length,
  });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
