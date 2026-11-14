// El Excel de una importación (MOM §45.9), con exceljs. Lo arma la ruta
// app/api/compras/excel/[id]/route.ts a partir de `loadImportDetail`, que ya
// vuelve a pedir el permiso en la organización y NO lee el dinero sin «Montos de
// compras». Aquí, además, las columnas y hojas de dinero solo se escriben con
// ese permiso: sin él salen la importación, los productos y la recepción.
//
// El costo aterrizado es el de `landedCosts` (lib/compras.ts): no se recalcula
// de otra forma. Redondeos del Excel: montos a 2 decimales, costos por unidad a
// 4, margen % a 1 decimal (referencia §6.18).

import ExcelJS from "exceljs";
import {
  IMPORT_STATUS_LABEL,
  allocationLabel,
  costKindLabel,
  formatDmy,
  goodUnits,
  landedCosts,
  marginOf,
  moneySummary,
  paymentMethodLabel,
  receptionSummary,
  round2,
  trackingPublicUrl,
  transportLabel,
  type Allocation,
  type CostKind,
} from "@/lib/compras";
import type { ImportDetail } from "@/lib/compras-server";
import { fmtDateTime } from "@/components/compras/format";

const USD = '#,##0.00';
const UNIT = '#,##0.0000';
const PCT = '0.0%';
const INT = '#,##0';

const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10_000) / 10_000;

export function importExcelFilename(code: string): string {
  return `${code.replace(/[^A-Za-z0-9-]/g, "_")}.xlsx`;
}

interface Col {
  header: string;
  width: number;
  fmt?: string;
}

