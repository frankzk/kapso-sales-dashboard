// Un rótulo de Olva llegado por correo (MOM §12): leerlo, guardarlo y, si no
// admite duda, ponerle el tracking a su salida. Lo llama el webhook que
// alimenta Make (/api/webhooks/olva-email).

import type { SupabaseClient } from "@supabase/supabase-js";
import { linkOlvaTrackingIfEmpty } from "@/lib/olva/link";
import {
  matchLabel,
  orderFitsLabelDate,
  parseOlvaLabelText,
  phoneKey,
  type LabelOutcome,
  type OlvaEmailLabel,
} from "@/lib/olva/email-label";
import { loadOlvaCandidates, limaDayKey } from "@/lib/olva/portal-sync";
import { formatOlvaTracking } from "@/lib/olva/tracking";
import { isTerminalGeneral } from "@/lib/order-status";

export type { LabelOutcome };

export interface LabelIngestResult {
  outcome: LabelOutcome;
  tracking: string | null;
  note: string;
}

/** El texto de un PDF. Import dinámico: solo esta ruta carga el lector. */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Las tiendas que despachan con la cuenta que envía (el RUC de «ENVIA»):
 * todas las de las organizaciones que tienen ese RUC en Ajustes. Sin RUC
 * reconocible no se coteja contra nadie.
 */
async function storesForSender(admin: SupabaseClient, senderDoc: string | null): Promise<string[]> {
  if (!senderDoc) return [];
  const { data: own } = await admin.from("stores").select("org_id").eq("olva_portal_ruc", senderDoc);
  const orgIds = [...new Set(((own ?? []) as { org_id: string }[]).map((s) => s.org_id))];
  if (!orgIds.length) return [];
  const { data } = await admin.from("stores").select("id,olva_portal_ruc").in("org_id", orgIds);
  return ((data ?? []) as { id: string; olva_portal_ruc: string | null }[])
    .filter((s) => !s.olva_portal_ruc || s.olva_portal_ruc === senderDoc)
    .map((s) => s.id);
}

/**
 * El pedido con ese teléfono que todavía no tiene salida de Olva: se SUGIERE
 * en la pantalla, no se crea la salida sola. Crear una salida es una decisión
 * de despacho y el rótulo solo dice a quién iba.
 */
async function suggestOrder(
  admin: SupabaseClient,
  storeIds: string[],
  label: OlvaEmailLabel,
  day: string,
): Promise<string[]> {
  const key = phoneKey(label.recipientPhone);
  if (!key || !storeIds.length) return [];
  const { data } = await admin
    .from("order_master")
    .select("order_name,general_status,order_created_at")
    .in("store_id", storeIds)
    .in("customer_phone", [`51${key}`, key, `+51${key}`])
    .limit(20);
  return ((data ?? []) as { order_name: string | null; general_status: string | null; order_created_at: string | null }[])
    .filter((o) => o.order_name && !isTerminalGeneral(o.general_status ?? "") && orderFitsLabelDate(o.order_created_at, day))
    .map((o) => o.order_name as string);
}

