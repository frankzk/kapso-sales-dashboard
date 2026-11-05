// Qué pasó con cada escaneo de Almacén → Devoluciones, en una forma que la
// pantalla pueda contar (MOM §9.4 y §29.13, 05-11-2026).
//
// EL CASO (05-11-2026, producción). La cámara decía «Recibidas 346 de 608 ·
// faltan 262» y casi no se movía: contaba solo Tanders y Shalom contra un
// atraso acumulado desde septiembre, y las 26 cajas de Grupo GF del día —el
// grueso del trabajo— nunca sumaban. Y una caja que pasaba dos veces por el
// lector («KP201949-S01 ya estaba recibido en oficina…») salía en el mismo
// verde que una recepción nueva, sin «no suma»: quien escaneaba creía que la
// caja se había perdido. KP201949-S01 se había recibido a las 16:45 y se
// volvió a escanear.
//
// LA REGLA. El servidor dice, además del texto, qué fue el escaneo:
//   - `nueva`: este escaneo escribió la recepción ahora;
//   - `repetida`: ya estaba recibida antes; no suma (con cuándo, si se sabe);
//   - `informativa`: un aviso que no es ninguna de las dos («nunca salió»).
// Un error sigue siendo `{ error }`. La pantalla cuenta la tanda (lo escaneado
// desde que se abrió) y pinta cada lectura con su color.
//
// Pura y sin dependencias: la usan la acción de servidor y el navegador.
// Pruebas en test/returns-scan-outcome.test.ts.

export type ReturnScanOutcome = "nueva" | "repetida" | "informativa";
export type ReturnScanCourier = "grupo_gf" | "tanders" | "shalom";

/** Lo que el escaneo hizo, legible por máquina, junto al `notice` / `error` de siempre. */
export interface ReturnScanReception {
  outcome: ReturnScanOutcome;
  courier: ReturnScanCourier;
  /** El código con el que se nombra la caja: «KP201949-S01». */
  label: string;
  /** Solo en `repetida`: cuándo se recibió por primera vez, si se sabe. */
  firstReceivedAt?: string | null;
}

/**
 * Tanders y Shalom: la decisión de recepción (`decideReception`,
 * `decideShalomReception`) en un resultado. `null` = es un error.
 */
export function courierReceptionOutcome(decision: { ok: true } | { ok: false; reason: string }): ReturnScanOutcome | null {
  if (decision.ok) return "nueva";
  return decision.reason === "ya_recibida" ? "repetida" : null;
}

/** El instante más temprano de unos eventos (`occurred_at`), o el de respaldo. */
export function earliestOccurredAt(
  rows: readonly { occurred_at?: string | null }[] | null | undefined,
  fallback: string | null = null,
): string | null {
  let first: string | null = null;
  for (const row of rows ?? []) {
    const at = row.occurred_at;
    if (at && (!first || Date.parse(at) < Date.parse(first))) first = at;
  }
  return first ?? fallback;
}

/**
 * El instante más reciente de unos eventos (`occurred_at`), o el de respaldo.
 * Grupo GF: una salida conserva su id de vuelta en vuelta (sale, vuelve «No
 * entregado», se reprograma, vuelve…), así que su repetida dice la ÚLTIMA
 * recepción, la que se está repitiendo, y no la de una vuelta anterior.
 */
export function latestOccurredAt(
  rows: readonly { occurred_at?: string | null }[] | null | undefined,
  fallback: string | null = null,
): string | null {
  let last: string | null = null;
  for (const row of rows ?? []) {
    const at = row.occurred_at;
    if (at && (!last || Date.parse(at) > Date.parse(last))) last = at;
  }
  return last ?? fallback;
}

/** Cómo se cuenta una lectura en la tanda. */
export type ReturnScanKind = ReturnScanOutcome | "error";

/**
 * La clase de una respuesta del escaneo. Manda `reception`: una caja recibida
 * con un aviso en rojo (anulado solo en Kapta) SÍ se recibió y suma, y una
 * repetida en rojo sigue sin sumar. Un aviso en rojo que no recibió nada
 * («nunca salió» de un pedido anulado) es un error: se pinta y vibra como
 * error, así que cuenta como error. Sin `reception`, un error es error y un
 * aviso suelto es informativo.
 */
