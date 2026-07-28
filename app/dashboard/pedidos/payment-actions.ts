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
import { analyzeYapeVoucherFromEnv, extractYapeVoucherFromEnv } from "@/lib/vision";
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
interface VoucherInspection {
  ok: boolean;
  isVoucher: boolean;
  /** Datos leídos de la imagen, para rellenar lo que el operador dejó en blanco. */
  fields: {
    operationNumber: string | null;
    amount: number | null;
    paidAt: string | null;
    payerName: string | null;
  };
  payload: Record<string, unknown>;
}

const EMPTY_INSPECTION: VoucherInspection = {
  ok: false,
  isVoucher: false,
  fields: { operationNumber: null, amount: null, paidAt: null, payerName: null },
  payload: {},
};

async function inspectVoucher(
  admin: ReturnType<typeof createAdminSupabase>,
  path: string | null,
  storeId: string,
): Promise<VoucherInspection> {
  if (!path) return EMPTY_INSPECTION;
  // Clave de visión de ESTA tienda (0052): el gasto cae en su propia cuenta de
  // Anthropic. Si no tiene clave propia se usa la del entorno.
  const { data: store } = await admin
    .from("stores")
    .select("anthropic_api_key_enc,anthropic_model")
    .eq("id", storeId)
    .maybeSingle();
  const storeCreds = {
    anthropicApiKey: decryptOrNull(
      (store as { anthropic_api_key_enc?: string | null } | null)?.anthropic_api_key_enc ?? null,
    ),
    anthropicModel: (store as { anthropic_model?: string | null } | null)?.anthropic_model ?? null,
  };
  try {
    const { data, error } = await admin.storage.from(VOUCHER_BUCKET).download(path);
    if (error || !data) return EMPTY_INSPECTION;
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes.byteLength > MAX_VOUCHER_BYTES) {
      return { ...EMPTY_INSPECTION, payload: { error: "imagen demasiado grande" } };
    }
    const base64 = Buffer.from(bytes).toString("base64");
    // Dos preguntas distintas a la misma imagen: "¿es un comprobante?" y "¿qué
    // dice?". La segunda es la que evita teclear el nº de operación a mano —y es
    // el nº de operación lo que hace posible detectar el mismo Yape recortado.
    const [verdict, extracted] = await Promise.all([
      analyzeYapeVoucherFromEnv(base64, data.type, storeCreds),
      extractYapeVoucherFromEnv(base64, data.type, storeCreds),
    ]);
    return {
      ok: verdict.ok,
      isVoucher: verdict.isVoucher,
      fields: {
        operationNumber: extracted.operationNumber,
        amount: extracted.amount,
        paidAt: extracted.paidAt,
        payerName: extracted.payerName,
      },
      payload: {
        indicators: verdict.indicators,
        model: verdict.model,
        ok: verdict.ok,
        extracted: {
          operation_number: extracted.operationNumber,
          amount: extracted.amount,
          paid_at: extracted.paidAt,
          payer_name: extracted.payerName,
          recipient_name: extracted.recipientName,
          ok: extracted.ok,
        },
      },
    };
  } catch {
    return EMPTY_INSPECTION;
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
  // Se lee la imagen ANTES de buscar duplicados: si el operador no tecleó el nº
  // de operación pero la imagen lo trae, ese dato entra en la comprobación. Sin
  // él, un mismo Yape recortado podría colarse en dos pedidos.
  const vision = await inspectVoucher(admin, input.path, ctx.storeId);
  const operation =
    normalizeOperationNumber(input.operationNumber) ??
    normalizeOperationNumber(vision.fields.operationNumber);
  const amount = input.amount ?? vision.fields.amount;
  const paidAt = input.paidAt ?? vision.fields.paidAt;
  const payerName = input.payerName ?? vision.fields.payerName;
  const payerPhone = normalizePhone(input.payerPhone);

  const candidate = {
    order_id: orderId,
    kind: input.kind,
    amount,
    operation_number: operation,
    paid_at: paidAt,
    payer_name: payerName,
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
  if (amount !== null && amount !== undefined) {
    const { data } = await admin.from("order_payments").select(COLUMNS).eq("amount", amount);
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

  // Un comprobante sin nº de operación NO se puede validar (ver validatePayment):
  // es el único dato que garantiza que ese Yape no se reutilice en otro pedido.
  // Entra como "información incompleta" para que alguien lo complete a mano.
  // Tampoco se rechaza solo un comprobante que la visión no reconoce: la imagen
  // por sí sola nunca vale como pago validado (§"Estados de validación").
  const status = !operation || (vision.ok && !vision.isVoucher)
    ? "info_incompleta"
    : "pendiente_revision";

  const { error } = await admin.from("order_payments").insert({
    store_id: ctx.storeId,
    order_id: orderId,
    kind: input.kind,
    amount,
    operation_number: operation,
    paid_at: paidAt,
    payer_name: payerName,
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

  // `vision.ok === false` NO significa "la imagen no se entiende": significa que
  // el lector no llegó a correr — clave de Anthropic ausente o inválida, modelo
  // mal escrito, o la API caída. Culpar a la captura en ese caso manda al equipo
  // a perseguir al cliente por una foto que estaba perfecta.
  if (!vision.ok) {
    return {
      notice:
        "Comprobante cargado, pero NO se pudo leer la imagen automáticamente: " +
        "revisa la API key de Anthropic en Ajustes de la tienda. " +
        "Mientras tanto, escribe el nº de operación y el monto a mano.",
    };
  }
  if (!operation) {
    return {
      notice:
        "Comprobante cargado, pero SIN nº de operación: no se puede validar así. " +
        "Si la captura está recortada, pide al cliente el comprobante completo o " +
        "escribe el nº de operación a mano en el pago.",
    };
  }
  if (status === "info_incompleta") {
    return {
      notice: "Comprobante cargado, pero la imagen no parece un Yape: queda para revisión.",
    };
  }
  const autofilled = [
    !input.operationNumber && vision.fields.operationNumber && "nº de operación",
    input.amount === null && vision.fields.amount !== null && "monto",
    !input.paidAt && vision.fields.paidAt && "fecha y hora",
  ].filter(Boolean);
  return {
    notice: autofilled.length
      ? `Comprobante cargado (se leyó de la imagen: ${autofilled.join(", ")}). Falta validarlo.`
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
    .select("id,order_id,store_id,kind,validation_status,operation_number")
    .eq("id", paymentId)
    .maybeSingle();
  return data as
    | {
        id: string;
        order_id: string;
        store_id: string;
        kind: string;
        validation_status: string;
        operation_number: string | null;
      }
    | null;
}

/** Marca un pago como validado. Es lo que habilita la clave, así que va aparte. */
export async function validatePayment(paymentId: string): Promise<PaymentActionState> {
  const perms = await getMasterPermissions();
  if (!perms.can("shalom.validate_payment")) return { error: "Tu rol no permite validar pagos." };
  const payment = await loadPayment(paymentId);
  if (!payment) return { error: "Pago no encontrado." };
  // Sin nº de operación no hay forma de garantizar que este mismo Yape no se
  // use en otro pedido: el índice único no puede actuar sobre un nulo. Es la
  // condición que cierra el hueco de la captura recortada.
  if (!payment.operation_number) {
    return {
      error:
        "Este pago no tiene nº de operación, así que no se puede validar. " +
        "Complétalo a mano (o pide el comprobante completo si la captura está recortada) " +
        "con «Corregir pago».",
    };
  }
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
 * Completa los datos que faltaban en un comprobante — típicamente el nº de
 * operación cuando la captura llegó recortada o la visión no lo pudo leer.
 *
 * NO es una excepción de administrador: es trabajo normal del equipo, así que
 * basta el permiso de registrar pagos. Lo que sí hace es volver a comprobar la
 * duplicidad con el dato nuevo, porque un nº de operación recién escrito puede
 * revelar que ese Yape ya se usó en otro pedido.
 */
export async function completePaymentData(
  paymentId: string,
  input: {
    operationNumber?: string | null;
    amount?: number | null;
    paidAt?: string | null;
    payerName?: string | null;
    payerPhone?: string | null;
  },
): Promise<PaymentActionState> {
  const perms = await getMasterPermissions();
  if (!perms.can("shalom.register_payment")) {
    return { error: "Tu rol no permite editar pagos." };
  }
  const payment = await loadPayment(paymentId);
  if (!payment) return { error: "Pago no encontrado." };
  if (payment.validation_status === "validado" && !perms.can("shalom.override_payment_validation")) {
    return { error: "Este pago ya está validado; solo un administrador puede corregirlo." };
  }
  const ctx = await authorizeOrder(payment.order_id);
  if (!ctx) return { error: "Sin acceso a este pedido." };

  const admin = createAdminSupabase();
  const operation = normalizeOperationNumber(input.operationNumber);

  // El nº de operación es global: antes de escribirlo hay que asegurarse de que
  // no pertenece ya a otro pago.
  if (operation) {
    const { data: clash } = await admin
      .from("order_payments")
      .select("id,order_id,kind,validation_status")
      .eq("operation_number", operation)
      .neq("id", paymentId);
    const live = ((clash ?? []) as { id: string; order_id: string; kind: string; validation_status: string }[])
      .filter((c) => c.validation_status !== "rechazado");
    if (live.length) {
      const other = live[0]!;
      const { data: otherOrder } = await admin
        .from("order_master")
        .select("order_name")
        .eq("order_id", other.order_id)
        .maybeSingle();
      const where =
        other.order_id === payment.order_id
          ? "este mismo pedido"
          : ((otherOrder as { order_name: string | null } | null)?.order_name ?? "otro pedido");
      await admin.from("order_events").insert({
        store_id: ctx.storeId,
        order_id: payment.order_id,
        kind: "payment",
        actor: ctx.userId,
        source: "manual",
        reason: "posible_duplicado",
        note: `Intento de asignar el nº de operación ${operation}, ya usado como ${other.kind} en ${where}.`,
      });
      return {
        error: `Ese nº de operación ya está registrado como ${other.kind} en ${where}.`,
        duplicate: { message: `Ya usado en ${where}.`, orderName: where, paymentId: other.id },
      };
    }
  }

  const patch: Record<string, unknown> = {};
  if (input.operationNumber !== undefined) patch.operation_number = operation;
  if (input.amount !== undefined) patch.amount = input.amount;
  if (input.paidAt !== undefined) patch.paid_at = input.paidAt;
  if (input.payerName !== undefined) patch.payer_name = input.payerName?.trim() || null;
  if (input.payerPhone !== undefined) patch.payer_phone = normalizePhone(input.payerPhone);
  if (!Object.keys(patch).length) return { error: "No hay nada que cambiar." };

  // Completar el nº de operación desbloquea la validación: el pago vuelve a la
  // cola normal en vez de quedarse en "información incompleta".
  if (operation && payment.validation_status === "info_incompleta") {
    patch.validation_status = "pendiente_revision";
  }

  const { error } = await admin.from("order_payments").update(patch).eq("id", paymentId);
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return { error: "Ese nº de operación ya está en uso." };
    }
    return { error: error.message };
  }

  await admin.from("order_events").insert({
    store_id: ctx.storeId,
    order_id: payment.order_id,
    kind: "payment",
    actor: ctx.userId,
    source: "manual",
    note: `Datos del ${payment.kind} completados a mano${operation ? ` (op. ${operation})` : ""}.`,
  });
  await recomputeOrderMasterSafe(admin, [payment.order_id]);
  revalidatePath(MASTER_PATH);
  return {
    notice: operation
      ? "Datos completados. El pago ya se puede validar."
      : "Datos actualizados.",
  };
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
