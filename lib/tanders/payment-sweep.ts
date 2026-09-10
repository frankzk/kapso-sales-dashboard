// El barrido de cobros de Tanders.
//
// Vive aparte del cron por una razón concreta: el MODO EN SECO tiene que
// recorrer exactamente el mismo camino que el real. Si fueran dos
// implementaciones, revisar los veredictos en seco no probaría nada sobre lo que
// hará el cron de verdad — que es justo para lo que existe esa revisión.
//
// EL ORDEN ES LA REGLA DEL NEGOCIO: que Tanders diga "entregado" no basta. La
// guía pasa a `entregado` SOLO si la constancia de pago valida. Una entrega sin
// cobro confirmado se queda donde está y espera a que alguien mire.
//
// El único parámetro que cambia el comportamiento es `dry`: con él no se escribe
// nada —ni el estado de la guía, ni la fila de la comprobación— y se devuelve el
// detalle de qué leyó el modelo en cada constancia.
//
// SERVER-ONLY: descifra la contraseña de la tienda y la clave del modelo.

import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/crypto";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { categoryOf } from "@/lib/shipments";
import { extractPaymentEvidence, TandersClient } from "@/lib/tanders/client";
import { alertDuplicatePayments } from "@/lib/tanders/duplicate-alert";
import {
  checkTandersPayment,
  normalizeOperationNumber,
  REASON_LABEL,
} from "@/lib/tanders/payment-check";
import { readTandersPayment } from "@/lib/tanders/payment-vision";
import {
  isNotYetDelivered,
  isThrottled,
  pace,
  recordSweepFailure,
  type SweepFailure,
} from "@/lib/tanders/sweep-failures";
import { normalizeMediaType, type StoreVisionCreds } from "@/lib/vision";

const DAY_MS = 86_400_000;
/** Días hacia atrás. Cubre "también las de esta semana" con margen. */
export const LOOKBACK_DAYS = 8;
/** Tope por pasada: cada guía cuesta una llamada al modelo. */
export const MAX_PER_RUN = 60;
/** Respuestas crudas que se conservan en seco. Tres bastan para ver la forma. */
const MAX_MUESTRAS = 3;

interface Candidate {
  id: string;
  store_id: string;
  guide_code: string;
  tanders_order_id: string | null;
  order_id: string | null;
  order_name: string | null;
  payment_check_state: string | null;
  tanders_raw: { collectionAmount?: unknown } | null;
}

