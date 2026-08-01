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
import { extractPaymentEvidence, TandersClient } from "@/lib/tanders/client";
import { checkTandersPayment, REASON_LABEL } from "@/lib/tanders/payment-check";
import { readTandersPayment } from "@/lib/tanders/payment-vision";
import { normalizeMediaType, type StoreVisionCreds } from "@/lib/vision";

const DAY_MS = 86_400_000;
/** Días hacia atrás. Cubre "también las de esta semana" con margen. */
export const LOOKBACK_DAYS = 8;
/** Tope por pasada: cada guía cuesta una llamada al modelo. */
export const MAX_PER_RUN = 60;

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
  /** Tanders todavía no la da por entregada: no hay nada que validar. */
  enCurso: number;
  entregado: number;
  validado: number;
  rechazado: number;
  pendiente: number;
  errores: number;
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
  const { data, error } = await admin
    .from("shipments")
    .select(
      "id,store_id,guide_code,tanders_order_id,order_id,order_name,payment_check_state,tanders_raw",
    )
    .eq("courier", "tanders")
    .in("delivery_status", ["pendiente", "en_ruta"])
    .gte("created_at", since)
    .or("payment_check_state.is.null,payment_check_state.eq.pendiente")
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
    rejected: [],
    detalle: [],
  };

  // Una sesión por tienda: el cliente cachea su token entre guías.
  const clients = new Map<string, TandersClient | null>();
  const visionCreds = new Map<string, StoreVisionCreds>();

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
        continue;
      }

      // 1) ¿Tanders ya la dio por entregada? Si no, no hay nada que validar.
      const order = await client.getOrder(row.tanders_order_id);
      if (String(order?.status ?? "").toUpperCase() !== "DELIVERED") {
        report.enCurso += 1;
        continue;
      }

      // 2) La constancia de pago. Sin ella no se decide nada: queda pendiente,
      //    que bloquea igual pero no acusa a nadie. Ver extractPaymentEvidence.
      const raw = await client.evidences(row.tanders_order_id);
      const payments = extractPaymentEvidence(raw);
      if (!payments.length) {
        report.pendiente += 1;
        report.detalle.push({
          guia: row.guide_code,
          pedido: row.order_name,
          cobroEsperado: expectedAmount(row.tanders_raw),
          leido: null,
          veredicto: "pendiente",
          motivos: [],
          resumen: "Tanders la da por entregada pero no se encontró constancia de pago.",
          haria: "dejar la guía como está",
          imagen: null,
        });
        if (!dry) {
          await admin
            .from("shipments")
            .update({ payment_check_state: "pendiente" })
            .eq("id", row.id);
        }
        continue;
      }

      // La más reciente: si hubo un reintento de cobro, la que vale es la última.
      const evidence = payments[payments.length - 1]!;
      const img = await fetch(evidence.imageUrl);
      if (!img.ok) {
        report.errores += 1;
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
      const verdict = checkTandersPayment({
        voucher: {
          ok: reading.ok,
          isVoucher: reading.isPaymentProof,
          method: reading.method,
          recipientName: reading.recipientName,
          amount: reading.amount,
          operationNumber: reading.operationNumber,
        },
        expectedAmount: expected,
      });

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
          operacion: reading.operationNumber,
          modelo: reading.model,
        },
        veredicto: verdict.state,
        motivos: verdict.reasons,
        resumen: verdict.summary,
        haria: verdict.state === "validado" ? "marcar ENTREGADO" : "dejar la guía como está",
        imagen: evidence.imageUrl,
      });

      if (dry) continue;

      await admin.from("tanders_payment_checks").insert({
        shipment_id: row.id,
        store_id: row.store_id,
        image_url: evidence.imageUrl,
        state: verdict.state,
        reasons: verdict.reasons,
        recipient_name: reading.recipientName,
        amount: reading.amount,
        operation_number: reading.operationNumber,
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
    } catch {
      // Una guía que falla no puede tumbar el barrido de las demás.
      report.errores += 1;
    }
  }

  return report;
}
