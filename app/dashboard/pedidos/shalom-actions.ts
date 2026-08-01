"use server";

// Creacion de pedidos por Agencia Shalom a traves de Aliclik.
//
// Esta ruta es distinta de Aliclik contraentrega: no cotiza por coordenadas ni
// elige courier. El equipo elige una agencia Shalom destino, registra el DNI y
// programa el despacho. Aliclik resuelve el almacen de origen por los EAN.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { decryptOrNull, encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";
import { getStoreCreds } from "@/lib/ingest";
import { getMasterPermissions } from "@/lib/permissions-access";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { getOrderMasterDetail } from "@/lib/orders-master-access";
import { normalizePhone } from "@/lib/phone";
import { categoryOf } from "@/lib/shipments";
import {
  createAgencyOrder,
  listAgencies,
  listPackageSizes,
  type AliclikAgency,
  type AliclikAgencyOrderInput,
  type AliclikClientOpts,
} from "@/lib/aliclik";
import { loadCatalogFor, resolveAliclikItems } from "@/lib/aliclik-catalog";
import { reconcileToOrderTotal } from "@/lib/aliclik-money";
import {
  generatePickupKey,
  resolveAgencyScheduleDate,
  splitCustomerName,
  validateAgencyDocument,
} from "@/lib/aliclik-agency";
import type { OrderMasterRow } from "@/lib/types";

const MASTER_PATH = "/dashboard/pedidos";
const MIN_ADVANCE = 30;

interface ShalomContext {
  userId: string;
  storeId: string;
  row: OrderMasterRow;
  client: AliclikClientOpts;
}

export interface ShalomAgencyOption {
  id: string;
  name: string;
  address: string;
  department: string | null;
  province: string | null;
  district: string | null;
}

export interface ShalomGuidePreview {
  ok: boolean;
  error?: string;
  warnings?: string[];
  orderName?: string | null;
  orderTotal?: number | null;
  receiverName?: string;
  receiverPhone?: string;
  agencies?: ShalomAgencyOption[];
  suggestedAgencyId?: string | null;
  packageSizes?: string[];
  scheduleDate?: string;
  scheduleMessage?: string | null;
  validatedAdvance?: number;
  requiredAdvance?: number;
  advanceReady?: boolean;
  writeBlocked?: string;
}

export interface CreateShalomGuideInput {
  agencyId: string;
  packageSize: string;
  scheduleDate: string;
  receiverName: string;
  receiverPhone: string;
  documentType: "DNI" | "CE";
  documentNumber: string;
}

export interface ShalomActionState {
  error?: string;
  notice?: string;
}

async function authorize(orderId: string): Promise<{ ctx?: ShalomContext; error?: string }> {
  const perms = await getMasterPermissions();
  if (!perms.can("aliclik.create_guide")) {
    return { error: "Tu rol no permite crear guias en Aliclik." };
  }

  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");

  const { data } = await sb.from("order_master").select("*").eq("order_id", orderId).maybeSingle();
  if (!data) return { error: "Sin acceso a este pedido." };
  const row = data as unknown as OrderMasterRow;

  const creds = await getStoreCreds(row.store_id);
  if (!creds?.aliclik_api_token) {
    return { error: "Esta tienda no tiene configurado el token de Aliclik." };
  }
  if (!creds.aliclik_enabled) {
    return { error: "La integracion con Aliclik esta desactivada para esta tienda." };
  }

  return {
    ctx: {
      userId: user.id,
      storeId: row.store_id,
      row,
      client: { apiToken: creds.aliclik_api_token },
    },
  };
}