/** Monto que la guía dice que había que cobrar. */
function expectedAmount(raw: Candidate["tanders_raw"]): number | null {
  const v = raw?.collectionAmount;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * ¿Este nº de operación ya se registró en OTRA guía?
 *
 * Es la detección de comprobante reusado: el mismo pago no puede cobrar dos
 * pedidos. Se compara contra cualquier comprobación anterior, no solo contra
 * las validadas —un voucher que se rechazó en la guía A por monto y reaparece
 * en la B sigue siendo el mismo papel presentado dos veces—, y se excluye la
 * propia guía, que se relee en cada pasada mientras siga pendiente.
 *
 * Devuelve las guías con las que choca, con su estado actual: hace falta para
 * nombrarlas en el veredicto Y para poder desandar la que ya se hubiera dado
 * por cobrada con ese mismo comprobante. Si la consulta falla devuelve vacío:
 * no acusar por un error de red es preferible a acusar en falso, y la guía se
 * vuelve a mirar en la siguiente pasada.
 */
interface GuiaChocada {
  id: string;
  nombre: string;
  paymentCheckState: string | null;
  deliveryStatus: string;
  orderId: string | null;
  storeId: string;
}

async function guiasConLaMismaOperacion(
  admin: SupabaseClient,
  operacion: string | null,
  shipmentId: string,
): Promise<GuiaChocada[]> {
  if (!operacion) return [];
  const { data, error } = await admin
    .from("tanders_payment_checks")
    .select("shipment_id")
    .eq("operation_number", operacion)
    .neq("shipment_id", shipmentId)
    .limit(20);
  if (error) return [];
  const ids = [...new Set(((data as { shipment_id: string }[]) ?? []).map((r) => r.shipment_id))];
  if (!ids.length) return [];

  const { data: guias } = await admin
    .from("shipments")
    .select("id,order_name,guide_code,payment_check_state,delivery_status,order_id,store_id")
    .in("id", ids);
  return ((guias as Record<string, string | null>[]) ?? []).map((g) => ({
    id: String(g.id),
    nombre: g.order_name ?? String(g.guide_code),
    paymentCheckState: g.payment_check_state ?? null,
    deliveryStatus: String(g.delivery_status ?? ""),
    orderId: g.order_id ?? null,
    storeId: String(g.store_id),
  }));
}

/**
 * Desanda la guía que YA se había dado por cobrada con el comprobante que
 * ahora resulta compartido.
 *
 * POR QUÉ HACE FALTA. La comprobación bloquea la SEGUNDA guía que ve el mismo
 * nº de operación — la primera ya pasó. Cuál fue cuál lo decide el orden de la
 * cola, que es arbitrario: el 10-09-2026 las dos guías del yape de S/ 198
 * (#KP125070 y #KP124793) cayeron en la misma pasada con un minuto de
 * diferencia. Sin esto, una de las dos se queda marcada como cobrada con un
 * comprobante que ya no prueba nada, y justo la que nadie va a revisar.
 *
 * `entregado` en este sistema significa «entregado Y cobrado» (§9.4). Si el
 * cobro deja de estar probado, `entregado` deja de ser cierto: la guía vuelve
 * a `en_ruta`, que es lo que el courier sí acredita. No es inventar una regla
 * nueva, es aplicar la que ya había.
 *
 * NO se toca una guía en `revisado`: ahí un administrador ya miró y decidió a
 * mano, y su decisión no la deshace un barrido.
 */
async function desandarCobroDuplicado(
  admin: SupabaseClient,
  chocadas: GuiaChocada[],
  operacion: string,
  nuevaGuia: string,
): Promise<string[]> {
  const desandadas: string[] = [];
  for (const otra of chocadas) {
    if (otra.paymentCheckState !== "validado") continue;
    await admin.from("tanders_payment_checks").insert({
      shipment_id: otra.id,
      store_id: otra.storeId,
      state: "rechazado",
      reasons: ["operacion_duplicada"],
      operation_number: operacion,
      raw: {
        motivo:
          `Se dio por cobrada con la operación ${operacion}, que después apareció ` +
          `también en ${nuevaGuia}. Al menos una de las dos no está pagada.`,
      },
    });
    const patch: Record<string, unknown> = { payment_check_state: "rechazado" };
    if (otra.deliveryStatus === "entregado") {
      patch.delivery_status = "en_ruta";
      patch.status_category = categoryOf("en_ruta");
    }
    await admin.from("shipments").update(patch).eq("id", otra.id);
    if (otra.orderId) await recomputeOrderMasterSafe(admin, [otra.orderId]);
    desandadas.push(otra.nombre);
  }
  return desandadas;
}

/** Un comprobante que apareció en más de una guía. */
export interface SweepDuplicate {
  guia: string;
  pedido: string | null;
  operacion: string;
  /** Las otras guías donde ya estaba. */
  otras: string[];
  /**
   * De esas otras, las que se habían dado por COBRADAS con este comprobante y
   * han dejado de estarlo. Son las que urge revisar: alguien ya las contó como
   * plata entrada.
   */
  desandadas: string[];
  monto: number | null;
  storeId: string;
}

export interface SweepDetail {
  guia: string;
  pedido: string | null;
  cobroEsperado: number | null;
  /** null cuando no se llegó a leer ninguna imagen. */
  leido: {
    esComprobante: boolean;
    medio: string;
    destinatario: string | null;
    monto: number | null;
    operacion: string | null;
    modelo: string;
  } | null;
  veredicto: string;
  motivos: string[];
  resumen: string;
  /** Qué haría (o hizo) con la guía. */
  haria: string;
  imagen: string | null;
}

export interface SweepReport {
  scanned: number;
  /** Sin constancia de pago todavía en Tanders: no hay nada que validar. */
  enCurso: number;
  entregado: number;
  validado: number;
  rechazado: number;
  pendiente: number;
  errores: number;
  /** POR QUÉ falló lo que falló, agrupado. Ver sweep-failures.ts. */
  fallos: SweepFailure[];
  /** true = Tanders devolvió 429 y el barrido paró ahí; lo demás va en la próxima pasada. */
  detenido: boolean;
  /**
   * SOLO en seco: la respuesta cruda de las guías entregadas en las que no se
   * reconoció ninguna constancia. Es lo único que permite saber si el extractor
   * busca donde no es — sin esto, «sin constancia aún» es indistinguible de
   * «no supe leerla».
   */
  muestras: { guia: string; respuesta: string }[];
  /**
   * Comprobantes que ya se habían presentado en otra guía. Van aparte del
   * resto de rechazos porque son los únicos que avisan por Telegram: un cobro
   * mal hecho se corrige, el mismo papel dos veces hay que mirarlo hoy.
   */
  duplicados: SweepDuplicate[];
  rejected: string[];
  detalle: SweepDetail[];
}

export async function sweepTandersPayments(
  admin: SupabaseClient,
  opts: { dry?: boolean } = {},
): Promise<SweepReport> {
  const dry = opts.dry === true;
  const since = new Date(Date.now() - LOOKBACK_DAYS * DAY_MS).toISOString();

  // Guías vivas: las que todavía no llegaron a un final. Una `rechazado` tampoco
  // se reanaliza — ya está esperando a un humano.
  //
  // La ventana mira la creación O el último reporte de su API. Solo por creación,
  // una guía que Tanders da por entregada más tarde de lo normal caía fuera del
  // corte antes de que nadie mirara su cobro y se quedaba varada para siempre;
  // el barrido de estados la vuelve a poner a tiro al releerla.
  const { data, error } = await admin
    .from("shipments")
    .select(
      "id,store_id,guide_code,tanders_order_id,order_id,order_name,payment_check_state,tanders_raw",
    )
    .eq("courier", "tanders")
    .in("delivery_status", ["pendiente", "en_ruta"])
    .or(`created_at.gte.${since},api_report_at.gte.${since}`)
    .or("payment_check_state.is.null,payment_check_state.eq.pendiente")
    // LA QUE HACE MÁS TIEMPO QUE NO SE MIRA, PRIMERO. Sin este orden la
    // consulta cortaba en 60 de 238 candidatas y PostgREST elegía cuáles: las
    // mismas cada pasada, y el resto nunca. No era atraso, era hambre — el
    // 10-09-2026 el #AUR176448 llevaba un día entregado y con su Yape
    // verificado sin entrar jamás en el lote. Mismo patrón que el barrido de
    // estados con `last_report_at` (0152).
    .order("payment_checked_at", { ascending: true, nullsFirst: true })
    .limit(MAX_PER_RUN);
  if (error) throw new Error(error.message);

  const candidates = (data as Candidate[]) ?? [];
  const report: SweepReport = {
    scanned: candidates.length,
    enCurso: 0,
    entregado: 0,
    validado: 0,
    rechazado: 0,
    pendiente: 0,
    errores: 0,
    fallos: [],
    detenido: false,
    muestras: [],
    duplicados: [],
    rejected: [],
    detalle: [],
  };

  // Una sesión por tienda: el cliente cachea su token entre guías.
  const clients = new Map<string, TandersClient | null>();
  const visionCreds = new Map<string, StoreVisionCreds>();

  // Las guías que esta pasada SÍ llegó a mirar. Se sellan todas juntas al
  // final para que la siguiente empiece por las otras: es lo único que hace
  // que la cola avance en vez de repetir siempre el mismo lote (0152). Entra
  // también lo que falló de forma definitiva —una guía sin credenciales
  // fallaría igual mañana, y dejarla sin sello la clava en la cabeza de la
  // cola—. NO entra la que se topó con el 429: a esa no se la llegó a
  // preguntar, así que le toca ir primero la próxima vez.
  const mirados: string[] = [];

  for (const row of candidates) {
    try {
      if (!clients.has(row.store_id)) {
        const { data: store } = await admin
          .from("stores")
          .select("tanders_email,tanders_password_enc,anthropic_api_key_enc,anthropic_model")
          .eq("id", row.store_id)
          .maybeSingle();
        const st = store as {
          tanders_email: string | null;
          tanders_password_enc: string | null;
          anthropic_api_key_enc: string | null;
          anthropic_model: string | null;
        } | null;
        clients.set(
          row.store_id,
          st?.tanders_email && st.tanders_password_enc
            ? new TandersClient({
                email: st.tanders_email,
                password: decrypt(st.tanders_password_enc),
              })
            : null,
        );
        // La clave de la TIENDA manda sobre la del entorno (0052): el gasto de
        // visión de cada tienda cae en su propia cuenta.
        visionCreds.set(row.store_id, {
          anthropicApiKey: st?.anthropic_api_key_enc ? decrypt(st.anthropic_api_key_enc) : null,
          anthropicModel: st?.anthropic_model ?? null,
        });
      }

      const client = clients.get(row.store_id);
      if (!client || !row.tanders_order_id) {
        report.errores += 1;
        recordSweepFailure(
          report.fallos,
          new Error(
            !client
              ? "La tienda no tiene credenciales de Tanders configuradas."
              : "La guía no tiene id interno de Tanders (tanders_order_id).",
          ),
        );
        mirados.push(row.id);
        continue;
      }

      // 1) La constancia de pago, DIRECTAMENTE. Antes se preguntaba primero el
      //    estado (`GET /orders/{id}`) y solo con DELIVERED se pedía la
      //    constancia: esa primera llamada era de administrador, respondía 403
      //    y ninguna guía llegó nunca aquí. La constancia bajo `files_payment/`
      //    existe solo cuando el motorizado cobró, así que ES la prueba de
      //    entrega, y pedirla directa además es una llamada menos por guía,
      //    que con el límite de ritmo de Tanders cuenta. Sin constancia no
      //    hay nada que validar: queda en curso.
      await pace();
      const raw = await client.evidences(row.tanders_order_id);
      const payments = extractPaymentEvidence(raw);
      if (!payments.length) {
        // La API contestó 200, así que la guía SÍ está entregada (si no,
        // habría dado 400). Que no encontremos constancia es sospechoso: se
        // guarda una muestra para poder mirar dónde está de verdad.
        report.enCurso += 1;
        if (dry && report.muestras.length < MAX_MUESTRAS) {
          report.muestras.push({
            guia: row.guide_code,
            respuesta: JSON.stringify(raw).slice(0, 2000),
          });
        }
        mirados.push(row.id);
        continue;
      }

      // La más reciente: si hubo un reintento de cobro, la que vale es la última.
      const evidence = payments[payments.length - 1]!;
      const img = await fetch(evidence.imageUrl);
      if (!img.ok) {
        report.errores += 1;
        mirados.push(row.id);
        continue;
      }
      const base64 = Buffer.from(await img.arrayBuffer()).toString("base64");
      const mediaType = normalizeMediaType(img.headers.get("content-type"));

      const reading = await readTandersPayment(
        base64,
        mediaType,
        visionCreds.get(row.store_id) ?? {},
      );
      const expected = expectedAmount(row.tanders_raw);
      const operacion = normalizeOperationNumber(reading.operationNumber);
      const chocadas = await guiasConLaMismaOperacion(admin, operacion, row.id);
      const duplicateOf = chocadas.map((c) => c.nombre);
      const verdict = checkTandersPayment({
        duplicateOf,
        voucher: {
          ok: reading.ok,
          isVoucher: reading.isPaymentProof,
          method: reading.method,
          recipientName: reading.recipientName,
          amount: reading.amount,
          operationNumber: operacion,
        },
        expectedAmount: expected,
      });
      if (duplicateOf.length) {
        // La que ya se había dado por cobrada con este mismo comprobante deja
        // de estarlo: bloquear solo a la recién llegada dejaría cobrada
        // justamente la que nadie va a revisar. Ver desandarCobroDuplicado.
        const desandadas = dry
          ? chocadas.filter((c) => c.paymentCheckState === "validado").map((c) => c.nombre)
          : await desandarCobroDuplicado(
              admin,
              chocadas,
              operacion ?? "?",
              row.order_name ?? row.guide_code,
            );
        report.duplicados.push({
          guia: row.guide_code,
          pedido: row.order_name,
          operacion: operacion ?? "?",
          otras: duplicateOf,
          desandadas,
          monto: reading.amount,
          storeId: row.store_id,
        });
      }

      report[verdict.state as "validado" | "rechazado" | "pendiente"] += 1;
      if (verdict.state === "validado") report.entregado += 1;
      if (verdict.state === "rechazado") {
        report.rejected.push(
          `${row.order_name ?? row.guide_code}: ${verdict.reasons
            .map((r) => REASON_LABEL[r])
            .join(", ")}`,
        );
      }
      report.detalle.push({
        guia: row.guide_code,
        pedido: row.order_name,
        cobroEsperado: expected,
        leido: {
          esComprobante: reading.isPaymentProof,
          medio: reading.method,
          destinatario: reading.recipientName,
          monto: reading.amount,
          operacion: operacion,
          modelo: reading.model,
        },
        veredicto: verdict.state,
        motivos: verdict.reasons,
        resumen: verdict.summary,
        haria: verdict.state === "validado" ? "marcar ENTREGADO" : "dejar la guía como está",
        imagen: evidence.imageUrl,
      });

      mirados.push(row.id);
      if (dry) continue;

      await admin.from("tanders_payment_checks").insert({
        shipment_id: row.id,
        store_id: row.store_id,
        image_url: evidence.imageUrl,
        state: verdict.state,
        reasons: verdict.reasons,
        recipient_name: reading.recipientName,
        amount: reading.amount,
        // Normalizado: es la clave con la que se detecta el reuso, y dos
        // transcripciones del mismo pago tienen que colisionar.
        operation_number: operacion,
        expected_amount: expected,
        model: reading.model,
        raw: raw as Record<string, unknown>,
      });

      // 3) El estado solo avanza con el cobro validado. Darla por entregada sin
      //    eso sería dar por cobrado un dinero que nadie confirmó.
      const patch: Record<string, unknown> = { payment_check_state: verdict.state };
      if (verdict.state === "validado") {
        patch.delivery_status = "entregado";
        patch.status_category = "delivered";
      }
      await admin.from("shipments").update(patch).eq("id", row.id);
      if (row.order_id) await recomputeOrderMasterSafe(admin, [row.order_id]);
    } catch (err) {
      // «Todavía no entregada» es la respuesta normal de una guía en ruta, no
      // un fallo: se cuenta como en curso y no ensucia el reporte.
      if (isNotYetDelivered(err)) {
        report.enCurso += 1;
        mirados.push(row.id);
        continue;
      }
      // Una guía que falla no puede tumbar el barrido de las demás — pero el
      // motivo se guarda. Ver sweep-failures.ts.
      report.errores += 1;
      recordSweepFailure(report.fallos, err);
      // Un 429 es Tanders diciendo «basta»: lo que queda va en la próxima. Sin
      // sello: a esta guía no se la llegó a preguntar.
      if (isThrottled(err)) {
        report.detenido = true;
        break;
      }
      mirados.push(row.id);
    }
  }

  // El sello, de una vez. Va aparte del veredicto a propósito: se pone también
  // a las que no dieron ninguno —en ruta, sin credenciales, imagen caída—, que
  // son justo las que sin él se quedarían atascadas al frente de la cola para
  // siempre. En seco no se escribe nada, como el resto del barrido.
  if (!dry && mirados.length) {
    await admin
      .from("shipments")
      .update({ payment_checked_at: new Date().toISOString() })
      .in("id", mirados);
  }

  // El aviso, al final y solo de verdad. Va después de escribir para que un
  // Telegram lento no retrase el bloqueo, que es lo que de verdad protege.
  if (!dry) await alertDuplicatePayments(admin, report.duplicados);

  return report;
}
