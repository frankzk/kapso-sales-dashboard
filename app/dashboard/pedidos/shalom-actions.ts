"use server";

// Crear una preguía de Shalom desde el Master de Pedidos.
//
// Shalom ya estaba en el sistema por la vía de ENTRADA: su reporte Excel se sube
// y lo parsea lib/couriers/agency.ts. Esto es la vía de SALIDA — se crea la
// preguía por API (api.shalom-api-peru.com, wrapper de pro.shalom.pe) y se
// registra el envío antes de que exista ningún reporte. Cuando el reporte del
// día siguiente llegue, cruzará por `guide_code` como cualquier otro envío.
//
// Tres cosas separan esto de la integración de Tanders (0058):
//
//  1. La sesión se saca aparte y se cachea 2 h en la tienda. El wrapper hace un
//     login real contra pro.shalom.pe la primera vez (~90 s): concentrarlo en
//     una llamada propia —que es una lectura y se puede reintentar sin riesgo—
//     evita que la creación de la guía, que NO se puede reintentar, cargue con
//     esa latencia.
//
//  2. Tras un corte se VERIFICA en lugar de reintentar. `POST /v1/orders` no
//     tiene idempotencia y crea una guía real y cobrable; un reintento a ciegas
//     duplicaría el despacho. Se busca la guía por documento + clave de recojo
//     en `GET /v1/orders` y, si aparece, se adopta.
//
//  3. La clave de recojo la elegimos NOSOTROS y va cifrada a `shalom_pickup_keys`
//     (0049). Antes la copiaba un administrador a mano desde el panel de Shalom;
//     ahora nace con la guía. El circuito de Yape → validación → revelar la clave
//     no cambia: sigue siendo la única vía de verla, y sigue auditado.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { getMasterPermissions } from "@/lib/permissions-access";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { SHALOM_ORIGIN } from "@/lib/shalom/origin";
import {
  describeShalomError,
  findCreatedOrder,
  sessionIsFresh,
  type ShalomClient,
} from "@/lib/shalom/client";
import {
  clearSession,
  clientFor,
  configurationBlocker,
  isConfigured,
  loadStoreShalom,
  mintSession,
  publicClient,
  readWithFreshSession,
  type StoreShalom,
} from "@/lib/shalom/session";
import {
  blockingActiveGuide,
  buildShalomOrderPayload,
  documentError,
  generatePickupCode,
  shalomSoftBlockers,
  MIN_OVERRIDE_REASON,
  normalizeDocument,
  splitReceiverName,
  suggestedAgencyQuery,
  shalomGuideIsCancelable,
  DEFAULT_DECLARACION,
  DEFAULT_PAYER,
} from "@/lib/shalom/draft";
import {
  normalizeManualShalomGuide,
  type ManualShalomGuideInput,
} from "@/lib/shalom/manual";
import {
  ShalomApiError,
  ShalomTimeoutError,
  type DeclaracionJurada,
  type ShalomAgency,
  type ShalomDocumentType,
  type ShalomPayer,
  type ShalomProduct,
} from "@/lib/shalom/types";
import type { OrderMasterRow } from "@/lib/types";

const MASTER_PATH = "/dashboard/pedidos";

/** Guías que ya cubren el pedido: crear otra encima duplica el despacho. */
const ACTIVE_STATUSES = new Set(["pendiente", "en_ruta", "por_preparar"]);

