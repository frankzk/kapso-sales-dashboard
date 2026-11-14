// «Compras»: estadísticas de proveedores y reportes (MOM §45.7 y §45.8,
// 14-11-2026). Reglas PURAS y probadas (test/compras-reportes.test.ts). La
// referencia es docs/compras/referencia-modulo-compras.md §4.3, §4.4 y §6.17.
//
// Todo en USD (la base) y, donde la importación tiene su tipo de cambio, también
// en soles. El costo de cada importación es el costo aterrizado de
// `landedCosts` (lib/compras.ts): aquí no se vuelve a calcular.
//
// Monedas (0342): cada costo y cada pago viene en la suya. Los totales en USD
// llevan los soles ÷ el tipo de cambio de SU importación y los totales en soles
// los USD × ese tipo de cambio (los soles, tal cual). Una importación que
// necesita convertir y no tiene tipo de cambio no entra en ese total y se cuenta
// aparte (`…WithoutFx`): nunca se suma a medias.
//
// «Comprado» de cada proveedor y su ranking (`supplierBought`,
// `supplierRanking`): en una base comparable, soles si todas las compras se
// pueden llevar a soles (un laboratorio local todo en soles no necesita tipo
// de cambio), si no USD, y nunca mezclando monedas.
//
// Reglas comunes:
//   - Las COTIZACIONES y las CANCELADAS no cuentan como compras (§6.17).
//   - Las fechas son días de Lima: la del pedido (`ordered_on`) y, sin ella, el
//     día de Lima de la creación.
//   - Las compras LOCALES (0343, MOM §45.12) entran igual: su costo es en soles
//     (el del laboratorio por unidad y sus costos), así que en los totales en
//     soles entran tal cual y en los de USD solo con su tipo de cambio (si no,
//     se cuentan aparte como cualquier importación con soles sin tipo de
//     cambio). Las faltantes se miden sobre lo esperado (pedidas + cortesía).

import {
  addMoney,
  daysBetween,
  isActiveStatus,
  landedCosts,
  limaDateOf,
  moneyInPen,
  moneyInUsd,
  moneyOf,
  paidSplit,
  paymentBalance,
  validFx,
  zeroMoney,
  expectedUnits,
  type Currency,
  type ImportKind,
  type ImportStatus,
  type LandedCostRow,
  type LandedResult,
  type Money2,
  type PaymentAmount,
} from "@/lib/compras";
/** «A tiempo» en rojo por debajo de esto. */
export const ON_TIME_WARN = 0.7;
/** «Faltantes y dañadas» en rojo desde esto. */
export const SHORTAGE_WARN = 0.03;
/** Un cambio del costo por unidad de más de esto se marca (rojo si sube, verde si baja). */
export const UNIT_COST_CHANGE_MARK = 0.02;
/** «Le compras»: los N productos con más unidades. */
export const TOP_PRODUCTS = 3;

export interface ReportItem {
  id: string;
  name: string;
  sku: string | null;
  storeId: string | null;
  qty: number;
  /** Cortesía (MOM §45.13); sin ella, 0. */
  courtesyQty?: number | null;
  /** Solo con «Montos de compras»; sin él, 0. */
  unitCostUsd: number;
  /** El costo por unidad en soles de una compra local (0343). Solo con «Montos de compras». */
  unitCostPen?: number | null;
  /** La moneda del costo por unidad; sin ella, USD. */
  unitCostCurrency?: Currency;
  unitWeightKg: number | null;
  receivedQty: number | null;
  damagedQty: number | null;
}

export interface ReportImport {
  id: string;
  code: string;
  /** Sin tipo: importación. */
  kind?: ImportKind;
  supplierId: string | null;
  status: ImportStatus;
  orderedOn: string | null;
  createdAt: string;
  eta: string | null;
  arrivedOn: string | null;
  /** Solo con «Montos de compras». */
  fxPenPerUsd: number | null;
  items: ReportItem[];
  /** Vacío sin «Montos de compras». */
  costs: LandedCostRow[];
  /** Vacío sin «Montos de compras». Cada pago en su moneda. */
  payments: (PaymentAmount & { paidOn: string })[];
}

