"use server";

// Acciones de las liquidaciones de motorizados. La carga del archivo va por
// /api/settlements/upload (multipart); aquí vive lo que se hace DESPUÉS: corregir
// vínculos, dar de alta motorizados y cerrar.
//
// Cerrar es la única acción irreversible del módulo, y por eso pide un permiso
// aparte (`settlements.close`): congela lo que se le paga al motorizado ese día.
// Si mañana cambia una tarifa o se corrige una guía, el número pagado NO se
// reescribe solo — se abre otra liquidación de ajuste. Es el mismo principio de
// vigencia del módulo de Costos: un número con fecha no se edita hacia atrás.

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { relinkSettlementLine } from "@/lib/settlement-ingest";
import { getRiderTariffs, getSettlementDetail } from "@/lib/settlements-access";
import {
  computeRiderPayout,
  settlementGuidesToCreate,
  settlementMasterEffects,
  settlementStatus,
  type SettlementLineInput,
  type SettlementMasterFacts,
} from "@/lib/settlements";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { defaultOperationalFor } from "@/lib/order-status";
import { categoryOf } from "@/lib/shipments";

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

/** Comprueba permiso y devuelve el cliente admin, o el error listo para devolver. */
async function guard(permission: "settlements.manage" | "settlements.close") {
  const user = await getCurrentUser();
  if (!user) return { error: "No autenticado." as const };
  const perms = await getMasterPermissions();
  if (!perms.can(permission)) {
    return {
      error:
        permission === "settlements.close"
          ? ("Tu rol no permite cerrar liquidaciones." as const)
          : ("Tu rol no permite editar liquidaciones." as const),
    };
  }
  return { user, admin: createAdminSupabase() };
}

/** Comprueba que la liquidación esté dentro de las tiendas del usuario. */
async function assertReachable(
  admin: ReturnType<typeof createAdminSupabase>,
  settlementId: string,
): Promise<{ storeId: string } | { error: string }> {
  const stores = await getAccessibleStores();
  const { data } = await admin
    .from("rider_settlements")
    .select("store_id")
    .eq("id", settlementId)
    .maybeSingle();
  const storeId = (data as { store_id?: string } | null)?.store_id;
  if (!storeId || !stores.some((s) => s.id === storeId)) {
    return { error: "Liquidación inexistente o sin acceso." };
  }
  return { storeId };
}

/**
 * Corrige el vínculo de una línea. `orderId = null` la marca como "no
 * corresponde a ningún pedido", que es una decisión legítima y distinta de
 * "todavía no la he mirado".
 */
export async function relinkLine(
  settlementId: string,
  lineId: string,
  orderId: string | null,
): Promise<ActionResult> {
  const g = await guard("settlements.manage");
  if ("error" in g) return { ok: false, error: g.error };

  const reach = await assertReachable(g.admin, settlementId);
  if ("error" in reach) return { ok: false, error: reach.error };

  // Una liquidación cerrada no se toca: su pago ya está congelado.
  const { data: head } = await g.admin
    .from("rider_settlements")
    .select("status")
    .eq("id", settlementId)
    .maybeSingle();
  if ((head as { status?: string } | null)?.status === "cerrada") {
    return { ok: false, error: "La liquidación está cerrada; abre una de ajuste." };
  }

  const res = await relinkSettlementLine(g.admin, lineId, orderId);
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath("/dashboard/liquidaciones");
  return { ok: true, message: orderId ? "Línea vinculada." : "Línea marcada sin pedido." };
}

/** Da de alta un motorizado. */
export async function createRider(input: {
  storeId: string | null;
  fullName: string;
  docNumber: string | null;
  phone: string | null;
  courier: string | null;
}): Promise<ActionResult> {
  const g = await guard("settlements.manage");
  if ("error" in g) return { ok: false, error: g.error };

  const name = input.fullName.trim();
  if (!name) return { ok: false, error: "El nombre del motorizado es obligatorio." };

  const stores = await getAccessibleStores();
  if (!stores.length) return { ok: false, error: "Sin tiendas accesibles." };
  if (input.storeId && !stores.some((s) => s.id === input.storeId)) {
    return { ok: false, error: "Tienda inválida o sin acceso." };
  }
  const orgId = stores[0]!.org_id;

  const { error } = await g.admin.from("riders").insert({
    org_id: orgId,
    store_id: input.storeId,
    full_name: name,
    doc_number: input.docNumber?.trim() || null,
    phone: input.phone?.trim() || null,
    courier: input.courier?.trim() || null,
    created_by: g.user.id,
  });
  if (error) {
    // El índice único por DNI es la red que evita pagarle dos veces a la misma
    // persona escrita de dos maneras.
    const msg = error.message.includes("riders_doc_idx")
      ? "Ya hay un motorizado con ese documento."
      : error.message;
    return { ok: false, error: msg };
  }
  revalidatePath("/dashboard/liquidaciones");
  return { ok: true, message: "Motorizado dado de alta." };
}

