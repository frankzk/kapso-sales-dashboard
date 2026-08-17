import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { getStoreCreds } from "@/lib/ingest";
import { refreshAliclikOrder } from "@/lib/aliclik-track";
import { selectFollowUpGuides, followUpKey, type FollowUpCandidate } from "@/lib/aliclik-followup";
import {
  selectExpiredOrphans,
  type ExpiryCandidate,
  type SweepEvidence,
} from "@/lib/aliclik-orphan-expiry";
import { readSweepEvidence } from "@/lib/aliclik-sweep-state";
import { courierReason, RECOVERY_DEFAULT_MAX_DAYS } from "@/lib/return-recovery";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// El cierre de Aliclik: soltar los candados que ya no protegen nada y perseguir
// a las guías que se quedaron sin desenlace.
//
// POR QUÉ ES UN CRON APARTE. Las dos tareas vivían al final de
// `/api/cron/aliclik-reconcile`, detrás del bucle que recorre el listado por
// fechas. Ese bucle creció hasta agotar `maxDuration` y la invocación empezó a
// morir dentro de él: las nueve pasadas de las tres horas previas al 10-08-2026
// 22:00 terminaron en 504. El barrido parecía sano —cada pasada aplicaba
// estados antes de morir, y hasta rescató huérfanas— pero nada de lo que iba
// DESPUÉS del bucle llegó a ejecutarse jamás.
//
// El daño fue de los dos tipos que este cron evita ahora:
//   * un candado eterno — `#KP127355` pasó más de diez horas en 'pending', con
//     el pedido inoperable, porque la caducidad nunca corrió;
//   * y el más caro por callado — 515 guías `en_ruta` con una media de 8 días
//     sin noticias y hasta 40, porque el pase de rezagadas tampoco corría. Son
//     justo las devoluciones que el MOM §11 convierte en entrada a
//     Reproprovincia: sin ellas esa puerta no se abre.
//
// La lección no es que el barrido fuera lento, es que un trabajo colgado del
// final de otro más largo no tiene garantía de ejecutarse nunca. Aquí ambas
// tareas tienen su propio presupuesto, y ninguna depende de que la otra termine.
//
// LO QUE NO SE AFLOJÓ AL SEPARARLAS. Caducar un candado sigue exigiendo un
// barrido COMPLETO que haya buscado de verdad esa intención (MOM §10.2). Lo que
// cambia es de dónde sale esa prueba: antes de un booleano local, ahora de la
// constancia que el barrido deja en `aliclik_sweep_state` (0116). Si no consta
// un barrido completo y reciente, este cron no caduca nada — exactamente igual
// que antes fallaba hacia el lado seguro durante una caída de Aliclik.

const DAY_MS = 86_400_000;
/** Antigüedad mínima de una intención para considerarla huérfana. */
const ORPHAN_MIN_AGE_MS = 5 * 60_000;
/**
 * Cuándo se da por no creada una intención que el barrido nunca encuentra.
 *
 * Con el barrido cada 20 minutos son cuatro o cinco pasadas completas buscándola
 * por su marca antes de soltar el candado. El margen es deliberadamente amplio:
 * caducar de más crea una guía duplicada —dinero real, ventana de cancelación
 * corta— y caducar de menos solo cuesta esperar.
 */
const ORPHAN_EXPIRY_MS = 90 * 60_000;
/**
 * Cuánto vale la constancia de un barrido completo antes de quedar rancia.
 *
 * Con el barrido cada 20 minutos, dos horas son seis pasadas fallidas seguidas:
 * a esas alturas ya no sabemos si el pedido está en Aliclik o no, y volvemos al
 * lado seguro de no soltar ningún candado. Es la misma retención que protegía
 * durante una caída de Aliclik, sostenida ahora en el tiempo en vez de en una
 * sola pasada — y lo que la haría saltar (un barrido que deja de completarse)
 * se ve en `orphansHeld.noSweep` sin tener que mirar los logs.
 */
