// Lectura de la hoja diaria del motorizado sin app (MOM §29.7, 08-10-2026).
//
// Alexis manda su hoja del día como una o varias capturas de una tabla de
// Excel: ITEM · PROVEEDOR · CLIENTE · DISTRITO · F. PAGO · RECAUDADO ·
// GANANCIA MOT. · UTILIDAD · OBSERVACIÓN (el pedido), con la fecha arriba y el
// TOTAL COBRADO abajo. Este módulo se las da a Claude en UNA llamada —las
// capturas son trozos de la misma hoja— y devuelve las filas para cruzarlas con
// la ruta (lib/notebook-import.ts).
//
// Mismas tres reglas que lib/settlement-vision.ts: nunca lanza, no inventa (lo
// ilegible es null) y lo que devuelve es una propuesta que una persona revisa.

import { normalizeMediaType } from "@/lib/vision";
import type { NotebookLine } from "@/lib/notebook-import";

const ANTHROPIC_VERSION = "2023-06-01";
// Una hoja de Alexis llega a 50 filas en tres capturas. 105 s deja margen
// dentro de los 120 s de la función de Vercel, como la liquidación por foto.
const REQUEST_TIMEOUT_MS = 105_000;
// El techo sin streaming. Lo que más gasta no es la hoja (40 filas compactas
// son ~2.000 tokens): es el razonamiento. claude-sonnet-5 piensa por defecto
// con esfuerzo alto, y el 08/10 la primera hoja real de Alexis (40 filas, una
// captura) se quedó sin salida a los 12.000 tokens. Transcribir no necesita
// pensar: se pide esfuerzo bajo y filas como arreglos.
const MAX_TOKENS = 16_000;
const EFFORT = "low";

export interface RiderSheetImage {
  base64: string;
  contentType: string | null | undefined;
}

export interface RiderSheet {
  /** Fecha de la cabecera (YYYY-MM-DD), tal cual; puede estar mal escrita. */
  date: string | null;
  riderName: string | null;
  lines: NotebookLine[];
  /** TOTAL COBRADO y TOTAL GANANCIA de la hoja, si los trae. */
  totals: { amount: number | null; fee: number | null };
}

export interface RiderSheetVisionResult extends RiderSheet {
  /** false ante cualquier fallo: no es «la hoja no tenía filas». */
  ok: boolean;
  /** La salida se cortó: `lines` trae solo las filas completas hasta ahí. */
  truncated?: boolean;
  model: string;
  failure?: "missing_credentials" | "api_error" | "timeout" | "invalid_response";
  detail?: string;
}

