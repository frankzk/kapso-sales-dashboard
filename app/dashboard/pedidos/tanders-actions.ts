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

import { shopifyOrderNote } from "@/lib/shopify-address";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { getMasterPermissions } from "@/lib/permissions-access";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { parseGeoLink } from "@/lib/geo-link";
import { extractLabelUrl, extractTrackingCode, TandersClient } from "@/lib/tanders/client";
import {
  buildTandersPayload,
  composeTandersNote,
  defaultCollectionAmount,
  suggestedDestination,
  tandersCoverageEligible,
} from "@/lib/tanders/draft";
import { getStoreCreds } from "@/lib/ingest";
import { writeCourierGuide } from "@/lib/route-output-fill";
import { isFillableRouteOutput } from "@/lib/shipment-output";
import { fetchOrderById } from "@/lib/shopify";
import { sweepTandersPayments, type SweepReport } from "@/lib/tanders/payment-sweep";
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

/**
 * Guías vivas del pedido, para no despachar dos veces lo mismo.
 *
 * La salida «por definir» NO cuenta: no es otro paquete en la calle, es ESTA
 * caja esperando a saber quién la lleva, y la guía nueva se va a escribir encima
 * de ella. Contarla obligaba a anularla para poder emitir la guía — y anularla
 * arrastraba al pedido a `anulado` (#KP127639).
 */
async function activeGuides(
  admin: ReturnType<typeof createAdminSupabase>,
  orderId: string,
): Promise<{ courier: string; guide_code: string; delivery_status: string }[]> {
  const { data } = await admin
    .from("shipments")
    .select(
      "courier,guide_code,delivery_status,created_via,custody_state,custody_transferred_at",
    )
    .eq("order_id", orderId);
  const rows =
    (data as {
      courier: string;
      guide_code: string;
      delivery_status: string;
      created_via: string | null;
      custody_state: string | null;
      custody_transferred_at: string | null;
    }[]) ?? [];
  return rows.filter((g) => ACTIVE_STATUSES.has(g.delivery_status) && !isFillableRouteOutput(g));
}

/**
 * La nota del pedido en Shopify, LEÍDA EN VIVO: donde el equipo apunta a mano lo
 * que averiguó al llamar (el enlace de Google Maps del cliente, un horario, una
 * advertencia).
 *
 * El nombre dice «live» porque lo único que la distingue de `shopifyOrderNote`
 * —que es quien decide QUÉ dice la nota, y se usa acá dentro— es de dónde la
 * saca. El drawer usa la copia local; esto pide a Shopify.
 *
 * Se pide EN VIVO y solo se usa lo sincronizado como respaldo. Es un campo que
 * un humano edita segundos antes de despachar —a menudo para pegar justamente
 * la ubicación—, así que leer la copia local se arriesga a mandar la guía sin lo
 * último que se escribió. Best-effort: si Shopify no responde, se sigue con lo
 * que haya en `orders.raw` y la guía se puede crear igual.
 */
