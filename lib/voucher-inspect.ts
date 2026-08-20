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
import { decryptOrNull } from "@/lib/crypto";
import {
  analyzeYapeVoucherFromEnv,
  checkYapeRecipient,
  extractYapeVoucherFromEnv,
  type YapeRecipientCheck,
} from "@/lib/vision";

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
  },
  payload: {},
};

/**
 * Lee una imagen del bucket y le hace las dos preguntas de visión: "¿es un
 * comprobante?" y "¿qué dice?". Nunca lanza.
 */
export async function inspectVoucher(
  admin: SupabaseClient,
  path: string | null,
  storeId: string,
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
    const recipientCheck = checkYapeRecipient(
      extracted.recipientName,
      extracted.recipientPhoneLastDigits,
    );
    return {
      ok: verdict.ok,
      isVoucher: verdict.isVoucher,
      fields: {
        operationNumber: extracted.operationNumber,
        operationLabel: extracted.operationLabel,
        amount: extracted.amount,
        paidAt: extracted.paidAt,
        payerName: extracted.payerName,
        recipientName: extracted.recipientName,
        recipientPhoneLastDigits: extracted.recipientPhoneLastDigits,
        recipientCheck,
      },
      payload: {
        indicators: verdict.indicators,
        model: verdict.model,
        ok: verdict.ok,
        extracted: {
          operation_number: extracted.operationNumber,
          // El rótulo bajo el que se leyó el número: es lo único que dice de qué
          // banco vino el comprobante. Sin esto, "distribución por banco" no se
          // puede responder con los datos que guardamos.
          operation_label: extracted.operationLabel,
          amount: extracted.amount,
          paid_at: extracted.paidAt,
          payer_name: extracted.payerName,
          recipient_name: extracted.recipientName,
          recipient_phone_last_digits: extracted.recipientPhoneLastDigits,
          recipient_check: recipientCheck,
          ok: extracted.ok,
        },
      },
    };
  } catch {
    return EMPTY_INSPECTION;
  }
}
