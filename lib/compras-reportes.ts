// «Compras»: estadísticas de proveedores y reportes (MOM §45.7 y §45.8,
// 14-11-2026). Reglas PURAS y probadas (test/compras-reportes.test.ts). La
// referencia es docs/compras/referencia-modulo-compras.md §4.3, §4.4 y §6.17.
//
// Todo en USD (la base) y, donde la importación tiene su tipo de cambio, también
// en soles. El costo de cada importación es el costo aterrizado de
// `landedCosts` (lib/compras.ts): aquí no se vuelve a calcular.
//
// Reglas comunes:
//   - Las COTIZACIONES y las CANCELADAS no cuentan como compras (§6.17).
//   - Las fechas son días de Lima: la del pedido (`ordered_on`) y, sin ella, el
//     día de Lima de la creación.

import {
  daysBetween,
  isActiveStatus,
  landedCosts,
  limaDateOf,
  type ImportStatus,
  type LandedCostRow,
  type LandedResult,
} from "@/lib/compras";

/** Pagado de más por menos de medio centavo no cuenta (como `moneySummary`). */
const HALF_CENT = 0.005;
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
  /** Solo con «Montos de compras»; sin él, 0. */
  unitCostUsd: number;
  unitWeightKg: number | null;
  receivedQty: number | null;
  damagedQty: number | null;
}

export interface ReportImport {
  id: string;
  code: string;
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
  /** Vacío sin «Montos de compras». */
  payments: { amountUsd: number; paidOn: string }[];
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

/** El costo aterrizado de la importación, con la función de siempre. */
export function landedOf(imp: Pick<ReportImport, "items" | "costs">): LandedResult {
  return landedCosts(
    imp.items.map((it) => ({
      id: it.id,
      name: it.name,
      qty: it.qty,
      unitCostUsd: it.unitCostUsd,
      unitWeightKg: it.unitWeightKg,
      receivedQty: it.receivedQty,
      damagedQty: it.damagedQty,
    })),
    imp.costs,
  );
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
  /** Solo con «Montos de compras»: Σ costo aterrizado de las compradas (USD). */
  boughtUsd?: number;
  /** Lo mismo en soles, de las compradas que tienen tipo de cambio. */
  boughtPen?: number;
  /** Compradas sin tipo de cambio (no entran en `boughtPen`). */
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
        countedOrdered += it.qty;
        countedBad += Math.max(0, it.qty - it.receivedQty) + (it.damagedQty ?? 0);
      }
      const key = productKey(it);
      const p = products.get(key) ?? { key, name: it.name, sku: (it.sku ?? "").trim() || null, units: 0 };
      p.units += it.qty;
      products.set(key, p);
    }
    if (opts.money) {
      const total = landedOf(imp).total;
      boughtUsd += total;
      if (imp.fxPenPerUsd && imp.fxPenPerUsd > 0) boughtPen += total * imp.fxPenPerUsd;
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
    ...(opts.money ? { boughtUsd, boughtPen, boughtWithoutFx } : {}),
  };
}

/** «A tiempo» bajo (rojo): menos del 70 %. */
export const onTimeIsLow = (share: number | null) => share !== null && share < ON_TIME_WARN;
/** «Faltantes y dañadas» alto (rojo): 3 % o más. */
export const shortageIsHigh = (share: number | null) => share !== null && share >= SHORTAGE_WARN;

/** Ranking de proveedores por monto comprado (USD), de mayor a menor; sin compras no entran. */
export function supplierRanking(
  stats: readonly SupplierStats[],
): { supplierId: string; boughtUsd: number; boughtPen: number; share: number; bought: number; units: number }[] {
  const rows = stats.filter((s) => (s.boughtUsd ?? 0) > 0);
  const total = rows.reduce((a, s) => a + (s.boughtUsd ?? 0), 0);
  return rows
    .map((s) => ({
      supplierId: s.supplierId,
      boughtUsd: s.boughtUsd ?? 0,
      boughtPen: s.boughtPen ?? 0,
      share: total > 0 ? (s.boughtUsd ?? 0) / total : 0,
      bought: s.bought,
      units: s.units,
    }))
    .sort((a, b) => b.boughtUsd - a.boughtUsd);
}

// ---------------------------------------------------------------------------
// Dinero en camino (referencia §6.17 `moneyInTransit`)
// ---------------------------------------------------------------------------

