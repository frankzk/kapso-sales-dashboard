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

import { quoteShippingCost, type AliclikClientOpts } from "@/lib/aliclik";
import { toAliclikCoord } from "@/lib/aliclik-geo";

export type AliclikHealth = "operativo" | "fallos" | "sin_monitoreo";

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
