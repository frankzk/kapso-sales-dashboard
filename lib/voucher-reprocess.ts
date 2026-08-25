// Releer los comprobantes ya cargados y rellenar lo que falta.
//
// POR QUÉ EXISTE
// --------------
// La visión corre UNA sola vez, al subir el comprobante, y su lectura queda
// cacheada en la columna `vision`. Arreglar el lector no mueve lo ya cargado
// —el mismo patrón de «¿llegó a correr?» que este repositorio lleva pagando en
// varios incidentes—, así que hace falta un pase que vuelva a mirar las
// imágenes con las reglas de hoy.
//
// El arreglo concreto que lo motiva: el prompt de extracción exigía el rótulo
// de Yape («Nro. de operación») y le ordenaba al modelo devolver null si no lo
// veía. Contra una constancia de Interbank, que rotula «Código de operación»,
// el modelo obedecía y descartaba un número que tenía delante: en 19 de los 21
// comprobantes observados sin nº, `indicators.operacion` era true.
//
// QUÉ NO HACE
// -----------
// No pisa NADA que ya tenga valor. Solo rellena huecos, porque un dato que hay
// en la fila puede haberlo escrito una persona mirando la imagen, y su lectura
// manda sobre la del modelo.
//
// No decide sobre el receptor ni toca `revision_admin`. Si el comprobante dice
// que el dinero fue a una cuenta que no es de la tienda, eso no es un dato que
// falte: es un hallazgo, y lo resuelve una persona. Vaciarle la cola a quien
// está revisando sería peor que el atasco.
//
// VIVE EN `lib/` PARA QUE HAYA UNA SOLA DEFINICIÓN. Lo usan el script suelto
// (scripts/reprocess-vouchers.ts) y la ruta de cron, que son dos formas de
// disparar exactamente el mismo trabajo. Copiarlo habría dejado dos versiones
// de «qué se rellena y qué no» divergiendo, que es el fallo que este repo
// repite.

import type { SupabaseClient } from "@supabase/supabase-js";
import { PAYMENT_OBSERVED_STATUSES } from "@/lib/payment-review";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { inspectVoucher } from "@/lib/voucher-inspect";
import { findOperationClash, normalizeOperationNumber } from "@/lib/yape-dedup";

interface PaymentRow {
  id: string;
  store_id: string;
  order_id: string;
  kind: string;
  amount: number | null;
  operation_number: string | null;
  paid_at: string | null;
  payer_name: string | null;
  file_path: string | null;
  validation_status: string;
  vision: unknown;
}

export interface ReprocessNote {
  paymentId: string;
  kind: "vision_falló" | "nº_ya_usado" | "no_se_pudo_escribir";
  detail: string;
}

export interface ReprocessReport {
  /** Comprobantes observados con imagen que entraron al pase. */
  candidates: number;
  /** De esos, cuántos se llegaron a releer. */
  reread: number;
  /** La visión no pudo con la imagen. Se dejan intactos, NO se cachea el fallo. */
  visionFailed: number;
  /** Nº de operación recuperado de la imagen. */
  filledOperation: number;
  /** Monto, fecha o pagador rellenados donde faltaban. */
  filledOther: number;
  /** Pasan de `info_incompleta` a `pendiente_revision`. */
  unblocked: number;
  /** El nº leído ya lo usaba otro pago vivo: NO se escribe. */
  clashes: number;
  /** Siguen sin nº de operación tras releer. */
  stillNoOperation: number;
  /** El receptor no encaja con ninguna cuenta de cobro. Lo mira una persona. */
  recipientMismatch: number;
  /** Los que no cupieron en el reloj. Vuelven en la siguiente pasada. */
  deferred: number;
  /** De qué banco vino cada comprobante, por el rótulo del nº de operación. */
  byLabel: Record<string, number>;
  /** A qué cuenta de cobro llegó, cuando se pudo determinar. */
  byAccount: Record<string, number>;
  /** Lo que merece que alguien lo lea, comprobante por comprobante. */
  notes: ReprocessNote[];
  /** false = simulacro: se calculó todo y no se escribió nada. */
  wrote: boolean;
}

export interface ReprocessOpts {
  /** Sin esto NO escribe: el simulacro es el modo por defecto, a propósito. */
  write?: boolean;
  /** Instante límite. El corte va ENTRE comprobantes, nunca a mitad de uno. */
  deadline?: number;
  /** Tope de comprobantes en esta pasada. */
  limit?: number;
  now?: () => number;
}

