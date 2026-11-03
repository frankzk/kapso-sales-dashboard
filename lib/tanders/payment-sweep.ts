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

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/crypto";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { categoryOf } from "@/lib/shipments";
import { extractPaymentEvidence, TandersClient } from "@/lib/tanders/client";
import {
  COURIER_COLLECTION_KIND,
  registerCourierCollection,
} from "@/lib/tanders/collection-payment";
import { alertDuplicatePayments } from "@/lib/tanders/duplicate-alert";
import { raiseRepeatedVoucherAlert, repeatedVoucherKey } from "@/lib/repeated-voucher-alert";
import {
  checkTandersPayment,
  normalizeOperationNumber,
  REASON_LABEL,
} from "@/lib/tanders/payment-check";
import {
  fichaDesdeComprobacion,
  mismaComprobacion,
  type ComprobacionGuardada,
  type HuellaComprobacion,
} from "@/lib/tanders/payment-sweep-rules";
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
/**
 * Guías ya validadas que se miran por pasada buscando la ficha que les falte.
 * Mirar una que ya la tiene es una consulta, no una llamada a Tanders ni al
 * modelo: por eso caben más que fichas se crean.
 */
export const MAX_VALIDADAS_POR_PASADA = 60;
/** Fichas que se crean como mucho por pasada: cada una baja la imagen y la sube al bucket. */
export const MAX_FICHAS_POR_PASADA = 20;

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
 * Escribe la comprobación SOLO si es un hecho nuevo.
 *
 * Una guía cuyo cobro no tiene ficha se relee en cada pasada —un comprobante
 * repetido no la tiene nunca, porque no es un cobro por confirmar sino una
 * incidencia—, y antes cada relectura dejaba una fila más aunque dijera lo
 * mismo: el 16-10-2026 había cuatro guías con 175-189 filas idénticas cada
 * una. Ahora se compara con la última fila de la guía: si el veredicto y el
 * comprobante leído son los mismos (ver `mismaComprobacion`) no se escribe
 * nada; la fila que ya está lo cuenta, y cuándo se miró por última vez lo
 * dice el sello de la guía. No se actualiza la fila vieja: seguiría diciendo
 * cuándo se llegó a ese veredicto, y eso es historial.
 *
 * Si no se puede leer la última fila, se escribe: una fila de más es ruido; un
 * veredicto que no quedó en ningún sitio es un hecho perdido.
 */
