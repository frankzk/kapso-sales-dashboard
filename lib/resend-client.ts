// El cliente de la API de Resend que usa «Correo · Resend» (MOM §46). Solo
// servidor: recibe la clave ya descifrada y nunca la registra. Sin SDK: unas
// pocas llamadas con `fetch` (las mismas rutas y campos que el SDK oficial,
// resend@6: `/topics`, `/segments`, `/contacts/imports`).

import type { ResendApiError, ResendImportCounts } from "@/lib/resend-marketing";

const BASE = "https://api.resend.com";
/** Una importación de 50.000 contactos son unos 3 MB: el envío puede tardar. */
const TIMEOUT_MS = 60_000;

export type ResendResult<T> = { ok: true; data: T } | { ok: false; error: ResendApiError };

export type ResendFetch = typeof fetch;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Una llamada. Con 429 (Resend deja 10 por segundo por cuenta) espera lo que
 * pide `retry-after`, hasta 3 s, y reintenta una vez.
 */
export async function resendRequest<T>(
  key: string,
  path: string,
  init: { method?: "GET" | "POST"; json?: unknown; form?: FormData } = {},
  fetchImpl: ResendFetch = fetch,
): Promise<ResendResult<T>> {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "User-Agent": "kapta-dashboard" };
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res: Response;
    try {
      res = await fetchImpl(`${BASE}${path}`, {
        method: init.method ?? (body ? "POST" : "GET"),
        headers,
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
    } catch {
      return { ok: false, error: { status: null, name: "network", message: null } };
    }
    if (res.status === 429 && attempt === 0) {
      const after = Number(res.headers.get("retry-after"));
      await wait(Math.min(3000, Number.isFinite(after) && after > 0 ? after * 1000 : 1000));
      continue;
    }
    const raw = await res.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) return { ok: false, error: parseResendError(res.status, parsed, raw) };
    return { ok: true, data: parsed as T };
  }
  return { ok: false, error: { status: 429, name: "rate_limit_exceeded", message: null } };
}

/** `{ name, message }` o `{ error: { name, message } }`; si no, el texto. */
export function parseResendError(status: number, parsed: unknown, raw: string): ResendApiError {
  const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const inner = obj?.error && typeof obj.error === "object" ? (obj.error as Record<string, unknown>) : null;
  const src = inner ?? obj;
  const name = typeof src?.name === "string" ? src.name : null;
  const message = typeof src?.message === "string" ? src.message : typeof obj?.error === "string" ? obj.error : raw.slice(0, 300) || null;
  return { status, name, message };
}

export interface ResendTopic {
  id: string;
  name: string;
  default_subscription?: string;
}

export interface ResendSegment {
  id: string;
  name: string;
}

interface ResendList<T> {
  data?: T[];
  has_more?: boolean;
}

/** Recorre una lista paginada (`limit`, `after`), hasta 10 páginas. */
async function listAll<T extends { id: string }>(key: string, path: string, fetchImpl: ResendFetch): Promise<ResendResult<T[]>> {
  const all: T[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const qs = new URLSearchParams({ limit: "100" });
    if (after) qs.set("after", after);
    const res: ResendResult<ResendList<T>> = await resendRequest<ResendList<T>>(key, `${path}?${qs}`, {}, fetchImpl);
    if (!res.ok) return res;
    const items = res.data?.data ?? [];
    all.push(...items);
    if (!res.data?.has_more || !items.length) break;
    after = items[items.length - 1]!.id;
  }
  return { ok: true, data: all };
}

/** Sirve también para probar la clave: una de solo envío contesta `restricted_api_key`. */
export function listResendSegments(key: string, fetchImpl: ResendFetch = fetch) {
  return listAll<ResendSegment>(key, "/segments", fetchImpl);
}

export async function listResendTopics(key: string, fetchImpl: ResendFetch = fetch): Promise<ResendResult<ResendTopic[]>> {
  const res = await resendRequest<ResendList<ResendTopic>>(key, "/topics", {}, fetchImpl);
  return res.ok ? { ok: true, data: res.data?.data ?? [] } : res;
}

export function createResendSegment(key: string, name: string, fetchImpl: ResendFetch = fetch) {
  return resendRequest<{ id: string }>(key, "/segments", { json: { name } }, fetchImpl);
}

/**
 * El tema de una marca, con `opt_in` por defecto: todos lo reciben salvo quien
 * se dio de baja de él. Así la importación no toca las preferencias de nadie
 * (no se pasa el tema al importar) y una baja en Resend se respeta aunque se
 * vuelva a subir la lista.
 */
export function createResendTopic(key: string, name: string, description: string, fetchImpl: ResendFetch = fetch) {
  return resendRequest<{ id: string }>(
    key,
    "/topics",
    { json: { name, description, default_subscription: "opt_in" } },
    fetchImpl,
  );
}

/**
 * Pide la importación (asíncrona en Resend). `upsert`: si el correo ya está,
 * se le actualiza el nombre y se le suma el segmento; su baja, si la tiene, no
 * se toca (no se manda la columna `unsubscribed`).
 */
export function createResendContactImport(
  key: string,
  input: { csv: string; filename: string; segmentId: string },
  fetchImpl: ResendFetch = fetch,
) {
  const form = new FormData();
  form.append("file", new Blob([input.csv], { type: "text/csv" }), input.filename);
  form.append("on_conflict", "upsert");
  form.append("segments", JSON.stringify([{ id: input.segmentId }]));
  return resendRequest<{ id: string }>(key, "/contacts/imports", { form }, fetchImpl);
}

export interface ResendContactImport {
  id: string;
  status: string;
  completed_at?: string | null;
  counts?: ResendImportCounts;
}

export function getResendContactImport(key: string, id: string, fetchImpl: ResendFetch = fetch) {
  return resendRequest<ResendContactImport>(key, `/contacts/imports/${encodeURIComponent(id)}`, {}, fetchImpl);
}
