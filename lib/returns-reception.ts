// Recepción física de devoluciones: lo que el courier DICE que devolvió frente a
// lo que de verdad llegó al almacén.
//
// EL CASO (24-09-2026). Tanders reportaba `RETURNED` en 108 guías y el sistema
// las daba por devueltas: desde 0579 ese estado sella `returned_at` solo, con
// procedencia `tanders_api`. Pero nadie había confirmado físicamente NI UNA —el
// evento `return_received` no existía en toda la historia de la base—, y el
// botón manual del drawer estaba además BLOQUEADO para ellas, porque leía
// `returned_at` como «ya se recibió en almacén». O sea: el sistema daba por
// hecho que 108 cajas estaban en el almacén solo porque el courier lo decía.
//
// Lo que se quiere saber es justo lo contrario: que el courier devuelve TODO lo
// que no entregó. Así que la recepción se registra aparte, como un hecho de una
// persona con la caja en la mano, SIN reescribir el sello del courier (0118: la
// procedencia de una devolución no se pisa). El cuadre sale de comparar las dos
// cosas.
//
// Puro y probado en test/returns-reception.test.ts.

/** Lo que hace falta saber de la guía para decidir si se puede recibir. */
export interface ReturnGuide {
  delivery_status: string;
  custody_state: string | null;
  returned_at: string | null;
}

export type ReceptionDecision =
  /** `seal`: además hay que sellar la devolución, porque el courier aún no lo hizo. */
  | { ok: true; seal: boolean }
  | { ok: false; reason: "ya_recibida" | "entregada" | "nunca_salio"; message: string };

/**
 * ¿Se puede registrar la llegada física de esta caja?
 *
 * Las negativas son las mismas que ya aplicaba el botón manual del drawer,
 * con una diferencia a propósito: aquel rechazaba cualquier guía con
 * `returned_at`, y acá eso NO es «ya recibida» si lo selló el courier — es
 * precisamente lo que hay que confirmar. «Ya recibida» es que una PERSONA ya
 * la registró.
 */
export function decideReception(guide: ReturnGuide, alreadyReceived: boolean): ReceptionDecision {
  if (alreadyReceived) {
    return { ok: false, reason: "ya_recibida", message: "Esta caja ya se había recibido en almacén." };
  }
  if (guide.delivery_status === "entregado") {
    // No se recibe como devolución: el courier la dio por entregada. Si la
    // caja está físicamente acá, eso es una incidencia que hay que escalar, no
    // una devolución más que se registra en silencio.
    return {
      ok: false,
      reason: "entregada",
      message:
        "El courier dio esta guía por ENTREGADA. Si la caja está aquí, es una incidencia: avísalo antes de registrarla.",
    };
  }
  if (guide.custody_state === "empresa" && !guide.returned_at) {
    return {
      ok: false,
      reason: "nunca_salio",
      message: "Esta guía nunca salió del almacén: no hay devolución que recibir.",
    };
  }
  // Si el courier aún no la dio por devuelta (va «en camino» o nunca lo
  // reportó), la persona que la tiene en la mano es quien la sella.
  return { ok: true, seal: !guide.returned_at };
}

/** Una guía candidata a devolución, con cuándo se recibió (si se recibió). */
export interface ReconciliationRow {
  id: string;
  guide_code: string | null;
  order_name: string | null;
  reported_status: string | null;
  custody_state: string | null;
  returned_at: string | null;
  returned_source: string | null;
  /** Cuándo la registró una persona en almacén. Null = todavía no. */
  received_at: string | null;
}

export interface ReconciliationBuckets {
  /** Confirmadas por una persona con la caja en la mano. */
  recibidas: ReconciliationRow[];
  /** El courier dice que ya las devolvió y no han llegado: lo que te debe. */
  faltan: ReconciliationRow[];
  /** El courier dice que vienen de vuelta. Aún no toca reclamarlas. */
  enCamino: ReconciliationRow[];
}

function reported(row: ReconciliationRow): string {
  return (row.reported_status ?? "").trim().toUpperCase();
}

/**
 * Reparte las guías en recibidas / faltan / en camino.
 *
 * «Faltan» es la lista que importa: el courier AFIRMA que ya las devolvió —por
 * su estado o por el sello que puso su API— y nadie las ha registrado en
 * almacén. Se ordena de la más antigua a la más reciente, porque una caja que
 * el courier dio por devuelta hace diez días y no aparece no es un retraso, es
 * una pérdida.
 */
export function bucketReturns(rows: readonly ReconciliationRow[]): ReconciliationBuckets {
  const recibidas: ReconciliationRow[] = [];
  const faltan: ReconciliationRow[] = [];
  const enCamino: ReconciliationRow[] = [];
  for (const row of rows) {
    if (row.received_at) {
      recibidas.push(row);
      continue;
    }
    const diceDevuelta =
      reported(row) === "RETURNED" || /_(api|report)$/.test(row.returned_source ?? "");
    if (diceDevuelta) faltan.push(row);
    else enCamino.push(row);
  }
  const antiguedad = (r: ReconciliationRow) => r.returned_at ?? "9999";
  faltan.sort((a, b) => antiguedad(a).localeCompare(antiguedad(b)));
  recibidas.sort((a, b) => (b.received_at ?? "").localeCompare(a.received_at ?? ""));
  return { recibidas, faltan, enCamino };
}

/** Días enteros desde un instante, para «hace N días». */
export function daysSince(iso: string | null, now: Date = new Date()): number | null {
  if (!iso) return null;
  const ms = now.getTime() - Date.parse(iso);
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86_400_000)) : null;
}
