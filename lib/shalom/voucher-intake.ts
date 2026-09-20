// El comprobante que la clienta manda por el número de cobranza (MOM §12).
//
// EL HUECO QUE TAPA. Desde que el aviso de Shalom sale solo, las clientas
// contestan con la captura de su Yape por el 600. Ahí no hay ninguna asesora
// mirando —ése era el punto del número dedicado— así que el bot contestaba
// «tu pago pasa a revisión» y la imagen se quedaba en el chat: no entraba a
// `order_payments`, nadie la validaba, y la clave no se liberaba. Medido el
// 20-09-2026 en #KP134340: S/ 237 pagados a las 17:43 y cero rastro en Kapta.
//
// LAS DOS PUERTAS. Registrar plata en el pedido equivocado es peor que no
// registrarla: una clienta recibiría su clave sin haber pagado y otra pagaría
// sin recibirla. Así que solo pasa lo que se puede atribuir SIN ADIVINAR:
//
//   1. EL MONTO. El importe leído coincide exacto con el saldo pendiente de un
//      candidato, o con su total (paga todo de golpe ignorando el adelanto).
//   2. LA GUÍA. Escribió la guía o el código de Shalom junto a la foto. Vale
//      aunque el monto no cuadre — nombrar la guía es decir de qué pedido es.
//
// Una sola puerta basta, pero tiene que señalar a UN candidato. Dos empatados
// es no saber, y no saber se resuelve con una persona, no con una moneda.
//
// LO QUE NO PASA NO DESAPARECE. Un pago parcial —debe S/ 237 y manda S/ 200—
// no cruza ninguna puerta, y es el caso más frecuente de los que caen. Queda
// la anomalía con el motivo escrito para que alguien lo suba a mano; lo que no
// puede pasar es el silencio, que es donde estábamos.
//
// Y ENTRA SIN VALIDAR, como todo comprobante que no miró una persona. Puede
// ensuciar la cola de revisión; no puede soltar un paquete sin cobrar.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoreCreds } from "@/lib/ingest";
import { noteAnomaly } from "@/lib/ingest-anomalies";
import { fetchKapsoImageBase64, type InboundMessage } from "@/lib/kapso";
import { analyzeYapeVoucherFromEnv, extractYapeVoucherFromEnv } from "@/lib/vision";
import { VOUCHER_BUCKET } from "@/lib/voucher-inspect";
import { findDuplicate, normalizeOperationNumber } from "@/lib/yape-dedup";
import { raiseCollectionAlert } from "@/lib/collection-alerts-access";

/** Un pedido al que este comprobante PODRÍA pertenecer. */
export interface VoucherCandidate {
  orderId: string;
  orderName: string | null;
  /** Lo que debe hoy, con los pagos validados descontados. */
  saldo: number | null;
  total: number | null;
  guideCode: string | null;
  shalomCodigo: string | null;
}

export type IntakeGate = "monto" | "guia";

export type CandidateMatch =
  | { ok: true; candidate: VoucherCandidate; gate: IntakeGate }
  | { ok: false; reason: string };

