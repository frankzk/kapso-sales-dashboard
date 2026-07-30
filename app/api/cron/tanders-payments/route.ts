import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { decrypt } from "@/lib/crypto";
import { env } from "@/lib/env";
import { extractPaymentEvidence, TandersClient } from "@/lib/tanders/client";
import { checkTandersPayment, REASON_LABEL } from "@/lib/tanders/payment-check";
import { readTandersPayment } from "@/lib/tanders/payment-vision";
import { normalizeMediaType } from "@/lib/vision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Estado y cobro de las guías Tanders, en un solo barrido.
//
// EL ORDEN IMPORTA Y ES LA REGLA DEL NEGOCIO: que Tanders diga "entregado" no
// basta para darlo por entregado acá. Primero se valida la constancia de pago; la
// guía pasa a `entregado` SOLO si el dinero está confirmado. Una entrega sin
// cobro validado se queda como está y espera a que alguien mire — que es
// exactamente lo que no pasaba cuando el estado se copiaba tal cual.
//
// POR QUÉ UN CRON Y NO UN BOTÓN. La entrega y su constancia ocurren a cualquier
// hora y sin que nadie esté mirando el Master.
//
// QUÉ SE ACEPTA COMO COBRO. Un comprobante real —Yape o transferencia BCP— a
// Grupo GF SAC, por el monto de la guía. Un pago a otra cuenta es dinero que no
// llegó; uno por otro medio no se puede conciliar después.
//
// Idempotente: una guía ya entregada y validada no se vuelve a analizar, así que
// ejecutarlo de más no gasta llamadas al modelo.
//
// MODO EN SECO (`?dry=1`). Hace exactamente el mismo recorrido —incluida la
// lectura de las imágenes— pero NO escribe nada: ni el estado de la guía, ni la
// fila de la comprobación. Devuelve qué leyó de cada constancia y qué habría
// hecho. Existe para poder mirar los veredictos ANTES de dejar que un modelo
// mueva guías a "entregado": con dinero de por medio, la primera pasada la
// revisa un humano.

const DAY_MS = 86_400_000;
/** Días hacia atrás. Cubre "también las de esta semana" con margen. */
const LOOKBACK_DAYS = 8;
/** Tope por ejecución: cada guía cuesta una llamada al modelo. */
const MAX_PER_RUN = 60;

function secretEquals(got: string | null, want: string): boolean {
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  const bearer = req.headers.get("authorization");
  if (bearer?.startsWith("Bearer ") && secretEquals(bearer.slice(7), secret)) return true;
  return secretEquals(req.nextUrl.searchParams.get("secret"), secret);
}

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

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";

  const admin = createAdminSupabase();
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

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const candidates = (data as Candidate[]) ?? [];

  const report = {
    scanned: candidates.length,
    en_curso: 0,
    entregado: 0,
    validado: 0,
    rechazado: 0,
    pendiente: 0,
    errores: 0,
  };
  const rejected: string[] = [];
  /** Detalle por guía. Solo se llena en seco: es lo que se revisa a mano. */
  const detalle: Record<string, unknown>[] = [];

  // Una sesión por tienda: el cliente cachea su token entre guías.
  const clients = new Map<string, TandersClient | null>();
  const visionCreds = new Map<string, { anthropic_api_key: string | null; anthropic_model: string | null }>();

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
        visionCreds.set(row.store_id, {
          anthropic_api_key: st?.anthropic_api_key_enc ? decrypt(st.anthropic_api_key_enc) : null,
          anthropic_model: st?.anthropic_model ?? null,
        });
      }

      const client = clients.get(row.store_id);
      if (!client || !row.tanders_order_id) {
        report.errores += 1;
        continue;
      }

      // 1) ¿Tanders ya la dio por entregada? Si no, no hay nada que validar.
      const order = await client.getOrder(row.tanders_order_id);
      const delivered = String(order?.status ?? "").toUpperCase() === "DELIVERED";
      if (!delivered) {
        report.en_curso += 1;
        continue;
      }

      // 2) La constancia de pago. Solo con ella se decide.
      const raw = await client.evidences(row.tanders_order_id);
      const payments = extractPaymentEvidence(raw);
      // Sin constancia identificable no se decide nada: queda pendiente, que
      // bloquea igual pero no acusa a nadie. Ver extractPaymentEvidence.
      if (!payments.length) {
        report.pendiente += 1;
        if (dry) {
          detalle.push({
            guia: row.guide_code,
            pedido: row.order_name,
            motivo: "Tanders la da por entregada pero no se encontró constancia de pago",
          });
        } else {
          await admin.from("shipments").update({ payment_check_state: "pendiente" }).eq("id", row.id);
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
      const bytes = Buffer.from(await img.arrayBuffer());
      const base64 = bytes.toString("base64");
      const mediaType = normalizeMediaType(img.headers.get("content-type"));

      const creds = visionCreds.get(row.store_id) ?? {};
      const reading = await readTandersPayment(base64, mediaType, creds);

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

      if (dry) {
        report[verdict.state as "validado" | "rechazado" | "pendiente"] += 1;
        if (verdict.state === "validado") report.entregado += 1;
        detalle.push({
          guia: row.guide_code,
          pedido: row.order_name,
          cobro_esperado: expected,
          leido: {
            es_comprobante: reading.isPaymentProof,
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
        continue;
      }

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

      // 3) El estado solo avanza con el cobro validado. Sin eso la guía se
      //    queda donde está: darla por entregada sería dar por cobrado un
      //    dinero que nadie confirmó.
      const patch: Record<string, unknown> = { payment_check_state: verdict.state };
      if (verdict.state === "validado") {
        patch.delivery_status = "entregado";
        patch.status_category = "delivered";
        report.entregado += 1;
      }
      await admin.from("shipments").update(patch).eq("id", row.id);
      if (row.order_id) await recomputeOrderMasterSafe(admin, [row.order_id]);

      report[verdict.state as "validado" | "rechazado" | "pendiente"] += 1;
      if (verdict.state === "rechazado") {
        rejected.push(
          `${row.order_name ?? row.guide_code}: ${verdict.reasons.map((r) => REASON_LABEL[r]).join(", ")}`,
        );
      }
    } catch {
      // Una guía que falla no puede tumbar el barrido de las demás.
      report.errores += 1;
    }
  }

  if (dry) return NextResponse.json({ ok: true, dry: true, ...report, detalle });
  return NextResponse.json({ ok: true, ...report, rejected });
}
