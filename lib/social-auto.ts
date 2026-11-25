// Respuestas automáticas de Leads → Redes (owner, 25-11-2026: «con respuestas
// automáticas»; textos aprobados ese día; MOM §25.4). PURO: qué contestar y con
// qué texto. Lo manda lib/social-auto-server.ts.
//
// LA REGLA.
// - Comentario de una clienta con palabras de compra («precio», «info», «cuánto»,
//   «envío», «provincia»…): respuesta pública corta + mensaje por privado con el
//   producto, el precio y el WhatsApp de la tienda. Una sola vez por comentario.
// - Primer mensaje directo de una conversación: saludo con el WhatsApp de la tienda.
// - El resto (quejas, preguntas raras, comentarios negativos) va a las asesoras:
//   por eso no hay palabras como «quiero» o «pedido», que también usa un reclamo.
// - Kapta contesta UNA vez por comentario o conversación (llave de idempotencia).

export const DEFAULT_COMMENT_KEYWORDS: readonly string[] = [
  "precio", "precios", "cuanto", "cuánto", "costo", "cuesta", "vale", "info", "informacion", "información",
  "envio", "envío", "envian", "envían", "provincia", "delivery", "comprar", "me interesa", "interesada", "interesado",
  "como lo consigo", "whatsapp", "numero", "número", "dm", "md", "interno", "inbox",
];

export const DEFAULT_PUBLIC_TEXT = "¡Te escribimos por interno! 💬";
export const DEFAULT_PRIVATE_TEXT = "Hola 👋 {producto} está a S/ {precio}. Escríbenos por WhatsApp y te lo enviamos: {whatsapp}";
/** Si falta el producto o el precio, no se inventa: este texto va sin ellos. */
export const FALLBACK_PRIVATE_TEXT = "Hola 👋 Escríbenos por WhatsApp y te contamos el precio y el envío: {whatsapp}";
export const DEFAULT_DM_TEXT = "¡Hola {nombre}! 👋 Gracias por escribirnos. Para atenderte más rápido escríbenos por WhatsApp: {whatsapp}";

export interface SocialAutoSettings {
  enabled: boolean;
  comment_keywords: string[] | null;
  public_text: string | null;
  private_text: string | null;
  dm_text: string | null;
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** ¿El comentario pregunta por comprar? Por palabra entera (o frase), sin tildes. */
export function hasBuyingIntent(text: string | null | undefined, keywords: readonly string[] = DEFAULT_COMMENT_KEYWORDS): boolean {
  const t = ` ${fold(text ?? "").replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim()} `;
  if (!t.trim()) return false;
  return keywords.some((k) => {
    const kw = fold(k).replace(/[^a-z0-9ñ ]+/g, " ").replace(/\s+/g, " ").trim();
    return Boolean(kw) && t.includes(` ${kw} `);
  });
}

/**
 * Llena `{producto}`, `{precio}`, `{whatsapp}` y `{nombre}`. Devuelve null si el
 * texto usa un dato que no hay (así se cae al texto sin ese dato y nunca sale
 * «S/ {precio}» ni un precio inventado).
 */
export function fillAutoText(template: string, vars: { producto?: string | null; precio?: number | null; whatsapp?: string | null; nombre?: string | null }): string | null {
  const values: Record<string, string | null> = {
    producto: vars.producto?.trim() || null,
    precio: vars.precio != null && Number.isFinite(vars.precio) && vars.precio > 0 ? formatSoles(vars.precio) : null,
    whatsapp: vars.whatsapp?.trim() || null,
    // El nombre de pila: «¡Hola María!»; sin nombre queda «¡Hola!» (se quita el espacio antes del signo).
    nombre: vars.nombre?.trim() ? vars.nombre.trim().split(/\s+/)[0]! : "",
  };
  let missing = false;
  const out = template.replace(/\{(producto|precio|whatsapp|nombre)\}/g, (_, key: string) => {
    const v = values[key];
    if (v == null) { missing = true; return ""; }
    return v;
  });
  return missing ? null : out.replace(/\s+([.,!?])/g, "$1").trim();
}

/** «89» o «89.90». */
export function formatSoles(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** El enlace de WhatsApp de la tienda: `https://wa.me/51989256981?text=…`. Sin número, null. */
export function whatsappLink(displayPhone: string | null | undefined, text: string): string | null {
  const digits = (displayPhone ?? "").replace(/\D/g, "");
  if (digits.length < 9) return null;
  const full = digits.length === 9 ? `51${digits}` : digits;
  return `https://wa.me/${full}?text=${encodeURIComponent(text)}`;
}

/** Los textos que se mandan, con el de respaldo si al privado le falta un dato. */
export function autoTexts(settings: Pick<SocialAutoSettings, "public_text" | "private_text" | "dm_text">, vars: { producto?: string | null; precio?: number | null; whatsapp?: string | null; nombre?: string | null }) {
  const publicText = fillAutoText(settings.public_text?.trim() || DEFAULT_PUBLIC_TEXT, vars);
  const privateText = fillAutoText(settings.private_text?.trim() || DEFAULT_PRIVATE_TEXT, vars) ?? fillAutoText(FALLBACK_PRIVATE_TEXT, vars);
  const dmText = fillAutoText(settings.dm_text?.trim() || DEFAULT_DM_TEXT, vars);
  return { publicText, privateText, dmText };
}