export async function ingestOlvaEmailLabel(
  admin: SupabaseClient,
  input: { messageId: string; fileName: string; receivedAt: string | null; subject: string | null; text: string },
): Promise<LabelIngestResult> {
  const label = parseOlvaLabelText(input.text);
  const tracking = label.id ? formatOlvaTracking(label.id) : null;
  const base = {
    message_id: input.messageId,
    file_name: input.fileName,
    received_at: input.receivedAt,
    subject: input.subject,
    registro: label.registro,
    olva_tracking: label.id?.tracking ?? null,
    olva_emision: label.id?.emision ?? null,
    sender_doc: label.senderDoc,
    recipient_name: label.recipientName,
    recipient_doc: label.recipientDoc,
    recipient_phone: label.recipientPhone,
    address: label.address,
    reference: label.reference,
    ubigeo: label.ubigeo,
    label_date: label.fecha,
    raw_text: input.text.slice(0, 8000),
    parse_error: label.id ? null : "no se leyó el tracking del rótulo",
    updated_at: new Date().toISOString(),
  };
  const save = async (extra: Record<string, unknown>, result: LabelIngestResult) => {
    const row = { ...base, ...extra, match_note: result.note, outcome: result.outcome };
    let { error } = await admin.from("olva_email_labels").upsert(row, { onConflict: "message_id,file_name" });
    // Sin la 0226 aplicada no existe `outcome`: el correo se guarda igual y
    // «Correos de Olva» deduce el resultado de la nota (`labelOutcome`).
    if (error && /outcome/.test(error.message)) {
      const { outcome: _outcome, ...legacy } = row;
      ({ error } = await admin.from("olva_email_labels").upsert(legacy, { onConflict: "message_id,file_name" }));
    }
    if (error) console.error("[olva-email] no se pudo guardar el rótulo", input.messageId, error.message);
    return result;
  };

  if (!label.id) return save({}, { outcome: "ilegible", tracking, note: "No se leyó el tracking del rótulo." });

  const { data: owner } = await admin
    .from("shipments")
    .select("id,order_name")
    .eq("olva_tracking", label.id.tracking)
    .eq("olva_emision", label.id.emision)
    .limit(1)
    .maybeSingle();
  const linked = owner as { id: string; order_name: string | null } | null;
  if (linked) {
    // Make puede mandar el mismo correo otra vez. Si la primera vez fue ESTE
    // correo el que puso el tracking, sigue siéndolo: no pasa a «ya estaba».
    const { data: before } = await admin
      .from("olva_email_labels")
      .select("linked_shipment_id,match_note")
      .eq("message_id", input.messageId)
      .eq("file_name", input.fileName)
      .maybeSingle();
    const prior = before as { linked_shipment_id: string | null; match_note: string | null } | null;
    if (prior?.linked_shipment_id === linked.id && prior.match_note?.startsWith("Puesto en")) {
      return save({ linked_shipment_id: linked.id }, { outcome: "vinculado", tracking, note: prior.match_note });
    }
    return save(
      { linked_shipment_id: linked.id },
      { outcome: "ya_vinculado", tracking, note: `Ya estaba en ${linked.order_name ?? "una salida"}.` },
    );
  }

  const storeIds = await storesForSender(admin, label.senderDoc);
  if (!storeIds.length) {
    return save({}, { outcome: "sin_pareja", tracking, note: `Ninguna tienda tiene el RUC ${label.senderDoc ?? "(sin leer)"} en Ajustes.` });
  }
  const day = label.fecha ?? limaDayKey(input.receivedAt ? new Date(input.receivedAt) : new Date());
  const candidates = await loadOlvaCandidates(admin, storeIds, addDays(day, -30));
  const m = matchLabel(label, candidates);

  if (m.kind === "match") {
    const via = m.via === "telefono" ? "mismo teléfono" : "mismo DNI";
    const res = await linkOlvaTrackingIfEmpty(admin, {
      shipmentId: m.candidate.shipmentId,
      id: label.id,
      actor: null,
      note: `Tracking Olva ${tracking} registrado por el rótulo que Olva mandó por correo (${via}).`,
      payload: { via: `rotulo_${m.via}`, registro: label.registro },
    });
    if (res.ok) {
      return save(
        { linked_shipment_id: m.candidate.shipmentId },
        { outcome: "vinculado", tracking, note: `Puesto en ${m.candidate.orderName ?? "la salida"} (${via}).` },
      );
    }
    return save({}, { outcome: "ambiguo", tracking, note: res.error });
  }
  if (m.kind === "ambiguous") {
    const names = m.candidates.map((c) => c.orderName ?? "?").join(", ");
    return save({}, { outcome: "ambiguo", tracking, note: `Coincide con varias salidas: ${names}.` });
  }

  const orders = await suggestOrder(admin, storeIds, label, day);
  if (orders.length === 1) {
    return save(
      { suggested_order_name: orders[0] },
      { outcome: "sugerido", tracking, note: `${orders[0]} tiene ese teléfono y no tiene salida de Olva sin tracking.` },
    );
  }
  return save(
    {},
    {
      outcome: "sin_pareja",
      tracking,
      note: orders.length ? `Varios pedidos con ese teléfono: ${orders.slice(0, 3).join(", ")}.` : "Ningún pedido con ese teléfono ni DNI.",
    },
  );
}
