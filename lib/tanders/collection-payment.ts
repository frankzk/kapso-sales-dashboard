// El cobro que hizo el motorizado entra a la cola de «Validar pagos».
//
// POR QUÉ EXISTE ESTE PUENTE. El lector de imágenes sabe decir «este yape es de
// S/ 198 y va a Grupo GF SAC», pero valida UNA IMAGEN, no un depósito: no
// detecta una captura editada, ni un comprobante real de otra transferencia, ni
// el mismo voucher reusado si el número se leyó mal. Mientras no haya conexión
// con el estado de cuenta del banco, quien declara que el dinero entró tiene
// que ser una persona — y esa persona ya tiene su pantalla desde 0049.
//
// Así que el modelo pasa de DECIDIR a PREPARAR LA FICHA: baja la imagen, la
// guarda en nuestro bucket, transcribe monto, operación y destinatario, y deja
// el cobro en la cola con el veredicto como pista. La firma la pone el humano.
//
// LO QUE SE GANA AL ENTRAR AQUÍ, y que la vía paralela de Tanders no tenía:
// el nº de operación es único en TODO el sistema, la huella sha256 atrapa la
// misma imagen renombrada —es lo que habría cazado el «198yape.png» sin
// depender de leer bien el número—, y `lib/yape-dedup.ts` añade la coincidencia
// difusa de monto + fecha + pagador. Tres capas, ya probadas.
//
// SERVER-ONLY: escribe en el bucket privado de comprobantes.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { categoryOf } from "@/lib/shipments";
import { VOUCHER_BUCKET } from "@/lib/voucher-inspect";
import { findDuplicate, normalizeOperationNumber, type ExistingPayment } from "@/lib/yape-dedup";
import type { PaymentCheckVerdict } from "@/lib/tanders/payment-check";
import type { TandersPaymentReading } from "@/lib/tanders/payment-vision";

/** El tipo con el que vive en `order_payments`. Ver 0158. */
export const COURIER_COLLECTION_KIND = "cobro_courier";

export interface CollectionInput {
  storeId: string;
  orderId: string;
  guideCode: string;
  /** La imagen tal cual la sirve Tanders. */
  imageUrl: string;
  imageBytes: ArrayBuffer;
  mediaType: string;
  reading: TandersPaymentReading;
  verdict: PaymentCheckVerdict;
  /** Lo que la guía decía que había que cobrar. */
  expectedAmount: number | null;
}

export type CollectionOutcome =
  | { registered: true; status: string }
  | { registered: false; reason: "ya_registrado" | "duplicado" | "sin_pedido" | "error"; detail?: string };

/**
 * En qué estado entra a la cola.
 *
 * No es el veredicto del modelo tal cual: la cola tiene su propio vocabulario y
 * cada valor le dice al revisor QUÉ mirar.
 *  - `pendiente_revision`: el modelo no vio nada raro. Confirmación de rutina.
 *  - `revision_admin`: el modelo vio algo que no cuadra (monto, destinatario,
 *    medio). No es un rechazo — es «mira esto tú».
 *  - `info_incompleta`: no se pudo leer. Culpar a la captura cuando lo que
 *    falló fue el lector manda a perseguir a alguien por una foto correcta.
 */
export function collectionReviewStatus(verdict: PaymentCheckVerdict): string {
  if (verdict.state === "validado") return "pendiente_revision";
  if (verdict.state === "pendiente") return "info_incompleta";
  return "revision_admin";
}

/** Los pagos con los que este cobro podría chocar, leídos de la base. */
async function posiblesChoques(
  admin: SupabaseClient,
  operation: string | null,
  sha256: string,
  amount: number | null,
): Promise<ExistingPayment[]> {
  const cols =
    "id,order_id,kind,amount,operation_number,paid_at,payer_name,payer_phone,file_sha256,validation_status";
  const vistos = new Map<string, ExistingPayment>();
  const añadir = (filas: unknown) => {
    for (const f of (filas as ExistingPayment[]) ?? []) vistos.set(f.id, f);
  };

  if (operation) {
    const { data } = await admin.from("order_payments").select(cols).eq("operation_number", operation);
    añadir(data);
  }
  const { data: porArchivo } = await admin.from("order_payments").select(cols).eq("file_sha256", sha256);
  añadir(porArchivo);
  if (amount != null) {
    // La red difusa: mismo monto. `findDuplicate` afina después con la fecha y
    // el pagador; acá solo se acota lo que hay que traer.
    const { data: porMonto } = await admin.from("order_payments").select(cols).eq("amount", amount).limit(50);
    añadir(porMonto);
  }
  return [...vistos.values()];
}