const SWEEP_MAX_AGE_MS = 120 * 60_000;
/**
 * Consultas individuales por tienda y pasada.
 *
 * Subió de 40 a 150 al mudarse aquí: antes compartía los 300 s con el recorrido
 * entero del listado y tenía que ser modesto, y ahora el presupuesto es suyo. Con
 * el cron cada 20 minutos son ~10.800 turnos al día, muy por encima de las 599
 * guías vivas — el atraso se drena en una hora en vez de en una tarde. El tope
 * real lo pone `FOLLOW_UP_BUDGET_MS`, que corta por tiempo antes que por cuenta.
 */
const FOLLOW_UP_LIMIT = 150;
/**
 * Cuándo se deja de preguntar por una guía que no responde. Un retorno tarda
 * semanas; dos meses de silencio ya es una guía que Aliclik nunca cerró.
 */
const FOLLOW_UP_MAX_SILENCE_MS = 60 * DAY_MS;
/**
 * Techo de filas que se traen para elegir a quién preguntar. No es una decisión
 * de producto: es el seguro contra el tope de filas de PostgREST, que truncaría
 * la consulta en silencio y recortaría el universo sin avisar. Se piden por
 * turno, así que un recorte se llevaría siempre a las que ya tuvieron el suyo.
 */
const FOLLOW_UP_POOL = 2000;
/**
 * Espejo de la ventana que `selectFollowUpGuides` le da a una anulada. Acá solo
 * recorta el pool para no arrastrar el histórico entero; quien decide de verdad
 * es el selector puro.
 */
const FOLLOW_UP_RETURN_WINDOW_MS = 21 * DAY_MS;
/** Consultas por pasada de la tercera vuelta (el motivo del courier, 0119). El
 *  atraso de ~100 guías se drena en poco más de una hora sin comerle el reloj a
 *  la persecución de rezagadas, que es la tarea larga de este cron. */
const REASON_PROBE_LIMIT = 30;
/** Cada cuánto se vuelve a preguntar por una guía que sigue sin motivo. Aliclik
 *  puede escribirlo tarde; repreguntar cada veinte minutos sería castigar a la
 *  API por un dato que casi nunca cambia. */
const REASON_PROBE_COOLDOWN_MS = 7 * DAY_MS;
/** Corte por reloj, por debajo de `maxDuration`: el corte tiene que ser nuestro. */
const FOLLOW_UP_BUDGET_MS = 230_000;
/** Cada cuántas consultas se sella el turno. Ver `flushAsked`. */
const ASKED_FLUSH = 25;

function secretEquals(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  const bearer = req.headers.get("authorization");
  if (bearer?.startsWith("Bearer ") && secretEquals(bearer.slice(7), secret)) return true;
  return secretEquals(req.nextUrl.searchParams.get("secret"), secret);
}

interface StoreReport {
  storeId: string;
  /** Minutos desde el último barrido completo. `null` si no consta ninguno. */
  sweepAgeMinutes: number | null;
  /** Intenciones dadas por no creadas: candado liberado, pedido reintentable. */
  orphansExpired: number;
  /** Caducadas sin que el barrido cubriera su fecha: piden ojo humano. */
  orphansExpiredUnverified: number;
  /** Las que siguen bloqueadas y por qué. Si no baja, hay algo que mirar. */
  orphansHeld: { tooYoung: number; ambiguous: number; noSweep: number; notSearched: number };
  /** Guías vivas consultadas de una en una. */
  followUpScanned: number;
  followUpApplied: number;
  /** Vivas que no cupieron en el tope de esta pasada; van en la siguiente. */
  followUpDeferred: number;
  /** Vivas que se dieron por abandonadas por llevar demasiado calladas. */
  followUpAbandoned: number;
  /** Consultadas que Aliclik ya no reconoce: quedan para revisión humana. */
  followUpMissing: number;
  /** `true` si el reloj cortó la cola antes que el tope de consultas. */
  followUpStoppedByBudget: boolean;
  /** Devoluciones sin motivo a las que se les preguntó por el motivo (0119). */
  reasonProbed: number;
  /** De esas, cuántas volvieron CON motivo: el MOM §11 ya se puede evaluar. */
  reasonFound: number;
  /** Las que ni así lo tienen. Si este número no baja, el dato no está en
   *  Aliclik y esas decisiones se seguirán tomando a ciegas. */
  reasonStillBlind: number;
  errors: string[];
}

