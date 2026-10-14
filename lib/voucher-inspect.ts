// Leer una imagen de comprobante del bucket privado y decir qué dice.
//
// Vive en `lib/` y no junto a las server actions a propósito: aquí no hay nada
// de Next —ni `next/headers` ni `revalidatePath`—, así que lo puede usar tanto
// la acción del dashboard como un script suelto (scripts/reprocess-vouchers.ts).
// Cuando estaba dentro de payment-actions.ts, releer los comprobantes ya
// cargados obligaba a importar un módulo "use server" desde Node, o a copiar la
// lectura. Copiarla habría dejado dos definiciones de "qué dice un comprobante"
// divergiendo, que es el fallo que este repo repite.

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadStoreCollectionAccounts } from "@/lib/collection-accounts";
import { decryptOrNull } from "@/lib/crypto";
import {
  analyzeYapeVoucherFromEnv,
  extractYapeVoucherFromEnv,
  type YapeVisionResult,
  type YapeVoucherFields,
} from "@/lib/vision";
import {
  yapeRecipientReading,
  type CollectionAccount,
  type YapeRecipientCheck,
} from "@/lib/yape-recipient";
import { verifyFlowReceipt, type FlowReceiptCheck } from "@/lib/flow/verify";

/** El receptor de un pago que Flow confirmó: la cuenta Flow de la tienda. */
export const FLOW_RECIPIENT_NAME = "Cuenta Flow de la tienda";

/** Los comprobantes llevan datos bancarios del cliente: bucket privado. */
export const VOUCHER_BUCKET = "yape-vouchers";
/** Una captura de móvil no pesa más que esto; corta las subidas absurdas. */
export const MAX_VOUCHER_BYTES = 6 * 1024 * 1024;

export interface VoucherInspection {
  /**
   * Hubo veredicto. FALSE ante cualquier fallo (sin clave, timeout, imagen
   * ilegible) — quien llama NO debe tomarlo por un "no es comprobante", que
   * sería cachear una caída como negativa y tirar un pago bueno.
   */
  ok: boolean;
  isVoucher: boolean;
  /** Datos leídos de la imagen, para rellenar lo que el operador dejó en blanco. */
  fields: {
    operationNumber: string | null;
    operationLabel: string | null;
    amount: number | null;
    paidAt: string | null;
    payerName: string | null;
    recipientName: string | null;
    recipientPhoneLastDigits: string | null;
    recipientCheck: YapeRecipientCheck;
    /** La lectura vino invertida y se corrigió antes de juzgarla. */
    recipientSwapped: boolean;
    /**
     * El nombre leído como receptor era el de la clienta —la nota del Yape— y
     * no contó para juzgar la cuenta. `recipientName` queda en null.
     */
    recipientIgnoredName: string | null;
    /** Captura de quien recibió («Te yapearon»). */
    recipientReceivedView: boolean;
    /** Esa captura trae el aviso de Yape Empresa: es de nuestra cuenta. */
    recipientYapeEmpresa: boolean;
    /** Con qué cuenta de cobro encajó, si encajó con alguna. */
    recipientAccount: CollectionAccount | null;
    /**
     * Constancia de Flow: lo que dijo Flow de su «Nº de orden». Null en
     * cualquier otro comprobante. Ver lib/flow/verify.ts.
     */
    flow: FlowReceiptCheck | null;
  };
  payload: Record<string, unknown>;
}

export const EMPTY_INSPECTION: VoucherInspection = {
  ok: false,
  isVoucher: false,
  fields: {
    operationNumber: null,
    operationLabel: null,
    amount: null,
    paidAt: null,
    payerName: null,
    recipientName: null,
    recipientPhoneLastDigits: null,
    recipientCheck: "missing",
    recipientSwapped: false,
    recipientIgnoredName: null,
    recipientReceivedView: false,
    recipientYapeEmpresa: false,
    recipientAccount: null,
    flow: null,
  },
  payload: {},
};

/**
 * Junta las dos respuestas de visión en UNA lectura, con la corrección de la
 * inversión aplicada y el jsonb de auditoría ya armado.
 *
 * Es pura y está aquí, exportada, por una razón concreta: la forma de ese jsonb
 * es un CONTRATO. `yapeRecipientReadingFromVision` lo relee en el drawer bajo
 * `vision.extracted.*` para decir si el dinero llegó a una cuenta nuestra. Cada
 * sitio que guarde un comprobante y escriba su propio objeto plano apaga ese
 * control sin que salte nada: el nombre del receptor está guardado, pero nadie
 * lo encuentra, y la pantalla dice «no pudo leerse» sobre una lectura perfecta.
 * Pasó con la ingesta por WhatsApp (MOM §12), en todos sus comprobantes.
 */
