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
  getOrder,
  interpretCancelResponse,
  listOrders,
  quoteShippingCost,
  type AliclikClientOpts,
  type AliclikCourierQuote,
  type AliclikOrder,
} from "@/lib/aliclik";
import { selectExistingAliclikOrder } from "@/lib/aliclik-existing-guide";
import { aliclikStatusLabel, mapAliclikStatus } from "@/lib/aliclik-status";
import {
  loadCatalogFor,
  resolveAliclikItems,
  type ResolvedItem,
} from "@/lib/aliclik-catalog";
import { MAX_ACCEPTABLE_LOSS, reconcileToOrderTotal } from "@/lib/aliclik-money";
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
}

interface ExistingGuideResolution {
  ctx: AliclikContext;
  order: AliclikOrder;
  guideCode: string;
  preview: ExistingAliclikGuidePreview;
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
  if (/^ALC/i.test(code)) {
    const remote = await getOrder(ctx.client, code, {
      searchTerms: [numericSuffix, customerPhone, customerPhoneLocal],
      startDate: dateKey(recentStart),
      endDate: dateKey(new Date(Date.now() + 24 * 60 * 60_000)),
      maxPagesPerQuery: 10,
      scanUnfiltered: true,
    });
    if (!remote.ok) return { error: `No se pudo consultar Aliclik: ${remote.error}` };
    remoteOrder = remote.data;
  } else {
    const candidates: AliclikOrder[] = [];
    for (let page = 1; page <= 10; page++) {
      const result = await listOrders(ctx.client, {
        page,
        limit: 100,
        startDate: dateKey(recentStart),
        endDate: dateKey(new Date(Date.now() + 24 * 60 * 60_000)),
      });
      if (!result.ok) return { error: `No se pudo consultar Aliclik: ${result.error}` };
      candidates.push(...(result.data.data ?? []));
      const totalPages = Math.max(1, result.data.pagination?.totalPages ?? 1);
      if (page >= totalPages || !(result.data.data ?? []).length) break;
    }
    const selected = selectExistingAliclikOrder(candidates, {
      orderName: ctx.row.order_name,
      customerPhone: ctx.row.customer_phone,
      orderTotal: ctx.row.order_total,
      region: ctx.row.region,
      province: ctx.row.province,
      district: ctx.row.district,
    });
    if (selected.ok) {
      remoteOrder = selected.match.order;
      matchExplanation = selected.match.reasons.join(", ");
    } else if (selected.reason === "ambiguous") {
      return {
        error:
          `Aliclik no expone el código impreso ${code} por API y encontramos más de un pedido ` +
          "posible. No se vinculó nada; usa el código ALC del pedido para confirmar cuál corresponde.",
      };
    }
  }
  if (!remoteOrder) {
    return {
      error:
        /^ALC/i.test(code)
          ? `El pedido ${code} no existe en la cuenta Aliclik de esta tienda.`
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
    return {
      error:
        `La guía ${code} ya está vinculada a ${linked.order_name ?? "otro pedido"}. ` +
        "No se modificó ningún vínculo.",
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
    statusLabel: aliclikStatusLabel(remoteOrder),
    shippingAddress: remoteOrder.shipping?.address1 ?? null,
    shippingDistrict: remoteOrder.shipping?.districtName ?? null,
    shippingProvince: remoteOrder.shipping?.provinceName ?? null,
    shippingDepartment: remoteOrder.shipping?.departmentName ?? null,
    phoneMatches: samePhone(remoteOrder.customer?.phone, ctx.row.customer_phone),
    totalMatches:
      total == null || ctx.row.order_total == null
        ? null
        : Math.abs(total - ctx.row.order_total) <= 0.01,
    alreadyLinked: linked?.order_id === orderId,
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
  input: { coordinate?: string | null; modality?: "cod" | "agency" } = {},
): Promise<AliclikPreview> {
  const { ctx, error } = await authorize(orderId, "aliclik.create_guide");
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
 * La consulta y todas las guardas se repiten aquí aunque la operadora ya haya
 * pulsado "Validar": el estado pudo cambiar entre ambos clics. Los índices
 * únicos son la última defensa ante dos vínculos simultáneos.
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
    external_order_number: orderNumber,
    delivery_status: deliveryStatus,
    status_category: categoryOf(deliveryStatus),
    order_id: orderId,
    matched: true,
    match_method: "manual_api",
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
    created_via: "aliclik_external_link",
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
  if (mapped.returned) insert.returned_at = lastReportAt;

  const { data: shipment, error: shipErr } = await admin
    .from("shipments")
    .insert(insert)
    .select("id")
    .single();
  if (shipErr) {
    if (shipErr.code === "23505") {
      return {
        error:
          `La guía ${orderNumber} acaba de ser vinculada por otra operación. ` +
          "Actualiza el pedido para ver dónde quedó.",
      };
    }
    return { error: `No se pudo vincular la guía: ${shipErr.message}` };
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
    shipment_id: (shipment as { id: string }).id,
    note:
      `Guía ${resolvedGuideCode} creada fuera de Kapta; pedido ${orderNumber} ` +
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
  return {
    notice:
      `Guía ${orderNumber} verificada en Aliclik y vinculada a ` +
      `${ctx.row.order_name ?? "este pedido"}. El seguimiento automático ya está activo.`,
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
