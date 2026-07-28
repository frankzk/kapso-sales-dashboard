import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { getStoreCreds } from "@/lib/ingest";
import { syncAliclikCatalog } from "@/lib/aliclik-catalog";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Sincroniza el espejo del catálogo de Aliclik (productos + EAN + stock por
// almacén, directorio de agencias y tamaños de paquete).
//
// Es de SOLO LECTURA hacia Aliclik: no depende de ALICLIK_WRITE_ENABLED ni de
// `stores.aliclik_enabled`. Tener el catálogo al día es útil aunque la creación
// de guías siga apagada — de hecho es lo que permite saber, antes de encender
// nada, cuántos pedidos serían creables.

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
    // Una tienda sin token no es un error: la mayoría no usará Aliclik.
    if (!creds?.aliclik_api_token) continue;
    try {
      const report = await syncAliclikCatalog(storeId, { apiToken: creds.aliclik_api_token }, admin);
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
