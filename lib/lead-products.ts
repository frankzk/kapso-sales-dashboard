/** Catalogue-backed attribution. Only customer messages are evidence. */
export interface LeadCatalogProduct { handle: string; title: string; aliases?: string[] }
export interface LeadProductSignal {
  handle: string | null;
  title: string | null;
  source: "customer_url" | "customer_text" | "ambiguous";
  at: string;
  message_id: string | null;
  evidence: string;
}
export interface ProductMessage { text: string; at: string; id?: string | null; direction: string }

export function productTextKey(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/&(?:amp|nbsp);/g, " ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

// Distinctive, catalogue-checked names, not symptoms, benefits or guessed ad copy.
const NAMES = ["aceite de semilla negra", "black seed oil", "cayenne pepper", "astaxantina",
  "nattokinase", "shilajit", "beewax", "softflex", "feel virgin", "oxido nitrico",
  "magnesio 12 en 1", "saffron advanced", "calzon faja", "keratin"];
const GENERIC = new Set(["suplemento", "capsulas", "producto", "super human", "superhuman", "magnesio", "pack"]);
const contains = (text: string, phrase: string) => (` ${text} `).includes(` ${phrase} `);

export function buildProductMatcher(products: readonly LeadCatalogProduct[]) {
  const catalogue = new Map<string, LeadCatalogProduct>();
  for (const p of products) if (p.handle && p.title) catalogue.set(p.handle.toLowerCase(), p);
  const aliases = new Map<string, Set<string>>();
  const add = (alias: string, handle: string) => {
    const key = productTextKey(alias);
    if (key.length < 6 || GENERIC.has(key)) return;
    const owners = aliases.get(key) ?? new Set<string>();
    owners.add(handle); aliases.set(key, owners);
  };
  for (const [handle, p] of catalogue) {
    add(p.title, handle);
    add(handle.replace(/-/g, " "), handle);
    // An explicit name before a description; never arbitrary keyword overlap.
    const name = p.title.split(/\s+[–—-]\s+|[|:]/)[0]!;
    if (productTextKey(name).split(" ").length >= 2) add(name, handle);
    for (const alias of p.aliases ?? []) add(alias, handle);
    for (const alias of NAMES) if (contains(productTextKey(p.title), alias)) add(alias, handle);
  }
  const byToken = new Map<string, [string, Set<string>][] >();
  for (const pair of aliases) {
    const first = pair[0].split(" ")[0]!;
    const bucket = byToken.get(first) ?? []; bucket.push(pair); byToken.set(first, bucket);
  }
  return (message: ProductMessage): LeadProductSignal | null => {
    if (message.direction !== "inbound" || !Number.isFinite(Date.parse(message.at))) return null;
    const handles = new Set<string>();
    let linked = false;
    const links = [...message.text.matchAll(/https?:\/\/[^\s<>]+\/products?\/([^\s/?#<>]+)/gi)];
    for (const link of links) {
      let h = link[1]!.toLowerCase();
      try { h = decodeURIComponent(h); } catch { /* malformed URL is not evidence */ }
      if (catalogue.has(h)) { handles.add(h); linked = true; }
    }
    const text = productTextKey(message.text.replace(/https?:\/\/\S+/gi, " "));
    const matches = [...new Set(text.split(" "))].flatMap((token) => byToken.get(token) ?? [])
      .filter(([alias]) => {
        const index = (` ${text} `).indexOf(` ${alias} `);
        if (index < 0) return false;
        const before = text.slice(Math.max(0, index - 55), index);
        // An explicit rejection is not buying intent for the rejected product.
        return !/\bno (?:quiero|deseo|me interesa|necesito)(?: (?:el|la|los|las|producto|suplemento|de))*\s*$/.test(before);
      });
    // A complete name wins over its own shorter alias; two distinct products
    // (or a shared name) remain ambiguous, never choose by catalogue order.
    for (const [alias, owners] of matches) {
      if (matches.some(([longer, ids]) => longer !== alias && contains(longer, alias) && ids.size === 1)) continue;
      for (const h of owners) handles.add(h);
    }
    if (!handles.size) return null;
    const handle = handles.size === 1 ? [...handles][0]! : null;
    return { handle, title: handle ? catalogue.get(handle)!.title : null,
      source: handle ? (linked ? "customer_url" : "customer_text") : "ambiguous",
      at: new Date(message.at).toISOString(), message_id: message.id ?? null,
      evidence: message.text.slice(0, 400) };
  };
}

export function customerProductSignals(products: readonly LeadCatalogProduct[], messages: readonly ProductMessage[]) {
  const match = buildProductMatcher(products);
  return messages.map(match).filter((s): s is LeadProductSignal => s !== null)
    .sort((a, b) => a.at.localeCompare(b.at) || (a.message_id ?? "").localeCompare(b.message_id ?? ""));
}

/** One resolver for both facet counts and rows; ambiguous != old interest. */
export function attributedProductHandle(lead: {
  entry_product?: LeadProductSignal | null; interest_product?: LeadProductSignal | null;
  last_product_handle?: string | null; cart_product_handle?: string | null;
}, basis: "current" | "entry", opener: string | null, ad: string | null): string | null {
  if (basis === "entry") return lead.entry_product ? lead.entry_product.handle : opener || ad || lead.cart_product_handle || null;
  if (lead.interest_product) return lead.interest_product.handle;
  const explicit = lead.last_product_handle || lead.cart_product_handle;
  if (explicit) return explicit;
  if (lead.entry_product) return lead.entry_product.handle;
  return opener || ad || null;
}
