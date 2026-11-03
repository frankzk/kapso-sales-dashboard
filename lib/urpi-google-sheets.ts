// Server-only. Read-only service account; never uses the user's browser session.
import { createSign } from "node:crypto";
import { urpiDateIso, type UrpiTab } from "./urpi-programming";

export function urpiGoogleConfigured(): boolean {
  return Boolean(process.env.URPI_GOOGLE_CLIENT_EMAIL && process.env.URPI_GOOGLE_PRIVATE_KEY);
}

/**
 * La clave privada tal como se pegó en Vercel. Vercel guarda lo que se pega: con
 * comillas, con `\n` escritos (uno o dos), con saltos reales, con `\r` de
 * Windows, en una sola línea con espacios, o el JSON entero de la cuenta de
 * servicio. Node solo lee el PEM limpio: con la clave pegada de otra forma la
 * primera lectura falló con «error:1E08010C:DECODER routines::unsupported»
 * (03-11-2026). Así que se reconstruye: cabecera, cuerpo base64 en líneas de 64
 * y pie. Lo que no parece una clave privada se rechaza con un mensaje que dice
 * qué copiar. PURA.
 */
export function urpiGooglePrivateKey(raw: string): string {
  let value = raw.trim();
  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as { private_key?: unknown };
      if (typeof parsed.private_key === "string") value = parsed.private_key;
    } catch { /* no era el JSON: se sigue con el texto */ }
  }
  value = value.replace(/^["'\s]+|["',\s]+$/g, "").replace(/\\+r/g, "").replace(/\\+n/g, "\n").replace(/\r/g, "");
  const match = value.match(/-----BEGIN ((?:RSA )?PRIVATE KEY)-----([\s\S]*?)-----END \1-----/);
  if (!match) {
    throw new Error("URPI_GOOGLE_PRIVATE_KEY no es una clave privada. Copia el valor de «private_key» del JSON de la cuenta de servicio, desde -----BEGIN PRIVATE KEY----- hasta -----END PRIVATE KEY-----.");
  }
  const lines = match[2]!.replace(/[^A-Za-z0-9+/=]/g, "").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${match[1]}-----\n${lines.join("\n")}\n-----END ${match[1]}-----\n`;
}

/** El correo de la cuenta de servicio, sin comillas ni espacios; también si se
 *  pegó el JSON entero. PURA. */
export function urpiGoogleClientEmail(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as { client_email?: unknown };
      if (typeof parsed.client_email === "string") return parsed.client_email.trim();
    } catch { /* no era el JSON */ }
  }
  return value.replace(/^["'\s]+|["',\s]+$/g, "");
}

async function googleToken(signal: AbortSignal): Promise<string> {
  if (!urpiGoogleConfigured()) throw new Error("La lectura de Google todavía no está conectada. Puedes cargar el Excel descargado del mismo Sheet.");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const assertion = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: urpiGoogleClientEmail(process.env.URPI_GOOGLE_CLIENT_EMAIL!),
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })}`;
  const key = urpiGooglePrivateKey(process.env.URPI_GOOGLE_PRIVATE_KEY!);
  let signature: string;
  try {
    signature = createSign("RSA-SHA256").update(assertion).sign(key, "base64url");
  } catch {
    throw new Error("No se pudo leer URPI_GOOGLE_PRIVATE_KEY. Vuelve a copiar el valor de «private_key» del JSON de la cuenta de servicio, completo y sin cortar.");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${assertion}.${signature}` }),
  });
  if (!res.ok) throw new Error("No se pudo autenticar la conexión de Google. Revisa sus credenciales.");
  const body = await res.json() as { access_token?: string };
  if (!body.access_token) throw new Error("Google no devolvió acceso de lectura.");
  return body.access_token;
}

async function readGoogle(url: string, token: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
  if (res.status === 403 || res.status === 404) throw new Error("La conexión no puede leer este Sheet. Comparte el archivo como lector con la cuenta de integración y comprueba que Sheets API esté habilitada.");
  if (!res.ok) throw new Error(`Google Sheets no respondió correctamente (${res.status}). Conservamos la última lectura.`);
  return res.json();
}

export async function readUrpiGoogleWorkbook(spreadsheetId: string, month: string): Promise<{ title: string; tabs: UrpiTab[] }> {
  if (!/^[a-zA-Z0-9_-]{20,100}$/.test(spreadsheetId)) throw new Error("Identificador de Sheet inválido.");
  const signal = AbortSignal.timeout(60000);
  const token = await googleToken(signal);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  const metadata = await readGoogle(`${base}?fields=properties(title),sheets(properties(sheetId,title,gridProperties))`, token, signal) as {
    properties: { title: string };
    sheets: { properties: { title: string; sheetId: number; gridProperties?: { rowCount: number; columnCount: number } } }[];
  };
  const sheets = metadata.sheets.map((sheet) => sheet.properties).filter((sheet) => urpiDateIso(sheet.title)?.startsWith(month));
  if (!sheets.length) throw new Error("No hay pestañas del mes seleccionado en este Sheet.");
  // Refuse partial reads rather than silently dropping rows from a larger workbook.
  if (sheets.length > 31 || sheets.some((sheet) => !sheet.gridProperties || sheet.gridProperties.rowCount > 5000 || sheet.gridProperties.columnCount < 15)) {
    throw new Error("El tamaño o formato del Sheet requiere revisión; no se realizó una lectura parcial.");
  }
  const tabs: UrpiTab[] = [];
  for (let offset = 0; offset < sheets.length; offset += 5) {
    const group = sheets.slice(offset, offset + 5);
    const params = new URLSearchParams({ valueRenderOption: "FORMATTED_VALUE" });
    for (const sheet of group) params.append("ranges", `'${sheet.title.replace(/'/g, "''")}'!A1:O${sheet.gridProperties!.rowCount}`);
    const result = await readGoogle(`${base}/values:batchGet?${params}`, token, signal) as { valueRanges?: { values?: unknown[][] }[] };
    if (result.valueRanges?.length !== group.length) throw new Error("Google devolvió una lectura incompleta. Conservamos la última lectura.");
    group.forEach((sheet, i) => tabs.push({ title: sheet.title, sheetId: sheet.sheetId, values: result.valueRanges![i]?.values ?? [] }));
  }
  return { title: metadata.properties.title, tabs };
}
