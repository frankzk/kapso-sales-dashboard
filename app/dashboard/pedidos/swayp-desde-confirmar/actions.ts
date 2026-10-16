"use server";

import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import { runPorConfirmarAuto } from "@/lib/swayp-por-confirmar-auto-server";
import type { PorConfirmarAutoSettings } from "@/lib/swayp-por-confirmar-auto";

// Swayp automático desde Por confirmar (MOM §11.13). Activarlo cambia la salida
// de pedidos de toda la organización: «Administrar tiendas» (MOM §16), igual
// que el automático Aliclik → Swayp. Y solo en producción: en un preview no
// están las credenciales de Swayp ni de Aliclik.
async function autorizado(orgId: string) {
  if (!(await hasOrgPermission(orgId, "stores.manage"))) return { error: "Tu rol no permite cambiar el automático." } as const;
  if (process.env.VERCEL_ENV !== "production") return { error: "Disponible solo en producción." } as const;
  return { admin: createAdminSupabase() } as const;
}

export async function cambiarAutomaticoPc(orgId: string, enabled: boolean): Promise<{ error?: string }> {
  const a = await autorizado(orgId);
  if ("error" in a) return { error: a.error };
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  const { error } = await a.admin
    .from("swayp_pc_auto_settings")
    .upsert({
      org_id: orgId,
      enabled,
      // Encenderlo a mano borra el motivo del freno: alguien decidió seguir.
      paused_reason: null,
      paused_at: enabled ? null : new Date().toISOString(),
      updated_by: user?.id ?? null,
      updated_at: new Date().toISOString(),
    });
  if (error) return { error: error.message };
  revalidatePath("/dashboard/pedidos/swayp-desde-confirmar");
  return {};
}

export interface SimulacionPc {
  error?: string;
  checked?: number;
  eligibleSwayp?: number;
  eligibleControl?: number;
  excluded?: Record<string, number>;
  /** El freno se habría activado: no se mira ningún pedido. */
  braked?: { tasa: number | null; casos: number } | null;
  items?: { orderId: string; orderName: string | null; arm: string | null; reason: string; bodega?: string | null }[];
}

/** La pasada de hoy sin escribir nada: qué saldría, qué iría al control y por qué quedan fuera los demás. */
export async function simularAutomaticoPc(orgId: string): Promise<SimulacionPc> {
  const a = await autorizado(orgId);
  if ("error" in a) return { error: a.error };
  const { data, error } = await a.admin.from("swayp_pc_auto_settings").select("*").eq("org_id", orgId).maybeSingle();
  if (error || !data) return { error: error?.message ?? "Falta la configuración del automático." };
  const r = await runPorConfirmarAuto(a.admin, { ...(data as PorConfirmarAutoSettings), enabled: true }, { dry: true });
  if (r.error) return { error: r.error };
  return {
    checked: r.checked,
    eligibleSwayp: r.eligibleSwayp,
    eligibleControl: r.eligibleControl,
    excluded: r.excluded,
    braked: r.braked,
    items: r.items,
  };
}