const emptyReport = (storeId: string): StoreReport => ({
  storeId,
  sweepAgeMinutes: null,
  orphansExpired: 0,
  orphansExpiredUnverified: 0,
  orphansHeld: { tooYoung: 0, ambiguous: 0, noSweep: 0, notSearched: 0 },
  followUpScanned: 0,
  followUpApplied: 0,
  followUpDeferred: 0,
  followUpAbandoned: 0,
  followUpMissing: 0,
  followUpStoppedByBudget: false,
  reasonProbed: 0,
  reasonFound: 0,
  reasonStillBlind: 0,
  errors: [],
});

/**
 * Cierra las intenciones que Aliclik nunca llegó a crear.
 *
 * Es la salida que le faltaba al candado. Sin esto, una creación que se va en
 * timeout SIN que Aliclik cree nada deja la intención en 'pending' para siempre:
 * el único parcial de 0056 solo excluye 'failed', así que el pedido no vuelve a
 * admitir un intento y solo un UPDATE a mano lo desbloquea.
 *
 * El motivo se escribe en la propia fila y distingue los dos casos —ausencia
 * comprobada frente a caducidad por antigüedad—, porque quien lo lea después
 * necesita saber cuál de los dos fue. Se AÑADE al error original en lugar de
 * pisarlo: el timeout que la dejó aquí es la mitad del diagnóstico, y la fila es
 * lo que se le manda al soporte de Aliclik cuando hay que reclamar.
 *
 * Un fallo al cerrar una no detiene a las demás: cada una es independiente y la
 * siguiente pasada lo reintenta.
 */
async function expireStaleOrphans(
  storeId: string,
  admin: ReturnType<typeof createAdminSupabase>,
  sweep: SweepEvidence | null,
  now: Date,
  report: StoreReport,
): Promise<void> {
  // Solo las que el barrido no consiguió emparejar: las rescatadas ya quedaron
  // en 'sent' y no aparecen en esta consulta.
  const { data, error } = await admin
    .from("aliclik_order_requests")
    .select("id,order_id,created_at,error,ambiguous_at")
    .eq("store_id", storeId)
    .eq("status", "pending")
    .lt("created_at", new Date(now.getTime() - ORPHAN_MIN_AGE_MS).toISOString());

  if (error) {
    report.errors.push(`huérfanas: ${error.message}`);
    return;
  }
  const pending = data ?? [];
  if (!pending.length) return;

  const selection = selectExpiredOrphans(
    pending.map(
      (p): ExpiryCandidate => ({
        id: p.id,
        orderId: p.order_id,
        createdAt: p.created_at,
        ambiguousAt: p.ambiguous_at,
      }),
    ),
    { sweep, expiryMs: ORPHAN_EXPIRY_MS, sweepMaxAgeMs: SWEEP_MAX_AGE_MS, now },
  );
  report.orphansHeld = selection.held;
  const causeOf = new Map(pending.map((p) => [p.id, (p.error ?? "").trim()]));

  for (const decision of selection.expire) {
    const cause = causeOf.get(decision.id);
    const reason = cause ? `${cause} — ${decision.reason}` : decision.reason;

    // El `eq('status','pending')` es la guarda contra la carrera con el propio
    // POST: si la creación terminó bien entre la carga de huérfanas y este
    // punto, la fila ya está en 'sent' y aquí no se toca nada.
    const { data: closed, error: upErr } = await admin
      .from("aliclik_order_requests")
      .update({
        status: "failed",
        error: reason,
        completed_at: now.toISOString(),
      })
      .eq("id", decision.id)
      .eq("status", "pending")
      .select("id");

    if (upErr) {
      report.errors.push(`caducar intención ${decision.id}: ${upErr.message}`);
      continue;
    }
    if (!(closed ?? []).length) continue;

    report.orphansExpired++;
    if (!decision.verified) report.orphansExpiredUnverified++;
  }
}

