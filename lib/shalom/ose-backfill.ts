// El OSE ID de las guías de Shalom creadas a mano en pro.shalom.pe (MOM §12).
//
// POR QUÉ. El aviso de tránsito y el de llegada llevan el ticket de Shalom en
// PDF, y el ticket se baja con el OSE ID de la guía. Las guías que el operador
// crea a mano en Shalom Pro —la contingencia cuando la integración falla— entran
// a Kapta solo con el número de guía y el código, sin OSE ID. El 01-10-2026 se
// crearon así 21 guías de Kenku y sus 25 avisos fallaron: «la plantilla lleva
// el ticket pero la guía no tiene OSE ID».
//
// DE DÓNDE SALE. El listado de órdenes de la cuenta (`GET /v1/orders`) trae
// también las guías creadas a mano, con su `guia` y un `id`. Que ese `id` sea
// el OSE ID no está documentado, así que NO se da por hecho: se comprueba en
// cada lectura con las guías que Kapta creó por API, cuyo OSE ID sí conoce. Si
// alguna de ellas aparece con otro `id`, o ninguna aparece, no se escribe nada.

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadStoreShalom, readWithFreshSession } from "@/lib/shalom/session";
import { SHALOM_ORIGIN } from "@/lib/shalom/origin";
import { collectListingPages } from "@/lib/shalom/account-match";
import { SLOW_TIMEOUT_MS } from "@/lib/shalom/client";
import type { ShalomAccountOrder } from "@/lib/shalom/types";

/** Una guía de la cuenta con OSE ID conocido: la prueba de que `id` es el OSE ID. */
export interface KnownOse {
  guideCode: string;
  oseId: number;
}

export interface OseResolution {
  /** Se comprobó con guías conocidas que `id` del listado ES el OSE ID. */
  trusted: boolean;
  /** Cuántas guías conocidas confirmaron la equivalencia. */
  verified: number;
  reason: string | null;
  /** Número de guía → OSE ID, solo si `trusted`. */
  resolved: Map<string, number>;
}

function guiaOf(o: ShalomAccountOrder): string {
  return String(o.guia ?? "").trim();
}

/** PURA. Decide qué OSE ID poner a cada guía buscada, y si se puede confiar. */
export function resolveOseIds(orders: ShalomAccountOrder[], known: KnownOse[], wanted: string[]): OseResolution {
  const byGuia = new Map<string, number[]>();
  for (const o of orders) {
    const g = guiaOf(o);
    if (!g || !Number.isSafeInteger(o.id) || o.id <= 0) continue;
    byGuia.set(g, [...(byGuia.get(g) ?? []), o.id]);
  }

  let verified = 0;
  for (const k of known) {
    const ids = byGuia.get(k.guideCode.trim());
    if (!ids) continue;
    if (ids.length !== 1 || ids[0] !== k.oseId) {
      return {
        trusted: false,
        verified,
        reason: `La guía ${k.guideCode} tiene OSE ID ${k.oseId} y el listado de Shalom le da ${ids.join(", ")}: no son lo mismo.`,
        resolved: new Map(),
      };
    }
    verified += 1;
  }
  if (!verified) {
    return {
      trusted: false,
      verified,
      reason: "Ninguna guía creada por API apareció en el listado para comprobar que su id es el OSE ID.",
      resolved: new Map(),
    };
  }

  const resolved = new Map<string, number>();
  for (const w of wanted) {
    const ids = byGuia.get(w.trim());
    const [only] = ids ?? [];
    if (ids?.length === 1 && only) resolved.set(w, only);
  }
  return { trusted: true, verified, reason: null, resolved };
}

export interface OseBackfillReport {
  buscadas: number;
  resueltas: number;
  sinResolver: string[];
  errores: string[];
}

/**
 * Hasta dónde se buscan guías manuales sin OSE ID. El OSE ID sirve para el
 * ticket de los avisos, que salen en la primera semana de la guía. Con 30 días,
 * UNA guía vieja que el listado nunca resuelve (98058249, del 01-10-2026) hacía
 * releer diez días de listado en cada pasada de media hora, y desde que se leen
 * todas las páginas eso se comía el tiempo del cron (10-10-2026).
 */
