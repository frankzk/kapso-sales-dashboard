// La fecha en que Aliclik recogerá el paquete. Puro y testeado.
//
// POR QUÉ LA CALCULAMOS SI LA DECIDE ALICLIK. Su API de contra entrega no
// admite fecha —el esquema de `POST /integration/order` no la tiene— así que no
// hay nada que enviar: la calcula su servidor. Lo que hacemos aquí es saber QUÉ
// DEBERÍA HABER CALCULADO, por dos razones concretas:
//
//   1. Avisar a la asesora en el momento de crear, cuando la fecha que van a
//      poner no es la que el paquete va a tener de verdad.
//   2. Contar los incumplimientos. Su Excel exporta «FECHA DESPACHO»; comparada
//      con esta, cada diferencia es un caso que reclamarles con nombre y fecha
//      en vez de una queja general.
//
// LA REGLA ES LA SUYA, NO UNA NUESTRA. Está en su documentación, en las reglas
// de negocio de Crear pedido: «Courier estándar: la fecha de despacho se calcula
// contra `schedule`. Si cae en domingo, se desplaza al lunes.» No inventamos
// política: replicamos la suya para poder detectar cuándo no la cumplen.
//
// EL CORTE NO SE CODIFICA. `schedule` llega en la cotización, por courier y por
// almacén (`GET /integration/order/shipping/cost`). En la guía AUR5X846640592825
// valía "14:00" para ALIDRIVER, pero el ejemplo de su documentación trae "16:30"
// para Olva. Fijarlo aquí sería sembrar el próximo fallo.
//
// LOS FERIADOS NO CUENTAN: Aliclik recoge todos los días salvo el domingo.
// Verificado con la operación el 05-09-2026. Por eso no hay calendario que
// mantener, y es una suerte — un calendario desactualizado miente sin avisar.

import { limaDateKey, limaTimeHHMM, parseHHMM } from "@/lib/aliclik-geo";

const DAY_MS = 86_400_000;

/** Suma días a una fecha "YYYY-MM-DD" sin tocar zonas horarias. */
export function addDays(dateKey: string, days: number): string {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** Día de la semana de una fecha "YYYY-MM-DD" (0 = domingo). */
export function dayOfWeek(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

/**
 * La fecha de despacho que corresponde, según la regla de Aliclik.
 *
 *   - hasta la hora de corte (inclusive) → hoy
 *   - pasada la hora de corte           → mañana
 *   - si cae en domingo                 → lunes
 *
 * La comparación es ESTRICTAMENTE mayor, así que a las 14:00 clavadas todavía
 * es hoy y a las 14:01 pasa a mañana. Es la ventana tal como la describe la
 * operación, y el borde importa: son los pedidos de última hora los que acaban
 * en discusión con el motorizado.
 *
 * Sin `schedule` conocido se asume que no ha pasado el corte. Es lo mismo que
 * hace la ruta de agencia, y por el mismo motivo: retrasar un despacho por un
 * dato que nos falta cuesta más que acertar tarde. El salto del domingo sí se
 * aplica igual, porque ese no depende de la hora.
 */
export function expectedDispatchDate(
  schedule: string | null | undefined,
  now: Date = new Date(),
): string {
  const cutoff = parseHHMM(schedule);
  const nowMin = parseHHMM(limaTimeHHMM(now));

  let date = limaDateKey(now);
  if (cutoff !== null && nowMin !== null && nowMin > cutoff) date = addDays(date, 1);
  if (dayOfWeek(date) === 0) date = addDays(date, 1);
  return date;
}

/**
 * La fecha a la que llega su cálculo si SOLO aplica el corte y se olvida del
 * domingo — que es exactamente el fallo observado en AUR5X846640592825, creada
 * el sábado 29-08-2026 a las 14:13 de Lima y fechada para el domingo 30.
 *
 * Sirve para dos cosas: avisar antes de crear, y reconocer después la firma del
 * incumplimiento en su reporte.
 */
export function naiveDispatchDate(
  schedule: string | null | undefined,
  now: Date = new Date(),
): string {
  const cutoff = parseHHMM(schedule);
  const nowMin = parseHHMM(limaTimeHHMM(now));
  const date = limaDateKey(now);
  return cutoff !== null && nowMin !== null && nowMin > cutoff ? addDays(date, 1) : date;
}

/**
 * ¿Va a fechar Aliclik esta guía en domingo?
 *
 * Es `true` justo cuando el corte empuja al domingo y su regla debería moverla
 * al lunes. Solo en ese caso hay algo que advertir: el resto de los días su
 * cálculo y el nuestro coinciden y avisar sería ruido.
 */
export function dispatchFallsOnSunday(
  schedule: string | null | undefined,
  now: Date = new Date(),
): boolean {
  return dayOfWeek(naiveDispatchDate(schedule, now)) === 0;
}