function normalize(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function toAgencyOption(value: AliclikAgency): ShalomAgencyOption | null {
  const id = value.id == null ? "" : String(value.id).trim();
  const name = (value.name ?? "").trim();
  const address = (value.address ?? "").trim();
  if (!id || !name || !address) return null;
  return {
    id,
    name,
    address,
    department: value.department?.trim() || null,
    province: value.province?.trim() || null,
    district: value.district?.trim() || null,
  };
}

async function loadAgencies(ctx: ShalomContext): Promise<ShalomAgencyOption[]> {
  const admin = createAdminSupabase();
  const { data } = await admin
    .from("aliclik_agencies")
    .select("agency_id,name,address,department,province,district")
    .eq("store_id", ctx.storeId)
    .order("department")
    .order("province")
    .order("district")
    .order("name");

  const cached = (data ?? [])
    .map((row) =>
      toAgencyOption({
        id: row.agency_id,
        name: row.name,
        address: row.address,
        department: row.department,
        province: row.province,
        district: row.district,
      }),
    )
    .filter((row): row is ShalomAgencyOption => Boolean(row));
  if (cached.length) return cached;

  // El directorio esta cacheado localmente, pero una tienda recien conectada
  // puede abrir el formulario antes del primer cron. La lectura en vivo evita
  // bloquear esa primera guia; nunca escribe hacia Aliclik.
  const live = await listAgencies(ctx.client);
  return live.ok
    ? live.data.map(toAgencyOption).filter((row): row is ShalomAgencyOption => Boolean(row))
    : [];
}

async function loadSizes(ctx: ShalomContext): Promise<string[]> {
  const admin = createAdminSupabase();
  const { data } = await admin
    .from("aliclik_package_sizes")
    .select("title")
    .eq("store_id", ctx.storeId)
    .order("position");
  const cached = (data ?? []).map((row) => (row.title ?? "").trim()).filter(Boolean);
  if (cached.length) return cached;
  const live = await listPackageSizes(ctx.client);
  return live.ok ? live.data.map((row) => (row.title ?? "").trim()).filter(Boolean) : [];
}

function suggestAgency(row: OrderMasterRow, agencies: readonly ShalomAgencyOption[]): string | null {
  const district = normalize(row.district);
  const province = normalize(row.province);
  const region = normalize(row.region);
  const exactDistrict = district ? agencies.filter((a) => normalize(a.district) === district) : [];
  if (exactDistrict.length === 1) return exactDistrict[0]!.id;
  const exactProvince = province ? agencies.filter((a) => normalize(a.province) === province) : [];
  if (exactProvince.length === 1) return exactProvince[0]!.id;
  const exactRegion = region ? agencies.filter((a) => normalize(a.department) === region) : [];
  return exactRegion.length === 1 ? exactRegion[0]!.id : null;
}

async function validatedAdvance(orderId: string): Promise<number> {
  const admin = createAdminSupabase();
  const { data } = await admin
    .from("order_payments")
    .select("amount")
    .eq("order_id", orderId)
    .eq("kind", "adelanto")
    .eq("validation_status", "validado");
  return (data ?? []).reduce((sum, row) => sum + Math.max(0, Number(row.amount) || 0), 0);
}

async function resolveProducts(ctx: ShalomContext) {
  const admin = createAdminSupabase();
  const detail = await getOrderMasterDetail(ctx.row.order_id);
  if (!detail) return { error: "No se pudo cargar el detalle del pedido." } as const;
  const { skus, mapping } = await loadCatalogFor(ctx.storeId, admin);
  const resolved = resolveAliclikItems(
    detail.lineItems.map((line) => ({
      title: line.title,
      sku: line.sku,
      quantity: line.quantity,
      price: line.price,
    })),
    mapping,
    skus,
    { modality: "agency" },
  );
  if (!resolved.ok) {
    const blocker = resolved.blocker;
    return {
      error: blocker.offenders.length
        ? `${blocker.message}\n- ${blocker.offenders.join("\n- ")}`
        : blocker.message,
    } as const;
  }
  const money = reconcileToOrderTotal(resolved.items, ctx.row.order_total);
  if (!money) return { error: "El pedido no tiene un total valido para crear la guia." } as const;
  return { resolved, items: money.items, total: money.total } as const;
}

export async function previewShalomGuide(orderId: string): Promise<ShalomGuidePreview> {
  const { ctx, error } = await authorize(orderId);
  if (!ctx) return { ok: false, error };

  const productResult = await resolveProducts(ctx);
  if ("error" in productResult) return { ok: false, error: productResult.error };

  const [agencies, packageSizes, advance] = await Promise.all([
    loadAgencies(ctx),
    loadSizes(ctx),
    validatedAdvance(orderId),
  ]);
  if (!agencies.length) {
    return { ok: false, error: "No se pudo cargar el directorio de agencias Shalom. Reintenta en unos minutos." };
  }
  if (!packageSizes.length) {
    return { ok: false, error: "No se pudo cargar el catalogo de tamanos de paquete de Shalom." };
  }

  const schedule = resolveAgencyScheduleDate({
    formatTimeAgency: productResult.resolved.formatTimeAgency,
  });
  const environmentBlock = env.aliclikWriteEnabled()
    ? null
    : "La escritura hacia Aliclik esta desactivada en este entorno.";

  return {
    ok: true,
    warnings: productResult.resolved.warnings,
    orderName: ctx.row.order_name,
    orderTotal: ctx.row.order_total,
    receiverName: ctx.row.customer_name?.trim() || "",
    receiverPhone: ctx.row.customer_phone?.trim() || "",
    agencies,
    suggestedAgencyId: suggestAgency(ctx.row, agencies),
    packageSizes,
    scheduleDate: schedule.date,
    scheduleMessage: schedule.message,
    validatedAdvance: advance,
    requiredAdvance: MIN_ADVANCE,
    advanceReady: advance >= MIN_ADVANCE,
    writeBlocked: environmentBlock ?? undefined,
  };
}

async function loadOrCreatePickupKey(ctx: ShalomContext): Promise<{ key?: string; error?: string }> {
  const admin = createAdminSupabase();
  const { data: existing } = await admin
    .from("shalom_pickup_keys")
    .select("key_enc")
    .eq("order_id", ctx.row.order_id)
    .maybeSingle();
  if (existing?.key_enc) {
    const key = decryptOrNull(existing.key_enc);
    return key ? { key } : { error: "La clave de recojo guardada no se pudo descifrar." };
  }

  const generated = generatePickupKey();
  const { error } = await admin.from("shalom_pickup_keys").insert({
    order_id: ctx.row.order_id,
    store_id: ctx.storeId,
    key_enc: encrypt(generated),
    created_by: ctx.userId,
  });
  if (!error) return { key: generated };

  // Dos personas pudieron pulsar a la vez. La PK deja una sola clave; quien
  // perdio la carrera vuelve a leerla en vez de inventar una segunda.
  if (error.code === "23505") {
    const { data: winner } = await admin
      .from("shalom_pickup_keys")
      .select("key_enc")
      .eq("order_id", ctx.row.order_id)
      .maybeSingle();
    const key = decryptOrNull(winner?.key_enc ?? null);
    return key ? { key } : { error: "No se pudo recuperar la clave de recojo existente." };
  }
  return { error: `No se pudo guardar la clave de recojo: ${error.message}` };
}

export async function createShalomGuide(
  orderId: string,
  input: CreateShalomGuideInput,
): Promise<ShalomActionState> {
  if (!env.aliclikWriteEnabled()) {
    return { error: "La escritura hacia Aliclik esta desactivada en este entorno." };
  }
  const { ctx, error } = await authorize(orderId);
  if (!ctx) return { error };

  const admin = createAdminSupabase();
  const { data: live } = await admin
    .from("shipments")
    .select("guide_code,delivery_status")
    .eq("order_id", orderId)
    .not("delivery_status", "in", "(anulado,transferido)")
    .limit(1);
  if (live?.[0]) return { error: `Este pedido ya tiene una guia activa (${live[0].guide_code}).` };

  const advance = await validatedAdvance(orderId);
  if (advance < MIN_ADVANCE) {
    return {
      error: `Para generar la guia Shalom primero debe existir un adelanto validado de S/ ${MIN_ADVANCE.toFixed(2)}. Validado ahora: S/ ${advance.toFixed(2)}.`,
    };
  }

  const productResult = await resolveProducts(ctx);
  if ("error" in productResult) return { error: productResult.error };

  const [agencies, packageSizes] = await Promise.all([loadAgencies(ctx), loadSizes(ctx)]);
  const agency = agencies.find((row) => row.id === input.agencyId);
  if (!agency) return { error: "La agencia elegida ya no esta disponible. Vuelve a abrir el formulario." };
  if (!packageSizes.includes(input.packageSize)) {
    return { error: "El tamano de paquete elegido ya no esta disponible." };
  }

  const schedule = resolveAgencyScheduleDate({
    requested: input.scheduleDate,
    formatTimeAgency: productResult.resolved.formatTimeAgency,
  });
  const phone = normalizePhone(input.receiverPhone);
  if (!phone) return { error: "Ingresa un numero de celular valido para quien recogera el pedido." };
  const documentValidation = validateAgencyDocument(input.documentType, input.documentNumber);
  if (!documentValidation.ok) return { error: documentValidation.message };
  const document = documentValidation.normalized;
  if (!input.receiverName.trim()) return { error: "Ingresa el nombre de quien recogera el pedido." };

  const keyResult = await loadOrCreatePickupKey(ctx);
  if (!keyResult.key) return { error: keyResult.error };
  const names = splitCustomerName(input.receiverName);
  const paymentType = advance >= (ctx.row.order_total ?? Number.POSITIVE_INFINITY) ? "C" : "P";
  const body: AliclikAgencyOrderInput = {
    paymentType,
    customer: {
      ...names,
      senderPhone: phone.replace(/^\+/, ""),
      senderDocumentType: input.documentType,
      senderContact: document,
    },
    shipping: {
      agencyName: "SHALOM",
      agencyAddress: agency.address,
      keyCode: keyResult.key,
      merchandiseShalom: input.packageSize,
      scheduleDate: schedule.date,
      shalomAgency: agency.name,
      shalomAgencyId: agency.id,
    },
    products: productResult.items.map((item) => ({
      ean: item.ean,
      quantity: item.quantity,
      price: item.price,
    })),
  };

  // La intencion se registra antes del POST para impedir duplicados. La clave
  // se redacta: su unica copia legible debe seguir cifrada en su tabla propia.
  const requestForAudit = {
    ...body,
    shipping: { ...body.shipping, keyCode: "[CIFRADA]" },
  };
  const { data: intent, error: intentError } = await admin
    .from("aliclik_order_requests")
    .insert({
      store_id: ctx.storeId,
      order_id: orderId,
      modality: "agency",
      status: "pending",
      request: requestForAudit as unknown as Record<string, unknown>,
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (intentError) {
    return {
      error: intentError.code === "23505"
        ? "Ya hay una creacion en curso o completada para este pedido."
        : `No se pudo registrar la intencion: ${intentError.message}`,
    };
  }

  const result = await createAgencyOrder(ctx.client, body);
  if (!result.ok && result.timedOut) {
    await admin.from("aliclik_order_requests").update({ error: result.error }).eq("id", intent.id);
    return {
      error: "Aliclik no respondio a tiempo. El pedido puede haberse creado: no reintentes hasta verificarlo.",
    };
  }
  if (!result.ok) {
    await admin
      .from("aliclik_order_requests")
      .update({
        status: "failed",
        error: result.error,
        http_status: result.status,
        completed_at: new Date().toISOString(),
      })
      .eq("id", intent.id);
    return { error: `Aliclik rechazo la guia Shalom: ${result.error}` };
  }

  const orderNumber = (result.data.orderNumber ?? "").trim();
  if (!orderNumber) {
    await admin
      .from("aliclik_order_requests")
      .update({
        status: "failed",
        error: "Aliclik respondio sin orderNumber.",
        response: result.data as unknown as Record<string, unknown>,
        completed_at: new Date().toISOString(),
      })
      .eq("id", intent.id);
    return { error: "Aliclik acepto el pedido, pero no devolvio el numero de orden. Revisalo en su panel." };
  }

  await admin
    .from("aliclik_order_requests")
    .update({
      status: "sent",
      order_number: orderNumber,
      response: result.data as unknown as Record<string, unknown>,
      http_status: 201,
      completed_at: new Date().toISOString(),
    })
    .eq("id", intent.id);

  // Desde este instante el pedido ya es de Agencia, aunque el registro local
  // de la salida fallara. Esto mantiene visible el panel de pagos y la clave
  // cifrada para poder recuperar el caso sin perder el paquete creado afuera.
  await admin.from("orders").update({ shipping_mode: "agency" }).eq("id", orderId);

  const now = new Date().toISOString();
  const { error: shipmentError } = await admin.from("shipments").insert({
    store_id: ctx.storeId,
    courier: "shalom",
    guide_code: orderNumber,
    external_order_number: orderNumber,
    delivery_status: "pendiente",
    status_category: categoryOf("pendiente"),
    order_id: orderId,
    matched: true,
    match_method: "manual",
    order_name: ctx.row.order_name,
    customer_name: input.receiverName.trim(),
    customer_phone: phone,
    district: agency.district,
    province: agency.province,
    region: agency.department,
    delivery_address: agency.address,
    created_via: "aliclik_agency_api",
    source: "aliclik",
    pickup_state: "enviado_a_agencia",
    agency_branch: `${agency.name} - ${agency.address}`,
    assigned_at: now,
  });
  if (shipmentError) {
    await recomputeOrderMasterSafe(admin, [orderId]);
    revalidatePath(MASTER_PATH);
    return {
      error: `La guia Shalom se creo en Aliclik (${orderNumber}), pero no se pudo guardar en Kapta: ${shipmentError.message}`,
    };
  }

  await admin.from("order_events").insert({
    store_id: ctx.storeId,
    order_id: orderId,
    kind: "guide_registered",
    occurred_at: now,
    actor: ctx.userId,
    source: "aliclik",
    courier: "shalom",
    guide_code: orderNumber,
    note: `Guia Shalom creada para recojo en ${agency.name}.`,
    payload: {
      modality: "agency",
      agencyId: agency.id,
      agencyName: agency.name,
      agencyAddress: agency.address,
      packageSize: input.packageSize,
      scheduleDate: schedule.date,
      paymentType,
      validatedAdvance: advance,
    },
  });

  await recomputeOrderMasterSafe(admin, [orderId]);
  revalidatePath(MASTER_PATH);
  return {
    notice: `Guia Shalom creada: ${orderNumber}. Agencia ${agency.name}; despacho programado ${schedule.date}.`,
  };
}
