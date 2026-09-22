// A quién le toca atender una alerta de cobranza, y cuándo pasa al siguiente.
//
// ES UNA ESCALERA, NO UNA RONDA. La alerta de «Yape/Shalom por verificar»
// reparte entre las asesoras conectadas y busca que alguien la tome primero;
// aquí hay un responsable. Gerardo cobra las diferencias del número de Shalom;
// si en sus minutos no la atendió, sube a Yohalis; después a Frank. El último
// escalón no escala más: no hay a quién avisar después.
//
// LA ESCALERA SUMA, NO TRASPASA. Escalar amplía quién la ve; no se la quita a
// nadie. A Gerardo le queda delante hasta que se resuelva, y a los 30 minutos
// le aparece ADEMÁS a Yohalis, y después a Frank: llegado ese punto la tienen
// los tres a la vez. Quitársela al primero sería dar por hecho que ya no va a
// atenderla —falso, suele estar a punto— y además le ocultaría el final de un
// trabajo que empezó él. Sigue habiendo UN responsable de turno; lo que cambia
// es que los anteriores no se quedan a ciegas.
//
// NO MIRA SI ESTÁ CONECTADO, y es deliberado. La oferta aguanta sus minutos
// aunque tenga el navegador cerrado, porque es su trabajo y va a entrar. Si
// saltara al desconectarse, en la práctica todo acabaría en el último escalón
// el primer día.
//
// Todo esto es PURO: recibe la escalera, la alerta y la hora, y devuelve a
// quién ofrecérsela. Sin base ni reloj propio, para poder probar el minuto 29
// y el 31 sin esperar.

export interface EscalationStep {
  userId: string;
  /** Minutos que espera en este escalón antes de subir al siguiente. */
  minutes: number;
}

export interface AlertRouting {
  offeredTo: string | null;
  /** ISO. `null` = nunca se ofreció. */
  offeredAt: string | null;
  passed: readonly string[];
  claimedBy: string | null;
}

export interface OfferDecision {
  offeredTo: string;
  /**
   * Quiénes ya la tienen delante además del de turno. Se llama `passed` porque
   * nació como «dejaron pasar», pero desde que la escalera SUMA es la lista de
   * quienes la recibieron antes — y la siguen viendo.
   */
  passed: string[];
}

/**
 * Quién debería tener esta alerta ahora, o `null` si no hay nada que cambiar.
 *
 * Devuelve `null` en tres casos que NO son lo mismo pero se tratan igual —no
 * hay nada que hacer—: ya la tomó alguien, la oferta vigente todavía no venció,
 * o no hay escalera configurada.
 */
export function nextOffer(
  alert: AlertRouting,
  ladder: readonly EscalationStep[],
  nowMs: number,
): OfferDecision | null {
  if (alert.claimedBy) return null; // ya la está atendiendo alguien
  if (!ladder.length) return null; // sin escalera no hay a quién ofrecérsela

  // Primera vez: al primero de la escalera.
  if (!alert.offeredTo || !alert.offeredAt) {
    return { offeredTo: ladder[0]!.userId, passed: [...alert.passed] };
  }

  const idx = ladder.findIndex((s) => s.userId === alert.offeredTo);
  // El de turno ya no está en la escalera (lo sacaron de Ajustes): pasa al
  // primero que no haya dejado pasar, sin esperar — su turno ya no existe.
  if (idx < 0) {
    const libre = ladder.find((s) => !alert.passed.includes(s.userId));
    if (!libre) return null;
    return { offeredTo: libre.userId, passed: [...alert.passed] };
  }

  const vencimiento = Date.parse(alert.offeredAt) + ladder[idx]!.minutes * 60_000;
  if (!Number.isFinite(vencimiento) || nowMs < vencimiento) return null; // su turno sigue vivo

  // Venció: sube al siguiente que quede. El ÚLTIMO no escala — ahí se queda,
  // y que se quede es la respuesta correcta: alguien tiene que ser el final.
  const siguiente = ladder.slice(idx + 1).find((s) => !alert.passed.includes(s.userId));
  if (!siguiente) return null;
  return { offeredTo: siguiente.userId, passed: [...alert.passed, alert.offeredTo] };
}

/**
 * ¿Esta alerta le sale a esta persona?
 *
 * A quien la tiene de turno y a TODOS los que ya la tuvieron antes. Es la regla
 * de «la escalera suma»: escalar añade ojos, no traspasa el problema. Por eso
 * se responde aquí y no con un `where offered_to = yo` suelto en una consulta —
 * la definición de «me toca» tiene que estar en un sitio y poder probarse.
 */
export function alertVisibleTo(alert: AlertRouting, userId: string): boolean {
  if (!userId) return false;
  return alert.offeredTo === userId || alert.passed.includes(userId);
}

/** Cuánto lleva esperando, en minutos. Para pintarlo en la pantalla. */
export function waitingMinutes(createdAt: string, nowMs: number): number {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((nowMs - t) / 60_000));
}
