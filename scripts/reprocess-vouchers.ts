/**
 * Vuelve a leer los comprobantes que quedaron OBSERVADOS y rellena lo que falta.
 *
 * Uso local autorizado:
 *   pnpm exec tsx scripts/reprocess-vouchers.ts            # simulacro, no escribe
 *   pnpm exec tsx scripts/reprocess-vouchers.ts --escribir # aplica los cambios
 *
 * Lee primero `.env.production.local` y luego `.env.local`.
 *
 * POR QUÉ EXISTE
 * --------------
 * El prompt de extracción exigía literalmente el rótulo "Nro. de operación" —el
 * de Yape— y le ordenaba al modelo devolver null si no lo veía. Contra una
 * constancia de Interbank, que rotula "Código de operación", el modelo obedecía
 * y descartaba un número que tenía delante: en 19 de los 21 comprobantes
 * observados sin nº de operación, `indicators.operacion` era true. El veredicto
 * de visión tenía el mismo sesgo y mandaba esos pagos a `info_incompleta`.
 *
 * Las dos cosas están arregladas en lib/vision.ts, pero la visión corre UNA vez,
 * al subir el comprobante, y su resultado queda cacheado en la columna `vision`.
 * Los comprobantes que ya están cargados no se mueven solos: hay que releerlos.
 * Eso es lo que hace este script.
 *
 * QUÉ NO HACE
 * -----------
 * No pisa NADA que ya tenga valor. Solo rellena huecos, porque un dato que hay
 * en la fila puede haberlo escrito una persona mirando la imagen, y su lectura
 * manda sobre la del modelo.
 *
 * No toca el receptor ni decide sobre él. Si el comprobante dice que el dinero
 * fue a otra cuenta, eso no es un dato que falte: es un hallazgo, y lo resuelve
 * una persona. El script lo cuenta en el informe y sigue.
 */
import { existsSync, readFileSync } from "node:fs";

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!key || process.env[key]) continue;
    let value = (rawValue ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(".env.production.local");
loadEnvFile(".env.local");

const WRITE = process.argv.includes("--escribir");

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

async function main() {
  const [
    { createAdminSupabase },
    { inspectVoucher },
    { PAYMENT_OBSERVED_STATUSES },
    { findOperationClash, normalizeOperationNumber },
    { verifyYapeRecipient },
    { recomputeOrderMasterSafe },
  ] = await Promise.all([
    import("@/lib/db"),
    import("@/lib/voucher-inspect"),
    import("@/lib/payment-review"),
    import("@/lib/yape-dedup"),
    import("@/lib/yape-recipient"),
    import("@/lib/order-master"),
  ]);

  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from("order_payments")
    .select(
      "id,store_id,order_id,kind,amount,operation_number,paid_at,payer_name,file_path,validation_status,vision",
    )
    .in("validation_status", [...PAYMENT_OBSERVED_STATUSES])
    .not("file_path", "is", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`No se pudieron listar los comprobantes: ${error.message}`);

  const rows = (data ?? []) as PaymentRow[];
  console.log(`${rows.length} comprobantes observados con imagen.${WRITE ? "" : "  (SIMULACRO)"}\n`);

  const byLabel = new Map<string, number>();
  const touchedOrders = new Set<string>();
  let reread = 0;
  let visionFailed = 0;
  let filledOperation = 0;
  let filledOther = 0;
  let unblocked = 0;
  let clashes = 0;
  let recipientMismatch = 0;
  let stillNoOperation = 0;

  for (const row of rows) {
    const inspection = await inspectVoucher(admin, row.file_path, row.store_id);
    if (!inspection.ok) {
      visionFailed += 1;
      console.log(`  ${row.id}  visión no pudo leer la imagen — se deja como está`);
      continue;
    }
    reread += 1;

    const extracted = (inspection.payload as { extracted?: Record<string, unknown> }).extracted ?? {};
    const label = typeof extracted.operation_label === "string" ? extracted.operation_label : null;
    if (label) byLabel.set(label, (byLabel.get(label) ?? 0) + 1);

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
      filledOther += 1;
    }
    if (!row.paid_at && inspection.fields.paidAt) {
      patch.paid_at = inspection.fields.paidAt;
      filledOther += 1;
    }
    if (!row.payer_name && inspection.fields.payerName) {
      patch.payer_name = inspection.fields.payerName;
      filledOther += 1;
    }

    // El nº de operación es llave global: se comprueba antes de escribirlo, con
    // la MISMA definición de choque que usa el operador al completarlo a mano.
    const readOperation = normalizeOperationNumber(inspection.fields.operationNumber);
    let gainedOperation = false;
    if (!row.operation_number && readOperation) {
      const clash = await findOperationClash(admin, readOperation, row.id);
      if (clash) {
        clashes += 1;
        console.log(
          `  ${row.id}  nº ${readOperation} ya lo usa el pago ${clash.id} (${clash.kind}) — NO se escribe`,
        );
      } else {
        patch.operation_number = readOperation;
        gainedOperation = true;
        filledOperation += 1;
      }
    }

    const operation = row.operation_number ?? (gainedOperation ? readOperation : null);
    if (!operation) stillNoOperation += 1;

    const recipient = verifyYapeRecipient(
      inspection.fields.recipientName,
      inspection.fields.recipientPhoneLastDigits,
    );
    if (recipient.status === "mismatch") recipientMismatch += 1;

    // Misma regla que completePaymentData: tener el nº de operación es lo que
    // saca al pago de "información incompleta" y lo devuelve a la cola normal.
    // No se toca `revision_admin`: ahí hay una persona mirando, y moverlo por
    // nuestra cuenta le vaciaría la cola sin que nadie lo haya revisado.
    if (operation && row.validation_status === "info_incompleta" && recipient.status !== "mismatch") {
      patch.validation_status = "pendiente_revision";
      unblocked += 1;
    }

    if (!WRITE) continue;

    const { error: upErr } = await admin.from("order_payments").update(patch).eq("id", row.id);
    if (upErr) {
      // 23505: el índice único global rechazó el número. Es la última defensa
      // por debajo de findOperationClash y tiene que verse, no tragarse.
      console.error(`  ${row.id}  no se pudo actualizar: ${upErr.message}`);
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
          `Comprobante releído tras ampliar la lectura a otros bancos` +
          `${patch.operation_number ? ` (op. ${patch.operation_number}${label ? `, "${label}"` : ""})` : ""}` +
          `${patch.validation_status ? ` — pasa a ${patch.validation_status}` : ""}.`,
      });
    }
  }

  if (WRITE && touchedOrders.size) {
    await recomputeOrderMasterSafe(admin, [...touchedOrders]);
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Releídos:                        ${reread}/${rows.length}`);
  console.log(`Visión falló (sin cambios):      ${visionFailed}`);
  console.log(`Nº de operación recuperado:      ${filledOperation}`);
  console.log(`Otros huecos rellenados:         ${filledOther}`);
  console.log(`Pasan a pendiente_revision:      ${unblocked}`);
  console.log(`Nº ya usado por otro pago:       ${clashes}`);
  console.log(`Siguen sin nº de operación:      ${stillNoOperation}`);
  console.log(`Receptor que NO es Grupo GF:     ${recipientMismatch}   ← esto lo mira una persona`);

  console.log(`\nDistribución por rótulo (de qué banco vino cada comprobante):`);
  if (!byLabel.size) console.log("  (ninguno legible)");
  for (const [label, n] of [...byLabel].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${label}`);
  }

  if (!WRITE) {
    console.log(`\nSimulacro: no se escribió nada. Repite con --escribir para aplicarlo.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
