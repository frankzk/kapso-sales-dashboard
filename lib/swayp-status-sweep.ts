// El estado de las guías Swayp, leído de su API (29-09-2026).
//
// EL CASO. #KP135009 seguía «En tránsito» con su guía 50000139816 en
// DEVOLUCIÓN en el panel de Swayp desde el 28/09. El único canal era el webhook,
// y el webhook de Swayp solo ha mandado ENTREGAS: las 43 guías que alguna vez
// actualizó están en 7, y no llegó ni un Reparto, una Novedad o una Devolución.
// Leído el tracking público de las 147 guías que Kapta tenía vivas: 94 en
// Devolución, 17 en Devolución confirmada, 1 con cobro, 14 en Novedad, 13 en
// Reparto, 6 recién generadas y 2 canceladas. Todas figuraban con el estado 1.
//
// Esto lee cada guía viva con `GET /v2/guias/{guia}` —el `estado` de la
// respuesta, como indicó la operación— y lo aplica por la MISMA puerta que el
// webhook (`applySwaypState`), así que las dos escriben lo mismo. Un `estado` que
// no sabemos traducir no toca la guía: se cuenta con su texto en el reporte,
// que es la única forma honesta de aprender el vocabulario (igual que Tanders).
//
// SERVER-ONLY: usa la credencial de Swayp del entorno.

import type { SupabaseClient } from "@supabase/supabase-js";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import {
  getGuide,
  isSwaypAuthError,
  readSwaypGuide,
  SwaypError,
  swaypOptsFromEnv,
  swaypResponseShape,
  SWAYP_STATES,
  type SwaypClientOpts,
} from "@/lib/swayp";
import {
  applySwaypState,
  normalizeSwaypIncoming,
  SWAYP_SHIPMENT_COLUMNS,
  swaypStatePatch,
  type SwaypShipmentRow,
} from "@/lib/swayp-ingest";

/**
 * Tope por pasada. Hoy hay ~150 guías vivas y el barrido corre cada media hora;
 * las nunca leídas y las leídas hace más tiempo van primero, así que si un día
 * hay más, entran en la pasada siguiente.
 */
export const MAX_PER_RUN = 200;
/** Lecturas a la vez. Swayp no publica su límite: pocas, y el primer 429 para todo. */
export const SWEEP_CONCURRENCY = 4;
/** Se deja de pedir guías nuevas pasado esto (el cron tiene 300 s). */
export const SWEEP_TIME_BUDGET_MS = 240_000;

/** Motivos distintos que se guardan en el reporte; más ya es ruido. */
const MAX_DISTINCT_FAILURES = 5;

interface Candidate extends SwaypShipmentRow {
  swayp_guide: string;
  order_name: string | null;
}

export interface SwaypStatusChange {
  guia: string;
  pedido: string | null;
  /** `delivery_status · estado Swayp` antes y después. */
  de: string;
  a: string;
}

export interface SwaypStatusReport {
  scanned: number;
  /** Guías en las que cambió algo. */
  aplicados: number;
  /** Leídas y sin novedad. */
  sinCambio: number;
  /** `estado` que Swayp devolvió y no sabemos traducir, con su cuenta. */
  desconocidos: Record<string, number>;
  /** La API respondió `{}`: la guía no existe o no es de la cuenta. */
  noEncontradas: number;
  errores: number;
  /** Por qué falló lo que falló, agrupado. */
  fallos: { mensaje: string; n: number }[];
  /** Por qué paró antes de terminar, si paró. */
  detenido: null | "limite" | "credencial" | "tiempo";
  cambios: SwaypStatusChange[];
  /**
   * Cómo vino la respuesta, sin datos: `estado|idEstado` crudos con su cuenta y
   * las claves de primer nivel. La forma de `GET /v2/guias` no está
   * documentada; así se aprende (una Devolución confirmada llega como 10).
   */
  crudos: Record<string, number>;
  forma: string[];
  /** Bajo qué clave vino el historial, si vino. */
  historial: string | null;
}

/**
 * El motivo de un fallo, sin lo que cambia de guía a guía: doscientas guías con
 * el mismo 500 son UN motivo, no doscientos.
 */
