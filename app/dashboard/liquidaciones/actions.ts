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
import { computeRiderPayout, settlementMasterEffects, settlementStatus } from "@/lib/settlements";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { defaultOperationalFor } from "@/lib/order-status";
import {
  directOrderSearchTerm,
  evaluateSettlementCandidateScope,
  settlementMatchKey,
} from "@/lib/settlement-order-search";

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

export interface SettlementOrderCandidate {
  orderId: string;
  orderName: string;
  storeName: string;
  customerName: string;
  district: string;
  total: number | null;
  status: string;
  score: number;
  reasons: string[];
  warnings: string[];
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

  const { data: line } = await g.admin
    .from("rider_settlement_lines")
    .select("settlement_id")
    .eq("id", lineId)
    .maybeSingle();
  if ((line as { settlement_id?: string } | null)?.settlement_id !== settlementId) {
    return { ok: false, error: "La línea no pertenece a esta liquidación." };
  }

  if (orderId) {
    const stores = await getAccessibleStores();
    const { data: order } = await g.admin
      .from("orders")
      .select("id,store_id")
      .eq("id", orderId)
      .maybeSingle();
    const storeId = (order as { store_id?: string } | null)?.store_id;
    if (!storeId || !stores.some((store) => store.id === storeId)) {
      return { ok: false, error: "Pedido inexistente o fuera de tus tiendas." };
    }
  }

  const res = await relinkSettlementLine(g.admin, lineId, orderId);
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath("/dashboard/liquidaciones");
  return { ok: true, message: orderId ? "Línea vinculada." : "Línea marcada sin pedido." };
}

/**
 * Sugiere pedidos para una fila de Axel. La sugerencia nunca modifica nada:
 * una persona debe confirmarla con `relinkLine`.
 */
