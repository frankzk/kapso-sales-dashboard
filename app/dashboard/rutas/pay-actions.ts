"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/access";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import type { RiderPayDetail, RiderPaySnapshot } from "@/lib/rider-pay";

const uuid = z.string().uuid();
const money = z.number().finite().min(0).max(99999.99).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.000001);
type Result = { error?: string; notice?: string };

async function context(routeId: string) {
  if (!uuid.safeParse(routeId).success) return null;
  const user = await getCurrentUser();
  if (!user) return null;
  const sb = await createServerSupabase();
  const { data: route } = await sb.from("delivery_routes").select("id,rider_id,org_id").eq("id", routeId).maybeSingle();
  if (!route) return null;
  const [canRead, canConfigure, canApprove] = await Promise.all([
    hasOrgPermission(route.org_id, "routes.manage"),
    hasOrgPermission(route.org_id, "costs.manage"),
    hasOrgPermission(route.org_id, "settlements.close"),
  ]);
  if (!canRead && !canApprove) return null;
  return { route, user, canConfigure, canApprove, admin: createAdminSupabase() };
}
function refresh() {
  revalidatePath("/dashboard/courier/reparto");
  revalidatePath("/dashboard/liquidaciones");
}

export async function getRiderPayDetail(routeId: string): Promise<{ detail?: RiderPayDetail; error?: string }> {
  const ctx = await context(routeId);
  if (!ctx) return { error: "Sin acceso al cálculo de esta ruta." };
  const { admin, route, user } = ctx;
  const [closure, rates] = await Promise.all([
    admin.from("rider_daily_pay_closures").select("snapshot,approved_at,approved_by").eq("route_id", routeId).maybeSingle(),
    admin.from("rider_pay_rates").select("id,district_key,amount,effective_from,reason").eq("rider_id", route.rider_id).order("effective_from", { ascending: false }).order("created_at", { ascending: false }).limit(500),
  ]);
  // Schema intentionally gated: do not replace a missing migration with a zero payout.
  if (closure.error || rates.error) return { error: "Tarifas personales no disponibles. Falta aplicar la migración 0162 o revisar el acceso; no se calculará un pago en cero." };
  // The canonical Lima/Callao universe is the same one used by the courier.
  const { data: canonical, error: districtError } = await admin.rpc("courier_lima_districts", { p_org_id: route.org_id });
  const preview = closure.data ? { data: closure.data.snapshot, error: null }
    : await admin.rpc("rider_pay_preview", { p_route: routeId, p_actor: user.id });
  if (preview.error) return { error: preview.error.message };
  return { detail: {
    snapshot: preview.data as RiderPaySnapshot,
    approved: closure.data ? { at: closure.data.approved_at, by: closure.data.approved_by } : null,
    rates: rates.data ?? [],
    districts: districtError ? [] : (canonical ?? []).map((d: { district_key: string; district: string }) => ({ district_key: d.district_key, name: d.district })),
    canConfigure: ctx.canConfigure, canApprove: ctx.canApprove,
  } };
}

export async function saveRiderPayRate(input: { routeId: string; district: string | null; amount: number; from: string; reason: string }): Promise<Result> {
  const parsed = z.object({ routeId: uuid, district: z.string().max(100).nullable(), amount: money,
    from: z.iso.date(), reason: z.string().trim().min(3).max(1000) }).safeParse(input);
  if (!parsed.success) return { error: "Revisa importe, fecha de vigencia y motivo." };
  const ctx = await context(input.routeId);
  if (!ctx?.canConfigure) return { error: "Sin permiso para configurar la tarifa del motorizado." };
  const { error } = await ctx.admin.rpc("rider_pay_save_rate", {
    p_rider: ctx.route.rider_id, p_district: input.district, p_amount: input.amount,
    p_from: input.from, p_reason: input.reason, p_actor: ctx.user.id,
  });
  if (error) return { error: error.message };
  refresh();
  return { notice: "Nueva tarifa personal guardada. Los cierres aprobados conservan sus importes." };
}

export async function approveRiderAdjustment(input: { routeId: string; stopId: string; amount: number; reason: string; requestId: string; reverseId?: string }): Promise<Result> {
  if (!z.object({ routeId: uuid, stopId: uuid, amount: money.positive(), reason: z.string().trim().min(3).max(1000), requestId: uuid, reverseId: uuid.optional() }).safeParse(input).success) {
    return { error: "Elige un punto, un importe positivo y el motivo." };
  }
  const ctx = await context(input.routeId);
  if (!ctx?.canApprove) return { error: "Sin permiso para aprobar adicionales." };
  const { error } = await ctx.admin.rpc("rider_pay_add_adjustment", {
    p_route: input.routeId, p_stop: input.stopId, p_amount: input.amount, p_reason: input.reason,
    p_actor: ctx.user.id, p_request: input.requestId, p_reverse: input.reverseId ?? null,
  });
  if (error) return { error: error.message };
  refresh();
  return { notice: input.reverseId ? "Adicional anulado mediante una contrapartida auditada." : "Adicional aprobado con tu usuario y motivo." };
}

export async function approveRiderDailyPay(routeId: string, expected: RiderPaySnapshot): Promise<Result> {
  const ctx = await context(routeId);
  if (!ctx?.canApprove) return { error: "Sin permiso para aprobar la liquidación diaria." };
  // Client snapshot is only a compare-and-swap token. SQL recomputes all money.
  const { error } = await ctx.admin.rpc("rider_pay_approve", { p_route: routeId, p_expected: expected, p_actor: ctx.user.id });
  if (error) return { error: error.message };
  refresh();
  return { notice: "Cálculo diario aprobado y congelado. Aún debes registrar el movimiento real de dinero; no se marcó como pagado." };
}