/** Actualiza la cabecera: quién liquida, cuánto declaró depositar y la nota. */
export async function updateSettlementHeader(
  settlementId: string,
  input: { riderId: string | null; declaredCash: number; declaredYape: number; note: string | null },
): Promise<ActionResult> {
  const g = await guard("settlements.manage");
  if ("error" in g) return { ok: false, error: g.error };

  const reach = await assertReachable(g.admin, settlementId);
  if ("error" in reach) return { ok: false, error: reach.error };

  const { data: head } = await g.admin
    .from("rider_settlements")
    .select("status")
    .eq("id", settlementId)
    .maybeSingle();
  if ((head as { status?: string } | null)?.status === "cerrada") {
    return { ok: false, error: "La liquidación está cerrada." };
  }

  const { error } = await g.admin
    .from("rider_settlements")
    .update({
      rider_id: input.riderId,
      declared_cash: Math.max(0, input.declaredCash),
      declared_yape: Math.max(0, input.declaredYape),
      note: input.note?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", settlementId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/liquidaciones");
  return { ok: true, message: "Liquidación actualizada." };
}

/** Recalcula el cuadre y guarda el estado (cuadrada / con descuadre). No cierra. */
export async function recheckSettlement(settlementId: string): Promise<ActionResult> {
  const g = await guard("settlements.manage");
  if ("error" in g) return { ok: false, error: g.error };

  const reach = await assertReachable(g.admin, settlementId);
  if ("error" in reach) return { ok: false, error: reach.error };

  const detail = await getSettlementDetail(settlementId);
  if (!detail) return { ok: false, error: "Liquidación inexistente." };
  if (detail.settlement.status === "cerrada") {
    return { ok: false, error: "La liquidación está cerrada." };
  }

  const status = settlementStatus(detail.reconciled.totals);
  const { error } = await g.admin
    .from("rider_settlements")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", settlementId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/liquidaciones");
  return {
    ok: true,
    message: status === "cuadrada" ? "Cuadra." : "Sigue con descuadre.",
  };
}

/**
 * Cierra la liquidación y congela el pago al motorizado.
 *
 * Exige que el cuadre esté limpio salvo que se pase `force` — un descuadre
 * cerrado a conciencia es una decisión de la empresa, pero tiene que ser
 * explícita y queda anotada.
 */