export function describeSwaypFailure(err: unknown): string {
  if (err instanceof SwaypError) {
    const body = err.body.replace(/\d{6,}/g, "{n}").replace(/\s+/g, " ").trim().slice(0, 160);
    return `Swayp GET /v2/guias/{guia} → ${err.status}${body ? `: ${body}` : ""}`;
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`.replace(/\d{6,}/g, "{n}").slice(0, 200);
  return String(err).slice(0, 200);
}

function recordFailure(list: SwaypStatusReport["fallos"], err: unknown): void {
  const mensaje = describeSwaypFailure(err);
  const hit = list.find((f) => f.mensaje === mensaje);
  if (hit) {
    hit.n += 1;
    return;
  }
  if (list.length >= MAX_DISTINCT_FAILURES) {
    const other = list.find((f) => f.mensaje === "(otros motivos distintos)");
    if (other) other.n += 1;
    else list.push({ mensaje: "(otros motivos distintos)", n: 1 });
    return;
  }
  list.push({ mensaje, n: 1 });
}

function stateText(state: number | null): string {
  return state == null ? "sin estado" : `${state} ${SWAYP_STATES[state] ?? ""}`.trim();
}

export async function sweepSwaypStatus(
  admin: SupabaseClient,
  opts: {
    dry?: boolean;
    /** Credencial; por defecto la del entorno. */
    client?: SwaypClientOpts;
    now?: () => Date;
    recompute?: (admin: SupabaseClient, orderIds: string[]) => Promise<unknown>;
  } = {},
): Promise<SwaypStatusReport> {
  const dry = opts.dry === true;
  const now = opts.now ?? (() => new Date());
  const client = opts.client ?? swaypOptsFromEnv();
  const started = Date.now();

  // Vivas: lo terminal ya no se relee (entregado, anulado, transferido). Sin
  // tope de antigüedad, como Tanders: una guía olvidada es justo la que hay que
  // ir a mirar. Las nunca leídas primero, después las leídas hace más tiempo.
  const { data, error } = await admin
    .from("shipments")
    .select(`${SWAYP_SHIPMENT_COLUMNS},swayp_guide,order_name`)
    .not("swayp_guide", "is", null)
    .in("delivery_status", ["pendiente", "en_ruta"])
    .order("swayp_synced_at", { ascending: true, nullsFirst: true })
    .limit(MAX_PER_RUN);
  if (error) throw new Error(error.message);

  const candidates = ((data ?? []) as unknown) as Candidate[];
  const report: SwaypStatusReport = {
    scanned: 0,
    aplicados: 0,
    sinCambio: 0,
    desconocidos: {},
    noEncontradas: 0,
    errores: 0,
    fallos: [],
    detenido: null,
    cambios: [],
    crudos: {},
    forma: [],
    historial: null,
  };
  const keys = new Set<string>();
  const changedOrders = new Set<string>();

  let next = 0;
  async function worker(): Promise<void> {
    while (next < candidates.length && !report.detenido) {
      if (Date.now() - started > SWEEP_TIME_BUDGET_MS) {
        report.detenido = "tiempo";
        return;
      }
      const row = candidates[next++]!;
      report.scanned += 1;
      try {
        const body = await getGuide(client, row.swayp_guide);
        if (!body) {
          report.noEncontradas += 1;
          continue;
        }
        const shape = swaypResponseShape(body);
        if (Object.keys(report.crudos).length < 20 || report.crudos[shape.estado]) {
          report.crudos[shape.estado] = (report.crudos[shape.estado] ?? 0) + 1;
        }
        for (const k of shape.keys) if (keys.size < 60) keys.add(k);
        report.historial ??= shape.historial;
        const reading = readSwaypGuide(body);
        if (reading.state == null) {
          const key = reading.label ?? "(sin estado)";
          report.desconocidos[key] = (report.desconocidos[key] ?? 0) + 1;
          continue;
        }
        // Un 10 sobre una guía que ya salió es el final de su devolución (9).
        const incoming = normalizeSwaypIncoming(row, {
          state: reading.state,
          departedAt: reading.departedAt,
          changedAt: reading.changedAt,
        });
        const at = now();
        const result = dry
          ? swaypStatePatch(row, incoming, at.toISOString())
          : await applySwaypState(admin, row, incoming, { now: at, recompute: false });
        if (!result.changed) {
          report.sinCambio += 1;
          continue;
        }
        report.aplicados += 1;
        report.cambios.push({
          guia: row.swayp_guide,
          pedido: row.order_name,
          de: `${row.delivery_status} · ${stateText(row.swayp_state)}`,
          a: `${result.deliveryStatus} · ${stateText(incoming.state)}`,
        });
        if (row.order_id) changedOrders.add(row.order_id);
      } catch (err) {
        report.errores += 1;
        recordFailure(report.fallos, err);
        // Un 429 es Swayp diciendo «basta», y una credencial muerta falla igual
        // en todas: seguir solo quema llamadas. Lo demás va en la pasada siguiente.
        if (err instanceof SwaypError && err.status === 429) report.detenido = "limite";
        else if (isSwaypAuthError(err)) report.detenido = "credencial";
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, candidates.length) }, worker));
  report.forma = [...keys].sort();

  // El Master de una vez al final: sin esto, un pedido que Swayp devolvió sigue
  // «En tránsito» hasta la puerta de guías movidas del cron.
  if (!dry && changedOrders.size) {
    await (opts.recompute ?? recomputeOrderMasterSafe)(admin, [...changedOrders]);
  }
  return report;
}
