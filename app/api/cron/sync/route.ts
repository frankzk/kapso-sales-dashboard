import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { runStoreSync } from "@/lib/ingest";
import { alertUnattendedYapes } from "@/lib/yape-alert-telegram";
import { alertCollectMismatches } from "@/lib/collect-alert";
import { assignPendingExperimentArms } from "@/lib/lead-experiment-assign";
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

  // Reparto de brazos del experimento de la hora dorada.
  //
  // VA AQUÍ, DESPUÉS DEL SYNC, y no en el propio ingreso: la elegibilidad mira
  // `first_inbound_text`, que se escribe en una segunda pasada (write-once, ver
  // leads-ingest). Repartiendo en el insert, un lead que llegó desde la ficha de
  // un producto todavía la tendría en null y entraría al estudio por error.
  //
  // Best-effort, como las dos alertas de arriba: si el reparto falla se pierde
  // una tanda de asignaciones —telemetría de un experimento—, y eso nunca puede
  // tumbar la sincronización de pedidos.
  let experimento = { asignados: 0, tratamiento: 0 };
  try {
    const r = await assignPendingExperimentArms(admin, storeIds);
    experimento = { asignados: r.asignados, tratamiento: r.tratamiento };
  } catch {
    /* ignore — el experimento nunca bloquea el sync */
  }

  return NextResponse.json({
    ok: true,
    stores: storeIds.length,
    yapeAlerts,
    collectAlerts,
    experimento,
    reports,
  });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
