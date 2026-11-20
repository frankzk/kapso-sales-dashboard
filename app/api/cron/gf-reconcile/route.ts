import { NextResponse, type NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { gfCourier } from "@/lib/gf-courier";
import { createGfGuideFor, loadGfStore, syncGfNoteFor } from "@/lib/gf-courier-guide";
import { applyGfSnapshot, GF_COURIER } from "@/lib/gf-courier-track";
import { GF_READ_BUDGET_MS, loadLiveGfGuides } from "@/lib/gf-reconcile-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const NOTES_PER_RUN = 120;
const NOTES_CHUNK = 100;

// Red de seguridad de GF Courier (MOM §29.17), cada 20 minutos.
//  1. HUÉRFANOS: intenciones 'pending' (timeout al crear). Se busca la guía por external_id; si existe se vincula
//     reintentando la creación con la MISMA Idempotency-Key (GF devuelve la misma guía). Si GF no la tiene, se marca
//     fallida para que se pueda volver a crear.
//  2. ESTADOS: relee TODAS las guías GF vivas y aplica el estado actual, por si se perdió un webhook. Primero la que GF
//     reportó hace más tiempo; al agotar GF_READ_BUDGET_MS no empieza otra lectura y las que faltan (`remaining`) van
//     primero en la pasada siguiente (lib/gf-reconcile-live.ts).
//  3. NOTAS: con la misma lectura, si la nota del pedido ya no es la que tiene GF, se la manda (owner, 20-11-2026: la nota
//     sale en el rótulo de GF y a veces se escribe después de la guía automática).
const eq = (a: string | null, b: string) => { if (!a) return false; const x = createHash("sha256").update(a).digest(), y = createHash("sha256").update(b).digest(); return timingSafeEqual(x, y); };
function authorized(req: NextRequest) {
  const secret = env.cronSecret(), bearer = req.headers.get("authorization");
  return (bearer?.startsWith("Bearer ") && eq(bearer.slice(7), secret)) || eq(req.nextUrl.searchParams.get("secret"), secret);
}

async function run(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const startedAt = Date.now();
  const admin = createAdminSupabase();
  // live = refreshed + remaining + skipped. `skipped`: sin guía o sin token de la tienda, no se pueden leer.
  const report = { orphans: 0, linked: 0, released: 0, live: 0, refreshed: 0, remaining: 0, skipped: 0, applied: 0, notes: 0, errors: [] as string[] };

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

  const { guides: live, error: liveError } = await loadLiveGfGuides(admin, GF_COURIER);
  if (liveError) report.errors.push(`guías vivas: ${liveError}`);
  report.live = live.length;
  const tokens = new Map<string, string | null>();
  for (const storeId of new Set(live.map((s) => s.store_id))) tokens.set(storeId, (await loadGfStore(admin, storeId))?.token ?? null);
  const readable = live.filter((s) => s.guide_code && tokens.get(s.store_id));
  report.skipped = live.length - readable.length;

  let notes = new Map<string, string | null>();
  for (const s of readable) {
    if (Date.now() - startedAt >= GF_READ_BUDGET_MS) break;
    // La nota en la columna `shopify_note` (= raw->>note, 0098), de a 100 pedidos y solo de los que se van a leer.
    if (report.refreshed % NOTES_CHUNK === 0) {
      const orderIds = [...new Set(readable.slice(report.refreshed, report.refreshed + NOTES_CHUNK).map((g) => g.order_id).filter(Boolean))] as string[];
      notes = new Map();
      if (orderIds.length) {
        const { data, error } = await admin.from("orders").select("id,shopify_note").in("id", orderIds);
        if (error) report.errors.push(`notas: ${error.message}`);
        for (const o of data ?? []) notes.set(o.id as string, (o.shopify_note as string | null) ?? null);
      }
    }
    const token = tokens.get(s.store_id)!, guide = s.guide_code!;
    report.refreshed++;
    const current = await gfCourier.getOrder({ apiToken: token }, guide);
    if (!current.ok) { report.errors.push(`${guide}: ${current.error.code}`); continue; }
    const applied = await applyGfSnapshot(current.data, admin);
    if (applied.outcome === "applied") report.applied++;
    // Tope por pasada: la primera vez hay ~200 guías vivas con nota y la pasada no debe pasar sus 5 minutos.
    if (s.order_id && notes.has(s.order_id) && report.notes < NOTES_PER_RUN) {
      const note = await syncGfNoteFor({ token, orderId: s.order_id, current: current.data, raw: { note: notes.get(s.order_id) } });
      if (note === "sent") report.notes++;
      else if (typeof note === "object") report.errors.push(`${guide} (nota): ${note.error}`);
    }
  }
  report.remaining = readable.length - report.refreshed;
  return NextResponse.json(report);
}
export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
