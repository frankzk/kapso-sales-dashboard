// La pasada del Swayp automático desde Por confirmar (MOM §11.13).
//
// Carga los candidatos, decide con `evaluarPorConfirmarAuto` (pura) y, para los
// que pasan, hace las comprobaciones que piden red: bodega sin fallas propias
// recientes, ubicación corroborada con Aliclik, vínculo de cada producto con
// Swayp y stock leído EN VIVO de Swayp. Esas comprobaciones corren para los DOS
// brazos del A/B: el grupo de control tiene que ser el mismo tipo de pedido que
// el que sale, o la comparación no dice nada. Solo el brazo `swayp` emite, por
// el mismo camino que el botón (`emitirGuiaSwaypDirecta`).
//
// La guía queda marcada como «desde Por confirmar»: si Swayp no entrega, el
// pedido vuelve a «Por confirmar · Swayp no entregó» (§11.11) igual que con el
// botón.

import type { SupabaseClient } from "@supabase/supabase-js";
import { limaDateKey } from "@/lib/aliclik-geo";
import { env } from "@/lib/env";
import { coverageCityOf } from "@/lib/fenix";
import { fenixWarehouseKey } from "@/lib/shipments";
import { swaypOptsFromEnv } from "@/lib/swayp";
import { nextAutoDelivery } from "@/lib/swayp-auto-policy";
import { corroboratePilotLocation } from "@/lib/swayp-auto-location";
import { SWAYP_DESDE_CONFIRMACION_KIND, swaypDesdeConfirmacionFailed } from "@/lib/swayp-desde-confirmacion";
import { DIRECT_GUIDE_ACTIVE_STATUSES, emitirGuiaSwaypDirecta, esRellenable, findGuidesOfOrder } from "@/lib/swayp-directa";
import { parseSenders } from "@/lib/swayp-guide";
import { leerInventarioSwayp, type LecturaSwayp } from "@/lib/swayp-inventory-sync";
import { normalizeSku } from "@/lib/swayp-productos";
import { DIRECT_GUIDE_ORDER_COLUMNS, type DirectGuideOrderRecord } from "@/lib/swayp-reenvio";
import { conflictosDeCodbar, filasDelMapaSwayp, unVinculoPorSku } from "@/lib/swayp-sku-map";
import {
  NOVEDADES_DE_BODEGA,
  codigoDeNovedad,
  evaluarPorConfirmarAuto,
  frenoActivado,
  ordenDePasada,
  type PcAutoArm,
  type PcAutoCandidate,
  type PorConfirmarAutoSettings,
} from "@/lib/swayp-por-confirmar-auto";
import type { OrderLineItem } from "@/lib/types";

const POLITICA = "pc-auto-v1";
const ETAPAS_VIVAS = new Set(["por_confirmar", "preparacion", "por_despachar", "en_curso"]);
const NOVEDADES_DE_RECHAZO = new Set([15, 16]);
const DAY_MS = 86_400_000;

export interface PcAutoReport {
  checked: number;
  /** Elegibles del brazo Swayp (pasaron también las comprobaciones de red). */
  eligibleSwayp: number;
  /** Elegibles del grupo de control. */
  eligibleControl: number;
  created: number;
  excluded: Record<string, number>;
  braked: { tasa: number | null; casos: number } | null;
  /** Cada pedido mirado, para la simulación y el registro de la corrida. */
  items: { orderId: string; orderName: string | null; arm: PcAutoArm | null; reason: string; bodega?: string | null }[];
  error: string | null;
}

