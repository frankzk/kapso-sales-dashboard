import ExcelJS from "exceljs";
import type { OrderLineItem } from "./types";

export interface FenixProgrammingShipment {
  id: string;
  order_id: string | null;
  order_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  product: string | null;
  city: string | null;
  district: string | null;
  delivery_address: string | null;
  delivery_reference: string | null;
  latitude: number | null;
  longitude: number | null;
  next_followup_at: string | null;
}

export interface FenixProgrammingOrder {
  id: string;
  name: string | null;
  total_amount: number | null;
  line_items: OrderLineItem[] | null;
  raw: unknown;
}

export interface FenixProgrammingRow {
  shipmentId: string;
  shippingDate: Date;
  orderName: string;
  product: string;
  quantity: number | null;
  amount: number | null;
  customerName: string;
  phone: string;
  province: string;
  district: string;
  address: string;
  reference: string;
  notes: string;
  latitude: number | null;
  longitude: number | null;
  gpsUrl: string | null;
}

const HEADERS = [
  "FECHA ENVÍO",
  "#PEDIDO",
  "PRODUCTO",
  "CANTIDAD",
  "COBRAR",
  "NOMBRE",
  "TELÉFONO",
  "PROVINCIA",
  "DISTRITO",
  "DIRECCIÓN",
  "REFERENCIA",
  "NOTAS",
  "UBICACIÓN GPS",
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function shopifyShippingAddress(raw: unknown): Record<string, unknown> {
  const source = asRecord(raw);
  return asRecord(source.shipping_address ?? source.shippingAddress);
}

export function extractShopifyOrderNote(raw: unknown): string {
  const source = asRecord(raw);
  return text(source.note ?? source.note2);
}

function titleCase(value: string | null): string {
  return (value ?? "")
    .trim()
    .toLocaleLowerCase("es")
    .replace(/(^|[\s/-])\p{L}/gu, (letter) => letter.toLocaleUpperCase("es"));
}

function uniqueNotes(...notes: (string | null | undefined)[]): string {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const note of notes) {
    const clean = note?.trim();
    if (!clean || seen.has(clean.toLocaleLowerCase("es"))) continue;
    seen.add(clean.toLocaleLowerCase("es"));
    result.push(clean);
  }
  return result.join(" | ");
}

function productSummary(items: OrderLineItem[] | null | undefined, fallback: string | null): {
  product: string;
  quantity: number | null;
} {
  const valid = (items ?? []).filter((item) => item?.title?.trim());
  if (!valid.length) return { product: fallback?.trim() ?? "", quantity: null };
  return {
    product: valid.map((item) => item.title.trim()).join(" | "),
    quantity: valid.reduce((sum, item) => sum + Math.max(0, Number(item.quantity) || 0), 0),
  };
}

/** Convert authorized shipment/order snapshots into the exact Fenix sheet rows. */
export function buildFenixProgrammingRows(
  shipments: FenixProgrammingShipment[],
  ordersById: Map<string, FenixProgrammingOrder>,
  latestNoteByShipment: Map<string, string> = new Map(),
): FenixProgrammingRow[] {
  const rows: FenixProgrammingRow[] = [];
  for (const shipment of shipments) {
    if (!shipment.next_followup_at) continue;
    const shippingDate = new Date(shipment.next_followup_at);
    if (Number.isNaN(shippingDate.getTime())) continue;
    const order = shipment.order_id ? ordersById.get(shipment.order_id) : undefined;
    const raw = order?.raw;
    const address = shopifyShippingAddress(raw);
    const products = productSummary(order?.line_items, shipment.product);
    const latitude = shipment.latitude == null ? null : Number(shipment.latitude);
    const longitude = shipment.longitude == null ? null : Number(shipment.longitude);
    const hasGps = Number.isFinite(latitude) && Number.isFinite(longitude);
    rows.push({
      shipmentId: shipment.id,
      shippingDate,
      orderName: shipment.order_name || order?.name || "",
      product: products.product,
      quantity: products.quantity,
      amount: order?.total_amount == null ? null : Number(order.total_amount),
      customerName: shipment.customer_name || text(address.name),
      phone: shipment.customer_phone || text(address.phone),
      province: titleCase(shipment.city || text(address.city) || text(address.province)),
      district: shipment.district || text(address.city),
      address: shipment.delivery_address || text(address.address1),
      reference: shipment.delivery_reference || text(address.address2),
      notes: uniqueNotes(extractShopifyOrderNote(raw), latestNoteByShipment.get(shipment.id)),
      latitude: hasGps ? latitude : null,
      longitude: hasGps ? longitude : null,
      gpsUrl: hasGps ? `https://www.google.com/maps?q=${latitude},${longitude}` : null,
    });
  }
  return rows;
}

/** Production workbook writer. ExcelJS is already the dashboard's deployed
 * XLSX runtime (also used by the Aliclik importer), keeping Vercel packaging
 * deterministic while generating a standards-compliant workbook. */
export async function createFenixProgrammingWorkbook(rows: FenixProgrammingRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Kapta";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("PEDIDOS", {
    views: [{ state: "frozen", ySplit: 1, showGridLines: false }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1 },
  });

  sheet.columns = [
    { key: "shippingDate", width: 14 },
    { key: "orderName", width: 23 },
    { key: "product", width: 46 },
    { key: "quantity", width: 11 },
    { key: "amount", width: 13 },
    { key: "customerName", width: 28 },
    { key: "phone", width: 17 },
    { key: "province", width: 18 },
    { key: "district", width: 20 },
    { key: "address", width: 42 },
    { key: "reference", width: 30 },
    { key: "notes", width: 40 },
    { key: "gps", width: 29 },
  ];

  const header = sheet.addRow([...HEADERS]);
  header.height = 25;
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF08112F" } };
    cell.font = { name: "Aptos", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = { bottom: { style: "medium", color: { argb: "FF1D4ED8" } } };
  });

  for (const item of rows) {
    const row = sheet.addRow([
      item.shippingDate,
      item.orderName,
      item.product,
      item.quantity,
      item.amount,
      item.customerName,
      item.phone,
      item.province,
      item.district,
      item.address,
      item.reference,
      item.notes,
      item.gpsUrl ? { text: `${item.latitude}, ${item.longitude}`, hyperlink: item.gpsUrl } : "",
    ]);
    row.height = 34;
    row.eachCell((cell, column) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDF3E8" } };
      cell.font = { name: "Aptos", size: 10, color: { argb: "FF172033" } };
      cell.alignment = {
        vertical: "middle",
        horizontal: column === 4 || column === 5 ? "right" : "left",
        wrapText: column === 3 || column >= 10,
      };
      cell.border = { bottom: { style: "hair", color: { argb: "FFB7D8C8" } } };
    });
    row.getCell(1).numFmt = "dd/mm/yyyy";
    row.getCell(2).numFmt = "@";
    row.getCell(4).numFmt = "0";
    row.getCell(5).numFmt = '"S/ "#,##0.00';
    row.getCell(7).numFmt = "@";
    if (item.gpsUrl) {
      row.getCell(13).font = { name: "Aptos", size: 10, color: { argb: "FF1155CC" }, underline: true };
    }
  }

  sheet.autoFilter = { from: "A1", to: `M${Math.max(1, rows.length + 1)}` };
  const bytes = await workbook.xlsx.writeBuffer();
  return Buffer.from(bytes);
}