/** ¿Cuenta como compra? Ni la cotización ni la cancelada (§6.17). */
export function isBought(status: ImportStatus): boolean {
  return status !== "cotizacion" && status !== "cancelado";
}

/** El día del pedido en Lima: `ordered_on` o, sin él, el día de Lima de la creación. */
export function orderDateOf(imp: Pick<ReportImport, "orderedOn" | "createdAt">): string {
  return imp.orderedOn ?? limaDateOf(imp.createdAt);
}

/** `AAAA-MM` de un día `AAAA-MM-DD`. */
export const monthOf = (date: string) => date.slice(0, 7);

/** El costo aterrizado de la importación, con la función de siempre y SU tipo de cambio. */
export function landedOf(imp: Pick<ReportImport, "items" | "costs" | "fxPenPerUsd">): LandedResult {
  return landedCosts(
    imp.items.map((it) => ({
      id: it.id,
      name: it.name,
      qty: it.qty,
      courtesyQty: it.courtesyQty ?? 0,
      unitCostUsd: it.unitCostUsd,
      unitCostPen: it.unitCostPen ?? null,
      unitCostCurrency: it.unitCostCurrency,
      unitWeightKg: it.unitWeightKg,
      receivedQty: it.receivedQty,
      damagedQty: it.damagedQty,
    })),
    imp.costs,
    imp.fxPenPerUsd,
  );
}

/**
 * ¿Le falta el tipo de cambio para sus cifras en USD? Tiene algún costo, pago o
 * costo por unidad (compra local) en soles y no tiene tipo de cambio (los
 * reportes dicen cuántas son).
 */
export function needsFxForUsd(imp: Pick<ReportImport, "costs" | "payments" | "fxPenPerUsd"> & { items?: readonly ReportItem[] }): boolean {
  if (validFx(imp.fxPenPerUsd)) return false;
  return (
    imp.costs.some((c) => c.currency === "PEN" && c.amount > 0) ||
    imp.payments.some((p) => p.currency === "PEN" && p.amount > 0) ||
    (imp.items ?? []).some((it) => it.unitCostCurrency === "PEN" && (it.unitCostPen ?? 0) > 0)
  );
}

/**
 * Cuántas importaciones que cuentan en los reportes (todas menos las
 * canceladas) tienen montos en soles sin tipo de cambio: lo que los reportes en
 * USD dejan fuera y dicen.
 */
export function importsMissingFxForUsd(imports: readonly ReportImport[]): number {
  return imports.filter((imp) => imp.status !== "cancelado" && needsFxForUsd(imp)).length;
}

/** `numerador / denominador`, o null si no hay base. */
const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);

// ---------------------------------------------------------------------------
// Un producto: por SKU y tienda si tiene SKU; si no, por el nombre normalizado
// ---------------------------------------------------------------------------

/** Minúsculas, sin tildes y sin signos: «Funda  iPhone-15 ÁÉ» → «funda iphone 15 ae». */
export function normalizeProductName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** La clave del producto entre importaciones. */
export function productKey(item: Pick<ReportItem, "sku" | "storeId" | "name">): string {
  const sku = (item.sku ?? "").trim().toLowerCase();
  return sku ? `sku:${item.storeId ?? ""}:${sku}` : `name:${normalizeProductName(item.name)}`;
}

// ---------------------------------------------------------------------------
// Proveedores (referencia §4.3 y §6.17)
// ---------------------------------------------------------------------------