export interface ShalomDraftView {
  orderId: string;
  storeId: string;
  orderName: string | null;
  /** false → faltan credenciales o la agencia de origen en Ajustes. */
  configured: boolean;
  /** true → hay token `ssk_` vigente: las llamadas siguientes son rápidas. */
  sessionReady: boolean;
  originTerminalId: number | null;
  originTerminalName: string | null;
  defaultProductId: number | null;
  /** Texto con el que arranca la búsqueda de agencia de destino. */
  agencyQuery: string;
  customerName: string | null;
  receiverName: string;
  receiverLastName: string;
  receiverSurName: string;
  receiverPhone: string | null;
  /**
   * Lo apuntado por adelantado al registrar el pago (0073). Es opcional y puede
   * venir a medias: quien cobró tal vez tenía el DNI pero no la agencia.
   */
  prefilledDocumentType: ShalomDocumentType | null;
  prefilledDocument: string | null;
  prefilledTerminalId: number | null;
  prefilledTerminalName: string | null;
  /** Clave de recojo generada en el servidor. Solo viaja si el rol puede verla. */
  pickupCode: string | null;
  /** Motivos para NO crear la guía todavía. Imposibles: no se saltan. */
  blockers: string[];
  /**
   * Los bloqueadores que valen TAMBIÉN para la vía de contingencia.
   *
   * `blockers` no sirve para la pestaña «Ya la creé en Shalom Pro»: casi todos
   * son motivos para no llamar al API —falta configuración, la sesión no
   * conecta— y esa vía existe precisamente para cuando el API no responde.
   * Pero una salida ya viva sí la bloquea, porque el problema no es la llamada
   * sino que el pedido acabaría con dos paquetes en la calle.
   */
  contingencyBlockers: string[];
  /**
   * Frenos que SÍ se pueden saltar, dejando un motivo escrito que queda en la
   * línea de tiempo con el nombre de quien lo escribió.
   */
  softBlockers: string[];
  /** Cosas que el operador debería mirar antes de confirmar. */
  warnings: string[];
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

/** Comprueba que el usuario ve esta tienda antes de usar el cliente admin. */
async function authorizeStore(storeId: string): Promise<boolean> {
  const sb = await createServerSupabase();
  const { data } = await sb.from("stores").select("id").eq("id", storeId).maybeSingle();
  return Boolean(data);
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

// ---------------------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------------------

/**
 * Canjea las credenciales de Shalom Pro por un token de 2 h y lo guarda cifrado.
 *
 * ES LA LLAMADA LENTA de toda la integración (~90 s, hasta 2 min): el wrapper
 * entra de verdad a pro.shalom.pe. Es una lectura, así que reintentarla no crea
 * nada — a diferencia de todo lo demás en este archivo.
 */
export async function connectShalomSession(
  storeId: string,
): Promise<{ expiresAt: string } | { error: string }> {
  const perms = await getMasterPermissions();
  if (!perms.can("shalom.create_guide")) return { error: "Tu rol no permite crear guías Shalom." };
  if (!(await authorizeStore(storeId))) return { error: "Sin acceso a esta tienda." };

  const admin = createAdminSupabase();
  const store = await loadStoreShalom(admin, storeId);
  const blocker = configurationBlocker(store);
  if (blocker) return { error: blocker };
  const s = store as StoreShalom;

  try {
    const res = await mintSession(admin, storeId, s);
    return "error" in res ? { error: res.error } : { expiresAt: res.expiresAt };
  } catch (err) {
    return { error: describeShalomError(err) };
  }
}

// ---------------------------------------------------------------------------
// Borrador
// ---------------------------------------------------------------------------

/**
 * Todo lo que necesita el modal, ya resuelto en el servidor: qué se despacha, a
 * quién, con qué clave, y qué debería frenar al operador.
 */
export async function loadShalomDraft(
  orderId: string,
): Promise<{ draft: ShalomDraftView } | { error: string }> {
  const perms = await getMasterPermissions();
  const ctx = await authorize(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };
  const { row } = ctx;

  const admin = createAdminSupabase();
  const store = await loadStoreShalom(admin, row.store_id);
  const configured = isConfigured(store);

  const blockers: string[] = [];
  const contingencyBlockers: string[] = [];
  const warnings: string[] = [];

  const configBlocker = configurationBlocker(store);
  if (configBlocker) blockers.push(configBlocker);

  for (const g of await activeGuides(admin, orderId)) {
    contingencyBlockers.push(
      `El pedido ya tiene una guía activa: ${g.guide_code} (${g.courier}, ${g.delivery_status}). Anúlala antes de crear otra.`,
    );
  }

  if (["entregado", "devuelto", "anulado"].includes(row.general_status)) {
    contingencyBlockers.push(`El pedido está ${row.general_status.replace("_", " ")}.`);
  }

  // Todo lo que impide la contingencia impide con más razón crear por API.
  blockers.push(...contingencyBlockers);

  // Shalom identifica al destinatario por documento y el pedido no lo trae:
  // Shopify no pide DNI. Es el único dato que el operador escribe siempre.
  warnings.push(
    "Shalom exige el documento del destinatario y el pedido no lo trae: pídeselo al cliente antes de crear la guía.",
  );

  // Faltar el adelanto frena de forma blanda (ver `shalomSoftBlockers`); tenerlo
  // cargado pero sin validar es solo un trámite pendiente y se queda en aviso.
  const softBlockers = shalomSoftBlockers(row.payment_state);
  if (row.payment_state !== "sin_pago" && row.payment_state !== "pago_completo") {
    warnings.push(
      "El pedido todavía no tiene el pago completo validado. La guía se puede crear igual, pero la clave de recojo seguirá bloqueada hasta que se valide.",
    );
  }

  const split = splitReceiverName(row.customer_name);

  // Lo que alguien dejó apuntado al registrar el pago (0073). Es el punto de todo
  // el mecanismo: quien cobró tenía a la clienta al teléfono y el DNI a mano;
  // quien crea la guía, normalmente ni una cosa ni la otra.
  const { data: pre } = await admin
    .from("shalom_order_drafts")
    .select("document_type,document,destiny_terminal_id,destiny_terminal_name")
    .eq("order_id", orderId)
    .maybeSingle();
  const prefilled = (pre ?? null) as {
    document_type: string | null;
    document: string | null;
    destiny_terminal_id: number | null;
    destiny_terminal_name: string | null;
  } | null;

  if (prefilled?.document) {
    warnings.push(
      `El documento y la agencia venían apuntados desde el registro del pago (${prefilled.document}${prefilled.destiny_terminal_name ? ` · ${prefilled.destiny_terminal_name}` : ""}). Verifícalos antes de crear.`,
    );
  }

  // La clave se genera en el servidor y NO viaja al cliente salvo que el rol ya
  // tenga permiso de verla: es la llave del paquete. Quien crea la guía no
  // necesita conocerla — se revela desde la salida Shalom, con auditoría.
  const pickupCode = generatePickupCode();

  return {
    draft: {
      orderId,
      storeId: row.store_id,
      orderName: row.order_name,
      configured,
      sessionReady: Boolean(
        store && sessionIsFresh(store.shalom_session_expires_at) && store.shalom_session_token_enc,
      ),
      originTerminalId: store?.shalom_origin_terminal_id ?? null,
      originTerminalName: store?.shalom_origin_terminal_name ?? null,
      defaultProductId: store?.shalom_default_product_id ?? null,
      agencyQuery: suggestedAgencyQuery(row),
      customerName: row.customer_name,
      receiverName: split.name,
      receiverLastName: split.last_name,
      receiverSurName: split.sur_name,
      receiverPhone: row.customer_phone,
      prefilledDocumentType: (prefilled?.document_type as ShalomDocumentType | null) ?? null,
      prefilledDocument: prefilled?.document ?? null,
      prefilledTerminalId: prefilled?.destiny_terminal_id ?? null,
      prefilledTerminalName: prefilled?.destiny_terminal_name ?? null,
      pickupCode: perms.can("shalom.view_pickup_key") ? pickupCode : null,
      blockers,
      contingencyBlockers,
      softBlockers,
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Catálogos para el modal
// ---------------------------------------------------------------------------

/** Agencias. Solo pide la API key, así que responde sin esperar a la sesión. */
export async function searchShalomAgencies(
  storeId: string,
  q: string,
): Promise<{ agencies: ShalomAgency[] } | { error: string }> {
  if (!(await authorizeStore(storeId))) return { error: "Sin acceso a esta tienda." };
  const query = q.trim();
  if (query.length < 2) return { agencies: [] };

  const admin = createAdminSupabase();
  const store = await loadStoreShalom(admin, storeId);
  const blocker = configurationBlocker(store);
  // Solo importa que la API key global exista: el directorio de agencias no toca
  // la cuenta del cliente, así que se puede buscar antes de conectar.
  if (blocker && !store?.shalom_pro_email) return { error: blocker };

  try {
    return { agencies: (await publicClient().searchAgencies({ q: query })).slice(0, 25) };
  } catch (err) {
    return { error: describeShalomError(err) };
  }
}

/** Catálogo de cajas de la cuenta. Necesita sesión. */
export async function loadShalomProducts(
  storeId: string,
): Promise<{ products: ShalomProduct[] } | { error: string }> {
  if (!(await authorizeStore(storeId))) return { error: "Sin acceso a esta tienda." };
  const admin = createAdminSupabase();
  const store = await loadStoreShalom(admin, storeId);
  const configBlocker = configurationBlocker(store);
  if (configBlocker) return { error: configBlocker };

  try {
    return {
      products: await readWithFreshSession(admin, storeId, store as StoreShalom, (client) =>
        client.products(),
      ),
    };
  } catch (err) {
    return { error: describeShalomError(err) };
  }
}

/**
 * Autocompleta el destinatario desde el documento. Es el motivo por el que el
 * operador no tiene que teclear nombre y apellidos exactos: si el cliente ya
 * envió alguna vez por Shalom, sus datos ya están del otro lado.
 */
export async function lookupShalomPerson(
  storeId: string,
  document: string,
  type: ShalomDocumentType,
): Promise<
  | { person: { id: number; name: string; lastName: string; surName: string; phone: string | null } | null }
  | { error: string }
> {
  if (!(await authorizeStore(storeId))) return { error: "Sin acceso a esta tienda." };
  const admin = createAdminSupabase();
  const store = await loadStoreShalom(admin, storeId);
  const configBlocker = configurationBlocker(store);
  if (configBlocker) return { error: configBlocker };

  try {
    // Lectura: si el token cacheado está muerto se renueva y se reintenta sola,
    // en vez de echar al operador a «vuelve a conectar» a mitad de la guía.
    const found = await readWithFreshSession(admin, storeId, store as StoreShalom, (client) =>
      client.findPerson(document, type),
    );
    if (!found) return { person: null };
    return {
      person: {
        id: found.id,
        name: found.name ?? "",
        lastName: found.last_name ?? "",
        surName: found.sur_name ?? "",
        phone: found.phone != null ? String(found.phone) : null,
      },
    };
  } catch (err) {
    return { error: describeShalomError(err) };
  }
}

/** Cotización antes de comprometer la orden. No crea nada. */
export async function quoteShalomTariff(
  storeId: string,
  input: { destinyTerminalId: number; productId?: number },
): Promise<{ currency: string; price: number | null; breakdown: Record<string, number> } | { error: string }> {
  if (!(await authorizeStore(storeId))) return { error: "Sin acceso a esta tienda." };
  const admin = createAdminSupabase();
  const store = await loadStoreShalom(admin, storeId);
  const configBlocker = configurationBlocker(store);
  if (configBlocker) return { error: configBlocker };
  const s = store as StoreShalom;

  try {
    // Cotizar no compromete nada, así que también se renueva y reintenta sola.
    const tariff = await readWithFreshSession(admin, storeId, s, (client) =>
      client.tariff({
        origin_terminal_id: s.shalom_origin_terminal_id as number,
        destiny_terminal_id: input.destinyTerminalId,
        product_id: input.productId,
      }),
    );
    return {
      currency: tariff.currency ?? "PEN",
      price: tariff.product?.price ?? null,
      breakdown: tariff.breakdown ?? {},
    };
  } catch (err) {
    return { error: describeShalomError(err) };
  }
}

// ---------------------------------------------------------------------------
// Crear la guía
// ---------------------------------------------------------------------------

export interface CreateShalomInput {
  destinyTerminalId: number;
  destinyTerminalName?: string;
  productId: number;
  quantity?: number;
  payer?: ShalomPayer;
  declaracionJurada?: DeclaracionJurada;
  documentType: ShalomDocumentType;
  document: string;
  name: string;
  lastName?: string;
  surName?: string;
  phone: string;
  aereo?: boolean;
  dimensions?: { weight_kg: number; height_m: number; length_m: number; width_m: number } | null;
  /** Solo lo manda un rol que puede ver la clave; si no, la genera el servidor. */
  pickupCode?: string;
  /**
   * Motivo para saltarse un freno blando (hoy: crear sin adelanto cargado).
   * Se exige solo si de verdad hay freno, y queda escrito en la línea de tiempo.
   */
  overrideReason?: string | null;
}

/**
 * Vincula una guía que el operador ya creó directamente en pro.shalom.pe.
 *
 * Esta acción es deliberadamente independiente de la sesión y del API de
 * creación: se usa precisamente cuando ese servicio está caído. No crea ni
 * reintenta nada fuera de Kapta; registra la salida física, deja su QR propio y
 * permite que el cron público la siga por número de guía.
 */
export async function registerManualShalomGuide(
  orderId: string,
  input: ManualShalomGuideInput,
): Promise<{ error?: string; notice?: string; guideCode?: string }> {
  const perms = await getMasterPermissions();
  if (!perms.can("shalom.create_guide")) {
    return { error: "Tu rol no permite registrar guías Shalom." };
  }

  const ctx = await authorize(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };
  const { row, userId } = ctx;

  const normalized = normalizeManualShalomGuide(input);
  if (!normalized.ok) return { error: normalized.error };
  const guide = normalized.value;
  const admin = createAdminSupabase();

  // El número impreso identifica una salida real. Nunca puede aparecer en dos
  // pedidos distintos, incluso si dos personas registran la contingencia al
  // mismo tiempo (la base además conserva unique(courier, guide_code)).
  const duplicate = await admin
    .from("shipments")
    .select("id,order_id,store_id,guide_code")
    .eq("courier", "shalom")
    .eq("guide_code", guide.guideCode)
    .maybeSingle();
  if (duplicate.error) return { error: `No se pudo validar la guía: ${duplicate.error.message}` };
  if (duplicate.data?.order_id && duplicate.data.order_id !== row.order_id) {
    return {
      error: `La guía ${guide.guideCode} ya está vinculada a otro pedido. Revisa el número antes de continuar.`,
    };
  }

  // La contingencia registra una salida física igual que la vía API, así que
  // hereda su misma regla: un pedido no puede quedar con dos salidas vivas. Sin
  // esto, la pestaña «Ya la creé en Shalom Pro» era la puerta de atrás — no la
  // frena `blockers` en el modal ni se comprobaba acá— y dejaba al pedido con
  // dos paquetes que nadie sabe cuál viaja.
  //
  // Se excluye ESTA guía: reenviar el formulario para completar identificadores
  // que faltaban es idempotente por diseño y no debe chocar consigo mismo.
  const otherActive = blockingActiveGuide(await activeGuides(admin, orderId), guide.guideCode);
  if (otherActive) {
    return {
      error:
        `El pedido ya tiene una salida activa: ${otherActive.guide_code} (${otherActive.courier}, ${otherActive.delivery_status}). ` +
        "Anúlala antes de vincular esta guía; si ya salió con el courier, registra primero su retorno.",
    };
  }

  const now = new Date().toISOString();
  let shipmentId = duplicate.data?.id ?? null;
  let alreadyLinked = Boolean(shipmentId);

  if (!shipmentId) {
    const inserted = await admin
      .from("shipments")
      .insert({
        courier: "shalom",
        guide_code: guide.guideCode,
        store_id: row.store_id,
        order_id: row.order_id,
        matched: true,
        match_method: "manual",
        order_name: row.order_name,
        customer_name: row.customer_name,
        customer_phone: row.customer_phone,
        product: null,
        district: row.district,
        province: row.province,
        city: row.district,
        region: row.region,
        delivery_address: null,
        agency_branch: guide.agencyBranch,
        delivery_status: "pendiente",
        status_category: "pending",
        pickup_state: "pendiente_de_envio",
        shalom_codigo: guide.codigo,
        shalom_serie: guide.serie,
        shalom_ose_id: guide.oseId,
        shalom_order_id: guide.shalomOrderId,
        shalom_raw: {
          source: SHALOM_ORIGIN.manual,
          guia: guide.guideCode,
          codigo: guide.codigo,
          serie: guide.serie,
          ose_id: guide.oseId,
          order_id: guide.shalomOrderId,
          recorded_at: now,
          recorded_by: userId,
        },
        // Generar la guía equivale a generar el rótulo, pero la caja todavía
        // sigue físicamente en almacén hasta el doble escaneo de despacho.
        preparation_state: "rotulo_generado",
        custody_state: "empresa",
        assigned_at: now,
        created_via: SHALOM_ORIGIN.manual,
      })
      .select("id")
      .single();

    if (inserted.error) {
      if (inserted.error.code === "23505") {
        return {
          error: `La guía ${guide.guideCode} fue registrada por otra persona mientras completabas el formulario. Actualiza el pedido para verla.`,
        };
      }
      return { error: `No se pudo registrar la guía manual: ${inserted.error.message}` };
    }
    shipmentId = inserted.data.id;
  } else {
    // Un segundo envío del mismo formulario es idempotente. Permite completar
    // identificadores faltantes, pero nunca cambia de pedido ni crea otro QR.
    const patch: Record<string, unknown> = { updated_at: now };
    if (guide.codigo) patch.shalom_codigo = guide.codigo;
    if (guide.serie) patch.shalom_serie = guide.serie;
    if (guide.oseId) patch.shalom_ose_id = guide.oseId;
    if (guide.shalomOrderId) patch.shalom_order_id = guide.shalomOrderId;
    if (guide.agencyBranch) patch.agency_branch = guide.agencyBranch;
    const updated = await admin.from("shipments").update(patch).eq("id", shipmentId);
    if (updated.error) return { error: `La guía ya existe, pero no se pudo actualizar: ${updated.error.message}` };
  }

  let keyWarning = "";
  if (guide.pickupCode) {
    const { data: previousKey } = await admin
      .from("shalom_pickup_keys")
      .select("order_id")
      .eq("order_id", row.order_id)
      .maybeSingle();
    const keyWrite = await admin.from("shalom_pickup_keys").upsert(
      {
        order_id: row.order_id,
        store_id: row.store_id,
        key_enc: encrypt(guide.pickupCode),
        created_by: userId,
        ...(previousKey ? { replaced_at: now, replaced_by: userId } : {}),
      },
      { onConflict: "order_id" },
    );
    if (keyWrite.error) {
      keyWarning = ` La guía quedó vinculada, pero la clave no pudo guardarse (${keyWrite.error.message}); regístrala desde la salida Shalom en Salidas y guías.`;
    }
  } else {
    keyWarning = " No se ingresó la clave de recojo; regístrala después desde la salida Shalom en Salidas y guías.";
  }

  const { data: validatedPayments } = await admin
    .from("order_payments")
    .select("amount")
    .eq("order_id", row.order_id)
    .eq("validation_status", "validado");
  const advance = (validatedPayments ?? []).reduce(
    (sum, payment) => sum + (Number(payment.amount) || 0),
    0,
  );
  await admin.from("order_events").insert({
    store_id: row.store_id,
    order_id: row.order_id,
    kind: alreadyLinked ? "guide_link_updated" : "guide_created",
    occurred_at: now,
    actor: userId,
    source: "shalom",
    courier: "shalom",
    guide_code: guide.guideCode,
    note:
      `Guía Shalom ${alreadyLinked ? "actualizada" : "creada fuera de Kapta y vinculada manualmente"}.` +
      `${guide.agencyBranch ? ` Destino: ${guide.agencyBranch}.` : ""}` +
      ` Adelanto validado: S/ ${advance.toFixed(2)}.`,
    // Nunca se guarda la clave en la línea de tiempo: solo la confirmación de
    // que fue recibida y cifrada.
    payload: {
      source: SHALOM_ORIGIN.manual,
      shipment_id: shipmentId,
      codigo: guide.codigo,
      serie: guide.serie,
      ose_id: guide.oseId,
      shalom_order_id: guide.shalomOrderId,
      agency_branch: guide.agencyBranch,
      has_pickup_key: Boolean(guide.pickupCode),
      validated_advance: advance,
    },
  });

  await recomputeOrderMasterSafe(admin, [row.order_id]);
  revalidatePath(MASTER_PATH);

  return {
    notice:
      `${alreadyLinked ? "La guía ya estaba vinculada; se actualizaron sus datos" : "Guía externa vinculada"}: ${guide.guideCode}.` +
      " El tracking público se hará automáticamente por este número cuando Shalom responda." +
      keyWarning,
    guideCode: guide.guideCode,
  };
}

export async function createShalomGuide(
  orderId: string,
  input: CreateShalomInput,
): Promise<{
  error?: string;
  notice?: string;
  guideCode?: string;
  codigo?: string | null;
  recovered?: boolean;
}> {
  const perms = await getMasterPermissions();
  if (!perms.can("shalom.create_guide")) return { error: "Tu rol no permite crear guías Shalom." };

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

  // Se revalida el freno blando ACÁ, no solo en el modal: un botón deshabilitado
  // no es una autorización, y entre abrir el modal y confirmar pudo cargarse (o
  // borrarse) el comprobante. El motivo se exige solo si el freno sigue vivo.
  const soft = shalomSoftBlockers(row.payment_state);
  const overrideReason = (input.overrideReason ?? "").trim();
  if (soft.length && overrideReason.length < MIN_OVERRIDE_REASON) {
    return {
      error: `${soft.join(" ")} Para crearla igual hace falta un motivo de al menos ${MIN_OVERRIDE_REASON} caracteres: queda registrado con tu nombre en la línea de tiempo del pedido.`,
    };
  }

  const store = await loadStoreShalom(admin, row.store_id);
  const configBlocker = configurationBlocker(store);
  if (configBlocker) return { error: configBlocker };
  const s = store as StoreShalom;

  // La clave sale del servidor salvo que la haya escrito un rol autorizado: no
  // se acepta una clave arbitraria de quien no puede verlas.
  const pickupCode =
    input.pickupCode && perms.can("shalom.view_pickup_key")
      ? input.pickupCode.trim()
      : generatePickupCode();

  const built = buildShalomOrderPayload({
    originTerminalId: s.shalom_origin_terminal_id,
    destinyTerminalId: input.destinyTerminalId,
    productId: input.productId,
    quantity: input.quantity,
    payer: input.payer ?? DEFAULT_PAYER,
    declaracionJurada: input.declaracionJurada ?? DEFAULT_DECLARACION,
    documentType: input.documentType,
    document: input.document,
    name: input.name,
    lastName: input.lastName,
    surName: input.surName,
    phone: input.phone,
    pickupCode,
    aereo: input.aereo,
    dimensions: input.dimensions,
  });
  if (!built.ok) return { error: built.errors.join(" ") };

  let client: ShalomClient;
  try {
    const made = clientFor(s);
    if (!made.sessionReady) {
      // Deliberado: no se crea la sesión acá. El login tarda ~90 s y hacerlo
      // dentro de esta llamada acerca peligrosamente el POST no idempotente al
      // límite de tiempo de la función.
      return {
        error:
          "No hay sesión de Shalom activa. Pulsa «Conectar con Shalom» y vuelve a intentarlo (la conexión tarda hasta 2 minutos la primera vez).",
      };
    }
    client = made.client;
  } catch {
    return { error: "No se pudieron descifrar las credenciales de Shalom. Vuelve a cargarlas en Ajustes." };
  }

  let result: Awaited<ReturnType<ShalomClient["createOrder"]>> | null = null;
  let recovered = false;

  try {
    result = await client.createOrder(built.payload);
  } catch (err) {
    // El caso peligroso: no hay respuesta y la guía puede existir igual. NO se
    // reintenta — se va a buscar. La documentación del proveedor es explícita:
    // "consulta primero GET /v1/orders para ver si la guía ya se creó, o la vas
    // a duplicar".
    if (err instanceof ShalomTimeoutError) {
      try {
        const orders = await client.recentOrders();
        const found = findCreatedOrder(orders, {
          document: built.payload.receiver.document,
          pickupCode: built.payload.pickup_code,
        });
        if (found?.guia) {
          result = {
            guia: String(found.guia),
            serie: found.serie ?? null,
            codigo: found.codigo ?? null,
            ose_id: typeof found.ose_id === "number" ? found.ose_id : null,
          };
          recovered = true;
        }
      } catch {
        /* la verificación también falló: se cae al mensaje de abajo */
      }
      if (!result) {
        return {
          error:
            "Shalom no respondió y NO se pudo verificar si la guía se creó. Revisa en pro.shalom.pe ANTES de reintentar: reintentar a ciegas crea una segunda guía real y cobrable.",
        };
      }
    } else {
      const shalomErr = err instanceof ShalomApiError ? err : null;
      // Un token vencido no es un fallo de datos: se limpia la caché para que
      // el siguiente intento vuelva a conectar en vez de repetir el 401.
      if (shalomErr?.isShalomAuth) await clearSession(admin, row.store_id);
      return { error: describeShalomError(err) };
    }
  }

  const guideCode = String(result?.guia ?? "").trim();
  if (!guideCode) {
    return {
      error:
        "Shalom respondió sin número de guía. Revisa en pro.shalom.pe si la guía se creó antes de reintentar.",
    };
  }

  const oseId = typeof result?.ose_id === "number" ? result.ose_id : null;

  const insertRow = {
    courier: "shalom",
    guide_code: guideCode,
    store_id: row.store_id,
    order_id: row.order_id,
    matched: true,
    match_method: "manual",
    order_name: row.order_name,
    customer_name: [built.payload.receiver.name, built.payload.receiver.last_name, built.payload.receiver.sur_name]
      .filter(Boolean)
      .join(" "),
    customer_phone: row.customer_phone,
    product: null,
    district: row.district,
    province: row.province,
    city: row.district,
    region: row.region,
    delivery_address: null,
    agency_branch: input.destinyTerminalName ?? null,
    // La guía nace creada pero el paquete todavía no salió del almacén: ese es
    // exactamente el sub-estado `pendiente_de_envio` del catálogo de agencia
    // (§10). No es `enviado_a_agencia` — eso lo dirá el reporte.
    delivery_status: "pendiente",
    status_category: "pending",
    pickup_state: "pendiente_de_envio",
    shalom_codigo: result?.codigo ?? null,
    shalom_serie: result?.serie ?? null,
    shalom_ose_id: oseId,
    shalom_raw: result as unknown as Record<string, unknown>,
    // La guía la emitió la integración, no un operador copiando de pro.shalom.pe.
    // Sin esta marca la salida quedaba con `created_via` nulo, igual que una
    // importada del reporte, y la columna no distinguía la vía normal de ninguna
    // otra: era el caso frecuente y era justo el que no se registraba.
    created_via: SHALOM_ORIGIN.api,
  };

  const inserted = await admin.from("shipments").insert(insertRow).select("id").single();
  if (inserted.error) {
    // La guía SÍ existe en Shalom: perderla de vista es peor que el error de
    // base, así que el mensaje lleva los identificadores para registrarla a mano.
    return {
      error: `La guía se creó en Shalom (${guideCode}${result?.codigo ? ` / ${result.codigo}` : ""}) pero no se pudo guardar acá: ${inserted.error.message}. Anótala y regístrala manualmente.`,
    };
  }

  // La clave de recojo, cifrada y en la tabla de siempre (0049). A partir de
  // acá el flujo es el de siempre: se revela cuando el cobro esté validado.
  const { data: previousKey } = await admin
    .from("shalom_pickup_keys")
    .select("order_id")
    .eq("order_id", row.order_id)
    .maybeSingle();

  const keyWrite = await admin.from("shalom_pickup_keys").upsert(
    {
      order_id: row.order_id,
      store_id: row.store_id,
      key_enc: encrypt(built.payload.pickup_code),
      created_by: userId,
      ...(previousKey ? { replaced_at: new Date().toISOString(), replaced_by: userId } : {}),
    },
    { onConflict: "order_id" },
  );

  await admin.from("order_events").insert({
    store_id: row.store_id,
    order_id: row.order_id,
    kind: "guide_created",
    occurred_at: new Date().toISOString(),
    actor: userId,
    source: "shalom",
    courier: "shalom",
    guide_code: guideCode,
    note:
      `Guía Shalom creada${recovered ? " (recuperada tras un corte de conexión)" : ""}.` +
      ` Destino: ${input.destinyTerminalName ?? input.destinyTerminalId}.` +
      ` Paga: ${built.payload.payer === "sender" ? "remitente" : "destinatario"}.` +
      // El motivo va en la NOTA, no solo en el payload: la línea de tiempo se
      // lee, el payload se consulta. Si alguien despachó sin cobro, tiene que
      // verse al abrir el pedido, no al escarbar.
      (soft.length ? ` CREADA SIN ADELANTO — motivo: ${overrideReason}` : ""),
    // La clave de recojo NO va en el evento: la línea de tiempo la ve cualquiera
    // con acceso al pedido, y la clave es la llave del paquete.
    payload: {
      source: SHALOM_ORIGIN.api,
      codigo: result?.codigo ?? null,
      serie: result?.serie ?? null,
      ose_id: oseId,
      destiny_terminal_id: built.payload.destiny_terminal_id,
      origin_terminal_id: built.payload.origin_terminal_id,
      product_id: built.payload.product_id,
      quantity: built.payload.quantity,
      payer: built.payload.payer,
      declaracion_jurada: built.payload.declaracion_jurada,
      recovered,
      ...(soft.length ? { override_reason: overrideReason, override_of: soft } : {}),
    },
  });

  await recomputeOrderMasterSafe(admin, [row.order_id]);
  revalidatePath(MASTER_PATH);

  const keyWarning = keyWrite.error
    ? ` ATENCIÓN: la clave de recojo NO se pudo guardar (${keyWrite.error.message}); regístrala a mano desde la salida Shalom en Salidas y guías.`
    : "";

  return {
    notice:
      `Guía Shalom creada: ${guideCode}${result?.codigo ? ` · código ${result.codigo}` : ""}.` +
      (recovered
        ? " Se recuperó de un corte de conexión: la guía ya existía en Shalom y no se duplicó."
        : "") +
      (keyWarning || " La clave de recojo quedó registrada y se revela desde la salida Shalom cuando el cobro esté validado."),
    guideCode,
    codigo: result?.codigo ?? null,
    recovered,
  };
}

/**
 * Anula en Shalom una guía creada por API y la marca anulada acá.
 *
 * Es la simétrica de crear, y por eso tiene su misma cautela: crear emite una
 * guía cobrable de un clic, así que deshacer no puede ser un clic más al lado.
 * La confirmación explícita vive en el modal; acá se revalida todo, porque un
 * botón deshabilitado no es una autorización.
 *
 * El `{id}` del borrado es el de `GET /v1/orders` (`shalom_order_id`), NO el
 * `ose_id` ni la guía. Es exactamente el motivo de que haya tres columnas.
 */
export async function cancelShalomGuide(
  shipmentId: string,
): Promise<{ notice: string } | { error: string }> {
  const perms = await getMasterPermissions();
  if (!perms.can("shalom.create_guide")) return { error: "Tu rol no permite anular guías Shalom." };

  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminSupabase();
  const { data: shipmentRow } = await admin
    .from("shipments")
    .select("id,store_id,order_id,courier,guide_code,delivery_status,pickup_state,shalom_order_id,shalom_codigo")
    .eq("id", shipmentId)
    .maybeSingle();
  if (!shipmentRow) return { error: "No se encontró la guía." };

  const guide = shipmentRow as {
    id: string;
    store_id: string;
    order_id: string | null;
    courier: string;
    guide_code: string | null;
    delivery_status: string;
    pickup_state: string | null;
    shalom_order_id: number | null;
    shalom_codigo: string | null;
  };
  if (!(await authorizeStore(guide.store_id))) return { error: "Sin acceso a esta tienda." };

  if (guide.courier !== "shalom") return { error: "Esta guía no es de Shalom." };
  if (!guide.shalom_order_id) {
    return {
      error:
        "Esta guía no se creó por API (llegó por el reporte), así que anularla hay que hacerlo en pro.shalom.pe.",
    };
  }
  if (!shalomGuideIsCancelable(guide)) {
    return {
      error:
        "Shalom ya no deja borrar esta guía: el paquete dejó de estar pendiente de envío. Si hay que anularla igual, se gestiona en agencia.",
    };
  }

  const store = await loadStoreShalom(admin, guide.store_id);
  const blocker = configurationBlocker(store);
  if (blocker) return { error: blocker };

  try {
    // Anular SÍ puede renovar sesión y reintentar, a diferencia de crear: borrar
    // es idempotente —borrar dos veces deja el mismo estado— mientras que un
    // segundo POST /v1/orders sería una segunda guía cobrable.
    await readWithFreshSession(admin, guide.store_id, store as StoreShalom, (client) =>
      client.deleteOrder(guide.shalom_order_id as number),
    );
  } catch (err) {
    return { error: `Shalom no anuló la guía: ${describeShalomError(err)}` };
  }

  // Solo se marca acá DESPUÉS de que Shalom confirme: al revés dejaría una guía
  // viva en Shalom y anulada en el panel, que es la peor de las dos mentiras.
  const updated = await admin
    .from("shipments")
    .update({
      delivery_status: "anulado",
      status_category: "closed",
      pickup_state: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", guide.id);
  if (updated.error) {
    return {
      error: `La guía SÍ se anuló en Shalom (${guide.guide_code ?? guide.shalom_order_id}) pero no se pudo marcar acá: ${updated.error.message}. Anótalo y corrígelo a mano.`,
    };
  }

  if (guide.order_id) {
    await admin.from("order_events").insert({
      store_id: guide.store_id,
      order_id: guide.order_id,
      kind: "guide_cancelled",
      occurred_at: new Date().toISOString(),
      actor: user.id,
      source: "shalom",
      courier: "shalom",
      guide_code: guide.guide_code,
      note: `Guía Shalom anulada${guide.shalom_codigo ? ` (código ${guide.shalom_codigo})` : ""}.`,
      payload: { shalom_order_id: guide.shalom_order_id, codigo: guide.shalom_codigo },
    });
    await recomputeOrderMasterSafe(admin, [guide.order_id]);
  }
  revalidatePath(MASTER_PATH);

  return {
    notice: `Guía Shalom anulada: ${guide.guide_code ?? guide.shalom_order_id}. La clave de recojo deja de tener paquete detrás.`,
  };
}

// ---------------------------------------------------------------------------
// Datos adelantados (0073)
// ---------------------------------------------------------------------------

export interface ShalomOrderDraftInput {
  documentType?: ShalomDocumentType | null;
  document?: string | null;
  destinyTerminalId?: number | null;
  destinyTerminalName?: string | null;
}

/**
 * Apunta por adelantado el destinatario y la agencia de un pedido.
 *
 * Se llama desde el panel de PAGOS, no desde el de guías, y a propósito: quien
 * registra el Yape acaba de hablar con la clienta y tiene el DNI a mano; quien
 * crea la guía suele ser otra persona y otro momento. Adelantar el dato ahí
 * ahorra volver a pedirlo.
 *
 * TODO es opcional, incluido no llamar a esta acción nunca: un cobro no puede
 * quedar bloqueado porque falte un DNI. Lo que se manda vacío se limpia, para
 * que corregir un dato mal puesto sea posible sin tener que borrar la fila.
 */
export async function saveShalomOrderDraft(
  orderId: string,
  input: ShalomOrderDraftInput,
): Promise<{ notice: string } | { error: string }> {
  const ctx = await authorize(orderId);
  if (!ctx) return { error: "Sin acceso a este pedido." };
  const { row } = ctx;

  // Con la guía ya creada, esto deja de ser un borrador: Shalom tiene el
  // destinatario y el destino, y los imprimió en su rótulo. Reescribirlo acá no
  // cambia nada allá — solo hace que Kapta y el papel que viaja con el paquete
  // digan cosas distintas. El panel ya no ofrece los campos; esto lo sostiene
  // también desde el servidor, porque esconder un formulario no es una regla.
  //
  // Se ignora en vez de fallar: este guardado ocurre DESPUÉS de registrar un
  // pago y no puede convertir un cobro correcto en un error rojo.
  const admin = createAdminSupabase();
  const { data: liveGuides } = await admin
    .from("shipments")
    .select("guide_code,delivery_status,custody_state")
    .eq("order_id", orderId)
    .eq("courier", "shalom");
  const live = ((liveGuides as { guide_code: string | null; delivery_status: string; custody_state: string | null }[] | null) ?? []).find(
    (guide) =>
      guide.custody_state !== "devuelto" &&
      ["pendiente", "en_ruta", "por_preparar"].includes(guide.delivery_status),
  );
  if (live) {
    return {
      notice: `La guía ${live.guide_code ?? "Shalom"} ya lleva el destinatario y el destino; para cambiarlos hay que anularla y crear otra.`,
    };
  }

  const documentType = input.documentType ?? null;
  const rawDocument = (input.document ?? "").trim();
  // Se valida con la misma función que usa la creación de la guía: apuntar acá
  // un documento que Shalom va a rechazar solo mueve el error más tarde, a
  // manos de alguien que ya no tiene a la clienta al teléfono.
  if (rawDocument && documentType) {
    const problem = documentError(documentType, rawDocument);
    if (problem) return { error: problem };
  }
  const document = rawDocument ? normalizeDocument(documentType ?? "DNI", rawDocument) : null;

  const terminalId = Number(input.destinyTerminalId ?? 0);
  const { error } = await admin.from("shalom_order_drafts").upsert(
    {
      order_id: orderId,
      store_id: row.store_id,
      document_type: document ? (documentType ?? "DNI") : null,
      document,
      destiny_terminal_id: Number.isFinite(terminalId) && terminalId > 0 ? terminalId : null,
      destiny_terminal_name: (input.destinyTerminalName ?? "").trim() || null,
      updated_by: ctx.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "order_id" },
  );
  if (error) return { error: error.message };

  revalidatePath(MASTER_PATH);
  return { notice: "Datos de Shalom guardados para cuando se cree la guía." };
}

/** Lo apuntado por adelantado, para pintarlo en el panel de pagos. */
export async function loadShalomOrderDraft(
  orderId: string,
): Promise<{ draft: ShalomOrderDraftInput | null } | { error: string }> {
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("shalom_order_drafts")
    .select("document_type,document,destiny_terminal_id,destiny_terminal_name")
    .eq("order_id", orderId)
    .maybeSingle();
  if (!data) return { draft: null };
  const row = data as {
    document_type: string | null;
    document: string | null;
    destiny_terminal_id: number | null;
    destiny_terminal_name: string | null;
  };
  return {
    draft: {
      documentType: (row.document_type as ShalomDocumentType | null) ?? null,
      document: row.document,
      destinyTerminalId: row.destiny_terminal_id,
      destinyTerminalName: row.destiny_terminal_name,
    },
  };
}
