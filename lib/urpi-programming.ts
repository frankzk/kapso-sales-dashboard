/** Programación enviada a Urpi. No es un reporte de entrega ni una salida. */
export interface UrpiTab {
  title: string;
  sheetId: number | null;
  values: readonly (readonly unknown[])[];
}

export interface UrpiProgrammingRow {
  key: string;
  tab: string;
  sheetId: number | null;
  rowNumber: number;
  date: string;
  dateWritten: string;
  orderCode: string;
  customer: string;
  phone: string;
  shift: string;
  province: string;
  district: string;
  address: string;
  reference: string;
  products: string;
  amount: number | null;
  notes: string;
  issues: string[];
  orderId: string | null;
}

export interface UrpiProgrammingData {
  rows: UrpiProgrammingRow[];
  tabs: { title: string; sheetId: number | null; count: number }[];
  unassigned: { tab: string; rowNumber: number }[];
}

export const URPI_SOURCE_EXAMPLES = [
  { month: "2026-10", title: "Octubre 2026", spreadsheetId: "13v6LVlETx17NWAN1jgWJzCHxR-7GoWOHk3llf2RzAgc" },
  { month: "2026-09", title: "Setiembre 2026", spreadsheetId: "1KDd2AwPqBXdV7JIAF3ebPOljI23w6h9trua9fEaqlWA" },
] as const;

export function sheetUrl(id: string, sheetId?: number | null): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit${sheetId != null ? `#gid=${sheetId}` : ""}`;
}

export function spreadsheetIdFromUrl(value: string): string {
  const url = new URL(value.trim());
  const match = /^\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,100})(?:\/|$)/.exec(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com" || url.username || url.password || url.port || !match) {
    throw new Error("Introduce un enlace válido de Google Sheets.");
  }
  return match[1]!;
}

export function validMonth(value: string): boolean {
  return /^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
}

export function urpiDateIso(value: unknown): string | null {
  const text = String(value ?? "").trim();
  let parts: string[] | null = null;
  const iso = /^(20\d{2})-(\d{2})-(\d{2})(?:T.*)?$/.exec(text);
  const local = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|20\d{2})$/.exec(text);
  if (iso) parts = [iso[1]!, iso[2]!, iso[3]!];
  else if (local) parts = [local[3]!.length === 2 ? `20${local[3]}` : local[3]!, local[2]!.padStart(2, "0"), local[1]!.padStart(2, "0")];
  if (!parts) return null;
  const result = parts.join("-");
  const date = new Date(`${result}T12:00:00Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === result ? result : null;
}

/** Regla confirmada por operación: día siguiente, saltando únicamente domingo.
 * La entrada es la FECHA DEL REPORTE, nunca la fecha en que se importa. */
export function nextUrpiDeliveryDate(reportDate: string): string {
  const iso = urpiDateIso(reportDate);
  if (!iso) throw new Error("La reprogramación requiere una fecha de reporte válida.");
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  if (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function normalizeUrpiOrder(value: unknown): string {
  return String(value ?? "").trim().replace(/^#\s*/, "").replace(/\s+/g, "").toUpperCase();
}

const clean = (v: unknown) => String(v ?? "").trim();
const header = (v: unknown) => clean(v).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ");

function amountOf(value: unknown): number | null {
  const raw = clean(value);
  if (!raw) return null;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw)) return null;
  const valueNumber = Number(raw.replace(/,/g, ""));
  return Number.isFinite(valueNumber) ? valueNumber : null;
}

export function parseUrpiProgramming(tabs: readonly UrpiTab[], month: string, prefix: string): UrpiProgrammingData {
  if (!validMonth(month)) throw new Error("El mes debe tener formato AAAA-MM.");
  if (!/^[A-Z]{1,12}$/.test(prefix)) throw new Error("Indica el prefijo de pedidos de la tienda, por ejemplo KP o AUR.");
  const result: UrpiProgrammingData = { rows: [], tabs: [], unassigned: [] };
  const seen = new Map<string, UrpiProgrammingRow>();
  const relevant = tabs.filter((tab) => urpiDateIso(tab.title)?.startsWith(month));
  if (!relevant.length) throw new Error("El archivo no contiene pestañas de fechas del mes seleccionado.");
  for (const tab of relevant) {
    const tabDate = urpiDateIso(tab.title)!;
    const headerIndex = tab.values.slice(0, 15).findIndex((row) => row.some((v) => header(v) === "codigo de pedido"));
    if (headerIndex < 0) throw new Error(`No se reconoce la cabecera de la pestaña ${tab.title}. No se importó el archivo.`);
    const names = tab.values[headerIndex]!.map(header);
    const required = ["fecha de entrega", "tipo de envio", "codigo de pedido", "destinatario", "numero de contacto", "provincia", "distrito", "direccion", "producto a entregar", "monto a cobrar"];
    if (required.some((name) => !names.includes(name))) throw new Error(`Faltan columnas en ${tab.title}. Revisa el formato de Urpi.`);
    const get = (row: readonly unknown[], name: string) => row[names.indexOf(name)];
    let count = 0;
    for (let i = headerIndex + 1; i < tab.values.length; i++) {
      const row = tab.values[i] ?? [];
      const orderCode = normalizeUrpiOrder(get(row, "codigo de pedido"));
      if (!orderCode) {
        if (clean(get(row, "destinatario"))) result.unassigned.push({ tab: tab.title, rowNumber: i + 1 });
        continue;
      }
      // Un archivo puede mezclar tiendas. Cada fuente importa únicamente su prefijo.
      if (!orderCode.startsWith(prefix)) continue;
      if (!/^\d+$/.test(orderCode.slice(prefix.length))) throw new Error(`Código de pedido inválido en ${tab.title}, fila ${i + 1}. Revisa el código antes de importar.`);
      const issues: string[] = [];
      const dateText = clean(get(row, "fecha de entrega"));
      const dateValue = urpiDateIso(dateText);
      const date = dateValue ?? tabDate;
      if (!dateValue) issues.push(dateText ? "Fecha de celda inválida; se muestra la fecha de pestaña" : "Fecha tomada de la pestaña");
      if (dateValue && dateValue !== tabDate) issues.push("La fecha de entrega difiere de la pestaña");
      const amount = amountOf(get(row, "monto a cobrar"));
      if (amount === null) issues.push("Monto vacío o inválido");
      const key = `${tab.title}:${i + 1}`;
      const parsed: UrpiProgrammingRow = {
        key, tab: tab.title, sheetId: tab.sheetId, rowNumber: i + 1, date, dateWritten: dateText, orderCode,
        customer: clean(get(row, "destinatario")), phone: clean(get(row, "numero de contacto")),
        shift: clean(get(row, "tipo de envio")), province: clean(get(row, "provincia")), district: clean(get(row, "distrito")),
        address: clean(get(row, "direccion")), reference: clean(get(row, "referencia")), products: clean(get(row, "producto a entregar")),
        amount, notes: clean(get(row, "observaciones")), issues, orderId: null,
      };
      const identity = `${date}:${orderCode}`;
      const prior = seen.get(identity);
      if (prior) {
        if (!prior.issues.includes("Pedido repetido en la misma fecha")) prior.issues.push("Pedido repetido en la misma fecha");
        issues.push("Pedido repetido en la misma fecha");
      }
      seen.set(identity, parsed);
      result.rows.push(parsed);
      if (result.rows.length > 10000) throw new Error("El mes supera 10 000 filas. Divide el archivo antes de importarlo.");
      count++;
    }
    result.tabs.push({ title: tab.title, sheetId: tab.sheetId, count });
  }
  return result;
}
