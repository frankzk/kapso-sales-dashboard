// «Compras»: importaciones (MOM §45, 14-11-2026). Reglas PURAS y probadas
// (test/compras.test.ts). La referencia funcional es
// docs/compras/referencia-modulo-compras.md (módulo de Miranova); esto la
// adapta a Kapta: bodega propia en Lima, fechas de America/Lima, la base en USD
// con el tipo de cambio de cada importación, y «Pasar a Costos».
//
// Monedas (MOM §45.3, 0342): el costo del proveedor va en USD; cada costo
// repartido y cada pago guarda SU moneda (USD o soles) tal como se escribió.
// Nada se convierte al guardar: el costo aterrizado se calcula en las dos
// vistas con el tipo de cambio de la importación (`Money2`, `moneyInUsd`,
// `moneyInPen`) y, sin él, lo que necesita convertirse dice «Falta el tipo de
// cambio» en vez de una cifra a medias.
//
// Lo que NO se copia de la referencia (su §13): la fecha de llegada y el año
// del código en UTC (aquí, Lima); «atrasada» y «avisar» contando cotizaciones
// (aquí, nunca); un costo «a un producto» que desaparece al quitar el producto
// (aquí se queda y se reparte por valor, con aviso).
//
// Compras locales, cortesía y entregas parciales (MOM §45.12–§45.14, 0343): una
// compra puede ser una importación (base USD, `IMP-`) o una compra LOCAL a un
// laboratorio o maquila (base soles, `LOC-`). Cada producto puede traer
// unidades de cortesía (gratis: no suben ningún monto y bajan el costo por
// unidad buena) y lo que llega se registra por ENTREGAS, cada una con su fecha,
// sus unidades por producto y sus fotos; los totales del producto son la suma
// de sus entregas (en la base los mantiene un trigger de la 0343).

// ---------------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------------

export const IMPORT_STATUSES = [
  { id: "cotizacion", label: "Cotización" },
  { id: "pagado", label: "Pagado" },
  { id: "en_produccion", label: "En producción" },
  { id: "en_transito", label: "En tránsito" },
  { id: "en_aduana", label: "En aduana" },
  { id: "en_camino_bodega", label: "En camino a bodega" },
  // 0343 (MOM §45.14): llegó una parte; falta lo demás.
  { id: "recibido_parcial", label: "Recibido parcial" },
  { id: "recibido", label: "Recibido" },
  { id: "ingresado", label: "Ingresado al inventario" },
  { id: "cerrado", label: "Cerrado" },
  { id: "cancelado", label: "Cancelado" },
] as const;

export type ImportStatus = (typeof IMPORT_STATUSES)[number]["id"];

export const IMPORT_STATUS_LABEL = Object.fromEntries(IMPORT_STATUSES.map((s) => [s.id, s.label])) as Record<
  ImportStatus,
  string
>;

export function isImportStatus(value: unknown): value is ImportStatus {
  return typeof value === "string" && IMPORT_STATUSES.some((s) => s.id === value);
}

/** Ya llegó a la bodega: pestaña «Recibidas». */
export const RECEIVED_STATUSES: readonly ImportStatus[] = ["recibido", "ingresado", "cerrado"];
/** Viaja: si pasa 7 días sin novedades, se avisa. */
export const TRAVELING_STATUSES: readonly ImportStatus[] = ["en_transito", "en_aduana", "en_camino_bodega"];
/** Días sin novedades para la alerta «Sin novedades». */
export const STALE_DAYS = 7;
/** «Avisar a la bodega» desde N días antes de la llegada estimada. */
export const NOTIFY_WAREHOUSE_DAYS = 3;

/** Activa: ni llegó ni se canceló. Incluye la cotización. */
export function isActiveStatus(status: ImportStatus): boolean {
  return status !== "cancelado" && !RECEIVED_STATUSES.includes(status);
}

const STATUS_ORDER = IMPORT_STATUSES.map((s) => s.id as ImportStatus);

/** Antes de «Recibido» en el orden del ciclo (sin contar la cancelada). Incluye «Recibido parcial». */
export function isBeforeReceived(status: ImportStatus): boolean {
  if (status === "cancelado") return false;
  return STATUS_ORDER.indexOf(status) < STATUS_ORDER.indexOf("recibido");
}

/** Antes de «Recibido parcial»: de Cotización a En camino a bodega (MOM §45.14). */
export function isBeforePartial(status: ImportStatus): boolean {
  if (status === "cancelado") return false;
  return STATUS_ORDER.indexOf(status) < STATUS_ORDER.indexOf("recibido_parcial");
}

export type ImportTab = "activas" | "recibidas" | "canceladas" | "todas";

export const IMPORT_TABS: { id: ImportTab; label: string }[] = [
  { id: "activas", label: "Activas" },
  { id: "recibidas", label: "Recibidas" },
  { id: "canceladas", label: "Canceladas" },
  { id: "todas", label: "Todas" },
];

export function importTabOf(status: ImportStatus): Exclude<ImportTab, "todas"> {
  if (status === "cancelado") return "canceladas";
  return RECEIVED_STATUSES.includes(status) ? "recibidas" : "activas";
}

export function inImportTab(status: ImportStatus, tab: ImportTab): boolean {
  return tab === "todas" || importTabOf(status) === tab;
}

// ---------------------------------------------------------------------------
// Tipo de compra (MOM §45.12, 0343): importación o compra local
// ---------------------------------------------------------------------------

/**
 * Una compra es una IMPORTACIÓN (del extranjero, base USD, código `IMP-`) o una
 * COMPRA LOCAL a un laboratorio o maquila de Perú (base soles, código `LOC-`).
 * Comparten la lista, el detalle, los productos, documentos, pagos, entregas,
 * historial, costo aterrizado y «Pasar a Costos». El tipo se elige al crearla y
 * no cambia (el código lo lleva).
 */
export const IMPORT_KINDS = [
  { id: "importacion", label: "Importación" },
  { id: "local", label: "Compra local" },
] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number]["id"];

export function isImportKind(value: unknown): value is ImportKind {
  return value === "importacion" || value === "local";
}

/** El tipo de una fila; sin él (antes de la 0343), importación. */
export function importKindOf(value: unknown): ImportKind {
  return value === "local" ? "local" : "importacion";
}

export const importKindLabel = (kind: ImportKind | null | undefined) => (kind === "local" ? "Compra local" : "Importación");

/** El prefijo del código: `IMP-` la importación, `LOC-` la compra local. */
export const IMPORT_CODE_PREFIX: Record<ImportKind, string> = { importacion: "IMP", local: "LOC" };

/**
 * La moneda base: USD la importación (el costo del proveedor por unidad va en
 * dólares) y SOLES la compra local (el laboratorio cobra en soles). Los costos
 * y pagos nacen en esa moneda y pueden ir en la otra (0342).
 */
export function baseCurrencyOf(kind: ImportKind | null | undefined): Currency {
  return kind === "local" ? "PEN" : "USD";
}

/** Transporte, paquetera, guía y «Avisar a la bodega» solo son de una importación. */
export function hasShipping(kind: ImportKind | null | undefined): boolean {
  return kind !== "local";
}

/** Una entrega de una compra local lleva al menos una foto de lo que llegó (decisión del owner). */
export function deliveryNeedsPhoto(kind: ImportKind | null | undefined): boolean {
  return kind === "local";
}

/** Un pago de una compra local lleva la captura de lo que se le pagó al laboratorio. */
export function paymentNeedsVoucher(kind: ImportKind | null | undefined): boolean {
  return kind === "local";
}

export const DELIVERY_PHOTO_REQUIRED = "En una compra local cada entrega lleva al menos una foto de lo que llegó.";
export const PAYMENT_VOUCHER_REQUIRED = "En una compra local el pago lleva la captura del comprobante (imagen o PDF).";

// ---------------------------------------------------------------------------
// Catálogos
// ---------------------------------------------------------------------------

export const TRANSPORTS = [
  { id: "courier", label: "Courier" },
  { id: "air", label: "Aéreo" },
  { id: "sea", label: "Marítimo" },
  { id: "land", label: "Terrestre" },
] as const;
export type Transport = (typeof TRANSPORTS)[number]["id"];

export const COST_KINDS = [
  { id: "envio", label: "Envío" },
  { id: "importacion", label: "Importación" },
  { id: "adicional", label: "Adicional" },
] as const;
export type CostKind = (typeof COST_KINDS)[number]["id"];

export const ALLOCATIONS = [
  { id: "value", label: "Por valor" },
  { id: "units", label: "Por unidades" },
  { id: "weight", label: "Por peso" },
  { id: "item", label: "Todo a un producto" },
] as const;
export type Allocation = (typeof ALLOCATIONS)[number]["id"];

export const PAYMENT_METHODS = [
  { id: "transferencia", label: "Transferencia" },
  { id: "tarjeta", label: "Tarjeta" },
  { id: "paypal", label: "PayPal" },
  { id: "alibaba", label: "Alibaba" },
  { id: "western_union", label: "Western Union" },
  { id: "efectivo", label: "Efectivo" },
  { id: "otro", label: "Otro" },
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]["id"];

export const DOC_KINDS = [
  { id: "proforma", label: "Proforma invoice" },
  { id: "invoice", label: "Factura comercial" },
  { id: "packing", label: "Packing list" },
  { id: "payment", label: "Comprobante de pago" },
  { id: "tracking", label: "Guía (AWB / BL)" },
  { id: "customs", label: "Aduana" },
  { id: "photo", label: "Foto" },
  { id: "other", label: "Otro" },
] as const;
export type DocKind = (typeof DOC_KINDS)[number]["id"];

/** Documentos con montos: verlos, subirlos y quitarlos pide «Montos de compras». */
export const MONEY_DOC_KINDS: readonly DocKind[] = ["proforma", "payment"];

export function isMoneyDoc(kind: string): boolean {
  return (MONEY_DOC_KINDS as readonly string[]).includes(kind);
}

/**
 * Lo que ve quien solo tiene «Recepción de compras» (MOM §45.11): la factura
 * comercial y el packing list para contar, y las fotos (las que sube).
 */
export const RECEIVE_DOC_KINDS: readonly DocKind[] = ["invoice", "packing", "photo"];
/** Lo único que sube quien solo tiene «Recepción de compras». */
export const RECEIVE_UPLOAD_KINDS: readonly DocKind[] = ["photo"];

/** Los permisos de Compras de una persona en una organización. */
export interface ComprasAccess {
  canManage: boolean;
  canMoney: boolean;
  /** «Recepción de compras» (`purchases.receive`, MOM §45.11). */
  canReceive: boolean;
}

/** ¿Abre Compras (lista y detalle)? Cualquiera de los tres permisos. */
export function canViewCompras(p: ComprasAccess): boolean {
  return p.canManage || p.canMoney || p.canReceive;
}

/** Solo «Recepción de compras»: sin «Compras» ni «Montos de compras». */
export function isReceiveOnly(p: ComprasAccess): boolean {
  return p.canReceive && !p.canManage && !p.canMoney;
}

