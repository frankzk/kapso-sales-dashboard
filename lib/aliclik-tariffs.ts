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
import { refreshOrderCoverage } from "@/lib/order-coverage";

/** Marca de procedencia. El cron solo toca lo suyo. */
export const ALICLIK_TARIFF_SOURCE = "aliclik";

/**
 * Conceptos con tarifa automática. `intento_adicional` NO sale de la
 * cotización —su API no lo devuelve— sino de los reportes Excel, que sí traen
 * `COSTO ENTREGA ADICIONAL`.
 */
export type QuotedConcept = "primer_intento" | "devolucion" | "intento_adicional";

/**
 * El almacén desde el que se cotiza: el más frecuente; a igualdad, el id más
 * bajo. El desempate mantiene la elección ESTABLE entre pasadas — si cambiara
 * de un día para otro, las tarifas de distintos distritos dejarían de ser
 * comparables entre sí, que es justo lo que se quiere evitar.
 */
export function pickTopWarehouse(counts: ReadonlyMap<number, number>): number | undefined {
  let best: number | undefined;
  let bestCount = -1;
  for (const [id, n] of counts) {
    if (n > bestCount || (n === bestCount && best !== undefined && id < best)) {
      best = id;
      bestCount = n;
    }
  }
  return best;
}

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
  /** Distritos que se dejaron intactos porque los lleva una tarifa manual. */
  skippedManual: number;
}

/**
 * Clave de comparación. Normaliza acentos y mayúsculas —los pedidos traen
 * "URUBAMBA", "Urubamba" y "Ancón"/"Ancon" indistintamente— pero NO ortografía:
 * "Cusco" y "Cuzco" siguen siendo dos distritos distintos, que es justo por lo
 * que las tarifas van por distrito y no por región.
 */
const key = (district: string, concept: string) =>
  `${district
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()}|${concept}`;

/**
 * Decide qué escribir. PURA: recibe lo observado y lo vigente, devuelve el plan.
 *
 * La regla que evita ensuciar el histórico: si el importe NO cambió, no se toca
 * nada. Sin eso, un cron diario generaría 661 filas nuevas cada día y la
 * vigencia de cada tarifa duraría 24 horas, volviendo inservible el propio
 * mecanismo de "al cambiarla se cierra la anterior".
 *
 * `manual` son las tarifas vigentes que NO puso el cron —cargadas a mano o
 * importadas de una planilla— y funcionan como veto: en ese distrito y ese
 * concepto el robot no escribe. No basta con "que no las pise": al resolver,
 * `lib/costs.ts` desempata por `effective_from` más reciente, así que una fila
 * automática insertada hoy le ganaría a la manual de ayer sin haber tocado ni
 * un byte de ella. La persona que se sentó a averiguar el precio real gana.
 */
export function planTariffUpdates(
  observed: readonly ObservedRate[],
  existing: readonly ExistingTariff[],
  today: string,
  manual: readonly ExistingTariff[] = [],
): TariffPlan {
  const current = new Map<string, ExistingTariff>();
  for (const t of existing) {
    if (!t.district) continue;
    current.set(key(t.district, t.concept), t);
  }
  const vetoed = new Set<string>();
  for (const t of manual) {
    if (!t.district) continue;
    vetoed.add(key(t.district, t.concept));
  }

  const plan: TariffPlan = { close: [], remove: [], insert: [], skippedManual: 0 };
  const previousDay = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);

  for (const o of observed) {
    if (!Number.isFinite(o.amount) || o.amount < 0) continue;
    if (vetoed.has(key(o.district, o.concept))) {
      plan.skippedManual += 1;
      continue;
    }
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
  /** Cotizaciones descartadas por respetar una tarifa cargada a mano. */
  skippedManual: number;
  /**
   * Distritos que se quedaron sin cotizar porque su API falló, incluso tras la
   * segunda vuelta. Se cuenta aparte de `errors` porque es EL número que dice
   * si la pasada sirvió de algo: una donde fallaron 45 de 60 y otra donde no
   * cambió ningún precio dan las dos `changed: 0`, y no son lo mismo.
   */
  failed: number;
  errors: string[];
}

