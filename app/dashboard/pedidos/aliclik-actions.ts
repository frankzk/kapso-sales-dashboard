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
import { writeCourierGuide } from "@/lib/route-output-fill";
import { isFillableRouteOutput } from "@/lib/shipment-output";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { getMasterPermissions } from "@/lib/permissions-access";
import { normalizeDistrictKey } from "@/lib/district-coverage";
import { saveDistrictCoverageRow } from "@/lib/district-coverage-access";
import { getStoreCreds } from "@/lib/ingest";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { getOrderMasterDetail } from "@/lib/orders-master-access";
import { classifyOperation } from "@/lib/order-macro-stage";
import { normalizePhone } from "@/lib/phone";
import { categoryOf, reconcileDeliveryStatus } from "@/lib/shipments";
import {
  cancelOrder,
  createOrder,
  getOrder,
  interpretCancelResponse,
  listOrders,
  quoteShippingCost,
  type AliclikClientOpts,
  type AliclikCourierQuote,
  type AliclikOrder,
} from "@/lib/aliclik";
import {
  isCompatibleManualPortalGuide,
  selectExistingAliclikOrder,
} from "@/lib/aliclik-existing-guide";
import { aliclikStatusLabel, mapAliclikStatus } from "@/lib/aliclik-status";
import { lockedIntentMessage, type LockedIntent } from "@/lib/aliclik-orphan-expiry";
import {
  loadCatalogFor,
  hydrateOrderLineSkusFromCatalog,
  resolveAliclikItems,
  type OrderLineInput,
  type ResolvedItem,
} from "@/lib/aliclik-catalog";
import { listActiveShopifyCatalogVariants, type ShopifyClientOpts } from "@/lib/shopify";
import { canAdoptExistingGuide } from "@/lib/aliclik-orphans";
import { MAX_ACCEPTABLE_LOSS, reconcileToOrderTotal } from "@/lib/aliclik-money";
import { stampOrderMarker } from "@/lib/aliclik-reconcile";
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

export interface ExistingAliclikGuidePreview {
  ok: boolean;
  error?: string;
  guideCode?: string;
  orderNumber?: string;
  matchExplanation?: string;
  customerName?: string | null;
  customerPhone?: string | null;
  total?: number | null;
  productDetail?: string | null;
  statusLabel?: string;
  shippingAddress?: string | null;
  shippingDistrict?: string | null;
  shippingProvince?: string | null;
  shippingDepartment?: string | null;
  phoneMatches?: boolean | null;
  totalMatches?: boolean | null;
  alreadyLinked?: boolean;
  verificationMode?: "api" | "manual_portal";
  /**
   * ¿El código impreso lleva dentro el número del pedido? Es una CORROBORACIÓN,
   * no un requisito: solo la familia de seis dígitos lo cumple, y una guía
   * creada en el portal puede salir con un código de otra familia. Cuando es
   * false, lo único que sostiene el vínculo es la palabra de quien lo afirma, y
   * la pantalla tiene que decirlo con esas letras.
   */
  codeMatchesOrder?: boolean;
  expectedOrderName?: string | null;
  apiCandidateCount?: number;
  apiMatchSummary?: string;
}

interface ExistingGuideResolution {
  ctx: AliclikContext;
  order: AliclikOrder;
  guideCode: string;
  preview: ExistingAliclikGuidePreview;
}

function manualPortalOrder(ctx: AliclikContext, guideCode: string): AliclikOrder {
  return {
    orderNumber: guideCode,
    total: ctx.row.order_total,
    createdAt: ctx.row.order_created_at,
    customer: {
      name: ctx.row.customer_name,
      phone: ctx.row.customer_phone,
    },
    shipping: {
      address1: ctx.row.address,
      reference: ctx.row.reference,
      lat: ctx.row.latitude == null ? null : String(ctx.row.latitude),
      lng: ctx.row.longitude == null ? null : String(ctx.row.longitude),
      departmentName: ctx.row.region,
      provinceName: ctx.row.province,
      districtName: ctx.row.district,
    },
  };
}

// ---------------------------------------------------------------------------
// Contexto y guardas
// ---------------------------------------------------------------------------

interface AliclikContext {
  userId: string;
  storeId: string;
  row: OrderMasterRow;
  client: AliclikClientOpts;
  clients: AliclikClientOpts[];
  shopify: ShopifyClientOpts | null;
}

/**
 * Autoriza y prepara el cliente. La lectura del pedido va por RLS: un pedido de
 * otra tienda simplemente no aparece, así que la comprobación de acceso es la
 * propia consulta.
 */