export interface SupplierStats {
  supplierId: string;
  /** Todas sus importaciones, también cotizaciones y canceladas (la lista filtrada las muestra). */
  imports: number;
  /** Las que cuentan como compra. */
  bought: number;
  /** El día del pedido de la más reciente (cualquier estado). */
  lastOrderedOn: string | null;
  /** Unidades pedidas en las compradas. */
  units: number;
  /** «Tarda»: días promedio del pedido a la llegada, de las compradas que llegaron (solo diferencias ≥ 0). */
  avgLeadDays: number | null;
  /** Cuántas entran en «Tarda». */
  leadSamples: number;
  /** «A tiempo»: de las compradas que llegaron y tenían llegada estimada, la parte que llegó ese día o antes. */
  onTimeShare: number | null;
  onTimeSamples: number;
  /** «Faltantes y dañadas»: (Σ faltantes + Σ dañadas) ÷ Σ pedidas, en las líneas contadas de las compradas. */
  shortageShare: number | null;
  /** «Le compras»: los productos con más unidades en las compradas. */
  topProducts: { key: string; name: string; sku: string | null; units: number }[];
  /** Solo con «Montos de compras»: Σ costo aterrizado de las compradas (USD), de las que se pueden llevar a USD. */
  boughtUsd?: number;
  /** Compradas con montos en soles y sin tipo de cambio (no entran en `boughtUsd`). */
  boughtUsdWithoutFx?: number;
  /**
   * Lo mismo en soles, de las compradas que se pueden llevar a soles: los soles
   * tal cual y los USD × el tipo de cambio de SU importación (una compra local
   * toda en soles entra sin tipo de cambio).
   */
  boughtPen?: number;
  /** Compradas con montos en USD y sin tipo de cambio (no entran en `boughtPen`). */
  boughtWithoutFx?: number;
}

export function supplierStats(
  supplierId: string,
  imports: readonly ReportImport[],
  opts: { money: boolean },
): SupplierStats {
  const mine = imports.filter((imp) => imp.supplierId === supplierId);
  const bought = mine.filter((imp) => isBought(imp.status));
  let lastOrderedOn: string | null = null;
  for (const imp of mine) {
    const d = orderDateOf(imp);
    if (!lastOrderedOn || d > lastOrderedOn) lastOrderedOn = d;
  }

  let units = 0;
  const leadDays: number[] = [];
  let onTime = 0;
  let onTimeSamples = 0;
  let countedOrdered = 0;
  let countedBad = 0;
  const products = new Map<string, { key: string; name: string; sku: string | null; units: number }>();
  let boughtUsd = 0;
  let boughtUsdWithoutFx = 0;
  let boughtPen = 0;
  let boughtWithoutFx = 0;

  for (const imp of bought) {
    if (imp.arrivedOn) {
      const d = daysBetween(orderDateOf(imp), imp.arrivedOn);
      if (d >= 0) leadDays.push(d);
      if (imp.eta) {
        onTimeSamples += 1;
        if (imp.arrivedOn <= imp.eta) onTime += 1;
      }
    }
    for (const it of imp.items) {
      units += it.qty;
      if (it.receivedQty != null) {
        // Sobre lo esperado: la cortesía también tenía que llegar (MOM §45.13).
        const expected = expectedUnits(it);
        countedOrdered += expected;
        countedBad += Math.max(0, expected - it.receivedQty) + (it.damagedQty ?? 0);
      }
      const key = productKey(it);
      const p = products.get(key) ?? { key, name: it.name, sku: (it.sku ?? "").trim() || null, units: 0 };
      p.units += it.qty;
      products.set(key, p);
    }
    if (opts.money) {
      const landed = landedOf(imp);
      if (landed.usd) boughtUsd += landed.usd.total;
      else boughtUsdWithoutFx += 1;
      if (landed.pen) boughtPen += landed.pen.total;
      else boughtWithoutFx += 1;
    }
  }

  return {
    supplierId,
    imports: mine.length,
    bought: bought.length,
    lastOrderedOn,
    units,
    avgLeadDays: leadDays.length ? leadDays.reduce((a, b) => a + b, 0) / leadDays.length : null,
    leadSamples: leadDays.length,
    onTimeShare: ratio(onTime, onTimeSamples),
    onTimeSamples,
    shortageShare: ratio(countedBad, countedOrdered),
    topProducts: [...products.values()]
      .sort((a, b) => b.units - a.units || a.name.localeCompare(b.name, "es"))
      .slice(0, TOP_PRODUCTS),
    ...(opts.money ? { boughtUsd, boughtUsdWithoutFx, boughtPen, boughtWithoutFx } : {}),
  };
}

