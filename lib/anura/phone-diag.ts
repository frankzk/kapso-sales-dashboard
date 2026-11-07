// Diagnóstico del teléfono de Kapta («Llamar con Anura», fase 2; MOM §8.7).
//
// La primera prueba real (06-11-2026) quedó en «Anura no llegó a hacer la
// llamada» sin ningún aviso de Anura, y nada decía si el navegador se registró,
// si Anura le mandó la llamada o qué hizo Kapta con ella. Cada paso del
// teléfono se manda al servidor y queda en el log de Vercel como
// `[anura-phone] {...}`. Puro y sin datos personales: solo nombres de paso,
// códigos SIP y causas de JsSIP; cualquier secuencia de 6+ dígitos se borra
// (un teléfono nunca llega al log).

export type AnuraPhoneDiagValue = string | number | boolean | null;
export type AnuraPhoneDiagData = Record<string, AnuraPhoneDiagValue>;

const MAX_KEYS = 12;
const MAX_TEXT = 80;

/** Deja un dato de diagnóstico apto para el log: corto y sin números largos. */
export function cleanDiagValue(value: unknown): AnuraPhoneDiagValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value)
    .replace(/\d{6,}/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, MAX_TEXT);
}

/** El evento y sus datos, limpios. Nombres de clave cortos y conocidos. */
export function cleanDiag(event: unknown, data: unknown): { event: string; data: AnuraPhoneDiagData } | null {
  const name = typeof event === "string" ? event.replace(/[^a-z_]/gi, "").slice(0, 40) : "";
  if (!name) return null;
  const out: AnuraPhoneDiagData = {};
  if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data as Record<string, unknown>).slice(0, MAX_KEYS)) {
      const key = k.replace(/[^a-z_]/gi, "").slice(0, 24);
      if (key) out[key] = cleanDiagValue(v);
    }
  }
  return { event: name, data: out };
}