export async function reprocessObservedVouchers(
  admin: SupabaseClient,
  opts: ReprocessOpts = {},
): Promise<ReprocessReport> {
  const write = opts.write === true;
  const clock = opts.now ?? Date.now;
  const report: ReprocessReport = {
    candidates: 0,
    reread: 0,
    visionFailed: 0,
    filledOperation: 0,
    filledOther: 0,
    unblocked: 0,
    clashes: 0,
    stillNoOperation: 0,
    recipientMismatch: 0,
    deferred: 0,
    byLabel: {},
    byAccount: {},
    notes: [],
    wrote: write,
  };

  let query = admin
    .from("order_payments")
    .select(
      "id,store_id,order_id,kind,amount,operation_number,paid_at,payer_name,file_path,validation_status,vision",
    )
    .in("validation_status", [...PAYMENT_OBSERVED_STATUSES])
    .not("file_path", "is", null)
    .order("created_at", { ascending: true });
  if (opts.limit) query = query.limit(opts.limit);

  const { data, error } = await query;
  if (error) throw new Error(`No se pudieron listar los comprobantes: ${error.message}`);

  const rows = (data ?? []) as PaymentRow[];
  report.candidates = rows.length;
  const touchedOrders = new Set<string>();

  for (const [i, row] of rows.entries()) {
    // El corte va ENTRE comprobantes: partir uno por la mitad dejaría la fila
    // escrita a medias con la auditoría de visión de otra pasada.
    if (opts.deadline !== undefined && clock() > opts.deadline) {
      report.deferred = rows.length - i;
      break;
    }

    const inspection = await inspectVoucher(admin, row.file_path, row.store_id);
    if (!inspection.ok) {
      // `ok:false` es un FALLO, no un veredicto. No se escribe nada: cachear una
      // caída de la API como «no dice nada» perdería el comprobante para siempre.
      report.visionFailed += 1;
      report.notes.push({
        paymentId: row.id,
        kind: "vision_falló",
        detail: "la visión no pudo leer la imagen — se deja intacto",
      });
      continue;
    }
    report.reread += 1;

    const label = inspection.fields.operationLabel;
    if (label) report.byLabel[label] = (report.byLabel[label] ?? 0) + 1;
    const account = inspection.fields.recipientAccount?.name;
    if (account) report.byAccount[account] = (report.byAccount[account] ?? 0) + 1;

    const patch: Record<string, unknown> = {
      // La auditoría de visión SÍ se reemplaza entera: es la lectura del modelo,
      // no un dato del operador, y guardar la vieja junto a la nueva dejaría dos
      // versiones de lo que dice la misma imagen.
      vision: {
        ...(typeof row.vision === "object" && row.vision ? (row.vision as object) : {}),
        ...inspection.payload,
        reprocesado: true,
      },
    };

    // Solo huecos. Un valor ya escrito manda sobre la lectura del modelo.
    if (row.amount === null && inspection.fields.amount !== null) {
      patch.amount = inspection.fields.amount;
      report.filledOther += 1;
    }
    if (!row.paid_at && inspection.fields.paidAt) {
      patch.paid_at = inspection.fields.paidAt;
      report.filledOther += 1;
    }
    if (!row.payer_name && inspection.fields.payerName) {
      patch.payer_name = inspection.fields.payerName;
      report.filledOther += 1;
    }

    // El nº de operación es llave global: se comprueba antes de escribirlo, con
    // la MISMA definición de choque que usa el operador al completarlo a mano.
    const readOperation = normalizeOperationNumber(inspection.fields.operationNumber, {
      labelled: Boolean(inspection.fields.operationLabel),
    });
    let gainedOperation = false;
    if (!row.operation_number && readOperation) {
      const clash = await findOperationClash(admin, readOperation, row.id);
      if (clash) {
        report.clashes += 1;
        report.notes.push({
          paymentId: row.id,
          kind: "nº_ya_usado",
          detail: `el nº ${readOperation} ya lo usa el pago ${clash.id} (${clash.kind}) — no se escribe`,
        });
      } else {
        patch.operation_number = readOperation;
        gainedOperation = true;
        report.filledOperation += 1;
      }
    }

    const operation = row.operation_number ?? (gainedOperation ? readOperation : null);
    if (!operation) report.stillNoOperation += 1;

    // El receptor ya lo juzgó `inspectVoucher` contra las cuentas de cobro de
    // ESTA tienda. Volver a calcularlo acá sería una segunda definición de la
    // misma regla esperando el día en que discrepen.
    const recipientCheck = inspection.fields.recipientCheck;
    if (recipientCheck === "mismatch") report.recipientMismatch += 1;

    // Misma regla que completePaymentData: tener el nº de operación es lo que
    // saca al pago de «información incompleta» y lo devuelve a la cola normal.
    // No se toca `revision_admin`: ahí hay una persona mirando.
    if (operation && row.validation_status === "info_incompleta" && recipientCheck !== "mismatch") {
      patch.validation_status = "pendiente_revision";
      report.unblocked += 1;
    }

    if (!write) continue;

    const { error: upErr } = await admin.from("order_payments").update(patch).eq("id", row.id);
    if (upErr) {
      // 23505: el índice único global rechazó el número. Es la última defensa
      // por debajo de findOperationClash y tiene que verse, no tragarse.
      report.notes.push({
        paymentId: row.id,
        kind: "no_se_pudo_escribir",
        detail: upErr.message,
      });
      continue;
    }
    touchedOrders.add(row.order_id);
    if (patch.operation_number || patch.validation_status) {
      await admin.from("order_events").insert({
        store_id: row.store_id,
        order_id: row.order_id,
        kind: "payment",
        source: "sistema",
        note:
          "Comprobante releído tras ampliar la lectura a otros bancos" +
          `${patch.operation_number ? ` (op. ${patch.operation_number}${label ? `, "${label}"` : ""})` : ""}` +
          `${patch.validation_status ? ` — pasa a ${patch.validation_status}` : ""}.`,
      });
    }
  }

  if (write && touchedOrders.size) {
    await recomputeOrderMasterSafe(admin, [...touchedOrders]);
  }

  return report;
}
