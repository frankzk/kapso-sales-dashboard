"use server";

// Pagos Yape y clave de recojo de los envíos por Shalom.
//
// El proceso: el cliente paga un ADELANTO para que el pedido se despache y, antes
// de recibir la clave con la que recoge el paquete en la agencia, paga la
// DIFERENCIA. La clave es la llave del paquete — entregarla antes de cobrar es
// perder el dinero. Por eso aquí no se confía en la interfaz: cada condición se
// vuelve a comprobar en el servidor antes de descifrar nada, y cada
// visualización queda registrada de forma imborrable (0049).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { decryptOrNull, encrypt } from "@/lib/crypto";
import { getMasterPermissions } from "@/lib/permissions-access";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { analyzeYapeVoucherFromEnv } from "@/lib/vision";
import { normalizePhone } from "@/lib/phone";
import {
  canRevealPickupKey,
  describeBlockers,
  paymentState,
  type PaymentSnapshot,
} from "@/lib/pickup-key";
import {
  describeDuplicate,
  findDuplicate,
  normalizeOperationNumber,
  type ExistingPayment,
} from "@/lib/yape-dedup";
import type { OrderMasterRow } from "@/lib/types";

const MASTER_PATH = "/dashboard/pedidos";
/** Los comprobantes llevan datos bancarios del cliente: bucket privado. */
const VOUCHER_BUCKET = "yape-vouchers";
/** Una captura de móvil no pesa más que esto; corta las subidas absurdas. */
const MAX_VOUCHER_BYTES = 6 * 1024 * 1024;

export interface PaymentActionState {
  error?: string;
  notice?: string;
  /** Cuando el registro se bloquea por duplicidad, qué se encontró. */
  duplicate?: { message: string; orderName: string | null; paymentId: string };
}

interface OrderContext {
  userId: string;
  storeId: string;
  row: OrderMasterRow;
}

async function authorizeOrder(orderId: string): Promise<OrderContext | null> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const { data } = await sb.from("order_master").select("*").eq("order_id", orderId).maybeSingle();
  if (!data) return null;
  const row = data as unknown as OrderMasterRow;
  return { userId: user.id, storeId: row.store_id, row };
}