const LOOKBACK_DAYS = 7;
/** El listado pagina y Shalom no entrega más de 200 por página aunque se le
 *  pidan más (medido el 10-10-2026): con 600 se leía solo la primera página. */
const PER_PAGE = 200;
/** Un mes de las dos tiendas cabe de sobra; el resto del cron necesita su tiempo. */
const MAX_PAGES = 15;
const LISTING_BUDGET_MS = 90_000;

/**
 * Busca las guías manuales recientes sin OSE ID y se lo pone desde el listado
 * de la cuenta. Barato cuando no hay nada que buscar: una consulta y vuelve.
 */
export async function backfillManualOseIds(admin: SupabaseClient): Promise<OseBackfillReport> {
  const report: OseBackfillReport = { buscadas: 0, resueltas: 0, sinResolver: [], errores: [] };
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const { data, error } = await admin
    .from("shipments")
    .select("id,store_id,guide_code,created_at")
    .eq("courier", "shalom")
    .eq("created_via", SHALOM_ORIGIN.manual)
    .is("shalom_ose_id", null)
    .not("guide_code", "is", null)
    .neq("delivery_status", "anulado")
    .gte("created_at", since)
    .limit(500);
  if (error) {
    report.errores.push(`guías manuales: ${error.message}`);
    return report;
  }
  const pending = (data ?? []) as { id: string; store_id: string; guide_code: string; created_at: string }[];
  report.buscadas = pending.length;
  if (!pending.length) return report;

  const byStore = new Map<string, typeof pending>();
  for (const p of pending) byStore.set(p.store_id, [...(byStore.get(p.store_id) ?? []), p]);

  for (const [storeId, rows] of byStore) {
    const store = await loadStoreShalom(admin, storeId);
    if (!store?.shalom_pro_email) {
      report.sinResolver.push(...rows.map((r) => r.guide_code));
      continue;
    }
    const oldest = Math.min(...rows.map((r) => Date.parse(r.created_at)).filter(Number.isFinite));
    const desde = new Date(oldest - 86_400_000).toISOString().slice(0, 10);
    try {
      // Todas las páginas desde `desde`: con una sola, las guías que no cabían
      // en ella quedaban sin OSE ID. Un listado a medias no engaña a
      // `resolveOseIds` —solo resuelve menos—, así que se usa lo que llegó.
      const { orders } = await readWithFreshSession(admin, storeId, store, (c) =>
        collectListingPages(
          (page, left) => c.ordersSince(desde, PER_PAGE, { page, timeoutMs: Math.min(SLOW_TIMEOUT_MS, left) }),
          { perPage: PER_PAGE, maxPages: MAX_PAGES, deadlineMs: Date.now() + LISTING_BUDGET_MS },
        ),
      );
      const { data: knownRows } = await admin
        .from("shipments")
        .select("guide_code,shalom_ose_id")
        .eq("store_id", storeId)
        .eq("courier", "shalom")
        .not("shalom_ose_id", "is", null)
        .gte("created_at", `${desde}T00:00:00Z`)
        .limit(1000);
      const known = ((knownRows ?? []) as { guide_code: string | null; shalom_ose_id: number }[])
        .filter((k) => k.guide_code)
        .map((k) => ({ guideCode: k.guide_code as string, oseId: Number(k.shalom_ose_id) }));
      const res = resolveOseIds(orders, known, rows.map((r) => r.guide_code));
      if (!res.trusted) {
        report.errores.push(res.reason ?? "no se pudo comprobar el OSE ID");
        report.sinResolver.push(...rows.map((r) => r.guide_code));
        continue;
      }
      for (const r of rows) {
        const oseId = res.resolved.get(r.guide_code);
        if (!oseId) {
          report.sinResolver.push(r.guide_code);
          continue;
        }
        const upd = await admin
          .from("shipments")
          .update({ shalom_ose_id: oseId, updated_at: new Date().toISOString() })
          .eq("id", r.id)
          .is("shalom_ose_id", null);
        if (upd.error) report.errores.push(`${r.guide_code}: ${upd.error.message}`);
        else report.resueltas += 1;
      }
    } catch (e) {
      report.errores.push(`tienda ${storeId}: ${e instanceof Error ? e.message : String(e)}`);
      report.sinResolver.push(...rows.map((r) => r.guide_code));
    }
  }
  return report;
}