/** Los casos del brazo Swayp que ya se resolvieron: entregado o Swayp ya no entrega. */
export async function casosResueltosAutomaticos(
  admin: SupabaseClient,
  storeIds: string[],
): Promise<{ entregado: boolean; resolvedAt: string }[]> {
  if (!storeIds.length) return [];
  const { data: eventos, error } = await admin
    .from("order_events")
    .select("shipment_id,occurred_at,payload")
    .eq("kind", SWAYP_DESDE_CONFIRMACION_KIND)
    .eq("source", "system")
    .in("store_id", storeIds)
    .order("occurred_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`leer los casos del automático: ${error.message}`);
  const ids = ((eventos ?? []) as { shipment_id: string | null }[]).map((e) => e.shipment_id).filter((x): x is string => !!x);
  if (!ids.length) return [];
  const { data: guias, error: gErr } = await admin
    .from("shipments")
    .select("id,courier,delivery_status,swayp_state,reported_status,closed_at,returned_at,updated_at")
    .in("id", ids);
  if (gErr) throw new Error(`leer las guías del automático: ${gErr.message}`);
  const out: { entregado: boolean; resolvedAt: string }[] = [];
  for (const g of (guias ?? []) as {
    courier: string;
    delivery_status: string;
    swayp_state: number | null;
    reported_status: string | null;
    closed_at: string | null;
    returned_at: string | null;
    updated_at: string | null;
  }[]) {
    const entregado = g.delivery_status === "entregado";
    if (!entregado && !swaypDesdeConfirmacionFailed(g)) continue;
    out.push({ entregado, resolvedAt: g.closed_at ?? g.returned_at ?? g.updated_at ?? "" });
  }
  return out;
}

/** Bodegas con una falla propia de Swayp (inventario o no despachó) en los últimos 7 días. */
async function bodegasConFallas(admin: SupabaseClient, storeIds: string[], now: Date): Promise<Set<string>> {
  const { data, error } = await admin
    .from("shipments")
    .select("city,reported_status")
    .in("store_id", storeIds)
    .eq("courier", "fenix")
    .not("swayp_guide", "is", null)
    .gte("updated_at", new Date(now.getTime() - 7 * DAY_MS).toISOString())
    .limit(5000);
  if (error) throw new Error(`leer las novedades de Swayp: ${error.message}`);
  const out = new Set<string>();
  for (const g of (data ?? []) as { city: string | null; reported_status: string | null }[]) {
    const code = codigoDeNovedad(g.reported_status);
    if (code !== null && NOVEDADES_DE_BODEGA.has(code) && g.city) out.add(fenixWarehouseKey(g.city));
  }
  return out;
}

type MasterRow = PcAutoCandidate["master"] & {
  order_id: string;
  store_id: string;
  customer_phone: string | null;
  order_created_at: string | null;
};

/** Carga todo lo que la política necesita de cada candidato, en lotes. */
async function cargarCandidatos(
  admin: SupabaseClient,
  storeIds: string[],
  s: PorConfirmarAutoSettings,
  now: Date,
): Promise<PcAutoCandidate[]> {
  const desde = new Date(now.getTime() - s.max_age_hours * 3_600_000).toISOString();
  const { data: masters, error } = await admin
    .from("order_master")
    .select(
      "order_id,store_id,macro_stage,macro_substage,coverage,swayp_availability,address,reference,district,province,region,latitude,longitude,confirmation_next_contact_on,customer_phone,order_created_at",
    )
    .in("store_id", storeIds)
    .eq("macro_stage", "por_confirmar")
    .eq("coverage", "provincia_cod")
    .gte("order_created_at", desde)
    .limit(500);
  if (error) throw new Error(`leer el Master: ${error.message}`);
  let rows = (masters ?? []) as MasterRow[];
  if (!rows.length) return [];

  // Un pedido ya decidido (con brazo) no se vuelve a mirar: el A/B no cambia de lado a nadie.
  const { data: decididos, error: dErr } = await admin
    .from("swayp_pc_auto_decisions")
    .select("order_id")
    .in("order_id", rows.map((r) => r.order_id))
    .eq("eligible", true);
  if (dErr) throw new Error(`leer las decisiones: ${dErr.message}`);
  const fijos = new Set(((decididos ?? []) as { order_id: string }[]).map((d) => d.order_id));
  rows = rows.filter((r) => !fijos.has(r.order_id));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.order_id);

  const [ordersRes, contactsRes, paymentsRes] = await Promise.all([
    admin
      .from("orders")
      .select("id,store_id,name,created_at,cancelled_at,total_amount,total_refunded,currency,financial_status,customer_phone,shopify_note,line_items")
      .in("id", ids),
    admin
      .from("order_events")
      .select("order_id,occurred_at,note,payload")
      .eq("kind", "confirmation_contact")
      .in("order_id", ids),
    admin.from("order_payments").select("order_id,validation_status").in("order_id", ids),
  ]);
  if (ordersRes.error) throw new Error(`leer los pedidos: ${ordersRes.error.message}`);
  if (contactsRes.error) throw new Error(`leer las gestiones: ${contactsRes.error.message}`);
  if (paymentsRes.error) throw new Error(`leer los pagos: ${paymentsRes.error.message}`);
  const orderById = new Map(((ordersRes.data ?? []) as PcAutoCandidate["order"][]).map((o) => [o.id, o]));
  const contactsBy = new Map<string, PcAutoCandidate["contacts"]>();
  for (const e of (contactsRes.data ?? []) as { order_id: string; occurred_at: string; note: string | null; payload: { result?: string } | null }[]) {
    const list = contactsBy.get(e.order_id) ?? [];
    list.push({ result: e.payload?.result ?? null, note: e.note, occurred_at: e.occurred_at });
    contactsBy.set(e.order_id, list);
  }
  const paymentsBy = new Map<string, number>();
  for (const p of (paymentsRes.data ?? []) as { order_id: string; validation_status: string }[]) {
    if (p.validation_status !== "rechazado") paymentsBy.set(p.order_id, (paymentsBy.get(p.order_id) ?? 0) + 1);
  }

  // Historial por teléfono: los demás pedidos de la misma clienta.
  const phones = [...new Set(rows.map((r) => r.customer_phone).filter((p): p is string => !!p))];
  const historyBy = new Map<string, PcAutoCandidate["phoneHistory"]>();
  if (phones.length) {
    const { data: otros, error: oErr } = await admin
      .from("order_master")
      .select("order_id,customer_phone,order_created_at,delivered_courier,macro_stage")
      .in("store_id", storeIds)
      .in("customer_phone", phones)
      .limit(2000);
    if (oErr) throw new Error(`leer el historial del teléfono: ${oErr.message}`);
    const otrosRows = (otros ?? []) as {
      order_id: string;
      customer_phone: string;
      order_created_at: string | null;
      delivered_courier: string | null;
      macro_stage: string | null;
    }[];
    const otrosIds = otrosRows.map((r) => r.order_id);
    const [oOrders, oGuides, oDiscards] = await Promise.all([
      admin.from("orders").select("id,cancelled_at,line_items").in("id", otrosIds),
      admin.from("shipments").select("order_id,reported_status").in("order_id", otrosIds).not("reported_status", "is", null),
      admin.from("order_events").select("order_id").eq("kind", "recovery_discarded").in("order_id", otrosIds),
    ]);
    if (oOrders.error || oGuides.error || oDiscards.error) {
      throw new Error(`leer el historial del teléfono: ${(oOrders.error ?? oGuides.error ?? oDiscards.error)!.message}`);
    }
    const oById = new Map(((oOrders.data ?? []) as { id: string; cancelled_at: string | null; line_items: OrderLineItem[] | null }[]).map((o) => [o.id, o]));
    const rechazados = new Set<string>();
    for (const g of (oGuides.data ?? []) as { order_id: string | null; reported_status: string | null }[]) {
      const code = codigoDeNovedad(g.reported_status);
      if (g.order_id && code !== null && NOVEDADES_DE_RECHAZO.has(code)) rechazados.add(g.order_id);
    }
    for (const d of (oDiscards.data ?? []) as { order_id: string }[]) rechazados.add(d.order_id);
    for (const r of otrosRows) {
      const o = oById.get(r.order_id);
      const list = historyBy.get(r.customer_phone) ?? [];
      list.push({
        id: r.order_id,
        created_at: r.order_created_at ?? "",
        cancelled_at: o?.cancelled_at ?? null,
        delivered: !!r.delivered_courier,
        rejected: rechazados.has(r.order_id),
        open: !r.delivered_courier && !o?.cancelled_at && ETAPAS_VIVAS.has(r.macro_stage ?? ""),
        line_items: o?.line_items ?? null,
      });
      historyBy.set(r.customer_phone, list);
    }
  }

  const out: PcAutoCandidate[] = [];
  for (const r of rows) {
    const order = orderById.get(r.order_id);
    if (!order) continue;
    // Salidas vivas que estorban: la «por definir» rellenable no cuenta, se escribe encima.
    const guides = await findGuidesOfOrder(admin, { id: order.id, store_id: order.store_id, name: order.name });
    const liveOutputs = guides.filter((g) => DIRECT_GUIDE_ACTIVE_STATUSES.has(g.delivery_status) && !esRellenable(g)).length;
    out.push({
      order,
      master: {
        macro_stage: r.macro_stage,
        macro_substage: r.macro_substage,
        coverage: r.coverage,
        swayp_availability: r.swayp_availability,
        address: r.address,
        reference: r.reference,
        district: r.district,
        province: r.province,
        region: r.region,
        latitude: r.latitude,
        longitude: r.longitude,
        confirmation_next_contact_on: r.confirmation_next_contact_on,
      },
      contacts: contactsBy.get(r.order_id) ?? [],
      liveOutputs,
      payments: paymentsBy.get(r.order_id) ?? 0,
      phoneHistory: (historyBy.get(r.customer_phone ?? "") ?? []).filter((h) => h.id !== r.order_id),
    });
  }
  return out;
}

