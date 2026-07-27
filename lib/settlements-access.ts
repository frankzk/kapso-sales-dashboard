// Lecturas de las liquidaciones de motorizados, con RLS. El cuadre en sí es
// puro y vive en lib/settlements.ts; aquí solo se traen las filas y se le pasan.
//
// El detalle carga los hechos del Master (`order_master`) de los pedidos que la
// liquidación menciona, y NO al revés: la liquidación consulta al Master, nunca
// lo modifica.

import { createServerSupabase } from "@/lib/db";
import { chunk } from "@/lib/access";
import {
  reconcileSettlement,
  type ReconciledSettlement,
  type SettlementLineInput,
  type SettlementMasterFacts,
} from "@/lib/settlements";
import type { CostTariff } from "@/lib/costs";

export interface RiderRow {
  id: string;
  full_name: string;
  courier: string | null;
  phone: string | null;
  active: boolean;
}

export interface SettlementRow {
  id: string;
  store_id: string;
  rider_id: string | null;
  rider_name_raw: string | null;
  settlement_date: string;
  source: string;
  file_path: string | null;
  declared_cash: number;
  declared_yape: number;
  status: string;
  payout_amount: number | null;
  note: string | null;
  created_at: string;
  closed_at: string | null;
}

const SETTLEMENT_COLUMNS =
  "id,store_id,rider_id,rider_name_raw,settlement_date,source,file_path," +
  "declared_cash,declared_yape,status,payout_amount,note,created_at,closed_at";

const LINE_COLUMNS =
  "id,order_id,guide_code,order_name,declared_status,declared_amount,match_status";

/** Motorizados de las tiendas accesibles, para el desplegable de "¿de quién es
 *  esta hoja?" y para el listado. */
export async function getRiders(): Promise<RiderRow[]> {
  const sb = await createServerSupabase();
  const { data, error } = await sb
    .from("riders")
    .select("id,full_name,courier,phone,active")
    .order("active", { ascending: false })
    .order("full_name");
  if (error) return [];
  return (data ?? []) as unknown as RiderRow[];
}

/** Listado de liquidaciones, de la más reciente a la más antigua. */
export async function getSettlements(
  storeIds: string[],
  opts: { limit?: number } = {},
): Promise<SettlementRow[]> {
  if (!storeIds.length) return [];
  const sb = await createServerSupabase();
  const { data, error } = await sb
    .from("rider_settlements")
    .select(SETTLEMENT_COLUMNS)
    .in("store_id", storeIds)
    .order("settlement_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 200);
  if (error) return [];
  return (data ?? []) as unknown as SettlementRow[];
}

export interface SettlementDetail {
  settlement: SettlementRow;
  reconciled: ReconciledSettlement;
  /** Nombre del pedido por `order_id`, para poder mostrar la línea sin repetir
   *  consultas en el componente. */
  orderNames: Record<string, string>;
}

/**
 * Trae una liquidación con su cuadre ya hecho. Las líneas sin pedido vinculado
 * no traen hechos del Master, y `reconcileSettlement` las deja como "sin
 * pedido" — que es exactamente lo que hay que revisar a mano.
 */
export async function getSettlementDetail(id: string): Promise<SettlementDetail | null> {
  const sb = await createServerSupabase();
  const { data: head } = await sb
    .from("rider_settlements")
    .select(SETTLEMENT_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (!head) return null;
  const settlement = head as unknown as SettlementRow;

  const { data: lineRows } = await sb
    .from("rider_settlement_lines")
    .select(LINE_COLUMNS)
    .eq("settlement_id", id)
    .order("created_at");
  const lines = (lineRows ?? []) as unknown as SettlementLineInput[];

  const orderIds = [...new Set(lines.map((l) => l.order_id).filter((v): v is string => Boolean(v)))];
  const facts = new Map<string, SettlementMasterFacts>();
  const orderNames: Record<string, string> = {};

  for (const batch of chunk(orderIds, 200)) {
    const { data } = await sb
      .from("order_master")
      .select("order_id,order_name,general_status,order_total,current_courier,region,province,district,store_id")
      .in("order_id", batch);
    for (const row of (data ?? []) as unknown as (SettlementMasterFacts & {
      order_name: string | null;
    })[]) {
      facts.set(row.order_id, row);
      if (row.order_name) orderNames[row.order_id] = row.order_name;
    }
  }

  return {
    settlement,
    reconciled: reconcileSettlement(lines, facts, {
      cash: settlement.declared_cash,
      yape: settlement.declared_yape,
    }),
    orderNames,
  };
}

/** Tarifas vigentes de la organización, para calcular el pago al motorizado.
 *  Se traen todas y `resolveTariff` elige: el filtro por fecha y ámbito es puro
 *  y está probado, y así una tarifa vencida sigue explicando un pago viejo. */
export async function getRiderTariffs(): Promise<CostTariff[]> {
  const sb = await createServerSupabase();
  const { data, error } = await sb
    .from("cost_tariffs")
    .select("id,store_id,courier,region,province,district,concept,amount,effective_from,effective_to")
    .in("concept", ["motorizado_entrega", "motorizado_visita", "motorizado_devolucion"]);
  if (error) return [];
  return (data ?? []) as unknown as CostTariff[];
}
