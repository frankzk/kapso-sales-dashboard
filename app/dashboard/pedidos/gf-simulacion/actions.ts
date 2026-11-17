"use server";

// Simulación de GF Courier (MOM §29.17, owner 16-11-2026). Solo el owner. Ninguna de las dos acciones escribe en Kapta
// ni crea nada en GF: la primera lista los pedidos y la segunda los manda a POST /v1/orders/validate de a 120.
import { limaTodayKey } from "@/lib/shipments";
import { GF_SIM_CHUNK, type GfSimOutcome } from "@/lib/gf-courier-simulation";
import { listGfSimulationTargets, runGfSimulationChunk } from "@/lib/gf-courier-simulate-server";
import { loadGfSimulationStores } from "@/lib/gf-courier-simulate-access";

export type GfSimStart =
  | { ok: true; stores: { id: string; name: string; count: number }[]; orderIds: string[] }
  | { ok: false; error: string };

export async function startGfSimulation(): Promise<GfSimStart> {
  const ctx = await loadGfSimulationStores();
  if (!ctx) return { ok: false, error: "Solo el owner puede simular con GF Courier." };
  if (!ctx.stores.length) return { ok: false, error: "Ninguna tienda tiene token de GF Courier." };
  try {
    const targets = await listGfSimulationTargets(ctx.admin, ctx.stores.map((s) => s.id));
    const count = new Map<string, number>();
    for (const t of targets) count.set(t.storeId, (count.get(t.storeId) ?? 0) + 1);
    return { ok: true, stores: ctx.stores.map((s) => ({ id: s.id, name: s.name, count: count.get(s.id) ?? 0 })), orderIds: targets.map((t) => t.orderId) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type GfSimStep = { ok: true; outcomes: GfSimOutcome[] } | { ok: false; error: string };

export async function runGfSimulationStep(orderIds: string[]): Promise<GfSimStep> {
  if (!Array.isArray(orderIds) || orderIds.length > GF_SIM_CHUNK || orderIds.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))) {
    return { ok: false, error: "Pasada inválida." };
  }
  const ctx = await loadGfSimulationStores();
  if (!ctx) return { ok: false, error: "Solo el owner puede simular con GF Courier." };
  const stores = new Map(ctx.stores.map((s) => [s.id, s]));
  const outcomes = await runGfSimulationChunk(ctx.admin, orderIds, stores, limaTodayKey());
  return { ok: true, outcomes };
}
