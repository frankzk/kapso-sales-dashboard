import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { getStoreCreds } from "@/lib/ingest";
import { listOrders } from "@/lib/aliclik";
import { applyAliclikSnapshot, refreshAliclikOrder } from "@/lib/aliclik-track";
import { selectFollowUpGuides, type FollowUpCandidate } from "@/lib/aliclik-followup";
import { normalizePhone } from "@/lib/phone";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Red de seguridad del webhook.
//
// POR QUÉ HACE FALTA. El webhook de Aliclik no viene firmado, no trae timestamp
// y no hay ninguna garantía de entrega documentada: no se sabe si reintenta
// cuando respondemos != 2xx. Un canal así no puede ser la única fuente del
// estado de un pedido. Este barrido relee los últimos días y aplica lo que
// diga Aliclik, de modo que un aviso perdido cuesta como mucho un ciclo.
//
// ADEMÁS RESUELVE LOS HUÉRFANOS. Cuando una creación se va en timeout, no
// sabemos si el pedido existe: la intención se queda en 'pending' (y sigue
// bloqueando un segundo intento, que es lo correcto). Aquí se busca por teléfono
// entre los pedidos que Aliclik creó en esa ventana y, si aparece, se vincula.
// Sin esto, un timeout dejaría el pedido bloqueado para siempre.
//
// Y PERSIGUE A LAS REZAGADAS. La ventana de fechas cubre el ciclo normal, pero
// no el retorno: un paquete rechazado tarda semanas en volver, y para cuando
// Aliclik lo marca RETURNED su guía ya se cayó del rango. Por eso, tras el
// barrido, se consulta una por una a las guías que siguen vivas y que el rango
// no tocó (lib/aliclik-followup.ts). El ancla es el estado, no la fecha.

const DAY_MS = 86_400_000;
/** Días hacia atrás que se releen. Cubre de sobra un fin de semana caído. */
const LOOKBACK_DAYS = 14;
/** Antigüedad mínima de una intención para considerarla huérfana. */
const ORPHAN_MIN_AGE_MS = 5 * 60_000;
/**
 * Consultas individuales por tienda y pasada. Con el cron cada 20 minutos son
 * ~2.900 turnos al día: de sobra para una cola de rezagadas sana. Si
 * `followUpDeferred` no vuelve a cero entre pasadas, este tope se quedó corto.
 */
const FOLLOW_UP_LIMIT = 40;
/**
 * Cuándo se deja de preguntar por una guía que no responde. Un retorno tarda
 * semanas; dos meses de silencio ya es una guía que Aliclik nunca cerró.
 */
const FOLLOW_UP_MAX_SILENCE_MS = 60 * DAY_MS;

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

const dateKey = (d: Date) => d.toISOString().slice(0, 10);

interface StoreReport {
  storeId: string;
  scanned: number;
  applied: number;
  unknown: number;
  orphansLinked: number;
  /** Guías vivas consultadas de una en una tras el barrido por fechas. */
  followUpScanned: number;
  followUpApplied: number;
  /** Vivas que no cupieron en el tope de esta pasada; van en la siguiente. */
  followUpDeferred: number;
  /** Vivas que se dieron por abandonadas por llevar demasiado calladas. */
  followUpAbandoned: number;
  errors: string[];
}

const emptyReport = (storeId: string): StoreReport => ({
  storeId,
  scanned: 0,
  applied: 0,
  unknown: 0,
  orphansLinked: 0,
  followUpScanned: 0,
  followUpApplied: 0,
  followUpDeferred: 0,
  followUpAbandoned: 0,
  errors: [],
});

