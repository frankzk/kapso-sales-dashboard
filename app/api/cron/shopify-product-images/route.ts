import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { getStoreCreds } from "@/lib/ingest";
import { syncShopifyProductImages } from "@/lib/shopify-product-images";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Espeja la foto de catálogo de los productos que los pedidos citan, para que
// el desglose de productos pueda mostrar una miniatura de verdad.
//
// Es de SOLO LECTURA hacia Shopify y no escribe nada en el catálogo. Barato por
// construcción: en 180 días los pedidos citan 331 productos distintos, y el TTL
// de siete días hace que la pasada normal no tenga nada que preguntar.

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
  const single = req.nextUrl.searchParams.get("storeId");
  // `?force=1` ignora el TTL: sirve para el primer llenado y para cuando alguien
  // acaba de cambiar varias fotos y no quiere esperar siete días.
  const ttlDays = req.nextUrl.searchParams.get("force") ? 0 : undefined;

  let storeIds: string[];
  if (single) {
    storeIds = [single];
  } else {
    const { data, error } = await admin.from("stores").select("id").eq("status", "active");
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    storeIds = (data ?? []).map((s: { id: string }) => s.id);
  }

  const reports: unknown[] = [];
  for (const storeId of storeIds) {
    const creds = await getStoreCreds(storeId, admin);
    // Una tienda sin Shopify conectado no es un error.
    if (!creds?.shopify_token || !creds.shopify_domain) continue;
    try {
      const report = await syncShopifyProductImages(
        storeId,
        { domain: creds.shopify_domain, token: creds.shopify_token },
        admin,
        { ttlDays },
      );
      reports.push({ storeId, ...report });
    } catch (e) {
      reports.push({ storeId, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({ ok: true, stores: reports.length, reports });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