/**
 * ¿Ve (y descarga) un documento de este tipo? Proforma y comprobante, solo con
 * «Montos»; el resto, con «Compras» o «Montos»; con solo «Recepción», la
 * factura comercial, el packing list y las fotos.
 */
export function canSeeDocKind(kind: string, p: ComprasAccess): boolean {
  if (isMoneyDoc(kind)) return p.canMoney;
  if (p.canManage || p.canMoney) return true;
  return p.canReceive && (RECEIVE_DOC_KINDS as readonly string[]).includes(kind);
}

/**
 * ¿Sube un documento de este tipo? Con «Compras», los que no tienen montos (y
 * con «Montos» además, todos); con «Recepción de compras», solo fotos.
 */
export function canUploadDocKind(kind: string, p: ComprasAccess): boolean {
  if (p.canManage) return !isMoneyDoc(kind) || p.canMoney;
  return p.canReceive && (RECEIVE_UPLOAD_KINDS as readonly string[]).includes(kind);
}

export const EVENT_KINDS = ["status", "nota", "producto", "dinero", "documento", "recepcion", "bodega", "costos", "datos"] as const;
export type ImportEventKind = (typeof EVENT_KINDS)[number];
/** Cuentan como novedad del envío (para «Sin novedades»). */
export const MOVEMENT_EVENT_KINDS: readonly ImportEventKind[] = ["status", "nota"];
/** Solo se muestran con «Montos de compras». */
export const MONEY_EVENT_KINDS: readonly ImportEventKind[] = ["dinero"];

function labelOf<T extends readonly { id: string; label: string }[]>(list: T, id: string | null | undefined): string {
  return list.find((x) => x.id === id)?.label ?? "—";
}
export const transportLabel = (id: string | null | undefined) => labelOf(TRANSPORTS, id);
export const costKindLabel = (id: string | null | undefined) => labelOf(COST_KINDS, id);
export const allocationLabel = (id: string | null | undefined) => labelOf(ALLOCATIONS, id);
export const paymentMethodLabel = (id: string | null | undefined) => labelOf(PAYMENT_METHODS, id);
export const docKindLabel = (id: string | null | undefined) => labelOf(DOC_KINDS, id);

// ---------------------------------------------------------------------------
// Archivos
// ---------------------------------------------------------------------------

export const IMPORT_FILES_BUCKET = "import-files";
export const IMPORT_FILE_MAX_BYTES = 25 * 1024 * 1024;

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  [XLSX]: "xlsx",
};
const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  xlsx: XLSX,
};
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** El tipo del archivo; si el navegador no lo dice, por la extensión. Null si no se acepta. */
export function importFileMime(contentType: string | null | undefined, filename: string | null | undefined): string | null {
  const ct = (contentType ?? "").trim().toLowerCase();
  if (ct === "image/jpg") return "image/jpeg";
  if (EXT_BY_MIME[ct]) return ct;
  if (ct && ct !== "application/octet-stream") return null;
  const ext = /\.([a-z0-9]+)$/i.exec(filename ?? "")?.[1]?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? null;
}

export function importFileExt(mime: string): string | null {
  return EXT_BY_MIME[mime] ?? null;
}

export function isImageMime(mime: string): boolean {
  return IMAGE_MIMES.has(mime);
}

/** ¿Se acepta este archivo para este tipo de documento? Devuelve el error tal cual se dice. */
export function checkImportFile(
  kind: DocKind | "item_photo",
  file: { contentType?: string | null; filename?: string | null; size: number },
): { mime: string } | { error: string } {
  const mime = importFileMime(file.contentType, file.filename);
  if (!mime) return { error: "El archivo debe ser PDF, JPG, PNG, WEBP o XLSX." };
  if ((kind === "photo" || kind === "item_photo") && !isImageMime(mime)) {
    return { error: "Las fotos deben ser JPG, PNG o WEBP." };
  }
  if (!(file.size > 0)) return { error: "El archivo está vacío." };
  if (file.size > IMPORT_FILE_MAX_BYTES) return { error: "El archivo pesa más de 25 MB." };
  return { mime };
}