/** «A tiempo» bajo (rojo): menos del 70 %. */
export const onTimeIsLow = (share: number | null) => share !== null && share < ON_TIME_WARN;
/** «Faltantes y dañadas» alto (rojo): 3 % o más. */
export const shortageIsHigh = (share: number | null) => share !== null && share >= SHORTAGE_WARN;

// ---------------------------------------------------------------------------
// «Comprado» en una base que se puede comparar (MOM §45.7 y §45.8)
// ---------------------------------------------------------------------------
//
// Lo comprado se cuenta en UNA moneda, nunca mezclando: en SOLES si todas las
// compras se pueden llevar a soles (los soles tal cual, los USD × el tipo de
// cambio de su importación: un laboratorio local todo en soles no necesita
// tipo de cambio); si no, en USD si todas se pueden llevar a USD (lo de antes);
// si ninguna de las dos alcanza a todas, en la que alcanza a más (a igual
// cantidad, soles) y se dice cuántas quedan fuera por falta del tipo de
// cambio. El equivalente en la otra moneda solo se muestra si TODAS las
// compras se pueden llevar a ella: nunca una cifra a medias al lado de otra
// entera.

/** La moneda en que se compara lo comprado. */
export type BoughtBase = "PEN" | "USD";

export interface BoughtView {
  /** La moneda de `amount`; null si ninguna compra se puede valorar (o no hay compras). */
  base: BoughtBase | null;
  /** Σ costo aterrizado en `base` de las compras que se pueden llevar a ella. */
  amount: number | null;
  /** El equivalente en la otra moneda, solo si todas las compras se pueden llevar a ella. */
  other: number | null;
  /** Compras que no entran en `amount`: les falta el tipo de cambio. */
  missingFx: number;
  /** Compras que no se pueden llevar a la otra moneda (por eso no hay `other`). */
  otherMissingFx: number;
}

/** Cuántas compras se pueden llevar a cada moneda. */
function boughtCoverage(s: SupplierStats): { pen: number; usd: number } {
  return { pen: s.bought - (s.boughtWithoutFx ?? 0), usd: s.bought - (s.boughtUsdWithoutFx ?? 0) };
}

const amountIn = (s: SupplierStats, base: BoughtBase) => (base === "PEN" ? (s.boughtPen ?? 0) : (s.boughtUsd ?? 0));

/** Lo comprado a UN proveedor en una base comparable (la columna «Comprado» de Proveedores). */
export function supplierBought(s: SupplierStats): BoughtView {
  const none: BoughtView = { base: null, amount: null, other: null, missingFx: 0, otherMissingFx: 0 };
  if (!s.bought || s.boughtUsd === undefined) return none;
  const ok = boughtCoverage(s);
  let base: BoughtBase | null;
  if (ok.pen === s.bought) base = "PEN";
  else if (ok.usd === s.bought) base = "USD";
  else if (!ok.pen && !ok.usd) return { ...none, missingFx: s.bought, otherMissingFx: s.bought };
  else base = ok.pen >= ok.usd ? "PEN" : "USD";
  const otherBase: BoughtBase = base === "PEN" ? "USD" : "PEN";
  const otherOk = otherBase === "PEN" ? ok.pen : ok.usd;
  const covered = base === "PEN" ? ok.pen : ok.usd;
  return {
    base,
    amount: amountIn(s, base),
    // Solo entero: si la base deja alguna fuera, la otra moneda tampoco va.
    other: covered === s.bought && otherOk === s.bought ? amountIn(s, otherBase) : null,
    missingFx: s.bought - covered,
    otherMissingFx: s.bought - otherOk,
  };
}

export interface SupplierRankingRow {
  supplierId: string;
  /** En la base del ranking. */
  amount: number;
  /** El equivalente en la otra moneda, solo si todas sus compras se pueden llevar a ella. */
  other: number | null;
  /** `amount` ÷ Σ `amount` del ranking. */
  share: number;
  bought: number;
  units: number;
  /** Sus compras que no entran en `amount` (falta el tipo de cambio). */
  missingFx: number;
}