export interface MoneyInTransit {
  /** Activas que no son cotización. */
  imports: number;
  units: number;
  totalUsd: number;
  paidUsd: number;
  /** Σ lo que falta pagar de cada una (un pago de más en una no descuenta otra). */
  pendingUsd: number;
  /** En soles, solo de las que tienen tipo de cambio. */
  totalPen: number;
  pendingPen: number;
  /** Cuántas no tienen tipo de cambio (no entran en los soles). */
  withoutFx: number;
}

export function moneyInTransit(imports: readonly ReportImport[]): MoneyInTransit {
  const out: MoneyInTransit = { imports: 0, units: 0, totalUsd: 0, paidUsd: 0, pendingUsd: 0, totalPen: 0, pendingPen: 0, withoutFx: 0 };
  for (const imp of imports) {
    if (!isActiveStatus(imp.status) || imp.status === "cotizacion") continue;
    const total = landedOf(imp).total;
    const paid = imp.payments.reduce((a, p) => a + (Number(p.amountUsd) || 0), 0);
    const pending = total - paid > HALF_CENT ? total - paid : 0;
    out.imports += 1;
    out.units += imp.items.reduce((a, it) => a + it.qty, 0);
    out.totalUsd += total;
    out.paidUsd += paid;
    out.pendingUsd += pending;
    if (imp.fxPenPerUsd && imp.fxPenPerUsd > 0) {
      out.totalPen += total * imp.fxPenPerUsd;
      out.pendingPen += pending * imp.fxPenPerUsd;
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
  /** Σ costo aterrizado de las compradas pedidas ese mes. */
  boughtUsd: number;
  /** Lo mismo en soles, de las que tienen tipo de cambio. */
  boughtPen: number;
  /** Σ pagos con fecha de ese mes, sin los de importaciones canceladas. */
  paidUsd: number;
  /** Los pagos en soles, con el tipo de cambio de su importación (si lo tiene). */
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
  const rows = new Map(months.map((month) => [month, { month, imports: 0, units: 0, boughtUsd: 0, boughtPen: 0, paidUsd: 0, paidPen: 0 }]));
  for (const imp of imports) {
    const fx = imp.fxPenPerUsd && imp.fxPenPerUsd > 0 ? imp.fxPenPerUsd : null;
    if (isBought(imp.status)) {
      const row = rows.get(monthOf(orderDateOf(imp)));
      if (row) {
        const total = landedOf(imp).total;
        row.imports += 1;
        row.units += imp.items.reduce((a, it) => a + it.qty, 0);
        row.boughtUsd += total;
        if (fx) row.boughtPen += total * fx;
      }
    }
    if (imp.status === "cancelado") continue;
    for (const p of imp.payments) {
      const row = rows.get(monthOf(p.paidOn));
      if (!row) continue;
      row.paidUsd += Number(p.amountUsd) || 0;
      if (fx) row.paidPen += (Number(p.amountUsd) || 0) * fx;
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
  unitCostUsd: number;
  /** Con el tipo de cambio de ESA importación; null si no tiene. */
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
  /** último ÷ anterior − 1; null sin anterior. */
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
    const perImport = new Map<string, { total: number; good: number; item: ReportItem }>();
    for (const it of imp.items) {
      const line = landed.byItem.get(it.id);
      if (!line || !(line.good > 0)) continue;
      const key = productKey(it);
      const acc = perImport.get(key) ?? { total: 0, good: 0, item: it };
      acc.total += line.total;
      acc.good += line.good;
      perImport.set(key, acc);
    }
    for (const [key, acc] of perImport) {
      const unitCostUsd = acc.total / acc.good;
      const fx = imp.fxPenPerUsd && imp.fxPenPerUsd > 0 ? imp.fxPenPerUsd : null;
      const entry =
        byKey.get(key) ??
        { key, name: acc.item.name, sku: (acc.item.sku ?? "").trim() || null, storeId: acc.item.storeId, latest: "", points: [] };
      entry.points.push({ importId: imp.id, code: imp.code, date, good: acc.good, unitCostUsd, unitCostPen: fx ? unitCostUsd * fx : null });
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
    const change = previous && previous.unitCostUsd > 0 ? last.unitCostUsd / previous.unitCostUsd - 1 : null;
    out.push({ key: e.key, name: e.name, sku: e.sku, storeId: e.storeId, points, last, previous, change, trend: unitCostTrend(change) });
  }
  return out.sort((a, b) => (a.last.date === b.last.date ? a.name.localeCompare(b.name, "es") : a.last.date < b.last.date ? 1 : -1));
}
