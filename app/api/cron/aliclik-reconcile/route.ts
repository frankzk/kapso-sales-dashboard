import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { getStoreCreds } from "@/lib/ingest";
import { listOrders, type AliclikOrder } from "@/lib/aliclik";
import { applyAliclikSnapshot, refreshAliclikOrder } from "@/lib/aliclik-track";
import { selectFollowUpGuides, followUpKey, type FollowUpCandidate } from "@/lib/aliclik-followup";
import { selectExpiredOrphans, type ExpiryCandidate } from "@/lib/aliclik-orphan-expiry";
import { normalizePhone } from "@/lib/phone";
import { readOrderMarker } from "@/lib/aliclik-reconcile";
import { categoryOf } from "@/lib/shipments";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Red de seguridad del webhook.
//
// POR QUÉ HACE FALTA. El webhook de Aliclik no viene firmado, no trae timestamp
// y no hay ninguna garantía de entrega documentada: no se sabe si reintenta
// cuando respondemos != 2xx. Un canal así no puede ser la única fuente del
// estado de un pedido. Este barrido relee los últimos días y aplica lo que
// diga Aliclik, de modo que un aviso perdido cuesta como mucho un ciclo.
//
// ADEMÁS RESUELVE LOS HUÉRFANOS. Cuando una creación se va en timeout, no
// sabemos si el pedido existe: la intención se queda en 'pending' (y sigue
// bloqueando un segundo intento, que es lo correcto). Aquí se busca entre los
// pedidos que Aliclik creó en esa ventana y, si aparece, se registra. Sin esto,
// un timeout dejaría el pedido bloqueado para siempre.
//
// Se empareja por la MARCA que estampamos en la nota al crear, que Aliclik
// devuelve al listar. El teléfono quedó como respaldo para las intenciones
// anteriores a la marca, y solo cuando señala a una sola candidata: hay clientes
// con dos pedidos abiertos a la vez.
//
// Y el rescate CREA la guía si no existe. Es lo normal, no la excepción: la fila
// se inserta después de que Aliclik responde, así que un timeout no deja
// ninguna. Antes esto era un UPDATE que no encontraba nada, no fallaba, y dejaba
// la intención marcada como resuelta sin haber registrado la guía.
//
// Y CADUCA LAS QUE NO EXISTEN. Buscar al huérfano cubre la rama "Aliclik sí lo
// creó". La otra —nunca llegó a crearlo— no tenía salida: la intención se
// quedaba en 'pending' para siempre y el candado dejaba el pedido inoperable.
// Tras `ORPHAN_EXPIRY_MS` de barridos sin encontrarla, se cierra como 'failed'
// con el motivo escrito y el pedido vuelve a admitir un intento
// (lib/aliclik-orphan-expiry.ts).
//
// Y PERSIGUE A LAS REZAGADAS. La ventana de fechas cubre el ciclo normal, pero
// no el retorno: un paquete rechazado tarda semanas en volver, y para cuando
// Aliclik lo marca RETURNED su guía ya se cayó del rango. Por eso, tras el
// barrido, se consulta una por una a las guías que siguen vivas y que el rango
// no tocó (lib/aliclik-followup.ts). El ancla es el estado, no la fecha.

const DAY_MS = 86_400_000;
/** Días hacia atrás que se releen. Cubre de sobra un fin de semana caído. */
const LOOKBACK_DAYS = 14;
/** Antigüedad mínima de una intención para considerarla huérfana. */
const ORPHAN_MIN_AGE_MS = 5 * 60_000;
/**
 * Cuándo se da por no creada una intención que el barrido nunca encuentra.
 *
 * Con el cron cada 20 minutos son cuatro o cinco pasadas completas buscándola
 * por su marca antes de soltar el candado. El margen es deliberadamente amplio:
 * caducar de más crea una guía duplicada —dinero real, ventana de cancelación
 * corta— y caducar de menos solo cuesta esperar.
 */
const ORPHAN_EXPIRY_MS = 90 * 60_000;
/**
 * Consultas individuales por tienda y pasada. Con el cron cada 20 minutos son
 * ~2.900 turnos al día: de sobra para una cola de rezagadas sana. Si
 * `followUpDeferred` no vuelve a cero entre pasadas, este tope se quedó corto.
 */
const FOLLOW_UP_LIMIT = 40;
/**
 * Cuándo se deja de preguntar por una guía que no responde. Un retorno tarda
 * semanas; dos meses de silencio ya es una guía que Aliclik nunca cerró.
 */
