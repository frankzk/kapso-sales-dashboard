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
  buildShalomOrderPayload,
  generatePickupCode,
  splitReceiverName,
  suggestedAgencyQuery,
  shalomGuideIsCancelable,
  DEFAULT_DECLARACION,
  DEFAULT_PAYER,
} from "@/lib/shalom/draft";
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
  /** Clave de recojo generada en el servidor. Solo viaja si el rol puede verla. */
  pickupCode: string | null;
  /** Motivos para NO crear la guía todavía. */
  blockers: string[];
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
  const warnings: string[] = [];

  const configBlocker = configurationBlocker(store);
  if (configBlocker) blockers.push(configBlocker);

  for (const g of await activeGuides(admin, orderId)) {
    blockers.push(
      `El pedido ya tiene una guía activa: ${g.guide_code} (${g.courier}, ${g.delivery_status}). Anúlala antes de crear otra.`,
    );
  }

  if (["entregado", "devuelto", "anulado"].includes(row.general_status)) {
    blockers.push(`El pedido está ${row.general_status.replace("_", " ")}.`);
  }

  // Shalom identifica al destinatario por documento y el pedido no lo trae:
  // Shopify no pide DNI. Es el único dato que el operador escribe siempre.
  warnings.push(
    "Shalom exige el documento del destinatario y el pedido no lo trae: pídeselo al cliente antes de crear la guía.",
  );

  if (row.payment_state !== "pago_completo") {
    warnings.push(
      "El pedido todavía no tiene el pago completo validado. La guía se puede crear igual, pero la clave de recojo seguirá bloqueada hasta que se valide.",
    );
  }

  const split = splitReceiverName(row.customer_name);

  // La clave se genera en el servidor y NO viaja al cliente salvo que el rol ya
  // tenga permiso de verla: es la llave del paquete. Quien crea la guía no
  // necesita conocerla — se revela por el panel de pagos, con auditoría.
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
      pickupCode: perms.can("shalom.view_pickup_key") ? pickupCode : null,
      blockers,
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
      ` Paga: ${built.payload.payer === "sender" ? "remitente" : "destinatario"}.`,
    // La clave de recojo NO va en el evento: la línea de tiempo la ve cualquiera
    // con acceso al pedido, y la clave es la llave del paquete.
    payload: {
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
    },
  });

  await recomputeOrderMasterSafe(admin, [row.order_id]);
  revalidatePath(MASTER_PATH);

  const keyWarning = keyWrite.error
    ? ` ATENCIÓN: la clave de recojo NO se pudo guardar (${keyWrite.error.message}); regístrala a mano desde el panel de pagos.`
    : "";

  return {
    notice:
      `Guía Shalom creada: ${guideCode}${result?.codigo ? ` · código ${result.codigo}` : ""}.` +
      (recovered
        ? " Se recuperó de un corte de conexión: la guía ya existía en Shalom y no se duplicó."
        : "") +
      (keyWarning || " La clave de recojo quedó registrada y se revela desde el panel de pagos cuando el cobro esté validado."),
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
