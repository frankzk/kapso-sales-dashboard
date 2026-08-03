// Fechas de los reportes Excel de los couriers.
//
// Los reportes traen la fecha de entrega como texto "DD/MM/YYYY" (Aliclik) o,
// en algunos exports, ya en ISO. Este módulo la lleva a "YYYY-MM-DD" sin tocar
// zonas horarias: es una FECHA de calendario (el día en que se entregó), no un
// instante. Puro y probado.

/**
 * Normaliza una fecha de reporte a "YYYY-MM-DD". Acepta "DD/MM/YYYY" y también
 * "YYYY-MM-DD[...]". Devuelve null si no es una fecha usable — un valor vacío o
 * con formato raro NO debe convertirse en una fecha inventada.
 */
export function parseReportDeliveryDate(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;

  const dmy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmy) {
    const dd = dmy[1]!;
    const mm = dmy[2]!;
    const yyyy = dmy[3]!;
    return validCalendarDate(yyyy, mm, dd) ? `${yyyy}-${mm}-${dd}` : null;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const yyyy = iso[1]!;
    const mm = iso[2]!;
    const dd = iso[3]!;
    return validCalendarDate(yyyy, mm, dd) ? `${yyyy}-${mm}-${dd}` : null;
  }
  return null;
}

function validCalendarDate(yyyy: string, mm: string, dd: string): boolean {
  const y = Number(yyyy);
  const m = Number(mm);
  const d = Number(dd);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // Rango defensivo: un año fuera de lo plausible casi siempre es un dato roto.
  if (y < 2000 || y > 2100) return false;
  return true;
}

/**
 * La fecha de entrega más reciente de un conjunto de valores crudos. Una guía
 * puede aparecer en varios reportes; la última entrega es la buena. Como todas
 * quedan en "YYYY-MM-DD", el orden lexicográfico coincide con el cronológico.
 */
export function latestReportDeliveryDate(raws: readonly (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const raw of raws) {
    const parsed = parseReportDeliveryDate(raw);
    if (parsed && (best === null || parsed > best)) best = parsed;
  }
  return best;
}

/**
 * El instante que se guarda en `closed_at` para una fecha de entrega. Se fija a
 * mediodía de Lima (UTC−05:00 → 17:00Z) a propósito: así cualquier conversión a
 * "día de Lima" aguas abajo cae en el MISMO día, sin el salto que provocaría la
 * medianoche.
 */
export function reportDeliveryClosedAt(dateYmd: string): string {
  return `${dateYmd}T17:00:00.000Z`;
}
