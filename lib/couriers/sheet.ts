// Utilidades para leer una fila de hoja de cálculo con cabeceras impredecibles.
// Mismo criterio que lib/aliclik-import.ts (que las tiene en privado): cada
// courier escribe las cabeceras a su manera y cambian entre exports, así que se
// comparan normalizadas y por lista de alias.

/** Quita los diacríticos: los reportes mezclan "tránsito" y "transito". */
export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Clave canónica de cabecera: minúsculas, sin acentos, sin puntuación y con los
 * espacios colapsados. Se quita la puntuación porque las agencias titulan la
 * misma columna como "N° GUÍA", "Nro. Guia" o "N GUIA" — normalizándola, un solo
 * alias ("n guia") cubre las tres.
 */
export function headerKey(h: string): string {
  return stripAccents(h.trim().toLowerCase())
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Mapa cabecera-normalizada → valor (gana el primer valor no vacío). */
export function buildLookup(raw: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [h, v] of Object.entries(raw)) {
    const k = headerKey(h);
    if (v != null && String(v).trim() && !map.has(k)) map.set(k, String(v).trim());
  }
  return map;
}

/** Primer valor no vacío entre los alias dados. */
export function pick(map: Map<string, string>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = map.get(k);
    if (v && v.trim()) return v.trim();
  }
  return null;
}

/** Número tolerante: acepta "S/ 12,50", "12.50", "  7 ". Devuelve null si no hay. */
export function parseNumber(value: string | null): number | null {
  if (!value) return null;
  // Sin dígitos no hay número. Sin esta guarda, "sin costo" se limpiaría hasta
  // la cadena vacía y `Number("")` devolvería 0 — un costo inventado.
  if (!/\d/.test(value)) return null;
  const cleaned = value.replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}\b)/g, "");
  const normalized = cleaned.replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fecha tolerante → ISO. Acepta ISO, `DD/MM/YYYY` y `DD-MM-YYYY` (el orden
 * peruano; nunca se interpreta como mes/día). Devuelve null si no se entiende:
 * mejor un dato ausente que uno inventado, porque estas fechas deciden si un
 * pedido cuenta como devuelto.
 */
export function parseDate(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(v);
  if (iso) {
    const [, y, m, d, hh = "00", mm = "00", ss = "00"] = iso;
    const stamp = Date.parse(`${y}-${m}-${d}T${hh}:${mm}:${ss}.000Z`);
    return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
  }

  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(v);
  if (dmy) {
    const [, d, m, rawY, hh = "0", mm = "0", ss = "0"] = dmy;
    const year = rawY!.length === 2 ? 2000 + Number(rawY) : Number(rawY);
    const pad = (n: string | number) => String(n).padStart(2, "0");
    const stamp = Date.parse(
      `${year}-${pad(m!)}-${pad(d!)}T${pad(hh)}:${pad(mm)}:${pad(ss)}.000Z`,
    );
    return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
  }
  return null;
}

/** Entero no negativo, o null. Para contadores de intentos. */
export function parseCount(value: string | null): number | null {
  const n = parseNumber(value);
  if (n === null) return null;
  const i = Math.trunc(n);
  return i >= 0 ? i : null;
}