async function liveOrderNote(
  admin: ReturnType<typeof createAdminSupabase>,
  orderId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("orders")
    .select("store_id,shopify_order_id,raw")
    .eq("id", orderId)
    .maybeSingle();
  const order = data as
    | { store_id: string; shopify_order_id: string | null; raw: unknown }
    | null;
  if (!order) return null;

  // Qué dice la nota lo decide `shopifyOrderNote` —el mismo ayudante que usa el
  // drawer— y no un `typeof` propio. Lo que NO se comparte es de dónde se lee:
  // acá en vivo, porque esto va a emitir una guía; en el drawer la copia local,
  // porque abrir un pedido no puede costar una llamada a Shopify. Una respuesta,
  // dos políticas de frescura, cada una explícita.
  const stored = shopifyOrderNote(order.raw);

  try {
    const creds = await getStoreCreds(order.store_id, admin);
    if (!creds?.shopify_token || !order.shopify_order_id) return stored;
    const live = await fetchOrderById({
      domain: creds.shopify_domain,
      token: creds.shopify_token,
      storeId: order.store_id,
      orderGid: `gid://shopify/Order/${order.shopify_order_id}`,
    });
    // El `?? stored` conserva el comportamiento de siempre, y con él una
    // peculiaridad que conviene conocer: si alguien BORRA la nota en Shopify,
    // GraphQL devuelve `null` y acá se cae al respaldo, así que la guía sale con
    // la nota vieja. No se cambia en este commit —tocar lo que se imprime en una
    // guía merece su propia decisión— pero queda anotado: hoy una nota se puede
    // corregir a tiempo y no se puede retirar a tiempo.
    return shopifyOrderNote(live?.raw) ?? stored;
  } catch {
    return stored;
  }
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

  if (!tandersCoverageEligible({
    coverage: row.coverage,
    storeId: row.store_id,
    region: row.region,
    province: row.province,
    district: row.district,
  })) {
    blockers.push("Tanders solo está habilitado para pedidos con cobertura Lima.");
  }

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
    // Decir solo «está anulado» deja al operador sin salida: no dice quién lo
    // anuló ni cómo revertirlo, y el motivo más probable es que él mismo acabe
    // de anular la salida para poder llegar hasta aquí.
    blockers.push(
      row.general_status === "anulado"
        ? "El pedido está anulado. Si acabas de anular su salida para cambiar de courier, el estado se recalcula solo y vuelve a Preparación; si lo anuló Shopify o el courier, reábrelo desde Estado del pedido antes de crear la guía."
        : `El pedido está ${row.general_status.replace("_", " ")}.`,
    );
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
      latitude: row.latitude ?? null,
      longitude: row.longitude ?? null,
      geoSource: row.geo_source ?? null,
      recipientName: row.customer_name,
      recipientPhone: row.customer_phone,
      collectionAmount: defaultCollectionAmount({
        paymentState: row.payment_state,
        orderTotal: row.order_total,
      }),
      note: composeTandersNote({
        reference: row.reference,
        shopifyNote: await liveOrderNote(admin, orderId),
      }),
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
  // El mismo permiso que gobierna el botón. Comprobarlo SOLO en la interfaz no
  // protege nada: la acción es invocable directamente.
  if (!perms.can("tanders.create_guide")) {
    return { error: "Tu rol no permite crear guías de Tanders." };
  }

  const ctx = await authorize(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };
  const { row, userId } = ctx;

  if (!tandersCoverageEligible({
    coverage: row.coverage,
    storeId: row.store_id,
    region: row.region,
    province: row.province,
    district: row.district,
  })) {
    return { error: "Tanders solo está habilitado para pedidos con cobertura Lima." };
  }

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
  let lat = row.latitude ?? null;
  let lng = row.longitude ?? null;
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

  // El código que se guarda es el N° de seguimiento de su panel, NO el cuid:
  // es por lo único que el equipo puede buscar el envío en Tanders. El cuid va
  // aparte porque sigue siendo la clave de su API.
  const guideCode = extractTrackingCode(order) ?? "";
  const tandersOrderId = String(order?.id ?? "").trim() || null;
  if (!guideCode) {
    return {
      error:
        "Tanders respondió sin código de pedido. Revisa en tanders.app si la guía se creó antes de reintentar.",
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
    tanders_order_id: tandersOrderId,
    tanders_raw: order as unknown as Record<string, unknown>,
    // Marca la vía, como Aliclik y Shalom. Además es lo que hace que la salida
    // rellenada deje de ofrecer «Anular salida»: esta guía ya existe en Tanders
    // y se anula desde su propio botón, que avisa al courier.
    created_via: "tanders_api",
  };

  // Rellena la salida «por definir» del pedido si la hay: es la misma caja, ya
  // armada y rotulada, a la que se le acaba de decidir el courier.
  const written = await writeCourierGuide(admin, row.order_id, insertRow);
  if ("error" in written) {
    // La guía SÍ existe en Tanders: perderla de vista es peor que el error de
    // base, así que el mensaje lleva el código para registrarla a mano.
    return {
      error: `La guía se creó en Tanders (${guideCode}) pero no se pudo guardar acá: ${written.error}. Anótala y regístrala manualmente.`,
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
      tandersOrderId,
      labelUrl,
    },
  });

  await recomputeOrderMasterSafe(admin, [row.order_id]);
  revalidatePath(MASTER_PATH);

  return {
    notice: `Guía Tanders creada: ${guideCode}${labelUrl ? "" : " — la etiqueta PDF se genera después, se descarga desde tanders.app"}.`,
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

/**
 * Deja constancia de que el rótulo se compuso: acá y en Tanders.
 *
 * Su panel enciende "✓ Rótulo generado" con opción de liberarlo, y es el único
 * guardarraíl contra imprimir dos etiquetas del mismo paquete. Si solo lo
 * anotáramos de nuestro lado, el guardarraíl dejaría de servir.
 *
 * Best-effort hacia Tanders: si su API no responde, el rótulo ya está impreso y
 * negarlo no ayuda a nadie — se registra local y se dice que su panel quedó sin
 * marcar, para que alguien lo mire.
 */
export async function markTandersLabelGenerated(
  shipmentIds: string[],
): Promise<{ error?: string; notice?: string }> {
  const perms = await getMasterPermissions();
  if (!perms.can("tanders.create_guide")) return { error: "Tu rol no permite generar rótulos." };

  const sb = await createServerSupabase();
  // RLS: solo los envíos de las tiendas a las que el usuario tiene acceso.
  const { data } = await sb
    .from("shipments")
    .select("id,store_id,guide_code,tanders_order_id")
    .eq("courier", "tanders")
    .in("id", shipmentIds);
  const rows =
    (data as { id: string; store_id: string; guide_code: string; tanders_order_id: string | null }[]) ??
    [];
  if (!rows.length) return { error: "Sin envíos que marcar." };

  const admin = createAdminSupabase();
  await admin
    .from("shipments")
    .update({ label_generated_at: new Date().toISOString() })
    .in(
      "id",
      rows.map((r) => r.id),
    );

  // Una sesión por tienda: el cliente cachea su token entre llamadas.
  const failed: string[] = [];
  const byStore = new Map<string, typeof rows>();
  for (const r of rows) byStore.set(r.store_id, [...(byStore.get(r.store_id) ?? []), r]);

  for (const [storeId, storeRows] of byStore) {
    const store = await loadStoreTanders(admin, storeId);
    if (!store?.tanders_email || !store.tanders_password_enc) {
      failed.push(...storeRows.map((r) => r.guide_code));
      continue;
    }
    try {
      const client = new TandersClient({
        email: store.tanders_email,
        password: decrypt(store.tanders_password_enc),
      });
      for (const r of storeRows) {
        if (!r.tanders_order_id) {
          failed.push(r.guide_code);
          continue;
        }
        try {
          await client.markLabelGenerated(r.tanders_order_id);
        } catch {
          failed.push(r.guide_code);
        }
      }
    } catch {
      failed.push(...storeRows.map((r) => r.guide_code));
    }
  }

  revalidatePath(MASTER_PATH);
  if (failed.length) {
    return {
      notice: `Rótulo listo. No se pudo marcar en Tanders: ${failed.join(", ")} — márcalos ahí si vas a imprimir otra vez.`,
    };
  }
  return { notice: "Rótulo listo y marcado como generado en Tanders." };
}

/**
 * Un administrador da por bueno un cobro que el lector rechazó.
 *
 * Es la única forma de levantar el bloqueo, y por eso exige motivo: el rechazo
 * dijo por escrito qué no cuadraba, así que la aceptación tiene que decir por
 * escrito por qué se acepta igual. Queda en la fila de la comprobación, junto a
 * lo que el lector había leído.
 */
export async function reviewTandersPayment(
  shipmentId: string,
  note: string,
): Promise<{ error?: string; notice?: string }> {
  const perms = await getMasterPermissions();
  if (!perms.can("tanders.review_payment")) {
    return { error: "Solo un administrador puede dar por bueno un cobro rechazado." };
  }
  const reason = note.trim();
  if (!reason) return { error: "Describe por qué el cobro es correcto: queda en el historial." };

  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");

  // RLS: un envío de otra tienda no aparece.
  const { data } = await sb
    .from("shipments")
    .select("id,store_id,order_id,guide_code")
    .eq("id", shipmentId)
    .maybeSingle();
  const shipment = data as
    | { id: string; store_id: string; order_id: string | null; guide_code: string }
    | null;
  if (!shipment) return { error: "Sin acceso a este envío." };

  const admin = createAdminSupabase();
  await admin.from("shipments").update({ payment_check_state: "revisado" }).eq("id", shipmentId);
  await admin
    .from("tanders_payment_checks")
    .update({ reviewed_by: user.id, reviewed_at: new Date().toISOString(), review_note: reason })
    .eq("shipment_id", shipmentId)
    .is("reviewed_at", null);

  if (shipment.order_id) {
    await admin.from("order_events").insert({
      store_id: shipment.store_id,
      order_id: shipment.order_id,
      kind: "comment",
      occurred_at: new Date().toISOString(),
      actor: user.id,
      source: "tanders",
      courier: "tanders",
      guide_code: shipment.guide_code,
      note: `Cobro rechazado por el lector y aceptado a mano: ${reason}`,
    });
    await recomputeOrderMasterSafe(admin, [shipment.order_id]);
  }

  revalidatePath(MASTER_PATH);
  return { notice: "Cobro dado por bueno. Queda registrado quién y por qué." };
}

/**
 * Revisión EN SECO de los cobros: lee las constancias y dice qué haría, sin
 * escribir nada.
 *
 * Comparte el código con el cron —es el mismo `sweepTandersPayments`— porque una
 * revisión que no recorriera el mismo camino no probaría nada sobre lo que hará
 * el barrido de verdad.
 *
 * Vive acá y no detrás del secreto del cron porque ese secreto está marcado como
 * sensible en Vercel y no se puede leer: pedirle a alguien que lo maneje para
 * mirar unos veredictos era pedir lo que no hace falta. Con la sesión y el
 * permiso de revisión alcanza.
 */
export async function dryRunTandersPayments(): Promise<
  { report: SweepReport } | { error: string }
> {
  const perms = await getMasterPermissions();
  if (!perms.can("tanders.review_payment")) {
    return { error: "Solo un administrador puede revisar los cobros." };
  }
  try {
    return { report: await sweepTandersPayments(createAdminSupabase(), { dry: true }) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "No se pudo revisar." };
  }
}
