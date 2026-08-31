// Aplicación de un estado de Aliclik a nuestra guía. Única vía de escritura,
// compartida por el webhook y por el cron de reconciliación.
//
// POR QUÉ UNA SOLA VÍA. Son dos disparadores (una notificación que llega y un
// barrido periódico) pero un solo efecto. Si cada uno escribiera a su manera,
// tarde o temprano diferirían — y la diferencia solo se vería en producción, en
// un pedido concreto, a las once de la noche.
//
// EL PAYLOAD DEL WEBHOOK NO SE ESCRIBE. Aliclik avisa de que "los estados pueden
// llegar en desorden" y su notificación no trae timestamp, así que no hay forma
// de saber si lo que llega es más nuevo que lo que tenemos. La notificación es
// solo un disparador: lo que se escribe es la respuesta de
// `GET /integration/order`, que sí trae `updatedAt` y sirve de guarda monotónica.
// Efecto lateral bienvenido: como el webhook no viene firmado, una notificación
// falsificada, como mucho, nos hace releer la verdad desde Aliclik.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { getOrder, type AliclikClientOpts, type AliclikOrder } from "@/lib/aliclik";
import {
  aliclikStatusLabel,
  mapAliclikStatus,
  reconcileAliclikCustodyState,
  reconcileAliclikPreparationState,
} from "@/lib/aliclik-status";
import { categoryOf, reconcileDeliveryStatus, reopensForFailedAttempt } from "@/lib/shipments";
import { sealReturn } from "@/lib/returned-source";
import { recomputeOrderMasterSafe } from "@/lib/order-master";

/**
 * Huella del estado, para la idempotencia que pide la documentación. El mismo
 * trío reenviado produce la misma huella y choca contra el único de
 * `aliclik_webhook_events`, así que no se vuelve a consultar la API.
 */