export interface SupplierRanking {
  /** Una sola moneda para todo el ranking. */
  base: BoughtBase;
  rows: SupplierRankingRow[];
  /** Σ `amount` de las filas. */
  total: number;
  /** Proveedores con compras de las que ninguna se puede llevar a la base: no entran en el ranking. */
  outside: { supplierId: string; bought: number }[];
  /** Compras que no entran en el ranking (de las filas y de `outside`): les falta el tipo de cambio. */
  missingFx: number;
}

/**
 * Ranking de proveedores por monto comprado, de mayor a menor, en UNA base para
 * todos: soles si todas las compras de todos se pueden llevar a soles; si no,
 * USD si todas se pueden llevar a USD; si no, la que alcanza a más compras (a
 * igual cantidad, soles), con las que quedan fuera contadas. Sin compras no
 * entran. Solo con «Montos de compras» (las estadísticas sin montos no rankean).
 */
export function supplierRanking(stats: readonly SupplierStats[]): SupplierRanking {
  const buyers = stats.filter((s) => s.bought > 0 && s.boughtUsd !== undefined);
  const cover = buyers.map((s) => ({ s, ok: boughtCoverage(s) }));
  const totalBought = buyers.reduce((a, s) => a + s.bought, 0);
  const penOk = cover.reduce((a, c) => a + c.ok.pen, 0);
  const usdOk = cover.reduce((a, c) => a + c.ok.usd, 0);
  const base: BoughtBase = penOk === totalBought ? "PEN" : usdOk === totalBought ? "USD" : penOk >= usdOk ? "PEN" : "USD";
  const rows: SupplierRankingRow[] = [];
  const outside: SupplierRanking["outside"] = [];
  let missingFx = 0;
  for (const { s, ok } of cover) {
    const covered = base === "PEN" ? ok.pen : ok.usd;
    const otherOk = base === "PEN" ? ok.usd : ok.pen;
    missingFx += s.bought - covered;
    if (!covered) {
      outside.push({ supplierId: s.supplierId, bought: s.bought });
      continue;
    }
    // Compras sin ningún monto cargado todavía: como antes, no rankean.
    if (!(amountIn(s, base) > 0)) continue;
    rows.push({
      supplierId: s.supplierId,
      amount: amountIn(s, base),
      other: covered === s.bought && otherOk === s.bought ? amountIn(s, base === "PEN" ? "USD" : "PEN") : null,
      share: 0,
      bought: s.bought,
      units: s.units,
      missingFx: s.bought - covered,
    });
  }
  const total = rows.reduce((a, r) => a + r.amount, 0);
  for (const r of rows) r.share = total > 0 ? r.amount / total : 0;
  rows.sort((a, b) => b.amount - a.amount || b.bought - a.bought);
  return { base, rows, total, outside, missingFx };
}

// ---------------------------------------------------------------------------
// Dinero en camino (referencia §6.17 `moneyInTransit`)
// ---------------------------------------------------------------------------

export interface MoneyInTransit {
  /** Activas que no son cotización. */
  imports: number;
  units: number;
  /** En USD, de las que se pueden llevar a USD (costo, pagado y lo que falta, de las mismas). */
  totalUsd: number;
  paidUsd: number;
  /** Σ lo que falta pagar de cada una (un pago de más en una no descuenta otra). */
  pendingUsd: number;
  /** Cuántas tienen montos en soles y no tienen tipo de cambio (no entran en los USD). */
  usdWithoutFx: number;
  /** En soles, de las que se pueden llevar a soles. */
  totalPen: number;
  pendingPen: number;
  /** Cuántas no se pueden llevar a soles (no entran en los soles). */
  withoutFx: number;
}

