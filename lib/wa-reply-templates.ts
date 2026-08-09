/**
 * Plantillas de respuesta manual: lo que el asesor puede enviar desde el drawer
 * cuando la ventana de 24 h ya se cerró.
 *
 * Módulo PURO y sin dependencias: lo importan a la vez el composer (cliente,
 * para pintar el preview mientras el asesor edita) y la server action (para
 * validar antes de gastar el envío). Todo lo que toque Supabase, Kapso o el
 * saneado de parámetros de Meta se queda del lado del servidor — ver
 * `sanitizeTemplateParam` en lib/leads-ingest.ts, que la action aplica ANTES de
 * llamar a `validateReplyParams`.
 *
 * La diferencia con las plantillas automáticas (drip, carritos, recuperación de
 * devueltos) es quién decide: allá el cron resuelve los parámetros contra el
 * dato y aborta si alguno sale vacío; acá se PRE-RELLENAN desde el lead y el
 * asesor los corrige antes de mandar. Por eso la resolución puede devolver
 * huecos y la validación es un paso aparte.
 */

/** Tokens que una tienda puede poner en `wa_reply_templates.params`. */
export const REPLY_TOKENS = ["nombre", "producto", "monto", "distrito", "tienda"] as const;
export type ReplyToken = (typeof REPLY_TOKENS)[number];

/** Cómo se titula cada campo en el composer. El asesor edita valores, no tokens. */
export const REPLY_TOKEN_LABEL: Record<ReplyToken, string> = {
  nombre: "Nombre",
  producto: "Producto",
  monto: "Monto",
  distrito: "Distrito",
  tienda: "Tienda",
};

/** Una plantilla del catálogo, tal como la ve el drawer. */
export interface ReplyTemplate {
  id: string;
  label: string;
  templateName: string;
  language: string;
  bodyPreview: string | null;
  tokens: ReplyToken[];
}

/**
 * Parsea la config de tokens de una fila. Los desconocidos se ignoran en vez de
 * romper: igual que en la recuperación de devueltos, una tienda mal configurada
 * manda un parámetro de menos —Meta lo rechaza con un error legible— y no
 * revienta el desplegable entero para las demás plantillas.
 */
export function parseReplyParams(raw: string | null | undefined): ReplyToken[] {
  return String(raw ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t): t is ReplyToken => (REPLY_TOKENS as readonly string[]).includes(t));
}

/** Los datos del lead de los que se pre-rellenan los parámetros. */
export interface ReplyLeadFacts {
  name?: string | null;
  product?: string | null;
  amount?: number | null;
  district?: string | null;
  storeName?: string | null;
}

/** "Jose" — solo el primer nombre. Un "JOSE PIO PADILLA" completo en un saludo
 *  suena a cobranza; el primer nombre suena a la tienda que le vendió. Misma
 *  regla que `firstName` en lib/return-recovery.ts. */
export function replyFirstName(full: string | null | undefined): string {
  const parts = String(full ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  const w = parts[0]!;
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

/** "S/ 89.00", el formato que ya usan los rótulos y la secuencia de carritos. */
export function replyAmountLabel(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return "";
  return `S/ ${Number(amount).toFixed(2)}`;
}

/**
 * Pre-rellena los parámetros en el orden configurado. A diferencia del cron,
 * PUEDE devolver huecos: el asesor los completa a mano y para eso está el
 * formulario. Un hueco no es un error todavía; lo es al enviar.
 */
export function resolveReplyParams(tokens: ReplyToken[], facts: ReplyLeadFacts): string[] {
  return tokens.map((t) => {
    switch (t) {
      case "nombre":
        return replyFirstName(facts.name);
      case "producto":
        return String(facts.product ?? "").trim();
      case "monto":
        return replyAmountLabel(facts.amount);
      case "distrito":
        return String(facts.district ?? "").trim();
      case "tienda":
        return String(facts.storeName ?? "").trim();
    }
  });
}

/**
 * Última red antes de gastar el envío. Meta rechaza un parámetro vacío con
 * `#132018`, y el rechazo llega como un código sin explicación: es mucho mejor
 * decirlo acá, nombrando el campo que falta, que dejar que el asesor lo
 * descubra por un error numérico.
 *
 * Devuelve el motivo, o `null` si está listo para enviar.
 */
export function validateReplyParams(
  tokens: ReplyToken[],
  values: string[],
): string | null {
  if (values.length !== tokens.length) {
    return "Los parámetros no coinciden con la plantilla.";
  }
  const missing = tokens.filter((_, i) => !String(values[i] ?? "").trim());
  if (missing.length) {
    const names = missing.map((t) => REPLY_TOKEN_LABEL[t]);
    return names.length === 1
      ? `Falta ${names[0]}.`
      : `Faltan ${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}.`;
  }
  return null;
}

/**
 * Sustituye {{1}}, {{2}}… en el cuerpo aprobado para que el asesor LEA el
 * mensaje antes de mandarlo. Un placeholder sin valor se deja tal cual en vez de
 * borrarse: el hueco visible es justo la señal de que falta completarlo.
 *
 * No se envía nunca — el cuerpo real lo compone Meta desde la plantilla
 * aprobada. Esto es solo lo que se pinta en pantalla.
 */
export function renderReplyPreview(
  bodyPreview: string | null | undefined,
  values: string[],
): string {
  const body = String(bodyPreview ?? "").trim();
  if (!body) return "";
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, digits: string) => {
    const idx = Number(digits) - 1;
    const v = String(values[idx] ?? "").trim();
    return v || whole;
  });
}
