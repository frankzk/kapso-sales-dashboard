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
import { createAdminSupabase } from "@/lib/db";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { relinkSettlementLine } from "@/lib/settlement-ingest";
import { getRiderTariffs, getSettlementDetail } from "@/lib/settlements-access";
import { computeRiderPayout, settlementStatus } from "@/lib/settlements";

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
