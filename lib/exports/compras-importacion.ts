// El Excel de una importación (MOM §45.9), con exceljs. Lo arma la ruta
// app/api/compras/excel/[id]/route.ts a partir de `loadImportDetail`, que ya
// vuelve a pedir el permiso en la organización y NO lee el dinero sin «Montos de
// compras». Aquí, además, las columnas y hojas de dinero solo se escriben con
// ese permiso: sin él salen la importación, los productos y la recepción.
//
// El costo aterrizado es el de `landedCosts` (lib/compras.ts): no se recalcula
// de otra forma. Redondeos del Excel: montos a 2 decimales, costos por unidad a
// 4, margen % a 1 decimal (referencia §6.18).
//
// Monedas (MOM §45.3 y §45.9, 0342): cada costo y cada pago sale en SU moneda y,
// al lado, en USD y en soles con el tipo de cambio de la importación. Lo que
// necesita convertir y no tiene tipo de cambio dice «Falta el tipo de cambio»
// en la celda, nunca una cifra a medias. Un costo con «Incluye IGV» dice
// «S/ 504.16 con IGV → S/ 427.25 sin IGV».
//
// Compras locales, cortesía y entregas (MOM §45.12–§45.14, 0343): el tipo de
// compra va en la hoja Importación; una compra local va en soles (su costo por
// unidad y el desglose, en S/) y no lleva transporte ni guía; los productos
// dicen su cortesía, lo esperado y lo que falta; la hoja «Entregas» lista cada
// entrega con su fecha, quién, sus unidades por producto y cuántas fotos tiene.

import ExcelJS from "exceljs";
import {
  IGV_TREATMENTS,
  IMPORT_STATUS_LABEL,
  MISSING_FX,
  allocationLabel,
  baseCurrencyOf,
  expectedUnits,
  hasShipping,
  importKindLabel,
  itemUnitCost,
  lineProgress,
  costAmountText,
  costKindLabel,
  currencySymbol,
  formatDmy,
  goodUnits,
  landedCostOf,
  landedCosts,
  landedItemOf,
  marginOf,
  moneyInPen,
  moneyInUsd,
  moneyOf,
  moneySummary,
  paymentMethodLabel,
  receptionSummary,
  round2,
  traceCodes,
  traceMissingText,
  trackingPublicUrl,
  transportLabel,
} from "@/lib/compras";
import type { ImportDetail } from "@/lib/compras-server";
import { fmtDateTime } from "@/components/compras/format";

const USD = '#,##0.00';
const UNIT = '#,##0.0000';
const PCT = '0.0%';
const INT = '#,##0';

const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10_000) / 10_000;