function sheetWithColumns(wb: ExcelJS.Workbook, name: string, cols: Col[]): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name);
  ws.columns = cols.map((c) => ({ header: c.header, width: c.width, style: c.fmt ? { numFmt: c.fmt } : {} }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  return ws;
}

/**
 * El libro de la importación. `money` sale de los permisos del detalle: sin
 * «Montos de compras» no hay costos, precios, márgenes, costos repartidos ni
 * pagos (y el detalle ni los trae).
 */
export async function buildImportWorkbook(
  detail: ImportDetail,
  opts: { storeNames: Map<string, string>; now?: Date },
): Promise<Buffer> {
  const { imp, items, supplier } = detail;
  const money = detail.perms.canMoney && detail.costs !== null && detail.payments !== null;
  const fx = money ? (imp.fx_pen_per_usd ?? null) : null;

  const landed = money
    ? landedCosts(
        items.map((it) => ({
          id: it.id,
          name: it.name,
          qty: it.qty,
          unitCostUsd: it.unit_cost_usd ?? 0,
          unitWeightKg: it.unit_weight_kg,
          receivedQty: it.received_qty,
          damagedQty: it.damaged_qty,
        })),
        (detail.costs ?? []).map((c) => ({
          id: c.id,
          kind: c.kind as CostKind,
          label: c.label,
          amountUsd: c.amount_usd,
          allocation: c.allocation as Allocation,
          itemId: c.item_id,
        })),
      )
    : null;
  const summary = landed
    ? moneySummary(
        landed,
        items.map((it) => ({ id: it.id, salePricePen: it.sale_price_pen })),
        (detail.payments ?? []).map((p) => ({ amountUsd: p.amount_usd })),
        fx,
      )
    : null;
  const reception = receptionSummary(
    items.map((it) => ({ id: it.id, name: it.name, qty: it.qty, receivedQty: it.received_qty, damagedQty: it.damaged_qty })),
  );

  const wb = new ExcelJS.Workbook();
  wb.creator = "Kapta";
  wb.created = opts.now ?? new Date();

  // ── Importación ─────────────────────────────────────────────────────────
  const head = wb.addWorksheet("Importación");
  head.columns = [{ width: 34 }, { width: 60 }];
  head.addRow([`Importación ${imp.code}`]).font = { bold: true, size: 13 };
  head.addRow([]);
  const kv = (k: string, v: string | number | null, fmt?: string) => {
    const row = head.addRow([k, v ?? "—"]);
    row.getCell(1).font = { bold: true };
    if (fmt && typeof v === "number") row.getCell(2).numFmt = fmt;
  };
  kv("Estado", IMPORT_STATUS_LABEL[imp.status]);
  kv("Proveedor", supplier?.name ?? "Sin proveedor");
  kv("Origen", imp.origin);
  kv("Destino", "Bodega de Kapta, Lima");
  kv("Transporte", transportLabel(imp.transport));
  kv("Paquetera", imp.carrier);
  kv("Guía", imp.tracking_number);
  kv("Seguimiento", trackingPublicUrl({ carrier: imp.carrier, trackingNumber: imp.tracking_number, trackingUrl: imp.tracking_url }));
  kv("N.º de orden", imp.platform_order);
  kv("Fecha del pedido", formatDmy(imp.ordered_on));
  kv("Llegada estimada", formatDmy(imp.eta));
  kv("Llegada", formatDmy(imp.arrived_on));
  kv("Avisada a la bodega", imp.reported_to_warehouse_at ? fmtDateTime(imp.reported_to_warehouse_at) : "No");
  kv("Notas", imp.notes);
  head.addRow([]);
  head.addRow(["Recepción"]).font = { bold: true };
  kv("Pedidas", reception.ordered, INT);
  kv("Llegaron", reception.received, INT);
  kv("Faltan", reception.missing, INT);
  kv("Sobran", reception.extra, INT);
  kv("Dañadas", reception.damaged, INT);
  kv("Buenas", reception.good, INT);
  kv("Productos sin contar", reception.uncounted, INT);
  if (summary && landed) {
    head.addRow([]);
    head.addRow(["Dinero (USD)"]).font = { bold: true };
    kv("Tipo de cambio (S/ por 1 USD)", fx, UNIT);
    kv("Costo de los productos", round2(landed.productTotal), USD);
    kv("Costos repartidos", round2(landed.costsTotal), USD);
    kv("Costo total", round2(summary.totalUsd), USD);
    if (fx) kv("Costo total (S/)", round2(summary.totalUsd * fx), USD);
    kv("Costo promedio por unidad buena", summary.avgUnitUsd != null ? round4(summary.avgUnitUsd) : null, UNIT);
    kv("Pagado", round2(summary.paidUsd), USD);
    kv("Falta pagar", round2(summary.pendingUsd), USD);
    kv("Ganancia esperada (S/)", summary.expectedProfitPen != null ? round2(summary.expectedProfitPen) : null, USD);
  }
  head.addRow([]);
  kv("Generado", fmtDateTime((opts.now ?? new Date()).toISOString()));

  // ── Productos ───────────────────────────────────────────────────────────
  const baseCols: Col[] = [
    { header: "#", width: 5 },
    { header: "Producto", width: 34 },
    { header: "SKU", width: 16 },
    { header: "Tienda", width: 18 },
    { header: "Cantidad", width: 10, fmt: INT },
    { header: "Peso por unidad (kg)", width: 12, fmt: UNIT },
    { header: "Recibidas", width: 10, fmt: INT },
    { header: "Dañadas", width: 10, fmt: INT },
    { header: "Buenas", width: 10, fmt: INT },
    { header: "Faltan", width: 10, fmt: INT },
    { header: "Nota de recepción", width: 28 },
  ];
  const moneyCols: Col[] = [
    { header: "Costo proveedor por unidad (USD)", width: 14, fmt: UNIT },
    { header: "Proveedor por unidad buena (USD)", width: 14, fmt: UNIT },
    { header: "Envío por unidad buena (USD)", width: 14, fmt: UNIT },
    { header: "Importación por unidad buena (USD)", width: 14, fmt: UNIT },
    { header: "Adicional por unidad buena (USD)", width: 14, fmt: UNIT },
    { header: "Costo aterrizado por unidad (USD)", width: 14, fmt: UNIT },
    { header: "Costo aterrizado por unidad (S/)", width: 14, fmt: USD },
    { header: "Precio de venta (S/)", width: 12, fmt: USD },
    { header: "Margen por unidad (S/)", width: 12, fmt: USD },
    { header: "Margen %", width: 10, fmt: PCT },
    { header: "Costo total de la línea (USD)", width: 14, fmt: USD },
    { header: "Pasó a Costos", width: 18 },
  ];
  const products = sheetWithColumns(wb, "Productos", money ? [...baseCols, ...moneyCols] : baseCols);
  items.forEach((it, i) => {
    const counted = it.received_qty != null;
    const base: (string | number | null)[] = [
      i + 1,
      it.name,
      it.sku ?? "",
      it.store_id ? (opts.storeNames.get(it.store_id) ?? "") : "General",
      it.qty,
      it.unit_weight_kg,
      counted ? it.received_qty : null,
      counted ? (it.damaged_qty ?? 0) : null,
      goodUnits({ qty: it.qty, receivedQty: it.received_qty, damagedQty: it.damaged_qty }),
      counted ? Math.max(0, it.qty - (it.received_qty ?? 0)) : null,
      it.reception_note ?? "",
    ];
    if (!money || !landed) {
      products.addRow(base);
      return;
    }
    const line = landed.byItem.get(it.id)!;
    const m = marginOf(line.unitCost, fx, it.sale_price_pen, line.good);
    products.addRow([
      ...base,
      round4(it.unit_cost_usd ?? 0),
      round4(line.perUnit.product),
      round4(line.perUnit.envio),
      round4(line.perUnit.importacion),
      round4(line.perUnit.adicional),
      round4(line.unitCost),
      fx ? round2(line.unitCost * fx) : null,
      it.sale_price_pen ?? null,
      m ? round2(m.unit) : null,
      m ? Math.round(m.pct * 1000) / 1000 : null,
      round2(line.total),
      it.cost_pushed_at ? fmtDateTime(it.cost_pushed_at) : "",
    ]);
  });

  if (!money || !landed || !summary) return Buffer.from(await wb.xlsx.writeBuffer());

  // ── Costos ──────────────────────────────────────────────────────────────
  const itemName = new Map(items.map((it) => [it.id, it.name]));
  const costs = sheetWithColumns(wb, "Costos", [
    { header: "Tipo", width: 14 },
    { header: "Nombre", width: 30 },
    { header: "Reparto", width: 20 },
    { header: "Producto", width: 30 },
    { header: "Monto (USD)", width: 14, fmt: USD },
  ]);
  for (const c of detail.costs ?? []) {
    costs.addRow([
      costKindLabel(c.kind),
      c.label,
      allocationLabel(c.allocation),
      c.allocation === "item" ? (c.item_id ? (itemName.get(c.item_id) ?? "") : "(producto quitado)") : "",
      round2(c.amount_usd),
    ]);
  }
  costs.addRow(["Total", "", "", "", round2(landed.costsTotal)]).font = { bold: true };
  if (landed.warnings.length) {
    costs.addRow([]);
    costs.addRow(["Notas del cálculo"]).font = { bold: true };
    for (const w of landed.warnings) costs.addRow([w]);
  }

  // ── Pagos ───────────────────────────────────────────────────────────────
  const pays = sheetWithColumns(wb, "Pagos", [
    { header: "Fecha", width: 12 },
    { header: "Método", width: 16 },
    { header: "Monto (USD)", width: 14, fmt: USD },
    { header: "Nota", width: 40 },
  ]);
  for (const p of detail.payments ?? []) pays.addRow([formatDmy(p.paid_on), paymentMethodLabel(p.method), round2(p.amount_usd), p.note ?? ""]);
  pays.addRow(["Pagado", "", round2(summary.paidUsd), ""]).font = { bold: true };
  pays.addRow(["Falta pagar", "", round2(summary.pendingUsd), ""]).font = { bold: true };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
