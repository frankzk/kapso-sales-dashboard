// El reprogramado que el motorizado conserva, sin esperar su hoja (MOM §29.7,
// «El reprogramado que el motorizado conserva», 01-11-2026, pedido del owner).
//
// Hasta hoy el paquete solo pasaba a la ruta siguiente cuando se cargaba la
// hoja del día siguiente y lo nombraba (`gf_notebook_carry_over`). Sin esa
// hoja, el reprogramado quedaba en la caja vieja «Por devolver», aunque el
// motorizado lo tuviera y lo volviera a llevar: en el aire. Ahora se pasa con
// un clic (Reparto y liquidación) o lo dice el propio motorizado en la app al
// reportarlo («Me lo quedo y lo llevo»). El traspaso es `gf_carry_over` (0234,
// 0248): las mismas validaciones y el mismo rastro que el de la hoja.
//
// Puro y sin Node: lo leen la acción, el panel y la app.

/** Hasta cuántos días después de hoy puede ir la ruta nueva. */
export const CARRY_MAX_DAYS_AHEAD = 7;

/** El día ISO (YYYY-MM-DD) `n` días después. */
export function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function ddmm(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/**
 * ¿Se puede pasar a la ruta de `toDate` un reprogramado de la ruta de
 * `fromDate`? Null si sí; si no, el motivo. Un día ya pasado vale (para
 * ponerse al día con lo que salió sin cargarse), pero siempre después de la
 * ruta en que se reprogramó. Pura.
 */
export function carryKeptProblem(fromDate: string, toDate: string, todayIso: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate) || Number.isNaN(Date.parse(`${toDate}T12:00:00Z`))) {
    return "Elige el día de la ruta en que sale.";
  }
  if (toDate <= fromDate) return `La ruta en que sale tiene que ser después del ${ddmm(fromDate)}.`;
  if (toDate > addDaysIso(todayIso, CARRY_MAX_DAYS_AHEAD)) {
    return `Como máximo ${CARRY_MAX_DAYS_AHEAD} días adelante (hasta el ${ddmm(addDaysIso(todayIso, CARRY_MAX_DAYS_AHEAD))}).`;
  }
  return null;
}

/**
 * El día que se propone: el siguiente a la ruta, salvo que ya pasó; entonces
 * mañana (lo normal al reportar en la tarde). Puro.
 */
export function defaultCarryDate(fromDate: string, todayIso: string): string {
  const next = addDaysIso(fromDate, 1);
  return next > todayIso ? next : addDaysIso(todayIso, 1);
}

/**
 * ¿Esta parada es un reprogramado que el motorizado todavía tiene en su caja
 * de Grupo GF, sin devolver ni pasar a otra ruta? Es lo único que
 * `gf_carry_over` acepta. Puro.
 */
export function isKeptReprogrammed(stop: {
  status: string;
  outcome_reason?: string | null;
  dispatch_manifest_id?: string | null;
  shipment_id?: string | null;
  manifest_item_id?: string | null;
  returned_at?: string | null;
  carried_to?: string | null;
}): boolean {
  return (
    stop.status === "no_entregado" &&
    stop.outcome_reason === "reprogramado" &&
    Boolean(stop.dispatch_manifest_id && stop.shipment_id && stop.manifest_item_id) &&
    !stop.returned_at &&
    !stop.carried_to
  );
}