export async function searchSettlementOrders(
  settlementId: string,
  lineId: string,
  query = "",
): Promise<{ ok: boolean; error?: string; candidates?: SettlementOrderCandidate[] }> {
  const g = await guard("settlements.manage");
  if ("error" in g) return { ok: false, error: g.error };

  const reach = await assertReachable(g.admin, settlementId);
  if ("error" in reach) return { ok: false, error: reach.error };

  const [{ data: head }, { data: line }, stores] = await Promise.all([
    g.admin
      .from("rider_settlements")
      .select("settlement_date,status")
      .eq("id", settlementId)
      .maybeSingle(),
    g.admin
      .from("rider_settlement_lines")
      .select("settlement_id,customer_name,district,declared_amount,store_hint,raw")
      .eq("id", lineId)
      .maybeSingle(),
    getAccessibleStores(),
  ]);
  if (!head || !line || (line as { settlement_id: string }).settlement_id !== settlementId) {
    return { ok: false, error: "Línea inexistente o fuera de esta liquidación." };
  }

  const day = String((head as { settlement_date: string }).settlement_date);
  const from = new Date(`${day}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 7);
  const to = new Date(`${day}T00:00:00.000Z`);
  to.setUTCDate(to.getUTCDate() + 3);
  const storeIds = stores.map((store) => store.id);
  const selectedFields =
    "order_id,order_name,store_id,customer_name,district,order_total,general_status,order_created_at";
  const directTerm = directOrderSearchTerm(query);
  const [windowResult, directResult] = await Promise.all([
    g.admin
      .from("order_master")
      .select(selectedFields)
      .in("store_id", storeIds)
      .gte("order_created_at", from.toISOString())
      .lt("order_created_at", to.toISOString())
      .limit(5000),
    directTerm
      ? g.admin
          .from("order_master")
          .select(selectedFields)
          .in("store_id", storeIds)
          .ilike("order_name", `%${directTerm}%`)
          .limit(25)
      : Promise.resolve({ data: [] }),
  ]);

  // La ventana de fechas protege la búsqueda difusa. La consulta directa se
  // combina aparte para que un código Shopify exacto no desaparezca porque el
  // courier liquidó tarde o escribió una tienda equivocada en su reporte.
  const orderRows = new Map<string, Record<string, unknown>>();
  for (const candidate of [...(windowResult.data ?? []), ...(directResult.data ?? [])]) {
    const orderId = String((candidate as { order_id?: string }).order_id ?? "");
    if (orderId) orderRows.set(orderId, candidate as Record<string, unknown>);
  }

  const row = line as {
    customer_name: string | null;
    district: string | null;
    declared_amount: number | null;
    store_hint: string | null;
    raw: Record<string, unknown> | null;
  };
  const storeNames = new Map(stores.map((store) => [store.id, store.name]));
  const storeHintRaw = row.store_hint ?? String(row.raw?.cliente ?? "");
  const storeHint = settlementMatchKey(storeHintRaw);
  const wantedName = settlementMatchKey(row.customer_name);
  const wantedDistrict = settlementMatchKey(row.district);
  const wantedQuery = settlementMatchKey(query);

  const candidates = (Array.from(orderRows.values()) as unknown as {
    order_id: string;
    order_name: string | null;
    store_id: string;
    customer_name: string | null;
    district: string | null;
    order_total: number | null;
    general_status: string | null;
  }[])
    .map((candidate) => {
      const storeName = storeNames.get(candidate.store_id) ?? "";
      const name = settlementMatchKey(candidate.customer_name);
      const district = settlementMatchKey(candidate.district);
      const orderName = settlementMatchKey(candidate.order_name);
      const reasons: string[] = [];
      const warnings: string[] = [];
      let score = 0;

      const scope = evaluateSettlementCandidateScope({
        orderName: candidate.order_name,
        storeName,
        storeHint: storeHintRaw,
        query,
      });
      if (!scope.allowed) return null;
      if (scope.exactOrderCode) {
        score += 100;
        reasons.push("código Shopify exacto");
      }
      if (scope.warning) warnings.push(scope.warning);

      if (storeHint) {
        if (scope.storeMatches) {
          score += 35;
          reasons.push(`tienda ${storeName}`);
        }
      }
      if (wantedName && name === wantedName) {
        score += 45;
        reasons.push("nombre exacto");
      } else if (wantedName && (name.startsWith(wantedName) || wantedName.startsWith(name))) {
        score += 32;
        reasons.push("nombre similar");
      }
      if (wantedDistrict && district === wantedDistrict) {
        score += 15;
        reasons.push("mismo distrito");
      }
      if (
        row.declared_amount !== null &&
        candidate.order_total !== null &&
        Math.abs(Number(row.declared_amount) - Number(candidate.order_total)) < 0.01
      ) {
        score += 15;
        reasons.push("mismo monto");
      }
      if (
        wantedQuery &&
        !name.includes(wantedQuery) &&
        !orderName.includes(wantedQuery) &&
        !district.includes(wantedQuery)
      ) {
        return null;
      }
      return {
        orderId: candidate.order_id,
        orderName: candidate.order_name ?? "Sin código",
        storeName,
        customerName: candidate.customer_name ?? "Sin nombre",
        district: candidate.district ?? "Sin distrito",
        total: candidate.order_total === null ? null : Number(candidate.order_total),
        status: candidate.general_status ?? "sin estado",
        score: Math.min(100, score),
        reasons,
        warnings,
      } satisfies SettlementOrderCandidate;
    })
    .filter((candidate): candidate is SettlementOrderCandidate => Boolean(candidate))
    .filter((candidate) => wantedQuery.length > 0 || candidate.score >= 32)
    .sort((a, b) => b.score - a.score || a.orderName.localeCompare(b.orderName))
    .slice(0, 12);

  return { ok: true, candidates };
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

  if (detail.reconciled.totals.reviewCount > 0) {
    return {
      ok: false,
      error:
        `Quedan ${detail.reconciled.totals.reviewCount} fila(s) sin cotejar. ` +
        "Asigna un pedido o márcalas como “sin pedido” antes de procesar.",
    };
  }

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

  const factStore = new Map(
    detail.reconciled.lines
      .filter((line) => line.facts)
      .map((line) => [line.facts!.order_id, line.facts!.store_id]),
  );
  const events = pending.map((e) => ({
    store_id: factStore.get(e.order_id) ?? reach.storeId,
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
      (anulados ? `, ${anulados} anulado(s) por rechazo` : "") + ".",
  };
}
