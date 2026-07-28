// Tarifas de ALIDRIVER por distrito, cotizadas contra Aliclik.
//
// PARA QUÉ. `shipments.quoted_delivery_cost` guarda el precio exacto de cada
// guía, pero solo existe DESPUÉS de crearla. Los ~6.500 pedidos que todavía no
// tienen guía no tienen precio, y sin él no hay margen estimado ni forma de
// decidir a cuáles conviene despachar. Esta tabla llena ese hueco.
//
// SOLO LECTURA HACIA AFUERA. `GET /integration/order/shipping/cost` no crea
// pedidos, no reserva stock y no escribe nada en Aliclik: es la misma llamada
// que hace el botón "Cotizar envío". Lo único que se escribe es nuestra propia
// `cost_tariffs`.
//
// POR DISTRITO Y NO POR REGIÓN, y no por gusto: los datos llegan con la región
// escrita de dos maneras —"Cusco" y "Cuzco" para la misma provincia— y
// `sameLabel` normaliza acentos y mayúsculas pero no ortografía. Una tarifa por
// región no casaría con la mitad de los pedidos. El distrito sí es consistente.
//
// LO QUE ESTA TABLA NO ES. Una tarifa por distrito es una ESTIMACIÓN. El precio
// real de un envío depende también del almacén de salida, y `cost_tariffs` no
// tiene esa dimensión — todas las guías creadas hasta ahora salieron del mismo
// almacén (133), así que no se ha podido medir cuánto varía. No se añade la
// dimensión porque el número exacto ya lo da la cotización al crear la guía, y
// ese gana sobre la tarifa en `computeLogisticsCost`. Esto es para ANTES.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { quoteShippingCost, type AliclikClientOpts } from "@/lib/aliclik";
import { toAliclikCoord } from "@/lib/aliclik-geo";

/** Marca de procedencia. El cron solo toca lo suyo. */
export const ALICLIK_TARIFF_SOURCE = "aliclik";

/** Conceptos que Aliclik cotiza. Los intentos adicionales no los da su API. */
export type QuotedConcept = "primer_intento" | "devolucion";

/** Una tarifa vigente tal y como está guardada. */
export interface ExistingTariff {
  id: string;
  concept: string;
  district: string | null;
  amount: number;
  effective_from: string;
}

/** Lo que Aliclik cobra hoy en un distrito. */
export interface ObservedRate {
  district: string;
  concept: QuotedConcept;
  amount: number;
}

export interface TariffPlan {
  /** Tarifas a cerrar (su importe cambió). */
  close: { id: string; effectiveTo: string }[];
  /** Tarifas a borrar en vez de cerrar: empezarían después de su propio cierre. */
  remove: string[];
  /** Tarifas a insertar. */
  insert: { district: string; concept: QuotedConcept; amount: number; effectiveFrom: string }[];
}

const key = (district: string, concept: string) => `${district.trim().toLowerCase()}|${concept}`;

/**
 * Decide qué escribir. PURA: recibe lo observado y lo vigente, devuelve el plan.
 *
 * La regla que evita ensuciar el histórico: si el importe NO cambió, no se toca
 * nada. Sin eso, un cron diario generaría 661 filas nuevas cada día y la
 * vigencia de cada tarifa duraría 24 horas, volviendo inservible el propio
 * mecanismo de "al cambiarla se cierra la anterior".
 */
