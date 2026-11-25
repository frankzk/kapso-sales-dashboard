// ¿Este snapshot de Aliclik cambia ALGO de la guía, o solo dice «te volví a mirar»?
//
// EL COSTE QUE ESTO EVITA. El barrido relee cada 20 minutos las guías de los
// últimos 14 días y aplica lo que Aliclik diga. La guarda monotónica descarta
// los snapshots más VIEJOS que el último aplicado, pero uno IGUAL pasa: se
// escribía entero y disparaba un recálculo del Master, que descarga las 745
// tarifas de la organización (unos 370 KB) más el pedido, sus guías y sus
// eventos. Medido el 10-09-2026: 1.200 guías distintas tocadas en 24 horas,
// 43.000 aplicaciones, 2.000 recálculos por hora de madrugada sin nadie
// conectado, 33 millones de filas de tarifas servidas al día. El egress de
// Supabase se fue a 333 GB sobre 250.
//
// LA REGLA. Se construye el parche igual que siempre y se compara con la fila.
// Si lo único que cambia son los SELLOS DE LECTURA —cuándo miramos, qué
// `updatedAt` vimos—, se escriben solo ésos (siguen importando: mientras la
// lectura de API esté fresca, un Excel no pisa el estado) y no se recalcula
// nada. Cualquier otro campo distinto es un cambio de verdad y sigue el camino
// de siempre. Un campo que la fila no trae se cuenta como cambio: ante la duda,
// se aplica. Lo caro era aplicar siempre, no aplicar de más una vez.

/** Lo que registra CUÁNDO miramos, no QUÉ vimos. Cambia en cada pasada. */
export const SELLOS_DE_LECTURA = ["last_report_at", "api_report_at", "api_updated_at"] as const;

const SELLOS = new Set<string>(SELLOS_DE_LECTURA);

/** Una fecha y hora con su zona: `2026-09-09T09:00:00.000Z`, `2026-09-09T09:00:00+00:00`. */
const INSTANTE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$/;

/**
 * El mismo instante escrito de dos maneras.
 *
 * EL COSTE QUE ESTO EVITA (medido el 25-11-2026). El parche lleva `closed_at`
 * de una guía entregada como lo escribe JavaScript (`…T09:00:00.000Z`) y la
 * base lo devuelve como lo escribe Postgres (`…T09:00:00+00:00`). Comparados
 * como texto eran distintos SIEMPRE: cada guía entregada de la ventana del
 * barrido se reescribía entera y recalculaba su pedido en cada pasada. 247.723
 * veces en 10 días (unas 23.800 al día, cerca del 83 % de los recálculos del
 * Master) para 735 guías, de las que 3 habían cambiado en tres horas.
 *
 * Solo dos textos con forma de fecha, hora y zona: un día suelto, una etiqueta
 * o un código no se interpretan.
 */
function mismoInstante(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (!INSTANTE.test(a) || !INSTANTE.test(b)) return false;
  const ta = Date.parse(a);
  return Number.isFinite(ta) && ta === Date.parse(b);
}

function igual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  // `numeric` llega como número o como texto según el cliente; «12.5» y 12.5
  // son el mismo monto.
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return mismoInstante(a, b);
}

/**
 * Claves del parche que dejan la fila distinta, sin contar los sellos.
 * Vacío significa «este snapshot no trae nada nuevo».
 */
export function cambiosMateriales(
  patch: Record<string, unknown>,
  current: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (SELLOS.has(key)) continue;
    if (!(key in current)) {
      out.push(key);
      continue;
    }
    if (!igual(value, current[key])) out.push(key);
  }
  return out;
}

/** El parche reducido a los sellos: lo único que se escribe cuando no hay cambios. */
export function soloSellos(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SELLOS_DE_LECTURA) {
    if (key in patch) out[key] = patch[key];
  }
  return out;
}
