import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { getStoreCreds } from "@/lib/ingest";
import { listOrders, type AliclikOrder } from "@/lib/aliclik";
import { applyAliclikSnapshot } from "@/lib/aliclik-track";
import { normalizePhone } from "@/lib/phone";
import { readOrderMarker } from "@/lib/aliclik-reconcile";
import { recordSweep } from "@/lib/aliclik-sweep-state";
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
// LO QUE ESTA RUTA YA NO HACE, Y POR QUÉ. Caducar los candados y perseguir a las
// guías rezagadas vivían aquí, detrás del bucle. El bucle creció hasta agotar
// `maxDuration` y la invocación empezó a morir dentro de él: las nueve pasadas
// de las tres horas previas al 10-08-2026 22:00 terminaron en 504. Todo lo que
// iba después del bucle dejó de ejecutarse siempre — un candado quedó diez horas
// puesto y 515 guías `en_ruta` acumularon una media de 8 días sin noticias.
//
// Un trabajo cuya ejecución depende de que otro más largo termine a tiempo no es
// un trabajo: es una apuesta. Ahora ese cierre vive en `/api/cron/aliclik-close`
// con su propio presupuesto, y esta ruta se limita a barrer y a DEJAR CONSTANCIA
// de lo que barrió (`aliclik_sweep_state`, 0116). La condición de seguridad no se
// aflojó al mudarse: sigue haciendo falta un recorrido completo para caducar
// nada, solo que ahora se lee de una fila en vez de una variable local.

const DAY_MS = 86_400_000;
/** Días hacia atrás que se releen. Cubre de sobra un fin de semana caído. */
const LOOKBACK_DAYS = 14;
/** Antigüedad mínima de una intención para considerarla huérfana. */
const ORPHAN_MIN_AGE_MS = 5 * 60_000;
/**
 * Cuánto tiempo se le deja al recorrido antes de cortarlo por las buenas.
 *
 * Por debajo de `maxDuration` a propósito: el corte tiene que ser NUESTRO. Una
 * pasada que se pasa de 300 s muere en 504 sin escribir el informe, sin anotar
 * su intento y sin dejar dicho hasta dónde llegó — que es como este barrido
 * estuvo fallando en silencio, contado como "el cron corre" porque cada pasada
 * sí aplicaba estados antes de morir. Cortando aquí, una pasada larga termina
 * siendo una pasada incompleta declarada, y el cierre sabe no fiarse de ella.
 */
const SWEEP_BUDGET_MS = 230_000;
/** Páginas de 100 que se leen como mucho. La ventana de 14 días son ~11. */
const MAX_PAGES = 50;

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
  /**
   * Snapshots que no traían nada nuevo y se saltaron sin consultar la guía. Es
   * la mayoría en régimen normal, y saberlo importa: si esto cae a cero, el
   * prefiltro dejó de filtrar y la pasada volvió a costar lo que costaba.
   */
  unchanged: number;
  unknown: number;
  orphansLinked: number;
  /** Guías creadas de cero al rescatar una huérfana. */
  orphansCreated: number;
  /** Candidatas descartadas por ambiguas (mismo teléfono, varios pedidos). */
  orphansAmbiguous: number;
  /** Páginas del listado que se llegaron a leer. */
  pages: number;
  /**
   * ¿Se recorrió el listado ENTERO? Es lo único de esta pasada que el cierre
   * mira, y por eso se reporta: una racha de `false` explica un candado que no
   * se suelta sin tener que mirar los logs.
   */
  sweepComplete: boolean;
  /** Por qué se cortó, cuando se cortó. Vacío si terminó el recorrido. */
  stoppedBy: "" | "api_error" | "budget" | "max_pages";
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
 * Por eso la duda se estampa luego en la fila (`ambiguous_at`) en vez de morir
 * con la invocación: quien caduca ya no es este cron.
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

