import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { getStoreCreds } from "@/lib/ingest";
import { syncAliclikTariffs, type DistrictProbe } from "@/lib/aliclik-tariffs";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Tarifas de ALIDRIVER por distrito, cotizadas contra Aliclik.
//
// SOLO LECTURA hacia Aliclik, igual que el cron del catálogo: cotizar es un GET
// que no crea pedidos ni reserva stock. No depende de ALICLIK_WRITE_ENABLED ni
// de `stores.aliclik_enabled` — saber cuánto cuesta enviar es útil aunque la
// creación de guías esté apagada, y de hecho es lo que permite estimar el margen
// de los pedidos que todavía NO tienen guía.
//
// EL LOTE ES ACOTADO A PROPÓSITO. Hay 661 distritos con pedidos esperando y no
// conocemos los límites de tasa de su API. Se cotizan los que más pedidos tienen
// pendientes —los que más mueven el margen— y el resto entra en las pasadas
// siguientes. Una vez cubiertos, las pasadas diarias solo detectan cambios de
// precio, que es barato porque `planTariffUpdates` no escribe si nada cambió.

/** Distritos por pasada. Con el cron diario, cubre los 661 en ~11 días. */
const BATCH = 60;

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

/**
 * Un punto representativo por distrito, tomado de un pedido real que espera.
 *
 * Se prioriza por número de pedidos pendientes y se dejan al final los distritos
 * cuya tarifa se cotizó más recientemente, para que las pasadas sucesivas vayan
 * cubriendo el mapa en vez de repetir siempre los mismos.
 */
async function pickProbes(
  admin: ReturnType<typeof createAdminSupabase>,
  storeId: string,
  warehouseId: number,
  limit: number,
): Promise<DistrictProbe[]> {
  const { data } = await admin.rpc("aliclik_tariff_probes", {
    p_store_id: storeId,
    p_limit: limit,
  });
  const rows = (data ?? []) as {
    district: string;
    lat: number;
    lng: number;
    pending: number;
  }[];
  return rows.map((r) => ({ ...r, warehouseId }));
}

async function run(req: NextRequest) {
  if (!authorized(req)) return new NextResponse("unauthorized", { status: 401 });

  const admin = createAdminSupabase();
  const single = req.nextUrl.searchParams.get("storeId");
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? BATCH) || BATCH;

  const { data: stores } = single
    ? await admin.from("stores").select("id,org_id").eq("id", single)
    : await admin.from("stores").select("id,org_id").eq("status", "active");

  const today = new Date().toISOString().slice(0, 10);
  const reports = [];
  for (const s of (stores ?? []) as { id: string; org_id: string }[]) {
    const creds = await getStoreCreds(s.id, admin);
    if (!creds?.aliclik_api_token) continue;

    // El almacén más usado de la tienda. La cotización lo exige, y el precio
    // podría depender de él — mientras no se pueda medir, se usa uno estable
    // para que las tarifas de distintos distritos sean comparables entre sí.
    const { data: wh } = await admin
      .from("aliclik_skus")
      .select("warehouse_id")
      .eq("store_id", s.id)
      .not("warehouse_id", "is", null)
      .limit(1);
    const warehouseId = (wh ?? [])[0]?.warehouse_id as number | undefined;
    if (!warehouseId) continue;

    const probes = await pickProbes(admin, s.id, warehouseId, limit);
    if (!probes.length) continue;

    const res = await syncAliclikTariffs(
      s.org_id,
      probes,
      { apiToken: creds.aliclik_api_token },
      today,
      admin,
    );
    reports.push({ storeId: s.id, districts: probes.length, ...res });
  }

  return NextResponse.json({ ok: true, reports });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