/** Una cifra convertida: el número redondeado o, sin tipo de cambio, el aviso. */
const money2 = (n: number | null | undefined) => (n == null ? MISSING_FX : round2(n));
const money4 = (n: number | null | undefined) => (n == null ? MISSING_FX : round4(n));

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
  const local = !hasShipping(imp.kind);
  const base = baseCurrencyOf(imp.kind);
  const baseLabel = base === "PEN" ? "S/" : "USD";

  const landed = money ? landedCosts(items.map(landedItemOf), (detail.costs ?? []).map(landedCostOf), fx) : null;
  const summary = landed
    ? moneySummary(
        landed,
        items.map((it) => ({ id: it.id, salePricePen: it.sale_price_pen })),
        (detail.payments ?? []).map((p) => ({ amount: p.amount, currency: p.currency })),
      )
    : null;
  const reception = receptionSummary(
    items.map((it) => ({ id: it.id, name: it.name, qty: it.qty, courtesyQty: it.courtesy_qty, receivedQty: it.received_qty, damagedQty: it.damaged_qty })),
  );

  const wb = new ExcelJS.Workbook();
  wb.creator = "Kapta";
  wb.created = opts.now ?? new Date();

  // ── Importación ─────────────────────────────────────────────────────────
  const head = wb.addWorksheet("Importación");
  head.columns = [{ width: 34 }, { width: 60 }];
  head.addRow([`${importKindLabel(imp.kind)} ${imp.code}`]).font = { bold: true, size: 13 };
  head.addRow([]);
  const kv = (k: string, v: string | number | null | undefined, fmt?: string) => {
    const row = head.addRow([k, v ?? "—"]);
    row.getCell(1).font = { bold: true };
    if (fmt && typeof v === "number") row.getCell(2).numFmt = fmt;
  };
  kv("Tipo", local ? "Compra local (laboratorio o maquila)" : "Importación");
  kv("Estado", IMPORT_STATUS_LABEL[imp.status]);
  kv(local ? "Laboratorio o maquila" : "Proveedor", supplier?.name ?? "Sin proveedor");
  kv("Origen", imp.origin);
  kv("Destino", "Bodega de Kapta, Lima");
  if (!local) {
    kv("Transporte", transportLabel(imp.transport));
    kv("Paquetera", imp.carrier);
    kv("Guía de envío", imp.tracking_number);
    kv("Seguimiento", trackingPublicUrl({ carrier: imp.carrier, trackingNumber: imp.tracking_number, trackingUrl: imp.tracking_url }));
  }
  if (local) kv("N.º de orden", imp.platform_order);
  else {
    // Los tres códigos de trazabilidad (MOM §45.15).
    const codes = traceCodes(imp);
    kv("Códigos de trazabilidad", `${codes.filled} de 3${codes.missing.length ? ` · ${traceMissingText(codes.missing)}` : ""}`);
    kv("Código de la proforma invoice", imp.proforma_number ?? null);
    kv("Orden de Alibaba", imp.platform_order);
  }
  kv("Fecha del pedido", formatDmy(imp.ordered_on));
  kv("Llegada estimada", formatDmy(imp.eta));
  kv("Llegada", formatDmy(imp.arrived_on));
  if (!local) kv("Avisada a la bodega", imp.reported_to_warehouse_at ? fmtDateTime(imp.reported_to_warehouse_at) : "No");
  kv("Notas", imp.notes);
  head.addRow([]);
  head.addRow(["Recepción"]).font = { bold: true };
  kv("Pedidas", reception.ordered, INT);
  if (reception.courtesy) {
    kv("Cortesía", reception.courtesy, INT);
    kv("Esperadas", reception.expected, INT);
  }
  kv("Entregas", detail.deliveries.length, INT);
  kv("Llegaron", reception.received, INT);
  kv("Faltan", reception.missing, INT);
  kv("Sobran", reception.extra, INT);
  kv("Dañadas", reception.damaged, INT);
  kv("Buenas", reception.good, INT);
  kv("Productos sin contar", reception.uncounted, INT);
  if (summary && landed) {
    head.addRow([]);
    head.addRow([`Dinero (base ${baseLabel})`]).font = { bold: true };
    kv("Tipo de cambio (S/ por 1 USD)", fx ?? (local && !landed.hasUsd ? "No hace falta: todo en soles" : null), UNIT);
    if (local) kv("Costo de los productos (S/)", round2(landed.split.product.pen), USD);
    else kv("Costo de los productos (USD)", round2(landed.split.product.usd), USD);
    kv("Costos repartidos en USD", round2(landed.split.costs.usd), USD);
    kv("Costos repartidos en S/", round2(landed.split.costs.pen), USD);
    kv("Costo total (USD)", money2(summary.totalUsd), USD);
    kv("Costo total (S/)", money2(summary.totalPen), USD);
    // Sin tipo de cambio, lo que hay que convertir dice «Falta el tipo de cambio».
    kv("Costo promedio por unidad buena (USD)", summary.avgUnitUsd != null ? round4(summary.avgUnitUsd) : summary.totalUsd == null ? MISSING_FX : null, UNIT);
    if (local) kv("Costo promedio por unidad buena (S/)", summary.avgUnitPen != null ? round4(summary.avgUnitPen) : summary.totalPen == null ? MISSING_FX : null, UNIT);
    kv("Pagado en USD", round2(summary.paid.usd), USD);
    kv("Pagado en S/", round2(summary.paid.pen), USD);
    kv("Pagado (USD)", money2(summary.paidUsd), USD);
    kv("Falta pagar (USD)", money2(summary.pendingUsd), USD);
    kv("Falta pagar (S/)", money2(summary.pendingPen), USD);
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
    { header: "Cortesía", width: 10, fmt: INT },
    { header: "Esperadas", width: 10, fmt: INT },
    { header: "Peso por unidad (kg)", width: 12, fmt: UNIT },
    { header: "Recibidas", width: 10, fmt: INT },
    { header: "Dañadas", width: 10, fmt: INT },
    { header: "Buenas", width: 10, fmt: INT },
    { header: "Faltan", width: 10, fmt: INT },
    { header: "Nota de recepción", width: 28 },
  ];
  // El costo del proveedor y el desglose, en la moneda base (USD la importación, S/ la compra local).
  const moneyCols: Col[] = [
    { header: `Costo ${local ? "del laboratorio" : "proveedor"} por unidad (${baseLabel})`, width: 14, fmt: UNIT },
    { header: `Proveedor por unidad buena (${baseLabel})`, width: 14, fmt: UNIT },
    { header: `Envío por unidad buena (${baseLabel})`, width: 14, fmt: UNIT },
    { header: `Importación por unidad buena (${baseLabel})`, width: 14, fmt: UNIT },
    { header: `Adicional por unidad buena (${baseLabel})`, width: 14, fmt: UNIT },
    { header: "Costo aterrizado por unidad (USD)", width: 14, fmt: UNIT },
    { header: "Costo aterrizado por unidad (S/)", width: 14, fmt: USD },
    { header: "Precio de venta (S/)", width: 12, fmt: USD },
    { header: "Margen por unidad (S/)", width: 12, fmt: USD },
    { header: "Margen %", width: 10, fmt: PCT },
    { header: `Costo total de la línea (${baseLabel})`, width: 14, fmt: USD },
    { header: "Pasó a Costos", width: 18 },
  ];
  const products = sheetWithColumns(wb, "Productos", money ? [...baseCols, ...moneyCols] : baseCols);
  items.forEach((it, i) => {
    const counted = it.received_qty != null;
    const progress = lineProgress({ qty: it.qty, courtesyQty: it.courtesy_qty, receivedQty: it.received_qty, damagedQty: it.damaged_qty });
    const row: (string | number | null)[] = [
      i + 1,
      it.name,
      it.sku ?? "",
      it.store_id ? (opts.storeNames.get(it.store_id) ?? "") : "General",
      it.qty,
      it.courtesy_qty ?? 0,
      expectedUnits({ qty: it.qty, courtesyQty: it.courtesy_qty }),
      it.unit_weight_kg,
      counted ? it.received_qty : null,
      counted ? (it.damaged_qty ?? 0) : null,
      goodUnits({ qty: it.qty, courtesyQty: it.courtesy_qty, receivedQty: it.received_qty, damagedQty: it.damaged_qty }),
      counted ? progress.missing : null,
      it.reception_note ?? "",
    ];
    if (!money || !landed) {
      products.addRow(row);
      return;
    }
    const line = landed.byItem.get(it.id)!;
    const m = marginOf(line.pen?.unitCost, it.sale_price_pen, line.good);
    // El desglose en la moneda base; la columna «(USD)» y «(S/)» siguen abajo.
    const u = local ? line.pen : line.usd;
    products.addRow([
      ...row,
      round4(itemUnitCost({ unitCostUsd: it.unit_cost_usd ?? 0, unitCostPen: it.unit_cost_pen ?? null, unitCostCurrency: it.unit_cost_currency }).amount),
      money4(u?.perUnit.product),
      money4(u?.perUnit.envio),
      money4(u?.perUnit.importacion),
      money4(u?.perUnit.adicional),
      money4(line.usd?.unitCost),
      money2(line.pen?.unitCost),
      it.sale_price_pen ?? null,
      m ? round2(m.unit) : null,
      m ? Math.round(m.pct * 1000) / 1000 : null,
      money2(u?.total),
      it.cost_pushed_at ? fmtDateTime(it.cost_pushed_at) : "",
    ]);
  });

  // ── Entregas (MOM §45.14): una fila por producto de cada entrega ────────
  const itemNames = new Map(items.map((it) => [it.id, it.name]));
  const deliveries = sheetWithColumns(wb, "Entregas", [
    { header: "Fecha", width: 12 },
    { header: "Registró", width: 22 },
    { header: "Producto", width: 34 },
    { header: "Llegaron", width: 10, fmt: INT },
    { header: "Dañadas", width: 10, fmt: INT },
    { header: "Nota del producto", width: 28 },
    { header: "Nota de la entrega", width: 34 },
    { header: "Fotos", width: 8, fmt: INT },
  ]);
  for (const d of detail.deliveries) {
    for (const l of d.lines) {
      deliveries.addRow([
        formatDmy(d.delivered_on),
        d.legacy ? "Recepción anterior" : (d.by_name ?? ""),
        itemNames.get(l.item_id) ?? "",
        l.received,
        l.damaged,
        l.note ?? "",
        d.note ?? "",
        d.photos.length,
      ]);
    }
  }

  if (!money || !landed || !summary) return Buffer.from(await wb.xlsx.writeBuffer());

  // ── Costos ──────────────────────────────────────────────────────────────
  const itemName = new Map(items.map((it) => [it.id, it.name]));
  const costs = sheetWithColumns(wb, "Costos", [
    { header: "Tipo", width: 14 },
    { header: "Nombre", width: 30 },
    { header: "Reparto", width: 20 },
    { header: "Producto", width: 30 },
    { header: "Moneda", width: 8 },
    { header: "Monto (sin IGV)", width: 14, fmt: USD },
    { header: "Incluye IGV", width: 11 },
    { header: "IGV", width: 18 },
    { header: "Monto con IGV", width: 14, fmt: USD },
    { header: "Detalle", width: 40 },
    { header: "En USD", width: 14, fmt: USD },
    { header: "En S/", width: 14, fmt: USD },
  ]);
  for (const c of detail.costs ?? []) {
    const amount = moneyOf(c.amount, c.currency);
    costs.addRow([
      costKindLabel(c.kind),
      c.label,
      allocationLabel(c.allocation),
      c.allocation === "item" ? (c.item_id ? (itemName.get(c.item_id) ?? "") : "(producto quitado)") : "",
      currencySymbol(c.currency),
      round2(c.amount),
      c.includes_igv ? "Sí" : "No",
      // El tratamiento (0343): sin IGV (monto neto), incluye IGV 18 % o inafecto a IGV.
      IGV_TREATMENTS.find((t) => t.id === c.igv_treatment)?.label ?? "",
      c.includes_igv && c.gross_amount != null ? round2(c.gross_amount) : null,
      costAmountText(c),
      money2(moneyInUsd(amount, fx)),
      money2(moneyInPen(amount, fx)),
    ]);
  }
  costs.addRow(["Total en USD", "", "", "", "US$", round2(landed.split.costs.usd)]).font = { bold: true };
  costs.addRow(["Total en S/", "", "", "", "S/", round2(landed.split.costs.pen)]).font = { bold: true };
  costs.addRow(["Total convertido", "", "", "", "", "", "", "", "", "", money2(landed.usd?.costsTotal), money2(landed.pen?.costsTotal)]).font = { bold: true };
  if (landed.warnings.length) {
    costs.addRow([]);
    costs.addRow(["Notas del cálculo"]).font = { bold: true };
    for (const w of landed.warnings) costs.addRow([w]);
  }

  // ── Pagos ───────────────────────────────────────────────────────────────
  const pays = sheetWithColumns(wb, "Pagos", [
    { header: "Fecha", width: 12 },
    { header: "Método", width: 16 },
    { header: "Moneda", width: 8 },
    { header: "Monto", width: 14, fmt: USD },
    { header: "En USD", width: 14, fmt: USD },
    { header: "En S/", width: 14, fmt: USD },
    { header: "Nota", width: 40 },
    { header: "Comprobante", width: 30 },
  ]);
  const docName = new Map(detail.documents.map((d) => [d.id, d.filename ?? "Comprobante"]));
  for (const p of detail.payments ?? []) {
    const amount = moneyOf(p.amount, p.currency);
    pays.addRow([
      formatDmy(p.paid_on),
      paymentMethodLabel(p.method),
      currencySymbol(p.currency),
      round2(p.amount),
      money2(moneyInUsd(amount, fx)),
      money2(moneyInPen(amount, fx)),
      p.note ?? "",
      p.document_id ? (docName.get(p.document_id) ?? "Sí") : "",
    ]);
  }
  pays.addRow(["Pagado en USD", "", "US$", round2(summary.paid.usd)]).font = { bold: true };
  pays.addRow(["Pagado en S/", "", "S/", round2(summary.paid.pen)]).font = { bold: true };
  pays.addRow(["Pagado", "", "", "", money2(summary.paidUsd), money2(summary.paidPen)]).font = { bold: true };
  pays.addRow(["Falta pagar", "", "", "", money2(summary.pendingUsd), money2(summary.pendingPen)]).font = { bold: true };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
