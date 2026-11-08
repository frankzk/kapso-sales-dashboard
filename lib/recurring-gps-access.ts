import "server-only";

// Carga de «Usar este GPS» (lib/recurring-gps.ts, MOM §6.1): los otros pedidos
// del mismo celular en la organización y sus guías, en dos consultas. Lee con
// el cliente que le pasen —la sesión de la asesora, con su RLS—, acotado a las
// tiendas de la organización del pedido para que un celular no cruce de
// organización.

import type { SupabaseClient } from "@supabase/supabase-js";
import { aliclikReadScopeFor } from "@/lib/aliclik-guide";
import {
  recurringGpsCandidates,
  type RecurringGpsCandidate,
  type RecurringGpsPrior,
  type RecurringGpsShipment,
} from "@/lib/recurring-gps";
import type { OrderMasterRow } from "@/lib/types";

const PRIOR_COLUMNS =
  "order_id,order_name,order_created_at,general_status,dispatched_at,attempt_count,delivered_at,address,district,province";
const SHIPMENT_COLUMNS = "order_id,courier,delivery_status,latitude,longitude,closed_at,returned_at,reported_status,created_at";

export async function loadRecurringGpsCandidates(
  sb: SupabaseClient,
  admin: SupabaseClient,
  row: Pick<OrderMasterRow, "order_id" | "store_id" | "customer_phone" | "address" | "district" | "province">,
): Promise<{ candidates: RecurringGpsCandidate[]; error?: string }> {
  const phone = (row.customer_phone ?? "").trim();
  if (!phone) return { candidates: [] };
  const { scope, error: scopeError } = await aliclikReadScopeFor(admin, row.store_id);
  if (!scope) return { candidates: [], error: scopeError };
  const { data: priors, error } = await sb
    .from("order_master")
    .select(PRIOR_COLUMNS)
    .eq("customer_phone", phone)
    .in("store_id", scope.storeIds)
    .neq("order_id", row.order_id)
    .eq("general_status", "entregado")
    .order("order_created_at", { ascending: false })
    .limit(50);
  if (error) return { candidates: [], error: error.message };
  const list = (priors ?? []) as unknown as RecurringGpsPrior[];
  if (!list.length) return { candidates: [] };
  const { data: guides, error: gError } = await sb
    .from("shipments")
    .select(SHIPMENT_COLUMNS)
    .in("order_id", list.map((p) => p.order_id));
  // Sin las guías no se sabe si hubo un fallido: no se propone nada.
  if (gError) return { candidates: [], error: gError.message };
  return {
    candidates: recurringGpsCandidates({
      order: row,
      priors: list,
      shipments: (guides ?? []) as unknown as RecurringGpsShipment[],
    }),
  };
}
