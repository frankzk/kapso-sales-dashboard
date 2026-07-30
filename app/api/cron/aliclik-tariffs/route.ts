import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { chunk } from "@/lib/access";
import { getStoreCreds } from "@/lib/ingest";
import {
  pickTopWarehouse,
  syncAliclikTariffs,
  syncTariffsFromReports,
  type DistrictProbe,
} from "@/lib/aliclik-tariffs";
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

/**
 * Ventana de los reportes que se considera vigente.
 *
 * Los precios de Aliclik se revisan: Arequipa pasó de S/15,50 en junio a S/16,50
 * en julio. Mirar más atrás mezclaría tarifas de dos épocas y la moda podría
 * devolver un precio que ya no se cobra.
 */
const REPORT_DAYS = 30;

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
 * El almacén desde el que se cotiza toda la tienda.
 *
 * POR QUÉ NO VALE COGER UNO CUALQUIERA. Esta tienda tiene SKUs en 65 almacenes
 * distintos —incluido uno en Cochabamba— pero solo vende desde uno. Antes esto
 * era un `select warehouse_id … limit 1` SIN `order by`, así que Postgres
 * devolvía la fila que le venía en gana: salía NIBRESMA (183), mientras que
 * todas las guías reales salen de GRUPO GF (133). Cotizar Chiclayo desde el
 * almacén equivocado devuelve un precio de otro origen, o un 500.
 *
 * SE MIRAN LOS SKUs MAPEADOS, no todos. Un SKU del catálogo de Aliclik que
 * nadie ha enlazado a un producto de Shopify no se puede pedir, así que su
 * almacén no dice nada de dónde sale la mercancía. Los 103 SKUs mapeados de
 * esta tienda están los 103 en el 133.
 *
 * El desempate por `warehouse_id` mantiene la elección ESTABLE entre pasadas:
 * si cambiara de un día para otro, las tarifas de distintos distritos dejarían
 * de ser comparables entre sí, que es justo lo que se quiere evitar.
 */
async function pickWarehouse(
  admin: ReturnType<typeof createAdminSupabase>,
  storeId: string,
): Promise<number | undefined> {
  const { data: mapped } = await admin
    .from("aliclik_sku_map")
    .select("ean")
    .eq("store_id", storeId);
  const eans = (mapped ?? []).map((r) => (r as { ean: string }).ean).filter(Boolean);

  const counts = new Map<number, number>();
  for (const batch of chunk(eans, 200)) {
    const { data } = await admin
      .from("aliclik_skus")
      .select("warehouse_id")
      .eq("store_id", storeId)
      .not("warehouse_id", "is", null)
      .in("ean", batch);
    for (const r of (data ?? []) as { warehouse_id: number }[]) {
      counts.set(r.warehouse_id, (counts.get(r.warehouse_id) ?? 0) + 1);
    }
  }

  // Sin nada mapeado todavía (tienda recién conectada) se cae al catálogo
  // entero: peor señal, pero mejor que no cotizar nada.
  if (!counts.size) {
    const { data } = await admin
      .from("aliclik_skus")
      .select("warehouse_id")
      .eq("store_id", storeId)
      .not("warehouse_id", "is", null);
    for (const r of (data ?? []) as { warehouse_id: number }[]) {
      counts.set(r.warehouse_id, (counts.get(r.warehouse_id) ?? 0) + 1);
    }
  }

  return pickTopWarehouse(counts);
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

  // PRIMERO los reportes ya importados: es el costo realizado, cubre más
  // distritos, trae `intento_adicional` —que la cotización no da— y no depende
  // de que la API de Aliclik responda. La cotización queda para los distritos
  // sin histórico, que son justo los que esto no puede cubrir.
  const fromReports = await syncTariffsFromReports(REPORT_DAYS, today, admin);

  const reports = [];
  for (const s of (stores ?? []) as { id: string; org_id: string }[]) {
    const creds = await getStoreCreds(s.id, admin);
    if (!creds?.aliclik_api_token) continue;

    const warehouseId = await pickWarehouse(admin, s.id);
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

  return NextResponse.json({ ok: true, fromReports, reports });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
