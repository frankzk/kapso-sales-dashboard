import "server-only";

// Cotizar y crear una guía en Aliclik: el núcleo que comparten el botón del
// Master y la guía automática del día programado (MOM §6.2, 16-10-2026).
//
// POR QUÉ ESTÁ AQUÍ Y NO EN `app/dashboard/pedidos/aliclik-actions.ts`. Aquel
// archivo es `"use server"`: todo lo que exporta es una acción que cualquier
// navegador puede invocar. El automático no tiene sesión, así que necesita una
// entrada que no pase por la sesión — y esa entrada NO puede vivir en un archivo
// de acciones, o sería una puerta abierta. Aquí no hay `"use server"`: solo lo
// llaman el servidor (las acciones, tras `authorize`) y el cron.
//
// LO QUE HACE PELIGROSA ESTA ACCIÓN. Crear un pedido en Aliclik es irreversible,
// con ventanas de cancelación estrictas, y su API NO tiene idempotency key. Las
// defensas, en orden:
//   1. permiso propio `aliclik.create_guide` (la acción) o pedido programado
//      para hoy (el automático);
//   2. dos interruptores (ALICLIK_WRITE_ENABLED + stores.aliclik_enabled);
//   3. TODA validación del preview se vuelve a ejecutar aquí — nunca se confía
//      en lo que manda el navegador (doctrina de `createDirectFenixGuide`);
//   4. la intención se escribe ANTES del POST, y su índice único parcial impide
//      dos guías para un pedido (doble clic, dos operadoras, reintento, el
//      automático y una persona a la vez);
//   5. un timeout NO se trata como fallo: el pedido pudo haberse creado.
//
// EL AUTOMÁTICO PASA POR LAS MISMAS COMPUERTAS, SIN EXCEPCIONES. Las dos que se
// levantan escribiendo un motivo —el pago exigido por el historial y el pin que
// el pedido no respalda— no se levantan solas: el automático no escribe motivos
// por nadie. Si una compuerta lo detiene, falla y avisa (lib/aliclik-scheduled-server.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import { swaypGuiaDeVuelta } from "@/lib/swayp-desde-confirmacion";
import { writeCourierGuide } from "@/lib/route-output-fill";
import { isFillableRouteOutput } from "@/lib/shipment-output";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { dispatchFallsOnSunday, expectedDispatchDate } from "@/lib/aliclik-dispatch-date";
import { getStoreCreds } from "@/lib/ingest";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { resolveEmails } from "@/lib/productivity";
import { guideCreatorPhrase } from "@/lib/guide-note";
import {
  getOrderConfirmationBrief,
  getOrderMasterDetail,
  OrderMasterReadError,
} from "@/lib/orders-master-access";
import { aliclikRiskGate } from "@/lib/order-confirmation-brief";
import { aliclikDoorBan } from "@/lib/door-rejection";
import { DUPLICATE_READ_ERROR, loadAliclikDuplicateHold } from "@/lib/aliclik-duplicate-access";
import type { DuplicateHold } from "@/lib/aliclik-duplicate";
import { classifyOperation } from "@/lib/order-macro-stage";
import { normalizePhone } from "@/lib/phone";
import { pinSinCorroborar } from "@/lib/pin-corroborado";
import { categoryOf } from "@/lib/shipments";
import {
  createOrder,
  quoteShippingCost,
  type AliclikClientOpts,
  type AliclikCourierQuote,
} from "@/lib/aliclik";
import { shouldRetryQuote } from "@/lib/aliclik-health";
import { loadAliclikHealthState } from "@/lib/aliclik-health-access";
import {
  avisoDistritoQueAliclikNoTiene,
  distritoQueAliclikNoTiene,
} from "@/lib/aliclik-status";
import { lockedIntentMessage, type LockedIntent } from "@/lib/aliclik-orphan-expiry";
import {
  loadCatalogFor,
  hydrateOrderLineSkusFromCatalog,
  resolveAliclikItems,
  type OrderLineInput,
  type ResolvedItem,
} from "@/lib/aliclik-catalog";
import { listActiveShopifyCatalogVariants, type ShopifyClientOpts } from "@/lib/shopify";
import { MAX_ACCEPTABLE_LOSS, aliclikPrepaidBlocker, reconcileToOrderTotal } from "@/lib/aliclik-money";
import { stampOrderMarker } from "@/lib/aliclik-reconcile";
import {
  canScheduleExpress,
  limaTimeHHMM,
  parseCoordinateInput,
  toAliclikCoord,
} from "@/lib/aliclik-geo";
import type { OrderMasterRow } from "@/lib/types";