let bucketReady = false;
async function ensureVoucherBucket(admin: ReturnType<typeof createAdminSupabase>): Promise<void> {
  if (bucketReady) return;
  await admin.storage.createBucket(VOUCHER_BUCKET, { public: false }).catch(() => {});
  await admin.storage.updateBucket(VOUCHER_BUCKET, { public: false }).catch(() => {});
  bucketReady = true;
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

export interface PaymentRow {
  id: string;
  order_id: string;
  kind: string;
  amount: number | null;
  operation_number: string | null;
  paid_at: string | null;
  payer_name: string | null;
  payer_phone: string | null;
  file_path: string | null;
  validation_status: string;
  registered_at: string;
  validated_at: string | null;
  notes: string | null;
  registered_by_name?: string | null;
  validated_by_name?: string | null;
}

export interface PickupKeyPanel {
  payments: PaymentRow[];
  paymentState: string;
  hasKey: boolean;
  canReveal: boolean;
  blockers: string;
  shares: { id: string; shared_at: string; channel: string; confirmed: boolean; note: string | null }[];
  views: { id: string; viewed_at: string; reason: string | null; override: boolean }[];
  /** Permisos del usuario actual, para que la interfaz no ofrezca lo imposible. */
  canRegister: boolean;
  canValidate: boolean;
  canViewKey: boolean;
  canOverride: boolean;
}

/** Estado completo del panel de pagos y clave. NUNCA devuelve la clave. */
export async function loadPaymentPanel(
  orderId: string,
): Promise<{ panel: PickupKeyPanel } | { error: string }> {
  const ctx = await authorizeOrder(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };
  const perms = await getMasterPermissions();
  const sb = await createServerSupabase();

  const [paymentsRes, keyRes, sharesRes, viewsRes] = await Promise.all([
    sb.from("order_payments").select("*").eq("order_id", orderId).order("registered_at"),
    sb.from("shalom_pickup_keys").select("order_id").eq("order_id", orderId).maybeSingle(),
    sb.from("pickup_key_shares").select("*").eq("order_id", orderId).order("shared_at", { ascending: false }),
    sb.from("pickup_key_views").select("id,viewed_at,reason,override").eq("order_id", orderId).order("viewed_at", { ascending: false }).limit(50),
  ]);

  const payments = (paymentsRes.data ?? []) as unknown as PaymentRow[];
  // `shalom_pickup_keys` no es legible por `authenticated` (0049, RLS sin
  // policy): la existencia de la clave se consulta con el service role, que es
  // lo único que se expone — nunca su contenido.
  const admin = createAdminSupabase();
  const { data: keyRow } = await admin
    .from("shalom_pickup_keys")
    .select("order_id")
    .eq("order_id", orderId)
    .maybeSingle();
  void keyRes;

  const snapshots: PaymentSnapshot[] = payments.map((p) => ({
    kind: p.kind,
    validation_status: p.validation_status,
    order_id: p.order_id,
  }));
  const verdict = canRevealPickupKey({
    orderId,
    generalStatus: ctx.row.general_status,
    pickupState: ctx.row.pickup_state,
    payments: snapshots,
    hasKey: Boolean(keyRow),
  });

  return {
    panel: {
      payments,
      paymentState: paymentState(snapshots),
      hasKey: Boolean(keyRow),
      canReveal: verdict.allowed,
      blockers: describeBlockers(verdict),
      shares: (sharesRes.data ?? []) as PickupKeyPanel["shares"],
      views: (viewsRes.data ?? []) as PickupKeyPanel["views"],
      canRegister: perms.can("shalom.register_payment"),
      canValidate: perms.can("shalom.validate_payment"),
      canViewKey: perms.can("shalom.view_pickup_key"),
      canOverride: perms.can("shalom.override_payment_validation"),
    },
  };
}

// ---------------------------------------------------------------------------
// Registro del comprobante
// ---------------------------------------------------------------------------

/**
 * URL firmada para subir el comprobante directamente al bucket privado. Igual
 * que en Leads (app/dashboard/leads/actions.ts): evita el límite de ~4,5 MB del
 * cuerpo de un Server Action y no expone el bucket.
 */
export async function createVoucherUpload(
  orderId: string,
  contentType: string,
  filename: string,
): Promise<{ path: string; token: string } | { error: string }> {
  const perms = await getMasterPermissions();
  if (!perms.can("shalom.register_payment")) return { error: "Tu rol no permite registrar pagos." };
  const ctx = await authorizeOrder(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };
  if (!contentType.startsWith("image/")) return { error: "El comprobante debe ser una imagen." };

  const admin = createAdminSupabase();
  await ensureVoucherBucket(admin);
  const ext = (filename.split(".").pop() ?? "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `${ctx.storeId}/${orderId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { data, error } = await admin.storage.from(VOUCHER_BUCKET).createSignedUploadUrl(path);
  if (error || !data) return { error: error?.message ?? "No se pudo preparar la subida." };
  return { path: data.path, token: data.token };
}

/**
 * Lee la imagen ya subida y le pide a Claude que confirme que es un comprobante
 * Yape real (lib/vision.ts, el mismo que ya usa la alerta de Leads). Nunca
 * lanza: si la visión no está disponible, el comprobante sigue su camino y lo
 * valida una persona.
 */
async function inspectVoucher(
  admin: ReturnType<typeof createAdminSupabase>,
  path: string | null,
): Promise<{ ok: boolean; isVoucher: boolean; payload: Record<string, unknown> }> {
  if (!path) return { ok: false, isVoucher: false, payload: {} };
  try {
    const { data, error } = await admin.storage.from(VOUCHER_BUCKET).download(path);
    if (error || !data) return { ok: false, isVoucher: false, payload: {} };
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes.byteLength > MAX_VOUCHER_BYTES) {
      return { ok: false, isVoucher: false, payload: { error: "imagen demasiado grande" } };
    }
    const base64 = Buffer.from(bytes).toString("base64");
    const result = await analyzeYapeVoucherFromEnv(base64, data.type);
    return {
      ok: result.ok,
      isVoucher: result.isVoucher,
      payload: { indicators: result.indicators, model: result.model, ok: result.ok },
    };
  } catch {
    return { ok: false, isVoucher: false, payload: {} };
  }
}

export interface RegisterPaymentInput {
  kind: "adelanto" | "diferencia";
  amount: number | null;
  operationNumber: string | null;
  paidAt: string | null;
  payerName: string | null;
  payerPhone: string | null;
  /** Ruta en el bucket, devuelta por createVoucherUpload. */
  path: string | null;
  /** sha256 del archivo, calculado en el navegador. */
  sha256: string | null;
  notes?: string | null;
}

/**
 * Registra un comprobante. Antes de insertar comprueba la duplicidad: si el
 * pago ya existe se BLOQUEA, se dice a qué pedido pertenece y qué datos
 * coinciden, y queda constancia de quién intentó volver a registrarlo.
 */
export async function registerPayment(
  orderId: string,
  input: RegisterPaymentInput,
): Promise<PaymentActionState> {
  const perms = await getMasterPermissions();
  if (!perms.can("shalom.register_payment")) return { error: "Tu rol no permite registrar pagos." };
  const ctx = await authorizeOrder(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };
  if (input.kind !== "adelanto" && input.kind !== "diferencia") {
    return { error: "Tipo de pago inválido." };
  }

  const admin = createAdminSupabase();
  const operation = normalizeOperationNumber(input.operationNumber);
  const payerPhone = normalizePhone(input.payerPhone);

  const candidate = {
    order_id: orderId,
    kind: input.kind,
    amount: input.amount,
    operation_number: operation,
    paid_at: input.paidAt,
    payer_name: input.payerName,
    payer_phone: payerPhone,
    file_sha256: input.sha256,
  };

  // Candidatos a duplicado: por nº de operación, por huella o por monto. La
  // consulta va por el service role A PROPÓSITO — un comprobante reutilizado en
  // la tienda de otro dueño debe detectarse igual, y RLS lo ocultaría.
  const existing: ExistingPayment[] = [];
  const seen = new Set<string>();
  const push = (rows: unknown) => {
    for (const r of (rows ?? []) as ExistingPayment[]) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        existing.push(r);
      }
    }
  };
  const COLUMNS =
    "id,order_id,kind,amount,operation_number,paid_at,payer_name,payer_phone,file_sha256,validation_status";
  if (operation) {
    const { data } = await admin.from("order_payments").select(COLUMNS).eq("operation_number", operation);
    push(data);
  }
  if (input.sha256) {
    const { data } = await admin.from("order_payments").select(COLUMNS).eq("file_sha256", input.sha256);
    push(data);
  }
  if (input.amount !== null) {
    const { data } = await admin.from("order_payments").select(COLUMNS).eq("amount", input.amount);
    push(data);
  }

  // Nombre del pedido en conflicto, para poder decirle al operador dónde está.
  const verdict = findDuplicate(candidate, existing);
  if (verdict.duplicate && verdict.conflict) {
    const { data: conflictOrder } = await admin
      .from("order_master")
      .select("order_name")
      .eq("order_id", verdict.conflict.order_id)
      .maybeSingle();
    const conflict = {
      ...verdict.conflict,
      order_name: (conflictOrder as { order_name: string | null } | null)?.order_name ?? null,
    };
    const message = describeDuplicate({ ...verdict, conflict });

    // Queda constancia del intento, aunque no se registre el pago.
    await admin.from("order_events").insert({
      store_id: ctx.storeId,
      order_id: orderId,
      kind: "payment",
      actor: ctx.userId,
      source: "manual",
      reason: "posible_duplicado",
      note: `Intento de registrar un comprobante ya usado. ${message}`,
      payload: { signals: verdict.signals, conflict_payment_id: verdict.conflict.id },
    });

    return {
      error: message,
      duplicate: {
        message,
        orderName: conflict.order_name,
        paymentId: verdict.conflict.id,
      },
    };
  }

  const vision = await inspectVoucher(admin, input.path);
  // Un comprobante que la visión no reconoce no se rechaza solo: se marca como
  // información incompleta para que una persona lo mire. La imagen por sí sola
  // nunca vale como pago validado (§"Estados de validación").
  const status = vision.ok && !vision.isVoucher ? "info_incompleta" : "pendiente_revision";

  const { error } = await admin.from("order_payments").insert({
    store_id: ctx.storeId,
    order_id: orderId,
    kind: input.kind,
    amount: input.amount,
    operation_number: operation,
    paid_at: input.paidAt,
    payer_name: input.payerName,
    payer_phone: payerPhone,
    file_path: input.path,
    file_sha256: input.sha256,
    validation_status: status,
    registered_by: ctx.userId,
    notes: input.notes ?? null,
    vision: vision.payload,
  });
  if (error) {
    // Los índices únicos de 0049 son la última línea: si dos operadores suben el
    // mismo comprobante a la vez, uno de los dos choca aquí.
    if ((error as { code?: string }).code === "23505") {
      return { error: "Ese comprobante ya está registrado en el sistema." };
    }
    return { error: error.message };
  }

  await admin.from("order_events").insert({
    store_id: ctx.storeId,
    order_id: orderId,
    kind: "payment",
    actor: ctx.userId,
    source: "manual",
    note: `Yape de ${input.kind} registrado${input.amount ? ` (S/ ${input.amount})` : ""}.`,
  });
  await recomputeOrderMasterSafe(admin, [orderId]);
  revalidatePath(MASTER_PATH);
  return {
    notice:
      status === "info_incompleta"
        ? "Comprobante cargado, pero la imagen no parece un Yape: queda para revisión."
        : "Comprobante cargado. Falta validarlo.",
  };
}

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

