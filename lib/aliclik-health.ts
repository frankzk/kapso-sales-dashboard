// Semáforo de salud de la API de Aliclik.
//
// PARA QUÉ. Su API de cotización cae por rachas (500 "Internal server error").
// Cuando pasa, la asesora reintenta a ciegas y pierde minutos. Este módulo
// sondea la API cada pocos minutos y deja un estado que el drawer pinta como un
// foco: verde (operativo), rojo (fallos generalizados) o gris (sin monitoreo).
//
// AISLADO DEL FLUJO DE GUÍAS. No bloquea nada: es una PISTA. Un pin puntual puede
// fallar con la API verde, o funcionar con la API roja —los fallos son a veces
// puntuales y a veces amplios—, así que el foco responde a "¿está caída ahora?",
// no a "¿va a funcionar mi pin?". Para eso último está el mensaje del botón.
//
// CONECTADO AL MISMO SISTEMA. La sonda cotiza por el MISMO Edge y el mismo token
// que las cotizaciones reales; si saliera por otro camino, no reflejaría lo que
// vive la asesora.
//
// DOS CAMINOS, DOS SALUDES. Cotizar y crear son endpoints distintos y se caen por
// separado: el 10-08 se crearon 15 guías sin un fallo hasta las 10:44, y a las
// 11:19 la creación empezó a irse en timeout mientras la sonda de cotización
// seguía 3/3 en ~1 s. El foco decía «Aliclik operativo» y la asesora pulsaba
// crear confiando en él — para comerse un timeout que deja el pedido bloqueado
// 90 minutos (MOM §10.2). Un solo verde para dos caminos miente justo cuando más
// caro sale.
//
// LA CREACIÓN NO SE PUEDE SONDEAR. Crear un pedido es una escritura irreversible
// con dinero real: no hay forma de "probar si funciona" sin crear una guía de
// verdad. Por eso su salud NO se sondea, se DEDUCE de los intentos que la
// operación ya hizo — que es telemetría que de todos modos se guarda en
// `aliclik_order_requests`. La sonda activa se queda donde es segura: cotizar.

import { quoteShippingCost, type AliclikClientOpts } from "@/lib/aliclik";
import { toAliclikCoord } from "@/lib/aliclik-geo";

/** Salud del camino de COTIZACIÓN, la que sondea el cron. */
export type AliclikHealth = "operativo" | "fallos" | "sin_monitoreo";

/** Salud del camino de CREACIÓN, deducida de los intentos reales. */
export type AliclikCreateHealth = "ok" | "degradado" | "sin_datos";

/** Las dos juntas: lo que el drawer necesita para pintar un foco honesto. */
export interface AliclikHealthState {
  quote: AliclikHealth;
  create: AliclikCreateHealth;
}

/** Lo que la sonda escribe en cada pasada. `operativo`/`fallos` solamente: el
 * gris no se guarda, se DEDUCE de que no haya sonda reciente. */
export type AliclikHealthStatus = "operativo" | "fallos";

/**
 * Puntos de referencia para el sondeo. Elegidos a propósito: tres ciudades
 * grandes con cobertura COD densa y estable (centro de Lima, Arequipa y
 * Trujillo). Que uno falle no declara caída —los fallos punto-específicos que
 * hemos visto son reales—, por eso se exige MAYORÍA para dar "fallos". Con tres
 * puntos, basta que dos respondan para llamarlo operativo.
 */
export const HEALTH_REFERENCE_POINTS: readonly { name: string; lat: number; lng: number }[] = [
  { name: "Lima · San Isidro", lat: -12.0976, lng: -77.0365 },
  { name: "Arequipa · Cercado", lat: -16.3989, lng: -71.535 },
  { name: "Trujillo · Cercado", lat: -8.112, lng: -79.0288 },
];

/** Una sonda ya no cuenta como "fresca" pasado esto. El cron corre cada 5 min,
 * así que en horario laboral siempre hay una < 5 min; de noche no hay ninguna y
 * el estado cae a gris solo. 12 min = 2 pasadas y algo de margen. */
export const HEALTH_FRESHNESS_MS = 12 * 60_000;

