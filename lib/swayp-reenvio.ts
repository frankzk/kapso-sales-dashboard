// Reenvío de una guía por Swayp: las rejas y el alta, en un solo sitio.
//
// Vivía dentro de app/dashboard/envios/actions.ts, un archivo "use server" cuyas
// exportaciones son acciones llamables desde el navegador. Se movió acá para que
// el agente de voz (MOM §11.8) cree la salida por EXACTAMENTE el mismo camino que
// el botón «Reenviar por Swayp»: misma cobertura, mismo stock ítem por ítem, mismo
// vínculo de codbar y el número emitido por Swayp. Una reja duplicada es una reja
// que un día se desincroniza.
//
// Nada de acá lee la sesión: quien llama decide quién es el actor (`ctx.userId`,
// nulo para el agente de voz) y ya autorizó el acceso.

import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import {
  createGuide,
  isSwaypAuthError,
  swaypAuthErrorHint,
  swaypOptsFromEnv,
} from "@/lib/swayp";
import { buildSwaypGuideInput, parseSenders } from "@/lib/swayp-guide";
import { avisoSinVinculoSwayp, productosSinVinculo } from "@/lib/swayp-productos";
import { cargarMapaSwayp } from "@/lib/swayp-sku-map";
import {
  coverageInputOf,
  evaluateDirectFenixStock,
  evaluateFenix,
  FENIX_COVERAGE_COLUMNS,
  type FenixCoverageRow,
  type FenixEligibility,
  type FenixStockRow,
} from "@/lib/fenix";
import {
  deriveFenixCoverageCity,
  effectiveOrderName,
  isFutureShipmentFollowup,
  shipmentRequiresCourierResult,
} from "@/lib/shipments";
import {
  reprogramDestination,
  shopifyShippingAddress,
  type ShipmentDestination,
} from "@/lib/shopify-address";
import { normalizePhone } from "@/lib/phone";
import type { OrderLineItem, OrderShippingAddress } from "@/lib/types";

/**
 * Reevalúa la cobertura y el stock de un envío contra el inventario de hoy.
 *
 * PIDE EL DESTINO COMPLETO, no solo `city`. El alta por la API de Aliclik deja
 * esa columna vacía —219 envíos, 85 de ellos pendientes— y `evaluateFenix` la
 * deriva del distrito, pero solo si se la pasan. Cuando esta reja leía `city` a
 * secas, la cola mostraba «Swayp Ok» (la lectura sí trae el distrito) y el botón
 * respondía «Swayp no tiene cobertura en la ciudad indicada» sobre el mismo
 * envío. La frase delataba el bug: «la ciudad indicada» es el texto de respaldo
 * de cuando `city` es NULL.
 */
export async function resolveCurrentFenixEligibility(
  admin: SupabaseClient,
  storeId: string,
  shipment: FenixCoverageRow & { product: string | null; order_id: string | null },
): Promise<FenixEligibility | { error: string }> {
  const { data: store, error: storeError } = await admin
    .from("stores")
    .select("org_id")
    .eq("id", storeId)
    .maybeSingle();
  if (storeError || !store) return { error: storeError?.message ?? "No se encontró la organización." };

  const stockPromise = admin
    .from("fenix_stock")
    .select("city,product,sku,quantity,unlimited")
    .eq("org_id", (store as { org_id: string }).org_id);
  const orderPromise = shipment.order_id
    ? admin.from("orders").select("line_items").eq("id", shipment.order_id).maybeSingle()
    : Promise.resolve({ data: null, error: null });
  const [{ data: stock, error: stockError }, { data: order, error: orderError }] = await Promise.all([
    stockPromise,
    orderPromise,
  ]);
  if (stockError || orderError) return { error: stockError?.message ?? orderError?.message ?? "No se pudo consultar el stock." };

  const lineItems = (order as {
    line_items?: { title?: string | null; sku?: string | null }[] | null;
  } | null)?.line_items ?? undefined;
  return evaluateFenix(coverageInputOf(shipment), (stock as FenixStockRow[]) ?? [], lineItems);
}