/** Carpeta de una importación en el bucket: `<org>/<importación>/`. */
export function importFolder(orgId: string, importId: string): string {
  return `${orgId}/${importId}/`;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const UUID_RE = new RegExp(`^${UUID}$`, "i");

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** ¿Es una ruta que el servidor generó para ESTA importación (`docs` o `items`)? */
export function isImportFilePath(path: string, orgId: string, importId: string, folder: "docs" | "items"): boolean {
  const prefix = `${importFolder(orgId, importId)}${folder}/`;
  if (typeof path !== "string" || !path.startsWith(prefix)) return false;
  return new RegExp(`^${UUID}\\.(pdf|jpg|png|webp|xlsx)$`, "i").test(path.slice(prefix.length));
}

// ---------------------------------------------------------------------------
// Fechas (America/Lima)
// ---------------------------------------------------------------------------

export const LIMA_TZ = "America/Lima";
const LIMA_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: LIMA_TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** El día calendario de Lima (`AAAA-MM-DD`) de un instante. */
export function limaDateOf(at: Date | string | number): string {
  const d = at instanceof Date ? at : new Date(at);
  return LIMA_DAY.format(d);
}

/** Hoy en Lima. */
export function limaToday(now: Date = new Date()): string {
  return limaDateOf(now);
}

/** El año de Lima: el del código `IMP-<año>-NNN`. */
export function limaYear(now: Date = new Date()): number {
  return Number(limaToday(now).slice(0, 4));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ¿`AAAA-MM-DD` y un día que existe? */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Días de `from` a `to` (fechas `AAAA-MM-DD`). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** `2026-11-14` → `14/11/2026`. */
export function formatDmy(date: string | null | undefined): string {
  if (!date || !isIsoDate(date)) return "—";
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}

// ---------------------------------------------------------------------------
// Código IMP-AAAA-NNN
// ---------------------------------------------------------------------------

/** `IMP-AAAA-NNN` (importación) o `LOC-AAAA-NNN` (compra local); con `kind`, solo el de ese tipo. */
export function isImportCode(value: unknown, kind?: ImportKind): value is string {
  if (typeof value !== "string") return false;
  const m = /^(IMP|LOC)-\d{4}-\d{3,}$/.exec(value);
  return Boolean(m) && (!kind || m![1] === IMPORT_CODE_PREFIX[kind]);
}

/**
 * El siguiente código del año y del tipo: el mayor número existente con ese
 * prefijo + 1, con 3 dígitos como mínimo. `existing` son los códigos de la
 * organización (los de otros años y los del otro tipo no cuentan: cada serie
 * va por su lado, `IMP-2026-001` y `LOC-2026-001` conviven).
 */
export function nextImportCode(existing: readonly string[], year: number, kind: ImportKind = "importacion"): string {
  const prefix = `${IMPORT_CODE_PREFIX[kind]}-${year}-`;
  let max = 0;
  for (const code of existing) {
    if (!code.startsWith(prefix)) continue;
    const n = Number(code.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Números
// ---------------------------------------------------------------------------

/** Redondeo a 2 decimales (lo que se guarda en soles). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Redondeo a 4 decimales (costos por unidad en USD). */
export function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10_000) / 10_000;
}

/** Un número escrito por una persona: «1,234.50», «12,5», «US$ 30». Null si no es un número. */
export function parseDecimal(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let s = String(raw ?? "").trim().replace(/^(us\$|s\/|\$)\s*/i, "").replace(/\s+/g, "");
  if (!s) return null;
  // «1,234.50» → miles con coma; «1,500» → miles; «12,5» → decimal con coma.
  if (s.includes(",") && s.includes(".")) s = s.replace(/,/g, "");
  else if (/^-?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Un entero escrito por una persona («1,500», «2000»). Null si no lo es. */
export function parseInteger(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) ? raw : null;
  const s = String(raw ?? "").trim().replace(/[\s,.](?=\d{3}(\D|$))/g, "");
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Monedas (MOM §45.3, 0342): cada costo y cada pago en la suya
// ---------------------------------------------------------------------------

export const CURRENCIES = [
  { id: "USD", label: "US$" },
  { id: "PEN", label: "S/" },
] as const;
export type Currency = (typeof CURRENCIES)[number]["id"];

export function isCurrency(value: unknown): value is Currency {
  return value === "USD" || value === "PEN";
}

/** «US$» o «S/». */
export const currencySymbol = (c: Currency | null | undefined) => (c === "PEN" ? "S/" : "US$");

/** Lo que dice una pantalla o el historial cuando hace falta convertir y no hay con qué. */
export const MISSING_FX = "Falta el tipo de cambio";

/** El tipo de cambio de la importación si sirve (> 0); si no, null. */
export function validFx(fx: number | null | undefined): number | null {
  return typeof fx === "number" && Number.isFinite(fx) && fx > 0 ? fx : null;
}

/** Dinero SIN convertir: lo que está en USD y lo que está en soles, por separado. */
export interface Money2 {
  usd: number;
  pen: number;
}

export const zeroMoney = (): Money2 => ({ usd: 0, pen: 0 });

/** Un monto en su moneda como `Money2`. */
export function moneyOf(amount: number, currency: Currency | null | undefined): Money2 {
  return currency === "PEN" ? { usd: 0, pen: amount } : { usd: amount, pen: 0 };
}

export function addMoney(a: Money2, b: Money2): Money2 {
  return { usd: a.usd + b.usd, pen: a.pen + b.pen };
}

/**
 * En USD (la base de la importación): lo que está en USD tal cual y los soles ÷
 * el tipo de cambio. Null si hay soles y no hay tipo de cambio.
 */
export function moneyInUsd(m: Money2, fx: number | null | undefined): number | null {
  if (m.pen === 0) return m.usd;
  const r = validFx(fx);
  return r ? m.usd + m.pen / r : null;
}

/**
 * En soles: lo que está en USD × el tipo de cambio y los soles TAL CUAL (sin ida
 * y vuelta por el dólar). Null si hay USD y no hay tipo de cambio.
 */
export function moneyInPen(m: Money2, fx: number | null | undefined): number | null {
  if (m.usd === 0) return m.pen;
  const r = validFx(fx);
  return r ? m.usd * r + m.pen : null;
}

/** `US$ 20.07` · `S/ 427.25`: como lo escribe el historial. */
export function moneyText(amount: number, currency: Currency | null | undefined): string {
  return `${currencySymbol(currency)} ${amount.toFixed(2)}`;
}

/** La moneda escrita en el formulario: vacía = USD (como antes de la 0342). Null si no es USD ni PEN. */
export function cleanCurrency(raw: unknown): Currency | null {
  const v = String(raw ?? "").trim().toUpperCase();
  if (!v) return "USD";
  if (v === "S/" || v === "S/.") return "PEN";
  if (v === "US$") return "USD";
  return isCurrency(v) ? v : null;
}

// ---------------------------------------------------------------------------
// IGV (MOM §45.3): sin IGV, incluye IGV o inafecto, en cada costo
// ---------------------------------------------------------------------------

/** El IGV de Perú: 18 %. */
export const IGV_RATE = 0.18;

/** El monto sin IGV de un total con IGV: total ÷ 1,18, a 2 decimales (S/ 504.16 → S/ 427.25). */
export function netOfIgv(gross: number): number {
  return round2(gross / (1 + IGV_RATE));
}

/** El IGV de un total con IGV: total − sin IGV (S/ 504.16 → S/ 76.91). */
export function igvOf(gross: number): number {
  return round2(gross - netOfIgv(gross));
}

/**
 * El tratamiento del IGV de un costo (MOM §45.3, 0343, decisión del owner del
 * 14-11-2026: hay costos que no llevan IGV, como el flete internacional):
 *   - «Sin IGV (monto neto)» (`neto`, el de siempre): el monto entra tal cual;
 *   - «Incluye IGV 18 %» (`con_igv`): entra el monto ÷ 1,18 y se guarda el
 *     monto con IGV (`gross_amount`, `includes_igv`);
 *   - «Inafecto a IGV» (`inafecto`): entra tal cual y queda dicho que no lleva
 *     IGV.
 */
export const IGV_TREATMENTS = [
  { id: "neto", label: "Sin IGV (monto neto)" },
  { id: "con_igv", label: "Incluye IGV 18 %" },
  { id: "inafecto", label: "Inafecto a IGV" },
] as const;
export type IgvTreatment = (typeof IGV_TREATMENTS)[number]["id"];

export function isIgvTreatment(value: unknown): value is IgvTreatment {
  return value === "neto" || value === "con_igv" || value === "inafecto";
}

/** El tratamiento de una fila; sin él (antes de la 0343), de `includes_igv`. */
export function igvTreatmentOf(row: { igv_treatment?: unknown; includes_igv?: unknown }): IgvTreatment {
  if (isIgvTreatment(row.igv_treatment)) return row.igv_treatment;
  return row.includes_igv === true ? "con_igv" : "neto";
}

/** La ayuda del selector de IGV. */
export const IGV_HELP =
  "Las líneas de la factura ya suelen venir sin IGV. Elige «Incluye IGV» solo si cargas el total con IGV, e «Inafecto» para lo que no lleva IGV, como el flete internacional.";

/**
 * Un costo como se cuenta: «S/ 427.25», con «Incluye IGV» «S/ 504.16 con IGV →
 * S/ 427.25 sin IGV» y, si es inafecto, «US$ 120.00 · inafecto a IGV» (el
 * historial, el detalle y el Excel).
 */
export function costAmountText(c: { amount: number; currency: Currency; includes_igv?: boolean; gross_amount?: number | null; igv_treatment?: IgvTreatment | null }): string {
  const net = moneyText(c.amount, c.currency);
  if (c.igv_treatment === "inafecto") return `${net} · inafecto a IGV`;
  if (!c.includes_igv || c.gross_amount == null) return net;
  return `${moneyText(c.gross_amount, c.currency)} con IGV → ${net} sin IGV`;
}

// ---------------------------------------------------------------------------
// Validaciones de lo que llega del formulario
// ---------------------------------------------------------------------------

type Clean<T> = { value: T } | { error: string };

function text(raw: unknown, max: number): string | null {
  const v = String(raw ?? "").replace(/\s+/g, " ").trim();
  return v ? v.slice(0, max) : null;
}

function longText(raw: unknown, max: number): string | null {
  const v = String(raw ?? "").trim();
  return v ? v.slice(0, max) : null;
}

export interface HeaderInput {
  supplierId?: string | null;
  origin?: string | null;
  platformOrder?: string | null;
  /** El código de la proforma invoice (0343, MOM §45.15). */
  proformaNumber?: string | null;
  transport?: string | null;
  carrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  orderedOn?: string | null;
  eta?: string | null;
  arrivedOn?: string | null;
  notes?: string | null;
}

export interface HeaderValue {
  supplier_id: string | null;
  origin: string | null;
  platform_order: string | null;
  proforma_number: string | null;
  transport: Transport;
  carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  ordered_on: string | null;
  eta: string | null;
  arrived_on: string | null;
  notes: string | null;
}

function optionalDate(raw: unknown, label: string): Clean<string | null> {
  const v = String(raw ?? "").trim();
  if (!v) return { value: null };
  return isIsoDate(v) ? { value: v } : { error: `${label}: fecha inválida.` };
}

/**
 * La cabecera de la compra (crear y editar). En una compra local (MOM §45.12)
 * no hay transporte, paquetera ni guía: se guardan «terrestre» y vacíos, sea
 * lo que sea que llegue del navegador.
 */
export function cleanHeader(input: HeaderInput, kind: ImportKind = "importacion"): Clean<HeaderValue> {
  // Una compra local tampoco lleva código de proforma (MOM §45.15).
  if (!hasShipping(kind)) input = { ...input, transport: "land", carrier: null, trackingNumber: null, trackingUrl: null, proformaNumber: null };
  const transport = (input.transport ?? "courier") as Transport;
  if (!TRANSPORTS.some((t) => t.id === transport)) return { error: "Transporte inválido." };
  const supplierId = String(input.supplierId ?? "").trim() || null;
  if (supplierId && !isUuid(supplierId)) return { error: "Proveedor inválido." };
  const trackingUrl = text(input.trackingUrl, 500);
  if (trackingUrl && !/^https?:\/\/\S+$/i.test(trackingUrl)) {
    return { error: "El enlace de seguimiento debe empezar con http:// o https://." };
  }
  const dates: Record<"ordered_on" | "eta" | "arrived_on", string | null> = { ordered_on: null, eta: null, arrived_on: null };
  for (const [key, raw, label] of [
    ["ordered_on", input.orderedOn, "Fecha del pedido"],
    ["eta", input.eta, "Llegada estimada"],
    ["arrived_on", input.arrivedOn, "Llegada"],
  ] as const) {
    const d = optionalDate(raw, label);
    if ("error" in d) return d;
    dates[key] = d.value;
  }
  return {
    value: {
      supplier_id: supplierId,
      origin: text(input.origin, 80),
      platform_order: text(input.platformOrder, 60),
      proforma_number: text(input.proformaNumber, 80),
      transport,
      carrier: text(input.carrier, 60),
      tracking_number: text(input.trackingNumber, 80),
      tracking_url: trackingUrl,
      ...dates,
      notes: longText(input.notes, 2000),
    },
  };
}

/** El tipo de cambio (soles por 1 USD). Vacío = sin tipo de cambio. */
export function cleanFx(raw: unknown): Clean<number | null> {
  if (String(raw ?? "").trim() === "") return { value: null };
  const n = parseDecimal(raw);
  if (n === null || !(n > 0) || n > 100) return { error: "Tipo de cambio inválido (soles por 1 USD)." };
  return { value: Math.round(n * 10_000) / 10_000 };
}

export interface SupplierInput {
  name?: string | null;
  country?: string | null;
  whatsapp?: string | null;
  notes?: string | null;
  /** Desde la 0341 (MOM §45.7). */
  contactName?: string | null;
  email?: string | null;
  paymentTerms?: string | null;
}

export interface SupplierValue {
  name: string;
  country: string | null;
  whatsapp: string | null;
  notes: string | null;
  contact_name: string | null;
  email: string | null;
  payment_terms: string | null;
}

/** La forma del correo, la misma que el CHECK de la 0341. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function cleanSupplier(input: SupplierInput): Clean<SupplierValue> {
  const name = text(input.name, 120);
  if (!name) return { error: "Indica el nombre del proveedor." };
  const rawWa = String(input.whatsapp ?? "").trim();
  let whatsapp: string | null = null;
  if (rawWa) {
    const digits = rawWa.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
    if (!/^\+?\d{6,15}$/.test(digits)) return { error: "WhatsApp inválido: solo números, con el código de país." };
    whatsapp = digits;
  }
  const rawEmail = String(input.email ?? "").trim().toLowerCase();
  if (rawEmail && (rawEmail.length > 160 || !EMAIL_RE.test(rawEmail))) return { error: "Correo inválido." };
  return {
    value: {
      name,
      country: text(input.country, 80),
      whatsapp,
      notes: longText(input.notes, 1000),
      contact_name: text(input.contactName, 120),
      email: rawEmail || null,
      payment_terms: text(input.paymentTerms, 200),
    },
  };
}

export const MAX_QTY = 10_000_000;

export interface ItemInput {
  storeId?: string | null;
  sku?: string | null;
  name?: string | null;
  qty?: unknown;
  /** Unidades de cortesía (gratis, MOM §45.13): vacío = 0. */
  courtesyQty?: unknown;
  unitWeightKg?: unknown;
  /** El costo por unidad de una importación (base USD). */
  unitCostUsd?: unknown;
  /** El costo por unidad de una compra local (base soles, MOM §45.12). */
  unitCostPen?: unknown;
  salePricePen?: unknown;
}

export interface ItemValue {
  store_id: string | null;
  sku: string | null;
  name: string;
  qty: number;
  courtesy_qty: number;
  unit_weight_kg: number | null;
  /**
   * Solo con «Montos de compras»; sin ese permiso, ni se lee ni se escribe. El
   * costo va en la columna de la moneda base de la compra (0343): USD en una
   * importación, soles en una compra local; la otra, nula.
   */
  unit_cost_currency?: Currency;
  unit_cost_usd?: number | null;
  unit_cost_pen?: number | null;
  sale_price_pen?: number | null;
}

/**
 * Las columnas del costo por unidad de un producto NUEVO cuando no se escribe
 * (sin «Montos de compras»): la moneda base de la compra con costo 0, para que
 * el CHECK de la 0343 se cumpla. En USD son los defaults de la base.
 */
export function defaultItemCostColumns(base: Currency): Pick<ItemValue, "unit_cost_currency" | "unit_cost_usd" | "unit_cost_pen"> {
  return base === "PEN" ? { unit_cost_currency: "PEN", unit_cost_usd: null, unit_cost_pen: 0 } : {};
}

/**
 * Un producto. Sin «Montos de compras» (`canMoney` falso) el costo por unidad
 * y el precio de venta NO se leen: no aparecen en el resultado, así que una
 * edición no los toca. `base` es la moneda de la compra (`baseCurrencyOf`): en
 * una compra local el costo por unidad es en soles (`unitCostPen`).
 */
export function cleanItem(input: ItemInput, canMoney: boolean, base: Currency = "USD"): Clean<ItemValue> {
  const name = text(input.name, 200);
  if (!name) return { error: "Indica el nombre del producto." };
  const sku = text(input.sku, 80);
  const storeId = String(input.storeId ?? "").trim() || null;
  if (storeId && !isUuid(storeId)) return { error: "Tienda inválida." };
  const qty = parseInteger(input.qty);
  if (qty === null || qty < 1 || qty > MAX_QTY) return { error: "Cantidad: un entero de 1 a 10.000.000." };
  const rawCourtesy = String(input.courtesyQty ?? "").trim();
  const courtesy = rawCourtesy === "" ? 0 : parseInteger(rawCourtesy);
  if (courtesy === null || courtesy < 0 || courtesy > MAX_QTY) return { error: "Cortesía: un entero de 0 en adelante." };
  let weight: number | null = null;
  if (String(input.unitWeightKg ?? "").trim() !== "") {
    weight = parseDecimal(input.unitWeightKg);
    if (weight === null || weight < 0) return { error: "Peso por unidad inválido." };
  }
  const value: ItemValue = { store_id: storeId, sku, name, qty, courtesy_qty: courtesy, unit_weight_kg: weight };
  if (canMoney) {
    const rawCost = String((base === "PEN" ? input.unitCostPen : input.unitCostUsd) ?? "").trim();
    const cost = rawCost === "" ? 0 : parseDecimal(rawCost);
    if (cost === null || cost < 0) return { error: "Costo por unidad inválido." };
    const rounded = Math.round(cost * 10_000) / 10_000;
    value.unit_cost_currency = base;
    value.unit_cost_usd = base === "PEN" ? null : rounded;
    value.unit_cost_pen = base === "PEN" ? rounded : null;
    const rawPrice = String(input.salePricePen ?? "").trim();
    if (rawPrice === "") value.sale_price_pen = null;
    else {
      const price = parseDecimal(rawPrice);
      if (price === null || price < 0) return { error: "Precio de venta inválido." };
      value.sale_price_pen = round2(price);
    }
  }
  return { value };
}

export interface CostInput {
  kind?: string | null;
  label?: string | null;
  /** El monto escrito, en su moneda (con IGV si se marca «Incluye IGV»). */
  amount?: unknown;
  /** USD o PEN; vacío = USD. */
  currency?: unknown;
  /** El tratamiento del IGV (0343): neto (por defecto), con_igv o inafecto. */
  igvTreatment?: unknown;
  /** Antes de la 0343: «Incluye IGV» marcada = con_igv. Se usa solo sin `igvTreatment`. */
  includesIgv?: unknown;
  allocation?: string | null;
  itemId?: string | null;
}

/**
 * La fila de `import_costs` (0342): el monto que entra al costo (SIN IGV) en
 * la columna de su moneda —`amount_usd` o `amount_pen`, la otra nula— y, con
 * «Incluye IGV», el monto con IGV tal como se escribió en `gross_amount`.
 */
export interface CostValue {
  kind: CostKind;
  label: string;
  currency: Currency;
  amount_usd: number | null;
  amount_pen: number | null;
  includes_igv: boolean;
  gross_amount: number | null;
  /** 0343: `con_igv` ⇔ `includes_igv` (CHECK de la base). */
  igv_treatment: IgvTreatment;
  allocation: Allocation;
  item_id: string | null;
}

/** Una casilla marcada que llega del navegador. */
function checked(raw: unknown): boolean {
  return raw === true || raw === "true" || raw === "on" || raw === "1";
}

/** El monto en su columna: `amount_usd` o `amount_pen`; la otra, nula (el CHECK de la 0342). */
export function amountColumns(amount: number, currency: Currency): { amount_usd: number | null; amount_pen: number | null } {
  return currency === "PEN" ? { amount_usd: null, amount_pen: amount } : { amount_usd: amount, amount_pen: null };
}

/** Un costo. `base`: la moneda si no se elige (vacía): USD en una importación, soles en una compra local. */
export function cleanCost(input: CostInput, itemIds: readonly string[], base: Currency = "USD"): Clean<CostValue> {
  const kind = input.kind as CostKind;
  if (!COST_KINDS.some((k) => k.id === kind)) return { error: "Tipo de costo inválido." };
  const label = text(input.label, 120) ?? costKindLabel(kind);
  const currency = String(input.currency ?? "").trim() === "" ? base : cleanCurrency(input.currency);
  if (!currency) return { error: "Moneda inválida: US$ o S/." };
  const raw = parseDecimal(input.amount);
  if (raw === null || round2(raw) <= 0) return { error: "El monto debe ser mayor que 0." };
  const rawTreatment = String(input.igvTreatment ?? "").trim();
  if (rawTreatment && !isIgvTreatment(rawTreatment)) return { error: "Tratamiento del IGV inválido." };
  const treatment: IgvTreatment = rawTreatment ? (rawTreatment as IgvTreatment) : checked(input.includesIgv) ? "con_igv" : "neto";
  const includesIgv = treatment === "con_igv";
  const gross = round2(raw);
  // Con IGV: al costo entra el monto sin IGV (÷ 1,18), a 2 decimales.
  const net = includesIgv ? netOfIgv(gross) : gross;
  if (!(net > 0)) return { error: "El monto debe ser mayor que 0." };
  const allocation = (input.allocation || "value") as Allocation;
  if (!ALLOCATIONS.some((a) => a.id === allocation)) return { error: "Reparto inválido." };
  let itemId: string | null = null;
  if (allocation === "item") {
    itemId = String(input.itemId ?? "").trim() || null;
    if (!itemId || !itemIds.includes(itemId)) return { error: "Elige el producto de esta importación al que va el costo." };
  }
  return {
    value: {
      kind,
      label,
      currency,
      ...amountColumns(net, currency),
      includes_igv: includesIgv,
      gross_amount: includesIgv ? gross : null,
      igv_treatment: treatment,
      allocation,
      item_id: itemId,
    },
  };
}

export interface PaymentInput {
  /** El monto, en su moneda. */
  amount?: unknown;
  /** USD o PEN; vacío = USD. */
  currency?: unknown;
  paidOn?: string | null;
  method?: string | null;
  note?: string | null;
  documentId?: string | null;
}

/** La fila de `import_payments` (0342): el monto en la columna de su moneda. */
export interface PaymentValue {
  currency: Currency;
  amount_usd: number | null;
  amount_pen: number | null;
  paid_on: string;
  method: PaymentMethod;
  note: string | null;
  document_id: string | null;
}

/**
 * Un pago. `opts.voucherRequired` (una compra local, MOM §45.12): sin
 * comprobante no se guarda. `opts.base`: la moneda si no se elige (vacía).
 */
export function cleanPayment(
  input: PaymentInput,
  paymentDocIds: readonly string[],
  opts: { voucherRequired?: boolean; base?: Currency } = {},
): Clean<PaymentValue> {
  const currency = String(input.currency ?? "").trim() === "" ? (opts.base ?? "USD") : cleanCurrency(input.currency);
  if (!currency) return { error: "Moneda inválida: US$ o S/." };
  const amount = parseDecimal(input.amount);
  if (amount === null || round2(amount) <= 0) return { error: "El monto debe ser mayor que 0." };
  if (!isIsoDate(input.paidOn)) return { error: "Fecha del pago inválida." };
  const method = input.method as PaymentMethod;
  if (!PAYMENT_METHODS.some((m) => m.id === method)) return { error: "Método de pago inválido." };
  const documentId = String(input.documentId ?? "").trim() || null;
  if (documentId && !paymentDocIds.includes(documentId)) return { error: "El comprobante debe ser de esta importación." };
  if (opts.voucherRequired && !documentId) return { error: PAYMENT_VOUCHER_REQUIRED };
  return {
    value: {
      currency,
      ...amountColumns(round2(amount), currency),
      paid_on: input.paidOn as string,
      method,
      note: longText(input.note, 300),
      document_id: documentId,
    },
  };
}

// ---------------------------------------------------------------------------
// Editar un costo o un pago (MOM §45.3, decisión del owner del 14-11-2026:
// «permíteme editar los costos»): el hecho de dinero dice qué cambió
// ---------------------------------------------------------------------------

/** Un costo como se compara: lo guardado o lo que devuelve `cleanCost`. */
export interface CostSnapshot {
  kind: string;
  label: string;
  currency: Currency;
  /** Lo que entra al costo (sin IGV). */
  amount: number;
  includes_igv: boolean;
  gross_amount: number | null;
  igv_treatment: IgvTreatment;
  allocation: string;
  item_id: string | null;
}

/** `CostValue` (la fila a guardar) como `CostSnapshot`. */
export function costSnapshotOf(v: CostValue): CostSnapshot {
  return {
    kind: v.kind,
    label: v.label,
    currency: v.currency,
    amount: (v.currency === "PEN" ? v.amount_pen : v.amount_usd) ?? 0,
    includes_igv: v.includes_igv,
    gross_amount: v.gross_amount,
    igv_treatment: v.igv_treatment,
    allocation: v.allocation,
    item_id: v.item_id,
  };
}

const igvTreatmentLabel = (t: IgvTreatment) => IGV_TREATMENTS.find((x) => x.id === t)!.label;

/**
 * Lo que cambió en un costo, para el historial: «Costo «AFORO FÍSICO»: tipo
 * Envío → Importación». Vacío si no cambió nada (no se guarda ni queda hecho).
 */
export function costChangeNote(before: CostSnapshot, after: CostSnapshot, itemName: (id: string | null) => string = () => "un producto"): string {
  const parts: string[] = [];
  if (before.kind !== after.kind) parts.push(`tipo ${costKindLabel(before.kind)} → ${costKindLabel(after.kind)}`);
  if (before.label !== after.label) parts.push(`nombre «${before.label}» → «${after.label}»`);
  const beforeAmount = costAmountText(before);
  const afterAmount = costAmountText(after);
  const amountChanged = before.currency !== after.currency || round2(before.amount) !== round2(after.amount) || (before.gross_amount ?? null) !== (after.gross_amount ?? null);
  if (amountChanged) parts.push(`monto ${beforeAmount} → ${afterAmount}`);
  else if (before.igv_treatment !== after.igv_treatment) parts.push(`IGV ${igvTreatmentLabel(before.igv_treatment)} → ${igvTreatmentLabel(after.igv_treatment)}`);
  const allocText = (c: CostSnapshot) => (c.allocation === "item" ? `a ${itemName(c.item_id)}` : allocationLabel(c.allocation).toLowerCase());
  if (before.allocation !== after.allocation || (after.allocation === "item" && before.item_id !== after.item_id)) {
    parts.push(`reparto ${allocText(before)} → ${allocText(after)}`);
  }
  return parts.length ? `Costo «${before.label}»: ${parts.join(" · ")}.` : "";
}

/** Un pago como se compara. */
export interface PaymentSnapshot {
  currency: Currency;
  amount: number;
  paid_on: string;
  method: string;
  note: string | null;
  document_id: string | null;
}

export function paymentSnapshotOf(v: PaymentValue): PaymentSnapshot {
  return {
    currency: v.currency,
    amount: (v.currency === "PEN" ? v.amount_pen : v.amount_usd) ?? 0,
    paid_on: v.paid_on,
    method: v.method,
    note: v.note,
    document_id: v.document_id,
  };
}

/** Lo que cambió en un pago: «Pago del 14/11/2026: monto US$ 500.00 → US$ 520.00 · método PayPal → Transferencia». */
export function paymentChangeNote(before: PaymentSnapshot, after: PaymentSnapshot): string {
  const parts: string[] = [];
  if (before.currency !== after.currency || round2(before.amount) !== round2(after.amount)) {
    parts.push(`monto ${moneyText(before.amount, before.currency)} → ${moneyText(after.amount, after.currency)}`);
  }
  if (before.paid_on !== after.paid_on) parts.push(`fecha ${formatDmy(before.paid_on)} → ${formatDmy(after.paid_on)}`);
  if (before.method !== after.method) parts.push(`método ${paymentMethodLabel(before.method)} → ${paymentMethodLabel(after.method)}`);
  if ((before.note ?? null) !== (after.note ?? null)) parts.push(after.note ? `nota «${after.note}»` : "sin nota");
  if ((before.document_id ?? null) !== (after.document_id ?? null)) parts.push(after.document_id ? (before.document_id ? "comprobante cambiado" : "con comprobante") : "sin comprobante");
  return parts.length ? `Pago del ${formatDmy(before.paid_on)}: ${parts.join(" · ")}.` : "";
}

export function cleanStatusChange(
  current: ImportStatus,
  next: unknown,
  rawNote: unknown,
): Clean<{ status: ImportStatus; note: string | null; changed: boolean }> {
  if (!isImportStatus(next)) return { error: "Estado inválido." };
  const note = longText(rawNote, 500);
  if (next === current && !note) return { error: "Ya está en ese estado. Escribe una nota si quieres dejar una novedad." };
  return { value: { status: next, note, changed: next !== current } };
}

// ---------------------------------------------------------------------------
// Costo aterrizado (referencia §6.3)
// ---------------------------------------------------------------------------

export interface LandedItem {
  id: string;
  name?: string;
  /** Lo pedido (lo que se paga). */
  qty: number;
  /** Unidades de cortesía (MOM §45.13): llegan gratis, no suben ningún monto. */
  courtesyQty?: number | null;
  /** El costo por unidad de una importación (USD). */
  unitCostUsd: number;
  /** El costo por unidad en soles de una compra local (0343): con `unitCostCurrency` = PEN. */
  unitCostPen?: number | null;
  /** La moneda del costo por unidad; sin ella, USD (antes de la 0343). */
  unitCostCurrency?: Currency;
  unitWeightKg?: number | null;
  receivedQty?: number | null;
  damagedQty?: number | null;
}

export interface LandedCostRow {
  id?: string;
  kind: CostKind;
  label: string;
  /** Lo que entra al costo (sin IGV), en su moneda. */
  amount: number;
  /** Sin moneda: USD (como antes de la 0342). */
  currency?: Currency;
  allocation: Allocation;
  itemId?: string | null;
}

/** Una línea en UNA moneda: USD (la base) o soles. */
export interface LandedView {
  /** Costo del proveedor (qty × costo por unidad). */
  product: number;
  envio: number;
  importacion: number;
  adicional: number;
  total: number;
  unitCost: number;
  perUnit: { product: number; envio: number; importacion: number; adicional: number };
}

export interface LandedLine {
  itemId: string;
  /** Cada parte en su moneda, sin convertir (el proveedor, siempre en USD). */
  split: { product: Money2; envio: Money2; importacion: Money2; adicional: Money2; total: Money2 };
  /** Unidades buenas: recibidas − dañadas si se contó; si no, las pedidas. */
  good: number;
  /** Sobre cuántas se divide (las buenas; si no hay ninguna, las pedidas). */
  divisor: number;
  /** Ninguna unidad buena: su costo es pérdida. */
  loss: boolean;
  /** En USD: los soles ÷ tipo de cambio. Null si le tocan soles y no hay tipo de cambio. */
  usd: LandedView | null;
  /** En soles: USD × tipo de cambio + los soles tal cual. Null si tiene USD y no hay tipo de cambio. */
  pen: LandedView | null;
}

export interface LandedTotals {
  /** Σ costo del proveedor. */
  productTotal: number;
  /** Σ costos a repartir. */
  costsTotal: number;
  /** productTotal + costsTotal: nada se pierde ni se duplica. */
  total: number;
}

export interface LandedResult {
  lines: LandedLine[];
  byItem: Map<string, LandedLine>;
  warnings: string[];
  /** El tipo de cambio con que se miró (soles por 1 USD), o null. */
  fx: number | null;
  /** Σ por moneda, sin convertir. `unallocated`: costos que no se pudieron repartir (sin productos). */
  split: { product: Money2; costs: Money2; total: Money2; unallocated: Money2 };
  /** Los totales en USD; null si hay costos en soles y no hay tipo de cambio. */
  usd: LandedTotals | null;
  /** Los totales en soles; null si hay USD y no hay tipo de cambio. */
  pen: LandedTotals | null;
  /** Algún costo está en soles. */
  hasPenCosts: boolean;
  /** Algún monto (proveedor o costo) está en USD: la vista en soles necesita el tipo de cambio. */
  hasUsd: boolean;
  goodUnits: number;
}

/** Las unidades que se esperan (MOM §45.13): lo pedido + la cortesía. */
export function expectedUnits(item: { qty: number; courtesyQty?: number | null }): number {
  return item.qty + Math.max(0, item.courtesyQty ?? 0);
}

/**
 * Unidades buenas de una línea (§6.3): recibidas − dañadas si llegó algo (la
 * cortesía va dentro); si no llegó nada todavía, las esperadas (pedidas +
 * cortesía).
 */
export function goodUnits(item: Pick<LandedItem, "qty" | "receivedQty" | "damagedQty" | "courtesyQty">): number {
  if (item.receivedQty == null) return expectedUnits(item);
  return Math.max(0, item.receivedQty - (item.damagedQty ?? 0));
}

/** El costo por unidad de un producto en SU moneda (USD o soles, 0343). */
export function itemUnitCost(it: Pick<LandedItem, "unitCostUsd" | "unitCostPen" | "unitCostCurrency">): { amount: number; currency: Currency } {
  return it.unitCostCurrency === "PEN" ? { amount: Number(it.unitCostPen) || 0, currency: "PEN" } : { amount: Number(it.unitCostUsd) || 0, currency: "USD" };
}

/** Un producto de la base (`import_items`) como entra al cálculo. */
export function landedItemOf(it: {
  id: string;
  name?: string;
  qty: number;
  courtesy_qty?: number | null;
  unit_cost_usd?: number | null;
  unit_cost_pen?: number | null;
  unit_cost_currency?: Currency | null;
  unit_weight_kg?: number | null;
  received_qty?: number | null;
  damaged_qty?: number | null;
}): LandedItem {
  return {
    id: it.id,
    name: it.name,
    qty: it.qty,
    courtesyQty: it.courtesy_qty ?? 0,
    unitCostUsd: it.unit_cost_usd ?? 0,
    unitCostPen: it.unit_cost_pen ?? null,
    unitCostCurrency: it.unit_cost_currency === "PEN" ? "PEN" : "USD",
    unitWeightKg: it.unit_weight_kg ?? null,
    receivedQty: it.received_qty ?? null,
    damagedQty: it.damaged_qty ?? null,
  };
}

/** Un costo leído de la base (ya normalizado: monto en su moneda) como entra al cálculo. */
export function landedCostOf(c: { id: string; kind: string; label: string; amount: number; currency: Currency; allocation: string; item_id: string | null }): LandedCostRow {
  return { id: c.id, kind: c.kind as CostKind, label: c.label, amount: c.amount, currency: c.currency, allocation: c.allocation as Allocation, itemId: c.item_id };
}

function viewOf(
  split: LandedLine["split"],
  divisor: number,
  convert: (m: Money2) => number | null,
): LandedView | null {
  const product = convert(split.product);
  const envio = convert(split.envio);
  const importacion = convert(split.importacion);
  const adicional = convert(split.adicional);
  const total = convert(split.total);
  if (product === null || envio === null || importacion === null || adicional === null || total === null) return null;
  return {
    product,
    envio,
    importacion,
    adicional,
    total,
    unitCost: total / divisor,
    perUnit: { product: product / divisor, envio: envio / divisor, importacion: importacion / divisor, adicional: adicional / divisor },
  };
}

function totalsOf(split: LandedResult["split"], convert: (m: Money2) => number | null): LandedTotals | null {
  const productTotal = convert(split.product);
  const costsTotal = convert(split.costs);
  const total = convert(split.total);
  return productTotal === null || costsTotal === null || total === null ? null : { productTotal, costsTotal, total };
}

/**
 * Costo final por unidad de cada línea, exactamente como §6.3 de la
 * referencia: los costos se reparten sobre lo PEDIDO (se pagó y se envió
 * todo) y el costo por unidad se divide entre las unidades BUENAS (lo que
 * faltó o llegó dañado lo pagan las que se pueden vender). Sin redondeo.
 *
 * Cada costo se reparte en SU moneda (0342) con la misma regla: «por valor» usa
 * el valor del proveedor (en la moneda base de la compra: USD en una
 * importación, soles en una compra local, 0343) sea cual sea la moneda del
 * costo. La cortesía (MOM §45.13) no entra en el reparto (no se pagó) pero sí
 * en las unidades buenas, así que baja el costo por unidad. Las dos vistas
 * salen del tipo de cambio de la importación (`fx`, soles por 1 USD): en soles,
 * el proveedor y los costos en USD × fx más los costos en soles tal cual; en
 * USD, los costos en soles ÷ fx. Sin `fx`, la vista que lo necesita es null.
 */
export function landedCosts(items: readonly LandedItem[], costs: readonly LandedCostRow[], fxPenPerUsd?: number | null): LandedResult {
  const fx = validFx(fxPenPerUsd);
  const warnings: string[] = [];
  // «Por valor»: el valor del proveedor en su moneda. Todos los productos de
  // una compra van en su moneda base (0343); si se mezclaran, se comparan en
  // USD con el tipo de cambio y, sin él, el reparto va por unidades con aviso.
  const unitCosts = items.map(itemUnitCost);
  const mixedProducts = new Set(unitCosts.map((u) => u.currency)).size > 1;
  const productValue = (i: number): number | null => {
    const u = unitCosts[i]!;
    const v = items[i]!.qty * u.amount;
    if (!mixedProducts) return v;
    return u.currency === "PEN" ? (fx ? v / fx : null) : v;
  };
  const parts = new Map<string, Record<CostKind, Money2>>();
  for (const it of items) parts.set(it.id, { envio: zeroMoney(), importacion: zeroMoney(), adicional: zeroMoney() });
  let unallocated = zeroMoney();
  let costsSplit = zeroMoney();
  let hasPenCosts = false;

  for (const cost of costs) {
    const amount = Number(cost.amount) || 0;
    if (!(amount > 0)) continue;
    const cur: Currency = cost.currency === "PEN" ? "PEN" : "USD";
    if (cur === "PEN") hasPenCosts = true;
    costsSplit = addMoney(costsSplit, moneyOf(amount, cur));
    if (!items.length) {
      unallocated = addMoney(unallocated, moneyOf(amount, cur));
      warnings.push(`«${cost.label}» no se puede repartir: la importación no tiene productos.`);
      continue;
    }
    let allocation = cost.allocation;
    if (allocation === "item" && !items.some((it) => it.id === cost.itemId)) {
      // Su producto se quitó (item_id nulo): el costo se queda y va por valor.
      allocation = "value";
      warnings.push(`«${cost.label}» estaba asignado a un producto que ya no está: se reparte por valor.`);
    }
    let base = items.map((it, i) => {
      if (allocation === "value") return productValue(i) ?? 0;
      if (allocation === "units") return it.qty;
      if (allocation === "weight") return it.qty * (it.unitWeightKg ?? 0);
      return it.id === cost.itemId ? 1 : 0;
    });
    if (allocation === "value" && mixedProducts && !fx) {
      base = items.map((it) => it.qty);
      warnings.push(`Productos en dólares y en soles sin tipo de cambio: «${cost.label}» se reparte por unidades.`);
    } else if (!base.some((b) => b > 0)) {
      base = items.map((it) => it.qty);
      warnings.push(
        allocation === "weight"
          ? `Faltan pesos: «${cost.label}» se reparte por unidades.`
          : `Sin costos por unidad cargados: «${cost.label}» se reparte por unidades.`,
      );
    }
    const sum = base.reduce((a, b) => a + b, 0);
    items.forEach((it, i) => {
      const p = parts.get(it.id)!;
      p[cost.kind] = addMoney(p[cost.kind], moneyOf((amount * base[i]!) / sum, cur));
    });
  }

  const toUsd = (m: Money2) => moneyInUsd(m, fx);
  const toPen = (m: Money2) => moneyInPen(m, fx);
  const lines: LandedLine[] = items.map((it, i) => {
    const p = parts.get(it.id)!;
    // El proveedor en la moneda del producto: USD (importación) o soles (compra local).
    const product = moneyOf(it.qty * unitCosts[i]!.amount, unitCosts[i]!.currency);
    const total = addMoney(addMoney(addMoney(product, p.envio), p.importacion), p.adicional);
    const good = goodUnits(it);
    const divisor = good > 0 ? good : it.qty > 0 ? it.qty : 1;
    if (good === 0 && it.receivedQty != null) {
      warnings.push(`${it.name ? `«${it.name}»` : "Un producto"} no tiene unidades buenas: su costo es pérdida (se muestra sobre lo pedido).`);
    }
    const split = { product, envio: p.envio, importacion: p.importacion, adicional: p.adicional, total };
    return {
      itemId: it.id,
      split,
      good,
      divisor,
      loss: good === 0,
      usd: viewOf(split, divisor, toUsd),
      pen: viewOf(split, divisor, toPen),
    };
  });

  const productSplit = lines.reduce((a, l) => addMoney(a, l.split.product), zeroMoney());
  const split = { product: productSplit, costs: costsSplit, total: addMoney(productSplit, costsSplit), unallocated };
  return {
    lines,
    byItem: new Map(lines.map((l) => [l.itemId, l])),
    warnings: [...new Set(warnings)],
    fx,
    split,
    usd: totalsOf(split, toUsd),
    pen: totalsOf(split, toPen),
    hasPenCosts,
    hasUsd: split.total.usd !== 0,
    goodUnits: lines.reduce((a, l) => a + l.good, 0),
  };
}

// ---------------------------------------------------------------------------
// Margen (en soles) y pagos
// ---------------------------------------------------------------------------

/** Margen bajo: menos del 20 % del precio de venta. */
export const LOW_MARGIN = 0.2;

export interface Margin {
  unitCostPen: number;
  /** Precio de venta − costo por unidad, en soles. */
  unit: number;
  /** Margen ÷ precio. */
  pct: number;
  /** Margen por unidad × unidades buenas. */
  total: number;
  low: boolean;
}

/**
 * El margen de una línea con su costo aterrizado por unidad EN SOLES (la vista
 * `pen` de `landedCosts`: los costos en soles entran tal cual). Null sin ese
 * costo (falta el tipo de cambio) o sin precio de venta > 0.
 */
export function marginOf(unitCostPen: number | null | undefined, salePricePen: number | null | undefined, good: number): Margin | null {
  if (unitCostPen == null || !Number.isFinite(unitCostPen) || !(salePricePen && salePricePen > 0)) return null;
  const unit = salePricePen - unitCostPen;
  const pct = unit / salePricePen;
  return { unitCostPen, unit, pct, total: unit * good, low: pct < LOW_MARGIN };
}

/** Pagado de más por menos de medio centavo no cuenta. */
export const HALF_CENT = 0.005;

/** Un pago como entra a las cuentas: su monto en su moneda. */
export interface PaymentAmount {
  amount: number;
  /** Sin moneda: USD (como antes de la 0342). */
  currency?: Currency;
}

/** Σ pagos por moneda, sin convertir. */
export function paidSplit(payments: readonly PaymentAmount[]): Money2 {
  return payments.reduce((a, p) => addMoney(a, moneyOf(Number(p.amount) || 0, p.currency === "PEN" ? "PEN" : "USD")), zeroMoney());
}

export interface Balance {
  /** En USD, la base. Null si hay soles y falta el tipo de cambio. */
  totalUsd: number | null;
  paidUsd: number | null;
  /** Lo que falta pagar (0 si se pagó todo; menos de medio centavo no cuenta). */
  pendingUsd: number | null;
  /** En soles. Null si hay USD y falta el tipo de cambio. */
  totalPen: number | null;
  paidPen: number | null;
  pendingPen: number | null;
  /** Monedas mezcladas y sin tipo de cambio: no se puede decir cuánto falta. */
  needsFx: boolean;
}

/**
 * «Pagado / Falta pagar» sin mezclar monedas (MOM §45.3): se compara en la base
 * (USD) convirtiendo con el tipo de cambio de la importación. Sin él, solo si
 * todo está en una sola moneda (todo USD, o todo soles); si se mezclan, el saldo
 * es null (`needsFx`) y se muestra cada moneda por separado.
 */
export function paymentBalance(total: Money2, paid: Money2, fx: number | null | undefined): Balance {
  const positive = (d: number) => (d > HALF_CENT ? d : 0);
  const totalUsd = moneyInUsd(total, fx);
  const paidUsd = moneyInUsd(paid, fx);
  const totalPen = moneyInPen(total, fx);
  const paidPen = moneyInPen(paid, fx);
  const pendingUsd = totalUsd !== null && paidUsd !== null ? positive(totalUsd - paidUsd) : null;
  // La base decide: si en USD no falta nada, en soles tampoco (sin diferencias de redondeo).
  const pendingPen = totalPen !== null && paidPen !== null ? (pendingUsd === 0 ? 0 : positive(totalPen - paidPen)) : null;
  return { totalUsd, paidUsd, pendingUsd, totalPen, paidPen, pendingPen, needsFx: pendingUsd === null && pendingPen === null };
}

export interface MoneySummary extends Balance {
  /** Costo total sin convertir: lo que está en USD y lo que está en soles. */
  total: Money2;
  /** Pagado sin convertir, por moneda. */
  paid: Money2;
  /** Costo promedio por unidad buena. Null sin unidades buenas o sin la vista. */
  avgUnitUsd: number | null;
  avgUnitPen: number | null;
  /** Ganancia esperada en soles: solo si TODAS las líneas tienen precio y costo en soles (hace falta el tipo de cambio). */
  expectedProfitPen: number | null;
  /** Parte de las unidades que hay que vender para recuperar lo invertido (0–∞). */
  recoveryShare: number | null;
}

/** El dinero de la importación, con el tipo de cambio con que se calculó `landed`. */
export function moneySummary(
  landed: LandedResult,
  items: readonly { id: string; salePricePen?: number | null }[],
  payments: readonly PaymentAmount[],
): MoneySummary {
  const paid = paidSplit(payments);
  const balance = paymentBalance(landed.split.total, paid, landed.fx);
  const good = landed.goodUnits;
  let expectedProfitPen: number | null = null;
  let recoveryShare: number | null = null;
  const lines = items.map((it) => landed.byItem.get(it.id));
  if (items.length && items.every((it) => (it.salePricePen ?? 0) > 0) && lines.every((l) => !l || l.pen) && balance.totalPen !== null) {
    let profit = 0;
    let revenue = 0;
    items.forEach((it, i) => {
      const line = lines[i];
      if (!line?.pen) return;
      const m = marginOf(line.pen.unitCost, it.salePricePen, line.good);
      profit += m?.total ?? 0;
      revenue += (it.salePricePen ?? 0) * line.good;
    });
    expectedProfitPen = profit;
    recoveryShare = revenue > 0 ? balance.totalPen / revenue : null;
  }
  return {
    ...balance,
    total: landed.split.total,
    paid,
    avgUnitUsd: good > 0 && balance.totalUsd !== null ? balance.totalUsd / good : null,
    avgUnitPen: good > 0 && balance.totalPen !== null ? balance.totalPen / good : null,
    expectedProfitPen,
    recoveryShare,
  };
}

// ---------------------------------------------------------------------------
// Recepción (referencia §6.6) y entregas parciales (MOM §45.14, 0343)
// ---------------------------------------------------------------------------

export interface ReceptionItem {
  id: string;
  name?: string;
  qty: number;
  /** Cortesía (MOM §45.13): se espera, no se paga. */
  courtesyQty?: number | null;
  /** Σ de sus entregas; null si todavía no llegó ninguna. */
  receivedQty: number | null;
  damagedQty: number | null;
}

export interface ReceptionSummary {
  /** Σ pedidas (lo que se paga). */
  ordered: number;
  /** Σ cortesía. */
  courtesy: number;
  /** Σ esperadas = pedidas + cortesía. */
  expected: number;
  received: number;
  damaged: number;
  /** Σ max(0, esperadas − recibidas) de las líneas que ya recibieron algo. */
  missing: number;
  /** Σ max(0, recibidas − esperadas). */
  extra: number;
  good: number;
  /** Líneas con alguna entrega. */
  counted: number;
  /** Líneas sin ninguna entrega todavía. */
  uncounted: number;
  /** Todas las líneas con alguna entrega. */
  complete: boolean;
  /** Todas las líneas recibieron lo esperado (o más). */
  allArrived: boolean;
  /** Líneas con faltantes, sobrantes o dañadas. */
  withDifferences: string[];
}

export function receptionSummary(items: readonly ReceptionItem[]): ReceptionSummary {
  const s: ReceptionSummary = {
    ordered: 0,
    courtesy: 0,
    expected: 0,
    received: 0,
    damaged: 0,
    missing: 0,
    extra: 0,
    good: 0,
    counted: 0,
    uncounted: 0,
    complete: items.length > 0,
    allArrived: items.length > 0,
    withDifferences: [],
  };
  for (const it of items) {
    const expected = expectedUnits(it);
    s.ordered += it.qty;
    s.courtesy += Math.max(0, it.courtesyQty ?? 0);
    s.expected += expected;
    s.good += goodUnits(it);
    if (it.receivedQty == null) {
      s.uncounted += 1;
      s.complete = false;
      s.allArrived = false;
      continue;
    }
    const damaged = it.damagedQty ?? 0;
    s.counted += 1;
    s.received += it.receivedQty;
    s.damaged += damaged;
    s.missing += Math.max(0, expected - it.receivedQty);
    s.extra += Math.max(0, it.receivedQty - expected);
    if (it.receivedQty < expected) s.allArrived = false;
    if (it.receivedQty !== expected || damaged > 0) s.withDifferences.push(it.id);
  }
  return s;
}

/** La línea del historial: «Recepción: X de Y u. (+C de cortesía) · faltan … · sobran … · N dañadas · N sin contar». */
export function receptionEventNote(s: ReceptionSummary): string {
  const parts = [`Recepción: ${s.received} de ${s.ordered} u.${s.courtesy ? ` (+${s.courtesy} de cortesía)` : ""}`];
  if (s.missing) parts.push(`faltan ${s.missing}`);
  if (s.extra) parts.push(`sobran ${s.extra}`);
  if (s.damaged) parts.push(`${s.damaged} dañada${s.damaged === 1 ? "" : "s"}`);
  if (s.uncounted) parts.push(`${s.uncounted} sin contar`);
  return parts.join(" · ");
}

/** El avance de un producto (MOM §45.14): lo esperado, lo que llegó y lo que falta. */
export interface LineProgress {
  ordered: number;
  courtesy: number;
  expected: number;
  received: number;
  damaged: number;
  good: number;
  /** esperadas − recibidas (0 si llegó todo o más). */
  missing: number;
  extra: number;
}

export function lineProgress(it: Pick<ReceptionItem, "qty" | "courtesyQty" | "receivedQty" | "damagedQty">): LineProgress {
  const expected = expectedUnits(it);
  const received = it.receivedQty ?? 0;
  const damaged = it.damagedQty ?? 0;
  return {
    ordered: it.qty,
    courtesy: Math.max(0, it.courtesyQty ?? 0),
    expected,
    received,
    damaged,
    good: Math.max(0, received - damaged),
    missing: Math.max(0, expected - received),
    extra: Math.max(0, received - expected),
  };
}

/** «Llegaron 400 de 600 (+50 cortesía) · faltan 250». */
export function lineProgressText(p: LineProgress): string {
  const fmt = (n: number) => n.toLocaleString("es-PE");
  const head = `Llegaron ${fmt(p.received)} de ${fmt(p.ordered)}${p.courtesy ? ` (+${fmt(p.courtesy)} cortesía)` : ""}`;
  if (p.missing) return `${head} · faltan ${fmt(p.missing)}`;
  if (p.extra) return `${head} · sobran ${fmt(p.extra)}`;
  return `${head} · completo`;
}

export interface DeliveryLineInput {
  itemId: string;
  received?: unknown;
  damaged?: unknown;
  note?: unknown;
}

export interface DeliveryInput {
  /** `AAAA-MM-DD` de Lima; no puede ser después de hoy. */
  deliveredOn?: unknown;
  note?: unknown;
  lines?: readonly DeliveryLineInput[];
}

export interface DeliveryLineValue {
  itemId: string;
  received: number;
  damaged: number;
  note: string | null;
}

export interface DeliveryValue {
  delivered_on: string;
  note: string | null;
  lines: DeliveryLineValue[];
}

/**
 * Una entrega (MOM §45.14): la fecha (de Lima, hoy o antes), una nota y, por
 * producto que LLEGÓ, recibidas (entero ≥ 1), dañadas (0 a recibidas) y nota.
 * Un producto vacío o en 0 no vino en esta entrega y no se guarda. No hay
 * dañadas sin recibidas; al menos un producto. Las fotos se comprueban aparte
 * (`deliveryNeedsPhoto`).
 */
export function cleanDelivery(input: DeliveryInput, itemIds: readonly string[], today: string): Clean<DeliveryValue> {
  const date = String(input.deliveredOn ?? "").trim();
  if (!isIsoDate(date)) return { error: "Fecha de la entrega inválida." };
  if (date > today) return { error: "La fecha de la entrega no puede ser después de hoy." };
  const out: DeliveryLineValue[] = [];
  const seen = new Set<string>();
  for (const line of input.lines ?? []) {
    if (!itemIds.includes(line.itemId) || seen.has(line.itemId)) return { error: "Un producto no es de esta compra." };
    seen.add(line.itemId);
    const rawR = String(line.received ?? "").trim();
    const rawD = String(line.damaged ?? "").trim();
    const received = rawR === "" ? 0 : parseInteger(rawR);
    const damaged = rawD === "" ? 0 : parseInteger(rawD);
    if (received === null || received < 0 || received > MAX_QTY) return { error: "Llegaron: un entero de 0 en adelante." };
    if (damaged === null || damaged < 0 || damaged > MAX_QTY) return { error: "Dañadas: un entero de 0 en adelante." };
    if (received === 0 && damaged > 0) return { error: "No se pueden anotar dañadas sin anotar las que llegaron." };
    if (damaged > received) return { error: "Las dañadas no pueden ser más que las que llegaron." };
    if (received === 0) continue;
    out.push({ itemId: line.itemId, received, damaged, note: longText(line.note, 300) });
  }
  if (!out.length) return { error: "Anota lo que llegó de al menos un producto." };
  return { value: { delivered_on: date, note: longText(input.note, 500), lines: out } };
}

/**
 * Los totales de cada producto: la suma de sus entregas (MOM §45.14). Es la
 * misma cuenta que hace en la base el trigger de la 0343
 * (`import_delivery_lines_sync`); un producto sin entregas no aparece (sus
 * totales quedan nulos: «sin contar»).
 */
export function deliveryTotals(lines: readonly { itemId: string; received: number; damaged: number }[]): Map<string, { received: number; damaged: number }> {
  const out = new Map<string, { received: number; damaged: number }>();
  for (const l of lines) {
    const cur = out.get(l.itemId) ?? { received: 0, damaged: 0 };
    cur.received += Number(l.received) || 0;
    cur.damaged += Number(l.damaged) || 0;
    out.set(l.itemId, cur);
  }
  return out;
}

/**
 * El estado después de registrar (o corregir) una entrega (MOM §45.14). Solo
 * AVANZA: si todos los productos recibieron lo esperado (pedidas + cortesía) o
 * más → «Recibido», con la llegada = el día de la última entrega; si no, y la
 * compra estaba antes de «Recibido parcial» → «Recibido parcial». Ya Recibida
 * (o después) o cancelada, no cambia. Null = sin cambio.
 */
export function statusAfterDelivery(input: {
  status: ImportStatus;
  items: readonly Pick<ReceptionItem, "qty" | "courtesyQty" | "receivedQty">[];
  lastDeliveredOn: string | null;
}): { status: ImportStatus; arrivedOn: string | null } | null {
  if (!isBeforeReceived(input.status)) return null;
  const anyArrived = input.items.some((it) => (it.receivedQty ?? 0) > 0);
  if (!anyArrived) return null;
  const allArrived = input.items.length > 0 && input.items.every((it) => (it.receivedQty ?? 0) >= expectedUnits(it));
  if (allArrived) return { status: "recibido", arrivedOn: input.lastDeliveredOn };
  if (isBeforePartial(input.status)) return { status: "recibido_parcial", arrivedOn: null };
  return null;
}

/** «Entrega del 14/11/2026: 400 × Crema (2 dañadas) · 50 × Gel · 2 fotos». */
export function deliveryEventNote(
  verb: "Entrega registrada" | "Entrega corregida" | "Entrega quitada",
  d: { delivered_on: string; lines: readonly { name: string; received: number; damaged: number }[]; photos?: number },
): string {
  const lines = d.lines.map((l) => `${l.received} × ${l.name}${l.damaged ? ` (${l.damaged} dañada${l.damaged === 1 ? "" : "s"})` : ""}`);
  const photos = d.photos ? ` · ${d.photos} foto${d.photos === 1 ? "" : "s"}` : "";
  return `${verb} del ${formatDmy(d.delivered_on)}: ${lines.join(" · ")}${photos}.`;
}

// ---------------------------------------------------------------------------
// Códigos de trazabilidad de una importación (MOM §45.15, decisión del owner
// del 14-11-2026: «deberían ser completados para poder hacer toda la
// trazabilidad de los costos»)
// ---------------------------------------------------------------------------

/**
 * Los tres códigos de una IMPORTACIÓN, en el orden en que aparecen en el
 * pedido: la proforma invoice, la orden de Alibaba (`platform_order`) y la guía
 * de envío (`tracking_number`, el AWB de DHL). Una compra local no los usa.
 */
export const TRACE_CODES = [
  { id: "proforma", label: "Código de la proforma invoice", short: "proforma", phrase: "el código de la proforma invoice" },
  { id: "alibaba", label: "Orden de Alibaba", short: "orden de Alibaba", phrase: "la orden de Alibaba" },
  { id: "guide", label: "Guía de envío", short: "guía de envío", phrase: "la guía de envío" },
] as const;
export type TraceCodeId = (typeof TRACE_CODES)[number]["id"];

export interface TraceCodes {
  /** Solo una importación los lleva. */
  applies: boolean;
  filled: number;
  total: number;
  has: Record<TraceCodeId, boolean>;
  missing: TraceCodeId[];
}

const filledText = (v: string | null | undefined) => Boolean((v ?? "").trim());

export function traceCodes(imp: {
  kind?: ImportKind | null;
  proforma_number?: string | null;
  platform_order?: string | null;
  tracking_number?: string | null;
}): TraceCodes {
  const has: Record<TraceCodeId, boolean> = {
    proforma: filledText(imp.proforma_number),
    alibaba: filledText(imp.platform_order),
    guide: filledText(imp.tracking_number),
  };
  const applies = hasShipping(imp.kind);
  const missing = applies ? TRACE_CODES.filter((c) => !has[c.id]).map((c) => c.id) : [];
  return { applies, filled: applies ? 3 - missing.length : 0, total: applies ? 3 : 0, has, missing };
}

export const traceCodeLabel = (id: TraceCodeId) => TRACE_CODES.find((c) => c.id === id)!.label;

/** «el código de la proforma invoice y la orden de Alibaba». */
function joinLabels(ids: readonly TraceCodeId[]): string {
  const names = ids.map((id) => TRACE_CODES.find((c) => c.id === id)!.phrase);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
}

/**
 * Qué códigos pide un estado (se exigen de forma progresiva): desde «Pagado»,
 * la proforma y la orden de Alibaba; desde «En tránsito» (en aduana, en camino,
 * recibido parcial, recibido, ingresado, cerrado), además la guía de envío.
 * Cancelar nunca los pide.
 */
export function traceCodesRequiredFor(status: ImportStatus): TraceCodeId[] {
  if (status === "cancelado") return [];
  const i = STATUS_ORDER.indexOf(status);
  const out: TraceCodeId[] = [];
  if (i >= STATUS_ORDER.indexOf("pagado")) out.push("proforma", "alibaba");
  if (i >= STATUS_ORDER.indexOf("en_transito")) out.push("guide");
  return out;
}

/**
 * Lo que impide pasar una IMPORTACIÓN a `next` a mano (`setImportStatus`):
 * los códigos que ese estado pide y faltan. Null = se puede. Una compra local
 * nunca se bloquea; una entrega que mueve el estado sola tampoco (la
 * mercadería llegó: se registra y se avisa de lo que falta).
 */
export function statusTraceBlocker(
  imp: Parameters<typeof traceCodes>[0],
  next: ImportStatus,
): { missing: TraceCodeId[]; message: string } | null {
  const codes = traceCodes(imp);
  if (!codes.applies) return null;
  const missing = traceCodesRequiredFor(next).filter((id) => !codes.has[id]);
  if (!missing.length) return null;
  return {
    missing,
    message: `Para pasar a «${IMPORT_STATUS_LABEL[next]}» falta${missing.length === 1 ? "" : "n"} ${joinLabels(missing)} (códigos de trazabilidad).`,
  };
}

/** El aviso de lo que falta (detalle, lista y «Pasar a Costos»). */
export function traceMissingText(missing: readonly TraceCodeId[]): string {
  return missing.length ? `Falta${missing.length === 1 ? "" : "n"} ${joinLabels(missing)}.` : "";
}

/** Para comparar un código con los de otras importaciones: sin espacios al borde ni mayúsculas. */
export function traceCodeKey(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Alertas (fechas de Lima) y checklist
// ---------------------------------------------------------------------------

export interface AlertInput {
  status: ImportStatus;
  /** Sin tipo: importación. Una compra local no avisa a la bodega ni «sin novedades» (MOM §45.12). */
  kind?: ImportKind;
  eta: string | null;
  reportedAt: string | null;
  /** La última novedad (cambio de estado o nota); sin novedades, la creación. */
  lastMovementAt: string | null;
}

export interface ImportAlerts {
  /** Activa, no cotización, con llegada estimada vencida. */
  late: boolean;
  /** Sin avisar a la bodega, activa, no cotización y faltan 3 días o menos (o ya pasó). */
  notifyWarehouse: boolean;
  /** Viajando y 7 días o más sin novedades. */
  stale: boolean;
  /** Días desde la última novedad (calendario de Lima). */
  daysSinceMovement: number | null;
  /** Días hasta la llegada estimada (negativo: vencida). */
  daysToEta: number | null;
}

/**
 * Las alertas de la lista y del detalle. Una compra LOCAL (MOM §45.12) no tiene
 * transporte ni guía: no pide «Avisar a la bodega» ni sale «Sin novedades» (que
 * mira el viaje); «Atrasada» sí (el laboratorio no entregó a tiempo). Una
 * «Recibido parcial» ya está en la bodega: tampoco pide avisarla.
 */
export function importAlerts(input: AlertInput, today: string): ImportAlerts {
  const active = isActiveStatus(input.status);
  const bought = active && input.status !== "cotizacion";
  const shipping = hasShipping(input.kind);
  const daysToEta = input.eta && isIsoDate(input.eta) ? daysBetween(today, input.eta) : null;
  const daysSinceMovement = input.lastMovementAt ? daysBetween(limaDateOf(input.lastMovementAt), today) : null;
  return {
    late: bought && daysToEta !== null && daysToEta < 0,
    notifyWarehouse:
      shipping && bought && input.status !== "recibido_parcial" && !input.reportedAt && daysToEta !== null && daysToEta <= NOTIFY_WAREHOUSE_DAYS,
    stale: shipping && TRAVELING_STATUSES.includes(input.status) && daysSinceMovement !== null && daysSinceMovement >= STALE_DAYS,
    daysSinceMovement,
    daysToEta,
  };
}

/**
 * El checklist mínimo: factura comercial y tracking (número de guía o documento
 * de guía). Una compra local no tiene guía: `tracking` es null (no aplica).
 */
export function importChecklist(
  docKinds: readonly string[],
  trackingNumber: string | null | undefined,
  kind?: ImportKind,
): { invoice: boolean; tracking: boolean | null } {
  return {
    invoice: docKinds.includes("invoice"),
    tracking: hasShipping(kind) ? Boolean((trackingNumber ?? "").trim()) || docKinds.includes("tracking") : null,
  };
}

// ---------------------------------------------------------------------------
// Seguimiento y aviso a la bodega
// ---------------------------------------------------------------------------

const CARRIER_PAGES: Record<string, (n: string) => string> = {
  dhl: (n) => `https://www.dhl.com/pe-es/home/tracking/tracking-express.html?submit=1&tracking-id=${n}`,
  fedex: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
  ups: (n) => `https://www.ups.com/track?loc=es_PE&tracknum=${n}`,
  usps: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
  aramex: (n) => `https://www.aramex.com/track/results?ShipmentNumber=${n}`,
};

/**
 * El enlace público de seguimiento: el escrito a mano (http/https) si hay; si
 * no, con número de guía, la página de la paquetera (DHL, FedEx, UPS, USPS,
 * Aramex: nombre exacto sin mayúsculas); cualquier otra, 17TRACK.
 */
export function trackingPublicUrl(input: { carrier?: string | null; trackingNumber?: string | null; trackingUrl?: string | null }): string | null {
  const manual = (input.trackingUrl ?? "").trim();
  if (/^https?:\/\/\S+$/i.test(manual)) return manual;
  const number = (input.trackingNumber ?? "").trim();
  if (!number) return null;
  const n = encodeURIComponent(number);
  const page = CARRIER_PAGES[(input.carrier ?? "").trim().toLowerCase()];
  return page ? page(n) : `https://t.17track.net/es#nums=${n}`;
}

export interface WarehouseMessageInput {
  code: string;
  supplierName: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  trackingLink: string | null;
  eta: string | null;
  items: readonly { qty: number; name: string; sku?: string | null }[];
}

/** El mensaje de WhatsApp para la bodega de Kapta en Lima. */
export function warehouseMessage(input: WarehouseMessageInput): string {
  const units = input.items.reduce((a, it) => a + it.qty, 0);
  const lines = [
    "Hola, les aviso que viene una importación a la bodega de Kapta en Lima.",
    "",
    `*${input.code}*${input.supplierName ? ` · Proveedor: *${input.supplierName}*` : ""}`,
  ];
  const guide = [input.carrier, input.trackingNumber].filter(Boolean).join(" ");
  lines.push(`Guía: ${guide || "por confirmar"}`);
  if (input.trackingLink) lines.push(`Seguimiento: ${input.trackingLink}`);
  lines.push(`Llegada estimada: ${input.eta ? formatDmy(input.eta) : "por confirmar"}`);
  lines.push("", "Productos:");
  for (const it of input.items) lines.push(`• ${it.qty} × ${it.name}${it.sku ? ` (SKU ${it.sku})` : ""}`);
  lines.push(`Total: ${units} u.`, "", "Al recibirla, por favor confirmen cuántas llegaron y si alguna vino dañada. Gracias.");
  return lines.join("\n");
}

export function whatsappShareUrl(message: string, phone?: string | null): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

// ---------------------------------------------------------------------------
// «Pasar a Costos»
// ---------------------------------------------------------------------------

/** Desde qué estado se puede pasar el costo aterrizado a Costos. */
export const PUSHABLE_STATUSES: readonly ImportStatus[] = ["recibido", "ingresado", "cerrado"];

export interface CostPushItem {
  id: string;
  name: string;
  sku: string | null;
  storeId: string | null;
  receivedQty: number | null;
  costPushedAt: string | null;
}

export type CostPushLine =
  | { itemId: string; name: string; sku: string; storeId: string | null; state: "push"; unitCostPen: number }
  | { itemId: string; name: string; sku: string; storeId: string | null; state: "already"; pushedAt: string }
  | { itemId: string; name: string; sku: string; storeId: string | null; state: "skip"; reason: string };

export interface CostPushPlan {
  /** Se puede pulsar «Pasar a Costos» (hay algo que pasar y nada lo impide). */
  ready: boolean;
  /** Lo que impide pasar la importación entera. */
  blockers: string[];
  lines: CostPushLine[];
  /** Todas las líneas con SKU ya pasaron. */
  alreadyDone: boolean;
}

/**
 * Qué pasaría a Costos (MOM §45): una línea por producto CON SKU, con su costo
 * aterrizado por unidad en soles redondeado a 2 decimales. Hace falta que la
 * importación esté Recibida (o después, nunca cancelada), que todas las líneas
 * con SKU estén contadas y, si algún monto está en USD, que haya tipo de cambio
 * (una compra local toda en soles no lo pide). Una línea ya pasada no se
 * vuelve a pasar; una sin unidades buenas no se pasa (no entró nada que
 * costear); dos líneas con el mismo SKU en la misma tienda bloquean (la
 * segunda cerraría el periodo de la primera el mismo día).
 */
export function costPushPlan(input: {
  status: ImportStatus;
  fxPenPerUsd: number | null | undefined;
  items: readonly CostPushItem[];
  landed: LandedResult;
  /** Los códigos de trazabilidad (MOM §45.15): una importación los pide los tres. */
  trace?: TraceCodes | null;
}): CostPushPlan {
  const blockers: string[] = [];
  if (!PUSHABLE_STATUSES.includes(input.status)) blockers.push("La importación tiene que estar Recibida (o después).");
  if (input.trace?.applies && input.trace.missing.length) {
    blockers.push(`Faltan códigos de trazabilidad: ${traceMissingText(input.trace.missing).replace(/^Faltan? /, "")}`);
  }
  const fx = validFx(input.fxPenPerUsd);
  // Costos va en soles: el tipo de cambio hace falta solo si algún monto está
  // en USD. Una compra local toda en soles no lo pide (MOM §45.12).
  if (!fx && input.landed.hasUsd) blockers.push("Falta el tipo de cambio (soles por 1 USD).");
  const withSku = input.items.filter((it) => (it.sku ?? "").trim());
  if (!withSku.length) blockers.push("Ningún producto tiene SKU: no hay nada que pasar a Costos.");
  const uncounted = withSku.filter((it) => it.receivedQty == null);
  if (uncounted.length) blockers.push(`Falta contar ${uncounted.length} producto${uncounted.length === 1 ? "" : "s"} con SKU: registra su entrega.`);
  const keys = new Map<string, number>();
  for (const it of withSku) {
    const k = `${it.storeId ?? ""}|${it.sku!.trim().toLowerCase()}`;
    keys.set(k, (keys.get(k) ?? 0) + 1);
  }
  const dup = [...keys.entries()].filter(([, n]) => n > 1).map(([k]) => k.split("|")[1]);
  if (dup.length) blockers.push(`El SKU ${dup.join(", ")} está en más de una línea de la misma tienda: únelas antes de pasar a Costos.`);

  const lines: CostPushLine[] = withSku.map((it) => {
    const base = { itemId: it.id, name: it.name, sku: it.sku!.trim(), storeId: it.storeId };
    if (it.costPushedAt) return { ...base, state: "already", pushedAt: it.costPushedAt };
    const line = input.landed.byItem.get(it.id);
    if (it.receivedQty != null && line && line.good === 0) {
      return { ...base, state: "skip", reason: "Sin unidades buenas: no entró nada que costear." };
    }
    // La vista en soles: los costos en soles entran tal cual; se redondea solo al final.
    if (!line || (!fx && input.landed.hasUsd) || !line.pen) return { ...base, state: "skip", reason: "Sin costo calculado." };
    return { ...base, state: "push", unitCostPen: round2(line.pen.unitCost) };
  });
  const alreadyDone = withSku.length > 0 && lines.every((l) => l.state === "already");
  return {
    ready: !blockers.length && lines.some((l) => l.state === "push"),
    blockers,
    lines,
    alreadyDone,
  };
}

/** La nota del costo en Costos. */
export function costPushNote(code: string): string {
  return `Costo aterrizado ${code}`;
}
