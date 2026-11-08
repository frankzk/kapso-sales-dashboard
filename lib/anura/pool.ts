// «Llamar con Anura»: las líneas compartidas (pool de anexos, 08-11-2026;
// MOM §8.7 «Líneas compartidas»). Las reglas puras: sin red, sin secretos y
// sin módulos de Node; lo importan el servidor, la ficha y Ajustes por igual.
//
// LA DECISIÓN. Pedido por el owner (08-11-2026): «¿no puede ser algo
// dinámico… el anexo asignado aleatoriamente?». En vez de un anexo por
// persona, la org tiene unas pocas líneas compartidas (empieza con 3; el plan
// permite hasta 10, y sirve para cualquier N), y quien tiene la casilla
// «Puede llamar con Anura» toma una LIBRE al llamar.
//
// EL ORDEN. La línea se elige cuando el navegador pide la clave (tiene que
// registrarse con ESA línea antes del Click2Dial): el servidor RESERVA una
// libre escribiendo la fila de la llamada para esa línea (la base no deja
// dos vivas en una línea), entrega la clave de esa línea y nada más, y
// después pide el Click2Dial SOLO con esa reserva, sin volver a elegir. Se
// prueba primero la que menos se usó y, entre las que empatan, al azar
// (`orderPoolCandidates`).
//
// Lo prueba `test/anura-pool.test.ts`.

import type { AnuraKaptaPhoneStatus } from "@/lib/anura/sip";

/** Una reserva que no llegó a pedir el Click2Dial se suelta a los 60 s. */
export const ANURA_UNDIALED_RESERVATION_MS = 60_000;

/** El motivo con que se suelta una reserva que nunca llegó a pedirse. No es un intento de contacto. */
export const ANURA_UNDIALED_REASON = "La llamada no llegó a pedirse.";

/** Todas las líneas tienen una llamada viva. */
export function anuraLinesBusyMessage(total: number): string {
  return total === 1
    ? "La línea de Anura está ocupada. Intenta en un momento."
    : `Las ${total} líneas de Anura están ocupadas. Intenta en un momento.`;
}

export const ANURA_LINES_BUSY_TITLE = "Líneas de Anura ocupadas";

/** No hay ninguna línea compartida que se pueda usar (sin clave, rechazada, apagada…). */
export const ANURA_NO_POOL_LINES =
  "No hay líneas compartidas de Anura listas para llamar. Pide a quien administra que revise Ajustes › Telefonía Anura.";

/** La reserva se soltó (pasó el minuto) antes de pedir el Click2Dial. */
export const ANURA_RESERVATION_LOST =
  "La línea de Anura reservada para esta llamada se liberó antes de pedirla. Vuelve a intentar.";

/** Una línea compartida solo se usa con el teléfono de Kapta (su principal es la «-websocket»). */
export const ANURA_POOL_NEEDS_KAPTA_PHONE =
  "Las líneas compartidas de Anura se usan con el teléfono de Kapta. Recarga la página y vuelve a intentar.";

/** Una línea compartida sin su clave de la «-websocket» no llama (su principal es esa terminal). */
export function anuraPoolLineNeedsKey(extension: string): string {
  return `La línea ${extension} es compartida y solo llama con el teléfono de Kapta: guarda la clave de la «${extension}-websocket» en «Líneas compartidas».`;
}

/** Sin anexo propio ni la casilla «Puede llamar con Anura». */
export const ANURA_NOT_A_CALLER =
  "No tienes «Puede llamar con Anura» ni un anexo propio. Pídelo a quien administra (Ajustes › Telefonía Anura).";

/** «2 de 3 líneas libres». */
export function anuraFreeLinesLabel(free: number, total: number): string {
  return total === 1 ? `${free} de 1 línea libre` : `${free} de ${total} líneas libres`;
}

/**
 * El orden en que se intentan las líneas libres: primero la que lleva más
 * tiempo sin usarse (una que nunca se usó va antes que todas) y, entre las
 * que empatan, al azar. `lastUsedMs`: la última llamada de cada anexo.
 */