const FOLLOW_UP_MAX_SILENCE_MS = 60 * DAY_MS;
/**
 * Techo de filas que se traen para elegir a quién preguntar. No es una decisión
 * de producto: es el seguro contra el tope de filas de PostgREST, que truncaría
 * la consulta en silencio y recortaría el universo sin avisar. Se piden las más
 * calladas primero, así que un recorte se llevaría siempre a las menos urgentes.
 *
 * Hoy las guías Aliclik vivas —`pendiente` + `en_ruta`, sumando TODAS las
 * tiendas— son 583, y este tope se aplica por tienda. Sobra holgura; si alguna
 * vez dejara de sobrar, `followUpDeferred` lo delataría antes de que importe.
 */
const FOLLOW_UP_POOL = 2000;

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

const dateKey = (d: Date) => d.toISOString().slice(0, 10);

interface StoreReport {
  storeId: string;
  scanned: number;
  applied: number;
  unknown: number;
  orphansLinked: number;
  /** Guías creadas de cero al rescatar una huérfana. */
  orphansCreated: number;
  /** Candidatas descartadas por ambiguas (mismo teléfono, varios pedidos). */
  orphansAmbiguous: number;
  /** Intenciones dadas por no creadas: candado liberado, pedido reintentable. */
  orphansExpired: number;
  /** Caducadas sin que el barrido cubriera su fecha: piden ojo humano. */
  orphansExpiredUnverified: number;
  /** Las que siguen bloqueadas y por qué. Si no baja, hay algo que mirar. */
  orphansHeld: { tooYoung: number; ambiguous: number; sweepIncomplete: number };
  /** Guías vivas consultadas de una en una tras el barrido por fechas. */
  followUpScanned: number;
  followUpApplied: number;
  /** Vivas que no cupieron en el tope de esta pasada; van en la siguiente. */
  followUpDeferred: number;
  /** Vivas que se dieron por abandonadas por llevar demasiado calladas. */
  followUpAbandoned: number;
  /** Consultadas que Aliclik ya no reconoce: quedan para revisión humana. */
  followUpMissing: number;
  errors: string[];
}

/** El cuerpo que mandamos al crear, tal y como quedó guardado en la intención. */
interface OrphanRequest {
  note?: string | null;
  customer?: { name?: string | null; phone?: string | null; address?: string | null } | null;
  shipping?: {
    address1?: string | null;
    lat?: string | null;
    lng?: string | null;
    reference?: string | null;
  } | null;
}

interface Orphan {
  id: string;
  orderId: string | null;
  phone: string | null;
  marker: string | null;
  createdAt: string;
  /** El fallo que la dejó en 'pending' — casi siempre el timeout de creación. */
  error: string | null;
  request: OrphanRequest;
}

/**
 * Qué intención huérfana corresponde a este pedido de Aliclik.
 *
 * La marca manda. El teléfono solo desempata cuando hay UNA sola candidata: dos
 * pedidos del mismo cliente son indistinguibles por teléfono, y vincular la guía
 * al pedido equivocado deja a los dos mal — uno con una salida que no es suya y
 * el otro esperando la propia.
 *
 * `ambiguous` recoge a las que quedaron en ese empate. Importa más allá del
 * contador: una intención ahí NO puede caducarse después, porque el barrido vio
 * un pedido sin registrar que podría ser el suyo. Su ausencia no está probada.
 */
function matchOrphan(
  order: AliclikOrder,
  orphans: Orphan[],
  ambiguous: Set<string>,
  report: StoreReport,
): Orphan | undefined {
  const marker = readOrderMarker(order.note);
  if (marker) {
    const exact = orphans.find((o) => o.marker && o.marker === marker);
    if (exact) return exact;
  }

  const phone = normalizePhone(order.customer?.phone ?? null);
  if (!phone) return undefined;
  const samePhone = orphans.filter((o) => o.phone && o.phone === phone);
  if (samePhone.length === 1) return samePhone[0];
  if (samePhone.length > 1) {
    report.orphansAmbiguous++;
    for (const o of samePhone) ambiguous.add(o.id);
  }
  return undefined;
}

