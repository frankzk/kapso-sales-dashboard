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
//
// Desde el 16-10-2026 cotizar y crear viven en lib/aliclik-guide.ts, que es
// donde están estas defensas; aquí queda la puerta de la persona (`authorize`)
// y lo demás: vincular, anular y marcar cobertura.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { swaypGuiaDeVuelta } from "@/lib/swayp-desde-confirmacion";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { getMasterPermissions, hasOrgPermission } from "@/lib/permissions-access";
import { normalizeDistrictKey } from "@/lib/district-coverage";
import { saveDistrictCoverageRow } from "@/lib/district-coverage-access";
import { recordCoverageChanges, type CoverageSnapshot } from "@/lib/coverage-change";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { normalizePhone } from "@/lib/phone";
import { categoryOf, reconcileDeliveryStatus } from "@/lib/shipments";
import {
  cancelOrder,
  getOrder,
  interpretCancelResponse,
  listOrders,
  type AliclikClientOpts,
  type AliclikOrder,
} from "@/lib/aliclik";
import { isCompatibleManualPortalGuide, selectExistingAliclikOrder } from "@/lib/aliclik-existing-guide";
import { aliclikStatusLabel, mapAliclikStatus } from "@/lib/aliclik-status";
import { canAdoptExistingGuide } from "@/lib/aliclik-orphans";
import type { OrderMasterRow } from "@/lib/types";
import {
  aliclikContextFor,
  createAliclikGuideFor,
  previewAliclikGuideFor,
  type AliclikContext,
  type AliclikPreview,
  type AliclikPreviewInput,
  type CreateGuideInput,
} from "@/lib/aliclik-guide";

export type { AliclikPreview, AliclikPreviewInput, CreateGuideInput } from "@/lib/aliclik-guide";

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

  // La clasificación (Agencia), las credenciales y el cliente: ver
  // `aliclikContextFor`. Anular y la comprobación de cobertura no se frenan
  // por Agencia; crear y vincular sí.
  return aliclikContextFor(row, user.id, {
    blockAgencia: permission === "aliclik.create_guide" && !opts.coverageProbe,
  });
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
    .select("guide_code,external_order_number,delivery_status,courier,swayp_state,returned_at")
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
      courier: string;
      swayp_state: number | null;
      returned_at: string | null;
    }[]
  ).find(
    (guide) =>
      // La Swayp en Devolución no frena: no se entrega ni se puede anular (§11.11).
      !swaypGuiaDeVuelta(guide) &&
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

// ---------------------------------------------------------------------------
// Cotizar y crear: la puerta de la persona
// ---------------------------------------------------------------------------
//
// El núcleo —todas las compuertas, el candado y la escritura— vive en
// lib/aliclik-guide.ts desde el 16-10-2026, para que la guía automática del día
// programado (MOM §6.2) pase EXACTAMENTE por el mismo camino que este botón.
// Aquí queda lo que es de la persona: su permiso, su sesión y su RLS.

export async function previewAliclikGuide(
  orderId: string,
  input: AliclikPreviewInput = {},
): Promise<AliclikPreview> {
  const { ctx, error } = await authorize(orderId, "aliclik.create_guide", {
    coverageProbe: input.coverageProbe,
  });
  if (!ctx) return { ok: false, error };
  return previewAliclikGuideFor(ctx, input);
}

export async function createAliclikGuide(
  orderId: string,
  input: CreateGuideInput,
): Promise<AliclikActionState> {
  const { ctx, error } = await authorize(orderId, "aliclik.create_guide");
  if (!ctx) return { error };
  const result = await createAliclikGuideFor(ctx, input);
  if (result.error) return { error: result.error };
  revalidatePath(MASTER_PATH);
  revalidatePath("/dashboard/leads");
  return { notice: result.notice };
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

  // Cambia el despacho de todos los pedidos del distrito: «Administrar tiendas».
  if (!(await hasOrgPermission(orgId, "stores.manage"))) {
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
    .select("order_id,store_id,coverage")
    .ilike("district", district)
    .not("macro_stage", "in", "(finalizado)")
    .limit(2000);
  const before = (affected ?? []) as CoverageSnapshot[];
  const done = before.length ? await recomputeOrderMasterSafe(admin, before.map((r) => r.order_id)) : { written: 0 };
  // Los que la decisión movió quedan con su antes y su después (MOM §19.0.1).
  const coverage = await recordCoverageChanges(admin, before, {
    cause: "decision_distrito",
    actor: user.id,
    reason: `Aliclik cotizó el distrito desde ${row.order_name ?? orderId}.`,
  });

  revalidatePath(MASTER_PATH);
  return {
    notice:
      `«${raw}» queda como Provincia COD.` +
      (done.written ? ` ${done.written} pedido(s) abiertos recalculados, ${coverage.changed.length} cambiaron de cobertura.` : "") +
      (coverage.error ? ` ${coverage.error}` : ""),
  };
}
