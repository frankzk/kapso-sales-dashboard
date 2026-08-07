import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { getStoreCreds } from "@/lib/ingest";
import { getOrder, listOrders, type AliclikOrder } from "@/lib/aliclik";
import { applyAliclikSnapshot } from "@/lib/aliclik-track";
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

const DAY_MS = 86_400_000;
/** Días hacia atrás que se releen. Cubre de sobra un fin de semana caído. */
const LOOKBACK_DAYS = 14;
/** Antigüedad mínima de una intención para considerarla huérfana. */
const ORPHAN_MIN_AGE_MS = 5 * 60_000;

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
  /** Guías viejas y abiertas consultadas una a una (ver `sweepStaleGuides`). */
  staleChecked: number;
  staleApplied: number;
  /** Consultadas que Aliclik ya no reconoce: quedan para revisión humana. */
  staleMissing: number;
  errors: string[];
}

/** Guías viejas revisadas por corrida. Acota la latencia y el gasto de API. */
const STALE_BATCH = 40;

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
  request: OrphanRequest;
}

/**
 * Qué intención huérfana corresponde a este pedido de Aliclik.
 *
 * La marca manda. El teléfono solo desempata cuando hay UNA sola candidata: dos
 * pedidos del mismo cliente son indistinguibles por teléfono, y vincular la guía
 * al pedido equivocado deja a los dos mal — uno con una salida que no es suya y
 * el otro esperando la propia.
 */
function matchOrphan(
  order: AliclikOrder,
  orphans: Orphan[],
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
  if (samePhone.length > 1) report.orphansAmbiguous++;
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

async function reconcileStore(
  storeId: string,
  apiToken: string,
  admin: ReturnType<typeof createAdminSupabase>,
): Promise<StoreReport> {
  const report: StoreReport = {
    storeId,
    scanned: 0,
    applied: 0,
    unknown: 0,
    orphansLinked: 0,
    orphansCreated: 0,
    orphansAmbiguous: 0,
    staleChecked: 0,
    staleApplied: 0,
    staleMissing: 0,
    errors: [],
  };
  const now = new Date();
  const startDate = dateKey(new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS));
  const endDate = dateKey(now);

  // Intenciones que se quedaron sin respuesta. Se cargan ANTES del barrido para
  // poder emparejarlas con lo que devuelva Aliclik en la misma pasada.
  const { data: pending } = await admin
    .from("aliclik_order_requests")
    .select("id,order_id,request,created_at")
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
      request: req,
    };
  });

  for (let page = 1; page <= 50; page++) {
    const res = await listOrders({ apiToken }, { page, limit: 100, startDate, endDate });
    if (!res.ok) {
      report.errors.push(res.error);
      break;
    }
    const rows = res.data.data ?? [];
    if (!rows.length) break;

    for (const order of rows) {
      report.scanned++;
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
        const orphan = matchOrphan(order, orphans, report);
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
    if (page >= (totalPages || 1)) break;
  }

  await sweepStaleGuides(storeId, apiToken, admin, report, startDate);
  return report;
}

/**
 * Guías abiertas MÁS VIEJAS que la ventana del barrido.
 *
 * El barrido de arriba relee por rango de fechas, así que una guía que lleva más
 * de LOOKBACK_DAYS abierta deja de aparecer y su estado se congela: la única
 * forma de moverla era que alguien subiera un Excel. Eso es exactamente lo que
 * pasó con las guías en POR DEVOLVER — el reporte amplio que traía DEVUELTO dejó
 * de subirse el 21-07 y quedaron 131 abiertas, con una mediana de 18 días y
 * hasta 38.
 *
 * `getOrder` busca por `orderNumber` SIN filtro de fecha, así que alcanza
 * cualquier antigüedad. Se consulta una por una porque no hay endpoint de
 * consulta múltiple, y por eso va acotado a STALE_BATCH por corrida: a cada
 * pasada le tocan las más rezagadas, y con el cron cada 20 minutos el atraso se
 * drena en pocas horas sin castigar la API ni agotar `maxDuration`.
 *
 * Lo que Aliclik ya no reconoce NO se toca: se cuenta en `staleMissing`. Cerrar
 * una guía porque una búsqueda vino vacía sería inventar un desenlace.
 */
async function sweepStaleGuides(
  storeId: string,
  apiToken: string,
  admin: ReturnType<typeof createAdminSupabase>,
  report: StoreReport,
  windowStart: string,
): Promise<void> {
  const { data, error } = await admin
    .from("shipments")
    .select("id,guide_code,created_at")
    .eq("store_id", storeId)
    .eq("courier", "aliclik")
    .in("delivery_status", ["pendiente", "en_ruta"])
    .not("guide_code", "is", null)
    .lt("created_at", windowStart)
    // Las más rezagadas primero: la que hace más que no se mira.
    .order("last_report_at", { ascending: true, nullsFirst: true })
    .limit(STALE_BATCH);

  if (error) {
    report.errors.push(`stale: ${error.message}`);
    return;
  }

  for (const row of (data ?? []) as { guide_code: string | null }[]) {
    const guide = (row.guide_code ?? "").trim();
    if (!guide) continue;
    report.staleChecked++;
    const res = await getOrder({ apiToken }, guide);
    if (!res.ok) {
      report.errors.push(`stale ${guide}: ${res.error}`);
      continue;
    }
    if (!res.data) {
      report.staleMissing++;
      continue;
    }
    const applied = await applyAliclikSnapshot(res.data, admin);
    if (applied.outcome === "applied") report.staleApplied++;
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
        storeId,
        scanned: 0,
        applied: 0,
        unknown: 0,
        orphansLinked: 0,
        orphansCreated: 0,
        orphansAmbiguous: 0,
        staleChecked: 0,
        staleApplied: 0,
        staleMissing: 0,
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