export function returnScanKind(result: { error?: string; notice?: string; reception?: ReturnScanReception | null }): ReturnScanKind {
  if (result.reception && !(result.error && result.reception.outcome === "informativa")) return result.reception.outcome;
  return result.error ? "error" : "informativa";
}

const LIMA_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" });
const LIMA_TIME = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", hour: "2-digit", minute: "2-digit", hour12: false });

/** «hoy 16:45», «ayer 09:10» o «el 03/11 16:45», en hora de Lima. */
export function receivedWhenText(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const day = LIMA_DAY.format(at);
  const today = LIMA_DAY.format(now);
  const yesterday = LIMA_DAY.format(new Date(now.getTime() - 86_400_000));
  const time = LIMA_TIME.format(at);
  if (day === today) return `hoy ${time}`;
  if (day === yesterday) return `ayer ${time}`;
  return `el ${day.slice(8, 10)}/${day.slice(5, 7)} ${time}`;
}

export type ReturnScanTone = "ok" | "warn" | "neutral" | "crit";

/** Una lectura de la tanda: la línea grande y, debajo, el aviso del servidor. */
export interface ReturnScanLine {
  kind: ReturnScanKind;
  tone: ReturnScanTone;
  headline: string;
  detail: string | null;
}

/**
 * Lo que se pinta de una lectura. Verde «recibida ✓» la nueva; ámbar «ya
 * estaba recibida (hoy 16:45) · no suma» la repetida; neutro el aviso; rojo el
 * error. Si el servidor trae además un error (la caja se recibió pero hay que
 * mirar algo), va en rojo con el motivo debajo.
 */
export function returnScanLine(
  result: { error?: string; notice?: string; reception?: ReturnScanReception | null },
  now: Date = new Date(),
): ReturnScanLine {
  const kind = returnScanKind(result);
  const reception = result.reception ?? null;
  const message = result.error ?? result.notice ?? null;
  if (!reception) {
    return result.error
      ? { kind, tone: "crit", headline: result.error, detail: null }
      : { kind, tone: "neutral", headline: result.notice ?? "Listo.", detail: null };
  }
  const alert = Boolean(result.error);
  if (reception.outcome === "nueva") {
    return { kind, tone: alert ? "crit" : "ok", headline: `${reception.label} · recibida ✓`, detail: message };
  }
  if (reception.outcome === "repetida") {
    const when = receivedWhenText(reception.firstReceivedAt, now);
    return {
      kind,
      tone: alert ? "crit" : "warn",
      headline: `${reception.label} · ya estaba recibida${when ? ` (${when})` : ""} · no suma`,
      detail: message,
    };
  }
  return { kind, tone: alert ? "crit" : "neutral", headline: message ?? reception.label, detail: null };
}

export interface ReturnScanTally {
  nuevas: number;
  repetidas: number;
  informativas: number;
  errores: number;
}