/**
 * ¿Merece una segunda vuelta al final de la pasada?
 *
 * `status === null` es corte de red o timeout; 5xx es que su servidor reventó.
 * Un 4xx NO se reintenta: es la petición la que está mal y repetirla da igual.
 */
const worthRetrying = (status: number | null) => status === null || status >= 500;

/**
 * Todas las tarifas vigentes por distrito de una organización, separadas por
 * procedencia.
 *
 * Se traen TODAS y no solo las de los distritos observados, a propósito. El
 * filtro `.in("district", …)` compara texto exacto, así que una tarifa manual
 * escrita "Ancón" quedaría fuera al observar "Ancon" y el cron creería que ese
 * distrito está libre. Son unos cientos de filas: la comparación tolerante a
 * acentos la hace `planTariffUpdates`, aquí solo se trae el material.
 */
const TARIFF_PAGE = 1000;

async function loadLiveDistrictTariffs(
  admin: SupabaseClient,
  orgId: string,
): Promise<{ auto: ExistingTariff[]; manual: ExistingTariff[]; error?: string }> {
  const auto: ExistingTariff[] = [];
  const manual: ExistingTariff[] = [];
  for (let from = 0; ; from += TARIFF_PAGE) {
    const { data, error } = await admin
      .from("cost_tariffs")
      .select("id,concept,district,amount,effective_from,source")
      .eq("org_id", orgId)
      .not("district", "is", null)
      .is("effective_to", null)
      .order("id")
      .range(from, from + TARIFF_PAGE - 1);
    if (error) return { auto, manual, error: error.message };
    const rows = (data ?? []) as (ExistingTariff & { source: string | null })[];
    for (const r of rows) {
      const t: ExistingTariff = {
        id: r.id,
        concept: r.concept,
        district: r.district,
        amount: Number(r.amount),
        effective_from: r.effective_from,
      };
      (r.source === ALICLIK_TARIFF_SOURCE ? auto : manual).push(t);
    }
    if (rows.length < TARIFF_PAGE) break;
  }
  return { auto, manual };
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
  const out: TariffSyncResult = {
    ok: true,
    quoted: 0,
    changed: 0,
    skipped: 0,
    skippedManual: 0,
    failed: 0,
    errors: [],
  };
  const observed: ObservedRate[] = [];

  /** Cotiza un distrito y anota el resultado en `out`. */
  const attempt = async (p: DistrictProbe): Promise<"ok" | "retry" | "failed"> => {
    const quote = await quoteShippingCost(opts, {
      warehouseId: p.warehouseId,
      lat: toAliclikCoord(p.lat),
      lng: toAliclikCoord(p.lng),
    });
    if (!quote.ok) {
      // Un distrito que falla no puede tumbar la pasada entera: se anota y sigue.
      out.errors.push(`${p.district}: ${quote.error}`);
      return worthRetrying(quote.status) ? "retry" : "failed";
    }
    out.quoted += 1;

    // Sin cobertura no hay tarifa que registrar, y poner cero sería mentir: un
    // costo de cero y un "no llegamos" no son lo mismo.
    const courier = (quote.data.couriers ?? [])[0];
    if (!courier) {
      out.skipped += 1;
      return "ok";
    }
    observed.push({ district: p.district, concept: "primer_intento", amount: courier.deliveryCost });
    if (Number.isFinite(courier.returnCost)) {
      observed.push({ district: p.district, concept: "devolucion", amount: courier.returnCost });
    }
    return "ok";
  };

  const retry: DistrictProbe[] = [];
  for (const p of probes) {
    const r = await attempt(p);
    if (r === "retry") retry.push(p);
    else if (r === "failed") out.failed += 1;
  }

  // SEGUNDA VUELTA, y no más reintentos dentro de la primera. Los 5xx de Aliclik
  // llegan en rachas de minutos —el 29/07 fallaron 136 de 203 peticiones entre
  // las 09:25 y las 09:45 UTC—, y los tres reintentos que ya hace el cliente HTTP
  // se agotan en poco más de un segundo, dentro de la misma racha. Volver al
  // final de la pasada pone minutos de por medio sin dormir el proceso.
  //
  // Un distrito que falla tampoco se pierde: al no escribirse ninguna tarifa
  // sigue con `last_quoted` nulo y `aliclik_tariff_probes` lo devuelve el
  // primero mañana. Esto solo evita perder la pasada entera.
  if (retry.length) {
    out.errors.push(`Segunda vuelta para ${retry.length} distrito(s) que fallaron.`);
    for (const p of retry) {
      if ((await attempt(p)) !== "ok") out.failed += 1;
    }
  }

  if (!observed.length) return out;

  const live = await loadLiveDistrictTariffs(admin, orgId);
  if (live.error) {
    out.ok = false;
    out.errors.push(`Tarifas vigentes: ${live.error}`);
    return out;
  }

  const plan = planTariffUpdates(observed, live.auto, today, live.manual);
  out.skippedManual = plan.skippedManual;

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
  if (out.changed > 0) await refreshOrderCoverage(admin, orgId);
  return out;
}