async function authorize(
  orderId: string,
  permission: "aliclik.create_guide" | "aliclik.cancel_guide",
  opts: { coverageProbe?: boolean } = {},
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

  // Aliclik no atiende Agencia: esos pedidos van con Shalom u Olva. El plan de
  // rutas ya no lo ofrece y el drawer ya no dibuja el panel, pero esconder un
  // botón no es una regla —el mismo criterio que se aplica a Tanders fuera de
  // Lima—, así que también se rechaza aquí.
  //
  // Solo bloquea CREAR y VINCULAR. Anular sigue permitido: un pedido puede
  // haberse reclasificado después de tener su guía, y dejarlo sin poder cerrarla
  // sería peor que el problema que esto evita.
  // La COMPROBACIÓN DE COBERTURA es la excepción, y por eso lleva su propia
  // puerta. Cotizar es un GET: no crea guía, no reserva stock, no cuesta nada.
  // La clasificación decide a dónde va el paquete, no si tenemos derecho a
  // preguntarle a Aliclik si llega — y mientras la pregunta estuvo detrás de la
  // respuesta, una clasificación equivocada no se podía desmentir nunca. Fue el
  // caso de Pisac: la operación sabía que Aliclik cubre, y el pedido no ofrecía
  // ni el botón de cotizar porque figuraba como Agencia.
  //
  // Escribir sigue cerrado: crear y vincular pasan por aquí sin la excepción.
  if (
    permission === "aliclik.create_guide" &&
    !opts.coverageProbe &&
    classifyOperation(row) === "agencia"
  ) {
    return {
      error:
        "Este pedido tiene cobertura Agencia y va con Shalom u Olva; Aliclik no lo atiende. " +
        "Si la dirección está mal clasificada, corrígela en Ubicación y cobertura.",
    };
  }

  const admin = createAdminSupabase();
  const creds = await getStoreCreds(row.store_id, admin);
  if (!creds) return { error: "No se pudo leer la configuración de la tienda." };

  // Aurela y Kenku son tiendas Shopify separadas, pero comparten una sola
  // tienda Aliclik (AURELA/KENKU). Las lecturas deben poder usar cualquiera de
  // las credenciales Aliclik habilitadas de la organización.
  const { data: orgStores, error: orgStoresError } = await admin
    .from("stores")
    .select("id")
    .eq("org_id", creds.org_id)
    .eq("aliclik_enabled", true);
  if (orgStoresError) {
    return { error: "No se pudo leer la configuración compartida de Aliclik." };
  }

  const siblingCreds = await Promise.all(
    (orgStores ?? []).map((store) => getStoreCreds(store.id, admin)),
  );
  const tokens = [
    creds.aliclik_enabled ? creds.aliclik_api_token : null,
    ...siblingCreds.map((candidate) =>
      candidate?.aliclik_enabled ? candidate.aliclik_api_token : null,
    ),
  ].filter((token): token is string => Boolean(token));
  const clients = [...new Set(tokens)].map((apiToken) => ({ apiToken }));
  if (!clients.length) {
    return {
      error:
        "La organización no tiene una conexión Aliclik habilitada " +
        "(Ajustes → Aliclik).",
    };
  }

  return {
    ctx: {
      userId: user.id,
      storeId: row.store_id,
      row,
      client: clients[0]!,
      clients,
      shopify:
        creds.shopify_token && creds.shopify_domain
          ? { domain: creds.shopify_domain, token: creds.shopify_token }
          : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Preview / cotización — NO escribe nada hacia afuera
// ---------------------------------------------------------------------------

function normalizeExternalGuideCode(value: string): string | null {
  const code = value.trim().replace(/^#+/, "").toUpperCase();
  if (!/^[A-Z0-9-]{4,80}$/.test(code)) return null;
  return code;
}

function samePhone(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const left = normalizePhone(a);
  const right = normalizePhone(b);
  if (!left || !right) return null;
  return left.replace(/\D/g, "").slice(-9) === right.replace(/\D/g, "").slice(-9);
}

async function resolveExistingAliclikGuide(
  orderId: string,
  rawGuideCode: string,
): Promise<{ resolution?: ExistingGuideResolution; error?: string }> {
  const code = normalizeExternalGuideCode(rawGuideCode);
  if (!code) return { error: "Escribe un número de guía Aliclik válido." };

  const { ctx, error } = await authorize(orderId, "aliclik.create_guide");
  if (!ctx) return { error };

  const numericSuffix = code.match(/\d{4,}$/)?.[0] ?? null;
  const customerPhone = normalizePhone(ctx.row.customer_phone);
  const customerPhoneLocal = customerPhone?.replace(/\D/g, "").slice(-9) || null;
  const createdAt = Date.parse(ctx.row.order_created_at ?? "");
  const recentStart = new Date(
    Number.isFinite(createdAt)
      ? Math.max(createdAt - 2 * 24 * 60 * 60_000, Date.now() - 120 * 24 * 60 * 60_000)
      : Date.now() - 30 * 24 * 60 * 60_000,
  );
  const dateKey = (date: Date) => date.toISOString().slice(0, 10);
  let remoteOrder: AliclikOrder | null = null;
  let matchExplanation: string | undefined;
  let verificationMode: "api" | "manual_portal" = "api";
  let codeMatchesOrder = false;
  let apiCandidateCount: number | undefined;
  let apiMatchSummary: string | undefined;
  if (/^ALC/i.test(code)) {
    const errors: string[] = [];
    for (const client of ctx.clients) {
      const remote = await getOrder(client, code, {
        searchTerms: [numericSuffix, customerPhone, customerPhoneLocal],
        startDate: dateKey(recentStart),
        endDate: dateKey(new Date(Date.now() + 24 * 60 * 60_000)),
        maxPagesPerQuery: 10,
        scanUnfiltered: true,
      });
      if (!remote.ok) {
        errors.push(remote.error);
        continue;
      }
      if (remote.data) {
        remoteOrder = remote.data;
        ctx.client = client;
        break;
      }
    }
    if (!remoteOrder && errors.length === ctx.clients.length) {
      return { error: `No se pudo consultar Aliclik: ${errors[0]}` };
    }
  } else {
    const candidates = new Map<
      string,
      { order: AliclikOrder; client: AliclikClientOpts }
    >();
    const errors: string[] = [];
    for (const client of ctx.clients) {
      // Si Aliclik expone el código impreso como `orderNumber`, esa igualdad
      // exacta es la identidad de la guía. No debe depender además del puntaje
      // por nota, teléfono o destino: esos campos se enseñan en la vista previa
      // para que la operadora los corrobore antes de confirmar el vínculo.
      const exact = await getOrder(client, code, {
        searchTerms: [numericSuffix, customerPhone, customerPhoneLocal],
        startDate: dateKey(recentStart),
        endDate: dateKey(new Date(Date.now() + 24 * 60 * 60_000)),
        maxPagesPerQuery: 10,
        scanUnfiltered: true,
      });
      if (!exact.ok) {
        errors.push(exact.error);
      } else if (exact.data) {
        remoteOrder = exact.data;
        matchExplanation = "código de guía exacto";
        ctx.client = client;
        break;
      }

      // El código impreso AUR5X... no siempre es el `orderNumber` técnico que
      // devuelve la integración. Antes del barrido reciente, aprovechamos la
      // búsqueda parcial de Aliclik con todas las referencias conocidas.
      const searchTerms = [
        code,
        numericSuffix,
        ctx.row.order_name?.replace(/^#+/, ""),
        customerPhone,
        customerPhoneLocal,
      ]
        .filter((term): term is string => Boolean(term))
        .filter((term, index, all) => all.indexOf(term) === index);
      for (const term of searchTerms) {
        const result = await listOrders(client, {
          page: 1,
          limit: 100,
          orderNumber: term,
        });
        if (!result.ok) {
          errors.push(result.error);
          continue;
        }
        for (const order of result.data.data ?? []) {
          const key = normalizeExternalGuideCode(order.orderNumber ?? "");
          if (key && !candidates.has(key)) candidates.set(key, { order, client });
        }
      }
      for (let page = 1; page <= 10; page++) {
        const result = await listOrders(client, {
          page,
          limit: 100,
          startDate: dateKey(recentStart),
          endDate: dateKey(new Date(Date.now() + 24 * 60 * 60_000)),
        });
        if (!result.ok) {
          errors.push(result.error);
          break;
        }
        for (const order of result.data.data ?? []) {
          const key = normalizeExternalGuideCode(order.orderNumber ?? "");
          if (key && !candidates.has(key)) candidates.set(key, { order, client });
        }
        const totalPages = Math.max(1, result.data.pagination?.totalPages ?? 1);
        if (page >= totalPages || !(result.data.data ?? []).length) break;
      }
    }
    if (!remoteOrder) {
      // La igualdad exacta ya resolvió la guía; el heurístico se aplica
      // únicamente cuando Aliclik oculta el código impreso.
      if (!candidates.size && errors.length === ctx.clients.length) {
        return { error: `No se pudo consultar Aliclik: ${errors[0]}` };
      }
      const selected = selectExistingAliclikOrder(
        [...candidates.values()].map(({ order }) => order),
        {
          guideCode: code,
          orderName: ctx.row.order_name,
          customerPhone: ctx.row.customer_phone,
          orderTotal: ctx.row.order_total,
          region: ctx.row.region,
          province: ctx.row.province,
          district: ctx.row.district,
        },
      );
      if (selected.ok) {
        remoteOrder = selected.match.order;
        matchExplanation = selected.match.reasons.join(", ");
        const key = normalizeExternalGuideCode(remoteOrder.orderNumber ?? "");
        if (key) ctx.client = candidates.get(key)?.client ?? ctx.client;
      } else if (selected.reason === "ambiguous") {
        return {
          error:
            `Aliclik no expone el código impreso ${code} por API y encontramos más de un pedido ` +
            "posible. No se vinculó nada; usa el código ALC del pedido para confirmar cuál corresponde.",
        };
      } else {
        const best = selected.matches[0];
        const matched = best?.reasons.length ? best.reasons.join(", ") : "ningún campo";

        // Un ALC que no aparece en la API no es una guía de portal: es un código
        // que no existe en la cuenta. Ahí no hay nada que atestiguar y se cae al
        // error de más abajo.
        if (!/^ALC/i.test(code)) {
          // GET /integration/order documenta expresamente que devuelve los
          // “pedidos de tu integración”. Una guía AUR5X creada en el portal
          // compartido no forma parte de esos pedidos ALC. Construimos una vista
          // previa local; la escritura exigirá una confirmación auditada.
          //
          // EL SUFIJO YA NO ES LA PUERTA. Se exigía que el código terminara en el
          // número del pedido, y eso solo lo cumple la familia de seis dígitos:
          // medido sobre 3.976 guías, de las de 7 y 12 dígitos ninguna lo hace.
          // Con la guarda anterior, una guía creada en la web de Aliclik que
          // saliera con código largo era IMPOSIBLE de vincular desde el Master
          // —le pasó a AUR5X7478480 con #KP128572— y el operador se quedaba sin
          // salida para un paquete que ya existía.
          //
          // Lo que sostiene esta vinculación no es el sufijo: es la confirmación
          // auditada que viene después —escribir el código del pedido y dar un
          // motivo— más la guarda de que la guía no cuelgue ya de otro pedido.
          // El sufijo pasa a ser lo que siempre fue, una corroboración: cuando
          // está, se enseña; cuando no, la pantalla avisa de que no hay más
          // respaldo que la palabra de quien firma.
          codeMatchesOrder = isCompatibleManualPortalGuide(code, ctx.row.order_name);
          remoteOrder = manualPortalOrder(ctx, code);
          verificationMode = "manual_portal";
          matchExplanation = codeMatchesOrder ? "sufijo exacto del pedido Shopify" : undefined;
          apiCandidateCount = candidates.size;
          apiMatchSummary = matched;
        }
      }
    }
  }
  if (!remoteOrder) {
    return {
      error:
        /^ALC/i.test(code)
          ? `El pedido ${code} no aparece en la cuenta compartida AURELA/KENKU de Aliclik.`
          : `No pudimos relacionar ${code} con un pedido Aliclik de forma segura. ` +
            "Verifica que tenga el mismo pedido Shopify, teléfono, monto y destino.",
    };
  }

  const orderNumber = normalizeExternalGuideCode(remoteOrder.orderNumber ?? "");
  if (!orderNumber) return { error: "Aliclik devolvió la guía sin un número identificador válido." };

  const admin = createAdminSupabase();
  const [externalLookup, guideLookup] = await Promise.all([
    admin
      .from("shipments")
      .select("order_id,order_name")
      .eq("courier", "aliclik")
      .ilike("external_order_number", orderNumber)
      .limit(1)
      .maybeSingle(),
    admin
      .from("shipments")
      .select("order_id,order_name")
      .eq("courier", "aliclik")
      .ilike("guide_code", code)
      .limit(1)
      .maybeSingle(),
  ]);
  if (externalLookup.error || guideLookup.error) {
    return {
      error:
        "No se pudo comprobar si la guía ya está vinculada. No se realizó ningún cambio.",
    };
  }
  const byExternal = externalLookup.data;
  const byGuide = guideLookup.data;
  const linked = (byExternal ?? byGuide) as {
    order_id: string | null;
    order_name: string | null;
  } | null;
  if (linked?.order_id && linked.order_id !== orderId) {
    // NO ES UN CALLEJÓN SIN SALIDA, y decirlo importa. Esta acción es para traer
    // de Aliclik una guía que aún no conocemos; mover una que ya está en otro
    // pedido es otra cosa —una corrección— y tiene su propia herramienta, que
    // renumera la salida y recalcula los dos pedidos. Sin esta frase, quien se
    // topa con el error concluye que no se puede y acaba pidiendo que alguien
    // toque la base: pasó con AUR5X121336, enganchada por teléfono al pedido
    // anterior del mismo cliente.
    return {
      error:
        `La guía ${code} ya está vinculada a ${linked.order_name ?? "otro pedido"}. ` +
        "No se modificó ningún vínculo. Para traerla a ESTE pedido usa «Gestión manual → " +
        "correcciones excepcionales → Corregir vínculo de guía», que la mueve dejando " +
        "constancia en los dos pedidos.",
    };
  }

  const { data: activeRows, error: activeError } = await admin
    .from("shipments")
    .select("guide_code,external_order_number,delivery_status")
    .eq("order_id", orderId)
    .not("delivery_status", "in", "(anulado,transferido)");
  if (activeError) {
    return {
      error:
        "No se pudo comprobar si este pedido ya tiene una guía activa. No se realizó ningún cambio.",
    };
  }
  const activeOther = (
    (activeRows ?? []) as {
      guide_code: string;
      external_order_number: string | null;
      delivery_status: string;
    }[]
  ).find(
    (guide) =>
      guide.guide_code.toUpperCase() !== code.toUpperCase() &&
      guide.external_order_number?.toUpperCase() !== orderNumber.toUpperCase(),
  );
  if (activeOther) {
    return {
      error:
        `Este pedido ya tiene una guía activa (${activeOther.guide_code}). ` +
        "Cancélala o corrige ese vínculo antes de añadir otra.",
    };
  }

  const customerName =
    [remoteOrder.customer?.name, remoteOrder.customer?.lastName]
      .filter(Boolean)
      .join(" ")
      .trim() || null;
  const total = remoteOrder.total ?? null;
  const preview: ExistingAliclikGuidePreview = {
    ok: true,
    guideCode: code,
    orderNumber,
    matchExplanation,
    customerName,
    customerPhone: remoteOrder.customer?.phone ?? null,
    total,
    productDetail: remoteOrder.productDetail ?? null,
    statusLabel:
      verificationMode === "manual_portal"
        ? "Creada directamente en el portal Aliclik"
        : aliclikStatusLabel(remoteOrder),
    shippingAddress: remoteOrder.shipping?.address1 ?? null,
    shippingDistrict: remoteOrder.shipping?.districtName ?? null,
    shippingProvince: remoteOrder.shipping?.provinceName ?? null,
    shippingDepartment: remoteOrder.shipping?.departmentName ?? null,
    phoneMatches:
      verificationMode === "manual_portal"
        ? null
        : samePhone(remoteOrder.customer?.phone, ctx.row.customer_phone),
    totalMatches:
      total == null || ctx.row.order_total == null
        ? null
        : verificationMode === "manual_portal"
          ? null
          : Math.abs(total - ctx.row.order_total) <= 0.01,
    alreadyLinked: linked?.order_id === orderId,
    verificationMode,
    codeMatchesOrder,
    expectedOrderName: ctx.row.order_name,
    apiCandidateCount,
    apiMatchSummary,
  };

  return { resolution: { ctx, order: remoteOrder, guideCode: code, preview } };
}

/**
 * Consulta Aliclik antes de escribir. Además de confirmar existencia, muestra
 * cliente, teléfono, monto y destino para impedir vínculos por tanteo.
 */
export async function previewExistingAliclikGuide(
  orderId: string,
  guideCode: string,
): Promise<ExistingAliclikGuidePreview> {
  const { resolution, error } = await resolveExistingAliclikGuide(orderId, guideCode);
  if (!resolution) return { ok: false, error };
  return resolution.preview;
}

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
  /** Nombre del pedido (#KP…). La operadora tiene que VER sobre cuál crea. */
  orderName?: string | null;
  /** Lo que Aliclik cobrará en la puerta. Es la cifra que hay que enseñar. */
  collectTotal?: number;
  /** Total del pedido en Shopify. Si difiere de `collectTotal`, se avisa. */
  orderTotal?: number | null;
  coordinate?: { lat: string; lng: string };
  /** Falta la coordenada: la interfaz debe pedirla antes de seguir. */
  needsCoordinate?: boolean;
  /**
   * El pedido acaba de crearse y Shopify todavía no nos ha devuelto su
   * dirección. NO es un error ni hay nada que la operadora deba hacer: el
   * webhook llega en segundos y trae dirección Y coordenada geocodificada.
   * Se distingue de `needsCoordinate` a propósito — pedirle un enlace de Maps
   * aquí sería pedirle trabajo que el sistema va a hacer solo.
   */
  notReady?: boolean;
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
  input: {
    coordinate?: string | null;
    modality?: "cod" | "agency";
    /**
     * Comprobación de cobertura sobre un pedido clasificado como Agencia. Solo
     * levanta la puerta de la clasificación para poder COTIZAR; crear sigue
     * cerrado, así que lo peor que puede pasar es enterarse de un precio.
     */
    coverageProbe?: boolean;
  } = {},
): Promise<AliclikPreview> {
  const { ctx, error } = await authorize(orderId, "aliclik.create_guide", {
    coverageProbe: input.coverageProbe,
  });
  if (!ctx) return { ok: false, error };

  // Pedido recién creado desde Leads: la fila local existe (la acción del botón
  // verde recalcula el Master), pero la dirección llega con el webhook de
  // Shopify unos segundos después. Sin dirección no se puede ni cotizar ni
  // crear, así que se dice que hay que esperar — no que falte una coordenada.
  // El límite de tiempo importa: pasados unos minutos ya NO es una carrera,
  // es un pedido roto, y entonces sí hay que enseñar el problema de verdad.
  if (!ctx.row.address) {
    const createdAt = Date.parse(ctx.row.order_created_at ?? "");
    const fresh = Number.isFinite(createdAt) && Date.now() - createdAt < 10 * 60_000;
    if (fresh) {
      return {
        ok: false,
        notReady: true,
        error: "Esperando la dirección de Shopify. Tarda unos segundos.",
      };
    }
  }

  const modality = input.modality ?? "cod";
  const admin = createAdminSupabase();

  // 1. Productos → EAN → un solo almacén.
  const detail = await getOrderMasterDetail(orderId);
  if (!detail) return { ok: false, error: "No se pudo cargar el detalle del pedido." };

  const { skus, mapping } = await loadCatalogFor(ctx.storeId, admin);
  let orderLines: OrderLineInput[] = detail.lineItems.map((line) => ({
    title: line.title,
    variantTitle: line.variant_title,
    sku: line.sku,
    productId: line.product_id,
    variantId: line.variant_id,
    quantity: line.quantity,
    price: line.price,
  }));

  // Un pedido conserva el SKU que tenía al crearse. Si en Shopify se asignó
  // después (caso ASTAXANTINA), la asociación del catálogo ya existe pero la
  // línea histórica sigue vacía. Solo consultamos el catálogo vivo cuando hace
  // falta y recuperamos el SKU por IDs estables o una coincidencia inequívoca.
  if (orderLines.some((line) => !line.sku?.trim()) && ctx.shopify) {
    try {
      const activeVariants = await listActiveShopifyCatalogVariants(ctx.shopify);
      orderLines = hydrateOrderLineSkusFromCatalog(orderLines, activeVariants);
    } catch {
      // El resolutor emitirá el bloqueo conservador "sin SKU". No se crea una
      // guía con una identidad de producto que no se pudo verificar.
    }
  }
  const resolved = resolveAliclikItems(
    orderLines,
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

  // 1-bis. EL DINERO. Aliclik cobra la suma de `precio × cantidad` y no tiene
  //        campo de descuento, pero los precios de Shopify son los de LISTA
  //        (`originalUnitPriceSet`, antes de descuentos). Mandarlos tal cual
  //        cobró S/447 en un pedido de S/298. Se cuadran contra el total real.
  const money = reconcileToOrderTotal(resolved.items, ctx.row.order_total);
  if (!money) {
    const total = ctx.row.order_total;
    const units = resolved.items.reduce((s, i) => s + i.quantity, 0);
    return {
      ok: false,
      error:
        total == null || total <= 0
          ? "No se puede determinar cuánto hay que cobrarle a la clienta: el pedido no tiene un total válido. " +
            "No se crea la guía a ciegas, porque Aliclik cobraría el precio de lista sin descuentos."
          : `Aliclik solo cobra importes enteros, y con ${units} unidad(es) no hay ninguno que se acerque a ` +
            `S/ ${Number(total).toFixed(2)} sin dejar de cobrar más de S/ ${MAX_ACCEPTABLE_LOSS.toFixed(2)}. ` +
            "Crea esta guía desde el panel de Aliclik, o ajusta el pedido para que el total sea alcanzable.",
    };
  }
  const priced = { ...resolved, items: money.items };

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
      items: priced.items,
      orderName: ctx.row.order_name,
      collectTotal: money.total,
      orderTotal: ctx.row.order_total,
      error:
        "Este pedido no tiene coordenada, y Aliclik la exige para cotizar y crear. Pega el enlace de Google Maps que mandó la clienta.",
    };
  }
  const lat = toAliclikCoord(coord.lat);
  const lng = toAliclikCoord(coord.lng);

  // 3. Cotización. El mismo EAN puede existir en varios almacenes y Aliclik
  // puede fallar para uno aunque otro compatible cotice correctamente. Repetir
  // tres veces el mismo warehouseId no cubre ese caso: primero probamos una vez
  // cada almacén que contiene TODOS los EAN. Solo si todos fallan de forma
  // transitoria se aplican los reintentos sobre el almacén operativo preferido.
  const candidates = resolved.warehouseCandidates.slice(0, 4);
  const failures: {
    warehouseId: number;
    error: string;
    status: number | null;
    requestRef?: string;
  }[] = [];
  let quotedWarehouse = candidates[0] ?? {
    id: resolved.warehouseId,
    name: resolved.warehouseName,
  };
  let quote: Awaited<ReturnType<typeof quoteShippingCost>> | null = null;

  for (const candidate of candidates) {
    const attempt = await quoteShippingCost(
      ctx.client,
      { warehouseId: candidate.id, lat, lng },
      { retry: false },
    );
    if (attempt.ok) {
      quote = attempt;
      quotedWarehouse = candidate;
      break;
    }
    failures.push({
      warehouseId: candidate.id,
      error: attempt.error,
      status: attempt.status,
      requestRef: attempt.requestRef,
    });
  }

  if (!quote) {
    const preferred = candidates[0] ?? quotedWarehouse;
    const allTransient =
      failures.length > 0 &&
      failures.every((failure) => failure.status == null || failure.status >= 500);
    if (allTransient) {
      const retried = await quoteShippingCost(ctx.client, {
        warehouseId: preferred.id,
        lat,
        lng,
      });
      if (retried.ok) {
        quote = retried;
        quotedWarehouse = preferred;
      } else {
        failures.push({
          warehouseId: preferred.id,
          error: retried.error,
          status: retried.status,
          requestRef: retried.requestRef,
        });
      }
    }
    if (!quote) {
      const attempted = [...new Set(failures.map((failure) => failure.warehouseId))].join(", ");
      const refs = [
        ...new Set(
          failures
            .map((failure) => failure.requestRef)
            .filter((ref): ref is string => Boolean(ref)),
        ),
      ].join(", ");
      return {
        ok: false,
        error:
          `${failures.at(-1)?.error ?? "Aliclik no respondió."} ` +
          `Almacén(es) compatibles probados: ${attempted || resolved.warehouseId}.` +
          (refs ? ` Referencia(s): ${refs}.` : ""),
        coordinate: { lat, lng },
      };
    }
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
    warehouseId: quotedWarehouse.id,
    warehouseName: quotedWarehouse.name,
    items: priced.items,
    orderName: ctx.row.order_name,
    collectTotal: money.total,
    orderTotal: ctx.row.order_total,
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
  /**
   * El monto que la operadora VIO en el preview. El servidor lo recalcula y
   * aborta si no coincide.
   *
   * No es paranoia: entre cotizar y pulsar, alguien pudo editar el pedido en
   * Shopify (quitar un descuento, cambiar una cantidad) y la guía saldría con
   * un importe distinto del que se aprobó. Cobrar mal en la puerta es
   * irreversible y lo paga la clienta.
   */
  expectedCollectTotal?: number | null;
}

/**
 * Cuánto aguanta una intención en 'pending' antes de que el barrido la caduque.
 * Es el mismo valor que aplica el cron; aquí solo sirve para decirle a la
 * operadora cuánto le queda de espera. Ver lib/aliclik-orphan-expiry.ts.
 */
const INTENT_EXPIRY_MS = 90 * 60_000;

/**
 * Por qué el candado rechazó este intento, en cristiano.
 *
 * Se consulta la intención viva en lugar de devolver un texto fijo: el estado
 * que la bloquea cambia por completo qué debe hacer quien está delante. Si la
 * consulta falla, se cae al mensaje genérico — no vale perder el aviso.
 */
async function describeLockedIntent(
  admin: ReturnType<typeof createAdminSupabase>,
  orderId: string,
): Promise<string> {
  const { data } = await admin
    .from("aliclik_order_requests")
    .select("status,order_number,created_at")
    .eq("order_id", orderId)
    .neq("status", "failed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return lockedIntentMessage((data as LockedIntent | null) ?? null, {
    expiryMs: INTENT_EXPIRY_MS,
    now: new Date(),
  });
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
  // La salida «por definir» NO cuenta: es ESTA caja esperando courier, y la guía
  // se va a escribir encima de ella. Contarla obligaba a anularla para poder
  // emitir la guía — y anularla arrastraba al pedido (#KP127639).
  const { data: live } = await admin
    .from("shipments")
    .select(
      "id,guide_code,delivery_status,courier,created_via,custody_state,custody_transferred_at",
    )
    .eq("order_id", orderId)
    .not("delivery_status", "in", "(anulado,transferido)");
  const activeGuide = ((live ?? []) as {
    id: string;
    guide_code: string;
    delivery_status: string;
    courier: string;
    created_via: string | null;
    custody_state: string | null;
    custody_transferred_at: string | null;
  }[]).find((g) => !isFillableRouteOutput(g));
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

  // El dinero que se va a cobrar tiene que ser EL MISMO que se aprobó.
  if (
    input.expectedCollectTotal != null &&
    preview.collectTotal != null &&
    Math.abs(preview.collectTotal - input.expectedCollectTotal) > 0.005
  ) {
    return {
      error:
        `El monto a cobrar cambió desde que cotizaste (ahora S/ ${preview.collectTotal.toFixed(2)}, ` +
        `antes S/ ${input.expectedCollectTotal.toFixed(2)}). No se creó la guía. Vuelve a cotizar y revísalo.`,
    };
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
    // La nota lleva la marca del pedido. Es lo que permite reencontrar la guía
    // si esta creación se va en timeout: Aliclik devuelve `note` al listar, así
    // que el barrido la reconoce por identidad y no por teléfono.
    note: stampOrderMarker(input.note, ctx.row.order_name),
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
      return { error: await describeLockedIntent(admin, orderId) };
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
        "Aliclik no respondió a tiempo. El pedido PUEDE haberse creado: no reintentes; se verificará " +
        "automáticamente en el próximo barrido, y si nunca llegó a crearse el pedido se libera solo en ~90 min.",
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
  // Rellena la salida «por definir» del pedido si la hay: es la misma caja, ya
  // armada y rotulada, a la que se le acaba de decidir el courier.
  const written = await writeCourierGuide(admin, orderId, {
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
  if ("error" in written) {
    // El pedido YA existe en Aliclik. Que falle nuestra fila es grave pero no se
    // puede deshacer: se avisa con el número para que se pueda vincular a mano.
    return {
      error: `El pedido se creó en Aliclik (${orderNumber}) pero no se pudo guardar la guía: ${written.error}`,
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

  // El mismo hecho, también en el HISTORIAL DEL LEAD.
  //
  // `order_events` es la verdad del pedido, pero el drawer de Leads no lo lee:
  // su historial es `lead_calls`. Sin esto, la vendedora veía la confirmación
  // unos segundos y desaparecía al recargarse el drawer, sin rastro de qué guía
  // se había creado. Se anotan los DOS códigos —el pedido de Shopify y la guía—
  // porque son los que hay que cruzar cuando algo se tuerce.
  //
  // Best-effort: un fallo aquí NO puede tumbar una guía que ya existe en
  // Aliclik. Y no todo pedido viene de un lead (el Master crea guías de pedidos
  // que nunca pasaron por WhatsApp), así que no encontrar lead es normal.
  try {
    const { data: lead } = await admin
      .from("leads")
      .select("id")
      .eq("order_id", orderId)
      .maybeSingle();
    const leadId = (lead as { id: string } | null)?.id;
    if (leadId) {
      await admin.from("lead_calls").insert({
        lead_id: leadId,
        store_id: ctx.storeId,
        // SIN vendedora, y no por descuido. `computeAdvisorConversionByDay`
        // atribuye la venta a quien hizo la ÚLTIMA interacción del lead, de
        // cualquier tipo. Firmar esta nota le robaría la venta a la asesora que
        // la cerró y se la daría a quien creó la guía — que puede ser otra
        // persona, o la misma en lote horas después. Quién creó la guía consta
        // en `order_events`, que es la auditoría de verdad; esto es solo la
        // anotación en el historial del lead.
        vendedora: null,
        kind: "system",
        new_status: null,
        note:
          `Guía de Aliclik creada · ${orderNumber} · pedido ${ctx.row.order_name ?? "—"} · ` +
          `cobrar S/ ${(preview.collectTotal ?? 0).toFixed(2)} · ` +
          `${courierBlock.transportName ?? "courier"} S/ ${courierBlock.deliveryCost}`,
      });
    }
  } catch {
    /* el historial es una comodidad; la guía ya existe y no se toca */
  }

  await recomputeOrderMasterSafe(admin, [orderId]);
  revalidatePath(MASTER_PATH);
  revalidatePath("/dashboard/leads");
  return {
    notice:
      `Guía creada en Aliclik para ${ctx.row.order_name ?? "el pedido"}: ${orderNumber} · ` +
      `cobrar S/ ${(preview.collectTotal ?? 0).toFixed(2)} · ` +
      `${courierBlock.transportName ?? "courier"} S/ ${courierBlock.deliveryCost}.`,
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
// ---------------------------------------------------------------------------
// Vinculación de una guía externa
// ---------------------------------------------------------------------------

/**
 * Incorpora al seguimiento una guía creada directamente en Aliclik.
 *
 * Buscar, validar y vincular ocurre dentro de esta única acción. Primero se
 * resuelve la guía y se ejecutan todas las guardas; solo después se inserta.
 * Los índices únicos son la última defensa ante dos vínculos simultáneos.
 */
export async function linkExistingAliclikGuide(
  orderId: string,
  guideCode: string,
): Promise<AliclikActionState> {
  const { resolution, error } = await resolveExistingAliclikGuide(orderId, guideCode);
  if (!resolution) return { error };
  if (resolution.preview.alreadyLinked) {
    return {
      notice: `La guía ${resolution.preview.orderNumber} ya estaba vinculada a este pedido.`,
    };
  }

  const { ctx, order, guideCode: resolvedGuideCode, preview } = resolution;
  const orderNumber = preview.orderNumber!;
  const mapped = mapAliclikStatus({
    callStatus: order.callStatus,
    status: order.status,
    dispatchStatus: order.dispatchStatus,
    isAgency: Boolean(order.shipping?.reference?.toLowerCase().includes("agencia")),
  });
  const deliveryStatus = mapped.deliveryStatus ?? "pendiente";
  const nowIso = new Date().toISOString();
  const remoteCreatedAt = order.createdAt ? new Date(order.createdAt) : null;
  const assignedAt =
    remoteCreatedAt && Number.isFinite(remoteCreatedAt.getTime())
      ? remoteCreatedAt.toISOString()
      : nowIso;
  const remoteUpdatedAt = order.updatedAt ? new Date(order.updatedAt) : null;
  const lastReportAt =
    remoteUpdatedAt && Number.isFinite(remoteUpdatedAt.getTime())
      ? remoteUpdatedAt.toISOString()
      : nowIso;
  const latitude = Number(order.shipping?.lat);
  const longitude = Number(order.shipping?.lng);
  const address = (order.shipping?.address1 ?? ctx.row.address ?? "").trim() || null;
  const reference = (order.shipping?.reference ?? ctx.row.reference ?? "").trim() || null;
  const customerName = preview.customerName || ctx.row.customer_name || "Cliente";
  const customerPhone =
    normalizePhone(order.customer?.phone) ?? normalizePhone(ctx.row.customer_phone);

  const admin = createAdminSupabase();
  const insert: Record<string, unknown> = {
    store_id: ctx.storeId,
    courier: "aliclik",
    guide_code: resolvedGuideCode,
    // Las guías AUR5X creadas en el portal no tienen un orderNumber ALC
    // visible por la API. No inventamos uno: guide_code conserva el código
    // impreso y el importador posterior podrá reconciliarlo.
    external_order_number:
      preview.verificationMode === "manual_portal" ? null : orderNumber,
    delivery_status: deliveryStatus,
    status_category: categoryOf(deliveryStatus),
    order_id: orderId,
    matched: true,
    // Distingue las dos vinculaciones de portal, porque no valen lo mismo: en
    // una el código impreso nombra al pedido, en la otra lo único que hay es la
    // firma del operador. Un solo valor para ambas borraría esa diferencia justo
    // en la columna que se mira para auditar cómo llegó una guía a su pedido.
    match_method:
      preview.verificationMode === "manual_portal"
        ? preview.codeMatchesOrder
          ? "portal_code_suffix"
          : "portal_operator_attested"
        : "manual_api",
    order_name: ctx.row.order_name,
    customer_name: customerName,
    customer_phone: customerPhone,
    product: order.productDetail ?? null,
    district: order.shipping?.districtName ?? ctx.row.district,
    province: order.shipping?.provinceName ?? ctx.row.province,
    city: order.shipping?.provinceName ?? ctx.row.province ?? ctx.row.region,
    region: order.shipping?.departmentName ?? ctx.row.region,
    delivery_address: address,
    delivery_reference: reference,
    latitude: Number.isFinite(latitude) ? latitude : ctx.row.latitude,
    longitude: Number.isFinite(longitude) ? longitude : ctx.row.longitude,
    created_via:
      preview.verificationMode === "manual_portal"
        ? "aliclik_external_portal_link"
        : "aliclik_external_link",
    assigned_at: assignedAt,
    last_report_at: lastReportAt,
    reported_status: aliclikStatusLabel(order),
    reported_collect_amount:
      order.total != null && Number.isFinite(order.total) ? order.total : null,
  };
  if (deliveryStatus === "en_ruta") insert.dispatched_at = lastReportAt;
  if (deliveryStatus === "entregado") {
    insert.closed_at = lastReportAt;
    insert.delivered_source = "aliclik_api";
  }
  if (mapped.returned) {
    insert.returned_at = lastReportAt;
    // Lo dice la API de Aliclik, no la persona que pulsó «verificar» (0118).
    insert.returned_source = "aliclik_api";
  }

  // ADOPTAR ANTES DE INSERTAR. La guía puede existir YA en `shipments` sin estar
  // enganchada a ningún pedido: es el caso de las miles de guías que entraron por
  // un reporte Excel y el importador no logró casar con su pedido (order_id null,
  // matched false). Insertar una segunda fila con el mismo `guide_code` choca
  // contra el índice único y el error se leía como "otra operación la vinculó",
  // que confundía —nadie la vinculó, ya existía— y dejaba el pedido sin guía y
  // sin seguimiento. Si la fila existe y está libre (o ya es de este pedido), se
  // ADOPTA: se le pone el vínculo y NO se pisa su estado, que el reporte ya venía
  // manteniendo. `reconcileDeliveryStatus` garantiza que el estado solo avance,
  // así que un "entregado" del reporte nunca retrocede al "pendiente" por defecto.
  const { data: existingRow } = await admin
    .from("shipments")
    .select("id,order_id,delivery_status,last_report_at")
    .eq("guide_code", resolvedGuideCode)
    .maybeSingle();
  const existing = existingRow as {
    id: string;
    order_id: string | null;
    delivery_status: string | null;
    last_report_at: string | null;
  } | null;

  let shipmentId: string;
  let adopted = false;
  if (existing && canAdoptExistingGuide(existing, orderId)) {
    const reconciled = reconcileDeliveryStatus(existing.delivery_status, deliveryStatus);
    const patch: Record<string, unknown> = {
      order_id: orderId,
      store_id: ctx.storeId,
      order_name: ctx.row.order_name,
      matched: true,
      match_method: insert.match_method,
      delivery_status: reconciled,
      status_category: categoryOf(reconciled),
    };
    // El reporte ya escribió created_via cuando lo hubo; solo se marca la
    // procedencia del vínculo si la fila no traía ninguna.
    if (!existing.last_report_at) {
      patch.last_report_at = lastReportAt;
      patch.reported_status = insert.reported_status;
    }
    if (reconciled === "entregado" && existing.delivery_status !== "entregado") {
      patch.closed_at = lastReportAt;
      patch.delivered_source = insert.delivered_source ?? "aliclik_api";
    }
    const { error: adoptErr } = await admin
      .from("shipments")
      .update(patch)
      .eq("id", existing.id);
    if (adoptErr) return { error: `No se pudo vincular la guía: ${adoptErr.message}` };
    shipmentId = existing.id;
    adopted = true;
  } else {
    const { data: shipment, error: shipErr } = await admin
      .from("shipments")
      .insert(insert)
      .select("id")
      .single();
    if (shipErr) {
      // Con la adopción previa, un 23505 aquí ya solo puede ser una carrera real:
      // otra operación insertó la MISMA guía entre el SELECT y este INSERT.
      if (shipErr.code === "23505") {
        return {
          error:
            `La guía ${orderNumber} acaba de ser vinculada por otra operación. ` +
            "Actualiza el pedido para ver dónde quedó.",
        };
      }
      return { error: `No se pudo vincular la guía: ${shipErr.message}` };
    }
    shipmentId = (shipment as { id: string }).id;
  }

  await admin.from("order_events").insert({
    store_id: ctx.storeId,
    order_id: orderId,
    kind: "guide_registered",
    occurred_at: nowIso,
    actor: ctx.userId,
    source: "aliclik",
    courier: "aliclik",
    guide_code: resolvedGuideCode,
    shipment_id: shipmentId,
    note:
      preview.verificationMode === "manual_portal"
        ? `Guía ${resolvedGuideCode} creada directamente en el portal AURELA/KENKU; ` +
          `vinculada a ${ctx.row.order_name} por coincidencia exacta del sufijo del pedido, ` +
          "tras comprobar que no estaba vinculada a otro pedido. La API oficial solo expone " +
          "pedidos ALC de la integración."
        : `Guía ${resolvedGuideCode} creada fuera de Kapta; pedido ${orderNumber} ` +
          "validado por la API de Aliclik y vinculado manualmente.",
    payload: {
      externalLink: true,
      callStatus: order.callStatus,
      status: order.status,
      dispatchStatus: order.dispatchStatus,
      customerPhone: order.customer?.phone,
      total: order.total,
      phoneMatches: preview.phoneMatches,
      totalMatches: preview.totalMatches,
      verificationMode: preview.verificationMode,
      expectedOrderName: preview.expectedOrderName,
      matchExplanation: preview.matchExplanation,
      apiCandidateCount: preview.apiCandidateCount,
      apiMatchSummary: preview.apiMatchSummary,
    },
  });

  try {
    const { data: lead } = await admin
      .from("leads")
      .select("id")
      .eq("order_id", orderId)
      .maybeSingle();
    const leadId = (lead as { id: string } | null)?.id;
    if (leadId) {
      await admin.from("lead_calls").insert({
        lead_id: leadId,
        store_id: ctx.storeId,
        vendedora: null,
        kind: "system",
        new_status: null,
        note:
          `Guía Aliclik existente vinculada · ${orderNumber} · ` +
          `pedido ${ctx.row.order_name ?? "—"} · estado ${aliclikStatusLabel(order)}`,
      });
    }
  } catch {
    /* El historial del lead es auxiliar; la guía y el evento ya quedaron guardados. */
  }

  await recomputeOrderMasterSafe(admin, [orderId]);
  revalidatePath(MASTER_PATH);
  revalidatePath("/dashboard/envios");
  revalidatePath("/dashboard/leads");
  const target = ctx.row.order_name ?? "este pedido";
  return {
    notice: adopted
      ? `Guía ${orderNumber} enganchada a ${target}. Ya estaba en el sistema ` +
        "por un reporte previo, así que su estado y su seguimiento se conservan."
      : `Guía ${orderNumber} verificada en Aliclik y vinculada a ${target}. ` +
        "El seguimiento automático ya está activo.",
  };
}

/**
 * Cancela una guía de Aliclik y conserva el resultado exacto de la API.
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

/**
 * Marca el distrito de un pedido como Provincia COD porque Aliclik acaba de
 * cotizarlo.
 *
 * DE DÓNDE SALE. El bloque de Agencia deja comprobar si Aliclik llega
 * (`previewAliclikGuide` con `coverageProbe`). Si contesta con un precio, esa
 * respuesta es la prueba de cobertura, y hasta ahora se enseñaba y se tiraba:
 * el operador tenía que ir a Ajustes a escribir a mano lo que el sistema
 * acababa de averiguar.
 *
 * POR QUÉ NO SE ESCRIBE SOLA. La cotización es por COORDENADA y la cobertura es
 * por DISTRITO. Que Aliclik llegue a un punto de Pisac no prueba que llegue a
 * todo Pisac, así que la generalización la firma una persona. Lo que se
 * automatiza es el trabajo —la consulta, el nombre normalizado, la nota con el
 * precio y la fecha, el recálculo de los pedidos abiertos—, no la decisión.
 *
 * QUIÉN PUEDE. Sigue exigiendo admin de la tienda, igual que Ajustes: esto
 * cambia por dónde se despacha TODO ese distrito, no solo este pedido. Quien
 * cotiza y no es admin ve el precio y a quién pedírselo.
 */
export async function markDistrictCoveredByAliclik(
  orderId: string,
  quotedCost: number | null,
): Promise<{ notice?: string; error?: string }> {
  const perms = await getMasterPermissions();
  if (!perms.can("aliclik.create_guide")) {
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

  const raw = (row.district ?? "").trim();
  const district = normalizeDistrictKey(raw);
  if (!district) {
    return { error: "El pedido no tiene distrito; corrígelo en Ubicación y cobertura." };
  }

  const admin = createAdminSupabase();
  const { data: store } = await admin
    .from("stores")
    .select("org_id")
    .eq("id", row.store_id)
    .maybeSingle();
  const orgId = (store as { org_id: string } | null)?.org_id;
  if (!orgId) return { error: "No se pudo leer la tienda del pedido." };

  const { data: membership } = await sb
    .from("memberships")
    .select("role")
    .eq("org_id", orgId)
    .eq("user_id", user.id)
    .maybeSingle();
  const role = (membership as { role: string } | null)?.role;
  if (role !== "owner" && role !== "admin") {
    return {
      error:
        `Aliclik sí cubre ${raw}, pero marcar un distrito cambia el despacho de todos sus ` +
        "pedidos y eso lo hace un administrador. Pídeselo indicando el distrito y el precio.",
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const { error } = await saveDistrictCoverageRow(admin, {
    // Sin tienda: la clasificación de hoy es global y un distrito cubierto lo
    // está para las dos tiendas, que comparten la misma cuenta de Aliclik.
    storeId: null,
    district,
    coverage: "provincia_cod",
    note:
      `Aliclik cotizó ${quotedCost != null ? `S/ ${quotedCost.toFixed(2)} ` : ""}` +
      `desde el pedido ${row.order_name ?? orderId} el ${today}.`,
    updatedBy: user.id,
  });
  if (error) return { error };

  // Los pedidos abiertos de ese distrito estaban clasificados con la regla
  // vieja. Sin esto, el que acabas de comprobar seguiría enseñando Agencia.
  const { data: affected } = await admin
    .from("order_master")
    .select("order_id")
    .ilike("district", district)
    .not("macro_stage", "in", "(finalizado)")
    .limit(2000);
  const ids = ((affected ?? []) as { order_id: string }[]).map((r) => r.order_id);
  const done = ids.length ? await recomputeOrderMasterSafe(admin, ids) : { written: 0 };

  revalidatePath(MASTER_PATH);
  return {
    notice:
      `«${raw}» queda como Provincia COD.` +
      (done.written ? ` ${done.written} pedido(s) abiertos reclasificados.` : ""),
  };
}