export function voucherReading(
  verdict: YapeVisionResult,
  extracted: YapeVoucherFields,
  accounts: CollectionAccount[],
  customerName?: string | null,
  /** Lo que dijo Flow del «Nº de orden», si la imagen era una constancia de Flow. */
  flow: FlowReceiptCheck | null = null,
): VoucherInspection {
  // La MISMA regla que relee la auditoría en cada pantalla, con sus dos
  // correcciones: la lectura invertida —un cobro impecable acusado de desvío
  // por un nombre que ni siquiera es el del receptor— y el nombre de la clienta
  // tomado por receptor, que casi siempre es la nota que ella escribe en el Yape.
  const recipient = yapeRecipientReading(extracted, accounts, customerName);
  const swapped = recipient.swapped;
  const recipientName = recipient.name;
  const recipientCheck = recipient.status;
  // FLOW MANDA SOBRE LA FOTO. Si Flow confirmó la orden como pagada en NUESTRA
  // cuenta, el dinero entró: el receptor somos nosotros, el monto es el que
  // dice Flow y es un comprobante aunque no se parezca a un Yape. La fecha se
  // toma de la imagen si se leyó (es la hora local que ve la clienta) y si no,
  // la de Flow.
  const paid = flow?.state === "pagado" ? flow : null;
  return {
    ok: verdict.ok,
    isVoucher: paid ? true : verdict.isVoucher,
    fields: {
      operationNumber: paid ? paid.flowOrder : extracted.operationNumber,
      operationLabel: paid ? "Nº de orden (Flow)" : extracted.operationLabel,
      amount: paid ? paid.amount ?? extracted.amount : extracted.amount,
      paidAt: paid ? extracted.paidAt ?? paid.paidAt : extracted.paidAt,
      payerName: swapped ? extracted.recipientName : extracted.payerName,
      recipientName: paid ? FLOW_RECIPIENT_NAME : recipientName,
      recipientPhoneLastDigits: paid ? null : extracted.recipientPhoneLastDigits,
      recipientCheck: paid ? "verified" : recipientCheck,
      recipientAccount: paid ? null : recipient.account,
      recipientSwapped: paid ? false : swapped,
      recipientIgnoredName: paid ? null : recipient.ignoredName,
      recipientReceivedView: paid ? false : recipient.receivedView,
      recipientYapeEmpresa: paid ? false : recipient.yapeEmpresa,
      flow,
    },
    payload: {
      indicators: verdict.indicators,
      model: verdict.model,
      ok: verdict.ok,
      // Lo que dijo Flow, tal cual: es la auditoría de por qué un comprobante
      // que no parece un Yape entró validado. `yapeRecipientReadingFromVision`
      // lo relee para no decir «receptor no pudo leerse» sobre un pago que la
      // pasarela confirmó.
      ...(flow ? { flow } : {}),
      extracted: {
        operation_number: extracted.operationNumber,
        // El rótulo bajo el que se leyó el número: es lo único que dice de qué
        // banco vino el comprobante. Sin esto, "distribución por banco" no se
        // puede responder con los datos que guardamos.
        operation_label: extracted.operationLabel,
        amount: extracted.amount,
        paid_at: extracted.paidAt,
        // Se guarda lo que el lector DIJO, sin corregir: el jsonb es la
        // auditoría de la lectura, y `yapeRecipientReadingFromVision` vuelve a
        // aplicar la corrección cada vez que alguien mira el comprobante.
        payer_name: extracted.payerName,
        recipient_name: extracted.recipientName,
        recipient_swapped: swapped,
        recipient_phone_last_digits: extracted.recipientPhoneLastDigits,
        // «Te yapearon»: captura de nuestra propia cuenta. La relectura de cada
        // pantalla lo necesita para no contrastar al pagador con nuestras cuentas.
        received_view: extracted.receivedView === true,
        yape_empresa_marker: extracted.yapeEmpresaMarker === true,
        recipient_check: recipientCheck,
        // A qué cuenta de cobro llegó, cuando se pudo determinar. Con varias
        // cuentas, "verificado" a secas ya no dice dónde está el dinero.
        recipient_account: recipient.account?.name ?? null,
        flow_order: extracted.flowOrder ?? null,
        ok: extracted.ok,
      },
    },
  };
}

/**
 * Lee una imagen del bucket y le hace las dos preguntas de visión: "¿es un
 * comprobante?" y "¿qué dice?". Nunca lanza.
 */
export async function inspectVoucher(
  admin: SupabaseClient,
  path: string | null,
  storeId: string,
  /** La clienta del pedido: su nombre en la nota del Yape no es el receptor. */
  customerName?: string | null,
): Promise<VoucherInspection> {
  if (!path) return EMPTY_INSPECTION;
  // Clave de visión de ESTA tienda (0052): el gasto cae en su propia cuenta de
  // Anthropic. Si no tiene clave propia se usa la del entorno.
  const { data: store } = await admin
    .from("stores")
    .select("anthropic_api_key_enc,anthropic_model")
    .eq("id", storeId)
    .maybeSingle();
  const storeCreds = {
    anthropicApiKey: decryptOrNull(
      (store as { anthropic_api_key_enc?: string | null } | null)?.anthropic_api_key_enc ?? null,
    ),
    anthropicModel: (store as { anthropic_model?: string | null } | null)?.anthropic_model ?? null,
  };
  try {
    const { data, error } = await admin.storage.from(VOUCHER_BUCKET).download(path);
    if (error || !data) return EMPTY_INSPECTION;
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes.byteLength > MAX_VOUCHER_BYTES) {
      return { ...EMPTY_INSPECTION, payload: { error: "imagen demasiado grande" } };
    }
    const base64 = Buffer.from(bytes).toString("base64");
    // Dos preguntas distintas a la misma imagen: "¿es un comprobante?" y "¿qué
    // dice?". La segunda es la que evita teclear el nº de operación a mano —y es
    // el nº de operación lo que hace posible detectar el mismo Yape recortado.
    const [verdict, extracted] = await Promise.all([
      analyzeYapeVoucherFromEnv(base64, data.type, storeCreds),
      extractYapeVoucherFromEnv(base64, data.type, storeCreds),
    ]);
    // Las cuentas de cobro de ESTA tienda. Si no hay ninguna configurada, la
    // verificación cae en «no se puede contrastar», jamás en «se desvió».
    const accounts = await loadStoreCollectionAccounts(admin, storeId);
    // Constancia de Flow: se le pregunta a Flow por su «Nº de orden».
    const flow = extracted.flowOrder ? await verifyFlowReceipt(admin, storeId, extracted.flowOrder) : null;
    return voucherReading(verdict, extracted, accounts, customerName, flow);
  } catch {
    return EMPTY_INSPECTION;
  }
}
