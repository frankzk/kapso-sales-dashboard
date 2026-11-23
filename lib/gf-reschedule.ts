// GF Courier volvió a programar su guía después de la novedad (owner, 21-11-2026,
// #KP207270). Puro.
//
// POR QUÉ. Una visita fallida deja la guía GF en incidencia (`INCIDENT:NO_ANSWER`)
// y GF la deja viva: cuando acuerda otro día, la vuelve a sacar con la MISMA guía
// (§29.17). El estado no cambia hasta que sale; lo que cambia es la fecha, que GF
// informa con `order.delivery_date_changed` (`new_date`). Repro Lima solo miraba
// el estado y seguía pidiendo llamar a una clienta que ya tenía su día. Daysi
// (GF): «pedido ya listo en Grupo GF para que salga el 24/11… debería salirse de
// la lista» y el owner: «y pasar a programados».
//
// LA REGLA. Con los avisos de GF de una guía (`gf_webhook_events`): el último
// cambio de fecha con un día válido, recibido DESPUÉS del último cambio de estado,
// es el día en que vuelve a salir. Un cambio de estado posterior (salió otra vez,
// otra visita fallida, una anulación) lo deja sin efecto. Sin cambio de estado
// conocido no se puede saber si la fecha es de antes o de después de la novedad:
// no cuenta.

export interface GfWebhookTimelineRow {
  type: string;
  received_at: string | null;
  /** `payload.data.new_date` del aviso (`YYYY-MM-DD`), solo en `order.delivery_date_changed`. */
  new_date?: string | null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** El día en que GF vuelve a sacar la guía después de su último cambio de estado, o null. */
export function gfRescheduleAfterIncident(events: readonly GfWebhookTimelineRow[]): { date: string; at: string } | null {
  let lastStatus: number | null = null;
  let reschedule: { date: string; at: string; time: number } | null = null;
  for (const e of events) {
    const time = Date.parse(e.received_at ?? "");
    if (!Number.isFinite(time)) continue;
    if (e.type === "order.status_changed") {
      if (lastStatus === null || time > lastStatus) lastStatus = time;
    } else if (e.type === "order.delivery_date_changed") {
      const date = (e.new_date ?? "").slice(0, 10);
      if (ISO_DAY.test(date) && (!reschedule || time > reschedule.time)) reschedule = { date, at: e.received_at!, time };
    }
  }
  if (lastStatus === null || !reschedule || reschedule.time <= lastStatus) return null;
  return { date: reschedule.date, at: reschedule.at };
}

/**
 * El día vigente de una guía GF que todavía no salió: el ÚLTIMO cambio de fecha
 * que avisó GF (`order.delivery_date_changed`), lo pidiera GF o la tienda, o null
 * si nunca cambió (owner, 23-11-2026, #KP207897: «si este es para el 25/11, ¿por
 * qué sale como para mañana?»).
 *
 * El día de la guía salía del pedido original a GF (o de la fecha que GF estimó
 * al crearla) y nunca se movía: GF lo reprogramó al 23/11 tras no contestar, el
 * acuerdo en Repro Lima lo pasó al 25/11 con la misma guía, y la fila seguía con
 * el 21/11 corrido al lunes. Medido ese día: 28 de 175 guías GF vivas de Lima con
 * un cambio de fecha que no se leía.
 *
 * Solo para guías sin salir: mientras la caja no sale, ningún cambio de estado
 * (impresa, por asignar, asignada) cambia el día que GF tiene para ella. Puro.
 */
export function gfLatestDeliveryDate(events: readonly GfWebhookTimelineRow[]): string | null {
  let latest: { date: string; time: number } | null = null;
  for (const e of events) {
    if (e.type !== "order.delivery_date_changed") continue;
    const time = Date.parse(e.received_at ?? "");
    const date = (e.new_date ?? "").slice(0, 10);
    if (!Number.isFinite(time) || !ISO_DAY.test(date)) continue;
    if (!latest || time > latest.time) latest = { date, time };
  }
  return latest?.date ?? null;
}
