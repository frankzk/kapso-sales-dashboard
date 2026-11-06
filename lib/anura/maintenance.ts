// El mantenimiento de «Llamar con Anura» (MOM §8.7, «El cron de Anura»). Lo
// corre `/api/cron/anura-recordings` cada 10 minutos (a los :01, :11, :21,
// :31, :41 y :51; vercel.json) con el cliente service role, en TODAS las
// organizaciones. SERVIDOR.
//
// POR QUÉ EXISTE. La ficha del pedido reintenta la copia de una grabación y
// suelta las llamadas colgadas al abrirse, pero las llamadas de PRUEBA y las
// ENTRANTES no tienen ficha: si la copia del aviso de fin fallaba, quedaban
// «pendiente» para siempre, y el enlace de Anura vence a los 30 minutos.
//
// QUÉ HACE, en este orden (cada paso solo toca lo que sigue pendiente, así
// que correrlo dos veces no hace nada de más):
//   1. Suelta las llamadas que Anura dejó colgadas (`releaseStaleAnuraCalls`,
//      las mismas reglas de la ficha: 60 s sin avisos, 2 h sin fin).
//   2. Marca «vencida» las «pendiente» cuyo enlace ya pasó los 30 minutos (o
//      sin fecha de vencimiento) y las que ya gastaron sus 6 intentos. La
//      escritura repite la condición de la lectura: si entretanto llegó otro
//      aviso de fin (enlace nuevo, intentos en 0), esa fila no se toca, y solo
//      se borran los enlaces de las que sí se marcaron.
//   3. Reintenta copiar las «pendiente» que siguen a tiempo, de la más antigua
//      a la más nueva, hasta `ANURA_MAINTENANCE_COPY_LIMIT` y mientras quede
//      presupuesto. Deja 2 minutos a la copia que lanza el aviso de fin.
//   4. Poda la bitácora: los avisos de más de 30 días y el enlace de Anura de
//      los avisos que ya no lo necesitan (grabación guardada o vencida, aviso
//      sin llamada de Kapta, o enlace ya vencido).
//
// NUNCA escribe teléfonos, enlaces ni mensajes de la base en su reporte: solo
// conteos y motivos fijos.

import type { SupabaseClient } from "@supabase/supabase-js";
import { releaseStaleAnuraCallsReport } from "@/lib/anura/calls";
import { ANURA_EVENT_RETENTION_DAYS, ANURA_RECORDING_TTL_MS, ANURA_STALE_REQUEST_MS, ANURA_STUCK_CALL_MS } from "@/lib/anura/events";
import {
  ANURA_RECORDING_EXPIRED_ERROR,
  ANURA_RECORDING_FETCH_TIMEOUT_MS,
  ANURA_RECORDING_MAX_ATTEMPTS,
  RECORDING_CALL_COLUMNS,
  retryAnuraRecording,
  type RecordingCallRow,
  type RecordingOutcome,
} from "@/lib/anura/recording";

/** `maxDuration` de la ruta (literal allá: Next lo lee sin ejecutar el módulo). */
export const ANURA_MAINTENANCE_MAX_DURATION_S = 60;
/**
 * Tiempo para EMPEZAR copias. Una que empieza al borde todavía tiene su
 * descarga (20 s como mucho) y la subida antes de `maxDuration`.
 */
export const ANURA_MAINTENANCE_COPY_BUDGET_MS = 25_000;
/** Copias por pasada. Lo que no cupo sigue en la siguiente (10 min después). */
export const ANURA_MAINTENANCE_COPY_LIMIT = 20;
/** Filas por paso de «vencida» y de enlaces revisados. */
export const ANURA_MAINTENANCE_BATCH = 200;
/** La copia que lanza el aviso de fin tiene este margen antes de que el cron la toque. */
export const ANURA_MAINTENANCE_END_GRACE_MS = 2 * 60_000;
/** Un enlace de Anura con más de esto ya no sirve: se borra de la bitácora. */
export const ANURA_MAINTENANCE_URL_DEAD_MS = ANURA_RECORDING_TTL_MS + 5 * 60_000;

export const ANURA_RECORDING_ATTEMPTS_ERROR = "No se pudo copiar la grabación después de 6 intentos.";