/** Céntimos, para no comparar importes en coma flotante. */
function cents(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Normaliza para buscar una guía dentro del texto: solo letras y dígitos. */
function squash(s: string | null | undefined): string {
  return String(s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * A qué pedido pertenece este comprobante, o por qué no se sabe. Pura — es el
 * corazón de la decisión y se prueba sin red ni base.
 *
 * El orden importa: la guía manda sobre el monto. Si la escribió, está
 * diciendo de qué pedido habla, y eso es más fuerte que una coincidencia
 * aritmética que podría ser casualidad entre dos pedidos del mismo importe.
 */
export function matchCandidate(
  candidates: readonly VoucherCandidate[],
  amount: number | null,
  texto: string | null | undefined,
): CandidateMatch {
  if (!candidates.length) return { ok: false, reason: "sin pedidos con saldo abierto para ese celular" };

  // Puerta 2 — la guía escrita.
  const t = squash(texto);
  if (t) {
    // Un código de Shalom son 4 caracteres: buscarlo suelto daría falsos
    // positivos dentro de cualquier palabra. Solo cuenta si el texto lo nombra
    // con su guía o si es lo único que escribió.
    const porGuia = candidates.filter((c) => {
      const g = squash(c.guideCode);
      return g.length >= 6 && t.includes(g);
    });
    if (porGuia.length === 1) return { ok: true, candidate: porGuia[0]!, gate: "guia" };
    if (porGuia.length > 1) return { ok: false, reason: "el texto nombra más de una guía" };

    const porCodigo = candidates.filter((c) => {
      const k = squash(c.shalomCodigo);
      return k.length >= 4 && t === k;
    });
    if (porCodigo.length === 1) return { ok: true, candidate: porCodigo[0]!, gate: "guia" };
  }

  // Puerta 1 — el monto exacto.
  const pagado = cents(amount);
  if (pagado == null) return { ok: false, reason: "la visión no pudo leer el monto" };
  const porMonto = candidates.filter((c) => cents(c.saldo) === pagado || cents(c.total) === pagado);
  if (porMonto.length === 1) return { ok: true, candidate: porMonto[0]!, gate: "monto" };
  if (porMonto.length > 1) return { ok: false, reason: "el monto coincide con más de un pedido" };

  const saldos = candidates
    .map((c) => `${c.orderName ?? c.orderId} debe ${c.saldo?.toFixed(2) ?? "?"}`)
    .join("; ");
  return { ok: false, reason: `el monto no coincide con ningún saldo ni total (${saldos})` };
}

export interface IntakeResult {
  /** `registrado` | `sin_atribuir` | y los motivos por los que ni se intentó. */
  outcome: string;
  paymentId?: string;
  orderId?: string;
  detail?: string;
}

export interface IntakeDeps {
  fetchImage?: typeof fetchKapsoImageBase64;
  nowIso?: string;
}

/**
 * Atiende una imagen entrante del número de cobranza. Nunca lanza: el webhook
 * tiene que contestar 200 a Kapso pase lo que pase.
 */
export async function handleInboundVoucher(
  admin: SupabaseClient,
  storeId: string,
  creds: StoreCreds,
  msg: InboundMessage,
  candidates: readonly VoucherCandidate[],
  deps: IntakeDeps = {},
): Promise<IntakeResult> {
  const nowIso = deps.nowIso ?? new Date().toISOString();
  const fail = async (outcome: string, detail: string): Promise<IntakeResult> => {
    // Nunca se termina en silencio: si el dinero entró y no lo registramos,
    // alguien tiene que poder enterarse sin leer los chats uno por uno. La
    // anomalía deja el rastro agregado; la alerta le pone DUEÑO y reloj.
    await noteAnomaly(admin, {
      storeId,
      source: "inbound_voucher",
      reason: outcome,
      sample: { phone: msg.from, messageId: msg.id, detail },
    });
    await raiseCollectionAlert(
      admin,
      {
        storeId,
        kind: "sin_atribuir",
        phone: msg.from,
        inboundMessageId: msg.id,
        detail,
      },
      nowIso,
    );
    return { outcome, detail };
  };

  if (!msg.mediaUrl || msg.mediaKind !== "image") return { outcome: "no_es_imagen" };
  if (!creds.kapso_api_key) return { outcome: "store_not_configured" };

  const img = await (deps.fetchImage ?? fetchKapsoImageBase64)(
    { apiKey: creds.kapso_api_key },
    msg.mediaUrl,
  );
  // Que no se pueda bajar la imagen es el peor fallo callado posible: la
  // clienta pagó y el bot le dijo que su pago está en revisión.
  if (!img) return fail("imagen_no_descargable", "no se pudo bajar la imagen de Kapso");

  const visionCreds = {
    anthropicApiKey: creds.anthropic_api_key,
    anthropicModel: creds.anthropic_model,
  };
  const [verdict, fields] = await Promise.all([
    analyzeYapeVoucherFromEnv(img.base64, img.contentType, visionCreds),
    extractYapeVoucherFromEnv(img.base64, img.contentType, visionCreds),
  ]);
  // Una foto cualquiera —el producto, una selfie— no es un comprobante y no
  // puede crear una fila de plata.
  if (verdict.ok && !verdict.isVoucher) return { outcome: "no_es_comprobante" };

  const amount = fields.amount ?? null;
  const match = matchCandidate(candidates, amount, msg.text);
  if (!match.ok) return fail("sin_atribuir", match.reason);

  const operation = normalizeOperationNumber(fields.operationNumber);
  const bytes = Buffer.from(img.base64, "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const { data: choques } = await admin
    .from("order_payments")
    .select("id, order_id, kind, amount, operation_number, paid_at, payer_name, payer_phone, file_sha256")
    .or(`operation_number.eq.${operation ?? "__none__"},file_sha256.eq.${sha256}`)
    .limit(20);
  const dup = findDuplicate(
    {
      order_id: match.candidate.orderId,
      kind: "diferencia",
      amount,
      operation_number: operation,
      paid_at: fields.paidAt ?? null,
      payer_name: fields.payerName ?? null,
      payer_phone: null,
      file_sha256: sha256,
    },
    (choques ?? []) as never[],
  );
  if (dup.duplicate) return fail("duplicado", "ese comprobante ya está registrado en otro pedido o en éste");

  const ext = (img.contentType ?? "").includes("png") ? "png" : "jpg";
  const path = `${storeId}/${match.candidate.orderId}/wa-${msg.id.replace(/[^A-Za-z0-9]/g, "")}.${ext}`;
  const { error: upErr } = await admin.storage
    .from(VOUCHER_BUCKET)
    .upload(path, bytes, { contentType: img.contentType ?? "image/jpeg", upsert: false });
  if (upErr) return fail("error_al_guardar", upErr.message);

  const { data: pago, error } = await admin
    .from("order_payments")
    .insert({
      store_id: storeId,
      order_id: match.candidate.orderId,
      kind: "diferencia",
      amount,
      operation_number: operation,
      paid_at: fields.paidAt ?? null,
      payer_name: fields.payerName ?? null,
      file_path: path,
      file_type: img.contentType,
      file_sha256: sha256,
      // Sin número de operación no se puede validar (es lo único que impide
      // reusar el mismo Yape en otro pedido): entra a completar, no a cobrar.
      validation_status: operation ? "pendiente_revision" : "info_incompleta",
      // `registered_by` en null a propósito: no lo registró una persona.
      notes: `Comprobante recibido por WhatsApp (cobranza Shalom). Atribuido por ${match.gate}.`,
      vision: {
        source: "wa_cobranza_shalom",
        gate: match.gate,
        message_id: msg.id,
        phone: msg.from,
        is_voucher: verdict.ok ? verdict.isVoucher : null,
        model: verdict.model,
        recipient_name: fields.recipientName ?? null,
        amount,
        operation_number: operation,
        saldo_esperado: match.candidate.saldo,
      },
    })
    .select("id")
    .single();
  if (error || !pago) {
    if ((error as { code?: string } | null)?.code === "23505") {
      return fail("duplicado", "los índices únicos pararon el registro");
    }
    return fail("error_al_registrar", error?.message ?? "el insert no devolvió fila");
  }

  await admin.from("order_events").insert({
    store_id: storeId,
    order_id: match.candidate.orderId,
    kind: "payment",
    occurred_at: nowIso,
    source: "system",
    note:
      `Comprobante recibido por WhatsApp y atribuido a este pedido por ${match.gate}. ` +
      `Pendiente de que una persona lo valide.`,
  });

  // Registrado no es cobrado: alguien tiene que validarlo para que la clave se
  // libere. Por eso también levanta alerta — con dueño, no en una bandeja.
  await raiseCollectionAlert(
    admin,
    {
      storeId,
      kind: "registrado",
      orderId: match.candidate.orderId,
      paymentId: (pago as { id: string }).id,
      phone: msg.from,
      inboundMessageId: msg.id,
      amount,
      detail: `${match.candidate.orderName ?? ""} · atribuido por ${match.gate} · falta validar`.trim(),
    },
    nowIso,
  );

  return {
    outcome: "registrado",
    paymentId: (pago as { id: string }).id,
    orderId: match.candidate.orderId,
  };
}

/**
 * Los pedidos de ese celular a los que este comprobante podría pertenecer:
 * con saldo abierto y con guía de Shalom. Ninguna lectura lanza.
 *
 * Se busca por CELULAR y no por el pedido del último aviso a propósito: una
 * clienta puede tener dos pedidos abiertos, y quedarse con el último sería
 * justo la adivinanza que las puertas existen para evitar. Mejor traer los dos
 * y que el monto o la guía decidan — o que no decidan y lo mire una persona.
 */
export async function loadVoucherCandidates(
  admin: SupabaseClient,
  storeId: string,
  phone: string,
): Promise<VoucherCandidate[]> {
  const { data: pedidos } = await admin
    .from("orders")
    .select("id,name,total_amount")
    .eq("store_id", storeId)
    .eq("customer_phone", phone)
    .order("created_at", { ascending: false })
    .limit(10);
  const rows = (pedidos ?? []) as { id: string; name: string | null; total_amount: number | null }[];
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);

  const [pagos, envios] = await Promise.all([
    admin.from("order_payments").select("order_id,amount,validation_status").in("order_id", ids),
    admin.from("shipments").select("order_id,guide_code,shalom_codigo").in("order_id", ids).eq("courier", "shalom"),
  ]);

  const validado = new Map<string, number>();
  for (const p of (pagos.data ?? []) as { order_id: string; amount: number | null; validation_status: string }[]) {
    if (p.validation_status !== "validado") continue;
    validado.set(p.order_id, (validado.get(p.order_id) ?? 0) + (Number(p.amount) || 0));
  }
  const guia = new Map<string, { guide_code: string | null; shalom_codigo: string | null }>();
  for (const s of (envios.data ?? []) as { order_id: string; guide_code: string | null; shalom_codigo: string | null }[]) {
    if (!guia.has(s.order_id)) guia.set(s.order_id, s);
  }

  const out: VoucherCandidate[] = [];
  for (const r of rows) {
    const envio = guia.get(r.id);
    if (!envio) continue; // sin guía de Shalom no es de esta cobranza
    const total = r.total_amount == null ? null : Number(r.total_amount);
    const saldo = total == null ? null : Math.max(0, Math.round((total - (validado.get(r.id) ?? 0)) * 100) / 100);
    if (saldo != null && saldo <= 0) continue; // ya no debe nada
    out.push({
      orderId: r.id,
      orderName: r.name,
      saldo,
      total,
      guideCode: envio.guide_code,
      shalomCodigo: envio.shalom_codigo,
    });
  }
  return out;
}