/**
 * Deja la guía huérfana registrada. Devuelve `true` solo si de verdad quedó.
 *
 * ANTES ESTO ERA UN UPDATE A SECAS, y ahí estaba el fallo: la fila de la guía se
 * inserta DESPUÉS de que Aliclik responde, así que tras un timeout no existe
 * ninguna. El update no encontraba nada, PostgREST no considera error actualizar
 * cero filas, y el barrido marcaba la intención como resuelta sin haber creado
 * nada. La guía quedaba invisible para siempre y el registro decía lo contrario.
 *
 * Ahora: si la fila existe se enlaza; si no existe se CREA con los datos de la
 * intención —que son los mismos que mandamos a Aliclik— y se vuelve a aplicar el
 * snapshot, que ya la encuentra y le escribe estado, custodia y Master.
 */
async function rescueOrphanGuide(
  admin: ReturnType<typeof createAdminSupabase>,
  order: AliclikOrder,
  orphan: Orphan,
  report: StoreReport,
): Promise<boolean> {
  const orderNumber = (order.orderNumber ?? "").trim();
  if (!orderNumber || !orphan.orderId) return false;

  // 1) ¿Ya está registrada? Entonces no hay nada que rescatar.
  const { data: already } = await admin
    .from("shipments")
    .select("id")
    .eq("external_order_number", orderNumber)
    .limit(1);
  if ((already ?? []).length) return true;

  // 2) ¿Hay una guía del pedido todavía sin identificador? Se le pone.
  const { data: linked, error: linkErr } = await admin
    .from("shipments")
    .update({ external_order_number: orderNumber })
    .eq("order_id", orphan.orderId)
    .eq("courier", "aliclik")
    .is("external_order_number", null)
    .select("id");
  if (linkErr) {
    report.errors.push(`huérfana ${orderNumber}: ${linkErr.message}`);
    return false;
  }
  // `.select()` es lo que permite saber si tocó algo. Sin él, cero filas y éxito
  // son indistinguibles — que es exactamente cómo se perdían estas guías.
  if ((linked ?? []).length) return true;

  // 3) No existe: se crea desde lo que mandamos.
  const req = orphan.request;
  const lat = Number(req.shipping?.lat);
  const lng = Number(req.shipping?.lng);
  const { error: insErr } = await admin.from("shipments").insert({
    store_id: report.storeId,
    courier: "aliclik",
    guide_code: orderNumber,
    external_order_number: orderNumber,
    delivery_status: "pendiente",
    status_category: categoryOf("pendiente"),
    order_id: orphan.orderId,
    matched: true,
    match_method: "manual",
    order_name: orphan.marker,
    customer_name: req.customer?.name ?? null,
    customer_phone: orphan.phone,
    delivery_address: req.shipping?.address1 ?? req.customer?.address ?? null,
    delivery_reference: req.shipping?.reference ?? null,
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null,
    created_via: "aliclik_api",
  });
  if (insErr) {
    report.errors.push(`huérfana ${orderNumber}: ${insErr.message}`);
    return false;
  }
  report.orphansCreated++;

  // Ya existe la fila: el snapshot que acabamos de recibir se aplica sobre ella
  // y arrastra estado, custodia y recálculo del Master.
  await applyAliclikSnapshot(order, admin);
  return true;
}

const emptyReport = (storeId: string): StoreReport => ({
  storeId,
  scanned: 0,
  applied: 0,
  unknown: 0,
  orphansLinked: 0,
  orphansCreated: 0,
  orphansAmbiguous: 0,
  orphansExpired: 0,
  orphansExpiredUnverified: 0,
  orphansHeld: { tooYoung: 0, ambiguous: 0, sweepIncomplete: 0 },
  followUpScanned: 0,
  followUpApplied: 0,
  followUpDeferred: 0,
  followUpAbandoned: 0,
  followUpMissing: 0,
  errors: [],
});

