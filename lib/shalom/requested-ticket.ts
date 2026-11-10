// Resolve only the guide whose ticket an authenticated operator requested.
// Reused outputs keep their original created_at, so the seven-day background
// lookup can miss a guide linked today. Do not widen that background queue.
import type { SupabaseClient } from "@supabase/supabase-js";
import { collectListingPages } from "@/lib/shalom/account-match";
import { SLOW_TIMEOUT_MS } from "@/lib/shalom/client";
import { resolveOseIds } from "@/lib/shalom/ose-backfill";
import { readWithFreshSession, type StoreShalom } from "@/lib/shalom/session";

export interface RequestedShalomTicket {
  id: string;
  store_id: string;
  courier: string;
  guide_code: string | null;
  shalom_ose_id: number | null;
  created_at: string;
}

export async function resolveRequestedShalomTicket(
  admin: SupabaseClient,
  guide: RequestedShalomTicket,
  store: StoreShalom,
): Promise<number> {
  if (guide.courier !== "shalom" || !guide.guide_code) throw new Error("La salida no tiene una guía Shalom identificable.");
  if (guide.shalom_ose_id) return guide.shalom_ose_id;
  const created = Date.parse(guide.created_at);
  if (!Number.isFinite(created)) throw new Error("No consta la fecha de esta salida para buscar su ticket.");
  const from = new Date(created - 86_400_000).toISOString().slice(0, 10);
  // Login plus listing share one budget; leave 45 s for the PDF within the
  // route's 300 s limit. Several slow pages may not fit the cron's 90 s budget.
  const deadlineMs = Date.now() + 240_000;
  const listing = await readWithFreshSession(admin, guide.store_id, store, (client) =>
    collectListingPages(
      (page, left) => client.ordersSince(from, 200, { page, timeoutMs: Math.min(SLOW_TIMEOUT_MS, left) }),
      { perPage: 200, maxPages: 15, concurrency: 3, deadlineMs },
    ),
  );
  if (!listing.completo) throw new Error("El listado de Shalom no terminó de cargar. Vuelve a abrir el ticket para reintentar.");
  const known = await admin.from("shipments")
    .select("guide_code,shalom_ose_id")
    .eq("store_id", guide.store_id).eq("courier", "shalom")
    .not("shalom_ose_id", "is", null).gte("created_at", `${from}T00:00:00Z`).limit(1000);
  if (known.error) throw new Error("No se pudieron comprobar los identificadores de Shalom.");
  const result = resolveOseIds(
    listing.orders,
    (known.data ?? []).filter((row) => row.guide_code).map((row) => ({ guideCode: row.guide_code as string, oseId: Number(row.shalom_ose_id) })),
    [guide.guide_code],
  );
  const oseId = result.resolved.get(guide.guide_code);
  if (!result.trusted || !oseId) throw new Error("Shalom no permitió identificar con seguridad el ticket de esta guía. No se modificó su vínculo.");

  // Never attach a document to a guide replaced while Shalom was loading.
  // Two identical requests may race; only the identical verified ID is reused.
  const written = await admin.from("shipments")
    .update({ shalom_ose_id: oseId })
    .eq("id", guide.id).eq("store_id", guide.store_id).eq("courier", "shalom")
    .eq("guide_code", guide.guide_code).is("shalom_ose_id", null)
    .select("shalom_ose_id").maybeSingle();
  if (written.error) throw new Error("No se pudo guardar el identificador del ticket.");
  if (!written.data) {
    const current = await admin.from("shipments").select("shalom_ose_id")
      .eq("id", guide.id).eq("store_id", guide.store_id).eq("courier", "shalom")
      .eq("guide_code", guide.guide_code).maybeSingle();
    if (current.error || current.data?.shalom_ose_id !== oseId) throw new Error("La guía cambió mientras se buscaba el ticket. Recarga el pedido.");
  }
  return oseId;
}