/**
 * Resuelve el foco a partir de la última sonda guardada. PURA.
 *
 * Gris ("sin_monitoreo") cuando no hay sonda, cuando la última es vieja (de
 * noche, o si el cron se cayó) o si su fecha viene del futuro (reloj torcido).
 * Un verde viejo sería mentira, y de noche —sin sondeo, como se pidió— el foco
 * apagado es lo honesto.
 */
export function resolveAliclikHealth(
  latest: { status: string; checkedAt: string } | null | undefined,
  nowMs: number,
  freshnessMs: number = HEALTH_FRESHNESS_MS,
): AliclikHealth {
  if (!latest) return "sin_monitoreo";
  const at = Date.parse(latest.checkedAt);
  if (!Number.isFinite(at)) return "sin_monitoreo";
  const age = nowMs - at;
  if (age > freshnessMs || age < -60_000) return "sin_monitoreo";
  return latest.status === "operativo" ? "operativo" : latest.status === "fallos" ? "fallos" : "sin_monitoreo";
}

/**
 * Ventana en la que un intento de creación todavía dice algo del estado de ahora.
 * Más corta que la frescura de la sonda porque las creaciones son esporádicas: si
 * la última fue hace media hora, ya no describe el presente.
 */
export const CREATE_WINDOW_MS = 30 * 60_000;

/**
 * Cuántos fallos seguidos hacen falta para encender el aviso.
 *
 * Uno no basta: un timeout suelto pasa con la API sana y encender el foco por él
 * sería ruido que enseña a ignorarlo. Dos seguidos, sin ningún éxito después, ya
 * es un patrón — es exactamente lo que se vio el 10-08 (11:19 y 11:23).
 */
export const CREATE_FAILURE_STREAK = 2;

/** Un intento de creación, tal y como quedó en `aliclik_order_requests`. */
export interface CreateAttempt {
  status: string;
  error: string | null;
  createdAt: string;
}

/**
 * Cómo cuenta un intento para la salud del camino de creación.
 *
 * `pending` SIN error es una creación en vuelo —la fila se escribe antes del
 * POST—, no un fallo: se ignora. `pending` CON error ya pasó por el camino malo
 * (timeout), y ese sí cuenta.
 */
function outcomeOf(attempt: CreateAttempt): "ok" | "bad" | "skip" {
  if (attempt.status === "sent" || attempt.status === "duplicate") return "ok";
  if (attempt.status === "failed") return "bad";
  if (attempt.status === "pending") return attempt.error ? "bad" : "skip";
  return "skip";
}

/**
 * Salud del camino de creación a partir de los intentos recientes. PURA.
 *
 * Mira la RACHA MÁS RECIENTE: se recorren los intentos del más nuevo al más
 * viejo y se cuentan los fallos hasta topar con el primer éxito. Así el foco se
 * apaga solo en cuanto una creación vuelve a funcionar, sin esperar a que la
 * ventana se vacíe — que es como debe comportarse algo que la asesora mira para
 * decidir si pulsar ahora.
 *
 * Sin intentos que valgan, `sin_datos`: de madrugada o en una hora floja no hay
 * nada que decir, y callar es más honesto que dar por bueno lo que no se ha
 * visto.
 */
export function resolveAliclikCreateHealth(
  attempts: readonly CreateAttempt[],
  nowMs: number,
  opts: { windowMs?: number; streak?: number } = {},
): AliclikCreateHealth {
  const windowMs = opts.windowMs ?? CREATE_WINDOW_MS;
  const streak = opts.streak ?? CREATE_FAILURE_STREAK;

  const recent = attempts
    .map((a) => ({ ...a, at: Date.parse(a.createdAt) }))
    // Una fecha ilegible no puede ordenarse; incluirla movería la racha al azar.
    .filter((a) => Number.isFinite(a.at) && nowMs - a.at <= windowMs && nowMs - a.at >= -60_000)
    .sort((a, b) => b.at - a.at);

  let consecutive = 0;
  let seenAny = false;
  for (const attempt of recent) {
    const outcome = outcomeOf(attempt);
    if (outcome === "skip") continue;
    seenAny = true;
    if (outcome === "ok") break;
    consecutive++;
    if (consecutive >= streak) return "degradado";
  }

  return seenAny ? "ok" : "sin_datos";
}

