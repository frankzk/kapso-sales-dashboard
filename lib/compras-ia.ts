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
  /** En la moneda del documento, > 0. */
  amount: number;
}

export interface AiProposal {
  /** ISO 4217 en mayúsculas; null si el documento no lo dice. */
  currency: string | null;
  lines: AiLine[];
  charges: AiCharge[];
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
  const rawCurrency = str(o.currency, 10)?.toUpperCase() ?? null;
  const currency = rawCurrency && /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : rawCurrency === "US$" ? "USD" : null;
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
    charges.push({ kind, label: str(c.label ?? c.name, 120) ?? costKindLabel(kind), amount });
    if (charges.length >= AI_MAX_CHARGES) break;
  }

  return { currency, lines, charges, dropped };
}

/**
 * Sin «Montos de compras» la propuesta no lleva precios, ni cargos, ni moneda:
 * se quitan en el servidor antes de mandarla al navegador.
 */
export function stripAiMoney(p: AiProposal): AiProposal {
  return { currency: null, lines: p.lines.map((l) => ({ ...l, unitPrice: null })), charges: [], dropped: p.dropped };
}

// ---------------------------------------------------------------------------
// Coincidencia con los SKU conocidos (referencia §6.9)
// ---------------------------------------------------------------------------

/** Un SKU que la organización ya conoce (Costos de productos o pedidos de la tienda). */
export interface CatalogEntry {
  sku: string;
  name: string | null;
  storeId: string | null;
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
  /** En la moneda del documento. */
  amount?: unknown;
  allocation?: unknown;
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

/**
 * Lo revisado, convertido a lo que reciben `cleanItem` y `cleanCost`. Sin
 * «Montos de compras» no se leen ni precios, ni cargos, ni tipo de cambio:
 * solo nombre, SKU, tienda, cantidad y peso. Con «Montos», un documento que no
 * está en USD pide el tipo de cambio si hay algún precio o cargo; el precio por
 * unidad pasa a USD a 4 decimales y los cargos a 2. Un cargo nunca va «a un
 * producto» (sus productos todavía no existen).
 */
export function aiConfirmToInputs(
  input: AiConfirmInput,
  canMoney: boolean,
): { items: ItemInput[]; costs: CostInput[]; currency: string | null; fx: number | null } | { error: string } {
  const lines = Array.isArray(input.lines) ? input.lines : [];
  const charges = canMoney && Array.isArray(input.charges) ? input.charges : [];
  if (!lines.length && !charges.length) return { error: "Marca al menos un producto o un cargo." };
  if (lines.length > AI_MAX_LINES) return { error: `Como máximo ${AI_MAX_LINES} productos por lectura.` };
  if (charges.length > AI_MAX_CHARGES) return { error: `Como máximo ${AI_MAX_CHARGES} cargos por lectura.` };

  let currency: string | null = null;
  let fx: number | null = null;
  if (canMoney) {
    currency = cleanAiCurrency(input.currency);
    if (!currency) return { error: "Moneda inválida: tres letras (USD, CNY, EUR…)." };
    const prices = lines.some((l) => String(l.unitPrice ?? "").trim() !== "");
    if (currency === "USD") fx = 1;
    else if (prices || charges.length) {
      fx = cleanAiFx(input.fx);
      if (fx === null) return { error: `Escribe el tipo de cambio: 1 USD = X ${currency}.` };
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
      if (raw === "") item.unitCostUsd = "";
      else {
        const price = parseDecimal(raw);
        if (price === null || price < 0) return { error: `Producto ${i + 1}: precio inválido.` };
        item.unitCostUsd = String(unitToUsd(price, fx ?? 1));
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
    costs.push({ kind, label: String(c.label ?? ""), amountUsd: String(chargeToUsd(amount, fx ?? 1)), allocation });
  }
  return { items, costs, currency, fx };
}

/** El hecho del historial al agregar lo leído. */
export function aiReadEventNote(products: number, charges: number, filename: string | null): string {
  const p = `${products} producto${products === 1 ? "" : "s"}`;
  const c = `${charges} cargo${charges === 1 ? "" : "s"}`;
  return `Leído con IA: ${p}, ${c} agregados de ${filename?.trim() || "el documento"}.`;
}
