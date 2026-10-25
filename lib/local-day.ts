// El día local de una tienda, en instantes UTC. Módulo PURO: sin base de datos
// ni red, para que lo usen la lectura del servidor, el navegador y las pruebas.
//
// Una tienda vive en su zona (`stores.timezone`); su «hoy» empieza a la
// medianoche de esa zona, no a la de UTC (en Lima, cinco horas después).

/** La medianoche local de `date` (YYYY-MM-DD) en `timeZone`, como instante ISO. */
export function localMidnightUtc(date: string, timeZone: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const target = Date.UTC(year!, month! - 1, day!, 0, 0, 0);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]),
    );
    const rendered = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    guess += target - rendered;
  }
  return new Date(guess).toISOString();
}

/** `date` (YYYY-MM-DD) más `days` días de calendario. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

/** La fecha local (YYYY-MM-DD) y los minutos desde su medianoche de un instante. */
export function localClock(iso: string | Date, timeZone: string): { date: string; minute: number } {
  let formatter = clockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    clockFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(typeof iso === "string" ? new Date(iso) : iso).map((part) => [part.type, part.value]),
  );
  const hour = Number(parts.hour) % 24;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: hour * 60 + Number(parts.minute) };
}
