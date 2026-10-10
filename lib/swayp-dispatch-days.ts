// Los días en que Swayp despacha: de LUNES A SÁBADO (owner, 10-10-2026).
//
// El selector de fecha nativo no deja apagar días sueltos, así que se elegía un
// domingo sin aviso y la guía salía con una fecha en la que Swayp no reparte.
// Las pantallas ofrecen solo los días válidos (`swaypDispatchDayOptions`) y el
// servidor rechaza el domingo igual (`isSwaypDispatchDay`): un botón que no se
// pinta no es una regla. Sin dependencias, para que lo use el navegador.

export const SWAYP_SUNDAY_ERROR = "Swayp no despacha los domingos: elige una fecha de lunes a sábado.";

/** El día de la semana de una clave YYYY-MM-DD, sin depender de la zona del navegador. */
function weekday(dayKey: string): number {
  return new Date(`${dayKey.slice(0, 10)}T12:00:00Z`).getUTCDay();
}

/**
 * ¿Swayp despacha ese día? Recibe la clave del día o el ISO que guarda la app
 * para una fecha elegida (medianoche UTC de ese día, como `isFutureShipmentFollowup`).
 */
export function isSwaypDispatchDay(dayKeyOrIso: string | null | undefined): boolean {
  const key = (dayKeyOrIso ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  return weekday(key) !== 0;
}

function addDays(dayKey: string, days: number): string {
  const d = new Date(`${dayKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Los próximos `count` días de despacho DESPUÉS de `todayKey` (Swayp arma la
 * ruta del día siguiente), sin domingos. El primero lleva «mañana» si lo es.
 */
export function swaypDispatchDayOptions(todayKey: string, count = 24): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (let i = 1; out.length < count && i <= count * 2; i += 1) {
    const value = addDays(todayKey, i);
    if (!isSwaypDispatchDay(value)) continue;
    const label = new Date(`${value}T12:00:00Z`).toLocaleDateString("es-PE", {
      weekday: "long",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
    out.push({ value, label: i === 1 ? `Mañana · ${label}` : label });
  }
  return out;
}

/** El primer día de despacho después de `todayKey`. */
export function firstSwaypDispatchDay(todayKey: string): string {
  return swaypDispatchDayOptions(todayKey, 1)[0]!.value;
}
