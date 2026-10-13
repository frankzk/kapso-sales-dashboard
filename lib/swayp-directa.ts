// La guía Swayp DIRECTA, en un solo sitio (MOM §11.11 y §11.13).
//
// POR QUÉ ESTÁ ACÁ Y NO EN LA ACCIÓN. La emitían solo las personas, desde el
// botón (`createDirectFenixGuide`). Desde el 13-10-2026 también la emite el
// automático desde Por confirmar, que corre en un cron sin sesión. Las rejas
// —pedido sano, otra salida viva, stock de TODOS los productos, vínculo con
// Swayp, fecha de despacho, número que emite Swayp— tienen que ser las mismas
// para los dos: dos copias acabarían diciendo cosas distintas sobre el mismo
// pedido. La acción conserva lo que es de una persona: el permiso, la sesión y
// leer el pedido con su RLS.
//
// No se exporta desde el archivo de acciones a propósito: todo lo que exporta
// un archivo `"use server"` es un endpoint que cualquiera puede llamar.

import type { SupabaseClient } from "@supabase/supabase-js";
import { SWAYP_SUNDAY_ERROR, isSwaypDispatchDay } from "@/lib/swayp-dispatch-days";
import { SWAYP_DESDE_CONFIRMACION_KIND } from "@/lib/swayp-desde-confirmacion";
import { recomputeOrderMasterForShipmentsSafe } from "@/lib/order-master";
import { deriveFenixCoverageCity, limaTodayKey } from "@/lib/shipments";
import { evaluateDirectFenixStock, type FenixStockRow } from "@/lib/fenix";
import { normalizePhone } from "@/lib/phone";
import { writeCourierGuide } from "@/lib/route-output-fill";
import { isFillableRouteOutput, puertaDeSalidaAdicional } from "@/lib/shipment-output";
import { esNumeroDeGuiaSwayp } from "@/lib/swayp-guide";
import { avisoSinVinculoSwayp, productosSinVinculo } from "@/lib/swayp-productos";
import { cargarMapaSwayp } from "@/lib/swayp-sku-map";
import {
  createFenixGuideViaApi,
  resolveDirectGuideAddress,
  type DirectGuideOrderRecord,
} from "@/lib/swayp-reenvio";

// ── Guía Swayp DIRECTA: desde un pedido, sin guía Aliclik madre ──────────────
// Urgencias que salen del almacén regional de Swayp sin pasar por Aliclik. La
// guía nace En ruta con su fecha de despacho (desde mañana) y entra al Excel de
// programación de ese día como cualquier guía Swayp. Gate de creación: cobertura
// + stock de TODOS los productos del pedido; el descuento de inventario sigue
// ocurriendo al entregar (salida_entrega), igual que el resto de guías.

export interface DirectGuideExisting {
  id: string;
  guide_code: string;
  courier: string;
  delivery_status: string;
  // Lo que hace falta para saber si es una salida «por definir» rellenable, en
  // vez de una guía que de verdad estorba. Ver `esRellenable`.
  created_via?: string | null;
  custody_state?: string | null;
  custody_transferred_at?: string | null;
  output_number?: number | null;
  output_code?: string | null;
}

/**
 * ¿Esta salida se RELLENA con la guía de Swayp en vez de estorbarla?
 *
 * Una salida «por definir» es una caja armada y rotulada esperando courier. Las
 * guías de Grupo GF, Tanders, Aliclik y Shalom le escriben el courier encima
 * (`writeCourierGuide`); Swayp era el único que no, así que pedía anularla
 * primero — y anular arrastra el pedido a `anulado` (#KP127639), que es
 * exactamente el rodeo que ese mecanismo vino a cerrar.
 *
 * Delega en `isFillableRouteOutput`: dos definiciones de «rellenable» harían
 * que el aviso de la mesa prometiera una cosa y el servidor hiciera otra.
 */
export function esRellenable(g: DirectGuideExisting): boolean {
  return isFillableRouteOutput({
    courier: g.courier,
    created_via: g.created_via ?? null,
    delivery_status: g.delivery_status,
    custody_state: g.custody_state ?? null,
    custody_transferred_at: g.custody_transferred_at ?? null,
  });
}