/** Cuenta las lecturas de la tanda; cada una, una sola vez. */
export function tallyReturnScans(kinds: readonly ReturnScanKind[]): ReturnScanTally {
  const tally: ReturnScanTally = { nuevas: 0, repetidas: 0, informativas: 0, errores: 0 };
  for (const kind of kinds) {
    if (kind === "nueva") tally.nuevas += 1;
    else if (kind === "repetida") tally.repetidas += 1;
    else if (kind === "informativa") tally.informativas += 1;
    else tally.errores += 1;
  }
  return tally;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** «Esta tanda: 3 recibidas · 1 repetida · 2 con error». Lo que es 0 no se dice, salvo las recibidas. */
export function returnScanTallyText(t: ReturnScanTally): string {
  const parts = [`Esta tanda: ${plural(t.nuevas, "recibida", "recibidas")}`];
  if (t.repetidas) parts.push(plural(t.repetidas, "repetida", "repetidas"));
  if (t.errores) parts.push(`${t.errores} con error`);
  if (t.informativas) parts.push(`${t.informativas} sin devolución`);
  return parts.join(" · ");
}

/** El día de Lima («2026-11-05») de un instante. */
export function limaDayKey(now: Date = new Date()): string {
  return LIMA_DAY.format(now);
}

/**
 * La línea de Grupo GF: lo recibido hoy (en cualquier pantalla) y lo que sigue
 * en cajas, como dos cifras y no «X de Y»: lo que sigue en cajas no tiene
 * fecha tope —un «No entregado» de la semana pasada sigue ahí—, así que no es
 * la meta de hoy. Lo de días anteriores se dice aparte. `today` es el día de
 * Lima («2026-11-05»); `routeDate`, el de la caja.
 */
export function gfReceptionLine(gf: { recibidasHoy: number; pendientes: readonly { routeDate: string }[]; today: string }): string {
  const received = `Grupo GF: ${plural(gf.recibidasHoy, "recibida", "recibidas")} hoy`;
  const left = gf.pendientes.length;
  if (!left) return `${received} · ninguna en cajas`;
  const older = gf.pendientes.filter((row) => row.routeDate && row.routeDate < gf.today).length;
  const inBoxes = left === 1 ? "1 sigue en cajas" : `${left} siguen en cajas`;
  return `${received} · ${inBoxes}${older ? ` (${older === left ? (left === 1 ? "de" : "todas de") : `${older} de`} días anteriores)` : ""}`;
}

/** La línea del atraso de Tanders y Shalom: lo que cada courier dice que devolvió. */
export function historicReceptionLine(p: { done: number; total: number }): string {
  const left = Math.max(0, p.total - p.done);
  return `Tanders y Shalom (pendientes históricos): ${p.done} de ${p.total} · ${left ? `faltan ${left}` : "no falta ninguna"}`;
}

/** Una lectura de la tanda, como la guarda la pantalla (lo último primero). */
export interface ReturnScanEntry {
  id: number;
  /** Lo que se escaneó o escribió, tal cual. */
  code: string;
  line: ReturnScanLine;
  /**
   * La respuesta no llegó (se cortó la red o el servidor no contestó): no se
   * sabe si la recepción se escribió.
   */
  transport?: boolean;
}

const sameCode = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

/**
 * Añade una lectura a la tanda, cada una UNA vez. El caso que corrige: la red
 * se corta después de que el servidor recibió la caja; la pantalla anota un
 * error y pide reintentar, y el reintento contesta «ya estaba recibida». Si
 * esa recepción es de esta tanda (`sessionStart`, en ms) y la lectura anterior
 * del mismo código fue ese corte, la caja se recibió AHORA: el corte se
 * reemplaza por una nueva —arriba, con la id de esta lectura— en vez de contar
 * un error y una repetida. PURA.
 */
export function recordReturnScan(
  entries: readonly ReturnScanEntry[],
  next: { id: number; code: string; result: { error?: string; notice?: string; reception?: ReturnScanReception | null }; transport?: boolean },
  sessionStart: number,
  now: Date = new Date(),
): ReturnScanEntry[] {
  const line = returnScanLine(next.result, now);
  const reception = next.result.reception ?? null;
  const firstAt = reception?.firstReceivedAt ? Date.parse(reception.firstReceivedAt) : Number.NaN;
  if (line.kind === "repetida" && reception && Number.isFinite(firstAt) && firstAt >= sessionStart) {
    const cut = entries.findIndex((entry) => sameCode(entry.code, next.code) || sameCode(entry.code, reception.label));
    if (cut >= 0 && entries[cut]?.transport) {
      const recovered: ReturnScanEntry = {
        id: next.id,
        code: next.code,
        line: {
          kind: "nueva",
          tone: "ok",
          headline: `${reception.label} · recibida ✓`,
          detail: "Se registró en el intento anterior: la conexión se cortó antes de la respuesta.",
        },
      };
      return [recovered, ...entries.slice(0, cut), ...entries.slice(cut + 1)];
    }
  }
  return [{ id: next.id, code: next.code, line, ...(next.transport ? { transport: true } : {}) }, ...entries];
}

/**
 * Grupo GF, dos lecturas a la vez: ¿la caja soltó el paquete porque otra
 * lectura lo recibió? Sí si hay una recepción desde un poco antes de que se
 * sacara de la caja: `gf_return_to_office` hace las dos cosas en una
 * transacción. Una recepción de una vuelta anterior no cuenta. PURA.
 */
export function gfReceivedWhenRemoved(removedAt: string | null, receivedAt: string | null, slackMs = 5_000): boolean {
  if (!removedAt || !receivedAt) return false;
  const removed = Date.parse(removedAt);
  const received = Date.parse(receivedAt);
  return Number.isFinite(removed) && Number.isFinite(received) && received >= removed - slackMs;
}
