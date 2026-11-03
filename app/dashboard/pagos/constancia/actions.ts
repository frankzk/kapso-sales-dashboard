"use server";

// Cargar a mano la constancia de cobro de una guía Tanders (03-11-2026).
// Qué se permite y por qué: lib/tanders/manual-collection.ts.
//
// La persona busca por nuestro código de pedido o por la guía de Tanders, pega
// la imagen que le llegó por WhatsApp y el cobro entra a «Validar pagos» por el
// MISMO puente que usa el barrido (`registerCourierCollection`): la imagen se
// lee con el lector de constancias de Tanders, se compara contra todo lo ya
// registrado y, si es un comprobante repetido, se bloquea y avisa.

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { decryptOrNull } from "@/lib/crypto";
import { getMasterPermissions } from "@/lib/permissions-access";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { raiseRepeatedVoucherAlert } from "@/lib/repeated-voucher-alert";
import { COURIER_COLLECTION_KIND, registerCourierCollection } from "@/lib/tanders/collection-payment";
import { checkTandersPayment, normalizeOperationNumber } from "@/lib/tanders/payment-check";
import { readTandersPayment } from "@/lib/tanders/payment-vision";
import {
  collectionGate,
  parseCollectionQuery,
  type CollectionGate,
  type CollectionTarget,
} from "@/lib/tanders/manual-collection";
import { VOUCHER_BUCKET } from "@/lib/voucher-inspect";
import { normalizeMediaType } from "@/lib/vision";

const PAGOS_PATH = "/dashboard/pagos";
const DENIED = "Tu rol no permite registrar pagos.";
/** Una búsqueda por pedido no trae más guías que estas. */
const MAX_TARGETS = 10;

export type CollectionTargetView = CollectionTarget & CollectionGate;

async function requireUploader(): Promise<{ userId: string } | { error: string }> {
  const perms = await getMasterPermissions();
  if (!perms.can("shalom.register_payment")) return { error: DENIED };
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  return { userId: user.id };
}

interface ShipmentRow {
  id: string;
  store_id: string;
  order_id: string | null;
  order_name: string | null;
  guide_code: string;
  delivery_status: string;
  reported_status: string | null;
  tanders_raw: { collectionAmount?: unknown } | null;
}

const SHIPMENT_COLUMNS =
  "id,store_id,order_id,order_name,guide_code,delivery_status,reported_status,tanders_raw";