async function reconcileStore(
  storeId: string,
  apiToken: string,
  admin: ReturnType<typeof createAdminSupabase>,
): Promise<StoreReport> {
  const report = emptyReport(storeId);
  const now = new Date();
  const startDate = dateKey(new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS));
  const endDate = dateKey(now);

  // Intenciones que se quedaron sin respuesta. Se cargan ANTES del barrido para
  // poder emparejarlas con lo que devuelva Aliclik en la misma pasada.
  const { data: pending } = await admin
    .from("aliclik_order_requests")
    .select("id,order_id,request,created_at,error")
    .eq("store_id", storeId)
    .eq("status", "pending")
    .lt("created_at", new Date(now.getTime() - ORPHAN_MIN_AGE_MS).toISOString());

  const orphans: Orphan[] = (pending ?? []).map((p) => {
    const req = (p.request ?? {}) as OrphanRequest;
    return {
      id: p.id,
      orderId: p.order_id,
      phone: normalizePhone(req.customer?.phone ?? null),
      // La marca que estampamos en la nota al crear. Es la identidad; el
      // teléfono queda solo como respaldo para las intenciones anteriores a esto.
      marker: readOrderMarker(req.note),
      createdAt: p.created_at,
      error: p.error,
      request: req,
    };
  });

  // Intenciones que el barrido vio pero no pudo descartar por ambigüedad de
  // teléfono. Nunca caducan: ver matchOrphan.
  const ambiguous = new Set<string>();

  // Lo que el barrido por fechas alcanza a ver. Sirve para no volver a
  // preguntar por ello en el pase de rezagadas.
  const scanned = new Set<string>();

  // ¿Se llegó a recorrer el listado ENTERO? Solo entonces "no aparece" significa
  // "no existe", y solo entonces se puede caducar una intención. Un corte por
  // error de la API —o por el tope de páginas— deja esto en false a propósito.
  let sweepComplete = false;

  for (let page = 1; page <= 50; page++) {
    const res = await listOrders({ apiToken }, { page, limit: 100, startDate, endDate });
    if (!res.ok) {
      report.errors.push(res.error);
      break;
    }
    const rows = res.data.data ?? [];
    if (!rows.length) {
      sweepComplete = true;
      break;
    }

    for (const order of rows) {
      report.scanned++;
      const seen = (order.orderNumber ?? "").trim();
      if (seen) scanned.add(seen);
      const applied = await applyAliclikSnapshot(order, admin);
      if (applied.outcome === "applied") report.applied++;
      else if (applied.outcome === "unknown_order") {
        report.unknown++;

        // ¿Es el pedido de una creación que se fue en timeout?
        //
        // Primero por la MARCA que estampamos en la nota (§ stampOrderMarker):
        // es identidad, no parecido. El teléfono queda como respaldo para las
        // intenciones anteriores a la marca, y solo si es inequívoco: hay
        // clientes con dos pedidos abiertos a la vez, y pegarle la guía al
        // equivocado es peor que no pegarla.
        const orphan = matchOrphan(order, orphans, ambiguous, report);
        if (orphan && order.orderNumber) {
          const rescued = await rescueOrphanGuide(admin, order, orphan, report);
          if (rescued) {
            await admin
              .from("aliclik_order_requests")
              .update({
                status: "sent",
                order_number: order.orderNumber,
                completed_at: new Date().toISOString(),
                error: "Vinculado por el barrido tras un timeout de creación.",
              })
              .eq("id", orphan.id);
            report.orphansLinked++;
            // Ya no está huérfana: no volver a usarla en esta pasada.
            orphans.splice(orphans.indexOf(orphan), 1);
          }
        }
      }
    }

    const totalPages = res.data.pagination?.totalPages ?? 1;
    if (page >= (totalPages || 1)) {
      sweepComplete = true;
      break;
    }
  }

  // Las que quedan en `orphans` son las que el barrido NO emparejó: las
  // rescatadas se sacaron del array al cerrarlas como 'sent'.
  await expireStaleOrphans(admin, orphans, ambiguous, sweepComplete, now, report);

  await followUpLiveGuides(storeId, apiToken, admin, scanned, now, report);

  return report;
}

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
  admin: ReturnType<typeof createAdminSupabase>,
  orphans: readonly Orphan[],
  ambiguous: ReadonlySet<string>,
  sweepComplete: boolean,
  now: Date,
  report: StoreReport,
): Promise<void> {
  const selection = selectExpiredOrphans(
    orphans.map((o): ExpiryCandidate => ({ id: o.id, orderId: o.orderId, createdAt: o.createdAt })),
    {
      ambiguous,
      sweepComplete,
      expiryMs: ORPHAN_EXPIRY_MS,
      lookbackMs: LOOKBACK_DAYS * DAY_MS,
      now,
    },
  );
  report.orphansHeld = selection.held;
  const causeOf = new Map(orphans.map((o) => [o.id, (o.error ?? "").trim()]));

  for (const decision of selection.expire) {
    const cause = causeOf.get(decision.id);
    const reason = cause ? `${cause} — ${decision.reason}` : decision.reason;

    // El `eq('status','pending')` es la guarda contra la carrera con el propio
    // POST: si la creación terminó bien entre la carga de huérfanas y este
    // punto, la fila ya está en 'sent' y aquí no se toca nada.
    const { data, error } = await admin
      .from("aliclik_order_requests")
      .update({
        status: "failed",
        error: reason,
        completed_at: now.toISOString(),
      })
      .eq("id", decision.id)
      .eq("status", "pending")
      .select("id");

    if (error) {
      report.errors.push(`caducar intención ${decision.id}: ${error.message}`);
      continue;
    }
    if (!(data ?? []).length) continue;

    report.orphansExpired++;
    if (!decision.verified) report.orphansExpiredUnverified++;
  }
}