/** Row shape shared by the preview and the create re-validation. */
export interface DirectGuideOrderRecord {
  id: string;
  store_id: string;
  shopify_order_id: string | null;
  name: string | null;
  total_amount: number | null;
  currency: string | null;
  cancelled_at: string | null;
  total_refunded: number | null;
  customer_phone: string | null;
  line_items: OrderLineItem[] | null;
  raw?: unknown;
}

export const DIRECT_GUIDE_ORDER_COLUMNS =
  "id,store_id,shopify_order_id,name,total_amount,currency,cancelled_at,total_refunded,customer_phone,line_items,raw";

/**
 * Delivery address of an order, best source first: the Shopify payload, the
 * originating COD draft cart, or the lead that produced a manual sale — manual
 * orders (venta por llamada) have no Shopify address at all.
 */
export async function resolveDirectGuideAddress(
  admin: SupabaseClient,
  order: DirectGuideOrderRecord,
): Promise<{ address: OrderShippingAddress | null; source: "shopify" | "carrito" | "lead" | null }> {
  const fromRaw = shopifyShippingAddress(order.raw);
  if (fromRaw) return { address: fromRaw, source: "shopify" };

  const isRealShopifyOrder = !!order.shopify_order_id && /^\d+$/.test(order.shopify_order_id);
  if (isRealShopifyOrder) {
    const { data: draft } = await admin
      .from("draft_orders")
      .select("address1,referencia,district,province,customer_name,customer_phone")
      .eq("order_gid", `gid://shopify/Order/${order.shopify_order_id}`)
      .maybeSingle();
    const d = draft as {
      address1?: string | null;
      referencia?: string | null;
      district?: string | null;
      province?: string | null;
      customer_name?: string | null;
      customer_phone?: string | null;
    } | null;
    if (d?.address1 || d?.district) {
      return {
        address: {
          address1: d.address1 ?? null,
          address2: d.referencia ?? null,
          city: d.district ?? null,
          province: d.province ?? null,
          name: d.customer_name ?? null,
          phone: d.customer_phone ?? null,
          // Un carrito abandonado no pasa por el checkout, así que Shopify
          // nunca llega a geocodificar la dirección.
          latitude: null,
          longitude: null,
        },
        source: "carrito",
      };
    }
  }

  const { data: lead } = await admin
    .from("leads")
    .select("ship_name,address1,referencia,district,province,region,phone")
    .eq("order_id", order.id)
    .maybeSingle();
  const l = lead as {
    ship_name?: string | null;
    address1?: string | null;
    referencia?: string | null;
    district?: string | null;
    province?: string | null;
    region?: string | null;
    phone?: string | null;
  } | null;
  if (l?.address1 || l?.district) {
    return {
      address: {
        address1: l.address1 ?? null,
        address2: l.referencia ?? null,
        city: l.district ?? null,
        province: l.province ?? l.region ?? null,
        name: l.ship_name ?? null,
        phone: l.phone ?? null,
        // La dirección de un lead la escribe el equipo a mano: sin geocodificar.
        latitude: null,
        longitude: null,
      },
      source: "lead",
    };
  }
  return { address: null, source: null };
}

/**
 * El mapa SKU de Shopify → codbar de Swayp, de toda la ORGANIZACIÓN.
 *
 * El alcance es de la organización y no de la tienda porque el codbar es un
 * hecho del producto en Swayp: el mismo frasco tiene el mismo código lo venda
 * Aurela o Kenku Peru, que comparten bodega. Acotado a la tienda, 18 de los 19
 * productos vinculados eran invisibles para la otra y sus pedidos morían en
 * «Falta vincular a Swayp» con el codbar ya escrito (15-09-2026). La regla vive
 * en lib/swayp-sku-map.ts, que es la que leen también el catálogo y el
 * importador — tres lectores, una definición.
 *
 * Vacío cuando no hay nada vinculado, y eso APAGA la función: la guía sale como
 * hasta hoy, sin `productos`. Ver `BuildGuideInput.skuMap` para por qué el mapa
 * es el interruptor. Ante un error de lectura devuelve vacío en vez de lanzar:
 * no conseguir el dato no bloquea una operación viva.
 */
export async function loadSwaypSkuMap(
  admin: SupabaseClient,
  storeId: string,
): Promise<Map<string, { codbar: string; nombre?: string | null }>> {
  return cargarMapaSwayp(admin, storeId);
}

