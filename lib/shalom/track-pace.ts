// El rastreo por lotes de Shalom: con qué identificador se pregunta cada guía y
// a qué ritmo (MOM §12). PURO Y TESTEADO; el cron (`shalom-reconcile`) solo
// llama y espera.
//
// EL CUPO DEL RASTREO (medido el 16-10-2026, 04:00 de Lima). Es propio del
// rastreo y se cuenta GUÍA A GUÍA, no por llamada: dos lotes de 50 pasaron y el
// tercero volvió con 429 «pediste 50 guías y superás tu cupo de rastreo por
// minuto; reintentá en 12s». Cuadra con un balde de 120 guías que se rellena a
// 2 por segundo: tras 100 guías en ~4 s quedan ~28, y faltan 22 para 50 →
// 11 s. Las cabeceras `x-ratelimit-*` no lo reflejan (decían 29 restantes
// antes y después de cada lote): son de las llamadas, no de las guías.
//
// Antes de esto, el cron mandaba los lotes seguidos: el tercero chocaba, el
// resto se daba por perdido y cada pasada preguntaba por ~100 de ~460 guías
// vivas. Una guía esperaba ~2-3 h entre respuesta y respuesta.

/** Guías por minuto que acepta el rastreo, y el máximo de una vez. */
export const TRACK_QUOTA_PER_MINUTE = 120;
export const TRACK_BURST = 120;

/** Lo que Shalom pide si no dice cuánto esperar. */
const DEFAULT_RETRY_MS = 15_000;
/** Nunca se espera más que esto por un 429: el cron tiene 300 s. */
const MAX_RETRY_MS = 60_000;

/**
 * Lleva la cuenta del cupo del rastreo del lado nuestro, porque Shalom no la
 * publica. Arranca lleno: el panel casi no rastrea, y si algo ya gastó parte,
 * el primer 429 lo corrige (`exhausted`).
 */
export class TrackQuota {
  private tokens: number;
  private at: number;
  private readonly perMs: number;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly capacity: number = TRACK_BURST,
    perMinute: number = TRACK_QUOTA_PER_MINUTE,
  ) {
    this.tokens = capacity;
    this.at = now();
    this.perMs = perMinute / 60_000;
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.at) * this.perMs);
    this.at = t;
  }

  /** Milisegundos que faltan para poder pedir `n` guías; 0 si ya se puede. */
  waitFor(n: number): number {
    this.refill();
    const missing = Math.min(n, this.capacity) - this.tokens;
    return missing <= 0 ? 0 : Math.ceil(missing / this.perMs) + 250;
  }

  /** Se pidieron `n` guías. */
  spend(n: number): void {
    this.refill();
    this.tokens -= n;
  }

  /**
   * Shalom dijo que no hay cupo para `wanted` guías y cuánto esperar: manda
   * su cuenta, no la nuestra. Queda de modo que `waitFor(wanted)` sea esa
   * espera.
   */
  exhausted(retryMs: number, wanted: number): void {
    this.at = this.now();
    this.tokens = Math.min(wanted, this.capacity) - retryMs * this.perMs;
  }
}

/** Lo que Shalom dice que hay que esperar en su 429 («reintentá en 12s»). */
export function trackRetryAfterMs(message: string | null | undefined): number {
  const m = /reintent[aá]\s+en\s+(\d+)\s*s/i.exec(message ?? "");
  const seconds = m ? Number(m[1]) : NaN;
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 + 500 : DEFAULT_RETRY_MS;
  return Math.min(ms, MAX_RETRY_MS);
}

/** Lo que el cron sabe de una guía viva para preguntar por ella. */
export interface TrackableGuide {
  id: string;
  guide_code: string | null;
  /** Alfanumérico de 4. El rastreo por número NO resuelve sin él. */
  shalom_codigo: string | null;
  shalom_ose_id: number | null;
  created_via: string | null;
}

export interface TrackItem {
  custom_id: string;
  numero?: string;
  codigo?: string;
  ose_id?: string;
}

/**
 * Cómo se pregunta por una guía, o `null` si no hay cómo.
 *
 *   - `numero` + `codigo`, juntos. `numero` solo no basta: el upstream contesta
 *     «Ingrese un código de orden» —y con solo el código, «Ingrese un número de
 *     orden»—. Eso tuvo las 93 guías sin rastrear desde el primer día.
 *   - `ose_id` resuelve él solo, y va primero en las guías HECHAS A MANO que lo
 *     tienen (16-10-2026): su código lo tecleó una persona y puede estar mal
 *     —#KP137651 entró como V929 y era D7MN, y Shalom la rechazó dos semanas
 *     aunque ya tenía su OSE ID, que sale del listado comprobado—. En las de la
 *     API el código lo dio la propia API.
 *   - Sin código ni OSE ID no hay nada que preguntar: el número solo siempre
 *     vuelve rechazado («falta codigo»). Es la salida de mentira de un estado
 *     atestiguado (`MOM-KP123525-SHALOM-…`), que gastaba cupo en cada pasada.
 *
 * `ose_id` VA COMO STRING: como número da `400 body JSON inválido`, y ese 400
 * tumba el LOTE ENTERO. Los campos sin valor se omiten en vez de ir como null:
 * un item incompleto falla solo, sin llevarse a los demás.
 */
export function shalomTrackItem(g: TrackableGuide, manualOrigin: string): TrackItem | null {
  const numero = (g.guide_code ?? "").trim();
  const codigo = (g.shalom_codigo ?? "").trim();
  const ose = Number(g.shalom_ose_id);
  const oseId = Number.isSafeInteger(ose) && ose > 0 ? String(ose) : null;
  if (oseId && g.created_via === manualOrigin) return { custom_id: g.id, ose_id: oseId };
  if (numero && codigo) return { custom_id: g.id, numero, codigo };
  if (oseId) return { custom_id: g.id, ose_id: oseId };
  return null;
}