export function planTariffUpdates(
  observed: readonly ObservedRate[],
  existing: readonly ExistingTariff[],
  today: string,
): TariffPlan {
  const current = new Map<string, ExistingTariff>();
  for (const t of existing) {
    if (!t.district) continue;
    current.set(key(t.district, t.concept), t);
  }

  const plan: TariffPlan = { close: [], remove: [], insert: [] };
  const previousDay = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);

  for (const o of observed) {
    if (!Number.isFinite(o.amount) || o.amount < 0) continue;
    const prev = current.get(key(o.district, o.concept));
    if (prev && Math.abs(prev.amount - o.amount) < 0.005) continue; // sin cambio

    if (prev) {
      // Una tarifa que empezaría después de cerrarse sería invisible: se borra
      // en vez de dejar un intervalo imposible. Mismo criterio que la pantalla.
      if (prev.effective_from > previousDay) plan.remove.push(prev.id);
      else plan.close.push({ id: prev.id, effectiveTo: previousDay });
    }
    plan.insert.push({
      district: o.district,
      concept: o.concept,
      amount: o.amount,
      effectiveFrom: today,
    });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Sincronización (impura)
// ---------------------------------------------------------------------------

/** Un distrito a cotizar, con un punto representativo tomado de un pedido real. */
export interface DistrictProbe {
  district: string;
  lat: number;
  lng: number;
  warehouseId: number;
  pending: number;
}

export interface TariffSyncResult {
  ok: boolean;
  quoted: number;
  changed: number;
  skipped: number;
  errors: string[];
}

/**
 * Cotiza un lote de distritos y actualiza las tarifas de Aliclik.
 *
 * El lote es acotado a propósito: son 661 distritos con pedidos pendientes y no
 * conocemos los límites de tasa de su API. Se priorizan los distritos con más
 * pedidos esperando, que son los que más mueven el margen, y el resto entra en
 * pasadas siguientes.
 */
export async function syncAliclikTariffs(
  orgId: string,
  probes: readonly DistrictProbe[],
  opts: AliclikClientOpts,
  today: string,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<TariffSyncResult> {
  const out: TariffSyncResult = { ok: true, quoted: 0, changed: 0, skipped: 0, errors: [] };
  const observed: ObservedRate[] = [];

  for (const p of probes) {
    const quote = await quoteShippingCost(opts, {
      warehouseId: p.warehouseId,
      lat: toAliclikCoord(p.lat),
      lng: toAliclikCoord(p.lng),
    });
    if (!quote.ok) {
      // Un distrito que falla no puede tumbar la pasada entera: se anota y sigue.
      out.errors.push(`${p.district}: ${quote.error}`);
      continue;
    }
    out.quoted += 1;

    // Sin cobertura no hay tarifa que registrar, y poner cero sería mentir: un
    // costo de cero y un "no llegamos" no son lo mismo.
    const courier = (quote.data.couriers ?? [])[0];
    if (!courier) {
      out.skipped += 1;
      continue;
    }
    observed.push({ district: p.district, concept: "primer_intento", amount: courier.deliveryCost });
    if (Number.isFinite(courier.returnCost)) {
      observed.push({ district: p.district, concept: "devolucion", amount: courier.returnCost });
    }
  }

  if (!observed.length) return out;

  const districts = [...new Set(observed.map((o) => o.district))];
  const { data: existing, error } = await admin
    .from("cost_tariffs")
    .select("id,concept,district,amount,effective_from")
    .eq("org_id", orgId)
    .eq("source", ALICLIK_TARIFF_SOURCE)
    .is("effective_to", null)
    .in("district", districts);
  if (error) {
    out.ok = false;
    out.errors.push(`Tarifas vigentes: ${error.message}`);
    return out;
  }

  const plan = planTariffUpdates(
    observed,
    ((existing ?? []) as ExistingTariff[]).map((t) => ({ ...t, amount: Number(t.amount) })),
    today,
  );

  for (const c of plan.close) {
    await admin.from("cost_tariffs").update({ effective_to: c.effectiveTo }).eq("id", c.id);
  }
  if (plan.remove.length) {
    await admin.from("cost_tariffs").delete().in("id", plan.remove);
  }
  if (plan.insert.length) {
    const { error: insErr } = await admin.from("cost_tariffs").insert(
      plan.insert.map((i) => ({
        org_id: orgId,
        // Solo courier + distrito: la región llega escrita de dos maneras
        // ("Cusco"/"Cuzco") y acotar por ella dejaría fuera la mitad.
        courier: "aliclik",
        district: i.district,
        concept: i.concept,
        amount: i.amount,
        effective_from: i.effectiveFrom,
        source: ALICLIK_TARIFF_SOURCE,
        note: "Cotizado automáticamente contra Aliclik",
      })),
    );
    if (insErr) {
      out.ok = false;
      out.errors.push(`Insertar tarifas: ${insErr.message}`);
      return out;
    }
  }
  out.changed = plan.insert.length;
  return out;
}