/**
 * Pide la guía a Swayp y devuelve el número que ELLOS emiten — el reemplazo del
 * código inventado localmente por autoFenixGuideCode/rescheduleGuideCode.
 *
 * Nunca lanza: cualquier problema (integración apagada, bodega sin configurar,
 * dirección inválida, API caída, token muerto) vuelve como `skipped` y el
 * llamador sigue con el alta manual. Es una operación viva; dejar al operador
 * bloqueado porque un courier no responde sería peor que una guía manual.
 *
 * No reintenta a propósito: la API no acepta clave de idempotencia, así que un
 * POST repetido tras un timeout crearía una segunda guía y un segundo paquete.
 */
export async function createFenixGuideViaApi(args: {
  admin: SupabaseClient;
  /** Tienda del pedido: el mapa de productos es por tienda. */
  storeId: string;
  city: string;
  district: string | null;
  customerName: string | null;
  customerPhone: string | null;
  address1: string | null;
  reference: string | null;
  lineItems: Array<{ title: string; quantity: number; sku?: string | null }>;
  codAmount: number;
  dispatchDateIso?: string | null;
  observaciones?: string | null;
}): Promise<{ ok: true; guia: string; idEstado: number } | { ok: false; reason: string }> {
  if (!env.swaypEnabled()) return { ok: false, reason: "integración Swayp desactivada" };

  const built = buildSwaypGuideInput({
    ...args,
    senders: parseSenders(env.swaypSenders()),
    idBusiness: env.swaypIdBusiness(),
    skuMap: await loadSwaypSkuMap(args.admin, args.storeId),
  });
  if (!built.ok) return { ok: false, reason: built.error };

  const opts = swaypOptsFromEnv();
  try {
    const created = await createGuide(opts, built.input);
    return { ok: true, guia: String(created.guia), idEstado: created.idEstado };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error desconocido";
    // Visible en los logs de Vercel. El motivo también sube al operador en el
    // aviso de la acción, que es hoy la única señal de que la API dejó de
    // responder — el token de Swayp no se puede renovar por código.
    const hint = isSwaypAuthError(e) ? swaypAuthErrorHint(opts) : null;
    console.error(hint ? `[swayp] CREDENCIAL: ${hint}` : "[swayp] createGuide falló:", msg);
    return { ok: false, reason: hint ?? msg };
  }
}

/**
 * Pide a Swayp el número de guía para el pedido de un envío que se reprograma.
 *
 * POR QUÉ EXISTE. La reprogramación desde Repro Provincia inventaba el código
 * localmente (`rescheduleGuideCode`) y nunca hablaba con Swayp: la guía había
 * que cargarla después a mano por el Excel de programación. El comentario de
 * `createFenixGuide` lo declaraba pendiente desde el #294 —«API-ready: a later
 * phase swaps the manual guideCode for createFenixGuideViaApi()»—; esto es esa
 * fase.
 *
 * LA FRONTERA POR CIUDAD NO SE DECIDE ACÁ, y es deliberado. `SWAYP_SENDERS`
 * solo tiene las ciudades habilitadas por API —hoy Arequipa—, así que un
 * destino de otra provincia falla dentro de `buildSwaypGuideInput` con «No hay
 * bodega Swayp configurada para …» y el llamador cae al código local. Habilitar
 * Trujillo será agregar una clave al JSON, sin tocar código ni reentrenar a
 * nadie.
 *
 * Devuelve el motivo en vez de lanzar: para el llamador, no conseguir número de
 * Swayp no es un error —es seguir por Excel, como hasta hoy.
 */
/**
 * Los productos de un pedido que Swayp NO tiene en su catálogo.
 *
 * LA REGLA, dicha por la operación el 16-09-2026: sin vínculo de codbar no se
 * genera guía Swayp. En Lima es la única condición que gobierna —la ciudad no
 * lleva control de cantidad a propósito— y en provincia se suma al stock.
 *
 * Una sola función para todas las puertas. Antes esto solo se preguntaba dentro
 * de `buildSwaypGuide`, o sea con la llamada a la API ya en marcha: fallaba, el
 * flujo caía al código local y la guía se creaba igual.
 *
 * Devuelve vacío cuando no hay nada que afirmar —pedido ilegible, o la tienda
 * todavía no vinculó nada—: ese es el mismo interruptor que ya gobernaba
 * `buildProductos`, y con él una tienda recién configurada no se queda sin poder
 * emitir. Quien muestre esto avisa aparte de que la reja está apagada.
 */
