// Cliente de Click2Dial de Anura Perú («Llamar con Anura», fase 1). SERVIDOR.
//
//   POST https://api.anura.pe/adapter/default/click2call
//   Authorization: Bearer <token Click2Dial>
//   Content-Type: application/x-www-form-urlencoded
//   called=<9 dígitos, sin 51>&extension=<anexo>&customs=kapta-<id>
//
// Anura responde 200 sin cuerpo y sin id de llamada (probado por Rentabilify
// el 24–26-10-2026); el id de Kapta vuelve como `custom1` en cada aviso. Los
// errores conocidos llegan como texto y se traducen a algo que la asesora
// pueda resolver. El token nunca aparece en un error ni en un log.

import { ANURA_CLICK2DIAL_TIMEOUT_MS } from "@/lib/anura/events";

export const ANURA_CLICK2CALL_URL = "https://api.anura.pe/adapter/default/click2call";

export type Click2DialErrorKind =
  | "sin_token"
  | "token"
  | "sin_terminal"
  | "terminal_no_registrada"
  | "tiempo"
  | "rechazo"
  | "red";

export type Click2DialResult = { ok: true } | { ok: false; kind: Click2DialErrorKind; error: string; httpStatus: number | null };

export interface Click2DialRequest {
  token: string;
  /** 9 dígitos, sin 51 (`anuraPeruCalled`). */
  called: string;
  extension: string;
  /** `kapta-<id>` (`anuraCustoms`). */
  customs: string;
}

export interface Click2DialDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const CLICK2DIAL_ERROR_TEXT: Record<Click2DialErrorKind, string> = {
  sin_token: "Anura no está configurado: falta el token de Click2Dial.",
  token: "El token de Anura no es válido. Hay que pegar uno nuevo de Integraciones → Click 2 Dial.",
  sin_terminal: "Tu anexo no tiene una terminal principal en Anura. Pide que marquen una como principal en tu anexo.",
  terminal_no_registrada:
    "Anura no encuentra conectado tu teléfono de Anura (la terminal principal de tu anexo). Ábrelo, espera a que diga «Listo» y vuelve a intentar.",
  tiempo:
    "Anura no respondió a tiempo y puede que igual haga la llamada. Si tu teléfono de Anura suena, contesta; si en un minuto no pasa nada, Kapta la da por fallida y puedes volver a intentar.",
  rechazo: "Anura rechazó la llamada.",
  red: "No se supo si Anura recibió el pedido de llamada. Si tu teléfono de Anura suena, contesta; si en un minuto no pasa nada, Kapta la da por fallida y puedes volver a intentar.",
};

/** El cuerpo form-urlencoded, en el orden del informe. */
export function click2DialBody(req: Pick<Click2DialRequest, "called" | "extension" | "customs">): string {
  return new URLSearchParams({ called: req.called, extension: req.extension, customs: req.customs }).toString();
}

/** Un trozo corto y limpio de la respuesta de Anura: sin el token, sin saltos. */
function snippet(text: string, token: string): string {
  let t = text.replace(/\s+/g, " ").trim();
  if (token) t = t.split(token).join("•••");
  return t.slice(0, 120);
}

/** Traduce una respuesta que no es 2xx. */
export function classifyClick2DialFailure(status: number, text: string, token = ""): Click2DialResult {
  const body = text.toLowerCase();
  if (body.includes("no originate terminal")) {
    return { ok: false, kind: "sin_terminal", error: CLICK2DIAL_ERROR_TEXT.sin_terminal, httpStatus: status };
  }
  if (body.includes("not registered")) {
    return { ok: false, kind: "terminal_no_registrada", error: CLICK2DIAL_ERROR_TEXT.terminal_no_registrada, httpStatus: status };
  }
  if (status === 401 || status === 403 || body.includes("secretid")) {
    return { ok: false, kind: "token", error: CLICK2DIAL_ERROR_TEXT.token, httpStatus: status };
  }
  const detail = snippet(text, token);
  return {
    ok: false,
    kind: "rechazo",
    error: `${CLICK2DIAL_ERROR_TEXT.rechazo} (HTTP ${status}${detail ? `: ${detail}` : ""})`,
    httpStatus: status,
  };
}

/** Pide la llamada. Nunca lanza. */
export async function requestClick2Dial(req: Click2DialRequest, deps: Click2DialDeps = {}): Promise<Click2DialResult> {
  const token = req.token.trim();
  if (!token) return { ok: false, kind: "sin_token", error: CLICK2DIAL_ERROR_TEXT.sin_token, httpStatus: null };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? ANURA_CLICK2DIAL_TIMEOUT_MS);
  try {
    const res = await fetchImpl(ANURA_CLICK2CALL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json, text/plain, */*",
      },
      body: click2DialBody(req),
      signal: controller.signal,
      cache: "no-store",
    });
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => "");
    return classifyClick2DialFailure(res.status, text, token);
  } catch (err) {
    const aborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
    return aborted
      ? { ok: false, kind: "tiempo", error: CLICK2DIAL_ERROR_TEXT.tiempo, httpStatus: null }
      : { ok: false, kind: "red", error: CLICK2DIAL_ERROR_TEXT.red, httpStatus: null };
  } finally {
    clearTimeout(timer);
  }
}
