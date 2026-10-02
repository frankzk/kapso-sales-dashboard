// Server-only. Read-only service account; never uses the user's browser session.
import { createSign } from "node:crypto";
import { urpiDateIso, type UrpiTab } from "./urpi-programming";

export function urpiGoogleConfigured(): boolean {
  return Boolean(process.env.URPI_GOOGLE_CLIENT_EMAIL && process.env.URPI_GOOGLE_PRIVATE_KEY);
}

async function googleToken(): Promise<string> {
  if (!urpiGoogleConfigured()) throw new Error("La lectura de Google todavía no está conectada. Puedes cargar el Excel descargado del mismo Sheet.");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const assertion = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: process.env.URPI_GOOGLE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })}`;
  const signature = createSign("RSA-SHA256").update(assertion).sign(process.env.URPI_GOOGLE_PRIVATE_KEY!.replace(/\\n/g, "\n"), "base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", cache: "no-store", signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${assertion}.${signature}` }),
  });
  if (!res.ok) throw new Error("No se pudo autenticar la conexión de Google. Revisa sus credenciales.");
  const body = await res.json() as { access_token?: string };
  if (!body.access_token) throw new Error("Google no devolvió acceso de lectura.");
  return body.access_token;
}

async function readGoogle(url: string, token: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(20000) });
  if (res.status === 403 || res.status === 404) throw new Error("La conexión no puede leer este Sheet. Comparte el archivo como lector con la cuenta de integración y comprueba que Sheets API esté habilitada.");
  if (!res.ok) throw new Error(`Google Sheets no respondió correctamente (${res.status}). Conservamos la última lectura.`);
  return res.json();
}

export async function readUrpiGoogleWorkbook(spreadsheetId: string, month: string): Promise<{ title: string; tabs: UrpiTab[] }> {
  if (!/^[a-zA-Z0-9_-]{20,100}$/.test(spreadsheetId)) throw new Error("Identificador de Sheet inválido.");
  const token = await googleToken();
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  const metadata = await readGoogle(`${base}?fields=properties(title),sheets(properties(sheetId,title,gridProperties))`, token) as {
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
    const result = await readGoogle(`${base}/values:batchGet?${params}`, token) as { valueRanges?: { values?: unknown[][] }[] };
    if (result.valueRanges?.length !== group.length) throw new Error("Google devolvió una lectura incompleta. Conservamos la última lectura.");
    group.forEach((sheet, i) => tabs.push({ title: sheet.title, sheetId: sheet.sheetId, values: result.valueRanges![i]?.values ?? [] }));
  }
  return { title: metadata.properties.title, tabs };
}