export async function swaypSinVinculo(
  admin: SupabaseClient,
  storeId: string,
  orderId: string | null | undefined,
): Promise<string[]> {
  if (!orderId) return [];
  const { data } = await admin
    .from("orders")
    .select("line_items")
    .eq("id", orderId)
    .maybeSingle();
  const lineItems = ((data as { line_items?: OrderLineItem[] } | null)?.line_items ?? []).map((li) => ({
    title: li.title ?? "",
    quantity: li.quantity ?? 1,
    sku: li.sku ?? null,
  }));
  if (!lineItems.length) return [];
  return productosSinVinculo(lineItems, await cargarMapaSwayp(admin, storeId));
}

export async function swaypGuideForReprogram(
  admin: SupabaseClient,
  shipmentId: string,
  orderId: string | null | undefined,
  dispatchDateIso: string | null | undefined,
  note?: string | null,
): Promise<{ ok: true; guia: string; idEstado: number } | { ok: false; reason: string }> {
  if (!env.swaypEnabled()) return { ok: false, reason: "integración Swayp desactivada" };
  if (!orderId) return { ok: false, reason: "el envío no está vinculado a un pedido" };

  const { data } = await admin
    .from("orders")
    .select(DIRECT_GUIDE_ORDER_COLUMNS)
    .eq("id", orderId)
    .maybeSingle();
  const order = data as unknown as DirectGuideOrderRecord | null;
  if (!order) return { ok: false, reason: "no se pudo leer el pedido" };

  // El destino de la guía se lee ACÁ y no se recibe del llamador: que una reja
  // dependa de que quien la llama se acuerde de seleccionar las columnas justas
  // es exactamente como se coló el fallo de cobertura (MOM §19.0.2).
  const { data: destRow } = await admin
    .from("shipments")
    .select(`customer_name,customer_phone,delivery_address,delivery_reference,${FENIX_COVERAGE_COLUMNS}`)
    .eq("id", shipmentId)
    .maybeSingle();

  const address = reprogramDestination(
    destRow as ShipmentDestination | null,
    (await resolveDirectGuideAddress(admin, order)).address,
  );
  const district = address?.city ?? null;
  const city = deriveFenixCoverageCity(district, address?.province ?? null);
  const totalRefunded = order.total_refunded ?? 0;
  const lineItems = (order.line_items ?? []).map((li) => ({
    title: li.title ?? "",
    quantity: li.quantity ?? 1,
    sku: li.sku ?? null,
  }));

  // Stock ÍTEM POR ÍTEM, el mismo criterio que la guía directa. La reja de más
  // arriba (`resolveCurrentFenixEligibility`) usa `evaluateFenix`, que aprueba
  // si CUALQUIER producto tiene stock; sirve para decidir si el envío se sigue
  // trabajando, pero no para mandar un paquete: en un pedido de dos productos
  // con uno solo en bodega, Swayp recibiría una guía que su almacén no puede
  // armar. Falla suave —se cae al código local— porque hasta hoy este camino
  // no validaba nada y bloquear al operador sería una regresión.
  const { data: store } = await admin
    .from("stores")
    .select("org_id")
    .eq("id", order.store_id)
    .maybeSingle();
  const orgId = (store as { org_id?: string } | null)?.org_id;
  if (!orgId) return { ok: false, reason: "no se encontró la organización de la tienda" };
  const { data: stock, error: stockError } = await admin
    .from("fenix_stock")
    .select("city,product,sku,quantity,unlimited")
    .eq("org_id", orgId);
  if (stockError) return { ok: false, reason: `no se pudo consultar el stock: ${stockError.message}` };
  const check = evaluateDirectFenixStock(city, (stock as FenixStockRow[]) ?? [], lineItems);
  if (!check.ok) {
    return {
      ok: false,
      reason:
        check.reason === "sin_stock"
          ? `sin stock en ${city} para: ${check.uncovered.join(", ")}`
          : `sin cobertura en ${district || "el destino"}`,
    };
  }

  return createFenixGuideViaApi({
    admin,
    storeId: order.store_id,
    city,
    district,
    customerName: address?.name ?? null,
    customerPhone: order.customer_phone ?? normalizePhone(address?.phone) ?? null,
    address1: address?.address1 ?? null,
    reference: address?.address2 ?? null,
    lineItems,
    codAmount: Math.max(0, (order.total_amount ?? 0) - totalRefunded),
    dispatchDateIso: dispatchDateIso ?? null,
    observaciones: note?.trim() || null,
  });
}