// ---------------------------------------------------------------------------
// Contexto
// ---------------------------------------------------------------------------

export interface AliclikContext {
  /** Quién crea. `null` = el sistema (la guía automática del día programado). */
  userId: string | null;
  storeId: string;
  row: OrderMasterRow;
  client: AliclikClientOpts;
  clients: AliclikClientOpts[];
  shopify: ShopifyClientOpts | null;
}

/**
 * Con qué se leen el detalle, el historial del cliente y los duplicados.
 *
 * Sin scope, con la sesión de quien pulsa: la RLS decide qué pedidos anteriores
 * se ven. El automático no tiene sesión y lee con el service role, que lo ve
 * TODO; por eso lleva las tiendas de la organización del pedido y el historial
 * se acota a ellas a mano. Sin ese límite, el historial de un teléfono cruzaría
 * a otra organización.
 */
export interface AliclikReadScope {
  client: SupabaseClient;
  storeIds: string[];
}

/** Las tiendas de la organización de una tienda: el límite del historial del automático. */
export async function aliclikReadScopeFor(
  admin: SupabaseClient,
  storeId: string,
): Promise<{ scope?: AliclikReadScope; error?: string }> {
  const { data: store, error } = await admin.from("stores").select("org_id").eq("id", storeId).maybeSingle();
  const orgId = (store as { org_id?: string | null } | null)?.org_id ?? null;
  if (error || !orgId) return { error: "No se pudo leer la organización de la tienda." };
  const { data: stores, error: storesError } = await admin.from("stores").select("id").eq("org_id", orgId);
  if (storesError || !stores?.length) return { error: "No se pudieron leer las tiendas de la organización." };
  return { scope: { client: admin, storeIds: (stores as { id: string }[]).map((s) => s.id) } };
}

/**
 * Prepara el cliente de Aliclik para un pedido ya leído. Quién puede leerlo lo
 * decide quien llama: la acción, con la sesión y la RLS; el automático, con su
 * propia selección de pedidos programados.
 */