/**
 * Segundo pase: las guías vivas a las que la ventana de fechas ya no llega.
 *
 * El barrido de arriba relee por rango de fechas, así que una guía que lleva más
 * de LOOKBACK_DAYS abierta deja de aparecer y su estado se congela: la única
 * forma de moverla era que alguien subiera un Excel. Eso es exactamente lo que
 * pasó con las guías en POR DEVOLVER — el reporte amplio que traía DEVUELTO dejó
 * de subirse el 21-07 y quedaron 131 abiertas, con una mediana de 18 días y
 * hasta 38.
 *
 * Se consultan de una en una porque no hay forma de pedirle a Aliclik "estas
 * guías concretas" — solo rangos y búsqueda por número. `getOrder` no filtra por
 * fecha, así que alcanza cualquier antigüedad. El coste está acotado por
 * `FOLLOW_UP_LIMIT`: a cada pasada le tocan las más calladas, y con el cron cada
 * 20 minutos el atraso se drena en pocas horas sin castigar la API ni agotar
 * `maxDuration`.
 *
 * ALCANZA TAMBIÉN A LAS DEL EXCEL. El identificador de consulta sale de
 * `followUpKey`: `external_order_number` si lo hay y `guide_code` si no. Sin ese
 * respaldo el pase dejaría fuera a 277 de las 583 guías vivas —las que entraron
 * por importación— que son justo las que se congelan.
 *
 * Lo que Aliclik ya no reconoce NO se toca: se cuenta en `followUpMissing`.
 * Cerrar una guía porque una búsqueda vino vacía sería inventar un desenlace.
 *
 * Un fallo aquí no rompe la pasada: el barrido por fechas ya se aplicó y esto
 * es trabajo extra que puede reintentarse en veinte minutos.
 */
async function followUpLiveGuides(
  storeId: string,
  apiToken: string,
  admin: ReturnType<typeof createAdminSupabase>,
  scanned: ReadonlySet<string>,
  now: Date,
  report: StoreReport,
): Promise<void> {
  // Las vivas se filtran en SQL —y no solo en el selector puro— porque sin ese
  // filtro la consulta traería las 3.818 guías de la tienda y PostgREST la
  // truncaría en su tope de filas, recortando el universo en silencio. El
  // `limit` explícito es el mismo seguro, ordenado por la más callada primero:
  // hoy las vivas rondan las 250, muy por debajo del tope.
  const { data, error } = await admin
    .from("shipments")
    .select("id,external_order_number,guide_code,delivery_status,last_report_at,created_at")
    .eq("store_id", storeId)
    .eq("courier", "aliclik")
    .in("delivery_status", ["pendiente", "en_ruta"])
    .order("last_report_at", { ascending: true, nullsFirst: true })
    .limit(FOLLOW_UP_POOL);

  if (error) {
    report.errors.push(`seguimiento: ${error.message}`);
    return;
  }

  const selection = selectFollowUpGuides((data ?? []) as FollowUpCandidate[], {
    scanned,
    limit: FOLLOW_UP_LIMIT,
    maxSilenceMs: FOLLOW_UP_MAX_SILENCE_MS,
    now,
  });
  report.followUpDeferred = selection.deferred;
  report.followUpAbandoned = selection.abandoned;

  for (const guide of selection.due) {
    const key = followUpKey(guide);
    report.followUpScanned++;
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
  }
}

async function run(req: NextRequest) {
  if (!authorized(req)) return new NextResponse("unauthorized", { status: 401 });

  const admin = createAdminSupabase();
  const single = req.nextUrl.searchParams.get("storeId");

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
    try {
      reports.push(await reconcileStore(storeId, creds.aliclik_api_token, admin));
    } catch (e) {
      reports.push({
        ...emptyReport(storeId),
        errors: [e instanceof Error ? e.message : String(e)],
      });
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