/**
 * Spin off a Swayp sub-guide from a shipment: insert a second shipments row
 * (courier='fenix', En ruta) carrying the order snapshot, then freeze the source
 * shipment as `transferido` (the Swayp guide is the active shipment going
 * forward) and log the hand-off. Shared by the manual `createFenixGuide` and the
 * automatic confirma flow in `registerRerouteCall`. `guideCode` is normalized
 * (trim + uppercase). Returns the new child id + code, or an error (missing code,
 * source already transferred, or a unique violation = code already used in Swayp).
 */
export async function spinOffFenixGuide(
  admin: SupabaseClient,
  ctx: { userId: string | null; storeId: string },
  shipmentId: string,
  guideCode: string,
  opts: {
    childNextFollowupAt?: string | null;
    expectedSourceStatus?: string;
    parentAuditNote?: string;
    /**
     * Número y estado que EMITIÓ Swayp, cuando la guía se pidió por API. Sin
     * esto la hija quedaría con el número correcto en `guide_code` y
     * `swayp_guide` nulo — y el webhook busca por esa columna
     * (`swayp-ingest.ts:96`), así que jamás encontraría la guía y el envío se
     * quedaría En ruta para siempre por más que Swayp reportara.
     */
    swaypGuide?: string | null;
    swaypState?: number | null;
  } = {},
): Promise<{ error: string } | { childId: string; guideCode: string }> {
  const code = guideCode.trim().toUpperCase();
  if (!code) return { error: "Ingresa el número de guía de Swayp." };

  const fetchParent = (columns: string) => admin
    .from("shipments")
    .select(columns)
    .eq("id", shipmentId)
    .maybeSingle();
  let parentResult = await fetchParent(
    "courier,delivery_status,store_id,order_id,order_name,customer_name,customer_phone,product,district,province,city,region,delivery_address,delivery_reference,latitude,longitude,address_override,address_updated_at,address_updated_by,fenix_shipment_id",
  );
  if (parentResult.error) {
    parentResult = await fetchParent(
      "courier,delivery_status,store_id,order_id,order_name,customer_name,customer_phone,product,district,city,region,fenix_shipment_id",
    );
  }
  const parent = parentResult.data;
  if (!parent) return { error: "No encontrado." };
  const source = parent as unknown as {
    courier: string;
    delivery_status: string;
    fenix_shipment_id: string | null;
  };
  if (shipmentRequiresCourierResult(source.courier, source.delivery_status)) {
    return { error: "Primero registra el resultado del courier antes de crear otra guía Swayp." };
  }
  if (source.fenix_shipment_id) {
    return { error: "Este envío ya tiene una guía Swayp." };
  }
  if (opts.expectedSourceStatus && source.delivery_status !== opts.expectedSourceStatus) {
    return { error: "La guía cambió de estado antes de guardar. Actualiza el panel y vuelve a revisarla." };
  }

  const p = parent as unknown as Record<string, unknown>;

  // LA REJA DEL CODBAR, en el único sitio por el que pasan las tres puertas que
  // paren una guía Swayp: la reprogramación confirmada, el reenvío de una guía
  // anulada y el alta con número escrito a mano. Ponerla en cada puerta habría
  // dejado la cuarta sin ella el día que alguien añada una. Ver `swaypSinVinculo`.
  const faltan = await swaypSinVinculo(
    admin,
    (p.store_id as string) ?? ctx.storeId,
    (p.order_id as string | null) ?? null,
  );
  if (faltan.length) return { error: avisoSinVinculoSwayp(faltan) };
  const { data: child, error: insErr } = await admin
    .from("shipments")
    .insert({
      courier: "fenix",
      guide_code: code,
      store_id: p.store_id,
      order_id: p.order_id,
      matched: !!p.order_id,
      match_method: "manual",
      order_name: p.order_name,
      customer_name: p.customer_name,
      customer_phone: p.customer_phone,
      product: p.product,
      district: p.district,
      province: p.province,
      city: p.city,
      region: p.region,
      delivery_address: p.delivery_address,
      delivery_reference: p.delivery_reference,
      latitude: p.latitude,
      longitude: p.longitude,
      address_override: p.address_override,
      address_updated_at: p.address_updated_at,
      address_updated_by: p.address_updated_by,
      delivery_status: "en_ruta",
      status_category: "in_route",
      next_followup_at: opts.childNextFollowupAt ?? null,
      swayp_guide: opts.swaypGuide ?? null,
      swayp_state: opts.swaypState ?? null,
    })
    .select("id")
    .single();
  if (insErr || !child) {
    // unique(courier, guide_code) violation → this code was already used in Swayp
    const dup = (insErr as { code?: string } | null)?.code === "23505";
    return {
      error: dup
        ? `Ya existe una guía Swayp con el código ${code}. Elige otra fecha de reprogramación.`
        : (insErr?.message ?? "No se pudo crear la guía Swayp."),
    };
  }

  // Transfer the source guide atomically: the UPDATE only matches while
  // fenix_shipment_id is still null, so two concurrent spin-offs can't both
  // transfer the same parent (each would otherwise leave an orphan En ruta
  // child). If we lost the race, roll back the child we just inserted.
  let transferQuery = admin
    .from("shipments")
    .update({
      fenix_shipment_id: child.id,
      delivery_status: "transferido",
      status_category: "transferred",
      // the source guide is now terminal — free its claim so the queue releases it
      claimed_by: null,
      claimed_at: null,
    })
    .eq("id", shipmentId)
    .is("fenix_shipment_id", null);
  if (opts.expectedSourceStatus) {
    transferQuery = transferQuery.eq("delivery_status", opts.expectedSourceStatus);
  }
  const { data: transferred, error: updErr } = await transferQuery
    .select("id")
    .maybeSingle();
  if (updErr || !transferred) {
    await admin.from("shipments").delete().eq("id", child.id);
    return { error: "Este envío acaba de recibir otra guía Swayp. Actualiza y reintenta." };
  }
  await admin.from("shipment_calls").insert({
    shipment_id: shipmentId,
    store_id: ctx.storeId,
    agent: ctx.userId,
    kind: "reroute",
    new_status: "transferido",
    note: opts.parentAuditNote ?? `Guía Swayp creada: ${code}`,
  });

  return { childId: child.id as string, guideCode: code };
}

