import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { getStoreCreds } from "@/lib/ingest";
import { listOrders } from "@/lib/aliclik";
import { applyAliclikSnapshot } from "@/lib/aliclik-track";
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

const DAY_MS = 86_400_000;
/** Días hacia atrás que se releen. Cubre de sobra un fin de semana caído. */
const LOOKBACK_DAYS = 14;
/** Antigüedad mínima de una intención para considerarla huérfana. */
const ORPHAN_MIN_AGE_MS = 5 * 60_000;

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
  errors: string[];
}

async function reconcileStore(
  storeId: string,
  apiToken: string,
  admin: ReturnType<typeof createAdminSupabase>,
): Promise<StoreReport> {
  const report: StoreReport = {
    storeId,
    scanned: 0,
    applied: 0,
    unknown: 0,
    orphansLinked: 0,
    errors: [],
  };
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

  return report;
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
        storeId,
        scanned: 0,
        applied: 0,
        unknown: 0,
        orphansLinked: 0,
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
