import { NextResponse, type NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { gfCourier } from "@/lib/gf-courier";
import { closeGhostGfGuide, createGfGuideFor, loadGfStore, syncGfNoteFor } from "@/lib/gf-courier-guide";
import { applyGfSnapshot, GF_COURIER } from "@/lib/gf-courier-track";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const NOTES_PER_RUN = 120;

// Red de seguridad de GF Courier (MOM §29.17), cada 20 minutos.
//  1. HUÉRFANOS: intenciones 'pending' (timeout al crear). Se busca la guía por external_id; si existe se vincula
//     reintentando la creación con la MISMA Idempotency-Key (GF devuelve la misma guía). Si GF no la tiene, se marca
//     fallida para que se pueda volver a crear.
//  2. ESTADOS: relee las guías GF vivas y aplica el estado actual, por si se perdió un webhook.
//  3. NOTAS: con la misma lectura, si la nota del pedido ya no es la que tiene GF, se la manda (owner, 20-11-2026: la nota
//     sale en el rótulo de GF y a veces se escribe después de la guía automática).
//  4. GUÍAS GF DE MÁS (owner, 24-11-2026, lib/gf-ghost-guide.ts): la guía GF abierta de un pedido que ya salió con otro
//     courier, creado después: si GF ya tiene la caja en su almacén, se anula sola. Por si el aviso de GF se perdió, o
//     la caja volvió antes de esta regla (#KP207043).
const eq = (a: string | null, b: string) => { if (!a) return false; const x = createHash("sha256").update(a).digest(), y = createHash("sha256").update(b).digest(); return timingSafeEqual(x, y); };
function authorized(req: NextRequest) {
  const secret = env.cronSecret(), bearer = req.headers.get("authorization");
  return (bearer?.startsWith("Bearer ") && eq(bearer.slice(7), secret)) || eq(req.nextUrl.searchParams.get("secret"), secret);
}

async function run(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const admin = createAdminSupabase();
  const report = { orphans: 0, linked: 0, released: 0, refreshed: 0, applied: 0, notes: 0, ghosts: 0, ghostsClosed: 0, errors: [] as string[] };

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

  const { data: live } = await admin.from("shipments").select("store_id,guide_code,order_id").eq("courier", GF_COURIER).in("delivery_status", ["pendiente", "en_ruta"]).limit(300);
  const orderIds = [...new Set((live ?? []).map((s) => s.order_id).filter(Boolean))] as string[];
  // La nota en la columna `shopify_note` (= raw->>note, 0098): no se trae el JSON crudo de 300 pedidos.
  const notes = new Map<string, string | null>();
  for (let i = 0; i < orderIds.length; i += 100) {
    const { data, error } = await admin.from("orders").select("id,shopify_note").in("id", orderIds.slice(i, i + 100));
    if (error) report.errors.push(`notas: ${error.message}`);
    for (const o of data ?? []) notes.set(o.id as string, (o.shopify_note as string | null) ?? null);
  }
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
    // Tope por pasada: la primera vez hay ~200 guías vivas con nota y la pasada no debe pasar sus 5 minutos.
    if (s.order_id && notes.has(s.order_id) && report.notes < NOTES_PER_RUN) {
      const note = await syncGfNoteFor({ token, orderId: s.order_id, current: current.data, raw: { note: notes.get(s.order_id) } });
      if (note === "sent") report.notes++;
      else if (typeof note === "object") report.errors.push(`${s.guide_code} (nota): ${note.error}`);
    }
  }
  // 4. Guías GF de más: solo las de pedidos con una guía de otro courier creada después (pocas), con su propia lectura.
  const { data: gfOpen } = await admin.from("shipments").select("store_id,guide_code,order_id,created_at")
    .eq("courier", GF_COURIER).in("delivery_status", ["pendiente", "en_ruta"]).is("returned_at", null).not("guide_code", "is", null).limit(2000);
  const gfByOrder = new Map<string, { store_id: string; guide_code: string; created_at: string }[]>();
  for (const g of gfOpen ?? []) if (g.order_id) gfByOrder.set(g.order_id, [...(gfByOrder.get(g.order_id) ?? []), g as { store_id: string; guide_code: string; created_at: string }]);
  const gfOrderIds = [...gfByOrder.keys()];
  const candidates: { orderId: string; store_id: string; guide_code: string }[] = [];
  for (let i = 0; i < gfOrderIds.length; i += 100) {
    const { data: others, error } = await admin.from("shipments").select("order_id,created_at")
      .in("order_id", gfOrderIds.slice(i, i + 100)).not("courier", "in", `(${GF_COURIER},propio)`)
      .in("delivery_status", ["pendiente", "en_ruta", "entregado"]).is("returned_at", null).not("guide_code", "is", null);
    if (error) { report.errors.push(`guías de más: ${error.message}`); continue; }
    for (const o of others ?? []) for (const g of gfByOrder.get(o.order_id as string) ?? []) {
      if (Date.parse(o.created_at as string) > Date.parse(g.created_at) && !candidates.some((c) => c.guide_code === g.guide_code))
        candidates.push({ orderId: o.order_id as string, store_id: g.store_id, guide_code: g.guide_code });
    }
  }
  for (const c of candidates.slice(0, 40)) {
    if (!tokens.has(c.store_id)) tokens.set(c.store_id, (await loadGfStore(admin, c.store_id))?.token ?? null);
    const token = tokens.get(c.store_id);
    if (!token) continue;
    report.ghosts++;
    const current = await gfCourier.getOrder({ apiToken: token }, c.guide_code);
    if (!current.ok) { report.errors.push(`${c.guide_code} (de más): ${current.error.code}`); continue; }
    const ghost = await closeGhostGfGuide(admin, c.orderId, current.data);
    if (ghost.closed) report.ghostsClosed++;
    else if (ghost.error) report.errors.push(`${c.guide_code} (de más): ${ghost.error}`);
  }
  return NextResponse.json(report);
}
export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
