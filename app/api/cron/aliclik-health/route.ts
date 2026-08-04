import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { chunk } from "@/lib/access";
import { getStoreCreds } from "@/lib/ingest";
import { pickTopWarehouse } from "@/lib/aliclik-tariffs";
import { runAliclikHealthProbe, withinBusinessHoursPeru } from "@/lib/aliclik-health";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Semáforo de salud de la API de Aliclik.
//
// SOLO LECTURA hacia Aliclik: sondea con el mismo GET de cotización que ya usa el
// cron de tarifas —no crea pedidos ni reserva stock—, por el mismo Edge y token.
//
// SOLO EN HORARIO LABORAL (7am–11pm Perú). Fuera de esa ventana no se sondea:
// nadie está creando guías, y el drawer muestra gris ("sin monitoreo") solo. El
// gate va en el handler además del cron, por si el cron se dispara al borde.

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

/** El almacén dominante entre los SKUs mapeados de las tiendas de la org. Mismo
 * criterio que el cron de tarifas: refleja de dónde salen las guías reales. */
async function orgWarehouse(
  admin: ReturnType<typeof createAdminSupabase>,
  storeIds: string[],
): Promise<number | undefined> {
  const { data: mapped } = await admin
    .from("aliclik_sku_map")
    .select("ean,store_id")
    .in("store_id", storeIds);
  const rows = (mapped ?? []) as { ean: string; store_id: string }[];
  const eans = rows.map((r) => r.ean).filter(Boolean);

  const counts = new Map<number, number>();
  for (const batch of chunk(eans, 200)) {
    const { data } = await admin
      .from("aliclik_skus")
      .select("warehouse_id")
      .in("store_id", storeIds)
      .not("warehouse_id", "is", null)
      .in("ean", batch);
    for (const r of (data ?? []) as { warehouse_id: number }[]) {
      counts.set(r.warehouse_id, (counts.get(r.warehouse_id) ?? 0) + 1);
    }
  }
  return pickTopWarehouse(counts);
}

async function run(req: NextRequest) {
  if (!authorized(req)) return new NextResponse("unauthorized", { status: 401 });

  // `?force=true` salta el gate horario, para probar la sonda a cualquier hora.
  const force = req.nextUrl.searchParams.get("force") === "true";
  if (!force && !withinBusinessHoursPeru(new Date())) {
    return NextResponse.json({ ok: true, skipped: "fuera de horario laboral (7am–11pm Perú)" });
  }

  const admin = createAdminSupabase();
  const { data: stores } = await admin
    .from("stores")
    .select("id,org_id")
    .eq("status", "active")
    .eq("aliclik_enabled", true);

  // Agrupar tiendas por org: la salud es por integración (una org = un token
  // Aliclik), aunque la org tenga varias tiendas Shopify.
  const byOrg = new Map<string, string[]>();
  for (const s of (stores ?? []) as { id: string; org_id: string }[]) {
    byOrg.set(s.org_id, [...(byOrg.get(s.org_id) ?? []), s.id]);
  }

  const reports = [];
  for (const [orgId, storeIds] of byOrg) {
    // Un token cualquiera de la org sirve: comparten la tienda Aliclik.
    let apiToken: string | null = null;
    for (const storeId of storeIds) {
      const creds = await getStoreCreds(storeId, admin);
      if (creds?.aliclik_api_token) {
        apiToken = creds.aliclik_api_token;
        break;
      }
    }
    if (!apiToken) continue;

    const warehouseId = await orgWarehouse(admin, storeIds);
    if (!warehouseId) continue;

    const probe = await runAliclikHealthProbe({ apiToken }, warehouseId);
    await admin.from("aliclik_health_checks").insert({
      org_id: orgId,
      status: probe.status,
      probes_total: probe.probesTotal,
      probes_ok: probe.probesOk,
      latency_ms: probe.latencyMs,
      detail: probe.detail,
    });
    reports.push({ orgId, ...probe });
  }

  return NextResponse.json({ ok: true, checked: reports.length, reports });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
