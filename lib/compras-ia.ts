// «Leer con IA» en Compras (MOM §45.10, 14-11-2026). Reglas PURAS y probadas
// (test/compras-ia.test.ts): qué documentos se leen, qué tamaño aguanta la
// API, cómo se normaliza lo que devuelve el modelo, la coincidencia con los
// SKU conocidos de la organización y la conversión a USD con el tipo de cambio
// que escribe la persona. La llamada a la API está en lib/compras-ia-vision.ts.
//
// Referencia: docs/compras/referencia-modulo-compras.md §7.2 (lectura con IA),
// §6.5 (monedas y redondeos) y §6.9 (coincidencia de productos).
//
// Lo que la IA lee es una PROPUESTA: nada se guarda hasta «Agregar
// seleccionados», que pasa cada fila por las mismas reglas que agregar un
// producto o un costo a mano (`cleanItem`, `cleanCost`).
//
// Monedas e IGV (0342, MOM §45.10): cada CARGO trae su moneda del documento y
// uno en USD o en soles se guarda así, sin convertir (la factura de DHL Express
// Perú en soles da costos en soles); uno en otra moneda (la del documento: CNY,
// EUR…) pasa a USD con el tipo de cambio escrito. Los precios de los productos
// siguen pasando a USD. La IA devuelve cada monto SIN IGV (el valor de venta) y
// el IGV aparte: se muestra como dato y nunca se agrega como costo. Un cargo
// que el documento marca inafecto o exonerado se propone «Inafecto a IGV»; los
// demás, «Sin IGV (monto neto)» (0343).
//
// Compra LOCAL (0343, MOM §45.12): la base es en soles. Los precios de un
// documento en soles se quedan en soles (sin tipo de cambio); los de otra
// moneda pasan a soles con «1 <moneda> = X S/». Los cargos siguen igual: en
// USD o en soles, tal cual.

import {
  COST_KINDS,
  MAX_QTY,
  costKindLabel,
  isImageMime,
  parseDecimal,
  round2,
  round4,
  type CostInput,
  type CostKind,
  type DocKind,
  type ItemInput,
} from "@/lib/compras";

// ---------------------------------------------------------------------------
// Qué se lee y qué tamaño aguanta
// ---------------------------------------------------------------------------

/** Factura comercial, proforma y packing list. */
export const AI_DOC_KINDS: readonly DocKind[] = ["invoice", "proforma", "packing"];

/**
 * La API recibe una imagen de hasta 5 MB y una petición de hasta 32 MB; el
 * PDF va en base64 (un tercio más), así que se corta en 20 MB.
 */
export const AI_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const AI_MAX_PDF_BYTES = 20 * 1024 * 1024;

/** Tope de lo que se agrega de una sola lectura (referencia §7.2). */
export const AI_MAX_LINES = 200;
export const AI_MAX_CHARGES = 20;

/** ¿Este documento ofrece «Leer con IA»? Tipo invoice/proforma/packing y PDF o imagen. */
export function canReadWithAi(doc: { kind: string; mime: string }): boolean {
  return (AI_DOC_KINDS as readonly string[]).includes(doc.kind) && (doc.mime === "application/pdf" || isImageMime(doc.mime));
}