/**
 * Una pasada. Con `dry` no escribe nada —ni decisiones, ni corrida, ni guías—:
 * es la simulación del panel, para ver qué saldría antes de activarlo.
 */
export async function runPorConfirmarAuto(
  admin: SupabaseClient,
  settings: PorConfirmarAutoSettings,
  opts: { dry?: boolean; now?: Date } = {},
): Promise<PcAutoReport> {
  const dry = !!opts.dry;
  const now = opts.now ?? new Date();
  const report: PcAutoReport = {
    checked: 0,
    eligibleSwayp: 0,
    eligibleControl: 0,
    created: 0,
    excluded: {},
    braked: null,
    items: [],
    error: null,
  };
  if (!dry && !settings.enabled) return report;
  const started = Date.now();
  let runId: string | undefined;

  try {
    const { data: stores, error: sErr } = await admin.from("stores").select("id").eq("org_id", settings.org_id);
    if (sErr) throw new Error(`leer las tiendas: ${sErr.message}`);
    const storeIds = ((stores ?? []) as { id: string }[]).map((x) => x.id);
    if (!storeIds.length) return report;

    // EL FRENO, antes de nada: si el brazo Swayp entrega por debajo del umbral, se apaga solo.
    const freno = frenoActivado(await casosResueltosAutomaticos(admin, storeIds), settings);
    if (freno.frena) {
      report.braked = { tasa: freno.tasa, casos: freno.casos };
      if (!dry) {
        const pct = Math.round((freno.tasa ?? 0) * 100);
        const { error } = await admin
          .from("swayp_pc_auto_settings")
          .update({
            enabled: false,
            paused_reason: `Freno: de los últimos ${freno.casos} casos resueltos se entregó el ${pct} %, por debajo del ${Math.round(settings.brake_min_rate * 100)} %.`,
            paused_at: now.toISOString(),
            updated_at: now.toISOString(),
          })
          .eq("org_id", settings.org_id);
        if (error) throw new Error(`aplicar el freno: ${error.message}`);
      }
      return report;
    }

    if (!dry) {
      const run = await admin.from("swayp_pc_auto_runs").insert({ org_id: settings.org_id, summary: { state: "running" } }).select("id").single();
      if (run.error) throw new Error(run.error.message);
      runId = (run.data as { id: string }).id;
    }

    // Lo que ya salió hoy (día de Lima): el cupo es por día, no por pasada.
    const hoy = `${limaDateKey(now)}T00:00:00-05:00`;
    const { data: hechos, error: hErr } = await admin
      .from("swayp_pc_auto_decisions")
      .select("evidence")
      .eq("org_id", settings.org_id)
      .eq("reason", "created")
      .gte("decided_at", hoy);
    if (hErr) throw new Error(`leer el cupo del día: ${hErr.message}`);
    let usadosHoy = (hechos ?? []).length;
    const usadosPorBodega = new Map<string, number>();
    for (const h of (hechos ?? []) as { evidence: { bodega?: string } | null }[]) {
      const b = h.evidence?.bodega;
      if (b) usadosPorBodega.set(b, (usadosPorBodega.get(b) ?? 0) + 1);
    }

    const candidatos = await cargarCandidatos(admin, storeIds, settings, now);
    const veredictos = candidatos.map((c) => ({ c, v: evaluarPorConfirmarAuto(c, settings, now) }));
    veredictos.sort((a, b) =>
      ordenDePasada(
        { recompra: a.v.eligible && a.v.recompra, createdAt: a.c.order.created_at },
        { recompra: b.v.eligible && b.v.recompra, createdAt: b.c.order.created_at },
      ),
    );

    const conFallas = await bodegasConFallas(admin, storeIds, now);
    const senders = parseSenders(env.swaypSenders());
    let inventario: LecturaSwayp | null = null;

    for (const { c, v } of veredictos) {
      if (Date.now() - started > 220_000) break;
      report.checked++;
      const evidence: Record<string, unknown> = {
        politica: POLITICA,
        orderName: c.order.name,
        llamadas: c.contacts.length,
        horas: Math.round((now.getTime() - Date.parse(c.order.created_at)) / 3_600_000),
      };
      let reason: string = v.reason;
      let arm: PcAutoArm | null = null;
      let eligible = false;
      let shipmentId: string | null = null;

      if (v.eligible) {
        arm = v.arm;
        evidence.recompra = v.recompra;
        const city = coverageCityOf({ city: null, district: c.master.district, province: c.master.province ?? c.master.region });
        const bodega = fenixWarehouseKey(city);
        evidence.bodega = bodega;

        if (conFallas.has(bodega)) reason = "warehouse_paused";
        else if (!env.swaypEnabled() || !senders[city] || process.env.SWAYP_INVENTORY_ORG_ID !== settings.org_id) reason = "api_disabled";
        else if (!Number.isFinite(c.master.latitude) || !Number.isFinite(c.master.longitude) || !c.master.latitude || !c.master.longitude) {
          reason = "no_location";
        } else {
          const located = await corroboratePilotLocation(admin, settings.org_id, city, c.master.district!, c.master.latitude!, c.master.longitude!);
          evidence.location = located;
          if (!located.ok) reason = "location";
          else {
            const mappingRows = await filasDelMapaSwayp(admin, c.order.store_id);
            const mapping = unVinculoPorSku(mappingRows, c.order.store_id);
            const conflicts = conflictosDeCodbar(mappingRows);
            const items = c.order.line_items ?? [];
            if (items.some((i) => !mapping.get(normalizeSku(i.sku))?.codbar || conflicts.has(normalizeSku(i.sku)))) reason = "no_mapping";
            else {
              inventario ??= await leerInventarioSwayp({ tipo: "integracion", opts: swaypOptsFromEnv() });
              if ("error" in inventario) throw new Error(inventario.error);
              const stock = inventario.porCiudad.get(bodega) ?? [];
              const needed = new Map<string, number>();
              for (const i of items) {
                const code = mapping.get(normalizeSku(i.sku))!.codbar;
                needed.set(code, (needed.get(code) ?? 0) + i.quantity);
              }
              if ([...needed].some(([code, qty]) => stock.filter((x) => x.codbar === code).reduce((n, x) => n + x.disponible, 0) < qty)) {
                reason = "no_stock";
              } else if (v.arm === "control") {
                reason = "control";
                eligible = true;
                report.eligibleControl++;
              } else if (usadosHoy >= settings.daily_cap) reason = "cap_daily";
              else if ((usadosPorBodega.get(bodega) ?? 0) >= settings.per_warehouse_cap) reason = "cap_warehouse";
              else {
                report.eligibleSwayp++;
                eligible = true;
                reason = "eligible";
                if (!dry) {
                  const { data: od, error: oErr } = await admin.from("orders").select(DIRECT_GUIDE_ORDER_COLUMNS).eq("id", c.order.id).maybeSingle();
                  if (oErr || !od) throw new Error(`releer el pedido ${c.order.name}: ${oErr?.message ?? "no existe"}`);
                  const dia = nextAutoDelivery(now, bodega);
                  evidence.dispatchDate = dia;
                  const r = await emitirGuiaSwaypDirecta(admin, {
                    order: od as unknown as DirectGuideOrderRecord,
                    actorId: null,
                    dispatchDateIso: `${dia}T00:00:00.000Z`,
                    origen: "por_confirmar",
                    note: "Automático desde Por confirmar (piloto A/B): sin confirmación.",
                    automatico: { arm: "swayp", politica: POLITICA, recompra: v.recompra, llamadas: c.contacts.length },
                  });
                  if ("error" in r) {
                    // Sin guía no hay brazo: vuelve a intentarse en la próxima pasada si sigue en la ventana.
                    eligible = false;
                    reason = "emission_error";
                    evidence.detail = r.error;
                  } else {
                    reason = "created";
                    shipmentId = r.childId;
                    evidence.guideCode = r.code;
                    usadosHoy++;
                    usadosPorBodega.set(bodega, (usadosPorBodega.get(bodega) ?? 0) + 1);
                    report.created++;
                  }
                }
              }
            }
          }
        }
      }

      if (!["created", "eligible", "control"].includes(reason)) report.excluded[reason] = (report.excluded[reason] ?? 0) + 1;
      report.items.push({ orderId: c.order.id, orderName: c.order.name, arm, reason, bodega: (evidence.bodega as string | undefined) ?? null });
      if (!dry) {
        const { error } = await admin.from("swayp_pc_auto_decisions").upsert({
          order_id: c.order.id,
          store_id: c.order.store_id,
          org_id: settings.org_id,
          arm: eligible ? arm : null,
          reason,
          eligible,
          shipment_id: shipmentId,
          evidence,
          decided_at: now.toISOString(),
          checked_at: new Date().toISOString(),
        });
        if (error) throw new Error(`guardar la decisión: ${error.message}`);
      }
      // Una emisión que falló para la tanda: puede ser un problema de Swayp que
      // repetiría el mismo error en cada pedido.
      if (reason === "emission_error") break;
    }
  } catch (err) {
    report.error = err instanceof Error ? err.message : "Error del automático";
  }
  if (runId) {
    const { items, ...resumen } = report;
    await admin
      .from("swayp_pc_auto_runs")
      .update({ summary: { ...resumen, items: items.slice(0, 200), state: report.error ? "error" : "completed" } })
      .eq("id", runId);
  }
  return report;
}