async function loadPayment(paymentId: string) {
  const admin = createAdminSupabase();
  const { data } = await admin
    .from("order_payments")
    .select("id,order_id,store_id,kind,validation_status")
    .eq("id", paymentId)
    .maybeSingle();
  return data as
    | { id: string; order_id: string; store_id: string; kind: string; validation_status: string }
    | null;
}

/** Marca un pago como validado. Es lo que habilita la clave, así que va aparte. */
export async function validatePayment(paymentId: string): Promise<PaymentActionState> {
  const perms = await getMasterPermissions();
  if (!perms.can("shalom.validate_payment")) return { error: "Tu rol no permite validar pagos." };
  const payment = await loadPayment(paymentId);
  if (!payment) return { error: "Pago no encontrado." };
  const ctx = await authorizeOrder(payment.order_id);
  if (!ctx) return { error: "Sin acceso a este pedido." };

  const admin = createAdminSupabase();
  const { error } = await admin
    .from("order_payments")
    .update({
      validation_status: "validado",
      validated_by: ctx.userId,
      validated_at: new Date().toISOString(),
    })
    .eq("id", paymentId);
  if (error) return { error: error.message };

  await admin.from("order_events").insert({
    store_id: ctx.storeId,
    order_id: payment.order_id,
    kind: "payment",
    actor: ctx.userId,
    source: "manual",
    previous_status: payment.validation_status,
    new_status: "validado",
    note: `Yape de ${payment.kind} validado.`,
  });
  await recomputeOrderMasterSafe(admin, [payment.order_id]);
  revalidatePath(MASTER_PATH);
  return { notice: "Pago validado." };
}