export interface AnuraMaintenanceReport {
  ok: boolean;
  dry: boolean;
  ms: number;
  /** Llamadas colgadas que se cerraron (en `dry`, las que se cerrarían). */
  liberadas: number;
  /** Grabaciones que pasaron a «vencida» sin intentarlo (en `dry`, las que pasarían). */
  vencidas: number;
  /** Lo que dio cada reintento de copia (en `dry`, todo en 0). */
  copias: Record<RecordingOutcome, number>;
  /** «Pendiente» a tiempo que esperan copia (en `dry`, las que se intentarían). */
  porCopiar: number;
  /** Las que no cupieron en el presupuesto: siguen en la próxima pasada. */
  sinTiempo: number;
  /** Avisos de más de 30 días borrados (en `dry`, los que se borrarían). */
  avisosBorrados: number;
  /** Avisos a los que se les borró el enlace de Anura. */
  enlacesBorrados: number;
  /** Motivos cortos y fijos, sin valores de la base. */
  errors: string[];
}

export interface AnuraMaintenanceDeps {
  now?: () => Date;
  fetchImpl?: typeof fetch;
  extraHosts?: readonly string[];
  budgetMs?: number;
  copyLimit?: number;
  timeoutMs?: number;
}

const emptyCopies = (): Record<RecordingOutcome, number> => ({ guardada: 0, pendiente: 0, vencida: 0, omitida: 0 });

type IdRow = { id: string };
type CallIdRow = { call_id: string | null };

const ids = (rows: unknown): string[] => ((rows ?? []) as IdRow[]).map((r) => r.id).filter(Boolean);

async function countStale(admin: SupabaseClient, now: Date): Promise<number> {
  const [req, stuck] = await Promise.all([
    admin
      .from("anura_calls")
      .select("id")
      .eq("status", "solicitada")
      .in("mode", ["pedido", "prueba"])
      .lt("requested_at", new Date(now.getTime() - ANURA_STALE_REQUEST_MS).toISOString())
      .limit(1000),
    admin
      .from("anura_calls")
      .select("id")
      .in("status", ["sonando", "en_curso"])
      .in("mode", ["pedido", "prueba"])
      .lt("last_event_at", new Date(now.getTime() - ANURA_STUCK_CALL_MS).toISOString())
      .limit(1000),
  ]);
  if (req.error || stuck.error) throw new Error("stale");
  return ids(req.data).length + ids(stuck.data).length;
}

/**
 * Por qué una «pendiente» ya no se puede copiar: el enlace venció (`vencido`),
 * no tiene fecha de vencimiento (`sinFecha`) o ya gastó sus intentos
 * (`sinIntentos`).
 */
type DeadKind = "vencido" | "sinFecha" | "sinIntentos";
const DEAD_KINDS: readonly DeadKind[] = ["vencido", "sinFecha", "sinIntentos"];

/**
 * La condición de cada motivo sobre `anura_calls`, además de «pendiente». La
 * usan la lectura y la escritura: así un aviso de fin que llegue entre las
 * dos (enlace nuevo, 30 minutos más, intentos en 0) deja la fila fuera.
 */
function deadFilter<Q extends { lte(c: string, v: string): Q; is(c: string, v: null): Q; gte(c: string, v: number): Q }>(
  q: Q,
  kind: DeadKind,
  nowIso: string,
): Q {
  if (kind === "vencido") return q.lte("recording_expires_at", nowIso);
  if (kind === "sinFecha") return q.is("recording_expires_at", null);
  return q.gte("recording_attempts", ANURA_RECORDING_MAX_ATTEMPTS);
}

/** Las «pendiente» que ya no se pueden copiar, por motivo. */
async function deadPending(admin: SupabaseClient, nowIso: string): Promise<Record<DeadKind, string[]>> {
  const found = await Promise.all(
    DEAD_KINDS.map((kind) =>
      deadFilter(admin.from("anura_calls").select("id").eq("recording_status", "pendiente"), kind, nowIso).limit(ANURA_MAINTENANCE_BATCH),
    ),
  );
  if (found.some((r) => r.error)) throw new Error("dead");
  const [vencido, sinFecha, sinIntentos] = found.map((r) => ids(r.data)) as [string[], string[], string[]];
  return { vencido, sinFecha, sinIntentos };
}

