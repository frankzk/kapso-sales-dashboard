import { isInCallQueue, type CallQueueLead } from "./lead-call-queue";
import { attributedProductHandle, type LeadProductSignal } from "./lead-products";
import { canonicalProductHandles, leadProductHandle } from "./leads";
import { claveAnuncio, handleDeAnuncioPara, mapaAnuncioProducto, type AdDeclaration } from "./ad-products";

export const PRODUCT_REVIEW_SOURCE = "lead_product_full_audit_20261111" as const;
export type ProductReviewLead = CallQueueLead & {
  id: string; store_id: string; first_seen_at: string | null; first_inbound_text?: string | null;
  entry_product?: LeadProductSignal | null; interest_product?: LeadProductSignal | null;
  last_product_handle?: string | null; cart_product_handle?: string | null; ad_id?: string | null;
};
const FAMILIES = ["biru", "magic", "magnesio", "magnesio_puro", "magnesio_12_en_1", "icefit"] as const;
type Family = typeof FAMILIES[number];
type Counts = { por_llamar: number; en_seguimiento: number };

/** The board's product/state resolvers, with no advisor routing or extra filters.
 * Only aggregate counts leave the server; never lead IDs, names or messages. */
export function summarizeLeadProducts(rows: readonly ProductReviewLead[], declarations: readonly AdDeclaration[]) {
  const leads = rows.filter(l => (l.category === "open" || l.category === "hot") && l.status !== "yape_por_verificar");
  const ads = mapaAnuncioProducto(declarations);
  const result = {} as Record<"entry" | "current", Record<Family, Counts>>;
  const withoutProduct = {} as Record<"entry" | "current", Counts>;
  for (const basis of ["entry", "current"] as const) {
    const counts = Object.fromEntries(FAMILIES.map(f => [f, { por_llamar: 0, en_seguimiento: 0 }])) as Record<Family, Counts>;
    const handles = leads.map(l => attributedProductHandle(l, basis, leadProductHandle(l.first_inbound_text),
      l.ad_id ? handleDeAnuncioPara(ads.get(claveAnuncio(l.store_id, l.ad_id)), l.first_seen_at) : null));
    const canonical = canonicalProductHandles(handles.filter((h): h is string => !!h));
    const missing: Counts = { por_llamar: 0, en_seguimiento: 0 };
    leads.forEach((l, i) => {
      const state = isInCallQueue(l) ? "por_llamar" : "en_seguimiento";
      const raw = handles[i]; if (!raw) { missing[state]++; return; }
      const h = canonical.get(raw) ?? raw;
      const families: Family[] = [];
      if (/biru/i.test(h)) families.push("biru");
      if (/^aceite-(?:corporal-)?magic(?:-|$)/i.test(h)) families.push("magic");
      if (/^magnesio(?:-|$)/i.test(h)) families.push("magnesio");
      if (/magnesio-puro/i.test(h)) families.push("magnesio_puro");
      if (/magnesio.*12.*en.*1/i.test(h)) families.push("magnesio_12_en_1");
      if (/icefit/i.test(h)) families.push("icefit");
      for (const f of families) counts[f][state]++;
    });
    result[basis] = counts;
    withoutProduct[basis] = missing;
  }
  return { queue_size: leads.length, without_product: withoutProduct, ...result };
}
