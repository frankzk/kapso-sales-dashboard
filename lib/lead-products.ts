/** Catalogue-backed attribution. Only customer messages are evidence. */
export interface LeadCatalogProduct { handle: string; title: string; aliases?: string[]; handles?: string[] }
export interface LeadProductSignal {
  handle: string | null;
  title: string | null;
  source: "customer_url" | "customer_text" | "ambiguous";
  at: string;
  message_id: string | null;
  evidence: string;
}
export interface ProductMessage { text: string; at: string; id?: string | null; direction: string }

export function productTitleText(text: string): string {
  return text.replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, code: string) => {
    const n = code[0]!.toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
    return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
  }).replace(/&(?:amp|nbsp|quot|apos|ndash|mdash|trade|reg|aacute|eacute|iacute|oacute|uacute|ntilde|uuml);/gi, (entity) => ({
    "&amp;": "&", "&nbsp;": " ", "&quot;": '"', "&apos;": "'", "&ndash;": "–", "&mdash;": "—", "&trade;": "™", "&reg;": "®",
    "&aacute;": "á", "&eacute;": "é", "&iacute;": "í", "&oacute;": "ó", "&uacute;": "ú", "&ntilde;": "ñ", "&uuml;": "ü",
  })[entity.toLowerCase()] ?? " ");
}
export function productTextKey(text: string): string {
  return productTitleText(text).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/&(?:amp|nbsp);/g, " ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

// Distinctive, catalogue-checked names, not symptoms, benefits or guessed ad copy.
const NAMES = ["aceite de semilla negra", "black seed oil", "cayenne pepper", "astaxantina",
  "nattokinase", "shilajit", "beewax", "softflex", "feel virgin", "oxido nitrico",
  "magnesio 12 en 1", "saffron advanced", "calzon faja", "keratin"];
const GENERIC = new Set(["suplemento", "capsulas", "producto", "super human", "superhuman", "magnesio", "pack"]);
const contains = (text: string, phrase: string) => (` ${text} `).includes(` ${phrase} `);

const NAMED_ALIASES = [
  { name: "icefit molde de hielo", aliases: ["icefit", "ice fit"] },
  { name: "aceite corporal magic", aliases: ["aceite magic", "magic oil"] },
  { name: "shampoo biru", aliases: ["shampoo biru", "champu biru", "biru"] },
  { name: "shampoo de cebolla rebrota", aliases: ["shampoo rebrota", "shampoo de cebolla", "rebrota"] },
  { name: "magnesio puro", aliases: ["magnesio puro", "spray de magnesio", "magnesio en spray"] },
];

/** Only reconcile an archived product to a UNIQUE live slug/title. Two live
 * products with the same title remain distinct and therefore ambiguous. */
export function mergeLeadProductCatalog(archive: readonly LeadCatalogProduct[], live: readonly LeadCatalogProduct[]): LeadCatalogProduct[] {
  const result = live.map((p) => ({ ...p, title: productTitleText(p.title), aliases: [...p.aliases ?? []], handles: [...p.handles ?? []] }));
  const liveProducts = [...result];
  for (const old of archive) {
    const exact = liveProducts.filter((p) => p.handle === old.handle);
    const candidates = exact.length ? exact : liveProducts.filter((p) => productTextKey(p.handle) === productTextKey(old.handle)
      || productTextKey(p.title) === productTextKey(old.title));
    if (candidates.length === 1) {
      const target = candidates[0]!;
      target.aliases.push(productTitleText(old.title), ...old.aliases ?? []);
      target.handles.push(old.handle, ...old.handles ?? []);
    } else result.push({ ...old, title: productTitleText(old.title), aliases: [...old.aliases ?? []], handles: [...old.handles ?? []] });
  }
  return result;
}

export function buildProductMatcher(products: readonly LeadCatalogProduct[]) {
  const catalogue = new Map<string, LeadCatalogProduct>();
  for (const p of products) if (p.handle && p.title) catalogue.set(p.handle.toLowerCase(), p);
  const handleAliases = new Map<string, string>();
  for (const [handle, p] of catalogue) for (const h of [handle, ...p.handles ?? []]) handleAliases.set(h.toLowerCase(), handle);
  const aliases = new Map<string, Set<string>>();
  const add = (alias: string, handle: string, named = false) => {
    const key = productTextKey(alias);
    if (key.length < (named ? 3 : 6) || GENERIC.has(key)) return;
    const owners = aliases.get(key) ?? new Set<string>();
    owners.add(handle); aliases.set(key, owners);
  };
  for (const [handle, p] of catalogue) {
    add(p.title, handle);
    add(handle.replace(/-/g, " "), handle);
    // An explicit name before a description; never arbitrary keyword overlap.
    const name = productTitleText(p.title).split(/\s+[–—-]\s+|[|:]/)[0]!;
    if (productTextKey(name).split(" ").length >= 2 || /[™®]/.test(name)) add(name, handle);
    // Type + distinctive name: «Shampoo Biru» rather than requiring the
    // entire marketing subtitle. Shared prefixes stay ambiguous via owners.
    const words = productTextKey(name).split(" ");
    const typedName = /^(shampoo|champu|aceite|magnesio|dispensador|calzon|pulsera|crema|gel|cepillo|serum|colageno|te|capsulas|gomitas|spray)$/.test(words[0] ?? "");
    for (const size of [2, 3]) if (typedName && words.length >= size) add(words.slice(0, size).join(" "), handle);
    for (const alias of p.aliases ?? []) add(alias, handle);
    for (const alias of NAMES) if (contains(productTextKey(p.title), alias)) add(alias, handle);
    for (const family of NAMED_ALIASES) if (contains(productTextKey(p.title), family.name)) {
      for (const alias of family.aliases) add(alias, handle, true);
    }
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
      const canonical = handleAliases.get(h);
      if (canonical) { handles.add(canonical); linked = true; }
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
      if (linked && owners.size > 1 && [...handles].some((h) => owners.has(h))) continue;
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

/** Stored evidence shorter than the 400-char cap is a COMPLETE customer text.
 * A capped excerpt must wait for the full conversation, never resolve from a crop. */
export function clarifyAmbiguousProduct(signal: LeadProductSignal | null | undefined, match: ReturnType<typeof buildProductMatcher>) {
  if (!signal || signal.source !== "ambiguous" || signal.evidence.length >= 400) return signal;
  const found = match({ text: signal.evidence, at: signal.at, id: signal.message_id, direction: "inbound" });
  return found?.handle ? found : signal;
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