/**
 * Lo que ya sabemos de las guías de esta página, en dos consultas en vez de 200.
 *
 * DE DÓNDE SALE EL COSTE. `applyAliclikSnapshot` empieza buscando la guía por
 * `external_order_number` y, si no la encuentra, por `guide_code`: una o dos
 * consultas por pedido. Con ~1.100 pedidos en la ventana son más de dos mil
 * viajes a la base, en serie, y la inmensa mayoría para descubrir que el
 * snapshot no traía nada nuevo. Eso es lo que agotaba `maxDuration`.
 *
 * QUÉ SE SALTA Y QUÉ NO. Solo se saltan los casos en los que el aplicador habría
 * salido sin escribir una sola fila:
 *   * la guía no existe → `unknown_order`, que aquí se atiende igual (es la vía
 *     de rescate de huérfanas);
 *   * el snapshot es más viejo que nuestra última lectura → la guarda monotónica
 *     lo descarta.
 * Cualquier otro caso baja al aplicador de siempre, que sigue siendo la única
 * vía de escritura. El prefiltro decide a quién NO preguntar, nunca qué escribir.
 *
 * Los identificadores raros se dejan fuera del filtro `in` y caen al camino de
 * una en una: el valor viene de la API, y PostgREST parsea la lista como texto
 * donde una coma o una comilla cambiarían la consulta. Con `.eq()` viaja como
 * parámetro y no hay nada que escapar — el mismo motivo por el que el aplicador
 * evita `.or(...)`.
 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

interface KnownGuide {
  last_report_at: string | null;
}

async function prefetchKnownGuides(
  admin: ReturnType<typeof createAdminSupabase>,
  orderNumbers: readonly string[],
  report: StoreReport,
): Promise<Map<string, KnownGuide>> {
  const known = new Map<string, KnownGuide>();
  const safe = orderNumbers.filter((n) => SAFE_ID.test(n));
  if (!safe.length) return known;

  // Por `guide_code` primero y por `external_order_number` después, para que el
  // segundo pise al primero: es el mismo orden de preferencia que aplica el
  // aplicador cuando una guía se puede encontrar por las dos vías.
  const byGuide = await admin
    .from("shipments")
    .select("guide_code,last_report_at")
    .eq("courier", "aliclik")
    .in("guide_code", safe);
  if (byGuide.error) {
    report.errors.push(`prefiltro (guide_code): ${byGuide.error.message}`);
    return known;
  }
  for (const row of byGuide.data ?? []) {
    const code = (row.guide_code ?? "").trim();
    if (code) known.set(code, { last_report_at: row.last_report_at });
  }

  const byExternal = await admin
    .from("shipments")
    .select("external_order_number,last_report_at")
    .in("external_order_number", safe);
  if (byExternal.error) {
    report.errors.push(`prefiltro (external_order_number): ${byExternal.error.message}`);
    return known;
  }
  for (const row of byExternal.data ?? []) {
    const code = (row.external_order_number ?? "").trim();
    if (code) known.set(code, { last_report_at: row.last_report_at });
  }

  return known;
}

/** ¿El snapshot es más viejo que lo último que aplicamos? Entonces no aporta. */
function isStale(order: AliclikOrder, guide: KnownGuide): boolean {
  if (!order.updatedAt || !guide.last_report_at) return false;
  const updatedAt = new Date(order.updatedAt);
  if (!Number.isFinite(updatedAt.getTime())) return false;
  return updatedAt.toISOString() < guide.last_report_at;
}

const emptyReport = (storeId: string): StoreReport => ({
  storeId,
  scanned: 0,
  applied: 0,
  unchanged: 0,
  unknown: 0,
  orphansLinked: 0,
  orphansCreated: 0,
  orphansAmbiguous: 0,
  pages: 0,
  sweepComplete: false,
  stoppedBy: "",
  errors: [],
});