export async function rejectPayment(
  paymentId: string,
  reason: string,
): Promise<PaymentActionState> {
  const perms = await getMasterPermissions();
  if (!perms.can("shalom.validate_payment")) return { error: "Tu rol no permite validar pagos." };
  const motive = reason.trim();
  if (!motive) return { error: "Indica el motivo del rechazo." };
  const payment = await loadPayment(paymentId);
  if (!payment) return { error: "Pago no encontrado." };
  const ctx = await authorizeOrder(payment.order_id);
  if (!ctx) return { error: "Sin acceso a este pedido." };

  const admin = createAdminSupabase();
  // Rechazar NO borra el pago: se conserva con su historial, y su nº de
  // operación vuelve a quedar libre por si fue un error de carga. "El sistema
  // nunca deberá eliminar silenciosamente un pago validado."
  const { error } = await admin
    .from("order_payments")
    .update({
      validation_status: "rechazado",
      validated_by: ctx.userId,
      validated_at: new Date().toISOString(),
      notes: motive,
    })
    .eq("id", paymentId);
  if (error) return { error: error.message };

  await admin.from("order_events").insert({
    store_id: ctx.storeId,
    order_id: payment.order_id,
    kind: "payment",
    actor: ctx.userId,
    source: "manual",
    previous_status: payment.validation_status,
    new_status: "rechazado",
    reason: motive,
    note: `Yape de ${payment.kind} rechazado.`,
  });
  await recomputeOrderMasterSafe(admin, [payment.order_id]);
  revalidatePath(MASTER_PATH);
  return { notice: "Pago rechazado." };
}

