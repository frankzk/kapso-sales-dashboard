"use server";

// Creación y cancelación de guías en Aliclik, desde el Master de Pedidos.
//
// POR QUÉ AQUÍ Y NO EN /dashboard/envios. La pantalla de Envíos lee `shipments`
// — una fila por GUÍA. Un pedido que todavía no tiene guía sencillamente no
// existe ahí, y son justo esos los candidatos. El Master lee `order_master`, una
// fila por PEDIDO, y su `OrderDrawer` ya trae cableado `updateOrderGeo`, que es
// el editor de ubicación del que depende todo esto.
//
// ARCHIVO APARTE de `actions.ts` a propósito: aquel ya pasa de 500 líneas y
// mezcla el registro manual del Master con lo que ahora es una integración
// saliente.
//
// LO QUE HACE PELIGROSA ESTA ACCIÓN. Crear un pedido en Aliclik es irreversible,
// con ventanas de cancelación estrictas, y su API NO tiene idempotency key. Las
// defensas, en orden:
//   1. permiso propio `aliclik.create_guide`;
//   2. dos interruptores (ALICLIK_WRITE_ENABLED + stores.aliclik_enabled);
//   3. TODA validación del preview se vuelve a ejecutar aquí — nunca se confía
//      en lo que manda el navegador (doctrina de `createDirectFenixGuide`);
//   4. la intención se escribe ANTES del POST, y su índice único parcial impide
//      dos guías para un pedido (doble clic, dos operadoras, reintento);
//   5. un timeout NO se trata como fallo: el pedido pudo haberse creado.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { getMasterPermissions } from "@/lib/permissions-access";
import { getStoreCreds } from "@/lib/ingest";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { getOrderMasterDetail } from "@/lib/orders-master-access";
import { normalizePhone } from "@/lib/phone";
import { categoryOf } from "@/lib/shipments";
import {
  cancelOrder,
  createOrder,
  interpretCancelResponse,
  quoteShippingCost,
  type AliclikClientOpts,
  type AliclikCourierQuote,
} from "@/lib/aliclik";
import {
  loadCatalogFor,
  resolveAliclikItems,
  type ResolvedItem,
} from "@/lib/aliclik-catalog";
import {
  canScheduleExpress,
  limaTimeHHMM,
  parseCoordinateInput,
  toAliclikCoord,
} from "@/lib/aliclik-geo";
import type { OrderMasterRow } from "@/lib/types";

const MASTER_PATH = "/dashboard/pedidos";

export interface AliclikActionState {
  error?: string;
  notice?: string;
}

// ---------------------------------------------------------------------------
// Contexto y guardas
// ---------------------------------------------------------------------------

interface AliclikContext {
  userId: string;
  storeId: string;
  row: OrderMasterRow;
  client: AliclikClientOpts;
}

/**
 * Autoriza y prepara el cliente. La lectura del pedido va por RLS: un pedido de
 * otra tienda simplemente no aparece, así que la comprobación de acceso es la
 * propia consulta.
 */