/**
 * «Reenviar por Swayp» sobre una guía anulada: el cuerpo de la acción de
 * Envíos, sin la sesión. La guía anulada nunca se reabre; queda como madre
 * `transferido` y nace una hija Swayp En ruta con la fecha pedida.
 *
 * Las rejas van en este orden y ninguna se salta:
 * - la guía sigue anulada y sin reemplazo;
 * - el pedido tiene número;
 * - hay cobertura y stock hoy, no el flag guardado;
 * - Swayp emite el número (stock ítem por ítem y vínculo de codbar dentro);
 * - el codbar se vuelve a comprobar en `spinOffFenixGuide`.
 *
 * Sin número de Swayp no se registra nada. La llaman el botón de Envíos y el
 * agente de voz (MOM §11.8).
 */
export async function reenviarGuiaAnulada(
  admin: SupabaseClient,
  ctx: { userId: string | null; storeId: string },
  shipmentId: string,
  input: { nextFollowupAt?: string | null; note?: string | null },
): Promise<{ error: string } | { childId: string; guideCode: string; sourceGuide: string }> {
  const note = input.note?.trim() ?? "";
  if (!note) {
    return { error: "Explica por qué se autoriza reprogramar esta guía anulada." };
  }
  if (!isFutureShipmentFollowup(input.nextFollowupAt)) {
    return { error: "Elige una fecha futura para la nueva entrega." };
  }

  const { data: shipment, error: shipmentError } = await admin
    .from("shipments")
    .select(
      `id,courier,guide_code,delivery_status,order_id,order_name,${FENIX_COVERAGE_COLUMNS},product,fenix_eligible,fenix_shipment_id`,
    )
    .eq("id", shipmentId)
    .maybeSingle();
  if (shipmentError || !shipment) {
    return { error: shipmentError?.message ?? "Guía no encontrada." };
  }

  const current = shipment as unknown as {
    guide_code: string;
    delivery_status: string;
    order_id: string | null;
    order_name: string | null;
    city: string | null;
    district?: string | null;
    province?: string | null;
    region?: string | null;
    product: string | null;
    fenix_eligible: boolean;
    fenix_shipment_id: string | null;
  };
  if (current.delivery_status !== "anulado") {
    return { error: "La guía ya cambió de estado. Actualiza el panel antes de continuar." };
  }
  if (current.fenix_shipment_id) {
    return { error: "Esta guía anulada ya tiene una guía Swayp de reemplazo." };
  }

  // La copia del envío puede estar vacía aunque el enlace exista (ver
  // `effectiveOrderName`): se lee la fuente antes de darse por vencido.
  let linkedOrderName: string | null = null;
  if (!current.order_name && current.order_id) {
    const { data: linked } = await admin
      .from("orders")
      .select("name")
      .eq("id", current.order_id)
      .maybeSingle();
    linkedOrderName = (linked as { name: string | null } | null)?.name ?? null;
  }
  // El N° de pedido hace falta para pedirle la guía a Swayp, que declara los
  // productos del pedido.
  if (!effectiveOrderName(current.order_name, linkedOrderName)?.trim()) {
    return { error: "Este envío no tiene N° de pedido, así que Swayp no puede emitir la nueva guía." };
  }

  // Nunca el flag guardado: el inventario pudo cambiar desde la importación
  // o desde que se abrió el cajón.
  const currentFenix = await resolveCurrentFenixEligibility(admin, ctx.storeId, current);
  if ("error" in currentFenix) {
    return { error: `No se pudo validar el stock Swayp: ${currentFenix.error}` };
  }
  if (currentFenix.eligible !== current.fenix_eligible) {
    await admin
      .from("shipments")
      .update({ fenix_eligible: currentFenix.eligible })
      .eq("id", shipmentId);
  }
  if (!currentFenix.eligible) {
    return {
      error: currentFenix.reason === "sin_stock"
        ? `Swayp no tiene stock disponible para este pedido en ${currentFenix.city || current.district || "la ciudad indicada"}.`
        : `Swayp no tiene cobertura en ${currentFenix.city || current.district || "la ciudad indicada"}.`,
    };
  }

  // Va DESPUÉS de la reja de stock a propósito: pedirle un número a Swayp para
  // un envío que vamos a rechazar por falta de inventario dejaría una guía
  // huérfana en su sistema, y la API no tiene forma de deshacerla.
  const viaApi = await swaypGuideForReprogram(
    admin,
    shipmentId,
    current.order_id,
    input.nextFollowupAt,
    note,
  );
  // Sin número de Swayp no hay guía: ver la reja gemela en `registerRerouteCall`.
  if (!viaApi.ok) {
    return { error: `Swayp no emitió la guía: ${viaApi.reason}. El reenvío no se registró.` };
  }
  const guideCode = String(viaApi.guia);

  const auditNote = `Excepción sobre guía anulada ${current.guide_code}. Motivo: ${note}`;
  const spun = await spinOffFenixGuide(admin, ctx, shipmentId, guideCode, {
    childNextFollowupAt: input.nextFollowupAt,
    expectedSourceStatus: "anulado",
    parentAuditNote: `${auditNote}. Nueva guía Swayp: ${guideCode}.`,
    // Sin esto la hija tendría el número correcto en `guide_code` y
    // `swayp_guide` nulo — y el webhook busca por esa columna, así que el envío
    // se quedaría En ruta para siempre por más que el mensajero reportara.
    swaypGuide: String(viaApi.guia),
    swaypState: viaApi.idEstado,
  });
  if ("error" in spun) return { error: spun.error };

  await admin.from("shipment_calls").insert({
    shipment_id: spun.childId,
    store_id: ctx.storeId,
    agent: ctx.userId,
    kind: "reroute",
    new_status: "en_ruta",
    note: `${auditNote}. Esta es la nueva guía activa.`,
    next_followup_at: input.nextFollowupAt,
  });

  return { childId: spun.childId, guideCode: spun.guideCode, sourceGuide: current.guide_code };
}
