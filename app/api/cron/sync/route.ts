import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { runStoreSync } from "@/lib/ingest";
import { alertUnattendedYapes } from "@/lib/yape-alert-telegram";
import { alertCollectMismatches } from "@/lib/collect-alert";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Constant-time equality (length-gated) to avoid leaking the secret via timing. */
function secretEquals(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically.
  const bearer = req.headers.get("authorization");
  if (bearer?.startsWith("Bearer ") && secretEquals(bearer.slice(7), secret)) return true;
  return secretEquals(req.nextUrl.searchParams.get("secret"), secret);
}

async function run(req: NextRequest) {
  if (!authorized(req)) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const admin = createAdminSupabase();

  // Optionally target one store (?storeId=...), else sync all active stores.
  const single = req.nextUrl.searchParams.get("storeId");
  let storeIds: string[];
  if (single) {
    storeIds = [single];
  } else {
    const { data, error } = await admin.from("stores").select("id").eq("status", "active");
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    storeIds = (data ?? []).map((s: { id: string }) => s.id);
  }

  const reports = [];
  for (const id of storeIds) {
    try {
      // El barrido del Master NO va aquí: colgado del final de esta cola, la
      // segunda tienda se quedaba sin él (ver la cabecera de
      // /api/cron/master-reconcile, que ahora lo hace con reloj propio).
      reports.push(await runStoreSync(id, admin, { skipMasterReconcile: true }));
    } catch (e) {
      reports.push({ storeId: id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Off-hours safety net: ping Telegram about Yapes nobody has taken in a while
  // (the advisor rotation is poll-driven, so it can't alert when no one is on).
  // Best-effort — a Telegram failure must never fail the sync.
  let yapeAlerts = 0;
  for (const id of storeIds) {
    try {
      const r = await alertUnattendedYapes(id, admin);
      yapeAlerts += r.alerted;
    } catch {
      /* ignore — alerting is best-effort */
    }
  }

  // Guías que van a cobrar lo que no toca — de más sobre el total, o cualquier
  // cosa sobre un pedido YA PAGADO. El dato (`reported_collect_amount`) lo
  // refresca el cron de Aliclik cada 20 minutos desde la migración 0060; hasta
  // ahora nadie lo miraba. Caduca con la entrega, así que va por el mismo canal
  // que los Yape sin atender y con el mismo trato: best-effort, nunca tumba la
  // sincronización.
  let collectAlerts = 0;
  for (const id of storeIds) {
    try {
      const r = await alertCollectMismatches(id, admin);
      collectAlerts += r.alerted;
    } catch {
      /* ignore — alerting is best-effort */
    }
  }

  return NextResponse.json({
    ok: true,
    stores: storeIds.length,
    yapeAlerts,
    collectAlerts,
    reports,
  });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