export function orderPoolCandidates<T extends { extension: string }>(
  lines: readonly T[],
  lastUsedMs: ReadonlyMap<string, number>,
  random: () => number = Math.random,
): T[] {
  return lines
    .map((line) => ({ line, last: lastUsedMs.get(line.extension) ?? Number.NEGATIVE_INFINITY, tie: random() }))
    .sort((a, b) => (a.last === b.last ? a.tie - b.tie : a.last < b.last ? -1 : 1))
    .map((x) => x.line);
}

/** ¿Es una reserva de línea que todavía no pidió el Click2Dial? */
export function isUndialedReservation(row: { reserved_at?: string | null; dialed_at?: string | null }): boolean {
  return Boolean(row.reserved_at) && !row.dialed_at;
}

/**
 * Cómo está una línea compartida, para Ajustes:
 *   · `apagada`: quien administra la apagó; no se elige.
 *   · `sin_clave` / `clave_rechazada` / `dominio_no_reconocido` /
 *     `sin_dominio`: no se puede usar (falta o falla su clave de la
 *     «-websocket», o la central no tiene dominio).
 *   · `en_uso`: tiene una llamada viva (dice de quién).
 *   · `libre`: se puede tomar ahora.
 */
export type AnuraPoolLineStatus = "libre" | "en_uso" | "apagada" | "sin_clave" | "clave_rechazada" | "dominio_no_reconocido" | "sin_dominio";

export function anuraPoolLineStatus(input: { active: boolean; phoneStatus: AnuraKaptaPhoneStatus; live: boolean }): AnuraPoolLineStatus {
  if (input.live) return "en_uso";
  if (!input.active) return "apagada";
  switch (input.phoneStatus) {
    case "listo":
      return "libre";
    case "sin_telefono":
      return "sin_clave";
    default:
      return input.phoneStatus;
  }
}

/** ¿La línea sirve para llamar (aunque ahora esté en uso)? */
export function anuraPoolLineUsable(input: { active: boolean; phoneStatus: AnuraKaptaPhoneStatus }): boolean {
  return input.active && input.phoneStatus === "listo";
}

/** La chapa de una línea en Ajustes. */
export function anuraPoolLineBadge(status: AnuraPoolLineStatus, byName: string | null): { label: string; tone: "neutral" | "ok" | "warn" | "crit" } {
  switch (status) {
    case "libre":
      return { label: "Libre", tone: "ok" };
    case "en_uso":
      return { label: byName ? `En uso por ${byName}` : "En uso", tone: "warn" };
    case "apagada":
      return { label: "Apagada", tone: "neutral" };
    case "sin_clave":
      return { label: "Sin clave", tone: "neutral" };
    case "clave_rechazada":
      return { label: "Clave rechazada", tone: "crit" };
    case "dominio_no_reconocido":
      return { label: "Dominio no reconocido", tone: "crit" };
    case "sin_dominio":
      return { label: "Falta el dominio", tone: "warn" };
  }
}

/**
 * Los pasos en el panel de Anura para CADA línea compartida (MOM §8.7,
 * «Líneas compartidas»). Lo que va entre comillas invertidas se muestra como
 * código.
 */
export const ANURA_POOL_PANEL_STEPS: readonly string[] = [
  "Crea el anexo en Configuración → Cuentas (por ejemplo 201, 202 y 203). No es de ninguna asesora: lo usa quien llama.",
  "En Terminales, la `<anexo>-websocket` encendida como principal (en el 201, `201-websocket`).",
  "En Avanzado → «Click 2 Dial», Auto answer apagado.",
  "En Límites, celulares permitidos.",
  "En Eventos, los tres (`START`, `TALK` y `END`, «Entrante/Saliente») con la plantilla «Kapta».",
  "En Terminales → lápiz de la -websocket → «Obtener credenciales»: el usuario y la contraseña SIP, que van en Kapta con «Probar y guardar».",
];

/** Lo que hay que preguntarle a Anura antes de sumar líneas. */
export const ANURA_POOL_CHANNELS_QUESTION =
  "Pregúntale a Anura cuántas llamadas salientes simultáneas (canales) permite el plan: si son menos que las líneas, las de más fallan aunque Kapta las vea libres.";