async function reconcileStore(
  storeId: string,
  apiToken: string,
  admin: ReturnType<typeof createAdminSupabase>,
): Promise<StoreReport> {
  const report = emptyReport(storeId);
  const now = new Date();
  const startDate = dateKey(new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS));
  const endDate = dateKey(now);

  // Intenciones que se quedaron sin respuesta. Se cargan ANTES del barrido para
  // poder emparejarlas con lo que devuelva Aliclik en la misma pasada.
  const { data: pending } = await admin
    .from("aliclik_order_requests")
    .select("id,order_id,request,created_at")
    .eq("store_id", storeId)
    .eq("status", "pending")
    .lt("created_at", new Date(now.getTime() - ORPHAN_MIN_AGE_MS).toISOString());

  const orphans = (pending ?? []).map((p) => {
    const req = (p.request ?? {}) as { customer?: { phone?: string } };
    return { id: p.id, orderId: p.order_id, phone: normalizePhone(req.customer?.phone ?? null) };
  });

  // Lo que el barrido por fechas alcanza a ver. Sirve para no volver a
  // preguntar por ello en el pase de rezagadas.
  const scanned = new Set<string>();

  for (let page = 1; page <= 50; page++) {
    const res = await listOrders({ apiToken }, { page, limit: 100, startDate, endDate });
    if (!res.ok) {
      report.errors.push(res.error);
      break;
    }
    const rows = res.data.data ?? [];
    if (!rows.length) break;

    for (const order of rows) {
      report.scanned++;
      const seen = (order.orderNumber ?? "").trim();
      if (seen) scanned.add(seen);
      const applied = await applyAliclikSnapshot(order, admin);
      if (applied.outcome === "applied") report.applied++;
      else if (applied.outcome === "unknown_order") {
        report.unknown++;

        // ¿Es el pedido de una creación que se fue en timeout? Se empareja por
        // teléfono, que es el único dato estable que enviamos y que Aliclik
        // devuelve.
        const phone = normalizePhone(order.customer?.phone ?? null);
        const orphan = phone ? orphans.find((o) => o.phone && o.phone === phone) : undefined;
        if (orphan && order.orderNumber) {
          const { error } = await admin
            .from("shipments")
            .update({ external_order_number: order.orderNumber })
            .eq("order_id", orphan.orderId)
            .eq("courier", "aliclik")
            .is("external_order_number", null);
          if (!error) {
            await admin
              .from("aliclik_order_requests")
              .update({
                status: "sent",
                order_number: order.orderNumber,
                completed_at: new Date().toISOString(),
                error: "Vinculado por el barrido tras un timeout de creación.",
              })
              .eq("id", orphan.id);
            report.orphansLinked++;
            // Ya no está huérfana: no volver a usarla en esta pasada.
            orphans.splice(orphans.indexOf(orphan), 1);
          }
        }
      }
    }

    const totalPages = res.data.pagination?.totalPages ?? 1;
    if (page >= (totalPages || 1)) break;
  }

  await followUpLiveGuides(storeId, apiToken, admin, scanned, now, report);

  return report;
}

/**
 * Segundo pase: las guías vivas a las que la ventana de fechas ya no llega.
 *
 * Se consultan de una en una porque no hay forma de pedirle a Aliclik "estas
 * guías concretas" — solo rangos y búsqueda por número. El coste está acotado
 * por `FOLLOW_UP_LIMIT` y por el propio universo: solo las guías creadas por API
 * tienen `external_order_number`, así que las que entraron por Excel ni entran
 * en la cuenta.
 *
 * Un fallo aquí no rompe la pasada: el barrido por fechas ya se aplicó y esto
 * es trabajo extra que puede reintentarse en veinte minutos.
 */
async function followUpLiveGuides(
  storeId: string,
  apiToken: string,
  admin: ReturnType<typeof createAdminSupabase>,
  scanned: ReadonlySet<string>,
  now: Date,
  report: StoreReport,
): Promise<void> {
  const { data, error } = await admin
    .from("shipments")
    .select("id,external_order_number,delivery_status,last_report_at,created_at")
    .eq("store_id", storeId)
    .eq("courier", "aliclik")
    .not("external_order_number", "is", null);

  if (error) {
    report.errors.push(`seguimiento: ${error.message}`);
    return;
  }

  const selection = selectFollowUpGuides((data ?? []) as FollowUpCandidate[], {
    scanned,
    limit: FOLLOW_UP_LIMIT,
    maxSilenceMs: FOLLOW_UP_MAX_SILENCE_MS,
    now,
  });
  report.followUpDeferred = selection.deferred;
  report.followUpAbandoned = selection.abandoned;

  for (const guide of selection.due) {
    const orderNumber = (guide.external_order_number ?? "").trim();
    report.followUpScanned++;
    try {
      const res = await refreshAliclikOrder(orderNumber, { apiToken }, admin);
      if (res.outcome === "applied") report.followUpApplied++;
      else if (res.outcome === "error" && res.error) {
        report.errors.push(`seguimiento ${orderNumber}: ${res.error}`);
      }
    } catch (e) {
      report.errors.push(
        `seguimiento ${orderNumber}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

async function run(req: NextRequest) {
  if (!authorized(req)) return new NextResponse("unauthorized", { status: 401 });

  const admin = createAdminSupabase();
  const single = req.nextUrl.searchParams.get("storeId");

  let storeIds: string[];
  if (single) {
    storeIds = [single];
  } else {
    const { data, error } = await admin.from("stores").select("id").eq("status", "active");
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    storeIds = (data ?? []).map((s: { id: string }) => s.id);
  }

  const reports: StoreReport[] = [];
  for (const storeId of storeIds) {
    const creds = await getStoreCreds(storeId, admin);
    if (!creds?.aliclik_api_token) continue;
    try {
      reports.push(await reconcileStore(storeId, creds.aliclik_api_token, admin));
    } catch (e) {
      reports.push({
        ...emptyReport(storeId),
        errors: [e instanceof Error ? e.message : String(e)],
      });
    }
  }

  return NextResponse.json({ ok: true, reports });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