// ---------------------------------------------------------------------------
// Clave de recojo
// ---------------------------------------------------------------------------

/** Registra o reemplaza la clave. Se guarda cifrada; nunca en texto plano. */
export async function setPickupKey(orderId: string, key: string): Promise<PaymentActionState> {
  const perms = await getMasterPermissions();
  if (!perms.can("shalom.view_pickup_key")) {
    return { error: "Solo un administrador puede registrar la clave de recojo." };
  }
  const value = key.trim();
  if (!value) return { error: "La clave está vacía." };
  const ctx = await authorizeOrder(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };

  const admin = createAdminSupabase();
  const { data: previous } = await admin
    .from("shalom_pickup_keys")
    .select("order_id")
    .eq("order_id", orderId)
    .maybeSingle();

  const { error } = await admin.from("shalom_pickup_keys").upsert(
    {
      order_id: orderId,
      store_id: ctx.storeId,
      key_enc: encrypt(value),
      created_by: ctx.userId,
      ...(previous ? { replaced_at: new Date().toISOString(), replaced_by: ctx.userId } : {}),
    },
    { onConflict: "order_id" },
  );
  if (error) return { error: error.message };

  await admin.from("order_events").insert({
    store_id: ctx.storeId,
    order_id: orderId,
    kind: "key_shared",
    actor: ctx.userId,
    source: "manual",
    note: previous ? "Clave de recojo reemplazada." : "Clave de recojo registrada.",
  });
  await recomputeOrderMasterSafe(admin, [orderId]);
  revalidatePath(MASTER_PATH);
  return { notice: previous ? "Clave reemplazada." : "Clave registrada." };
}

/**
 * Devuelve la clave en claro. Comprueba permiso y condiciones, y **escribe la
 * auditoría antes de devolverla**: si algo fallara después, el rastro ya está.
 *
 * Un administrador con `shalom.override_payment_validation` puede saltarse las
 * condiciones, pero solo con motivo obligatorio y quedando marcado como
 * excepción en el historial.
 */
export async function revealPickupKey(
  orderId: string,
  input: { reason?: string; override?: boolean } = {},
): Promise<{ key: string } | { error: string }> {
  const perms = await getMasterPermissions();
  if (!perms.can("shalom.view_pickup_key")) {
    return { error: "Tu rol no permite ver la clave de recojo." };
  }
  const ctx = await authorizeOrder(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };

  const admin = createAdminSupabase();
  const [{ data: keyRow }, { data: paymentRows }] = await Promise.all([
    admin.from("shalom_pickup_keys").select("key_enc").eq("order_id", orderId).maybeSingle(),
    admin.from("order_payments").select("kind,validation_status,order_id").eq("order_id", orderId),
  ]);

  const payments = (paymentRows ?? []) as PaymentSnapshot[];
  const verdict = canRevealPickupKey({
    orderId,
    generalStatus: ctx.row.general_status,
    pickupState: ctx.row.pickup_state,
    payments,
    hasKey: Boolean(keyRow),
  });

  const wantsOverride = Boolean(input.override);
  if (!verdict.allowed) {
    if (!wantsOverride) return { error: describeBlockers(verdict) };
    if (!perms.can("shalom.override_payment_validation")) {
      return { error: "Solo un administrador puede mostrar la clave sin las validaciones." };
    }
    if (!input.reason?.trim()) {
      return { error: "Una excepción exige motivo: quedará en el historial." };
    }
    if (!keyRow) return { error: "No hay clave registrada para este pedido." };
  }

  const key = decryptOrNull((keyRow as { key_enc: string } | null)?.key_enc ?? null);
  if (!key) return { error: "No se pudo descifrar la clave. Vuelve a registrarla." };

  // Auditoría ANTES de devolverla, con el estado de los pagos en ese momento:
  // sin esto no se puede responder "¿ya estaban ambos validados cuando la vio?".
  const h = await headers();
  await admin.from("pickup_key_views").insert({
    store_id: ctx.storeId,
    order_id: orderId,
    user_id: ctx.userId,
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
    reason: input.reason?.trim() || null,
    override: !verdict.allowed,
    payment_state: {
      state: paymentState(payments),
      payments: payments.map((p) => ({ kind: p.kind, status: p.validation_status })),
      blockers: verdict.blockers,
    },
  });
  await admin.from("order_events").insert({
    store_id: ctx.storeId,
    order_id: orderId,
    kind: "key_view",
    actor: ctx.userId,
    source: "manual",
    reason: input.reason?.trim() || null,
    note: verdict.allowed ? "Clave de recojo consultada." : "Clave consultada como EXCEPCIÓN.",
  });

  revalidatePath(MASTER_PATH);
  return { key };
}