/**
 * Las guías vivas a las que la ventana de fechas del barrido ya no llega.
 *
 * El barrido relee por rango de fechas, así que una guía que lleva más de dos
 * semanas abierta deja de aparecer y su estado se congela: la única forma de
 * moverla era que alguien subiera un Excel. Eso es exactamente lo que pasó con
 * las guías en POR DEVOLVER — el reporte amplio que traía DEVUELTO dejó de
 * subirse el 21-07 y quedaron 131 abiertas, con una mediana de 18 días y hasta
 * 38.
 *
 * Se consultan de una en una porque no hay forma de pedirle a Aliclik "estas
 * guías concretas" — solo rangos y búsqueda por número. `getOrder` no filtra por
 * fecha, así que alcanza cualquier antigüedad.
 *
 * ALCANZA TAMBIÉN A LAS DEL EXCEL. El identificador de consulta sale de
 * `followUpKey`: `external_order_number` si lo hay y `guide_code` si no. Sin ese
 * respaldo el pase dejaría fuera a casi la mitad de las guías vivas —las que
 * entraron por importación— que son justo las que se congelan.
 *
 * Lo que Aliclik ya no reconoce NO se toca: se cuenta en `followUpMissing`.
 * Cerrar una guía porque una búsqueda vino vacía sería inventar un desenlace.
 */
