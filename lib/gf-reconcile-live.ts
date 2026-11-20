// Qué guías GF vivas relee `gf-reconcile` y en qué orden (MOM §29.17).
//
// Hasta el 20-11-2026 la pasada leía las vivas con `.limit(300)` y sin orden. Ese día había justo 300 (211 pendientes,
// 89 en ruta, la más vieja del 11-11): toda guía de más no se releía nunca, y si se perdía su webhook su estado y su nota
// se quedaban viejos en Kapta. Ahora se traen TODAS y se lee primero la que GF reportó hace más tiempo
// (`api_report_at`, que sella cada lectura de GF, también la que dispara el webhook). Una guía leída pasa al final de la
// cola; la pasada deja de empezar lecturas al agotar su presupuesto y lo que no alcanzó va primero en la siguiente.
import type { SupabaseClient } from "@supabase/supabase-js";

export interface LiveGfGuide {
  id: string;
  store_id: string;
  guide_code: string | null;
  order_id: string | null;
  api_report_at: string | null;
}

/** Filas por consulta: el tope de PostgREST en Supabase es 1000. */
export const GF_LIVE_PAGE = 1000;

/**
 * La pasada no empieza otra lectura pasados 230 s desde que arrancó. La peor lectura (20 s de timeout de GF, la nota con
 * otros 20 s y la base) termina igual antes de los 300 s de `maxDuration`.
 */
export const GF_READ_BUDGET_MS = 230_000;

const readAt = (g: LiveGfGuide) => {
  const ms = g.api_report_at ? Date.parse(g.api_report_at) : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
};

/** La que nunca se leyó primero, luego la leída hace más tiempo; a igual sello, por id (orden estable). */
export function stalestFirst(guides: readonly LiveGfGuide[]): LiveGfGuide[] {
  return [...guides].sort((a, b) => {
    const ta = readAt(a), tb = readAt(b);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Todas las guías GF vivas (`pendiente`, `en_ruta`), ordenadas con `stalestFirst`. Se pagina por `id`, que no cambia, y
 * se ordena en memoria: paginar por `api_report_at` saltaría filas si un webhook sella una guía entre dos páginas.
 */
export async function loadLiveGfGuides(admin: SupabaseClient, courier: string): Promise<{ guides: LiveGfGuide[]; error: string | null }> {
  const guides: LiveGfGuide[] = [];
  let after: string | null = null;
  for (;;) {
    let query = admin.from("shipments").select("id,store_id,guide_code,order_id,api_report_at")
      .eq("courier", courier).in("delivery_status", ["pendiente", "en_ruta"]);
    if (after) query = query.gt("id", after);
    const { data, error } = await query.order("id", { ascending: true }).limit(GF_LIVE_PAGE);
    if (error) return { guides: stalestFirst(guides), error: error.message };
    const rows = (data ?? []) as LiveGfGuide[];
    guides.push(...rows);
    if (rows.length < GF_LIVE_PAGE) break;
    after = rows[rows.length - 1]!.id;
  }
  return { guides: stalestFirst(guides), error: null };
}
