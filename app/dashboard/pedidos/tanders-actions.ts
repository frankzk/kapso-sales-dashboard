"use server";

// Crear una guía Tanders desde el Master de Pedidos.
//
// A diferencia de los demás couriers, Tanders no entra por reporte: se le crea
// el pedido por API y devuelve el código de guía. La guía nace `pendiente` (así
// la crea Tanders: "Pendiente") y desde ahí sigue el mismo circuito que
// cualquier otra — cola de llamadas, estados, Master.
//
// El punto del mapa es obligatorio para Tanders y NO se resuelve solo: lo
// confirma el operador. Ver lib/geo-link.ts.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { getMasterPermissions } from "@/lib/permissions-access";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { parseGeoLink } from "@/lib/geo-link";
import { extractLabelUrl, TandersClient } from "@/lib/tanders/client";
import {
  buildTandersPayload,
  defaultCollectionAmount,
  suggestedDestination,
} from "@/lib/tanders/draft";
import { TandersApiError } from "@/lib/tanders/types";
import type { OrderMasterRow } from "@/lib/types";

const MASTER_PATH = "/dashboard/pedidos";

/** Guías que ya cubren el pedido: crear otra encima duplica el despacho. */
const ACTIVE_STATUSES = new Set(["pendiente", "en_ruta", "por_preparar"]);

export interface TandersDraftView {
  orderId: string;
  orderName: string | null;
  /** false → la tienda todavía no cargó usuario/contraseña ni el origen. */
  configured: boolean;
  originAddress: string | null;
  destination: string;
  latitude: number | null;
  longitude: number | null;
  /** "manual" | "courier" | … — de dónde salió el punto que se está mostrando. */
  geoSource: string | null;
  recipientName: string | null;
  recipientPhone: string | null;
  collectionAmount: number;
  note: string;
  /** Motivos para NO crear la guía todavía (guía activa, pedido cerrado…). */
  blockers: string[];
  /** Cosas que el operador debería mirar antes de confirmar. */
  warnings: string[];
}

interface StoreTanders {
  tanders_email: string | null;
  tanders_password_enc: string | null;
  tanders_origin_address: string | null;
  tanders_origin_lat: number | null;
  tanders_origin_lng: number | null;
}

async function authorize(
  orderId: string,
): Promise<{ userId: string; row: OrderMasterRow } | null> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  // RLS: un pedido de otra tienda simplemente no aparece.
  const { data } = await sb.from("order_master").select("*").eq("order_id", orderId).maybeSingle();
  if (!data) return null;
  return { userId: user.id, row: data as unknown as OrderMasterRow };
}

async function loadStoreTanders(
  admin: ReturnType<typeof createAdminSupabase>,
  storeId: string,
): Promise<StoreTanders | null> {
  const { data } = await admin
    .from("stores")
    .select(
      "tanders_email,tanders_password_enc,tanders_origin_address,tanders_origin_lat,tanders_origin_lng",
    )
    .eq("id", storeId)
    .maybeSingle();
  return (data as StoreTanders | null) ?? null;
}

/** Guías vivas del pedido, para no despachar dos veces lo mismo. */
async function activeGuides(
  admin: ReturnType<typeof createAdminSupabase>,
  orderId: string,
): Promise<{ courier: string; guide_code: string; delivery_status: string }[]> {
  const { data } = await admin
    .from("shipments")
    .select("courier,guide_code,delivery_status")
    .eq("order_id", orderId);
  const rows = (data as { courier: string; guide_code: string; delivery_status: string }[]) ?? [];
  return rows.filter((g) => ACTIVE_STATUSES.has(g.delivery_status));
}

/**
 * Todo lo que necesita el modal, ya resuelto en el servidor: qué se va a
 * despachar, a dónde, por cuánto, y qué debería frenar al operador.
 */
