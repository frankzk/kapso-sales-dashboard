// El cambio de cobertura de un pedido, registrado (MOM §19.0.1, 13-10-2026).
//
// LA PREGUNTA DEL OWNER. Si «Descargar rótulos» solo crea la salida interna en
// Lima, un pedido mal clasificado —Provincia COD o Agencia que en realidad es
// de Lima— se queda sin rótulo. La salida no es otra puerta: es corregir la
// cobertura por la vía que ya existe y que quede escrito que se corrigió.
//
// La cobertura NO se escribe a mano: la decide `order_coverage_for` en la base
// a partir de la ubicación y de las decisiones por distrito. Lo que una persona
// cambia es la CAUSA —la ubicación del pedido, o la cobertura de su distrito—,
// y la cobertura se recalcula. Hasta hoy eso dejaba un comentario genérico
// («Ubicación corregida…») y en ningún sitio decía «pasó de Provincia COD a
// Lima». Ahora cada acción humana que mueve la cobertura deja el hecho
// `coverage_changed` con el antes, el después y la causa.
//
// Solo las acciones HUMANAS. El recálculo del Master corre en tandas de miles y
// una tarifa nueva puede reclasificar un distrito entero: registrar ahí cada
// cambio llenaría el historial sin que nadie haya decidido nada.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ORDER_COVERAGE_LABEL, type OrderCoverage } from "@/lib/order-coverage";

export const COVERAGE_CHANGED_KIND = "coverage_changed";

/** Qué acción humana movió la cobertura. */
export type CoverageChangeCause = "ubicacion_corregida" | "ubicacion_restaurada" | "decision_distrito";

export const COVERAGE_CHANGE_CAUSE_LABEL: Record<CoverageChangeCause, string> = {
  ubicacion_corregida: "ubicación corregida",
  ubicacion_restaurada: "corrección de ubicación retirada",
  decision_distrito: "decisión de cobertura del distrito",
};

export function coverageLabel(value: string | null | undefined): string {
  if (!value) return "sin cobertura";
  return ORDER_COVERAGE_LABEL[value as OrderCoverage] ?? value;
}

/** «Cobertura: Provincia COD → Lima · ubicación corregida». */
export function coverageChangeNote(from: string | null, to: string | null, cause: CoverageChangeCause): string {
  return `Cobertura: ${coverageLabel(from)} → ${coverageLabel(to)} · ${COVERAGE_CHANGE_CAUSE_LABEL[cause]}.`;
}

export interface CoverageSnapshot {
  order_id: string;
  store_id: string;
  coverage: string | null;
}

/**
 * Los eventos a escribir: uno por pedido cuya cobertura cambió. Puro.
 * Un pedido que ya no aparece en `after` no se registra — no se inventa un
 * «después» que no se leyó.
 */
export function coverageChangeEvents(
  before: readonly CoverageSnapshot[],
  after: readonly CoverageSnapshot[],
  input: { cause: CoverageChangeCause; actor: string | null; reason?: string | null; occurredAt: string },
): Record<string, unknown>[] {
  const now = new Map(after.map((row) => [row.order_id, row]));
  const events: Record<string, unknown>[] = [];
  for (const prev of before) {
    const next = now.get(prev.order_id);
    if (!next || (next.coverage ?? null) === (prev.coverage ?? null)) continue;
    events.push({
      store_id: prev.store_id,
      order_id: prev.order_id,
      kind: COVERAGE_CHANGED_KIND,
      source: "manual",
      actor: input.actor,
      occurred_at: input.occurredAt,
      reason: input.reason ?? null,
      note: coverageChangeNote(prev.coverage, next.coverage, input.cause),
      payload: { from: prev.coverage, to: next.coverage, cause: input.cause },
    });
  }
  return events;
}

/**
 * Relee la cobertura después del recálculo y escribe un `coverage_changed` por
 * cada pedido que cambió. Devuelve los cambios, para decirlos en pantalla.
 *
 * No falla la acción que lo llama: la corrección ya quedó guardada y el pedido
 * ya se recalculó. Si este registro no se puede escribir, se devuelve el error
 * para mostrarlo, pero la cobertura nueva es la verdadera igual.
 */
export async function recordCoverageChanges(
  admin: SupabaseClient,
  before: readonly CoverageSnapshot[],
  input: { cause: CoverageChangeCause; actor: string | null; reason?: string | null },
): Promise<{ changed: { order_id: string; from: string | null; to: string | null }[]; error: string | null }> {
  if (!before.length) return { changed: [], error: null };
  const after: CoverageSnapshot[] = [];
  const ids = before.map((row) => row.order_id);
  for (let start = 0; start < ids.length; start += 200) {
    const { data, error } = await admin
      .from("order_master")
      .select("order_id,store_id,coverage")
      .in("order_id", ids.slice(start, start + 200));
    if (error) return { changed: [], error: `No se pudo verificar la cobertura nueva: ${error.message}` };
    after.push(...((data ?? []) as CoverageSnapshot[]));
  }
  const events = coverageChangeEvents(before, after, { ...input, occurredAt: new Date().toISOString() });
  const changed = events.map((event) => {
    const payload = event.payload as { from: string | null; to: string | null };
    return { order_id: event.order_id as string, from: payload.from, to: payload.to };
  });
  if (!events.length) return { changed, error: null };
  const { error } = await admin.from("order_events").insert(events);
  return { changed, error: error ? `No se pudo registrar el cambio de cobertura: ${error.message}` : null };
}
