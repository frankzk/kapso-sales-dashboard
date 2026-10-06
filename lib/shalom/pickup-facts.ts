// Los hechos de clave, cobro y llegada de un pedido de Shalom, para leer bien
// un «entregado» (MOM §12). Los usan el rastreo, que decide si la salida fue un
// recojo o el retorno, y la recepción de devoluciones, que decide si una caja
// que Shalom dio por recogida se puede recibir.
//
// FALLA CERRADO. Una lectura que falla no es «no hay clave» ni «no pagó»: con
// cualquiera de las dos en falso un recojo se convertiría en retorno. Quien
// llama recibe el error y no escribe nada; el cron lo reintenta en la pasada
// siguiente y el escáner pide volver a escanear.
//
// De la clave solo se pregunta si EXISTE: nunca se lee `key_enc`.

import type { SupabaseClient } from "@supabase/supabase-js";
import { hasCollectionEvidence } from "@/lib/order-macro-stage";
import type { ShalomExitFacts } from "@/lib/shalom/tracking";

export type PickupKeyFacts = Pick<ShalomExitFacts, "hasKey" | "keyGiven">;

export type FactsResult<T> = { ok: true; facts: T } | { ok: false; error: string };

/** Los eventos que prueban que la clave salió de la pantalla hacia alguien. */
const KEY_GIVEN_EVENTS = ["key_view", "key_shared"];

export async function loadPickupKeyFacts(
  admin: SupabaseClient,
  orderId: string,
): Promise<FactsResult<PickupKeyFacts>> {
  const [key, shares, views] = await Promise.all([
    admin.from("shalom_pickup_keys").select("order_id").eq("order_id", orderId).limit(1),
    admin.from("pickup_key_shares").select("id").eq("order_id", orderId).limit(1),
    admin.from("order_events").select("id").eq("order_id", orderId).in("kind", KEY_GIVEN_EVENTS).limit(1),
  ]);
  const failed = [key, shares, views].find((r) => r.error);
  if (failed?.error) return { ok: false, error: `no se pudo leer la clave del pedido: ${failed.error.message}` };
  return {
    ok: true,
    facts: {
      hasKey: (key.data ?? []).length > 0,
      keyGiven: (shares.data ?? []).length > 0 || (views.data ?? []).length > 0,
    },
  };
}

/**
 * La primera vez que esta guía quedó en la agencia: el `disponible_para_recojo`
 * que escribió el rastreo cuando Shalom marcó la llegada. Hace falta porque
 * Shalom mueve esa fecha después (MOM §12).
 *
 * Por guía y no por pedido: un pedido reenviado con otra guía no hereda los
 * días de la primera. Las correcciones manuales (`status_override`) no traen
 * guía, y tampoco son la llegada física.
 */
async function loadFirstArrival(
  admin: SupabaseClient,
  orderId: string,
  guideCode: string | null,
): Promise<FactsResult<string | null>> {
  if (!guideCode) return { ok: true, facts: null };
  const { data, error } = await admin
    .from("order_events")
    .select("occurred_at")
    .eq("order_id", orderId)
    .eq("guide_code", guideCode)
    .eq("new_operational", "disponible_para_recojo")
    .order("occurred_at", { ascending: true })
    .limit(1);
  if (error) return { ok: false, error: `no se pudo leer la llegada a la agencia: ${error.message}` };
  const first = ((data ?? []) as { occurred_at: string | null }[])[0];
  return { ok: true, facts: first?.occurred_at ?? null };
}

export async function loadShalomExitFacts(
  admin: SupabaseClient,
  orderId: string,
  guideCode: string | null,
): Promise<FactsResult<ShalomExitFacts>> {
  const [keys, master, arrival] = await Promise.all([
    loadPickupKeyFacts(admin, orderId),
    admin
      .from("order_master")
      .select("payment_state,financial_status,total_refunded")
      .eq("order_id", orderId)
      .maybeSingle(),
    loadFirstArrival(admin, orderId, guideCode),
  ]);
  if (!keys.ok) return keys;
  if (master.error) return { ok: false, error: `no se pudo leer el cobro del pedido: ${master.error.message}` };
  if (!arrival.ok) return arrival;
  const row = master.data as
    | { payment_state: string | null; financial_status: string | null; total_refunded: number | string | null }
    | null;
  // Sin fila del Master no se sabe si cobró. No se adivina un retorno: se lee
  // como cobrado, que deja el «entregado» de Shalom como hasta ahora.
  const collected = row
    ? hasCollectionEvidence(row.payment_state, {
        financial_status: row.financial_status,
        total_refunded: row.total_refunded == null ? null : Number(row.total_refunded),
      })
    : true;
  return { ok: true, facts: { ...keys.facts, collected, firstArrivalAt: arrival.facts } };
}