export async function loadTandersDraft(
  orderId: string,
): Promise<{ draft: TandersDraftView } | { error: string }> {
  const ctx = await authorize(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };
  const { row } = ctx;

  const admin = createAdminSupabase();
  const store = await loadStoreTanders(admin, row.store_id);
  const configured = Boolean(
    store?.tanders_email &&
      store?.tanders_password_enc &&
      store?.tanders_origin_address &&
      store?.tanders_origin_lat != null &&
      store?.tanders_origin_lng != null,
  );

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!configured) {
    blockers.push(
      "Esta tienda no tiene Tanders configurado. Carga el usuario, la contraseña y el almacén de origen en Ajustes → Tienda.",
    );
  }

  for (const g of await activeGuides(admin, orderId)) {
    blockers.push(
      `El pedido ya tiene una guía activa: ${g.guide_code} (${g.courier}, ${g.delivery_status}). Anúlala antes de crear otra.`,
    );
  }

  if (["entregado", "devuelto", "anulado"].includes(row.general_status)) {
    blockers.push(`El pedido está ${row.general_status.replace("_", " ")}.`);
  }

  // El punto no se inventa: si no hay, el operador lo pega. Ver lib/geo-link.ts.
  if (row.latitude == null || row.longitude == null) {
    warnings.push(
      "Este pedido no tiene punto en el mapa. Búscalo en Google Maps y pega el enlace: Tanders no acepta solo la dirección.",
    );
  } else if (row.geo_source !== "manual") {
    warnings.push(
      `El punto viene de ${row.geo_source ?? "otra fuente"} y no fue confirmado a mano. Verifícalo antes de crear la guía.`,
    );
  }

  if (row.payment_state === "pago_completo") {
    warnings.push("El pedido ya está pagado: el monto a cobrar va en 0.");
  }

  return {
    draft: {
      orderId,
      orderName: row.order_name,
      configured,
      originAddress: store?.tanders_origin_address ?? null,
      destination: suggestedDestination(row),
      latitude: row.latitude,
      longitude: row.longitude,
      geoSource: row.geo_source,
      recipientName: row.customer_name,
      recipientPhone: row.customer_phone,
      collectionAmount: defaultCollectionAmount({
        paymentState: row.payment_state,
        orderTotal: row.order_total,
      }),
      note: row.reference ?? "",
      blockers,
      warnings,
    },
  };
}

export interface CreateTandersInput {
  destination: string;
  /** Enlace de Google Maps o "lat, lng". Gana sobre el punto guardado. */
  mapLink?: string;
  recipientName: string;
  recipientPhone: string;
  collectionAmount: number;
  note?: string;
}