/** El documento, antes de gastar una llamada: tipo, formato y tamaño. El error, tal cual se dice. */
export function checkAiFile(doc: { kind: string; mime: string; size: number }): { ok: true } | { error: string } {
  if (!(AI_DOC_KINDS as readonly string[]).includes(doc.kind)) {
    return { error: "«Leer con IA» es para la factura comercial, la proforma o el packing list." };
  }
  if (doc.mime === "application/pdf") {
    if (doc.size > AI_MAX_PDF_BYTES) return { error: "El PDF pesa más de 20 MB: la IA no lo puede leer. Divídelo o súbelo como imágenes." };
  } else if (isImageMime(doc.mime)) {
    if (doc.size > AI_MAX_IMAGE_BYTES) return { error: "La imagen pesa más de 5 MB: la IA no la puede leer. Súbela más liviana." };
  } else {
    return { error: "La IA solo lee PDF, JPG, PNG o WEBP (no XLSX)." };
  }
  if (!(doc.size > 0)) return { error: "El archivo está vacío." };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// La propuesta
// ---------------------------------------------------------------------------

export interface AiLine {
  name: string;
  sku: string | null;
  /** Entero ≥ 1. */
  qty: number;
  /** En la moneda del documento: el precio por unidad, o el total ÷ la cantidad. Null sin precio. */
  unitPrice: number | null;
  /** Peso por unidad en kg, si se ve. */
  unitWeightKg: number | null;
}

export interface AiCharge {
  kind: CostKind;
  label: string;
  /** Sin IGV, en `currency`, > 0. */
  amount: number;
  /** La moneda del cargo (ISO 4217); sin ella, la del documento; null si ninguno la dice. */
  currency: string | null;
  /**
   * El IGV del cargo (0343, MOM §45.10): `inafecto` si el documento lo marca
   * inafecto o exonerado; si no, `neto` (su monto ya viene sin IGV). Nunca
   * `con_igv`: los montos de la IA vienen sin IGV.
   */
  igvTreatment: "neto" | "inafecto";
}

/** El IGV del documento: un dato aparte, nunca un costo. */
export interface AiIgv {
  amount: number;
  currency: string | null;
}

export interface AiProposal {
  /** ISO 4217 en mayúsculas; null si el documento no lo dice. */
  currency: string | null;
  lines: AiLine[];
  charges: AiCharge[];
  /** El IGV que dice el documento (los montos de las líneas y los cargos ya van sin IGV). */
  igv: AiIgv | null;
  /** Lo que se descartó al normalizar (líneas sin nombre o sin cantidad, cargos sin monto). */
  dropped: number;
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const t = String(v).replace(/\s+/g, " ").trim();
  if (!t || /^(null|n\/a|-+|—)$/i.test(t)) return null;
  return t.slice(0, max);
}

/** Un número que dijo el modelo: número o texto («1,234.50», «US$ 30»). Null si no hay número. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const cleaned = v
    .trim()
    .replace(/^[A-Za-z$€¥£/\s]+/, "")
    .replace(/[A-Za-z$€¥£/\s]+$/, "")
    .trim();
  return parseDecimal(cleaned);
}

/**
 * La cantidad: entera y ≥ 1. Redondea al entero más cercano (una fracción de
 * unidad sube a 1); sin cantidad, cero o negativa, la línea no sirve.
 */
export function normalizeQty(v: unknown): number | null {
  const n = num(v);
  if (n === null || !(n > 0)) return null;
  return Math.min(MAX_QTY, Math.max(1, Math.round(n)));
}

/** El precio por unidad: el que dice el documento o, si no, total ÷ cantidad. */
export function unitPriceOf(unit: unknown, total: unknown, qty: number): number | null {
  const u = num(unit);
  if (u !== null && u >= 0) return u;
  const t = num(total);
  if (t !== null && t >= 0 && qty > 0) return t / qty;
  return null;
}

/**
 * Una moneda que dijo el modelo: ISO 4217 en mayúsculas; «US$» es USD y «S/»,
 * «S/.» o «soles» es PEN. Null si no es una moneda.
 */
export function isoCurrency(v: unknown): string | null {
  const raw = str(v, 10)?.toUpperCase() ?? null;
  if (!raw) return null;
  if (raw === "US$") return "USD";
  if (raw === "S/" || raw === "S/." || raw === "SOLES") return "PEN";
  return /^[A-Z]{3}$/.test(raw) ? raw : null;
}

const CHARGE_KIND: Record<string, CostKind> = {
  envio: "envio",
  shipping: "envio",
  freight: "envio",
  flete: "envio",
  importacion: "importacion",
  import: "importacion",
  customs: "importacion",
  duty: "importacion",
  duties: "importacion",
  tax: "importacion",
  aduana: "importacion",
  adicional: "adicional",
  other: "adicional",
  otro: "adicional",
};

function chargeKind(v: unknown): CostKind {
  const k = String(v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
  return CHARGE_KIND[k] ?? "adicional";
}

/** El objeto de la respuesta: la entrada de la herramienta o el JSON del texto (con o sin cercas). */
function toObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Normaliza lo que devolvió el modelo. Tolera texto alrededor del JSON, números
 * como texto y campos que faltan; descarta las líneas sin nombre o sin
 * cantidad y los cargos sin monto > 0. Null si no hay un objeto que leer.
 */
export function parseAiProposal(raw: unknown): AiProposal | null {
  const o = toObject(raw);
  if (!o) return null;
  const currency = isoCurrency(o.currency);
  let dropped = 0;

  const lines: AiLine[] = [];
  for (const item of Array.isArray(o.lines) ? o.lines : []) {
    if (!item || typeof item !== "object") {
      dropped++;
      continue;
    }
    const l = item as Record<string, unknown>;
    const name = str(l.name ?? l.description, 200);
    const qty = normalizeQty(l.quantity ?? l.qty);
    if (!name || qty === null) {
      dropped++;
      continue;
    }
    const unitWeight = num(l.unit_weight_kg);
    const lineWeight = num(l.line_weight_kg);
    const weight = unitWeight !== null && unitWeight >= 0 ? unitWeight : lineWeight !== null && lineWeight >= 0 ? lineWeight / qty : null;
    lines.push({
      name,
      sku: str(l.sku, 80),
      qty,
      unitPrice: unitPriceOf(l.unit_price, l.line_total, qty),
      unitWeightKg: weight === null ? null : round4(weight),
    });
    if (lines.length >= AI_MAX_LINES) break;
  }

  const charges: AiCharge[] = [];
  for (const item of Array.isArray(o.charges) ? o.charges : []) {
    if (!item || typeof item !== "object") {
      dropped++;
      continue;
    }
    const c = item as Record<string, unknown>;
    const amount = num(c.amount);
    if (amount === null || !(amount > 0)) {
      dropped++;
      continue;
    }
    const kind = chargeKind(c.kind);
    // La moneda de CADA cargo; sin ella, la del documento.
    // Inafecto o exonerado (lo dice el documento); si no, neto: su monto ya va sin IGV.
    const exempt = c.igv_exempt === true || /^(inafect|exoner)/i.test(String(c.igv ?? c.igv_treatment ?? ""));
    charges.push({
      kind,
      label: str(c.label ?? c.name, 120) ?? costKindLabel(kind),
      amount,
      currency: isoCurrency(c.currency) ?? currency,
      igvTreatment: exempt ? "inafecto" : "neto",
    });
    if (charges.length >= AI_MAX_CHARGES) break;
  }

  // El IGV va aparte: se muestra, nunca es un cargo.
  const igvAmount = num(o.igv ?? o.igv_amount);
  const igv = igvAmount !== null && igvAmount > 0 ? { amount: igvAmount, currency: isoCurrency(o.igv_currency) ?? currency } : null;

  return { currency, lines, charges, igv, dropped };
}

/**
 * Sin «Montos de compras» la propuesta no lleva precios, ni cargos, ni moneda,
 * ni IGV: se quitan en el servidor antes de mandarla al navegador.
 */
export function stripAiMoney(p: AiProposal): AiProposal {
  return { currency: null, lines: p.lines.map((l) => ({ ...l, unitPrice: null })), charges: [], igv: null, dropped: p.dropped };
}

// ---------------------------------------------------------------------------
// Coincidencia con los SKU conocidos (referencia §6.9)
// ---------------------------------------------------------------------------

/** Un SKU que la organización ya conoce (Costos de productos o pedidos de la tienda). */
export interface CatalogEntry {
  sku: string;
  name: string | null;
  storeId: string | null;
  /** En cuántos pedidos de las tiendas apareció (`org_shopify_products`); los de Costos no traen. */
  orderCount?: number | null;
}

export interface CatalogProduct {
  sku: string;
  name: string | null;
  /** La tienda, si todas las veces que se vio el SKU fue en la misma; si no, null. */
  storeId: string | null;
}

/** El nombre para comparar: sin tildes, minúsculas, todo lo que no es letra o número → espacio. */
export function normalizeProductName(name: string | null | undefined): string {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const skuKey = (sku: string | null | undefined) => String(sku ?? "").trim().toLowerCase();

/**
 * Un producto por SKU (sin mayúsculas ni espacios al borde). La tienda solo se
 * sugiere si el SKU se vio siempre en la misma; el nombre, el primero que lo
 * tenga.
 */
export function buildCatalog(entries: readonly CatalogEntry[]): CatalogProduct[] {
  const byKey = new Map<string, { sku: string; name: string | null; stores: Set<string | null> }>();
  for (const e of entries) {
    const key = skuKey(e.sku);
    if (!key) continue;
    const cur = byKey.get(key) ?? { sku: e.sku.trim(), name: null, stores: new Set<string | null>() };
    cur.name ??= (e.name ?? "").trim() || null;
    cur.stores.add(e.storeId ?? null);
    byKey.set(key, cur);
  }
  return [...byKey.values()].map((p) => {
    const stores = [...p.stores];
    return { sku: p.sku, name: p.name, storeId: stores.length === 1 ? (stores[0] ?? null) : null };
  });
}

/** Un producto del selector de «Agregar producto» (MOM §45.1): el del catálogo y en cuántos pedidos salió. */
export interface PickerProduct extends CatalogProduct {
  orderCount: number;
}

/**
 * El catálogo para elegir un producto a mano en «Agregar producto»: el mismo
 * `buildCatalog` que usa «Leer con IA» (un producto por SKU, la tienda solo si
 * el SKU se vio siempre en la misma), con los pedidos sumados por SKU y
 * ordenado de más a menos pedidos; a igual cifra, por nombre.
 */
export function buildProductPicker(entries: readonly CatalogEntry[]): PickerProduct[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const key = skuKey(e.sku);
    if (!key) continue;
    const n = Number(e.orderCount);
    counts.set(key, (counts.get(key) ?? 0) + (Number.isFinite(n) && n > 0 ? n : 0));
  }
  return buildCatalog(entries)
    .map((p) => ({ ...p, orderCount: counts.get(skuKey(p.sku)) ?? 0 }))
    .sort((a, b) => b.orderCount - a.orderCount || (a.name ?? a.sku).localeCompare(b.name ?? b.sku, "es"));
}

/**
 * Buscar en el selector por nombre o SKU: cada palabra escrita tiene que estar
 * en el nombre normalizado o en el SKU (sin tildes ni mayúsculas). Conserva el
 * orden del catálogo (los más pedidos primero).
 */
export function searchProductPicker(list: readonly PickerProduct[], query: string, limit = 8): PickerProduct[] {
  const words = normalizeProductName(query).split(" ").filter(Boolean);
  if (!words.length) return list.slice(0, limit);
  const out: PickerProduct[] = [];
  for (const p of list) {
    const hay = `${normalizeProductName(p.name)} ${normalizeProductName(p.sku)} ${skuKey(p.sku)}`;
    if (words.every((w) => hay.includes(w))) out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

export const MIN_NAME_MATCH = 6;

/**
 * El producto conocido de una línea (referencia §6.9): con SKU, el único cuyo
 * SKU coincide (sin mayúsculas, sin espacios al borde); si hay varios, ninguno
 * y no se intenta por nombre; si no hay, por el nombre normalizado, de al
 * menos 6 caracteres y que coincida con exactamente uno. Si no, es nuevo.
 */
export function matchCatalog(line: { sku: string | null; name: string }, catalog: readonly CatalogProduct[]): CatalogProduct | null {
  const key = skuKey(line.sku);
  if (key) {
    const bySku = catalog.filter((p) => skuKey(p.sku) === key);
    if (bySku.length === 1) return bySku[0]!;
    if (bySku.length > 1) return null;
  }
  const name = normalizeProductName(line.name);
  if (name.length < MIN_NAME_MATCH) return null;
  const byName = catalog.filter((p) => normalizeProductName(p.name) === name);
  return byName.length === 1 ? byName[0]! : null;
}

// ---------------------------------------------------------------------------
// De la propuesta revisada a filas (referencia §6.5)
// ---------------------------------------------------------------------------

/** Lo que manda el navegador al pulsar «Agregar seleccionados» (solo lo marcado). */
export interface AiConfirmLine {
  name?: unknown;
  sku?: unknown;
  storeId?: unknown;
  qty?: unknown;
  unitWeightKg?: unknown;
  /** En la moneda del documento. Se ignora sin «Montos de compras». */
  unitPrice?: unknown;
}

export interface AiConfirmCharge {
  kind?: unknown;
  label?: unknown;
  /** Sin IGV, en `currency`. */
  amount?: unknown;
  /** USD, PEN o la moneda del documento; vacío = la del documento. */
  currency?: unknown;
  allocation?: unknown;
  /** neto (por defecto) o inafecto; nunca con IGV (los montos vienen sin IGV). */
  igvTreatment?: unknown;
}

export interface AiConfirmInput {
  documentId?: unknown;
  currency?: unknown;
  /** «1 USD = X <moneda>». */
  fx?: unknown;
  lines?: AiConfirmLine[];
  charges?: AiConfirmCharge[];
}

/** La moneda que se confirma: tres letras; vacía = USD. */
export function cleanAiCurrency(raw: unknown): string | null {
  const v = String(raw ?? "").trim().toUpperCase();
  if (!v) return "USD";
  return /^[A-Z]{3}$/.test(v) ? v : null;
}

/** «1 USD = X <moneda>»: X > 0. Null si no es eso. */
export function cleanAiFx(raw: unknown): number | null {
  const n = parseDecimal(raw);
  return n !== null && n > 0 && n <= 1_000_000 ? n : null;
}

/** Precio por unidad en USD: ÷ X y a 4 decimales. */
export function unitToUsd(price: number, fx: number): number {
  return round4(price / fx);
}

/** Un cargo en USD: ÷ X y a 2 decimales. */
export function chargeToUsd(amount: number, fx: number): number {
  return round2(amount / fx);
}

/** Precio por unidad en soles (compra local): × X («1 <moneda> = X S/») y a 4 decimales. */
export function unitToPen(price: number, penPerUnit: number): number {
  return round4(price * penPerUnit);
}

/** Un cargo en soles (compra local) desde la moneda del documento: × X y a 2 decimales. */
export function chargeToPen(amount: number, penPerUnit: number): number {
  return round2(amount * penPerUnit);
}

/**
 * ¿Hace falta el tipo de cambio para los PRECIOS? Solo si el documento no está
 * en la moneda base de la compra (USD la importación, soles la compra local).
 */
export function aiPricesNeedFx(documentCurrency: string, base: "USD" | "PEN"): boolean {
  return documentCurrency !== base;
}

/**
 * La moneda en que se GUARDA un cargo de la propuesta: USD y soles, tal cual
 * (0342); la del documento (CNY, EUR…), en USD con el tipo de cambio escrito.
 */
export function aiChargeStoredCurrency(chargeCurrency: string): "USD" | "PEN" {
  return chargeCurrency === "PEN" ? "PEN" : "USD";
}

/** ¿Este cargo hay que convertirlo con «1 USD = X <moneda del documento>»? Solo si no es USD ni soles. */
export function aiChargeNeedsFx(chargeCurrency: string): boolean {
  return chargeCurrency !== "USD" && chargeCurrency !== "PEN";
}

/**
 * Lo revisado, convertido a lo que reciben `cleanItem` y `cleanCost`. Sin
 * «Montos de compras» no se leen ni precios, ni cargos, ni tipo de cambio:
 * solo nombre, SKU, tienda, cantidad y peso. Con «Montos», el precio por unidad
 * de un documento que no está en USD pasa a USD con «1 USD = X <moneda>» a 4
 * decimales. Cada cargo va en SU moneda: en USD o en soles se guarda así (a 2
 * decimales, sin convertir); en la moneda del documento (ni USD ni soles), pasa
 * a USD ÷ X a 2 decimales. El tipo de cambio se pide solo si algo lo necesita.
 * Un cargo nunca va «a un producto» (sus productos todavía no existen) y el IGV
 * del documento nunca entra: los cargos ya van sin IGV.
 */
export function aiConfirmToInputs(
  input: AiConfirmInput,
  canMoney: boolean,
  /** La moneda base de la compra: USD (importación) o PEN (compra local, MOM §45.12). */
  base: "USD" | "PEN" = "USD",
): { items: ItemInput[]; costs: CostInput[]; currency: string | null; fx: number | null } | { error: string } {
  const lines = Array.isArray(input.lines) ? input.lines : [];
  const charges = canMoney && Array.isArray(input.charges) ? input.charges : [];
  if (!lines.length && !charges.length) return { error: "Marca al menos un producto o un cargo." };
  if (lines.length > AI_MAX_LINES) return { error: `Como máximo ${AI_MAX_LINES} productos por lectura.` };
  if (charges.length > AI_MAX_CHARGES) return { error: `Como máximo ${AI_MAX_CHARGES} cargos por lectura.` };

  let currency: string | null = null;
  let fx: number | null = null;
  const chargeCurrencies: string[] = [];
  if (canMoney) {
    currency = cleanAiCurrency(input.currency);
    if (!currency) return { error: "Moneda inválida: tres letras (USD, CNY, EUR…)." };
    for (const [i, c] of charges.entries()) {
      const raw = String(c.currency ?? "").trim();
      const cur: string | null = raw ? cleanAiCurrency(raw) : currency;
      if (!cur || (cur !== "USD" && cur !== "PEN" && cur !== currency)) {
        return { error: `Cargo ${i + 1}: la moneda es US$, S/ o la del documento (${currency}).` };
      }
      chargeCurrencies.push(cur);
    }
    const prices = lines.some((l) => String(l.unitPrice ?? "").trim() !== "");
    // Importación: «1 USD = X <moneda>». Compra local: «1 <moneda> = X S/»; en
    // soles no se pide nada (los precios se quedan en soles).
    if (currency === base) fx = 1;
    else if (prices || chargeCurrencies.some(aiChargeNeedsFx)) {
      fx = cleanAiFx(input.fx);
      if (fx === null) return { error: base === "PEN" ? `Escribe el tipo de cambio: 1 ${currency} = X S/.` : `Escribe el tipo de cambio: 1 USD = X ${currency}.` };
    }
  }

  const items: ItemInput[] = [];
  for (const [i, l] of lines.entries()) {
    const item: ItemInput = {
      name: String(l.name ?? ""),
      sku: String(l.sku ?? ""),
      storeId: String(l.storeId ?? ""),
      qty: l.qty,
      unitWeightKg: l.unitWeightKg == null ? "" : String(l.unitWeightKg),
    };
    if (canMoney) {
      const raw = String(l.unitPrice ?? "").trim();
      const key = base === "PEN" ? "unitCostPen" : "unitCostUsd";
      if (raw === "") item[key] = "";
      else {
        const price = parseDecimal(raw);
        if (price === null || price < 0) return { error: `Producto ${i + 1}: precio inválido.` };
        item[key] = String(base === "PEN" ? unitToPen(price, fx ?? 1) : unitToUsd(price, fx ?? 1));
      }
      item.salePricePen = "";
    }
    items.push(item);
  }

  const costs: CostInput[] = [];
  for (const [i, c] of charges.entries()) {
    const kind = String(c.kind ?? "");
    if (!COST_KINDS.some((k) => k.id === kind)) return { error: `Cargo ${i + 1}: tipo inválido.` };
    const amount = parseDecimal(c.amount);
    if (amount === null || !(amount > 0)) return { error: `Cargo ${i + 1}: el monto debe ser mayor que 0.` };
    const allocation = String(c.allocation ?? "") || "value";
    if (allocation === "item") return { error: `Cargo ${i + 1}: elige un reparto por valor, unidades o peso.` };
    const cur = chargeCurrencies[i]!;
    // USD y soles, tal cual; la moneda del documento, a la base con el tipo de
    // cambio (a USD en una importación, a soles en una compra local).
    const convert = aiChargeNeedsFx(cur);
    const stored = convert ? (base === "PEN" ? chargeToPen(amount, fx ?? 1) : chargeToUsd(amount, fx ?? 1)) : round2(amount);
    const storedCurrency = convert ? base : aiChargeStoredCurrency(cur);
    const igvTreatment = String(c.igvTreatment ?? "") === "inafecto" ? "inafecto" : "neto";
    costs.push({ kind, label: String(c.label ?? ""), amount: String(stored), currency: storedCurrency, allocation, igvTreatment });
  }
  return { items, costs, currency, fx };
}

/** El hecho del historial al agregar lo leído. */
export function aiReadEventNote(products: number, charges: number, filename: string | null): string {
  const p = `${products} producto${products === 1 ? "" : "s"}`;
  const c = `${charges} cargo${charges === 1 ? "" : "s"}`;
  return `Leído con IA: ${p}, ${c} agregados de ${filename?.trim() || "el documento"}.`;
}