function expectedAmountOf(raw: ShipmentRow["tanders_raw"]): number | null {
  const v = raw?.collectionAmount;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Las guías Tanders de lo que se escribió. La lectura va con la sesión (RLS):
 * una guía de otra tienda simplemente no aparece.
 */
async function loadTargets(rows: ShipmentRow[]): Promise<CollectionTargetView[]> {
  if (!rows.length) return [];
  const admin = createAdminSupabase();
  const orderIds = [...new Set(rows.map((r) => r.order_id).filter((id): id is string => Boolean(id)))];
  const storeIds = [...new Set(rows.map((r) => r.store_id))];
  const [orders, payments, stores] = await Promise.all([
    orderIds.length
      ? admin.from("orders").select("id,name,cancelled_at").in("id", orderIds)
      : Promise.resolve({ data: [] }),
    orderIds.length
      ? admin
          .from("order_payments")
          .select("order_id,validation_status,amount")
          .in("order_id", orderIds)
          .eq("kind", COURIER_COLLECTION_KIND)
          .neq("validation_status", "rechazado")
      : Promise.resolve({ data: [] }),
    admin.from("stores").select("id,name").in("id", storeIds),
  ]);
  const orderById = new Map(
    ((orders.data ?? []) as { id: string; name: string | null; cancelled_at: string | null }[]).map((o) => [o.id, o]),
  );
  const paymentByOrder = new Map(
    ((payments.data ?? []) as { order_id: string; validation_status: string; amount: number | null }[]).map((p) => [
      p.order_id,
      { status: p.validation_status, amount: p.amount == null ? null : Number(p.amount) },
    ]),
  );
  const storeName = new Map(((stores.data ?? []) as { id: string; name: string }[]).map((s) => [s.id, s.name]));

  return rows.map((r) => {
    const order = r.order_id ? orderById.get(r.order_id) : undefined;
    const target: CollectionTarget = {
      shipmentId: r.id,
      orderId: r.order_id,
      orderName: order?.name ?? r.order_name,
      storeName: storeName.get(r.store_id) ?? null,
      guideCode: r.guide_code,
      deliveryStatus: r.delivery_status,
      reportedStatus: r.reported_status,
      expectedAmount: expectedAmountOf(r.tanders_raw),
      cancelledAt: order?.cancelled_at ?? null,
      livePayment: (r.order_id && paymentByOrder.get(r.order_id)) || null,
    };
    return { ...target, ...collectionGate(target) };
  });
}

/** Busca por nuestro código de pedido o por la guía de Tanders. */
export async function findCollectionTargets(
  query: string,
): Promise<{ targets: CollectionTargetView[] } | { error: string }> {
  const auth = await requireUploader();
  if ("error" in auth) return auth;
  const parsed = parseCollectionQuery(query);
  if (!parsed) {
    return { error: "Escribe el código del pedido (#KP124940) o la guía de Tanders (TANDER1785…)." };
  }
  const sb = await createServerSupabase();
  let q = sb.from("shipments").select(SHIPMENT_COLUMNS).eq("courier", "tanders");
  if (parsed.kind === "guia") {
    q = q.eq("guide_code", parsed.guideCode);
  } else {
    // El nombre en `shipments` es una copia; el de verdad está en el pedido.
    const { data: orders } = await sb.from("order_master").select("order_id").ilike("order_name", parsed.orderName);
    const ids = ((orders ?? []) as { order_id: string }[]).map((o) => o.order_id);
    if (!ids.length) return { error: `No encontramos el pedido ${parsed.orderName}.` };
    q = q.in("order_id", ids);
  }
  const { data, error } = await q.order("created_at", { ascending: false }).limit(MAX_TARGETS);
  if (error) return { error: `No se pudo buscar: ${error.message}` };
  const rows = (data ?? []) as ShipmentRow[];
  if (!rows.length) {
    return {
      error:
        parsed.kind === "guia"
          ? `No encontramos la guía ${parsed.guideCode}.`
          : `El pedido ${parsed.orderName} no tiene guías de Tanders.`,
    };
  }
  return { targets: await loadTargets(rows) };
}

/** La guía, releída con la sesión: el navegador solo manda su id. */
async function readTarget(shipmentId: string): Promise<{ row: ShipmentRow; view: CollectionTargetView } | null> {
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("shipments")
    .select(SHIPMENT_COLUMNS)
    .eq("id", shipmentId)
    .eq("courier", "tanders")
    .maybeSingle();
  if (!data) return null;
  const row = data as ShipmentRow;
  const [view] = await loadTargets([row]);
  return view ? { row, view } : null;
}

/**
 * URL firmada para subir la imagen directo al bucket privado: evita el límite
 * del cuerpo de un Server Action, igual que «Registrar un pago».
 */
export async function createCollectionUpload(
  shipmentId: string,
  contentType: string,
  filename: string,
): Promise<{ path: string; token: string } | { error: string }> {
  const auth = await requireUploader();
  if ("error" in auth) return auth;
  if (!contentType.startsWith("image/")) return { error: "La constancia debe ser una imagen." };
  const target = await readTarget(shipmentId);
  if (!target?.row.order_id) return { error: "Sin acceso a esa guía." };
  if (target.view.blockers.length) return { error: target.view.blockers[0]! };

  const ext = (filename.split(".").pop() ?? "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `${target.row.store_id}/${target.row.order_id}/manual-${target.row.guide_code}-${Date.now()}.${ext}`;
  const { data, error } = await createAdminSupabase().storage.from(VOUCHER_BUCKET).createSignedUploadUrl(path);
  if (error || !data) return { error: error?.message ?? "No se pudo preparar la subida." };
  return { path: data.path, token: data.token };
}

/**
 * Registra la constancia ya subida: la lee, la compara y la deja en «Validar
 * pagos». Un pedido anulado en Shopify exige `confirmCancelled`.
 */
export async function registerManualCollection(input: {
  shipmentId: string;
  path: string;
  confirmCancelled?: boolean;
}): Promise<{ notice: string } | { error: string }> {
  const auth = await requireUploader();
  if ("error" in auth) return auth;
  const target = await readTarget(input.shipmentId);
  if (!target?.row.order_id) return { error: "Sin acceso a esa guía." };
  const { row, view } = target;
  const orderId = row.order_id!;
  if (view.blockers.length) return { error: view.blockers[0]! };
  // Solo una ruta de ESTE pedido: el bucket es privado y el navegador no elige
  // qué archivo de quién se adjunta.
  if (!input.path.startsWith(`${row.store_id}/${orderId}/manual-`)) {
    return { error: "La imagen no pertenece a esta guía." };
  }
  if (view.needsCancelConfirmation && !input.confirmCancelled) {
    return { error: "El pedido está anulado en la tienda: confirma que la venta sí se cobró." };
  }

  const admin = createAdminSupabase();
  const { data: file, error: dlError } = await admin.storage.from(VOUCHER_BUCKET).download(input.path);
  if (dlError || !file) return { error: "No se encontró la imagen subida. Vuelve a pegarla." };
  const bytes = await file.arrayBuffer();
  const mediaType = normalizeMediaType(file.type);

  const { data: store } = await admin
    .from("stores")
    .select("anthropic_api_key_enc,anthropic_model")
    .eq("id", row.store_id)
    .maybeSingle();
  const creds = store as { anthropic_api_key_enc: string | null; anthropic_model: string | null } | null;
  const reading = await readTandersPayment(Buffer.from(bytes).toString("base64"), mediaType, {
    anthropicApiKey: decryptOrNull(creds?.anthropic_api_key_enc ?? null),
    anthropicModel: creds?.anthropic_model ?? null,
  });
  const operation = normalizeOperationNumber(reading.operationNumber);

  // ¿El barrido ya leyó este mismo nº de operación en OTRA guía? Es el caso de
  // los pares con un solo Yape (#KP125070 y #KP124793): ninguno llegó a la
  // cola, así que el choque solo está en las lecturas de Tanders.
  let otraGuia: string | null = null;
  if (operation) {
    const { data: checks } = await admin
      .from("tanders_payment_checks")
      .select("shipment_id")
      .eq("operation_number", operation)
      .neq("shipment_id", row.id)
      .limit(1);
    const otherId = ((checks ?? []) as { shipment_id: string }[])[0]?.shipment_id;
    if (otherId) {
      const { data: other } = await admin.from("shipments").select("order_name,guide_code").eq("id", otherId).maybeSingle();
      const o = other as { order_name: string | null; guide_code: string } | null;
      otraGuia = o?.order_name ?? o?.guide_code ?? "otra guía";
    }
  }

  const sha256 = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  const alertRepeated = (alsoIn: string, amount: number | null) =>
    raiseRepeatedVoucherAlert(admin, {
      storeId: row.store_id,
      orderId,
      orderName: view.orderName ?? row.guide_code,
      alsoIn: [alsoIn],
      operation,
      fileSha256: sha256,
      amount,
      source: "subida_manual",
      actions: ["Se bloqueó al subirlo: no se registró."],
    });

  if (otraGuia) {
    await alertRepeated(otraGuia, reading.amount);
    return { error: `Ese comprobante (operación ${operation}) ya es la constancia de ${otraGuia}. No se registró.` };
  }

  const verdict = checkTandersPayment({
    duplicateOf: [],
    voucher: {
      ok: reading.ok,
      isVoucher: reading.isPaymentProof,
      method: reading.method,
      toYape: reading.toYape,
      recipientName: reading.recipientName,
      amount: reading.amount,
      operationNumber: operation,
    },
    expectedAmount: view.expectedAmount,
  });

  const alta = await registerCourierCollection(admin, {
    storeId: row.store_id,
    orderId,
    guideCode: row.guide_code,
    imageUrl: null,
    imageBytes: bytes,
    mediaType,
    reading,
    verdict,
    expectedAmount: view.expectedAmount,
    manual: { storedPath: input.path, registeredBy: auth.userId },
  });

  if (!alta.registered) {
    if (alta.reason === "duplicado") {
      const donde = alta.repeated.orderName ?? "otro pedido";
      if (!alta.repeated.sameOrder) await alertRepeated(donde, alta.repeated.amount);
      return {
        error: alta.repeated.sameOrder
          ? "Esa misma constancia ya está registrada en este pedido."
          : `Ese comprobante ya está registrado en ${donde}. No se registró.`,
      };
    }
    if (alta.reason === "ya_registrado") return { error: "El pedido ya tiene una constancia de cobro en «Validar pagos»." };
    return { error: `No se pudo registrar: ${alta.detail ?? alta.reason}` };
  }

  await admin.from("order_events").insert({
    store_id: row.store_id,
    order_id: orderId,
    kind: "payment",
    actor: auth.userId,
    source: "manual",
    note:
      `Constancia de cobro de ${row.guide_code} (Tanders) subida a mano` +
      (reading.amount != null ? ` (S/ ${reading.amount.toFixed(2)})` : "") +
      (view.cancelledAt ? ". El pedido está anulado en la tienda y se confirmó que se cobró." : "."),
  });
  await recomputeOrderMasterSafe(admin, [orderId]);
  revalidatePath(PAGOS_PATH);

  const leido = [
    reading.amount != null && `S/ ${reading.amount.toFixed(2)}`,
    operation && `operación ${operation}`,
  ].filter(Boolean);
  return {
    notice:
      `Constancia de ${view.orderName ?? row.guide_code} registrada` +
      (leido.length ? ` (${leido.join(", ")})` : "") +
      `. Ya está en «Validar pagos»: ${verdict.summary}`,
  };
}
