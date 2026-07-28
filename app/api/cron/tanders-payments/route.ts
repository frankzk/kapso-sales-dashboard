import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { env } from "@/lib/env";
import { extractPaymentEvidence, TandersClient } from "@/lib/tanders/client";
import { checkTandersPayment, REASON_LABEL } from "@/lib/tanders/payment-check";
import { extractYapeVoucherFromEnv, analyzeYapeVoucherFromEnv, normalizeMediaType } from "@/lib/vision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Validación de las constancias de pago de Tanders.
//
// POR QUÉ UN CRON Y NO UN BOTÓN. La constancia aparece cuando el repartidor
// entrega, que es a cualquier hora y sin que nadie esté mirando el Master. Si
// dependiera de que alguien abra el pedido, los cobros mal hechos se
// descubrirían tarde o no se descubrirían.
//
// QUÉ COMPRUEBA. Que el comprobante sea un Yape real, a Grupo GF SAC, por el
// monto de la guía. Un pago a otra cuenta es dinero que no llegó.
//
// BLOQUEA. Mientras el resultado no sea `validado` (o un administrador lo dé por
// bueno a mano), el pedido no cuenta como cobrado.
//
// El barrido es idempotente: una guía ya validada no se vuelve a analizar, así
// que ejecutarlo de más no gasta llamadas al modelo ni dinero.

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

  const admin = createAdminSupabase();
  const since = new Date(Date.now() - LOOKBACK_DAYS * DAY_MS).toISOString();

  // Entregas Tanders recientes que todavía no tienen un veredicto firme. Un
  // `rechazado` tampoco se reanaliza: ya está esperando a un humano.
  const { data, error } = await admin
    .from("shipments")
    .select(
      "id,store_id,guide_code,tanders_order_id,order_id,order_name,payment_check_state,tanders_raw",
    )
    .eq("courier", "tanders")
    .eq("delivery_status", "entregado")
    .gte("updated_at", since)
    .or("payment_check_state.is.null,payment_check_state.eq.pendiente")
    .limit(MAX_PER_RUN);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const candidates = (data as Candidate[]) ?? [];

  const report = { scanned: candidates.length, validado: 0, rechazado: 0, pendiente: 0, errores: 0 };
  const rejected: string[] = [];

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

      const raw = await client.evidences(row.tanders_order_id);
      const payments = extractPaymentEvidence(raw);
      // Sin constancia identificable no se decide nada: queda pendiente, que
      // bloquea igual pero no acusa a nadie. Ver extractPaymentEvidence.
      if (!payments.length) {
        report.pendiente += 1;
        await admin.from("shipments").update({ payment_check_state: "pendiente" }).eq("id", row.id);
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
      const [isVoucher, fields] = await Promise.all([
        analyzeYapeVoucherFromEnv(base64, mediaType, creds),
        extractYapeVoucherFromEnv(base64, mediaType, creds),
      ]);

      const expected = expectedAmount(row.tanders_raw);
      const verdict = checkTandersPayment({
        voucher: {
          ok: isVoucher.ok && fields.ok,
          isVoucher: isVoucher.isVoucher,
          recipientName: fields.recipientName,
          amount: fields.amount,
          operationNumber: fields.operationNumber,
        },
        expectedAmount: expected,
      });

      await admin.from("tanders_payment_checks").insert({
        shipment_id: row.id,
        store_id: row.store_id,
        image_url: evidence.imageUrl,
        state: verdict.state,
        reasons: verdict.reasons,
        recipient_name: fields.recipientName,
        amount: fields.amount,
        operation_number: fields.operationNumber,
        expected_amount: expected,
        model: fields.model,
        raw: raw as Record<string, unknown>,
      });

      await admin
        .from("shipments")
        .update({ payment_check_state: verdict.state })
        .eq("id", row.id);

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

  return NextResponse.json({ ok: true, ...report, rejected });
}