export interface RiderSheetVisionOpts {
  apiKey: string;
  model: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

const SYSTEM_PROMPT =
  "Transcribes la hoja diaria de un motorizado de reparto en Lima, Perú. La " +
  "hoja es una tabla (normalmente capturas de Excel) con una fila por pedido " +
  "que llevó ese día. Puedes recibir varias capturas: son partes de la MISMA " +
  "hoja, a veces con filas repetidas en el borde entre una y otra.\n\n" +
  "Tu única tarea es TRANSCRIBIR. No corrijas, no completes y no deduzcas. Lo " +
  "que esté tachado, borroso, cortado sin remedio o vacío va como null: una " +
  "celda vacía la completa una persona en segundos, un dato inventado se " +
  "convierte en plata inventada en la liquidación del motorizado.";

function buildPrompt(images: number): string {
  return (
    `Recibes ${images === 1 ? "una captura" : `${images} capturas`} de la hoja. ` +
    "Devuelve SOLO un JSON, sin texto antes ni después, con esta forma exacta:\n" +
    "{\n" +
    '  "date": string|null,          // fecha de la cabecera en formato YYYY-MM-DD, tal cual esté escrita\n' +
    '  "rider_name": string|null,    // nombre del motorizado si aparece\n' +
    '  "total_amount": number|null,  // TOTAL COBRADO / TOTAL RECAUDADO de la hoja, si aparece\n' +
    '  "total_fee": number|null,     // total de GANANCIA MOT., si aparece\n' +
    '  "rows": [ [item, store, customer, district, written, amount, fee, order, notes], ... ]\n' +
    "}\n\n" +
    "Cada fila de `rows` es un arreglo de 9 valores, en este orden:\n" +
    "  item      número|null  ITEM\n" +
    "  store     texto|null   PROVEEDOR (AURELA, KENKU…)\n" +
    "  customer  texto|null   CLIENTE: la persona\n" +
    "  district  texto|null   DISTRITO\n" +
    "  written   texto|null   F. PAGO tal cual: EFECTIVO, PAGO POS, SOLO ENTREGA, YAPE PROV, CAIDA, COBRO CAIDA, NO CONTESTO, REPRO, MIERCOLES…\n" +
    "  amount    número|null  RECAUDADO de esa fila (S/.0.00 es 0)\n" +
    "  fee       número|null  GANANCIA MOT. de esa fila\n" +
    "  order     texto|null   código del pedido en OBSERVACIÓN: #KP138029, #AUR177790\n" +
    "  notes     texto|null   el resto de la OBSERVACIÓN, si dice algo más\n" +
    'Ejemplo de fila: [5, "AURELA", "Dotty Pinedo", "Mariscal", "EFECTIVO", 189, 12, "#KP138910", null]\n\n' +
    "Reglas:\n" +
    "- Una fila por ITEM, en el orden de la hoja. Ignora encabezados y filas de TOTAL.\n" +
    "- Si un ITEM aparece en dos capturas, transcríbelo una sola vez.\n" +
    "- El código del pedido se copia carácter por carácter (#KP + 6 dígitos o #AUR + 6 dígitos). " +
    "Si no lo lees con seguridad o la celda dice «No especificado», `order` es null: un pedido " +
    "equivocado es peor que ninguno.\n" +
    "- Si F. PAGO está cortada por el ancho de la celda («OLO ENTREGA», «YAPE PROV»), copia lo visible.\n" +
    "- Los montos son números sin «S/.»: S/.189.00 es 189, S/.0.00 es 0. Celda vacía es null.\n" +
    "- La columna UTILIDAD se ignora.\n" +
    "- Si la imagen no es una hoja de reparto, devuelve `rows` vacío.\n" +
    "- No expliques nada: solo el JSON."
  );
}

function extractText(json: unknown): string {
  const content = (json as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => (b as { type?: string })?.type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("\n");
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.toLowerCase() !== "null" ? t : null;
}

/** Igual que en la liquidación por foto: sin un dígito no hay número (null ≠ 0). */
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = str(v);
  if (!s) return null;
  let cleaned = s.replace(/[^\d.,-]/g, "").replace(/^\.+/, "");
  // «3,575.10» lleva coma de miles; «89,50», coma decimal.
  cleaned = cleaned.includes(".") || /,\d{3}$/.test(cleaned) ? cleaned.replace(/,/g, "") : cleaned.replace(",", ".");
  if (!/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function day(v: unknown): string | null {
  const s = str(v);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return Number.isFinite(Date.parse(`${s}T00:00:00.000Z`)) ? s : null;
}

const ROW_KEYS = ["item", "store", "customer", "district", "written", "amount", "fee", "order", "notes"] as const;

/** Una fila como arreglo de 9 valores (el formato pedido) o como objeto. */
function rowObject(raw: unknown): Record<string, unknown> | null {
  if (Array.isArray(raw)) return Object.fromEntries(ROW_KEYS.map((k, i) => [k, raw[i] ?? null]));
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

/**
 * Las filas completas de una respuesta cortada: cada `[...]` cerrado dentro de
 * `"rows": [`. Lo que quedó a medias se descarta; nunca se completa.
 */
function salvageRows(text: string): unknown[] {
  const at = text.search(/"rows"\s*:\s*\[/);
  if (at < 0) return [];
  const rows: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  for (let i = text.indexOf("[", at) + 1; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "]") {
      if (depth === 0) break;
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          rows.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // Fila ilegible: fuera.
        }
        start = -1;
      }
    }
  }
  return rows;
}

/** Un campo suelto de la cabecera de una respuesta cortada. */
function headField(text: string, key: string): unknown {
  const m = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|-?[\\d.]+|null)`).exec(text);
  if (!m || m[1] === "null") return null;
  try {
    return JSON.parse(m[1]!);
  } catch {
    return null;
  }
}

/**
 * Convierte la respuesta del modelo en filas. Aparte de la red, para probarla.
 * Con `allowTruncated`, una respuesta cortada devuelve sus filas completas.
 */
export function parseRiderSheet(text: string, allowTruncated = false): RiderSheet | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let obj: unknown = null;
  if (start >= 0 && end > start) {
    try {
      obj = JSON.parse(text.slice(start, end + 1));
    } catch {
      obj = null;
    }
  }
  if (!obj && allowTruncated) {
    const rows = salvageRows(text);
    if (!rows.length) return null;
    obj = {
      date: headField(text, "date"),
      rider_name: headField(text, "rider_name"),
      total_amount: headField(text, "total_amount"),
      total_fee: headField(text, "total_fee"),
      rows,
    };
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const lines: NotebookLine[] = [];
  const seen = new Set<string>();
  const rawRows = Array.isArray(o.rows) ? o.rows : Array.isArray(o.lines) ? o.lines : [];
  for (const raw of rawRows) {
    const l = rowObject(raw);
    if (!l) continue;
    const item = num(l.item);
    const line: NotebookLine = {
      item: item !== null && Number.isInteger(item) ? item : null,
      store: str(l.store),
      customer: str(l.customer),
      district: str(l.district),
      written: str(l.written),
      amount: num(l.amount),
      fee: num(l.fee),
      order: str(l.order),
      notes: str(l.notes),
    };
    if (!line.customer && !line.order && !line.written && line.amount === null) continue;
    // La misma fila en el borde de dos capturas cuenta una vez.
    const key = [line.item, line.order, line.customer, line.written, line.amount].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return {
    date: day(o.date),
    riderName: str(o.rider_name),
    lines,
    totals: { amount: num(o.total_amount), fee: num(o.total_fee) },
  };
}

/**
 * Lee la hoja de una o varias capturas en una sola llamada. Nunca lanza: ante
 * cualquier fallo devuelve cero filas con `ok:false`, que quien llama debe
 * distinguir de una hoja vacía.
 */
export async function readRiderSheet(images: readonly RiderSheetImage[], opts: RiderSheetVisionOpts): Promise<RiderSheetVisionResult> {
  const model = opts.model;
  const empty: RiderSheetVisionResult = { date: null, riderName: null, lines: [], totals: { amount: null, fee: null }, ok: false, model };
  if (!opts.apiKey || images.length === 0) {
    return { ...empty, failure: "missing_credentials", detail: "Falta la foto o la clave de visión." };
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const base = (opts.apiBase ?? "https://api.anthropic.com").replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const send = (withEffort: boolean) =>
    doFetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        ...(withEffort ? { output_config: { effort: EFFORT } } : {}),
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              ...images.map((img) => ({
                type: "image",
                source: { type: "base64", media_type: normalizeMediaType(img.contentType), data: img.base64 },
              })),
              { type: "text", text: buildPrompt(images.length) },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
  try {
    let res = await send(true);
    // Un modelo configurado que no acepte el esfuerzo: se repite sin él.
    if (res.status === 400) {
      const body = await res.clone().text().catch(() => "");
      if (/effort|output_config/i.test(body)) res = await send(false);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let detail = `Anthropic respondió HTTP ${res.status}.`;
      try {
        const error = (JSON.parse(body) as { error?: { type?: string; message?: string } }).error;
        if (error?.message) detail = `${error.type ?? "api_error"}: ${error.message}`;
      } catch {
        // El status basta.
      }
      return { ...empty, failure: "api_error", detail };
    }
    const json = await res.json();
    const stopReason = (json as { stop_reason?: string })?.stop_reason;
    const cut = stopReason === "max_tokens";
    const parsed = parseRiderSheet(extractText(json), cut);
    if (!parsed || (cut && !parsed.lines.length)) {
      return {
        ...empty,
        failure: "invalid_response",
        detail: cut
          ? "La lectura quedó cortada antes de la primera fila: recorta la foto en dos partes y súbelas por separado."
          : stopReason === "refusal"
            ? "El modelo no quiso leer esa imagen."
            : "El modelo no devolvió la hoja en el formato esperado.",
      };
    }
    return { ...parsed, ok: true, model, ...(cut ? { truncated: true } : {}) };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return {
      ...empty,
      failure: timedOut ? "timeout" : "api_error",
      detail: timedOut ? "La lectura excedió 105 segundos." : "La llamada de visión falló.",
    };
  } finally {
    clearTimeout(timer);
  }
}