/** Registra que la clave se le entregó al cliente y por qué canal. */
export async function sharePickupKey(
  orderId: string,
  input: { channel: string; note?: string | null; confirmed?: boolean },
): Promise<PaymentActionState> {
  const perms = await getMasterPermissions();
  if (!perms.can("shalom.view_pickup_key")) {
    return { error: "Tu rol no permite entregar la clave." };
  }
  const ctx = await authorizeOrder(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };

  const channel = ["whatsapp", "llamada", "mensaje", "otro"].includes(input.channel)
    ? input.channel
    : "otro";

  const admin = createAdminSupabase();
  const { error } = await admin.from("pickup_key_shares").insert({
    store_id: ctx.storeId,
    order_id: orderId,
    shared_by: ctx.userId,
    channel,
    confirmed: input.confirmed ?? true,
    note: input.note?.trim() || null,
  });
  if (error) return { error: error.message };

  await admin.from("order_events").insert({
    store_id: ctx.storeId,
    order_id: orderId,
    kind: "key_shared",
    actor: ctx.userId,
    source: "manual",
    note: `Clave entregada al cliente por ${channel}.`,
  });
  await recomputeOrderMasterSafe(admin, [orderId]);
  revalidatePath(MASTER_PATH);
  return { notice: "Entrega de la clave registrada." };
}

/**
 * Corrige un pago: cambia su estado o lo reasigna a otro pedido. Solo
 * administradores, con motivo obligatorio, y todo queda en el historial con el
 * valor anterior y el nuevo.
 */
export async function overridePaymentValidation(
  paymentId: string,
  input: { status?: string; targetOrderId?: string; reason: string },
): Promise<PaymentActionState> {
  const perms = await getMasterPermissions();
  if (!perms.can("shalom.override_payment_validation")) {
    return { error: "Solo un administrador puede corregir un pago." };
  }
  const reason = input.reason?.trim();
  if (!reason) return { error: "Una corrección exige motivo: quedará en el historial." };

  const payment = await loadPayment(paymentId);
  if (!payment) return { error: "Pago no encontrado." };
  const ctx = await authorizeOrder(input.targetOrderId ?? payment.order_id);
  if (!ctx) return { error: "Sin acceso a este pedido." };

  const admin = createAdminSupabase();
  const patch: Record<string, unknown> = { notes: reason };
  if (input.status) patch.validation_status = input.status;
  if (input.targetOrderId && input.targetOrderId !== payment.order_id) {
    patch.order_id = input.targetOrderId;
    patch.store_id = ctx.storeId;
  }

  const { error } = await admin.from("order_payments").update(patch).eq("id", paymentId);
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return {
        error:
          "Ese pedido ya tiene un pago de este tipo, o el nº de operación ya está en uso. Rechaza primero el que sobra.",
      };
    }
    return { error: error.message };
  }

  const affected = [...new Set([payment.order_id, input.targetOrderId].filter(Boolean))] as string[];
  for (const orderId of affected) {
    await admin.from("order_events").insert({
      store_id: ctx.storeId,
      order_id: orderId,
      kind: "payment",
      actor: ctx.userId,
      source: "manual",
      previous_status: payment.validation_status,
      new_status: input.status ?? payment.validation_status,
      reason,
      note: input.targetOrderId
        ? `Pago reasignado por un administrador (excepción).`
        : `Estado del pago corregido por un administrador (excepción).`,
    });
  }
  await recomputeOrderMasterSafe(admin, affected);
  revalidatePath(MASTER_PATH);
  return { notice: "Corrección registrada." };
}
