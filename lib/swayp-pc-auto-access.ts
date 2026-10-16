// Lectura del panel del Swayp automático desde Por confirmar (MOM §11.13):
// estado, cupo del día, última pasada y la comparación de los dos brazos.
// Con la sesión de quien mira: la RLS decide qué tiendas entran.

import { createServerSupabase } from "@/lib/db";
import { limaDateKey } from "@/lib/aliclik-geo";
import { chunk } from "@/lib/access";
import { swaypDesdeConfirmacionFailed } from "@/lib/swayp-desde-confirmacion";
import type { PcAutoArm, PorConfirmarAutoSettings } from "@/lib/swayp-por-confirmar-auto";

export type PcAutoOutcome = "entregado" | "no_entregado" | "en_curso";

export interface PcAutoBrazo {
  total: number;
  entregados: number;
  noEntregados: number;
  enCurso: number;
}

export interface PcAutoResumen {
  settings: PorConfirmarAutoSettings | null;
  creadosHoy: number;
  ultimaPasada: { at: string; summary: Record<string, unknown> } | null;
  brazos: Record<PcAutoArm, PcAutoBrazo>;
}

/** Cuenta los resultados de un brazo. Pura. */
export function resumenDelBrazo(outcomes: readonly PcAutoOutcome[]): PcAutoBrazo {
  return {
    total: outcomes.length,
    entregados: outcomes.filter((o) => o === "entregado").length,
    noEntregados: outcomes.filter((o) => o === "no_entregado").length,
    enCurso: outcomes.filter((o) => o === "en_curso").length,
  };
}

/**
 * En qué quedó un pedido del grupo de control, que sigue el camino normal:
 * entregado por quien sea, cerrado sin entrega (o anulado), o todavía en curso.
 */
export function resultadoDeControl(m: {
  delivered_courier: string | null;
  macro_stage: string | null;
  cancelled_at?: string | null;
}): PcAutoOutcome {
  if (m.delivered_courier) return "entregado";
  if (m.cancelled_at || m.macro_stage === "finalizado" || m.macro_stage === "por_cerrar") return "no_entregado";
  return "en_curso";
}

export async function getPcAutoResumen(orgId: string): Promise<PcAutoResumen> {
  const sb = await createServerSupabase();
  const vacio: PcAutoBrazo = { total: 0, entregados: 0, noEntregados: 0, enCurso: 0 };

  const [settingsRes, runsRes, decisionsRes] = await Promise.all([
    sb.from("swayp_pc_auto_settings").select("*").eq("org_id", orgId).maybeSingle(),
    sb.from("swayp_pc_auto_runs").select("created_at,summary").eq("org_id", orgId).order("created_at", { ascending: false }).limit(1),
    sb
      .from("swayp_pc_auto_decisions")
      .select("order_id,arm,reason,shipment_id,decided_at")
      .eq("org_id", orgId)
      .eq("eligible", true)
      .order("decided_at", { ascending: false })
      .limit(1000),
  ]);
  // Sin la tabla (migración sin aplicar) el panel dice que no está instalado, no revienta la página.
  if (settingsRes.error) return { settings: null, creadosHoy: 0, ultimaPasada: null, brazos: { swayp: vacio, control: vacio } };

  const decisiones = (decisionsRes.data ?? []) as {
    order_id: string;
    arm: PcAutoArm | null;
    reason: string;
    shipment_id: string | null;
    decided_at: string;
  }[];
  const hoy = `${limaDateKey()}T05:00:00Z`;
  const creadosHoy = decisiones.filter((d) => d.reason === "created" && d.decided_at >= hoy).length;

  const swayp = decisiones.filter((d) => d.arm === "swayp" && d.shipment_id);
  const control = decisiones.filter((d) => d.arm === "control");

  const outSwayp: PcAutoOutcome[] = [];
  for (const part of chunk(swayp.map((d) => d.shipment_id!), 200)) {
    const { data } = await sb
      .from("shipments")
      .select("courier,delivery_status,swayp_state,reported_status,closed_at,returned_at,updated_at")
      .in("id", part);
    for (const g of (data ?? []) as Parameters<typeof swaypDesdeConfirmacionFailed>[0][]) {
      outSwayp.push(g.delivery_status === "entregado" ? "entregado" : swaypDesdeConfirmacionFailed(g) ? "no_entregado" : "en_curso");
    }
  }
  const outControl: PcAutoOutcome[] = [];
  for (const part of chunk(control.map((d) => d.order_id), 200)) {
    const [{ data: masters }, { data: orders }] = await Promise.all([
      sb.from("order_master").select("order_id,delivered_courier,macro_stage").in("order_id", part),
      sb.from("orders").select("id,cancelled_at").in("id", part),
    ]);
    const cancelled = new Map(((orders ?? []) as { id: string; cancelled_at: string | null }[]).map((o) => [o.id, o.cancelled_at]));
    for (const m of (masters ?? []) as { order_id: string; delivered_courier: string | null; macro_stage: string | null }[]) {
      outControl.push(resultadoDeControl({ ...m, cancelled_at: cancelled.get(m.order_id) ?? null }));
    }
  }

  const run = ((runsRes.data ?? []) as { created_at: string; summary: Record<string, unknown> }[])[0];
  return {
    settings: (settingsRes.data as PorConfirmarAutoSettings | null) ?? null,
    creadosHoy,
    ultimaPasada: run ? { at: run.created_at, summary: run.summary } : null,
    brazos: { swayp: resumenDelBrazo(outSwayp), control: resumenDelBrazo(outControl) },
  };
}