/** Every guide already tied to the order (by FK or by carried order name). */
export async function findGuidesOfOrder(
  admin: SupabaseClient,
  order: { id: string; store_id: string; name: string | null },
): Promise<DirectGuideExisting[]> {
  const cols =
    "id,guide_code,courier,delivery_status,created_via,custody_state,custody_transferred_at,output_number,output_code";
  const { data: byOrder } = await admin.from("shipments").select(cols).eq("order_id", order.id).limit(50);
  let byName: DirectGuideExisting[] = [];
  if (order.name) {
    const { data } = await admin
      .from("shipments")
      .select(cols)
      .eq("store_id", order.store_id)
      .eq("order_name", order.name)
      .limit(50);
    byName = (data as DirectGuideExisting[]) ?? [];
  }
  const merged = new Map<string, DirectGuideExisting>();
  for (const g of [...((byOrder as DirectGuideExisting[]) ?? []), ...byName]) merged.set(g.id, g);
  return [...merged.values()];
}

export const DIRECT_GUIDE_ACTIVE_STATUSES = new Set(["pendiente", "en_ruta", "por_preparar"]);

/**
 * Lima, provincia o agencia, leído de donde lo lee la mesa de ruta manual:
 * `order_master.macro_operation`. Decide si otra salida viva bloquea (fuera de
 * Lima) o solo pide motivo (en Lima). Ver `puertaDeSalidaAdicional`.
 */
export async function operacionDelPedido(
  admin: SupabaseClient,
  orderId: string,
): Promise<"lima" | "provincia_cod" | "agencia" | "desconocida"> {
  const { data } = await admin
    .from("order_master")
    .select("macro_operation")
    .eq("order_id", orderId)
    .maybeSingle();
  const op = (data as { macro_operation?: string | null } | null)?.macro_operation ?? "";
  return op === "lima" || op === "provincia_cod" || op === "agencia" ? op : "desconocida";
}

export interface EmitirGuiaSwaypDirectaInput {
  /** El pedido ya leído por quien llama (la acción, con la RLS de la persona; el automático, con admin). */
  order: DirectGuideOrderRecord;
  /** Quien la emite; null para el automático. */
  actorId: string | null;
  dispatchDateIso: string;
  guideCode?: string;
  note?: string;
  /** Motivo de la salida adicional en Lima, con otra salida todavía viva. */
  motivoSalidaAdicional?: string | null;
  /** `por_confirmar`: sale sin confirmar y, si Swayp no entrega, vuelve a Por confirmar (MOM §11.11). */
  origen?: "por_confirmar";
  /** La emitió el automático (MOM §11.13): su evidencia viaja en el hecho. */
  automatico?: Record<string, unknown> | null;
}

export type EmitirGuiaSwaypDirectaResult =
  | { error: string }
  | { code: string; childId: string; filled: boolean; outputCode: string | null; avisoOrigen: string };

/**
 * Emite la guía Swayp directa de un pedido. Corre TODAS las rejas otra vez —no
 * se fía de la vista previa—, escribe la salida (rellenando la «por definir» si
 * la hay), deja la gestión, el hecho de Por confirmar si corresponde, y
 * recalcula el Master después del hecho, que el recálculo lee.
 */