async function authorize(
  orderId: string,
  permission: "aliclik.create_guide" | "aliclik.cancel_guide",
): Promise<{ ctx?: AliclikContext; error?: string }> {
  const perms = await getMasterPermissions();
  if (!perms.can(permission)) {
    return { error: "Tu rol no permite esta acción sobre Aliclik." };
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
    return { error: "Esta tienda no tiene configurado el token de Aliclik (Ajustes → Aliclik)." };
  }
  if (!creds.aliclik_enabled) {
    return { error: "La integración con Aliclik está desactivada para esta tienda." };
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

// ---------------------------------------------------------------------------
// Preview / cotización — NO escribe nada hacia afuera
// ---------------------------------------------------------------------------

export interface AliclikPreview {
  ok: boolean;
  /** Motivo del bloqueo, ya redactado para enseñar. */
  error?: string;
  /** Avisos que no impiden crear. */
  warnings?: string[];
  warehouseId?: number;
  warehouseName?: string | null;
  items?: ResolvedItem[];
  /** Ubigeo que Aliclik resuelve del pin. Comparado con el nuestro delata pines malos. */
  aliclikUbigeo?: { department: string | null; province: string | null; district: string | null };
  ourUbigeo?: { region: string | null; province: string | null; district: string | null };
  ubigeoMismatch?: boolean;
  couriers?: (AliclikCourierQuote & { selectable: boolean; reason?: string })[];
  coordinate?: { lat: string; lng: string };
  /** Falta la coordenada: la interfaz debe pedirla antes de seguir. */
  needsCoordinate?: boolean;
  /**
   * Por qué NO se podría crear la guía aunque la cotización salga bien.
   *
   * La cotización es de solo lectura, así que se permite siempre; la escritura
   * exige además las dos llaves. Sin este dato el panel enseñaba el botón
   * "Crear guía" en azul y la operadora descubría el bloqueo DESPUÉS de pulsar
   * un botón que el propio panel describe como irreversible. Se decide en el
   * servidor porque `ALICLIK_WRITE_ENABLED` no existe en el navegador.
   */
  writeBlocked?: string;
}

/** Motivo por el que la escritura está cerrada, o null si está abierta. */
function writeBlockedReason(): string | null {
  return env.aliclikWriteEnabled()
    ? null
    : "La escritura hacia Aliclik está desactivada en este entorno (ALICLIK_WRITE_ENABLED). Puedes cotizar, pero no crear la guía.";
}

const norm = (v: string | null | undefined) =>
  (v ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/**
 * Cotiza el envío y devuelve todo lo que hace falta para decidir. NO crea nada.
 *
 * Este paso vale por sí mismo aunque nunca se llegue a crear la guía: cotizar
 * los pedidos pendientes dice cuántos son creables y —comparando el ubigeo que
 * resuelve Aliclik con el nuestro— cuántos tienen el pin mal puesto.
 */
export async function previewAliclikGuide(
  orderId: string,
  input: { coordinate?: string | null; modality?: "cod" | "agency" } = {},
): Promise<AliclikPreview> {
  const { ctx, error } = await authorize(orderId, "aliclik.create_guide");
  if (!ctx) return { ok: false, error };

  const modality = input.modality ?? "cod";
  const admin = createAdminSupabase();

  // 1. Productos → EAN → un solo almacén.
  const detail = await getOrderMasterDetail(orderId);
  if (!detail) return { ok: false, error: "No se pudo cargar el detalle del pedido." };

  const { skus, mapping } = await loadCatalogFor(ctx.storeId, admin);
  const resolved = resolveAliclikItems(
    detail.lineItems.map((l) => ({
      title: l.title,
      sku: l.sku,
      quantity: l.quantity,
      price: l.price,
    })),
    mapping,
    skus,
    { modality },
  );
  if (!resolved.ok) {
    const b = resolved.blocker;
    return {
      ok: false,
      error: b.offenders.length ? `${b.message}\n· ${b.offenders.join("\n· ")}` : b.message,
    };
  }

  // 2. La coordenada. Es el cuello de botella real: Shopify no la entrega, así
  //    que casi siempre hay que pedirla. Se acepta lo que la operadora pegue
  //    (par suelto o enlace de Google Maps).
  const typed = input.coordinate ? parseCoordinateInput(input.coordinate) : null;
  const stored =
    ctx.row.latitude != null && ctx.row.longitude != null
      ? { lat: Number(ctx.row.latitude), lng: Number(ctx.row.longitude) }
      : null;
  const coord = typed ?? stored;
  if (!coord) {
    return {
      ok: false,
      needsCoordinate: true,
      warehouseId: resolved.warehouseId,
      warehouseName: resolved.warehouseName,
      items: resolved.items,
      error:
        "Este pedido no tiene coordenada, y Aliclik la exige para cotizar y crear. Pega el enlace de Google Maps que mandó la clienta.",
    };
  }
  const lat = toAliclikCoord(coord.lat);
  const lng = toAliclikCoord(coord.lng);

  // 3. Cotización. Doble función: da los couriers Y valida cobertura y ubigeo.
  const quote = await quoteShippingCost(ctx.client, {
    warehouseId: resolved.warehouseId,
    lat,
    lng,
  });
  if (!quote.ok) {
    return { ok: false, error: quote.error, coordinate: { lat, lng } };
  }

  const aliclikUbigeo = {
    department: quote.data.ubigeo?.department?.name ?? null,
    province: quote.data.ubigeo?.province?.name ?? null,
    district: quote.data.ubigeo?.district?.name ?? null,
  };
  const ourUbigeo = {
    region: ctx.row.region ?? null,
    province: ctx.row.province ?? null,
    district: ctx.row.district ?? null,
  };
  // Solo se compara el distrito, que es el nivel que decide tarifa y cobertura,
  // y solo cuando conocemos ambos. Una discrepancia casi siempre significa que
  // el pin está en otro sitio del que dice la dirección.
  const ubigeoMismatch =
    Boolean(aliclikUbigeo.district && ourUbigeo.district) &&
    norm(aliclikUbigeo.district) !== norm(ourUbigeo.district);

  const couriers = quote.data.couriers ?? [];
  if (!couriers.length) {
    return {
      ok: false,
      error: `Aliclik no tiene cobertura para ese punto (${aliclikUbigeo.district ?? "distrito desconocido"}). Revisa la ubicación o usa otro courier.`,
      aliclikUbigeo,
      ourUbigeo,
      ubigeoMismatch,
      coordinate: { lat, lng },
    };
  }

  // Los express fuera de su ventana se marcan no seleccionables aquí, para no
  // dejar que la operadora rellene todo y se coma el 400 al final.
  const nowHHMM = limaTimeHHMM();
  const annotated = couriers.map((c) => {
    if (!c.flagDeliveryExpress) return { ...c, selectable: true };
    const open = canScheduleExpress(nowHHMM, c.scheduleExpressStart, c.scheduleExpressEnd);
    return {
      ...c,
      selectable: open,
      reason: open
        ? undefined
        : `Express disponible solo entre ${c.scheduleExpressStart ?? "?"} y ${c.scheduleExpressEnd ?? "?"} (ahora ${nowHHMM} en Lima).`,
    };
  });

  return {
    ok: true,
    warnings: resolved.warnings,
    warehouseId: resolved.warehouseId,
    warehouseName: resolved.warehouseName,
    items: resolved.items,
    aliclikUbigeo,
    ourUbigeo,
    ubigeoMismatch,
    couriers: annotated,
    coordinate: { lat, lng },
    writeBlocked: writeBlockedReason() ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Creación — la primera escritura hacia afuera
// ---------------------------------------------------------------------------

export interface CreateGuideInput {
  /** transportId del courier elegido en el preview. */
  transportId: number;
  /** Coordenada confirmada por la operadora (par o enlace de Maps). */
  coordinate?: string | null;
  note?: string | null;
}

export async function createAliclikGuide(
  orderId: string,
  input: CreateGuideInput,
): Promise<AliclikActionState> {
  if (!env.aliclikWriteEnabled()) {
    return { error: "La escritura hacia Aliclik está desactivada en este entorno (ALICLIK_WRITE_ENABLED)." };
  }
  const { ctx, error } = await authorize(orderId, "aliclik.create_guide");
  if (!ctx) return { error };

  const admin = createAdminSupabase();

  // El pedido no puede tener ya una guía activa. Mismo criterio que
  // `createDirectFenixGuide`: dos guías vivas para un pedido es un paquete
  // duplicado saliendo del almacén.
  const { data: live } = await admin
    .from("shipments")
    .select("id,guide_code,delivery_status")
    .eq("order_id", orderId)
    .not("delivery_status", "in", "(anulado,transferido)")
    .limit(1);
  const activeGuide = live?.[0];
  if (activeGuide) {
    return { error: `Este pedido ya tiene una guía activa (${activeGuide.guide_code}).` };
  }

  // Se REVALIDA todo en el servidor. Lo que mandó el navegador es una intención,
  // no un hecho: entre el preview y el clic pudo cambiar el stock, el catálogo o
  // la ventana express.
  const preview = await previewAliclikGuide(orderId, { coordinate: input.coordinate, modality: "cod" });
  if (!preview.ok || !preview.items || !preview.coordinate || !preview.warehouseId) {
    return { error: preview.error ?? "No se pudo validar el pedido." };
  }

  const courier = preview.couriers?.find((c) => c.transportId === input.transportId);
  if (!courier) {
    return { error: "El courier elegido ya no está disponible para este destino. Vuelve a cotizar." };
  }
  if (!courier.selectable) {
    return { error: courier.reason ?? "Ese courier no se puede agendar ahora." };
  }

  const phone = normalizePhone(ctx.row.customer_phone);
  if (!phone) return { error: "El pedido no tiene un teléfono válido, y Aliclik lo exige." };
  const address = (ctx.row.address ?? "").trim();
  if (!address) return { error: "El pedido no tiene dirección de envío." };

  // El bloque `courier` se reenvía VERBATIM tal y como lo devolvió la cotización.
  // Recomponerlo a mano sería inventar tarifas: los costos son los que Aliclik
  // calculó para este destino concreto.
  const { selectable: _s, reason: _r, ...courierBlock } = courier;

  const body = {
    note: (input.note ?? "").trim() || undefined,
    channel: "WHATSAPP",
    delivery: courierBlock.deliveryCost,
    customer: {
      name: (ctx.row.customer_name ?? "Cliente").trim(),
      // Aliclik pide el teléfono con código de país y SIN "+".
      phone: phone.replace(/^\+/, ""),
      address,
    },
    shipping: {
      address1: address,
      lat: preview.coordinate.lat,
      lng: preview.coordinate.lng,
      reference: (ctx.row.reference ?? "").trim() || undefined,
    },
    products: preview.items.map((i) => ({ ean: i.ean, quantity: i.quantity, price: i.price })),
    courier: courierBlock as AliclikCourierQuote,
  };

  // EL CANDADO. Se escribe ANTES del POST: si dos peticiones llegan a la vez,
  // una choca aquí (23505) en lugar de crear dos pedidos reales en Aliclik.
  const { data: intent, error: intentErr } = await admin
    .from("aliclik_order_requests")
    .insert({
      store_id: ctx.storeId,
      order_id: orderId,
      modality: "cod",
      status: "pending",
      request: body as unknown as Record<string, unknown>,
      created_by: ctx.userId,
    })
    .select("id")
    .single();

  if (intentErr) {
    if (intentErr.code === "23505") {
      return { error: "Ya hay una creación en curso o completada para este pedido." };
    }
    return { error: `No se pudo registrar la intención: ${intentErr.message}` };
  }

  const res = await createOrder(ctx.client, body);

  // UN TIMEOUT NO ES UN FALLO. Aliclik pudo haber creado el pedido y habérsenos
  // perdido la respuesta. La intención se queda en 'pending' —y por tanto sigue
  // bloqueando un segundo intento— y el cron de reconciliación la resolverá
  // buscando el pedido huérfano. Reintentar a ciegas es lo que crea duplicados.
  if (!res.ok && res.timedOut) {
    await admin
      .from("aliclik_order_requests")
      .update({ error: res.error, http_status: null })
      .eq("id", intent.id);
    return {
      error:
        "Aliclik no respondió a tiempo. El pedido PUEDE haberse creado: no reintentes; se verificará automáticamente en el próximo barrido.",
    };
  }

  if (!res.ok) {
    await admin
      .from("aliclik_order_requests")
      .update({
        status: "failed",
        error: res.error,
        http_status: res.status,
        completed_at: new Date().toISOString(),
      })
      .eq("id", intent.id);
    // El mensaje de Aliclik viene en español y accionable: se muestra literal.
    return { error: `Aliclik rechazó el pedido: ${res.error}` };
  }

  const orderNumber = (res.data.orderNumber ?? "").trim();
  if (!orderNumber) {
    await admin
      .from("aliclik_order_requests")
      .update({
        status: "failed",
        error: "Aliclik respondió sin orderNumber.",
        response: res.data as unknown as Record<string, unknown>,
        completed_at: new Date().toISOString(),
      })
      .eq("id", intent.id);
    return { error: "Aliclik aceptó el pedido pero no devolvió su número. Revísalo en su panel." };
  }

  await admin
    .from("aliclik_order_requests")
    .update({
      status: "sent",
      order_number: orderNumber,
      response: res.data as unknown as Record<string, unknown>,
      http_status: 201,
      completed_at: new Date().toISOString(),
    })
    .eq("id", intent.id);

  // La guía. `guide_code` lleva el ALC… de forma PROVISIONAL: cuando el Excel
  // traiga el AUR5X definitivo, lib/aliclik-reconcile.ts lo promueve sobre esta
  // misma fila, que conserva llamadas, vínculo e historial (ver 0054).
  const { error: shipErr } = await admin.from("shipments").insert({
    store_id: ctx.storeId,
    courier: "aliclik",
    guide_code: orderNumber,
    external_order_number: orderNumber,
    delivery_status: "pendiente",
    status_category: categoryOf("pendiente"),
    order_id: orderId,
    matched: true,
    match_method: "manual",
    order_name: ctx.row.order_name,
    customer_name: ctx.row.customer_name,
    customer_phone: ctx.row.customer_phone,
    district: ctx.row.district,
    province: ctx.row.province,
    region: ctx.row.region,
    delivery_address: address,
    delivery_reference: ctx.row.reference,
    latitude: Number(preview.coordinate.lat),
    longitude: Number(preview.coordinate.lng),
    created_via: "aliclik_api",
    quoted_delivery_cost: courierBlock.deliveryCost,
    quoted_return_cost: courierBlock.returnCost,
    aliclik_transport_id: courierBlock.transportId,
    aliclik_transport_name: courierBlock.transportName ?? null,
    assigned_at: new Date().toISOString(),
  });
  if (shipErr) {
    // El pedido YA existe en Aliclik. Que falle nuestra fila es grave pero no se
    // puede deshacer: se avisa con el número para que se pueda vincular a mano.
    return {
      error: `El pedido se creó en Aliclik (${orderNumber}) pero no se pudo guardar la guía: ${shipErr.message}`,
    };
  }

  await admin.from("order_events").insert({
    store_id: ctx.storeId,
    order_id: orderId,
    kind: "guide_registered",
    occurred_at: new Date().toISOString(),
    actor: ctx.userId,
    source: "aliclik",
    courier: "aliclik",
    guide_code: orderNumber,
    payload: {
      transportName: courierBlock.transportName,
      deliveryCost: courierBlock.deliveryCost,
      returnCost: courierBlock.returnCost,
      warehouseId: preview.warehouseId,
      ubigeo: preview.aliclikUbigeo,
    },
  });

  await recomputeOrderMasterSafe(admin, [orderId]);
  revalidatePath(MASTER_PATH);
  return {
    notice: `Guía creada en Aliclik: ${orderNumber} (${courierBlock.transportName ?? "courier"}, S/ ${courierBlock.deliveryCost}).`,
  };
}

// ---------------------------------------------------------------------------
// Cancelación
// ---------------------------------------------------------------------------

/**
 * Cancela el pedido en Aliclik.
 *
 * TRAMPA: `POST /integration/order/cancel` responde 201 aunque NO cancele. Si el
 * pedido no está confirmado, Aliclik solo le añade una nota y contesta
 * "Pedido no confirmado." — con el mismo 201 que un éxito. Dar eso por cancelado
 * dejaría al equipo creyendo que el paquete no sale, cuando sí sale. Por eso el
 * resultado se decide leyendo el mensaje (`interpretCancelResponse`).
 */
export async function cancelAliclikGuide(
  orderId: string,
  reason: string,
): Promise<AliclikActionState> {
  if (!env.aliclikWriteEnabled()) {
    return { error: "La escritura hacia Aliclik está desactivada en este entorno." };
  }
  const { ctx, error } = await authorize(orderId, "aliclik.cancel_guide");
  if (!ctx) return { error };
  if (!reason.trim()) return { error: "Indica el motivo de la cancelación." };

  const admin = createAdminSupabase();
  const { data: guide } = await admin
    .from("shipments")
    .select("id,guide_code,external_order_number,delivery_status")
    .eq("order_id", orderId)
    .eq("courier", "aliclik")
    .not("external_order_number", "is", null)
    .limit(1)
    .maybeSingle();

  if (!guide?.external_order_number) {
    return { error: "Este pedido no tiene una guía de Aliclik creada por API." };
  }

  const res = await cancelOrder(ctx.client, guide.external_order_number);
  if (!res.ok) return { error: `Aliclik rechazó la cancelación: ${res.error}` };

  const outcome = interpretCancelResponse(res.data.message);

  if (outcome === "not_confirmed") {
    // NO se canceló. Se registra como comentario, no como cambio de estado.
    await admin.from("order_events").insert({
      store_id: ctx.storeId,
      order_id: orderId,
      kind: "comment",
      occurred_at: new Date().toISOString(),
      actor: ctx.userId,
      source: "aliclik",
      courier: "aliclik",
      guide_code: guide.guide_code,
      note: `Aliclik no canceló el pedido (aún sin confirmar); dejó la nota "Cancelar pedido.". Motivo pedido: ${reason.trim()}`,
    });
    revalidatePath(MASTER_PATH);
    return {
      error:
        'El pedido NO se canceló: Aliclik lo tiene sin confirmar y solo le dejó la nota "Cancelar pedido.". Vuelve a intentarlo cuando esté confirmado.',
    };
  }

  if (outcome === "unknown") {
    return { error: `Aliclik respondió algo inesperado: "${res.data.message ?? ""}". Verifícalo en su panel.` };
  }

  await admin
    .from("shipments")
    .update({
      delivery_status: "anulado",
      status_category: categoryOf("anulado"),
      closed_at: new Date().toISOString(),
    })
    .eq("id", guide.id);

  await admin.from("order_events").insert({
    store_id: ctx.storeId,
    order_id: orderId,
    kind: "status_override",
    occurred_at: new Date().toISOString(),
    actor: ctx.userId,
    source: "aliclik",
    courier: "aliclik",
    guide_code: guide.guide_code,
    previous_status: ctx.row.general_status,
    new_status: "anulado",
    reason: reason.trim(),
  });

  await recomputeOrderMasterSafe(admin, [orderId]);
  revalidatePath(MASTER_PATH);
  return { notice: "Pedido cancelado en Aliclik." };
}