export async function aliclikContextFor(
  row: OrderMasterRow,
  userId: string | null,
  opts: { blockAgencia: boolean },
): Promise<{ ctx?: AliclikContext; error?: string }> {
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
  if (opts.blockAgencia && classifyOperation(row) === "agencia") {
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
      userId,
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

/** La retención por posible duplicado, leída con la sesión o con el scope del automático. */
async function duplicateHold(
  orderId: string,
  scope: AliclikReadScope | undefined,
): Promise<{ hold: DuplicateHold } | { error: string }> {
  try {
    return { hold: await loadAliclikDuplicateHold(orderId, scope) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : DUPLICATE_READ_ERROR };
  }
}

type LiveGuide = {
  id: string;
  guide_code: string;
  delivery_status: string;
  courier: string;
  created_via: string | null;
  custody_state: string | null;
  custody_transferred_at: string | null;
  swayp_state: number | null;
  returned_at: string | null;
};

/**
 * La guía viva que impide crear otra, o null.
 *
 * El pedido no puede tener ya una guía activa. Mismo criterio que
 * `createDirectFenixGuide`: dos guías vivas para un pedido es un paquete
 * duplicado saliendo del almacén.
 * La salida «por definir» NO cuenta: es ESTA caja esperando courier, y la guía
 * se va a escribir encima de ella. Contarla obligaba a anularla para poder
 * emitir la guía — y anularla arrastraba al pedido (#KP127639).
 * Tampoco la guía Swayp en Devolución (`swaypGuiaDeVuelta`, MOM §11.11): no
 * se va a entregar ni se puede anular, y es justo la que obliga a salir por
 * Aliclik.
 */
export async function activeAliclikBlocker(
  admin: SupabaseClient,
  orderId: string,
): Promise<{ guide: LiveGuide | null; error?: string }> {
  const { data: live, error } = await admin
    .from("shipments")
    .select(
      "id,guide_code,delivery_status,courier,created_via,custody_state,custody_transferred_at,swayp_state,returned_at",
    )
    .eq("order_id", orderId)
    .not("delivery_status", "in", "(anulado,transferido)");
  if (error) return { guide: null, error: `No se pudieron leer las guías del pedido: ${error.message}` };
  const guide = ((live ?? []) as LiveGuide[]).find((g) => !isFillableRouteOutput(g) && !swaypGuiaDeVuelta(g));
  return { guide: guide ?? null };
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
  /**
   * El pedido NO respalda el pin y por eso no se puede emitir: ni el
   * departamento elegido en el checkout ni la ciudad escrita coinciden con lo
   * que Aliclik deduce del pin. Texto ya redactado para enseñar.
   */
  pinSinCorroborar?: string;
  couriers?: (AliclikCourierQuote & { selectable: boolean; reason?: string })[];
  /** Nombre del pedido (#KP…). La operadora tiene que VER sobre cuál crea. */
  orderName?: string | null;
  /** Lo que Aliclik cobrará en la puerta. Es la cifra que hay que enseñar. */
  collectTotal?: number;
  /** Total del pedido en Shopify. Si difiere de `collectTotal`, se avisa. */
  orderTotal?: number | null;
  coordinate?: { lat: string; lng: string };
  /**
   * Cuándo recogerán el paquete según la regla del propio Aliclik, y si su
   * cálculo va a caer en domingo. `fallsOnSunday` es lo que hay que advertir:
   * ahí su regla dice lunes y lo observado es que ponen el domingo.
   */
  dispatch?: { date: string; fallsOnSunday: boolean };
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

export interface AliclikPreviewInput {
  coordinate?: string | null;
  modality?: "cod" | "agency";
  /**
   * Comprobación de cobertura sobre un pedido clasificado como Agencia. Solo
   * levanta la puerta de la clasificación para poder COTIZAR; crear sigue
   * cerrado, así que lo peor que puede pasar es enterarse de un precio.
   */
  coverageProbe?: boolean;
  /**
   * Excepción auditada al respaldo del pin. Mismo patrón que
   * `riskExceptionReason`: no se levanta la puerta con una casilla muda, se
   * levanta escribiendo por qué el pin es correcto pese a contradecir al
   * pedido. Esos casos existen —la clienta eligió mal el departamento— y son
   * 4 de 2.878 guías medidas.
   */
  pinExceptionReason?: string | null;
}

/**
 * Cotiza el envío y devuelve todo lo que hace falta para decidir. NO crea nada.
 *
 * Este paso vale por sí mismo aunque nunca se llegue a crear la guía: cotizar
 * los pedidos pendientes dice cuántos son creables y —comparando el ubigeo que
 * resuelve Aliclik con el nuestro— cuántos tienen el pin mal puesto.
 */
export async function previewAliclikGuideFor(
  ctx: AliclikContext,
  input: AliclikPreviewInput = {},
  scope?: AliclikReadScope,
): Promise<AliclikPreview> {
  const orderId = ctx.row.order_id;

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
  let detail: Awaited<ReturnType<typeof getOrderMasterDetail>>;
  try {
    detail = await getOrderMasterDetail(orderId, scope?.client);
  } catch (cause) {
    // Sin generar la guía y con el motivo delante: emitirla a ciegas con un
    // detalle que la base no pudo dar es cómo se despacha una caja equivocada.
    if (cause instanceof OrderMasterReadError) return { ok: false, error: cause.message };
    throw cause;
  }
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

  // 1-ter. ¿PUEDE SIQUIERA IR POR ALICLIK? Un pedido ya cobrado no: Aliclik es
  //        solo contraentrega y no admite cobro cero. Se corta ANTES de calcular
  //        el importe, porque acá no hay importe correcto que calcular.
  const prepaidBlock = aliclikPrepaidBlocker({
    financialStatus: ctx.row.financial_status,
    totalRefunded: ctx.row.total_refunded,
    paymentState: ctx.row.payment_state,
    paymentGateway: ctx.row.payment_gateway,
  });
  if (prepaidBlock) return { ok: false, error: prepaidBlock };

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

  let outageNote: string | null = null;
  if (!quote) {
    const preferred = candidates[0] ?? quotedWarehouse;
    const allTransient =
      failures.length > 0 &&
      failures.every((failure) => failure.status == null || failure.status >= 500);
    // La sonda se consulta AQUÍ y no antes: en el camino feliz no hace falta, y
    // esto solo se recorre cuando ya falló todo. Va por el cliente de servicio
    // porque la salud es de la ORG y el acceso a este pedido ya se autorizó
    // arriba; leerla no descubre nada que esta pantalla no pueda ver.
    const plan = allTransient
      ? shouldRetryQuote((await loadAliclikHealthState(admin, ctx.storeId)).quote, true)
      : { retry: false, note: null };
    outageNote = plan.note;
    if (plan.retry) {
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
      const ultimo = failures.at(-1)?.error ?? "Aliclik no respondió.";
      // CUANDO EL PROBLEMA ES EL DISTRITO, EL ALMACÉN NO SE NOMBRA. Añadirle
      // «Almacén(es) compatibles probados: …» a un fallo de ubigeo mandaba a
      // buscar por donde no era — pasó con #AUR177131, y la conclusión de quien
      // lo leyó fue «es imposible que no haya almacenes compatibles», que es
      // cierta. Ver `distritoQueAliclikNoTiene`.
      const distritoDesconocido = distritoQueAliclikNoTiene(ultimo);
      if (distritoDesconocido) {
        return {
          ok: false,
          error:
            avisoDistritoQueAliclikNoTiene(distritoDesconocido) +
            (refs ? ` Referencia(s): ${refs}.` : ""),
          coordinate: { lat, lng },
        };
      }
      return {
        ok: false,
        error:
          // El aviso de caída va PRIMERO: es lo único accionable de todo el
          // mensaje. Detrás siguen el error crudo y las referencias, que son lo
          // que se le reenvía a Aliclik.
          (outageNote ? `${outageNote} ` : "") +
          `${ultimo} ` +
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
  // Se compara el distrito, que es el nivel que decide tarifa y cobertura. Es
  // un AVISO, no una puerta, y a propósito: salta en 1.958 de 4.173 guías (47%)
  // y casi siempre por nada —Cusco/Cuzco, Coronel Portillo/Pucallpa, el nombre
  // oficial contra el comercial (§10)—. Sirve para mirar, no para decidir.
  const ubigeoMismatch =
    Boolean(aliclikUbigeo.district && ourUbigeo.district) &&
    norm(aliclikUbigeo.district) !== norm(ourUbigeo.district);

  // LA PUERTA ES OTRA: que el pedido respalde el pin. El pin decide a dónde va
  // el paquete, así que un pin contradicho por el desplegable del checkout Y
  // por la ciudad escrita no es una discrepancia de nombres, es otro destino.
  // Eso fue #KP133769: Puno en las dos declaraciones, pin en Cusco, 331 km, y
  // el paquete volvió. Ver lib/pin-corroborado.ts para la medición.
  const pinDudoso = pinSinCorroborar({
    departamentoDelPin: aliclikUbigeo.department,
    distritoDelPin: aliclikUbigeo.district,
    isoDelCheckout: detail.departamentoElegido,
    ciudadEscrita: detail.address?.city,
  });
  if (pinDudoso && !input.pinExceptionReason?.trim()) {
    return {
      ok: false,
      error: pinDudoso,
      pinSinCorroborar: pinDudoso,
      aliclikUbigeo,
      ourUbigeo,
      ubigeoMismatch,
      coordinate: { lat, lng },
    };
  }

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
    pinSinCorroborar: pinDudoso ?? undefined,
    couriers: annotated,
    coordinate: { lat, lng },
    dispatch: dispatchOutlook(annotated),
    writeBlocked: writeBlockedReason() ?? undefined,
  };
}

/**
 * Cuándo recogerán el paquete, y si Aliclik va a equivocarse al fecharlo.
 *
 * Se calcula sobre el courier más barato entre los seleccionables, que es el que
 * el panel preselecciona y el que la asesora elige casi siempre. No sobre todos:
 * enseñar una fecha por courier convertiría un aviso en una tabla, y el aviso
 * solo importa cuando hay algo que advertir.
 */
function dispatchOutlook(
  couriers: (AliclikCourierQuote & { selectable: boolean })[],
): { date: string; fallsOnSunday: boolean } | undefined {
  const chosen = couriers
    .filter((c) => c.selectable)
    .sort((a, b) => a.deliveryCost - b.deliveryCost)[0];
  if (!chosen) return undefined;
  return {
    date: expectedDispatchDate(chosen.schedule),
    fallsOnSunday: dispatchFallsOnSunday(chosen.schedule),
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
  /** Excepción auditada a la regla de adelanto/pago del historial. */
  riskExceptionReason?: string | null;
  /**
   * Excepción auditada al respaldo del pin. Se exige por escrito porque emitir
   * con un pin que el pedido contradice manda el paquete a otro departamento:
   * es lo que le pasó a #KP133769. Si el pin es correcto y quien se equivocó
   * fue el desplegable del checkout, aquí se deja dicho.
   */
  pinExceptionReason?: string | null;
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

export interface AliclikCreateResult {
  error?: string;
  notice?: string;
  /** El número que devolvió Aliclik, si el pedido llegó a crearse allá. */
  orderNumber?: string;
  /** Otra creación de este pedido tiene el candado: no es un fallo de este intento. */
  locked?: boolean;
  /** Aliclik no respondió a tiempo: el pedido PUEDE haberse creado. */
  timedOut?: boolean;
}

/**
 * Quién pidió la guía cuando no fue una persona. Va aparte de `CreateGuideInput`
 * a propósito: ese tipo es lo que manda el navegador a la acción, y nadie debe
 * poder firmar una guía suya como automática.
 */
export interface AliclikGuideOrigin {
  kind: "envio_programado";
  /** El día programado (YYYY-MM-DD), que es por lo que se creó hoy. */
  scheduledOn: string;
  /** El motivo que queda en el hecho `guide_registered`. */
  reason: string;
}

export async function createAliclikGuideFor(
  ctx: AliclikContext,
  input: CreateGuideInput,
  scope?: AliclikReadScope,
  origin?: AliclikGuideOrigin,
): Promise<AliclikCreateResult> {
  if (!env.aliclikWriteEnabled()) {
    return { error: "La escritura hacia Aliclik está desactivada en este entorno (ALICLIK_WRITE_ENABLED)." };
  }
  const orderId = ctx.row.order_id;

  const admin = createAdminSupabase();
  const confirmationBrief = await getOrderConfirmationBrief(orderId, scope);
  if (!confirmationBrief) {
    return { error: "No se pudo verificar el historial del cliente antes de crear la guía." };
  }
  // La misma compuerta que la vista previa, repetida acá A PROPÓSITO: la vista
  // previa es una cortesía y esto es la creación real. Un cliente viejo, un
  // reintento o una llamada directa a la acción no pueden saltarse el bloqueo.
  const prepaidBlock = aliclikPrepaidBlocker({
    financialStatus: ctx.row.financial_status,
    totalRefunded: ctx.row.total_refunded,
    paymentState: ctx.row.payment_state,
    paymentGateway: ctx.row.payment_gateway,
  });
  if (prepaidBlock) return { error: prepaidBlock };

  // El bloqueo por rechazo en la puerta va ANTES que el de plata, y no se
  // parece a él: no pregunta cuánto hay que cobrar por adelantado sino si esta
  // ruta sigue abierta para este cliente. No tiene excepción —ver
  // `aliclikDoorBan`— así que tampoco lee `input`: no hay nada que escribir que
  // lo levante.
  if (confirmationBrief.doorRejections === null) {
    // No se pudo leer el historial de guías. Cero y «no sé» se despachan
    // distinto: lo segundo no autoriza nada.
    return {
      error:
        "No se pudo verificar si este cliente tiene rechazos en la puerta. " +
        "Vuelve a intentarlo; si sigue fallando, despáchalo por agencia o Swayp.",
    };
  }
  const doorBan = aliclikDoorBan(confirmationBrief.doorRejections);
  if (doorBan.banned) return { error: doorBan.message ?? "Aliclik está cerrado para este cliente." };

  const duplicateCheck = await duplicateHold(orderId, scope);
  if ("error" in duplicateCheck) return { error: duplicateCheck.error };
  if (!duplicateCheck.hold.allowed) return { error: duplicateCheck.hold.message ?? "Resuelve el posible duplicado antes de crear otra guía." };

  const riskGate = aliclikRiskGate(
    confirmationBrief.risk.requirement,
    ctx.row.payment_state,
    input.riskExceptionReason,
  );
  if (!riskGate.allowed) return { error: riskGate.message ?? "Falta validar el pago exigido." };
  const riskExceptionReason = riskGate.requiresException
    ? input.riskExceptionReason?.trim() ?? null
    : null;
  const pinExceptionReason = input.pinExceptionReason?.trim() || null;

  // El pedido no puede tener ya una guía activa: ver `activeAliclikBlocker`.
  // «No se pudo leer» no autoriza, igual que con los rechazos en la puerta.
  const live = await activeAliclikBlocker(admin, orderId);
  if (live.error) return { error: live.error };
  const activeGuide = live.guide;
  if (activeGuide) {
    return { error: `Este pedido ya tiene una guía activa (${activeGuide.guide_code}).` };
  }

  // Se REVALIDA todo en el servidor. Lo que mandó el navegador es una intención,
  // no un hecho: entre el preview y el clic pudo cambiar el stock, el catálogo o
  // la ventana express.
  const preview = await previewAliclikGuideFor(
    ctx,
    {
      coordinate: input.coordinate,
      modality: "cod",
      pinExceptionReason: input.pinExceptionReason,
    },
    scope,
  );
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

  // Cotizar puede tardar: volver a leer pagos, resoluciones y salidas antes de
  // registrar la intención. Una excepción de antecedentes NO abre esta puerta.
  const finalDuplicateCheck = await duplicateHold(orderId, scope);
  if ("error" in finalDuplicateCheck) return { error: finalDuplicateCheck.error };
  if (!finalDuplicateCheck.hold.allowed) return { error: finalDuplicateCheck.hold.message ?? "El posible duplicado sigue retenido." };

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
      return { error: await describeLockedIntent(admin, orderId), locked: true };
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
      timedOut: true,
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
    // La fecha que corresponde según la regla del propio Aliclik, con el corte
    // que su cotización dio para ESTE courier y almacén. No viaja en la
    // petición —su API de contra entrega no admite fecha— pero queda guardada
    // para contrastarla después con la que ellos pongan en su reporte.
    aliclik_expected_dispatch_date: expectedDispatchDate(courierBlock.schedule),
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
      orderNumber,
      error: `El pedido se creó en Aliclik (${orderNumber}) pero no se pudo guardar la guía: ${written.error}`,
    };
  }

  const registeredAt = new Date().toISOString();
  await admin.from("order_events").insert([
    {
      store_id: ctx.storeId,
      order_id: orderId,
      kind: "guide_registered",
      occurred_at: registeredAt,
      actor: ctx.userId,
      source: "aliclik",
      courier: "aliclik",
      guide_code: orderNumber,
      // La guía automática no tiene persona detrás: el motivo dice por qué se
      // creó sola y el payload, con qué día programado (MOM §6.2).
      ...(origin ? { reason: origin.reason } : {}),
      payload: {
        ...(origin ? { auto: { kind: origin.kind, scheduled_on: origin.scheduledOn } } : {}),
        transportName: courierBlock.transportName,
        deliveryCost: courierBlock.deliveryCost,
        returnCost: courierBlock.returnCost,
        warehouseId: preview.warehouseId,
        ubigeo: preview.aliclikUbigeo,
      },
    },
    ...(riskExceptionReason
      ? [
          {
            store_id: ctx.storeId,
            order_id: orderId,
            kind: "aliclik_risk_exception",
            occurred_at: registeredAt,
            actor: ctx.userId,
            source: "manual",
            courier: "aliclik",
            guide_code: orderNumber,
            reason: riskExceptionReason,
            payload: {
              requirement: confirmationBrief.risk.requirement,
              payment_state: ctx.row.payment_state,
              antecedents: confirmationBrief.risk.antecedents,
            },
          },
        ]
      : []),
    // La excepción al pin se anota aparte y SIEMPRE que se usó: es el único
    // rastro de que alguien emitió sabiendo que el pedido decía otro
    // departamento, y el ubigeo del pin queda guardado al lado para poder
    // releerlo cuando el paquete vuelva.
    ...(pinExceptionReason
      ? [
          {
            store_id: ctx.storeId,
            order_id: orderId,
            kind: "aliclik_pin_exception",
            occurred_at: registeredAt,
            actor: ctx.userId,
            source: "manual",
            courier: "aliclik",
            guide_code: orderNumber,
            reason: pinExceptionReason,
            payload: {
              ubigeo: preview.aliclikUbigeo,
              aviso: preview.pinSinCorroborar ?? null,
            },
          },
        ]
      : []),
  ]);

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
      const creator = ctx.userId ? (await resolveEmails([ctx.userId])).get(ctx.userId) ?? null : null;
      await admin.from("lead_calls").insert({
        lead_id: leadId,
        store_id: ctx.storeId,
        // SIN vendedora, y no por descuido. `computeAdvisorConversionByDay`
        // atribuye la venta a quien hizo la ÚLTIMA interacción del lead, de
        // cualquier tipo. Firmar esta nota le robaría la venta a la asesora que
        // la cerró y se la daría a quien creó la guía — que puede ser otra
        // persona, o la misma en lote horas después. Quién creó la guía consta
        // en `order_events`, que es la auditoría de verdad; esto es solo la
        // anotación en el historial del lead. Por eso el nombre va en el TEXTO
        // (`guideCreatorPhrase`): sin él la nota se leía como «Automático».
        vendedora: null,
        kind: "system",
        new_status: null,
        note:
          `Guía de Aliclik creada ${guideCreatorPhrase(creator, Boolean(origin))} · ${orderNumber} · ` +
          `pedido ${ctx.row.order_name ?? "—"} · ` +
          `cobrar S/ ${(preview.collectTotal ?? 0).toFixed(2)} · ` +
          `${courierBlock.transportName ?? "courier"} S/ ${courierBlock.deliveryCost}`,
      });
    }
  } catch {
    /* el historial es una comodidad; la guía ya existe y no se toca */
  }

  await recomputeOrderMasterSafe(admin, [orderId]);
  return {
    orderNumber,
    notice:
      `Guía creada en Aliclik para ${ctx.row.order_name ?? "el pedido"}: ${orderNumber} · ` +
      `cobrar S/ ${(preview.collectTotal ?? 0).toFixed(2)} · ` +
      `${courierBlock.transportName ?? "courier"} S/ ${courierBlock.deliveryCost}.`,
  };
}