export async function emitirGuiaSwaypDirecta(
  admin: SupabaseClient,
  input: EmitirGuiaSwaypDirectaInput,
): Promise<EmitirGuiaSwaypDirectaResult> {
  const order = input.order;
  if (order.cancelled_at) {
    return { error: "El pedido está cancelado en Shopify; no se puede crear la guía." };
  }
  const totalRefunded = order.total_refunded ?? 0;
  if ((order.total_amount ?? 0) > 0 && totalRefunded >= (order.total_amount ?? 0)) {
    return { error: "El pedido fue reembolsado por completo en Shopify; no se puede crear la guía." };
  }


  // El botón de Por confirmar solo vale donde el owner lo pensó: provincia COD
  // que todavía está por confirmar. Se lee del Master, que es donde vive esa
  // respuesta; un pedido que avanzó entre abrir la ficha y pulsar ya no es eso.
  if (input.origen === "por_confirmar") {
    const { data: master } = await admin
      .from("order_master")
      .select("macro_stage,coverage")
      .eq("order_id", order.id)
      .maybeSingle();
    const m = master as { macro_stage: string | null; coverage: string | null } | null;
    if (m?.macro_stage !== "por_confirmar") {
      return { error: "El pedido ya no está en Por confirmar. Actualiza la ficha." };
    }
    if (m.coverage !== "provincia_cod") {
      return { error: "«Enviar por Swayp» desde Por confirmar es solo para pedidos de provincia COD." };
    }
  }

  const { address } = await resolveDirectGuideAddress(admin, order);
  const district = address?.city ?? null;
  const region = address?.province ?? null;
  const city = deriveFenixCoverageCity(district, region);
  if (!district) {
    return {
      error:
        "El pedido no tiene distrito/ciudad de envío, así que no se puede validar la cobertura ni el stock Swayp. Complétalo en Shopify y reintenta.",
    };
  }

  const { data: store } = await admin
    .from("stores")
    .select("org_id")
    .eq("id", order.store_id)
    .maybeSingle();
  const orgId = (store as { org_id?: string } | null)?.org_id;
  if (!orgId) return { error: "No se encontró la organización de la tienda." };

  // Otra salida viva: fuera de Lima bloquea; en Lima pide motivo (MOM
  // principio 7 y §9 — no hay que esperar el reporte del otro courier). Una
  // «por definir» todavía en casa no cuenta: se rellena. Ver
  // `puertaDeSalidaAdicional`, la misma regla que Tanders.
  const guides = await findGuidesOfOrder(admin, order);
  const puerta = puertaDeSalidaAdicional({
    courier: "fenix",
    operation: await operacionDelPedido(admin, order.id),
    outputs: guides,
    motivo: input.motivoSalidaAdicional,
  });
  if (!puerta.ok) return { error: puerta.error };

  // Stock gate: EVERY line item must have stock in the destination city.
  const { data: stock, error: stockError } = await admin
    .from("fenix_stock")
    .select("city,product,sku,quantity,unlimited")
    .eq("org_id", orgId);
  if (stockError) return { error: `No se pudo consultar el stock Swayp: ${stockError.message}` };
  const lineItems = (order.line_items ?? []).map((li) => ({
    title: li.title ?? "",
    quantity: li.quantity ?? 1,
    sku: li.sku ?? null,
  }));
  const check = evaluateDirectFenixStock(city, (stock as FenixStockRow[]) ?? [], lineItems);
  if (!check.ok) {
    if (check.reason === "sin_stock") {
      return {
        error: `Sin stock Swayp en ${city} para: ${check.uncovered.join(", ")}. Actualiza el inventario en Stock Swayp e intenta de nuevo.`,
      };
    }
    return { error: `Swayp no tiene cobertura en ${district || "el destino del pedido"}.` };
  }

  // REJA DEL VÍNCULO. Sin esto, un producto que Swayp no conoce llegaba hasta la
  // llamada a la API, esta fallaba con «Falta vincular a Swayp», y el flujo caía
  // al código local y CREABA LA GUÍA IGUAL: una caja despachada contra un número
  // que Swayp nunca emitió, con el fallo contado en un aviso al final.
  //
  // El respaldo del código local sigue vivo para lo que de verdad es una
  // limitación de Swayp —una ciudad que su API no atiende—. Un vínculo que falta
  // es un hueco NUESTRO, se arregla en dos minutos y no puede despachar una caja
  // mientras tanto.
  const sinVinculo = productosSinVinculo(lineItems, await cargarMapaSwayp(admin, order.store_id));
  if (sinVinculo.length) return { error: avisoSinVinculoSwayp(sinVinculo) };

  // Dispatch date: required, from tomorrow (Lima) onward — the day's Excel is
  // usually already sent, so a same-day guide would never reach Swayp.
  const dispatchDay = (input.dispatchDateIso || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dispatchDay) || Number.isNaN(Date.parse(input.dispatchDateIso))) {
    return { error: "Elige la fecha de despacho." };
  }
  if (dispatchDay <= limaTodayKey()) {
    return { error: "Elige una fecha de despacho desde mañana." };
  }
  if (!isSwaypDispatchDay(dispatchDay)) return { error: SWAYP_SUNDAY_ERROR };

  // Guía por API. Sólo cuando el operador NO escribió un código a mano: si lo
  // escribió es porque la generó él en el sistema de Swayp, y pedir otra
  // duplicaría el paquete. Cuando Swayp responde, SU número pasa a ser el
  // guide_code — el punto de todo esto es dejar de inventarlo localmente.
  let swaypGuide: string | null = null;
  let swaypState: number | null = null;
  const swaypNotice = "";
  if (!input.guideCode?.trim()) {
    const viaApi = await createFenixGuideViaApi({
      admin,
      orderId: order.id,
      sourceKey: `direct:${order.id}:${input.dispatchDateIso}`,
      storeId: order.store_id,
      city,
      district,
      customerName: address?.name ?? null,
      customerPhone: order.customer_phone ?? normalizePhone(address?.phone) ?? null,
      address1: address?.address1 ?? null,
      reference: address?.address2 ?? null,
      lineItems,
      codAmount: Math.max(0, (order.total_amount ?? 0) - totalRefunded),
      dispatchDateIso: input.dispatchDateIso,
      observaciones: input.note?.trim() || null,
    });
    // Sin número de Swayp no hay guía. Ver la reja gemela en `registerRerouteCall`.
    if (!viaApi.ok) {
      return { error: `Swayp no emitió la guía: ${viaApi.reason}. No se creó ninguna salida.` };
    }
    swaypGuide = viaApi.guia;
    swaypState = viaApi.idEstado;
  }

  // El código escrito a mano tiene que SER de Swayp. Autogenerarlo con el
  // pedido y la fecha era acuñar un número que Swayp no conoce, que es
  // justamente lo que esta regla cierra.
  const escrito = input.guideCode?.trim().toUpperCase() ?? "";
  if (escrito && !esNumeroDeGuiaSwayp(escrito)) {
    return {
      error:
        `«${escrito}» no es un número de guía de Swayp: los suyos son solo dígitos, como 50000132589. ` +
        `Cópialo de su panel, o deja el campo vacío para que Swayp lo emita.`,
    };
  }
  const code = swaypGuide ?? escrito;
  if (!code) {
    return { error: "Swayp no devolvió número de guía. Vuelve a intentarlo." };
  }

  const insertRow = {
    courier: "fenix",
    guide_code: code,
    swayp_guide: swaypGuide,
    swayp_state: swaypState,
    store_id: order.store_id,
    order_id: order.id,
    matched: true,
    match_method: "manual",
    order_name: order.name,
    customer_name: address?.name ?? null,
    customer_phone: order.customer_phone ?? normalizePhone(address?.phone) ?? null,
    product: lineItems.map((li) => li.title).filter(Boolean).join(" | ") || null,
    district,
    province: null,
    city,
    region,
    delivery_address: address?.address1 ?? null,
    delivery_reference: address?.address2 ?? null,
    latitude: null,
    longitude: null,
    delivery_status: "en_ruta",
    status_category: "in_route",
    next_followup_at: input.dispatchDateIso,
    fenix_eligible: true,
    created_via: "fenix_directo",
  };
  // RELLENA la salida «por definir» si la hay, y si no crea una nueva. Es el
  // mismo camino que Grupo GF, Tanders, Aliclik y Shalom: sin esto, Swayp era
  // el único courier que obligaba a anular la salida para poder emitir, y
  // anularla arrastra el pedido a `anulado` (#KP127639).
  //
  // Se queda además con el reintento por columna faltante que la inserción a
  // mano traía suelto, pero con una diferencia que importa: `created_via` es
  // esencial y ya no se suelta. Rellenar sin él dejaría la salida marcada como
  // ruta manual, con «Anular salida» ofreciéndose sobre una guía que ya existe
  // en Swayp — anularla de nuestro lado la dejaría viva del otro (MOM §4).
  const written = await writeCourierGuide(admin, order.id, insertRow);
  if ("error" in written) {
    const dup = written.error.includes("23505") || written.error.toLowerCase().includes("duplicate");
    return {
      error: dup
        ? `Ya existe una guía Swayp con el código ${code}. Cambia la fecha o edita el código.`
        : written.error,
    };
  }
  const childId = written.shipmentId;

  // Gestión del día de quien la creó (kind reroute + new_status null: cuenta
  // como gestión sin inflar "reprogramadas", y la guía —sin madre— queda fuera
  // del universo de Reprogramados en Kapso).
  await admin.from("shipment_calls").insert({
    shipment_id: childId,
    store_id: order.store_id,
    agent: input.actorId,
    kind: "reroute",
    new_status: null,
    note: [
      `Guía Swayp directa creada: ${code} (pedido ${order.name ?? "sin número"}).`,
      input.automatico ? "La emitió el automático desde Por confirmar (MOM §11.13)." : null,
      input.note?.trim() || null,
    ]
      .filter(Boolean)
      .join(" "),
    next_followup_at: input.dispatchDateIso,
  });

  // La justificación auditada de la salida adicional (MOM §23), en su propio
  // evento y con las salidas que seguían vivas.
  if (puerta.motivo) {
    await admin.from("order_events").insert({
      store_id: order.store_id,
      order_id: order.id,
      kind: "additional_output_reason",
      occurred_at: new Date().toISOString(),
      actor: input.actorId,
      source: "fenix",
      courier: "fenix",
      guide_code: code,
      shipment_id: childId,
      reason: puerta.motivo,
      note: `Salida adicional por Swayp con ${puerta.estorban.length} salida(s) todavía viva(s).`,
      payload: {
        salidas_vivas: puerta.estorban.map((o) => ({
          codigo: o.output_code ?? o.guide_code ?? null,
          courier: o.courier,
          estado: o.delivery_status,
        })),
      },
    });
  }

  // El hecho que hace volver el pedido a Por confirmar si Swayp no entrega (MOM
  // §11.11). Va ANTES de recalcular el Master: el recálculo lo lee.
  let avisoOrigen = "";
  if (input.origen === "por_confirmar") {
    const { error: caseError } = await admin.from("order_events").insert({
      store_id: order.store_id,
      order_id: order.id,
      kind: SWAYP_DESDE_CONFIRMACION_KIND,
      occurred_at: new Date().toISOString(),
      actor: input.actorId,
      // El automático no tiene persona detrás: `system`, y su evidencia en el
      // payload, para que el registro distinga un brazo del otro (MOM §11.13).
      source: input.automatico ? "system" : "manual",
      courier: "fenix",
      guide_code: code,
      shipment_id: childId,
      note: input.automatico
        ? "Enviado por Swayp desde Por confirmar por el automático (piloto A/B), sin confirmación. Si Swayp no entrega, vuelve a Por confirmar."
        : "Enviado por Swayp desde Por confirmar, sin confirmación. Si Swayp no entrega, vuelve a Por confirmar.",
      payload: input.automatico ? { automatico: true, ...input.automatico } : {},
    });
    // La guía ya existe en Swayp: no se deshace por esto, pero se dice, porque
    // sin el hecho el pedido no volvería solo a Por confirmar.
    avisoOrigen = caseError
      ? ` No se pudo marcar como «desde Por confirmar» (${caseError.message}): si Swayp no entrega, avisa para devolverlo a mano.`
      : " Si Swayp no la entrega, el pedido vuelve a Por confirmar.";
  }

  await recomputeOrderMasterForShipmentsSafe(admin, [childId]);
  return {
    code,
    childId,
    filled: !!written.filled,
    outputCode: written.outputCode ?? null,
    avisoOrigen,
  };
}