// ---------------------------------------------------------------------------
// Derivar tarifas de los reportes Excel ya importados
// ---------------------------------------------------------------------------

/**
 * Escribe las tarifas que salen de los Excel de Repro Provincia.
 *
 * ES LA FUENTE PREFERENTE, por delante de cotizar contra su API:
 *
 *   * es el costo REALIZADO —lo que Aliclik cobró— y no una estimación;
 *   * cubre 80 distritos de golpe en vez de 60 por día;
 *   * no depende de que su API responda, que hoy mismo estuvo caída 45 minutos;
 *   * incluye `intento_adicional`, que su cotización no devuelve.
 *
 * La agregación vive en `aliclik_tariffs_from_reports` (SQL) porque parte de
 * ~20.000 filas: traerlas para agrupar en JavaScript sería mover megabytes por
 * la red para quedarse con 183 números.
 *
 * La cotización NO se retira: sigue siendo la única vía para distritos donde
 * todavía no se ha enviado nada, que son justo los que no tienen histórico.
 */
export async function syncTariffsFromReports(
  days: number,
  today: string,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<{
  ok: boolean;
  observed: number;
  changed: number;
  skippedManual: number;
  errors: string[];
}> {
  const out = { ok: true, observed: 0, changed: 0, skippedManual: 0, errors: [] as string[] };

  const { data, error } = await admin.rpc("aliclik_tariffs_from_reports", { p_days: days });
  if (error) return { ...out, ok: false, errors: [error.message] };

  const rows = (data ?? []) as {
    org_id: string;
    district: string;
    concept: string;
    amount: number | string;
  }[];
  out.observed = rows.length;
  if (!rows.length) return out;

  // Las tarifas son por organización, así que el plan se calcula por separado
  // para cada una: mezclarlas cerraría filas de una org con datos de otra.
  const byOrg = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byOrg.get(r.org_id) ?? [];
    list.push(r);
    byOrg.set(r.org_id, list);
  }

  for (const [orgId, orgRows] of byOrg) {
    const live = await loadLiveDistrictTariffs(admin, orgId);
    if (live.error) {
      out.ok = false;
      out.errors.push(`Tarifas vigentes (${orgId}): ${live.error}`);
      continue;
    }

    const plan = planTariffUpdates(
      orgRows.map((r) => ({
        district: r.district,
        concept: r.concept as QuotedConcept,
        amount: Number(r.amount),
      })),
      live.auto,
      today,
      live.manual,
    );
    out.skippedManual += plan.skippedManual;

    for (const c of plan.close) {
      await admin.from("cost_tariffs").update({ effective_to: c.effectiveTo }).eq("id", c.id);
    }
    if (plan.remove.length) await admin.from("cost_tariffs").delete().in("id", plan.remove);
    if (plan.insert.length) {
      const { error: insErr } = await admin.from("cost_tariffs").insert(
        plan.insert.map((i) => ({
          org_id: orgId,
          courier: "aliclik",
          district: i.district,
          concept: i.concept,
          amount: i.amount,
          effective_from: i.effectiveFrom,
          source: ALICLIK_TARIFF_SOURCE,
          note: `Derivado de los reportes de Aliclik (últimos ${days} días)`,
        })),
      );
      if (insErr) {
        out.ok = false;
        out.errors.push(`Insertar (${orgId}): ${insErr.message}`);
        continue;
      }
    }
    out.changed += plan.insert.length;
  }
  return out;
}
