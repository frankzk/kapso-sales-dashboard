// Ponerle hora a los cobros de courier que entraron a la cola sin ella.
//
// POR QUÉ. Hasta el 04-10-2026 el lector de Tanders transcribía monto,
// operación y destinatario, pero no la fecha ni la hora del pago. Sin hora, un
// cobro no se puede cruzar al minuto con el estado de cuenta de Yape
// (lib/yape-statement), que es lo único que permite darlo por cobrado sin una
// persona delante. Este pase relee la constancia —la que guardamos en nuestro
// bucket al encolarla— y rellena `paid_at`.
//
// SOLO RELLENA. No toca un `paid_at` que ya tenga valor —puede haberlo escrito
// una persona— ni el estado del cobro. Y si el monto que se relee no es el que
// ya tenía la ficha, no escribe nada: o la imagen no es la misma o la lectura
// es mala, y en los dos casos la hora no es de fiar.
//
// SERVER-ONLY: lee el bucket privado de comprobantes.

import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/crypto";
import { COURIER_COLLECTION_KIND } from "@/lib/tanders/collection-payment";
import { readTandersPayment } from "@/lib/tanders/payment-vision";
import { normalizeMediaType, type StoreVisionCreds } from "@/lib/vision";
import { VOUCHER_BUCKET } from "@/lib/voucher-inspect";

export interface CourierTimeBackfillReport {
  candidates: number;
  filled: number;
  /** La constancia no dice la hora, o el lector no pudo con ella. */
  unreadable: number;
  /** El monto releído no es el de la ficha: no se escribe. */
  amountMismatch: number;
  /** No cupieron en el tiempo: vuelven en la siguiente pasada. */
  deferred: number;
}

interface Row {
  id: string;
  store_id: string;
  amount: number | string | null;
  file_path: string | null;
  file_type: string | null;
  vision: unknown;
}

const CONCURRENCY = 6;

export async function backfillCourierPaidAt(
  admin: SupabaseClient,
  opts: { budgetMs: number; limit?: number; now?: () => number } = { budgetMs: 30_000 },
): Promise<CourierTimeBackfillReport> {
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.budgetMs;
  const report: CourierTimeBackfillReport = {
    candidates: 0,
    filled: 0,
    unreadable: 0,
    amountMismatch: 0,
    deferred: 0,
  };

  // Solo lo que espera firma: lo ya validado no necesita cruzarse, y lo
  // observado lo está mirando una persona.
  const { data } = await admin
    .from("order_payments")
    .select("id,store_id,amount,file_path,file_type,vision")
    .eq("kind", COURIER_COLLECTION_KIND)
    .eq("validation_status", "pendiente_revision")
    .is("paid_at", null)
    .not("file_path", "is", null)
    .order("registered_at", { ascending: true })
    .limit(opts.limit ?? 120);
  const rows = (data ?? []) as Row[];
  report.candidates = rows.length;
  if (!rows.length) return report;

  // La clave de la TIENDA manda sobre la del entorno (0052), igual que en el
  // barrido de Tanders.
  const storeIds = [...new Set(rows.map((r) => r.store_id))];
  const { data: stores } = await admin
    .from("stores")
    .select("id,anthropic_api_key_enc,anthropic_model")
    .in("id", storeIds);
  const creds = new Map<string, StoreVisionCreds>();
  for (const s of (stores ?? []) as {
    id: string;
    anthropic_api_key_enc: string | null;
    anthropic_model: string | null;
  }[]) {
    creds.set(s.id, {
      anthropicApiKey: s.anthropic_api_key_enc ? decrypt(s.anthropic_api_key_enc) : null,
      anthropicModel: s.anthropic_model,
    });
  }

  let next = 0;
  async function worker() {
    while (next < rows.length) {
      if (now() >= deadline) return;
      const row = rows[next++]!;
      const { data: file } = await admin.storage.from(VOUCHER_BUCKET).download(row.file_path!);
      if (!file) {
        report.unreadable += 1;
        continue;
      }
      const bytes = Buffer.from(await file.arrayBuffer());
      const reading = await readTandersPayment(
        bytes.toString("base64"),
        normalizeMediaType(row.file_type ?? file.type),
        creds.get(row.store_id) ?? {},
      );
      if (!reading.ok || !reading.paidAt) {
        report.unreadable += 1;
        continue;
      }
      const stored = row.amount == null ? null : Number(row.amount);
      if (stored == null || reading.amount == null || Math.abs(stored - reading.amount) > 0.001) {
        report.amountMismatch += 1;
        continue;
      }
      const vision = row.vision && typeof row.vision === "object" ? (row.vision as Record<string, unknown>) : {};
      const { error } = await admin
        .from("order_payments")
        .update({ paid_at: reading.paidAt, vision: { ...vision, paid_at: reading.paidAt } })
        .eq("id", row.id)
        .is("paid_at", null);
      if (!error) report.filled += 1;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  report.deferred = Math.max(0, rows.length - next);
  return report;
}