/**
 * Pasa a «vencida» las de ese motivo que TODAVÍA lo cumplen. Devuelve los ids
 * que de verdad cambió: solo a esos se les borra el enlace.
 */
async function markVencida(admin: SupabaseClient, callIds: string[], kind: DeadKind, nowIso: string): Promise<string[]> {
  if (!callIds.length) return [];
  const error = kind === "sinIntentos" ? ANURA_RECORDING_ATTEMPTS_ERROR : ANURA_RECORDING_EXPIRED_ERROR;
  const q = admin
    .from("anura_calls")
    .update({ recording_status: "vencida", recording_error: error })
    .in("id", callIds)
    .eq("recording_status", "pendiente");
  const { data, error: dbError } = await deadFilter(q, kind, nowIso).select("id");
  if (dbError) throw new Error("vencida");
  return ids(data);
}

/**
 * Borra el enlace de Anura de los avisos de estas llamadas que llegaron hasta
 * `receivedUpTo` (un aviso de fin posterior trae un enlace nuevo que todavía
 * sirve). Devuelve cuántos tocó.
 */
async function forgetUrls(admin: SupabaseClient, callIds: string[], receivedUpTo: string): Promise<number> {
  if (!callIds.length) return 0;
  const { data, error } = await admin
    .from("anura_webhook_events")
    .update({ recording_url: null })
    .in("call_id", callIds)
    .not("recording_url", "is", null)
    .lte("received_at", receivedUpTo)
    .select("id");
  if (error) throw new Error("enlaces");
  return ids(data).length;
}