export function statusFingerprint(p: {
  orderNumber: string;
  status?: string | null;
  callStatus?: string | null;
  dispatchStatus?: string | null;
}): string {
  const raw = [p.orderNumber, p.status ?? "", p.callStatus ?? "", p.dispatchStatus ?? ""]
    .map((v) => String(v).trim().toUpperCase())
    .join("|");
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * ¿Este snapshot de Aliclik es más viejo que el último que ya aplicamos? Pura.
 *
 * Se compara contra `api_updated_at` —el `updatedAt` que vio la propia API— y
 * NUNCA contra `last_report_at`, que también escribe el importador de Excel con
 * la hora de la subida. Son dos relojes distintos: uno mide cuándo se movió el
 * pedido en Aliclik, el otro cuándo miramos nosotros. Compararlos entre sí hacía
 * que cada reporte importado dejara `last_report_at = ahora` en todas las guías
 * del archivo y, con eso, que el barrido las diera por rezagadas y no volviera a
 * tocarlas hasta que Aliclik moviera el pedido (0117).
 *
 * Sin marca previa no hay guarda: una guía nunca leída por la API se aplica y
 * queda sellada para la próxima. Y una fecha ilegible no bloquea: no tener el
 * dato no debe congelar la guía, que para eso está la precedencia monotónica.
 */
export function apiSnapshotIsStale(
  updatedAt: string | null | undefined,
  apiUpdatedAt: string | null | undefined,
): boolean {
  if (!updatedAt || !apiUpdatedAt) return false;
  const seen = Date.parse(updatedAt);
  const applied = Date.parse(apiUpdatedAt);
  if (Number.isNaN(seen) || Number.isNaN(applied)) return false;
  return seen < applied;
}

export interface ApplySnapshotResult {
  ok: boolean;
  outcome: "applied" | "unchanged" | "unknown_order" | "error";
  shipmentId?: string;
  orderId?: string | null;
  from?: string;
  to?: string;
  error?: string;
}

/** La fila de `shipments` que necesita el aplicador. */
interface TrackedShipment {
  id: string;
  store_id: string;
  order_id: string | null;
  delivery_status: string;
  last_report_at: string | null;
  /** El `updatedAt` de Aliclik que vio la última lectura de la API (0117). */
  api_updated_at: string | null;
  external_order_number: string | null;
  /** AUR5X… — el código impreso en el paquete y, además, el `orderNumber` de la API. */
  guide_code: string | null;
  preparation_state: string | null;
  custody_state: string | null;
  ready_at: string | null;
  custody_transferred_at: string | null;
  /** El sello de devolución que ya tenga la guía. Entra para poder RESPETARLO
   *  (0118): la API relee guías ya devueltas —es lo que llena el motivo del
   *  courier, 0119— y sin esto cada relectura reescribiría el sello. */
  returned_at: string | null;
  returned_source: string | null;
  /** Lo que agendó la asesora: protege una reprogramación que aún no le toca. */
  next_followup_at: string | null;
}

/**
 * Escribe en nuestra guía el estado que Aliclik reporta para `orderNumber`.
 *
 * Tres guardas, en este orden:
 *   1. Si no conocemos el orderNumber, no se inventa una guía: se informa
 *      `unknown_order`. Crear filas a partir de un webhook sin firma sería
 *      dejar que cualquiera nos llene la base.
 *   2. `updatedAt` de Aliclik contra `api_updated_at`: un snapshot más viejo que
 *      el último que aplicamos se descarta. Es la protección real contra el
 *      desorden que la propia documentación anuncia. Contra `api_updated_at` y
 *      no contra `last_report_at`, que el Excel también escribe: ver
 *      `apiSnapshotIsStale`.
 *   3. `reconcileDeliveryStatus` (lib/shipments.ts): un estado solo avanza. Un
 *      `entregado` no se reabre y el trabajo del equipo no se pisa.
 */
export async function applyAliclikSnapshot(
  order: AliclikOrder,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<ApplySnapshotResult> {
  const orderNumber = (order.orderNumber ?? "").trim();
  if (!orderNumber) return { ok: false, outcome: "error", error: "Snapshot sin orderNumber." };

  // Dos vías para encontrar la guía, porque hay dos formas de que exista.
  //
  //   1. `external_order_number` — la guía la creamos nosotros por API y
  //      guardamos el identificador que nos devolvió Aliclik.
  //   2. `guide_code` — la guía entró por el Excel y nunca pasó por la API, así
  //      que ese campo está vacío. Son la MAYORÍA: 3.268 de 3.818 guías Aliclik.
  //
  // Buscar solo por (1) dejaba a la API ciega ante el 86% de las guías: el
  // barrido las contaba como `unknown_order` y no aplicaba nada, de modo que su
  // estado dependía por completo de que alguien subiera un Excel.
  //
  // Que (2) sea válido no es una suposición: el `orderNumber` que devuelve la
  // API ES el código AUR5X… del reporte. En las 550 guías que tienen ambos
  // campos coinciden en las 550, y ninguna usa el formato `ALC…` que describe
  // el comentario de lib/aliclik-reconcile.ts. `guide_code` además es único por
  // courier (0022), así que el emparejamiento no es ambiguo.
  //
  // Van en dos consultas y no en un `.or(...)`: el valor viene de la API y
  // PostgREST parsea el filtro `or` como texto, donde una coma o un paréntesis
  // en el valor cambiaría la consulta. Con `.eq()` el valor viaja como
  // parámetro y no hay nada que escapar.
  const COLUMNS =
    "id,store_id,order_id,delivery_status,last_report_at,api_updated_at,external_order_number,guide_code," +
    "preparation_state,custody_state,ready_at,custody_transferred_at,next_followup_at," +
    "returned_at,returned_source";

  const byExternal = await admin
    .from("shipments")
    .select(COLUMNS)
    .eq("external_order_number", orderNumber)
    .limit(1)
    .maybeSingle();
  if (byExternal.error) return { ok: false, outcome: "error", error: byExternal.error.message };

  let shipment = byExternal.data as TrackedShipment | null;
  if (!shipment) {
    const byGuide = await admin
      .from("shipments")
      .select(COLUMNS)
      .eq("courier", "aliclik")
      .eq("guide_code", orderNumber)
      .limit(1)
      .maybeSingle();
    if (byGuide.error) return { ok: false, outcome: "error", error: byGuide.error.message };
    shipment = byGuide.data as TrackedShipment | null;
  }
  if (!shipment) return { ok: false, outcome: "unknown_order" };

  // Si entró por `guide_code`, se graba el identificador: la próxima pasada usa
  // la vía rápida y el vínculo queda explícito en la fila en vez de deducirse
  // otra vez. Solo cuando está vacío — nunca se pisa uno ya grabado.
  const linkPatch: Record<string, unknown> = shipment.external_order_number
    ? {}
    : { external_order_number: orderNumber };

  // Guarda monotónica. Sin `updatedAt` se aplica igual: no tener el dato no debe
  // congelar la guía, y la precedencia de estados sigue protegiendo el resultado.
  const updatedAt = order.updatedAt ? new Date(order.updatedAt).toISOString() : null;
  if (apiSnapshotIsStale(updatedAt, shipment.api_updated_at)) {
    return { ok: true, outcome: "unchanged", shipmentId: shipment.id, orderId: shipment.order_id };
  }
  // Sella el snapshot aplicado, para que el de la próxima pasada se ordene
  // contra él. Solo cuando Aliclik dio la fecha: sin ella no hay nada que
  // sellar y borrar la marca anterior sería perder la guarda.
  const seenPatch: Record<string, unknown> = updatedAt ? { api_updated_at: updatedAt } : {};

  const isAgency = Boolean(order.shipping?.reference?.toLowerCase().includes("agencia"));
  const mapped = mapAliclikStatus({
    callStatus: order.callStatus,
    status: order.status,
    dispatchStatus: order.dispatchStatus,
    isAgency,
  });

  // Un estado que no supimos traducir NO toca la guía. Se registra el valor en
  // `reported_status` para poder verlo y ampliar el mapeo, pero el estado
  // operativo se queda como está.
  if (!mapped.deliveryStatus) {
    await admin
      .from("shipments")
      .update({
        ...reportedStatusPatch(order),
        last_report_at: updatedAt ?? new Date().toISOString(),
        ...seenPatch,
        ...collectAmountPatch(order),
        ...linkPatch,
      })
      .eq("id", shipment.id);
    return { ok: true, outcome: "unchanged", shipmentId: shipment.id, orderId: shipment.order_id };
  }

  // Un NO CONTESTA consume la reprogramación agendada: la guía vuelve a la cola
  // de llamadas. Va también acá y no solo en el Excel porque este barrido corre
  // cada pocos minutos: si solo lo hiciera el import, este la devolvería a "En
  // ruta" enseguida y la guía quedaría rebotando entre estados.
  //
  // El día del intento es HOY: la API está diciendo AHORA que no la encontró.
  const reopen = reopensForFailedAttempt({
    existingStatus: shipment.delivery_status,
    attemptFailed: mapped.attemptFailed,
    attemptDate: new Date().toISOString().slice(0, 10),
    scheduledFor: shipment.next_followup_at,
  });
  const next = reopen
    ? "pendiente"
    : reconcileDeliveryStatus(shipment.delivery_status, mapped.deliveryStatus);
  const nowIso = new Date().toISOString();

  const patch: Record<string, unknown> = {
    delivery_status: next,
    status_category: categoryOf(next),
    ...reportedStatusPatch(order),
    last_report_at: updatedAt ?? nowIso,
    // Sella la lectura de API: mientras siga fresca, un Excel importado no puede
    // cambiar el estado de esta guía (`reconcileReportedDeliveryStatus`). Va con
    // la hora REAL de la lectura, no con el `updatedAt` de Aliclik: lo que mide
    // la propiedad es hace cuánto miramos nosotros, no hace cuánto se movió el
    // pedido. Una guía quieta desde hace un mes que acabamos de consultar está
    // fresca; usar `updatedAt` la habría dado por vencida.
    api_report_at: nowIso,
    ...seenPatch,
    ...collectAmountPatch(order),
    ...linkPatch,
  };
  if (mapped.pickupState) patch.pickup_state = mapped.pickupState;
  // El sello viaja con su procedencia (0118) y se pone UNA VEZ. La regla vive en
  // `sealReturn` y acá importa más que en ningún otro camino: la pasada de motivo
  // (0119) relee justo las guías ya devueltas, así que sin esta guarda cada
  // consulta a la API convertiría en «API de Aliclik» un paquete que recibió una
  // persona en el almacén, borrando de paso su nombre de `returned_by`. Escribir
  // solo cuando el sello CAMBIA deja intacto lo que ya estaba.
  const seal = sealReturn(shipment, {
    returned: mapped.returned,
    at: updatedAt ?? nowIso,
    source: "aliclik_api",
  });
  if (seal.returned_at && seal.returned_at !== shipment.returned_at) {
    patch.returned_at = seal.returned_at;
    patch.returned_source = seal.returned_source;
    patch.returned_by = null;
  }
  if (next === "entregado") {
    patch.closed_at = updatedAt ?? nowIso;
    patch.delivered_source = "aliclik_api";
  }
  if (next === "en_ruta" && shipment.delivery_status === "pendiente") {
    patch.dispatched_at = updatedAt ?? nowIso;
  }

  // Aliclik ya hace el cotejo físico de esta modalidad. Su PREPARED equivale al
  // escaneo de almacén del MOM y PICKED equivale a transferencia de custodia.
  // Las reconciliaciones son monotónicas para que un snapshot retrasado no
  // deshaga un escaneo local ni haga volver un paquete desde el courier.
  const nextPreparation = reconcileAliclikPreparationState(
    shipment.preparation_state,
    mapped.preparationState,
  );
  if (nextPreparation && nextPreparation !== shipment.preparation_state) {
    patch.preparation_state = nextPreparation;
    if (nextPreparation === "listo_despacho" && !shipment.ready_at) {
      patch.ready_at = updatedAt ?? nowIso;
    }
  }

  const nextCustody = reconcileAliclikCustodyState(shipment.custody_state, mapped.custodyState);
  if (nextCustody && nextCustody !== shipment.custody_state) {
    patch.custody_state = nextCustody;
    if (nextCustody === "courier" && !shipment.custody_transferred_at) {
      patch.custody_transferred_at = updatedAt ?? nowIso;
    }
  }

  const { error: upErr } = await admin.from("shipments").update(patch).eq("id", shipment.id);
  if (upErr) return { ok: false, outcome: "error", error: upErr.message };

  // DEJAR CONSTANCIA EN EL PEDIDO, no solo en la guía.
  //
  // Hasta acá este barrido escribía en `shipments` y nada más: el pedido cambiaba
  // de estado —incluso se cerraba— sin una línea en su historial. Se vio en
  // #KP131561, una venta cerrada por la asesora que Aliclik anuló 33 segundos
  // después de crear la guía: la pestaña Actividad mostraba la llamada, la venta
  // y la guía, pero NO que se había anulado. El dato más importante de ese pedido
  // era justo el que faltaba, y quien lo abría no tenía cómo saber qué pasó.
  //
  // Medido: Shalom llevaba 2.241 eventos `courier_status` y Aliclik 0. Es la
  // misma información y el mismo courier de contraentrega; no había razón para
  // que uno dejara rastro y el otro no.
  //
  // SOLO EN LA TRANSICIÓN. El barrido relee las mismas guías cada pocos minutos:
  // escribir en cada pasada llenaría el historial de líneas idénticas y lo haría
  // ilegible, que es la otra forma de perder la información.
  //
  // La nota lleva la etiqueta CRUDA de Aliclik además del estado nuestro, porque
  // el motivo vive ahí: «anulado» a secas no distingue quién lo anuló ni por qué,
  // y `ANNULLED` en el tercer campo dice que fue su llamada y no su reparto.
  if (shipment.order_id && next !== shipment.delivery_status) {
    const etiqueta = aliclikStatusLabel(order).trim();
    await admin.from("order_events").insert({
      store_id: shipment.store_id,
      order_id: shipment.order_id,
      kind: "courier_status",
      occurred_at: updatedAt ?? nowIso,
      actor: null,
      source: "aliclik",
      courier: "aliclik",
      guide_code: shipment.guide_code,
      previous_status: shipment.delivery_status,
      new_status: next,
      new_operational: mapped.operational ?? null,
      note: `Aliclik: ${next}${etiqueta ? ` · ${etiqueta}` : ""}.`,
    });
  }

  // El Master se recalcula desde las guías; sin esto el cambio no se vería en
  // /dashboard/pedidos. `Safe` no lanza: un fallo de recálculo no debe deshacer
  // un estado ya escrito.
  if (shipment.order_id) {
    await recomputeOrderMasterSafe(admin, [shipment.order_id]);
  }

  return {
    ok: true,
    outcome: "applied",
    shipmentId: shipment.id,
    orderId: shipment.order_id,
    from: shipment.delivery_status,
    to: next,
  };
}

/**
 * Relee un pedido de Aliclik y aplica lo que diga. Es lo que hacen tanto el
 * webhook (tras registrar el aviso) como el cron.
 */
/**
 * Lo que Aliclik declara que cobrará en la puerta.
 *
 * Se guarda en CADA pasada, gane o no el mapeo de estados, porque el importe
 * puede cambiar sin que cambie el estado — es justo lo que pasa cuando alguien
 * lo corrige a mano en el panel de Aliclik. Si no viene el dato, no se toca la
 * columna: un `null` accidental borraría la última lectura buena.
 */
/**
 * El motivo tal y como lo dice Aliclik, y NADA cuando no dice nada.
 *
 * Mismo trato que el importe, y por la misma razón: `aliclikStatusLabel` une
 * tres campos y devuelve cadena vacía si los tres vienen vacíos. Escribirla
 * borraba un motivo que otra vía ya había registrado, y dejaba la columna con
 * dos formas de decir «no sé» —`''` y `null`— que cada consulta tenía que
 * distinguir a mano (así entraron las 5 vacías que limpia 0119).
 *
 * Importa más de lo que parece: sobre esta columna se evalúa el MOM §11
 * (lib/return-recovery.ts). Un motivo perdido no es un dato cosmético que falta,
 * es una guía que entra a la cola de recuperación sin que conste qué pasó en la
 * puerta.
 */
function reportedStatusPatch(order: AliclikOrder): Record<string, unknown> {
  const label = aliclikStatusLabel(order).trim();
  return label ? { reported_status: label } : {};
}

function collectAmountPatch(order: AliclikOrder): Record<string, unknown> {
  const total = order.total;
  if (total == null || !Number.isFinite(total) || total <= 0) return {};
  return { reported_collect_amount: total };
}

export async function refreshAliclikOrder(
  orderNumber: string,
  opts: AliclikClientOpts,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<ApplySnapshotResult> {
  const res = await getOrder(opts, orderNumber);
  if (!res.ok) return { ok: false, outcome: "error", error: res.error };
  if (!res.data) return { ok: false, outcome: "unknown_order", error: "Aliclik no devolvió el pedido." };
  return applyAliclikSnapshot(res.data, admin);
}