export function moneyInTransit(imports: readonly ReportImport[]): MoneyInTransit {
  const out: MoneyInTransit = { imports: 0, units: 0, totalUsd: 0, paidUsd: 0, pendingUsd: 0, usdWithoutFx: 0, totalPen: 0, pendingPen: 0, withoutFx: 0 };
  for (const imp of imports) {
    if (!isActiveStatus(imp.status) || imp.status === "cotizacion") continue;
    const landed = landedOf(imp);
    // La misma cuenta de «Pagado / Falta pagar» del detalle (`paymentBalance`).
    const b = paymentBalance(landed.split.total, paidSplit(imp.payments), imp.fxPenPerUsd);
    out.imports += 1;
    out.units += imp.items.reduce((a, it) => a + it.qty, 0);
    if (b.totalUsd !== null && b.paidUsd !== null && b.pendingUsd !== null) {
      out.totalUsd += b.totalUsd;
      out.paidUsd += b.paidUsd;
      out.pendingUsd += b.pendingUsd;
    } else out.usdWithoutFx += 1;
    if (b.totalPen !== null && b.pendingPen !== null) {
      out.totalPen += b.totalPen;
      out.pendingPen += b.pendingPen;
    } else out.withoutFx += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Por mes (referencia §6.17 `monthlySpend`)
// ---------------------------------------------------------------------------

export interface MonthRow {
  /** `AAAA-MM`. */
  month: string;
  /** Compradas pedidas ese mes (día del pedido en Lima). */
  imports: number;
  units: number;
  /** Σ costo aterrizado de las compradas pedidas ese mes, de las que se pueden llevar a USD. */
  boughtUsd: number;
  /** Compradas ese mes que no entran en `boughtUsd` (costos en soles sin tipo de cambio). */
  boughtUsdWithoutFx: number;
  /** Lo mismo en soles, de las que se pueden llevar a soles. */
  boughtPen: number;
  /** Σ pagos con fecha de ese mes, sin los de importaciones canceladas: los USD y los soles ÷ el tipo de cambio de su importación. */
  paidUsd: number;
  /** Pagos en soles de ese mes que no entran en `paidUsd` (su importación no tiene tipo de cambio). */
  paidUsdWithoutFx: number;
  /** Los pagos en soles: los soles tal cual y los USD × el tipo de cambio de su importación (si lo tiene). */
  paidPen: number;
}

/** Los `count` meses que terminan en el de `today` (Lima), del más viejo al actual. */
export function lastMonths(today: string, count: number): string[] {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const idx = y * 12 + (m - 1) - i;
    out.push(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

export function monthlySpend(imports: readonly ReportImport[], today: string, count = 12): MonthRow[] {
  const months = lastMonths(today, count);
  const rows = new Map<string, MonthRow>(
    months.map((month) => [month, { month, imports: 0, units: 0, boughtUsd: 0, boughtUsdWithoutFx: 0, boughtPen: 0, paidUsd: 0, paidUsdWithoutFx: 0, paidPen: 0 }]),
  );
  for (const imp of imports) {
    const fx = validFx(imp.fxPenPerUsd);
    if (isBought(imp.status)) {
      const row = rows.get(monthOf(orderDateOf(imp)));
      if (row) {
        const landed = landedOf(imp);
        row.imports += 1;
        row.units += imp.items.reduce((a, it) => a + it.qty, 0);
        if (landed.usd) row.boughtUsd += landed.usd.total;
        else row.boughtUsdWithoutFx += 1;
        if (landed.pen) row.boughtPen += landed.pen.total;
      }
    }
    if (imp.status === "cancelado") continue;
    for (const p of imp.payments) {
      const row = rows.get(monthOf(p.paidOn));
      if (!row) continue;
      const m = moneyOf(Number(p.amount) || 0, p.currency);
      const usd = moneyInUsd(m, fx);
      const pen = moneyInPen(m, fx);
      if (usd !== null) row.paidUsd += usd;
      else row.paidUsdWithoutFx += 1;
      if (pen !== null) row.paidPen += pen;
    }
  }
  return months.map((m) => rows.get(m)!);
}

// ---------------------------------------------------------------------------
// Costo por unidad de cada producto (referencia §6.17 `unitCostHistory`)
// ---------------------------------------------------------------------------

export interface UnitCostPoint {
  importId: string;
  code: string;
  /** Día del pedido en Lima. */
  date: string;
  /** Unidades buenas (sobre ellas se divide el costo). */
  good: number;
  /** Null si le tocan costos en soles y ESA importación no tiene tipo de cambio. */
  unitCostUsd: number | null;
  /** Con el tipo de cambio de ESA importación (los soles, tal cual); null si hace falta y no tiene. */
  unitCostPen: number | null;
}

export interface UnitCostProduct {
  key: string;
  name: string;
  sku: string | null;
  storeId: string | null;
  /** Del más viejo al más reciente. */
  points: UnitCostPoint[];
  last: UnitCostPoint;
  previous: UnitCostPoint | null;
  /** último ÷ anterior − 1, en USD; null sin anterior o si a alguno le falta el tipo de cambio. */
  change: number | null;
  /** «up» si sube más de 2 %, «down» si baja más de 2 %. */
  trend: "up" | "down" | "flat" | null;
}

export function unitCostTrend(change: number | null): UnitCostProduct["trend"] {
  if (change === null) return null;
  if (change > UNIT_COST_CHANGE_MARK) return "up";
  if (change < -UNIT_COST_CHANGE_MARK) return "down";
  return "flat";
}

/**
 * Un punto por importación COMPRADA y producto con unidades buenas > 0: su
 * costo aterrizado por unidad (si el producto está en dos líneas de la misma
 * importación, Σ costo ÷ Σ buenas). Ordenado del más reciente al más viejo.
 */
export function unitCostHistory(imports: readonly ReportImport[]): UnitCostProduct[] {
  const byKey = new Map<string, { key: string; name: string; sku: string | null; storeId: string | null; latest: string; points: UnitCostPoint[] }>();
  for (const imp of imports) {
    if (!isBought(imp.status) || !imp.items.length) continue;
    const landed = landedOf(imp);
    const date = orderDateOf(imp);
    const perImport = new Map<string, { total: Money2; good: number; item: ReportItem }>();
    for (const it of imp.items) {
      const line = landed.byItem.get(it.id);
      if (!line || !(line.good > 0)) continue;
      const key = productKey(it);
      const acc = perImport.get(key) ?? { total: zeroMoney(), good: 0, item: it };
      acc.total = addMoney(acc.total, line.split.total);
      acc.good += line.good;
      perImport.set(key, acc);
    }
    for (const [key, acc] of perImport) {
      const usd = moneyInUsd(acc.total, imp.fxPenPerUsd);
      const pen = moneyInPen(acc.total, imp.fxPenPerUsd);
      const entry =
        byKey.get(key) ??
        { key, name: acc.item.name, sku: (acc.item.sku ?? "").trim() || null, storeId: acc.item.storeId, latest: "", points: [] };
      entry.points.push({
        importId: imp.id,
        code: imp.code,
        date,
        good: acc.good,
        unitCostUsd: usd === null ? null : usd / acc.good,
        unitCostPen: pen === null ? null : pen / acc.good,
      });
      // El nombre que se muestra es el de la compra más reciente.
      if (date >= entry.latest) {
        entry.latest = date;
        entry.name = acc.item.name;
      }
      byKey.set(key, entry);
    }
  }
  const out: UnitCostProduct[] = [];
  for (const e of byKey.values()) {
    const points = [...e.points].sort((a, b) => (a.date === b.date ? a.code.localeCompare(b.code) : a.date < b.date ? -1 : 1));
    const last = points[points.length - 1]!;
    const previous = points.length > 1 ? points[points.length - 2]! : null;
    // En USD; si a alguno le falta el tipo de cambio y los dos tienen soles
    // (compras locales sin tipo de cambio), en soles.
    const change =
      previous && previous.unitCostUsd != null && previous.unitCostUsd > 0 && last.unitCostUsd != null
        ? last.unitCostUsd / previous.unitCostUsd - 1
        : previous && previous.unitCostPen != null && previous.unitCostPen > 0 && last.unitCostPen != null
          ? last.unitCostPen / previous.unitCostPen - 1
          : null;
    out.push({ key: e.key, name: e.name, sku: e.sku, storeId: e.storeId, points, last, previous, change, trend: unitCostTrend(change) });
  }
  return out.sort((a, b) => (a.last.date === b.last.date ? a.name.localeCompare(b.name, "es") : a.last.date < b.last.date ? 1 : -1));
}