async function followUpLiveGuides(
  storeId: string,
  apiToken: string,
  admin: ReturnType<typeof createAdminSupabase>,
  sweep: SweepEvidence | null,
  now: Date,
  deadline: number,
  report: StoreReport,
): Promise<void> {
  // Las vivas se filtran en SQL —y no solo en el selector puro— porque sin ese
  // filtro la consulta traería las miles de guías de la tienda y PostgREST la
  // truncaría en su tope de filas, recortando el universo en silencio. El
  // `limit` explícito es el mismo seguro, ordenado por turno: primero las que
  // nunca se consultaron y, entre iguales, la más callada.
  const { data, error } = await admin
    .from("shipments")
    .select("id,external_order_number,guide_code,delivery_status,last_report_at,created_at,reported_status,aliclik_followup_at,api_report_at")
    .eq("store_id", storeId)
    .eq("courier", "aliclik")
    // `anulado` entra junto a las vivas: el paquete vuelve DESPUÉS de anularse,
    // así que excluirlas era dejar fuera justo el estado en el que aparece una
    // devolución. El recorte por antigüedad lo hace `selectFollowUpGuides`, que
    // le da a una anulada tres semanas de silencio en vez de sesenta días; acá
    // se acota en SQL para no arrastrar el histórico entero al pool.
    .in("delivery_status", ["pendiente", "en_ruta", "anulado"])
    .or(
      `delivery_status.neq.anulado,last_report_at.gte.${new Date(
        now.getTime() - FOLLOW_UP_RETURN_WINDOW_MS,
      ).toISOString()}`,
    )
    .order("aliclik_followup_at", { ascending: true, nullsFirst: true })
    .order("last_report_at", { ascending: true, nullsFirst: true })
    .limit(FOLLOW_UP_POOL);

  if (error) {
    report.errors.push(`seguimiento: ${error.message}`);
    return;
  }

  // El barrido acaba de refrescar a las que caen dentro de su ventana: no se
  // gasta un turno en ellas. Sin constancia de barrido no se excluye a nadie —
  // el orden de la cola ya reparte bien.
  const sweptAt = sweep ? new Date(sweep.startedAt) : null;
  const refreshedSince = sweptAt && Number.isFinite(sweptAt.getTime()) ? sweptAt : null;

  const selection = selectFollowUpGuides((data ?? []) as FollowUpCandidate[], {
    refreshedSince,
    limit: FOLLOW_UP_LIMIT,
    maxSilenceMs: FOLLOW_UP_MAX_SILENCE_MS,
    now,
  });
  report.followUpDeferred = selection.deferred;
  report.followUpAbandoned = selection.abandoned;

  // El turno se sella pase lo que pase con la consulta: lo que ordena la cola es
  // haber PREGUNTADO, no haber obtenido respuesta. Sellarlo solo cuando Aliclik
  // contesta devolvería el atasco que 0116 vino a quitar — una guía que falla
  // siempre volvería a encabezar la cola siempre.
  const asked: string[] = [];
  const flushAsked = async () => {
    if (!asked.length) return;
    const ids = asked.splice(0, asked.length);
    const { error: stampErr } = await admin
      .from("shipments")
      .update({ aliclik_followup_at: new Date().toISOString() })
      .in("id", ids);
    if (stampErr) report.errors.push(`sellar turno: ${stampErr.message}`);
  };

  for (const guide of selection.due) {
    if (Date.now() > deadline) {
      report.followUpStoppedByBudget = true;
      // Las que no llegaron a consultarse siguen contando como aplazadas: es lo
      // que hace visible que el tope se quedó corto.
      report.followUpDeferred += selection.due.length - report.followUpScanned;
      break;
    }

    const key = followUpKey(guide);
    report.followUpScanned++;
    asked.push(guide.id);
    try {
      const res = await refreshAliclikOrder(key, { apiToken }, admin);
      if (res.outcome === "applied") report.followUpApplied++;
      else if (res.outcome === "unknown_order") report.followUpMissing++;
      else if (res.outcome === "error" && res.error) {
        report.errors.push(`seguimiento ${key}: ${res.error}`);
      }
    } catch (e) {
      report.errors.push(`seguimiento ${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (asked.length >= ASKED_FLUSH) await flushAsked();
  }

  await flushAsked();
}

/** Lo que necesita la pasada de motivo: con qué preguntar y qué mirar después. */
interface ReasonProbeCandidate {
  id: string;
  external_order_number: string | null;
  guide_code: string | null;
  reported_status: string | null;
  non_delivery_reason: string | null;
  api_report_at: string | null;
}

/**
 * Tercera vuelta: el MOTIVO de las devoluciones que volvieron sin él (0119).
 *
 * POR QUÉ ES UNA PASADA APARTE. Las otras dos persiguen el ESTADO de la guía, y
 * para estas el estado ya está resuelto: volvieron, están `anulado`, no hay nada
 * más que esperar. Lo que falta es el motivo — y el motivo no es un adorno del
 * estado, es el dato con el que se aplica el MOM §11 en lib/return-recovery.ts.
 * Con las dos columnas vacías `wasRefusedInPerson` devuelve `false` y la guía
 * entra a la cola de recuperación, desde donde sale un mensaje pidiéndole un
 * adelanto a una clienta que, por lo que consta, bien pudo haber rechazado el
 * paquete en la puerta.
 *
 * Eran 100 de 130 candidatas: guías importadas del Excel del 20-07 que nunca
 * pasaron por la API. El barrido por fechas ya no las alcanza y la persecución
 * de rezagadas tampoco —a una anulada le da tres semanas de silencio y estas
 * llevan más—, así que el ancla acá no es el estado ni la fecha del reporte,
 * sino la PREGUNTA sin responder.
 *
 * Se acota a la ventana de recuperación (`RECOVERY_DEFAULT_MAX_DAYS`): fuera de
 * ella no se le escribe a nadie, así que preguntar sería gastar llamadas en una
 * decisión que ya no se va a tomar. Y se anota en `reason_probed_at` HAYA O NO
 * respuesta, que es lo único que evita repreguntar en bucle cada veinte minutos
 * por un dato que Aliclik quizá no tenga.
 *
 * Un fallo acá no rompe la pasada, igual que el seguimiento: son consultas extra
 * sobre un estado ya aplicado, y se reintentan en el siguiente ciclo.
 */
async function fillReturnReasons(
  storeId: string,
  apiToken: string,
  admin: ReturnType<typeof createAdminSupabase>,
  sweep: SweepEvidence | null,
  now: Date,
  deadline: number,
  report: StoreReport,
): Promise<void> {
  const windowStart = new Date(now.getTime() - RECOVERY_DEFAULT_MAX_DAYS * DAY_MS).toISOString();
  const cooldown = new Date(now.getTime() - REASON_PROBE_COOLDOWN_MS).toISOString();

  const { data, error } = await admin
    .from("shipments")
    .select("id,external_order_number,guide_code,reported_status,non_delivery_reason,api_report_at")
    .eq("store_id", storeId)
    .eq("courier", "aliclik")
    .not("returned_at", "is", null)
    .gte("returned_at", windowStart)
    // `is null` a secas alcanza porque 0119 dejó una sola forma del vacío y
    // `reportedStatusPatch` ya no escribe cadenas vacías.
    .is("reported_status", null)
    .is("non_delivery_reason", null)
    .or(`reason_probed_at.is.null,reason_probed_at.lt.${cooldown}`)
    // Las devueltas más recientes primero: son las que la cola va a trabajar hoy
    // y las que más lejos están de caerse de la ventana.
    .order("returned_at", { ascending: false })
    .limit(REASON_PROBE_LIMIT);

  if (error) {
    report.errors.push(`motivo: ${error.message}`);
    return;
  }

  // Si el barrido acaba de releerla y sigue sin motivo, la respuesta ya la
  // tenemos: preguntar otra vez por lo mismo no la cambiaría.
  const sweptAt = sweep ? new Date(sweep.startedAt).getTime() : NaN;

  for (const guide of (data ?? []) as ReasonProbeCandidate[]) {
    if (Date.now() > deadline) break;
    if (
      Number.isFinite(sweptAt) &&
      guide.api_report_at &&
      new Date(guide.api_report_at).getTime() >= sweptAt
    ) {
      continue;
    }

    const key = followUpKey(guide);
    report.reasonProbed++;
    try {
      const res = await refreshAliclikOrder(key, { apiToken }, admin);
      if (res.outcome === "error" && res.error) {
        report.errors.push(`motivo ${key}: ${res.error}`);
      }
    } catch (e) {
      report.errors.push(`motivo ${key}: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Se relee la guía en vez de deducirlo del resultado: `applyAliclikSnapshot`
    // informa de si aplicó un ESTADO, y acá lo que importa es otra cosa —si la
    // columna del motivo quedó escrita—. Una guía puede volver `unchanged`
    // porque el snapshot era más viejo que el último reporte y seguir sin motivo.
    const { data: after } = await admin
      .from("shipments")
      .select("reported_status,non_delivery_reason")
      .eq("id", guide.id)
      .maybeSingle();

    if (
      after &&
      courierReason(after as Pick<ReasonProbeCandidate, "reported_status" | "non_delivery_reason">)
    ) {
      report.reasonFound++;
    } else {
      report.reasonStillBlind++;
    }

    await admin
      .from("shipments")
      .update({ reason_probed_at: new Date().toISOString() })
      .eq("id", guide.id);
  }
}

async function run(req: NextRequest) {
  if (!authorized(req)) return new NextResponse("unauthorized", { status: 401 });

  const admin = createAdminSupabase();
  const single = req.nextUrl.searchParams.get("storeId");
  const deadline = Date.now() + FOLLOW_UP_BUDGET_MS;

  let storeIds: string[];
  if (single) {
    storeIds = [single];
  } else {
    const { data, error } = await admin.from("stores").select("id").eq("status", "active");
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    storeIds = (data ?? []).map((s: { id: string }) => s.id);
  }

  const reports: StoreReport[] = [];
  for (const storeId of storeIds) {
    const creds = await getStoreCreds(storeId, admin);
    if (!creds?.aliclik_api_token) continue;
    const report = emptyReport(storeId);
    reports.push(report);
    try {
      const now = new Date();
      // Una sola lectura de la constancia para las dos tareas: la usan para lo
      // mismo —saber hasta dónde llegó el barrido— y leerla dos veces solo
      // abriría la puerta a que cada una decidiera con una foto distinta.
      const sweep = await readSweepEvidence(admin, storeId);
      if (sweep) {
        const at = new Date(sweep.completedAt).getTime();
        if (Number.isFinite(at)) report.sweepAgeMinutes = Math.round((now.getTime() - at) / 60_000);
      }

      // La caducidad va PRIMERO y sin presupuesto: son un puñado de filas, y es
      // lo que tiene a un pedido inoperable. La persecución de rezagadas, que es
      // la parte larga, se reparte el reloj entre las tiendas que queden.
      await expireStaleOrphans(storeId, admin, sweep, now, report);

      const remaining = storeIds.length - reports.length + 1;
      const share = Math.max(0, deadline - Date.now()) / Math.max(1, remaining);
      await followUpLiveGuides(
        storeId,
        creds.aliclik_api_token,
        admin,
        sweep,
        now,
        Date.now() + share,
        report,
      );

      // Va la última y con lo que sobre del reloj: son treinta consultas por un
      // dato que ya llegó tarde. La persecución de rezagadas persigue estados
      // que aún se pueden mover, y esa tiene prioridad sobre esta.
      await fillReturnReasons(
        storeId,
        creds.aliclik_api_token,
        admin,
        sweep,
        now,
        deadline,
        report,
      );
    } catch (e) {
      report.errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return NextResponse.json({ ok: true, reports });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
