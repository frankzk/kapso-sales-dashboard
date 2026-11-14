import { NextResponse, type NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { gfCourier } from "@/lib/gf-courier";
import { createGfGuideFor, loadGfStore } from "@/lib/gf-courier-guide";
import { applyGfSnapshot, GF_COURIER } from "@/lib/gf-courier-track";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Red de seguridad de GF Courier (MOM §29.17), cada 20 minutos.
//  1. HUÉRFANOS: intenciones 'pending' (timeout al crear). Se busca la guía por external_id; si existe se vincula
//     reintentando la creación con la MISMA Idempotency-Key (GF devuelve la misma guía). Si GF no la tiene, se marca
//     fallida para que se pueda volver a crear.
//  2. ESTADOS: relee las guías GF vivas y aplica el estado actual, por si se perdió un webhook.
const eq = (a: string | null, b: string) => { if (!a) return false; const x = createHash("sha256").update(a).digest(), y = createHash("sha256").update(b).digest(); return timingSafeEqual(x, y); };
function authorized(req: NextRequest) {
  const secret = env.cronSecret(), bearer = req.headers.get("authorization");
  return (bearer?.startsWith("Bearer ") && eq(bearer.slice(7), secret)) || eq(req.nextUrl.searchParams.get("secret"), secret);
}

async function run(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const admin = createAdminSupabase();
  const report = { orphans: 0, linked: 0, released: 0, refreshed: 0, applied: 0, errors: [] as string[] };

  const old = new Date(Date.now() - 2 * 60_000).toISOString();
  const { data: pending } = await admin.from("gf_order_requests").select("id,store_id,order_id,external_id").eq("status", "pending").lt("created_at", old).limit(50);
  for (const intent of pending ?? []) {
    report.orphans++;
    const store = await loadGfStore(admin, intent.store_id);
    if (!store?.token) continue;
    const found = await gfCourier.findByExternalId({ apiToken: store.token }, intent.external_id);
    if (found.ok) {
      const r = await createGfGuideFor(intent.order_id, { userId: null }, admin);
      if (r.ok) report.linked++; else report.errors.push(`${intent.external_id}: ${r.error}`);
    } else if (found.status === 404) {
      await admin.from("gf_order_requests").update({ status: "failed", error_code: "NOT_CREATED", updated_at: new Date().toISOString() }).eq("id", intent.id);
      report.released++;
    }
  }

  const { data: live } = await admin.from("shipments").select("store_id,guide_code").eq("courier", GF_COURIER).in("delivery_status", ["pendiente", "en_ruta"]).limit(300);
  const tokens = new Map<string, string | null>();
  for (const s of live ?? []) {
    if (!tokens.has(s.store_id)) tokens.set(s.store_id, (await loadGfStore(admin, s.store_id))?.token ?? null);
    const token = tokens.get(s.store_id);
    if (!token || !s.guide_code) continue;
    report.refreshed++;
    const current = await gfCourier.getOrder({ apiToken: token }, s.guide_code);
    if (!current.ok) { report.errors.push(`${s.guide_code}: ${current.error.code}`); continue; }
    const applied = await applyGfSnapshot(current.data, admin);
    if (applied.outcome === "applied") report.applied++;
  }
  return NextResponse.json(report);
}
export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