export async function closeSettlement(
  settlementId: string,
  opts: { deductShortfall?: boolean; force?: boolean } = {},
): Promise<ActionResult> {
  const g = await guard("settlements.close");
  if ("error" in g) return { ok: false, error: g.error };

  const reach = await assertReachable(g.admin, settlementId);
  if ("error" in reach) return { ok: false, error: reach.error };

  const detail = await getSettlementDetail(settlementId);
  if (!detail) return { ok: false, error: "Liquidación inexistente." };
  if (detail.settlement.status === "cerrada") {
    return { ok: false, error: "Ya estaba cerrada." };
  }

  const { totals } = detail.reconciled;
  if (!totals.balanced && !opts.force) {
    return {
      ok: false,
      error:
        totals.reviewCount > 0
          ? `Quedan ${totals.reviewCount} línea(s) sin vincular. Resuélvelas o cierra con descuadre a conciencia.`
          : `Hay ${totals.mismatchCount} descuadre(s). Revísalos o cierra con descuadre a conciencia.`,
    };
  }

  const tariffs = await getRiderTariffs();
  const payout = computeRiderPayout(
    detail.reconciled.lines,
    tariffs,
    detail.settlement.settlement_date,
    { deductShortfall: opts.deductShortfall },
  );
  if (payout.missingTariffs > 0) {
    return {
      ok: false,
      error: `Faltan ${payout.missingTariffs} tarifa(s) de motorizado vigentes ese día. Defínelas en Costos antes de cerrar.`,
    };
  }

  const forcedNote = !totals.balanced
    ? `${detail.settlement.note ? detail.settlement.note + " · " : ""}Cerrada con descuadre de S/ ${totals.difference.toFixed(2)}.`
    : detail.settlement.note;

  const { error } = await g.admin
    .from("rider_settlements")
    .update({
      status: "cerrada",
      payout_amount: payout.net,
      note: forcedNote,
      closed_at: new Date().toISOString(),
      closed_by: g.user.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", settlementId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard/liquidaciones");
  return { ok: true, message: `Cerrada. Pago al motorizado: S/ ${payout.net.toFixed(2)}.` };
}

/**
 * Aplica al Master lo que dice una liquidación ya revisada.
 *
 * Detrás de la liquidación de un courier no viene ningún otro reporte que mueva
 * el Master, así que sin esto las entregas de Axel —todo Lima Metropolitana— se
 * quedan en "pendiente" para siempre y el cuadre las marca como "cobro sin
 * entrega". Es el mismo enganche que hace el cierre de una ruta, pero disparado
 * por una persona, porque aquí lo que se aplica viene de un tercero.
 *
 * Solo toca los pedidos VINCULADOS: una línea en revisión no mueve nada.
 */
export async function applySettlementToMaster(settlementId: string): Promise<ActionResult> {
  const g = await guard("settlements.manage");
  if ("error" in g) return { ok: false, error: g.error };

  const reach = await assertReachable(g.admin, settlementId);
  if ("error" in reach) return { ok: false, error: reach.error };

  const detail = await getSettlementDetail(settlementId);
  if (!detail) return { ok: false, error: "Liquidación inexistente." };

  const effects = settlementMasterEffects(detail.reconciled.lines.map((r) => r.line));
  if (!effects.length) {
    return {
      ok: false,
      error:
        "No hay nada que aplicar: ninguna línea vinculada declara una entrega o un rechazo.",
    };
  }

  // Lo que el Master YA sabe no se vuelve a escribir: repetir el evento
  // ensuciaría el historial del pedido con cambios que no cambiaron nada.
  const current = new Map(
    detail.reconciled.lines
      .filter((r) => r.facts)
      .map((r) => [r.facts!.order_id, r.facts!.general_status]),
  );
  const pending = effects.filter((e) => current.get(e.order_id) !== e.target);
  if (!pending.length) {
    return { ok: true, message: "El Master ya estaba al día con esta liquidación." };
  }

  const events = pending.map((e) => ({
    store_id: reach.storeId,
    order_id: e.order_id,
    kind: "status_override",
    occurred_at: new Date().toISOString(),
    actor: g.user.id,
    source: "liquidacion",
    new_status: e.target,
    new_operational: defaultOperationalFor(e.target),
    reason: e.reason,
    payload: { settlement_id: settlementId },
  }));

  const { error } = await g.admin.from("order_events").insert(events);
  if (error) return { ok: false, error: error.message };

  // Antes de recalcular: los pedidos que llegan aquí sin ninguna guía se
  // quedarían sin courier y, por tanto, sin costo logístico. Ver
  // settlementGuidesToCreate().
  const guidesCreated = await createGuidesFromSettlement(
    g.admin,
    detail.settlement.courier,
    detail.reconciled.lines,
  );

  await recomputeOrderMasterSafe(
    g.admin,
    pending.map((e) => e.order_id),
  );

  revalidatePath("/dashboard/liquidaciones");
  revalidatePath("/dashboard/pedidos");

  const entregados = pending.filter((e) => e.target === "entregado").length;
  const anulados = pending.length - entregados;
  return {
    ok: true,
    message:
      `Master actualizado: ${entregados} entregado(s)` +
      (anulados ? `, ${anulados} anulado(s) por rechazo` : "") +
      (guidesCreated ? `, ${guidesCreated} guía(s) de courier creada(s)` : "") + ".",
  };
}

/**
 * Crea la guía de los pedidos de la liquidación que no tienen ninguna, para que
 * el courier de la hoja quede escrito en el Master y sus tarifas resuelvan.
 *
 * Solo aplica a las hojas que declaran courier (`axel`…): una liquidación de un
 * motorizado propio no lleva courier, y ahí no hay nada que etiquetar.
 *
 * Nunca hace fallar el "Aplicar al Master": el estado del pedido es lo que el
 * usuario pidió mover, y perderlo porque una guía derivada no se pudo escribir
 * sería cambiar un dato bueno por un accesorio. Lo que no entre se puede volver
 * a intentar reaplicando la liquidación — el código de guía es determinista, así
 * que no se duplica.
 */
async function createGuidesFromSettlement(
  admin: SupabaseClient,
  courier: string | null,
  rows: readonly { line: SettlementLineInput; facts: SettlementMasterFacts | null }[],
): Promise<number> {
  if (!courier) return 0;
  const needed = settlementGuidesToCreate(courier, rows);
  if (!needed.length) return 0;

  const now = new Date().toISOString();
  const payload = needed.map((n) => ({
    courier,
    guide_code: n.guide_code,
    store_id: n.store_id,
    order_id: n.order_id,
    matched: true,
    match_method: "settlement",
    order_name: n.order_name,
    customer_name: n.customer_name,
    district: n.district,
    province: n.province,
    region: n.region,
    delivery_status: n.delivered ? "entregado" : "anulado",
    status_category: categoryOf(n.delivered ? "entregado" : "anulado"),
    // La hoja es de un día concreto y llega después del reparto: la guía nace
    // ya despachada y cerrada, no "en ruta".
    dispatched_at: now,
    closed_at: now,
    created_via: "liquidacion",
  }));

  // ignoreDuplicates: reaplicar la misma liquidación no debe reventar por el
  // único (courier, guide_code) — la guía ya existe y eso es exactamente lo que
  // se quería.
  const { data, error } = await admin
    .from("shipments")
    .upsert(payload, { onConflict: "courier,guide_code", ignoreDuplicates: true })
    .select("id");
  if (error) return 0;
  return (data ?? []).length;
}