async function reconcileStore(
  storeId: string,
  apiToken: string,
  admin: ReturnType<typeof createAdminSupabase>,
  deadline: number,
): Promise<StoreReport> {
  const report = emptyReport(storeId);
  const startedAt = new Date();
  const windowFrom = new Date(startedAt.getTime() - LOOKBACK_DAYS * DAY_MS);
  const startDate = dateKey(windowFrom);
  const endDate = dateKey(startedAt);

  // Intenciones que se quedaron sin respuesta. Se cargan ANTES del barrido para
  // poder emparejarlas con lo que devuelva Aliclik en la misma pasada.
  const { data: pending } = await admin
    .from("aliclik_order_requests")
    .select("id,order_id,request,created_at,error")
    .eq("store_id", storeId)
    .eq("status", "pending")
    .lt("created_at", new Date(startedAt.getTime() - ORPHAN_MIN_AGE_MS).toISOString());

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
  // teléfono. Nunca caducan mientras la duda siga en pie: ver matchOrphan.
  const ambiguous = new Set<string>();

  // ¿Se llegó a recorrer el listado ENTERO? Solo entonces "no aparece" significa
  // "no existe", y solo entonces el cierre podrá caducar una intención. Un corte
  // por error de la API, por el tope de páginas o por agotar el presupuesto de
  // tiempo deja esto en false a propósito.
  let sweepComplete = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (Date.now() > deadline) {
      report.stoppedBy = "budget";
      break;
    }

    const res = await listOrders({ apiToken }, { page, limit: 100, startDate, endDate });
    if (!res.ok) {
      report.errors.push(res.error);
      report.stoppedBy = "api_error";
      break;
    }
    report.pages = page;
    const rows = res.data.data ?? [];
    if (!rows.length) {
      sweepComplete = true;
      break;
    }

    const known = await prefetchKnownGuides(
      admin,
      rows.map((o) => (o.orderNumber ?? "").trim()).filter(Boolean),
      report,
    );

    for (const order of rows) {
      report.scanned++;
      const orderNumber = (order.orderNumber ?? "").trim();
      // Un identificador que el prefiltro no pudo consultar no es una guía
      // desconocida: es una guía sin averiguar. Baja al aplicador, que la busca
      // con `.eq()` igual que siempre.
      const prefiltered = Boolean(orderNumber) && SAFE_ID.test(orderNumber);
      const guide = prefiltered ? known.get(orderNumber) : undefined;

      // Conocida y sin novedad: el aplicador habría salido sin escribir nada.
      if (guide && isStale(order, guide)) {
        report.unchanged++;
        continue;
      }

      let missing = true;
      if (guide || !prefiltered) {
        const applied = await applyAliclikSnapshot(order, admin);
        missing = applied.outcome === "unknown_order";
        if (applied.outcome === "applied") report.applied++;
        else if (applied.outcome === "unchanged") report.unchanged++;
        else if (applied.outcome === "error" && applied.error) {
          report.errors.push(`snapshot ${orderNumber || "(sin número)"}: ${applied.error}`);
        }
      }
      if (!missing) continue;

      // No la conocemos. ¿Es el pedido de una creación que se fue en timeout?
      //
      // Primero por la MARCA que estampamos en la nota (§ stampOrderMarker):
      // es identidad, no parecido. El teléfono queda como respaldo para las
      // intenciones anteriores a la marca, y solo si es inequívoco: hay
      // clientes con dos pedidos abiertos a la vez, y pegarle la guía al
      // equivocado es peor que no pegarla.
      report.unknown++;
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

    const totalPages = res.data.pagination?.totalPages ?? 1;
    if (page >= (totalPages || 1)) {
      sweepComplete = true;
      break;
    }
    if (page === MAX_PAGES) report.stoppedBy = "max_pages";
  }

  report.sweepComplete = sweepComplete;
  if (sweepComplete) report.stoppedBy = "";

  // La duda por ambigüedad se estampa en la propia intención. Antes vivía en el
  // Set de arriba y le bastaba, porque quien caducaba era esta misma invocación;
  // ahora quien caduca es otro cron y el hecho tiene que sobrevivir al proceso.
  if (ambiguous.size) {
    const { error } = await admin
      .from("aliclik_order_requests")
      .update({ ambiguous_at: startedAt.toISOString() })
      .in("id", [...ambiguous]);
    if (error) report.errors.push(`marcar ambiguas: ${error.message}`);
  }

  // La constancia va SIEMPRE, complete o no: una pasada truncada solo anota el
  // intento y deja intactas las marcas del último barrido bueno.
  const stateErr = await recordSweep(admin, storeId, {
    startedAt,
    finishedAt: new Date(),
    windowFrom,
    complete: sweepComplete,
  });
  if (stateErr) report.errors.push(`constancia del barrido: ${stateErr}`);

  return report;
}

async function run(req: NextRequest) {
  if (!authorized(req)) return new NextResponse("unauthorized", { status: 401 });

  const admin = createAdminSupabase();
  const single = req.nextUrl.searchParams.get("storeId");
  const deadline = Date.now() + SWEEP_BUDGET_MS;

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
      // El presupuesto se reparte entre las tiendas que quedan por barrer. Sin
      // esto, la primera podría gastárselo entero y las siguientes no llegarían
      // a leer ni una página — que es la forma silenciosa de que una tienda deje
      // de reconciliarse sin que nadie lo note.
      const remaining = storeIds.length - reports.length;
      const share = Math.max(0, deadline - Date.now()) / Math.max(1, remaining);
      reports.push(await reconcileStore(storeId, creds.aliclik_api_token, admin, Date.now() + share));
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
