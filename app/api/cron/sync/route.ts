import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { runStoreSync } from "@/lib/ingest";
import { alertUnattendedYapes } from "@/lib/yape-alert-telegram";
import { createDeadline } from "@/lib/deadline";
import { mapWithConcurrency, orderByStaleness, summarizeRun, logRunSummary } from "@/lib/sync-schedule";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Presupuesto de la corrida.
//
// Vercel mata la función a los `maxDuration` segundos sin avisar ni dejar
// reporte: el error que se ve es "Task timed out after 300 seconds", sin decir
// en qué tienda ni en qué etapa. Esta corrida se lo pone a sí misma más bajo
// para terminar por su cuenta y responder, que es lo que deja rastro.
const RESPONSE_RESERVE_MS = 20_000;
// Derivado de `maxDuration`, no un 300_000 a mano: si alguien sube el techo de
// la función y el presupuesto se queda en el número viejo, la corrida se frena
// antes de tiempo sin que nada lo delate.
const RUN_BUDGET_MS = maxDuration * 1_000 - RESPONSE_RESERVE_MS;

// Cuántas tiendas se sincronizan a la vez. Cada tienda habla con SU Shopify y SU
// Kapso, con credenciales distintas, así que solapar dos no comparte cupo de
// rate limit con nadie; lo único compartido es Supabase, que aguanta de sobra.
// En serie, dos tiendas de ~3 min cada una ya no cabían en 5 minutos.
const STORE_CONCURRENCY = 2;

// Coste estimado del aviso de Yapes sin atender de una tienda.
const YAPE_ALERT_COST_MS = 8_000;

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
  const startedAt = Date.now();
  const deadline = createDeadline(RUN_BUDGET_MS);

  // Optionally target one store (?storeId=...), else sync all active stores.
  const single = req.nextUrl.searchParams.get("storeId");
  let storeIds: string[];
  if (single) {
    storeIds = [single];
  } else {
    const { data, error } = await admin.from("stores").select("id").eq("status", "active");
    if (error) {
      // También se resume: una corrida que ni llegó a listar tiendas tiene que
      // dejar rastro en los logs, no solo un 500 mudo.
      logRunSummary(
        summarizeRun({
          budgetMs: RUN_BUDGET_MS,
          elapsedMs: Date.now() - startedAt,
          remainingMs: deadline.remainingMs(),
          stores: 0,
          yapeAlerts: 0,
          reports: [{ storeId: "-", error: error.message }],
        }),
      );
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    storeIds = await orderByStaleness(admin, (data ?? []).map((s: { id: string }) => s.id));
  }

  // Todas las tiendas comparten el mismo presupuesto porque comparten la misma
  // invocación: el reloj es uno solo. Cada `runStoreSync` decide por su cuenta
  // qué etapas le caben en lo que queda.
  const reports = await mapWithConcurrency(storeIds, STORE_CONCURRENCY, async (id) => {
    try {
      return await runStoreSync(id, admin, { deadline });
    } catch (e) {
      return { storeId: id, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // Off-hours safety net: ping Telegram about Yapes nobody has taken in a while
  // (the advisor rotation is poll-driven, so it can't alert when no one is on).
  // Best-effort — a Telegram failure must never fail the sync.
  let yapeAlerts = 0;
  for (const id of storeIds) {
    // Si no queda tiempo, el aviso espera a la corrida de dentro de 5 minutos:
    // llegar tarde a un Yape es mucho mejor que morir aquí y perder el reporte.
    if (!deadline.hasRoomFor(YAPE_ALERT_COST_MS)) break;
    try {
      const r = await alertUnattendedYapes(id, admin);
      yapeAlerts += r.alerted;
    } catch {
      /* ignore — alerting is best-effort */
    }
  }

  // El resumen va a los logs de ejecución, que es donde SÍ se puede consultar
  // después: el cuerpo de la respuesta de un cron no lo guarda nadie.
  const summary = summarizeRun({
    budgetMs: RUN_BUDGET_MS,
    elapsedMs: Date.now() - startedAt,
    remainingMs: deadline.remainingMs(),
    stores: storeIds.length,
    yapeAlerts,
    reports,
  });
  logRunSummary(summary);

  const partial = summary.partial;
  return NextResponse.json({
    ok: true,
    stores: storeIds.length,
    // `partial: true` no es un fallo: la corrida se quedó sin presupuesto y dejó
    // etapas anotadas en `skipped` para la siguiente. Sirve para vigilar si el
    // atraso se vuelve crónico en vez de puntual.
    partial,
    remainingMs: deadline.remainingMs(),
    yapeAlerts,
    reports,
  });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