export async function createTandersGuide(
  orderId: string,
  input: CreateTandersInput,
): Promise<{ error?: string; notice?: string; guideCode?: string; labelUrl?: string }> {
  const perms = await getMasterPermissions();
  if (!perms.can("master.edit")) return { error: "Tu rol no permite crear guías." };

  const ctx = await authorize(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };
  const { row, userId } = ctx;

  const admin = createAdminSupabase();

  // Se revalida acá y no solo en el modal: entre que se abrió y se confirmó,
  // otro operador pudo haber creado una guía para el mismo pedido.
  const [active] = await activeGuides(admin, orderId);
  if (active) {
    return { error: `El pedido ya tiene una guía activa: ${active.guide_code} (${active.courier}).` };
  }

  const store = await loadStoreTanders(admin, row.store_id);
  if (!store?.tanders_email || !store.tanders_password_enc) {
    return { error: "Esta tienda no tiene credenciales de Tanders configuradas." };
  }

  // El punto: lo que pegó el operador manda sobre lo guardado.
  let lat = row.latitude;
  let lng = row.longitude;
  if (input.mapLink?.trim()) {
    const parsed = parseGeoLink(input.mapLink);
    if (!parsed.ok) return { error: parsed.error };
    lat = parsed.point.lat;
    lng = parsed.point.lng;
  }

  const built = buildTandersPayload({
    origin: {
      address: store.tanders_origin_address,
      lat: store.tanders_origin_lat,
      lng: store.tanders_origin_lng,
    },
    destination: input.destination,
    destinationLat: lat,
    destinationLng: lng,
    recipientName: input.recipientName,
    recipientPhone: input.recipientPhone,
    collectionAmount: input.collectionAmount,
    note: input.note,
  });
  if (!built.ok) return { error: built.errors.join(" ") };

  let password: string;
  try {
    password = decrypt(store.tanders_password_enc);
  } catch {
    return { error: "No se pudo descifrar la contraseña de Tanders. Vuelve a cargarla en Ajustes." };
  }

  const client = new TandersClient({ email: store.tanders_email, password });

  let order;
  try {
    order = await client.createOrder(built.payload);
  } catch (err) {
    if (err instanceof TandersApiError) {
      // 402/403 con saldo insuficiente es el caso esperado según la operación:
      // Tanders no deja registrar y no devuelve guía. Se dice tal cual en vez de
      // dejar al operador creyendo que se creó.
      const hint =
        err.status === 401
          ? " Revisa el usuario y la contraseña en Ajustes → Tienda."
          : err.status === 402 || err.status === 403
            ? " Puede ser saldo insuficiente en la billetera de Tanders o el cupo del día agotado."
            : "";
      return { error: `Tanders rechazó la guía (${err.status}): ${err.message}.${hint}` };
    }
    // Sin respuesta no se sabe si la guía existe: se manda a verificar a mano
    // antes que reintentar y despachar dos veces el mismo paquete.
    return {
      error:
        "No se pudo contactar a Tanders. Revisa en tanders.app si el pedido llegó a crearse ANTES de reintentar.",
    };
  }

  const guideCode = String(order?.id ?? "").trim();
  if (!guideCode) {
    return {
      error:
        "Tanders respondió sin id de pedido. Revisa en tanders.app si la guía se creó antes de reintentar.",
    };
  }
  const labelUrl = extractLabelUrl(order);

  const insertRow = {
    courier: "tanders",
    guide_code: guideCode,
    store_id: row.store_id,
    order_id: row.order_id,
    matched: true,
    match_method: "manual",
    order_name: row.order_name,
    customer_name: built.payload.recipientFullName,
    customer_phone: row.customer_phone,
    product: null,
    district: row.district,
    province: row.province,
    city: row.district,
    region: row.region,
    delivery_address: built.payload.destination,
    delivery_reference: built.payload.note || null,
    latitude: built.payload.destinationLat,
    longitude: built.payload.destinationLng,
    // Tanders la crea "Pendiente": el mismo estado inicial del resto del sistema.
    delivery_status: "pendiente",
    status_category: "pending",
    label_url: labelUrl,
    tanders_raw: order as unknown as Record<string, unknown>,
  };

  const inserted = await admin.from("shipments").insert(insertRow).select("id").single();
  if (inserted.error) {
    // La guía SÍ existe en Tanders: perderla de vista es peor que el error de
    // base, así que el mensaje lleva el código para registrarla a mano.
    return {
      error: `La guía se creó en Tanders (${guideCode}) pero no se pudo guardar acá: ${inserted.error.message}. Anótala y regístrala manualmente.`,
    };
  }

  await admin.from("order_events").insert({
    store_id: row.store_id,
    order_id: row.order_id,
    kind: "guide_created",
    occurred_at: new Date().toISOString(),
    actor: userId,
    source: "tanders",
    courier: "tanders",
    guide_code: guideCode,
    note: `Guía Tanders creada. Cobro S/ ${built.payload.collectionAmount.toFixed(2)} · ${built.payload.destination}`,
    payload: {
      destination: built.payload.destination,
      lat: built.payload.destinationLat,
      lng: built.payload.destinationLng,
      packageType: built.payload.packageType,
      weightGrams: built.payload.weightGrams,
      collectionAmount: built.payload.collectionAmount,
      labelUrl,
    },
  });

  await recomputeOrderMasterSafe(admin, [row.order_id]);
  revalidatePath(MASTER_PATH);

  return {
    notice: `Guía Tanders creada: ${guideCode}${labelUrl ? "" : " (la etiqueta PDF puede tardar en estar lista)"}.`,
    guideCode,
    labelUrl: labelUrl ?? undefined,
  };
}

/** Cupo del día de Tanders, para avisar antes de intentar crear la guía. */
export async function loadTandersCapacity(
  storeId: string,
): Promise<{ used?: number | null; total?: number | null; remaining?: number | null } | { error: string }> {
  const sb = await createServerSupabase();
  const { data } = await sb.from("stores").select("id").eq("id", storeId).maybeSingle();
  if (!data) return { error: "Sin acceso a esta tienda." };

  const admin = createAdminSupabase();
  const store = await loadStoreTanders(admin, storeId);
  if (!store?.tanders_email || !store.tanders_password_enc) {
    return { error: "Tanders no está configurado para esta tienda." };
  }
  try {
    const client = new TandersClient({
      email: store.tanders_email,
      password: decrypt(store.tanders_password_enc),
    });
    return await client.capacity();
  } catch (err) {
    return { error: err instanceof Error ? err.message : "No se pudo leer el cupo de Tanders." };
  }
}