/** Las «pendiente» que todavía están a tiempo y cuyo aviso de fin ya tuvo su margen. */
async function retryablePending(admin: SupabaseClient, now: Date, limit: number): Promise<RecordingCallRow[]> {
  const { data, error } = await admin
    .from("anura_calls")
    .select(RECORDING_CALL_COLUMNS)
    .eq("recording_status", "pendiente")
    .gt("recording_expires_at", now.toISOString())
    // El END llegó hace más de 2 minutos: vence en menos de 30 − 2.
    .lte("recording_expires_at", new Date(now.getTime() + ANURA_RECORDING_TTL_MS - ANURA_MAINTENANCE_END_GRACE_MS).toISOString())
    .lt("recording_attempts", ANURA_RECORDING_MAX_ATTEMPTS)
    .order("requested_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error("pendientes");
  return (data ?? []) as unknown as RecordingCallRow[];
}

async function purgeOldEvents(admin: SupabaseClient, now: Date, dry: boolean): Promise<number> {
  const cutoff = new Date(now.getTime() - ANURA_EVENT_RETENTION_DAYS * 86_400_000).toISOString();
  const q = dry
    ? admin.from("anura_webhook_events").select("id").lt("received_at", cutoff).limit(1000)
    : admin.from("anura_webhook_events").delete().lt("received_at", cutoff).select("id");
  const { data, error } = await q;
  if (error) throw new Error("bitácora");
  return ids(data).length;
}

/**
 * Los enlaces de Anura que ya no sirven: los avisos con más de 35 minutos
 * (el enlace venció) y, entre los recientes, los que no son de una llamada de
 * Kapta o cuya grabación ya quedó guardada o vencida.
 */
async function forgetUsedUrls(admin: SupabaseClient, now: Date): Promise<number> {
  const nowIso = now.toISOString();
  const dead = await admin
    .from("anura_webhook_events")
    .update({ recording_url: null })
    .not("recording_url", "is", null)
    .lt("received_at", new Date(now.getTime() - ANURA_MAINTENANCE_URL_DEAD_MS).toISOString())
    .select("id");
  if (dead.error) throw new Error("enlaces");
  let touched = ids(dead.data).length;

  const orphans = await admin
    .from("anura_webhook_events")
    .update({ recording_url: null })
    .not("recording_url", "is", null)
    .is("call_id", null)
    .select("id");
  if (orphans.error) throw new Error("enlaces");
  touched += ids(orphans.data).length;

  const recent = await admin
    .from("anura_webhook_events")
    .select("call_id")
    .not("recording_url", "is", null)
    .not("call_id", "is", null)
    .limit(ANURA_MAINTENANCE_BATCH);
  if (recent.error) throw new Error("enlaces");
  const callIds = [...new Set(((recent.data ?? []) as CallIdRow[]).map((r) => r.call_id).filter((v): v is string => !!v))];
  if (!callIds.length) return touched;
  const calls = await admin.from("anura_calls").select("id,recording_status").in("id", callIds);
  if (calls.error) throw new Error("enlaces");
  const live = new Set(((calls.data ?? []) as { id: string; recording_status: string }[]).filter((c) => c.recording_status === "pendiente").map((c) => c.id));
  // Sin fila (la llamada se borró con su pedido) o sin «pendiente»: nadie va a usar el enlace.
  touched += await forgetUrls(
    admin,
    callIds.filter((id) => !live.has(id)),
    nowIso,
  );
  return touched;
}

/** Corre la pasada entera. Nunca lanza: un paso que falla queda en `errors` y los demás siguen. */
export async function runAnuraMaintenance(
  admin: SupabaseClient,
  opts: { dry?: boolean } = {},
  deps: AnuraMaintenanceDeps = {},
): Promise<AnuraMaintenanceReport> {
  const clock = deps.now ?? (() => new Date());
  const started = clock().getTime();
  const dry = Boolean(opts.dry);
  const budgetMs = deps.budgetMs ?? ANURA_MAINTENANCE_COPY_BUDGET_MS;
  const report: AnuraMaintenanceReport = {
    ok: true,
    dry,
    ms: 0,
    liberadas: 0,
    vencidas: 0,
    copias: emptyCopies(),
    porCopiar: 0,
    sinTiempo: 0,
    avisosBorrados: 0,
    enlacesBorrados: 0,
    errors: [],
  };
  const fail = (motivo: string) => {
    report.ok = false;
    report.errors.push(motivo);
  };

  // 1. Las llamadas colgadas.
  try {
    if (dry) {
      report.liberadas = await countStale(admin, clock());
    } else {
      // Una pasada que no pudo escribir no es «0 liberadas»: es un error.
      const released = await releaseStaleAnuraCallsReport(admin, { all: true }, clock());
      report.liberadas = released.closed;
      if (released.failed) throw new Error("stale");
    }
  } catch {
    fail("No se pudieron revisar las llamadas colgadas.");
  }

  // 2. Lo que ya no se puede copiar.
  try {
    const nowIso = clock().toISOString();
    const dead = await deadPending(admin, nowIso);
    if (dry) {
      report.vencidas = new Set(DEAD_KINDS.flatMap((kind) => dead[kind])).size;
    } else {
      const marked: string[] = [];
      // En este orden: una vencida que además gastó sus intentos queda como vencida.
      for (const kind of DEAD_KINDS) marked.push(...(await markVencida(admin, dead[kind], kind, nowIso)));
      report.vencidas += marked.length;
      report.enlacesBorrados += await forgetUrls(admin, marked, nowIso);
    }
  } catch {
    fail("No se pudieron marcar las grabaciones vencidas.");
  }

  // 3. Las copias que siguen a tiempo.
  try {
    const pending = await retryablePending(admin, clock(), deps.copyLimit ?? ANURA_MAINTENANCE_COPY_LIMIT);
    report.porCopiar = pending.length;
    if (!dry) {
      for (let i = 0; i < pending.length; i += 1) {
        if (clock().getTime() - started >= budgetMs) {
          report.sinTiempo = pending.length - i;
          break;
        }
        const outcome = await retryAnuraRecording(admin, pending[i]!, {
          now: clock(),
          fetchImpl: deps.fetchImpl,
          extraHosts: deps.extraHosts,
          timeoutMs: deps.timeoutMs ?? ANURA_RECORDING_FETCH_TIMEOUT_MS,
        });
        report.copias[outcome] += 1;
      }
    }
  } catch {
    fail("No se pudieron reintentar las grabaciones pendientes.");
  }

  // 4. La bitácora.
  try {
    report.avisosBorrados = await purgeOldEvents(admin, clock(), dry);
  } catch {
    fail("No se pudo podar la bitácora de avisos.");
  }
  if (!dry) {
    try {
      report.enlacesBorrados += await forgetUsedUrls(admin, clock());
    } catch {
      fail("No se pudieron borrar los enlaces de grabación ya usados.");
    }
  }

  report.ms = clock().getTime() - started;
  return report;
}