/**
 * Deja el cobro en la cola de validación. Idempotente por pedido: si ese pedido
 * ya tiene un cobro de courier vivo, no se registra otro — el barrido relee la
 * misma guía en cada pasada mientras siga sin cerrarse.
 *
 * UN DUPLICADO NO ENTRA A LA COLA. La cola es de cobros por confirmar; un
 * comprobante que ya está asociado a otro pedido no es un cobro por confirmar,
 * es una incidencia. Se devuelve como tal para que el barrido la bloquee y
 * avise, que es lo que ya hace.
 */
export async function registerCourierCollection(
  admin: SupabaseClient,
  input: CollectionInput,
): Promise<CollectionOutcome> {
  if (!input.orderId) return { registered: false, reason: "sin_pedido" };

  const { data: yaExiste } = await admin
    .from("order_payments")
    .select("id")
    .eq("order_id", input.orderId)
    .eq("kind", COURIER_COLLECTION_KIND)
    .neq("validation_status", "rechazado")
    .limit(1);
  if ((yaExiste as { id: string }[] | null)?.length) {
    return { registered: false, reason: "ya_registrado" };
  }

  const bytes = Buffer.from(input.imageBytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const operation = normalizeOperationNumber(input.reading.operationNumber);
  const amount = input.reading.amount;

  const choques = await posiblesChoques(admin, operation, sha256, amount);
  const dup = findDuplicate(
    {
      order_id: input.orderId,
      kind: COURIER_COLLECTION_KIND,
      amount,
      operation_number: operation,
      paid_at: null,
      payer_name: null,
      payer_phone: null,
      file_sha256: sha256,
    },
    choques,
  );
  if (dup.duplicate) return { registered: false, reason: "duplicado" };

  // La imagen se guarda en NUESTRO bucket, no se enlaza la de Tanders: la
  // evidencia de un cobro no puede depender de que un tercero conserve el
  // archivo, ni de un token de descarga que caduque.
  const ext = input.mediaType.includes("png") ? "png" : "jpg";
  const path = `${input.storeId}/${input.orderId}/tanders-${input.guideCode}-${Date.now()}.${ext}`;
  const { error: upErr } = await admin.storage
    .from(VOUCHER_BUCKET)
    .upload(path, bytes, { contentType: input.mediaType, upsert: false });
  if (upErr) return { registered: false, reason: "error", detail: upErr.message };

  const status = collectionReviewStatus(input.verdict);
  const { error } = await admin.from("order_payments").insert({
    store_id: input.storeId,
    order_id: input.orderId,
    kind: COURIER_COLLECTION_KIND,
    amount,
    operation_number: operation,
    file_path: path,
    file_type: input.mediaType,
    file_sha256: sha256,
    validation_status: status,
    // `registered_by` va en null a propósito: no lo registró una persona.
    notes: `Cobro de ${input.guideCode} (Tanders). ${input.verdict.summary}`,
    vision: {
      source: "tanders_evidences",
      guide_code: input.guideCode,
      tanders_image_url: input.imageUrl,
      model: input.reading.model,
      is_payment_proof: input.reading.isPaymentProof,
      method: input.reading.method,
      recipient_name: input.reading.recipientName,
      amount: input.reading.amount,
      operation_number: input.reading.operationNumber,
      expected_amount: input.expectedAmount,
      verdict: input.verdict.state,
      reasons: input.verdict.reasons,
    },
  });
  if (error) {
    // Los índices únicos de 0049 son la última línea de defensa: si el choque se
    // coló entre la comprobación y el insert, aquí se para.
    if ((error as { code?: string }).code === "23505") return { registered: false, reason: "duplicado" };
    return { registered: false, reason: "error", detail: error.message };
  }
  return { registered: true, status };
}

// ---------------------------------------------------------------------------
// La firma humana manda sobre la guía
// ---------------------------------------------------------------------------
//
// EL FALLO QUE ESTO CIERRA (medido el 24-09-2026). De 124 cobros que una
// persona validó en «Validar pagos», 49 se quedaron con la guía en `en_ruta` y
// el pedido «En curso · En tránsito», pese a que Tanders los daba por
// entregados y alguien había firmado que el dinero llegó. La causa: la guía
// solo pasaba a `entregado` con el veredicto del MODELO (`validado`), y esos 49
// eran justo los que el modelo había rechazado o no había podido leer —los que
// más necesitaban la mirada humana—. La persona los aprobaba, se emitía el
// cierre de liquidación… y el pedido no podía cerrar porque, para el Master,
// nunca se había entregado. La firma valía para el dinero pero no para la
// entrega: dos autoridades contradiciéndose sobre el mismo pedido.
//
// La regla ahora es una: la decisión de la persona es la que vale, para las
// dos cosas.

/** La decisión humana sobre un cobro de courier ya registrado. */
export type HumanRuling = "validado" | "retirado";

/**
 * Qué hay que escribirle a la guía Tanders cuando una persona decide su cobro.
 * Pura: el barrido, las acciones y el relleno 0191 comparten esta regla.
 *
 * - `validado`: el dinero llegó. La guía pasa a `entregado` —si Tanders la da
 *   por entregada; nunca se afirma una entrega que el courier no acredita—. El
 *   estado del cobro queda en `revisado` cuando la persona CORRIGIÓ al modelo,
 *   y se deja en `validado` cuando los dos estaban de acuerdo: la diferencia es
 *   la que interesa al auditar («¿cuántas veces tuvo que enmendarle la plana
 *   una persona al lector?»).
 * - `retirado`: se rechazó u observó un cobro que ya estaba validado. El cobro
 *   deja de estar probado, así que `entregado` —que en este sistema significa
 *   «entregado Y cobrado» (§9.4)— deja de ser cierto: vuelve a `en_ruta`, que
 *   es lo que el courier sí acredita.
 */
export function guidePatchForHumanRuling(
  guide: { delivery_status: string; reported_status: string | null; payment_check_state: string | null },
  ruling: HumanRuling,
): Record<string, unknown> {
  if (ruling === "validado") {
    const patch: Record<string, unknown> = {
      payment_check_state: guide.payment_check_state === "validado" ? "validado" : "revisado",
    };
    const tandersDiceEntregado =
      (guide.reported_status ?? "").trim().toUpperCase() === "DELIVERED";
    if (tandersDiceEntregado && guide.delivery_status !== "entregado") {
      patch.delivery_status = "entregado";
      patch.status_category = categoryOf("entregado");
    }
    return patch;
  }
  const patch: Record<string, unknown> = { payment_check_state: "rechazado" };
  if (guide.delivery_status === "entregado") {
    patch.delivery_status = "en_ruta";
    patch.status_category = categoryOf("en_ruta");
  }
  return patch;
}

/** El nº de guía que el barrido dejó en la ficha al encolarla. */
function guideCodeFromVision(vision: unknown): string | null {
  const v = (vision ?? {}) as { guide_code?: unknown };
  return typeof v.guide_code === "string" && v.guide_code.trim() ? v.guide_code.trim() : null;
}

/**
 * Aplica la decisión humana a la guía Tanders del pedido. Se busca por el nº
 * de guía que quedó en la ficha: si el pedido salió dos veces con Tanders,
 * solo cambia la guía cuyo comprobante se revisó.
 */
export async function applyHumanRulingToGuide(
  admin: SupabaseClient,
  payment: { order_id: string; vision?: unknown },
  ruling: HumanRuling,
): Promise<void> {
  let query = admin
    .from("shipments")
    .select("id,delivery_status,reported_status,payment_check_state")
    .eq("order_id", payment.order_id)
    .eq("courier", "tanders");
  const guideCode = guideCodeFromVision(payment.vision);
  if (guideCode) query = query.eq("guide_code", guideCode);
  const { data } = await query;
  for (const guide of (data ?? []) as {
    id: string;
    delivery_status: string;
    reported_status: string | null;
    payment_check_state: string | null;
  }[]) {
    await admin.from("shipments").update(guidePatchForHumanRuling(guide, ruling)).eq("id", guide.id);
  }
}