/**
 * ¿Es horario laboral en Perú (7am–11pm)? El sondeo solo corre en esa ventana;
 * fuera de ella no hay foco (gris), que es lo acordado. Perú es UTC−5 fijo.
 *
 * Se sondea con la hora en [7, 22]: la última pasada cae ~22:55, y como una
 * sonda vale 12 min, el foco sigue vivo hasta pasadas las 23:00.
 */
export function withinBusinessHoursPeru(now: Date): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Lima",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now),
  );
  return hour >= 7 && hour <= 22;
}

export type HealthTone = "verde" | "ambar" | "rojo" | "gris";

export interface HealthBadgeCopy {
  tone: HealthTone;
  label: string;
  hint: string;
}

/**
 * Qué foco pintar con las dos saludes. PURA.
 *
 * PRECEDENCIA. La cotización caída gana: si su servidor no responde, no hay nada
 * que crear y decirlo una sola vez basta. Por debajo va el caso nuevo —cotiza
 * bien pero crear falla—, que antes se pintaba VERDE y era el más caro de todos:
 * la asesora confiaba en el foco, pulsaba, y se llevaba un pedido bloqueado.
 *
 * El aviso de creación nombra la consecuencia, no el síntoma. «Falla al crear»
 * sin más invita a reintentar; lo que hay que saber es que cada intento cuesta
 * el pedido bloqueado un rato.
 */
export function describeAliclikHealth(state: AliclikHealthState): HealthBadgeCopy {
  if (state.quote === "fallos") {
    return {
      tone: "rojo",
      label: "Aliclik con fallos",
      hint: "Su API de cotización está fallando ahora mismo; conviene reintentar en unos minutos.",
    };
  }
  if (state.create === "degradado") {
    return {
      tone: "ambar",
      label: "Aliclik: crear guías falla",
      hint:
        "Cotizar funciona, pero las últimas creaciones se fueron en timeout. Cada intento deja el " +
        "pedido bloqueado hasta que el barrido comprueba si la guía llegó a existir: espera unos " +
        "minutos antes de crear.",
    };
  }
  if (state.quote === "sin_monitoreo") {
    return {
      tone: "gris",
      label: "Sin monitoreo",
      hint: "Sin sondeo reciente (fuera del horario 7am–11pm, o el monitor no ha corrido).",
    };
  }
  return {
    tone: "verde",
    label: "Aliclik operativo",
    hint:
      state.create === "ok"
        ? "La API de cotización responde normal y las últimas guías se crearon bien."
        : "La API de cotización responde normal. Sin creaciones recientes que informen del otro camino.",
  };
}

export interface HealthProbeResult {
  status: AliclikHealthStatus;
  probesTotal: number;
  probesOk: number;
  latencyMs: number;
  detail: { point: string; ok: boolean; httpStatus: number | null; couriers: number }[];
}

/**
 * Sondea los puntos de referencia y decide operativo/fallos por mayoría.
 *
 * "ok" = la API respondió un 200 válido (no 500 ni timeout). NO se exige que
 * haya couriers: el foco mide si su servidor RESPONDE, que es justo lo que se
 * cae; la cobertura de un punto es otra cosa. Aun así se guardan los couriers
 * hallados por punto, para el histórico.
 */
export async function runAliclikHealthProbe(
  opts: AliclikClientOpts,
  warehouseId: number,
): Promise<HealthProbeResult> {
  const started = Date.now();
  const detail: HealthProbeResult["detail"] = [];
  for (const point of HEALTH_REFERENCE_POINTS) {
    const quote = await quoteShippingCost(opts, {
      warehouseId,
      lat: toAliclikCoord(point.lat),
      lng: toAliclikCoord(point.lng),
    });
    detail.push({
      point: point.name,
      ok: quote.ok,
      httpStatus: quote.ok ? 200 : quote.status,
      couriers: quote.ok ? (quote.data.couriers ?? []).length : 0,
    });
  }
  const probesOk = detail.filter((d) => d.ok).length;
  const needed = Math.ceil(HEALTH_REFERENCE_POINTS.length / 2); // 2 de 3
  return {
    status: probesOk >= needed ? "operativo" : "fallos",
    probesTotal: detail.length,
    probesOk,
    latencyMs: Date.now() - started,
    detail,
  };
}