async function registrarComprobacion(
  admin: SupabaseClient,
  fila: { shipment_id: string; state: string; reasons: string[] } & Record<string, unknown>,
): Promise<"insertada" | "repetida"> {
  const nueva: HuellaComprobacion = {
    state: fila.state,
    reasons: fila.reasons,
    image_url: (fila.image_url as string | null | undefined) ?? null,
    operation_number: (fila.operation_number as string | null | undefined) ?? null,
    amount: (fila.amount as number | null | undefined) ?? null,
  };
  const { data, error } = await admin
    .from("tanders_payment_checks")
    .select("state,reasons,image_url,operation_number,amount")
    .eq("shipment_id", fila.shipment_id)
    .order("checked_at", { ascending: false })
    .limit(1);
  const previa = error ? null : (((data as HuellaComprobacion[] | null) ?? [])[0] ?? null);
  if (mismaComprobacion(previa, nueva)) return "repetida";
  await admin.from("tanders_payment_checks").insert(fila);
  return "insertada";
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
    await registrarComprobacion(admin, {
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

/**
 * ¿El cobro de esta guía ya tiene ficha en la cola de validación?
 *
 * Es lo que impide que una guía `rechazado` se relea en cada pasada: entra una
 * vez, deja su ficha, y a partir de ahí el barrido la salta. Sin esto, incluir
 * las rechazadas sería un bucle que quema llamadas a Tanders para siempre.
 */
async function yaEnLaCola(admin: SupabaseClient, orderId: string | null): Promise<boolean> {
  if (!orderId) return false;
  // Dos razones para saltarla, las dos de «esto ya lo tiene una persona»:
  //  · la ficha sigue viva en la cola (no rechazada), o
  //  · una persona YA DECIDIÓ sobre ella (`validated_by`), aunque la rechazara.
  //
  // La segunda es la que evita que el barrido PISE a la persona. Una guía cuyo
  // cobro se rechazó a mano vuelve a `rechazado`, que es candidata; sin esto el
  // barrido la releería, el modelo podría darla por buena y la devolvería a
  // `entregado`, deshaciendo en dos horas lo que alguien decidió mirando la
  // imagen. Y además volvería a encolar el mismo comprobante una y otra vez: un
  // rechazo libera el índice único, así que nada lo pararía.
  const { data } = await admin
    .from("order_payments")
    .select("id")
    .eq("order_id", orderId)
    .eq("kind", COURIER_COLLECTION_KIND)
    .or("validation_status.neq.rechazado,validated_by.not.is.null")
    .limit(1);
  return Boolean((data as { id: string }[] | null)?.length);
}

/**
 * ¿Ya se avisó de que esta guía trae un comprobante repetido?
 *
 * Un duplicado nunca entra a la cola —no es un cobro por confirmar, es una
 * incidencia—, así que `yaEnLaCola` no lo frena y la guía se relee. Eso está
 * bien (el bloqueo se mantiene) pero el aviso NO puede repetirse cada dos
 * horas: una alerta que llega sola todos los días deja de leerse, y entonces no
 * sirve el día que llegue una nueva.
 */
async function yaAvisado(admin: SupabaseClient, shipmentId: string): Promise<boolean> {
  const { data } = await admin
    .from("tanders_payment_checks")
    .select("id")
    .eq("shipment_id", shipmentId)
    .contains("reasons", ["operacion_duplicada"])
    .limit(1);
  return Boolean((data as { id: string }[] | null)?.length);
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
    /** La constancia dice que el dinero fue a un Yape (Prex, BBVA, Plin…). */
    aYape: boolean;
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
  /** Su cobro ya tiene ficha en «Validar pagos»: lo decide una persona. */
  enCola: number;
  /** Cobros encolados en esta pasada para que los confirme una persona. */
  aRevision: number;
  /**
   * Guías que el lector ya había dado por cobradas y cuyo cobro no tenía ficha
   * en «Validar pagos» —las validadas antes de que existiera (10 al
   * 12-09-2026) o aquellas cuya ficha no llegó a crearse— que se miraron en
   * esta pasada (hasta `MAX_FICHAS_POR_PASADA`).
   */
  sinFicha: number;
  /** De `aRevision`, las fichas creadas en esta pasada para esas guías. */
  fichasRecuperadas: number;
  /**
   * De `sinFicha`, las que no entran a la cola porque su comprobante ya está
   * en otro pedido o tiene alerta de comprobante repetido: son una incidencia,
   * no un cobro por confirmar.
   */
  fichasBloqueadas: number;
  /**
   * Guías validadas sin ficha cuyo pedido está anulado en Shopify
   * (`orders.cancelled_at`): no entran a «Validar pagos» como un cobro de
   * rutina, porque firmarlo lo cerraría como venta cobrada. Decide una persona
   * desde su ficha (MOM §9.4, §30.3 regla 3). No cuentan en `sinFicha` ni en
   * `errores`: no son un fallo, y se vuelven a mirar en cada vuelta de la cola.
   */
  fichasAnuladas: number;
  /** Los pedidos de `fichasAnuladas`, para nombrarlos. */
  anuladas: string[];
  /** Cuántas fichas prepara como mucho una pasada (`MAX_FICHAS_POR_PASADA`). */
  topeFichas: number;
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
  // se reanaliza — ya está esperando a un humano. Las ya `entregado` con el
  // cobro validado no vuelven aquí: si se quedaron sin ficha, las recoge
  // `recuperarFichasSinCola`, al final, sin volver a leerlas.
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
    // También las RECHAZADAS. Antes salían del barrido para siempre: el modelo
    // había dicho «esto no cuadra» y ahí moría, sin que nadie pudiera
    // resolverlo. Ahora tienen que llegar a la cola de «Validar pagos» para que
    // una persona decida, así que vuelven a ser candidatas. No es un bucle: en
    // cuanto el cobro tiene su ficha en la cola, la guía se salta (ver
    // `yaEnLaCola`).
    .or(
      "payment_check_state.is.null,payment_check_state.eq.pendiente," +
        "payment_check_state.eq.rechazado",
    )
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
    enCola: 0,
    aRevision: 0,
    sinFicha: 0,
    fichasRecuperadas: 0,
    fichasBloqueadas: 0,
    fichasAnuladas: 0,
    anuladas: [],
    topeFichas: MAX_FICHAS_POR_PASADA,
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
  // Las que esta pasada dejó `entregado` + `validado` y cuya ficha NO se pudo
  // crear (error al encolar, o una excepción después de marcarla). Sin sello
  // nuevo iban al final de la cola de `recuperarFichasSinCola`, detrás de
  // todas las validadas que ya tienen ficha —575 el 16-10-2026, unas 80 más
  // por semana—: una vuelta entera de espera, que crecía con el historial. Se
  // les BORRA el sello (`payment_checked_at` = null) para que la recuperación,
  // que ordena con los nulos primero, las mire en la pasada siguiente.
  const fichaFallida: string[] = [];

  for (const row of candidates) {
    // ¿Esta guía ya quedó entregada y validada sin que su ficha exista todavía?
    let validadaSinFicha = false;
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

      // Su cobro ya está en manos de una persona: no hay nada que volver a
      // preguntarle a Tanders. Va antes de gastar la llamada.
      if (await yaEnLaCola(admin, row.order_id)) {
        report.enCola += 1;
        mirados.push(row.id);
        continue;
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
      // Los bytes se conservan: además de leerlos, hay que guardarlos en
      // nuestro bucket al encolar el cobro. La evidencia de un pago no puede
      // depender de que Tanders conserve el archivo ni de un token que caduque.
      const bytes = await img.arrayBuffer();
      const base64 = Buffer.from(bytes).toString("base64");
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
          toYape: reading.toYape,
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
        // Solo se avisa la PRIMERA vez. La guía duplicada se relee en cada
        // pasada —no entra a la cola, porque no es un cobro por confirmar sino
        // una incidencia— y repetir el Telegram cada dos horas convertiría la
        // alerta en ruido: una que llega sola todos los días deja de leerse, y
        // entonces no sirve el día que llegue una nueva.
        if (dry || !(await yaAvisado(admin, row.id))) {
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
          aYape: reading.toYape,
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

      // Solo si es un hecho nuevo: releer y llegar a lo mismo no deja otra fila
      // (ver registrarComprobacion).
      await registrarComprobacion(admin, {
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
      validadaSinFicha = verdict.state === "validado" && !duplicateOf.length && Boolean(row.order_id);

      // 4) Y el cobro va a la cola donde lo confirma una PERSONA. El modelo
      //    valida una imagen, no un depósito: mientras no haya conexión con el
      //    estado de cuenta, la firma la pone alguien. Un duplicado no entra —no
      //    es un cobro por confirmar, es una incidencia, y ya quedó bloqueado.
      if (!duplicateOf.length && row.order_id) {
        const alta = await registerCourierCollection(admin, {
          storeId: row.store_id,
          orderId: row.order_id,
          guideCode: row.guide_code,
          imageUrl: evidence.imageUrl,
          imageBytes: bytes,
          mediaType,
          reading,
          verdict,
          expectedAmount: expected,
        });
        if (alta.registered) report.aRevision += 1;
        else if (alta.reason === "duplicado" && !alta.repeated.sameOrder) {
          // El nº de operación no chocó (o no se pudo leer), pero el ARCHIVO sí:
          // es el caso de los cuatro pedidos con el mismo Lemon de S/ 89, que se
          // bloqueaba sin que nadie se enterara (0226).
          await raiseRepeatedVoucherAlert(admin, {
            storeId: row.store_id,
            orderId: row.order_id,
            orderName: row.order_name ?? row.guide_code,
            alsoIn: [alta.repeated.orderName ?? "otro pedido"],
            operation: alta.repeated.operation,
            fileSha256: alta.repeated.sha256,
            amount: alta.repeated.amount,
            source: "cobro_courier",
            actions: ["El cobro no entró a «Validar pagos»: quedó bloqueado."],
          });
        } else if (alta.reason === "error") {
          report.errores += 1;
          recordSweepFailure(report.fallos, new Error(`No se pudo encolar el cobro: ${alta.detail}`));
        }
        if (alta.registered || alta.reason !== "error") validadaSinFicha = false;
      }
      if (validadaSinFicha) fichaFallida.push(row.id);

      if (row.order_id) await recomputeOrderMasterSafe(admin, [row.order_id]);
    } catch (err) {
      // Ya quedó entregada y validada, y la ficha no llegó: va primero en la
      // recuperación de la pasada siguiente (ver `fichaFallida`).
      if (validadaSinFicha && !fichaFallida.includes(row.id)) fichaFallida.push(row.id);
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
  const sinSello = new Set(fichaFallida);
  const sellar = mirados.filter((id) => !sinSello.has(id));
  if (!dry && sellar.length) {
    await admin
      .from("shipments")
      .update({ payment_checked_at: new Date().toISOString() })
      .in("id", sellar);
  }
  if (!dry && sinSello.size) {
    await admin
      .from("shipments")
      .update({ payment_checked_at: null })
      .in("id", [...sinSello]);
  }

  // El aviso, al final y solo de verdad. Va después de escribir para que un
  // Telegram lento no retrase el bloqueo, que es lo que de verdad protege.
  if (!dry) await alertDuplicatePayments(admin, report.duplicados);

  // Las ya validadas que se quedaron sin ficha. Va lo último: no le pregunta
  // nada a Tanders ni al modelo, así que no compite con el lote de arriba por
  // el límite de ritmo, y si se alarga no retrasa ni el sello ni el aviso.
  // Las que acaban de fallar no se reintentan en esta misma pasada: el fallo
  // (el bucket, la base) suele seguir ahí, y fallar otra vez les pondría el
  // sello de ahora y las mandaría al final de la cola.
  await recuperarFichasSinCola(admin, report, dry, sinSello);

  return report;
}

// ---------------------------------------------------------------------------
// Las validadas que se quedaron sin ficha
// ---------------------------------------------------------------------------
//
// EL FALLO (auditoría del 14-10-2026). 203 guías Tanders estaban `entregado` y
// con el cobro `validado` por el lector, y su pedido no tenía ficha
// `cobro_courier` en «Validar pagos»: 202 se validaron entre el 10 y el
// 12-09-2026, antes de que existiera la cola (0158), y una el 15-10 sin que
// su ficha llegara a crearse. El barrido de arriba solo relee las guías vivas
// (`pendiente`/`en_ruta`), así que esas no volvían a entrar nunca: nadie podía
// firmar su cobro, la liquidación no se cerraba y el pedido se quedaba en
// «Por cerrar · Pendiente de liquidación» para siempre (201 de ellas).
//
// LO QUE SE HACE. Se les prepara la ficha con la lectura que ya está guardada,
// sin volver a pasar la imagen por el modelo: el veredicto ya se dio, lo que
// faltaba era el sitio donde lo confirma una persona. La ficha entra
// `pendiente_revision`, como cualquier cobro que el lector dio por bueno, y
// ahí espera: nada se cierra solo. La guía no se toca —ya está donde la dejó
// su veredicto—. Un comprobante que ya está en otro pedido, o que ya tiene
// alerta de comprobante repetido, no entra: es una incidencia (ver
// `comprobanteConAlerta`).
//
// ACOTADO. Una consulta por pasada, con tope, por la misma cola ordenada por
// `payment_checked_at` que usa el barrido (0152): la que hace más tiempo que no
// se mira, primero, y cada guía mirada deja sello. Las que ya tienen ficha se
// saltan con una sola consulta para todo el lote. La ficha no se duplica: se
// comprueba antes, igual que `yaEnLaCola`, y `registerCourierCollection` lo
// vuelve a comprobar antes de escribir. La que el barrido de arriba dejó
// validada sin poder crearle la ficha llega sin sello y va primero en la pasada
// siguiente (ver `fichaFallida`).
//
// ANULADAS EN SHOPIFY (auditoría del 14-10-2026). Entre las 203 había cuatro
// pedidos anulados en Shopify (#KP131617, #AUR174710, #KP130888, #KP129592).
// La bandeja de «Validar pagos» no enseña la anulación, y firmar el cobro
// escribe `liquidation_closed`: el pedido se cerraría como venta cobrada. Es lo
// contrario de §30.3 regla 3 (entregado y anulado en Shopify queda como
// observación abierta, nunca se resuelve solo) y de la puerta a «entregado»
// (§11.4). No se les crea ficha: se cuentan aparte (`fichasAnuladas`) y decide
// una persona desde su ficha. Si la anulación no se puede leer, no se crea
// ninguna: «no lo sé» no es «no está anulado».

interface GuiaValidada {
  id: string;
  store_id: string;
  guide_code: string;
  order_id: string;
  order_name: string | null;
}

/**
 * De estos pedidos, los que ya tienen ficha del cobro del courier. Mismo
 * criterio que `yaEnLaCola`: viva en la cola, o ya decidida por una persona.
 * null si no se pudo saber: entonces no se crea ninguna, por si acaso.
 */
async function pedidosConFicha(
  admin: SupabaseClient,
  orderIds: string[],
): Promise<Set<string> | null> {
  const { data, error } = await admin
    .from("order_payments")
    .select("order_id")
    .in("order_id", orderIds)
    .eq("kind", COURIER_COLLECTION_KIND)
    .or("validation_status.neq.rechazado,validated_by.not.is.null");
  if (error) return null;
  return new Set(((data as { order_id: string }[] | null) ?? []).map((r) => r.order_id));
}

/**
 * ¿Este comprobante ya tiene, o tuvo, alerta de comprobante repetido (0226)?
 * Abierta o cerrada, por la huella del archivo o por el nº de operación.
 *
 * Es lo que impide encolar como «cobro por confirmar» lo que ya se sabe que es
 * una incidencia. El caso: el Lemon de S/ 89 que era el comprobante de cuatro
 * pedidos (#KP124940, #KP126075, #KP126468, #KP126871) está entre las guías
 * validadas sin ficha, y ninguno de los cuatro tiene un pago registrado con
 * el que choque. Sin esto, la primera de las cuatro entraría a «Validar
 * pagos» como un cobro de rutina, con la alerta cerrada con «estamos
 * consultando». También impide avisar dos veces: la guía se sigue mirando en
 * cada vuelta de la cola, y una alerta cerrada no frena otra igual.
 *
 * Si no se puede saber, se responde que sí: ni se encola ni se avisa, y se
 * vuelve a mirar en la próxima vuelta.
 */
async function comprobanteConAlerta(
  admin: SupabaseClient,
  sha256: string,
  operacion: string | null,
): Promise<boolean> {
  const claves = [
    repeatedVoucherKey({ fileSha256: sha256, operation: null, orderId: null, alsoIn: [] }),
    ...(operacion
      ? [repeatedVoucherKey({ fileSha256: null, operation: operacion, orderId: null, alsoIn: [] })]
      : []),
  ];
  const { data, error } = await admin
    .from("collection_alerts")
    .select("id")
    .eq("kind", "comprobante_repetido")
    .in("dedupe_key", claves)
    .limit(1);
  if (error) return true;
  return Boolean((data as { id: string }[] | null)?.length);
}

/**
 * De estos pedidos, los anulados en Shopify (`orders.cancelled_at`), con su
 * nombre. null si no se pudo saber: entonces no se crea ninguna ficha.
 */
async function pedidosAnulados(
  admin: SupabaseClient,
  orderIds: string[],
): Promise<Set<string> | null> {
  const { data, error } = await admin
    .from("orders")
    .select("id,cancelled_at")
    .in("id", orderIds)
    .not("cancelled_at", "is", null);
  if (error) return null;
  return new Set(((data as { id: string }[] | null) ?? []).map((r) => r.id));
}

async function recuperarFichasSinCola(
  admin: SupabaseClient,
  report: SweepReport,
  dry: boolean,
  recienFallidas: ReadonlySet<string> = new Set(),
): Promise<void> {
  const { data, error } = await admin
    .from("shipments")
    .select("id,store_id,guide_code,order_id,order_name")
    .eq("courier", "tanders")
    .eq("delivery_status", "entregado")
    .eq("payment_check_state", "validado")
    .not("order_id", "is", null)
    .order("payment_checked_at", { ascending: true, nullsFirst: true })
    .limit(MAX_VALIDADAS_POR_PASADA);
  if (error) {
    report.errores += 1;
    recordSweepFailure(report.fallos, new Error(`No se pudieron leer las guías validadas: ${error.message}`));
    return;
  }
  const guias = (data as GuiaValidada[] | null) ?? [];
  if (!guias.length) return;

  const pedidos = [...new Set(guias.map((g) => g.order_id))];
  const [conFicha, anulados] = await Promise.all([pedidosConFicha(admin, pedidos), pedidosAnulados(admin, pedidos)]);
  if (!conFicha) {
    report.errores += 1;
    recordSweepFailure(report.fallos, new Error("No se pudo comprobar qué guías validadas ya tienen ficha."));
    return;
  }
  if (!anulados) {
    report.errores += 1;
    recordSweepFailure(
      report.fallos,
      new Error("No se pudo comprobar qué guías validadas tienen el pedido anulado en la tienda: no se creó ninguna ficha."),
    );
    return;
  }

  // Mismo sello que el barrido de arriba: TODA guía mirada lo lleva, tenga
  // ficha o no y salga bien o mal, para que la siguiente pasada empiece por
  // las otras. La que no se llegó a mirar por el tope no lo lleva: va primero.
  const mirados: string[] = [];
  let intentadas = 0;

  for (const g of guias) {
    // La acaba de dejar sin ficha el barrido de arriba: sin sello, va primero
    // la próxima vez.
    if (recienFallidas.has(g.id)) continue;
    if (conFicha.has(g.order_id)) {
      mirados.push(g.id);
      continue;
    }
    if (anulados.has(g.order_id)) {
      // Su cobro no entra a «Validar pagos»: firmarlo cerraría como venta
      // cobrada un pedido anulado. Se mira igual (sello) y se nombra.
      report.fichasAnuladas += 1;
      report.anuladas.push(g.order_name ?? g.guide_code);
      mirados.push(g.id);
      continue;
    }
    if (intentadas >= MAX_FICHAS_POR_PASADA) continue;
    intentadas += 1;
    report.sinFicha += 1;
    mirados.push(g.id);

    try {
      const { data: ultima } = await admin
        .from("tanders_payment_checks")
        .select(
          "state,reasons,image_url,operation_number,amount,expected_amount,recipient_name,model,checked_at,raw",
        )
        .eq("shipment_id", g.id)
        .order("checked_at", { ascending: false })
        .limit(1);
      const ficha = fichaDesdeComprobacion(((ultima as ComprobacionGuardada[] | null) ?? [])[0]);
      if (!ficha.ok) {
        report.errores += 1;
        recordSweepFailure(report.fallos, new Error(ficha.motivo));
        continue;
      }
      // La imagen, de donde se leyó entonces. Hace falta igual que en el
      // camino normal: la ficha la guarda en NUESTRO bucket, y su huella sha256
      // es la que caza el mismo archivo en otro pedido. Bajarla no escribe
      // nada, así que también se hace en seco.
      const img = await fetch(ficha.imageUrl);
      if (!img.ok) {
        report.errores += 1;
        recordSweepFailure(report.fallos, new Error("No se pudo bajar la constancia guardada de una guía validada."));
        continue;
      }
      const bytes = await img.arrayBuffer();
      const mediaType = normalizeMediaType(img.headers.get("content-type"));

      // Un comprobante que ya se sabe repetido no es un cobro por confirmar:
      // no entra a la cola. Ver comprobanteConAlerta.
      const sha256 = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
      if (await comprobanteConAlerta(admin, sha256, normalizeOperationNumber(ficha.reading.operationNumber))) {
        report.fichasBloqueadas += 1;
        continue;
      }
      if (dry) continue;

      const alta = await registerCourierCollection(admin, {
        storeId: g.store_id,
        orderId: g.order_id,
        guideCode: g.guide_code,
        imageUrl: ficha.imageUrl,
        imageBytes: bytes,
        mediaType,
        reading: ficha.reading,
        verdict: ficha.verdict,
        expectedAmount: ficha.expectedAmount,
      });
      if (alta.registered) {
        report.aRevision += 1;
        report.fichasRecuperadas += 1;
        await recomputeOrderMasterSafe(admin, [g.order_id]);
      } else if (alta.reason === "ya_registrado") {
        report.enCola += 1;
      } else if (alta.reason === "duplicado") {
        report.fichasBloqueadas += 1;
        // El mismo comprobante ya está en otro pedido: es la incidencia de 0226
        // y se avisa igual que en el camino normal. Una sola vez: en la vuelta
        // siguiente de la cola, comprobanteConAlerta ya la encuentra. El mismo
        // pedido dos veces es un reintento, no se avisa.
        if (!alta.repeated.sameOrder) {
          await raiseRepeatedVoucherAlert(admin, {
            storeId: g.store_id,
            orderId: g.order_id,
            orderName: g.order_name ?? g.guide_code,
            alsoIn: [alta.repeated.orderName ?? "otro pedido"],
            operation: alta.repeated.operation,
            fileSha256: alta.repeated.sha256,
            amount: alta.repeated.amount,
            source: "cobro_courier",
            actions: ["La guía figura como cobrada por el lector, pero su cobro no entró a «Validar pagos»."],
          });
        }
      } else if (alta.reason === "error") {
        report.errores += 1;
        recordSweepFailure(report.fallos, new Error(`No se pudo encolar el cobro: ${alta.detail}`));
      }
    } catch (err) {
      report.errores += 1;
      recordSweepFailure(report.fallos, err);
    }
  }

  if (!dry && mirados.length) {
    await admin
      .from("shipments")
      .update({ payment_checked_at: new Date().toISOString() })
      .in("id", mirados);
  }
}
