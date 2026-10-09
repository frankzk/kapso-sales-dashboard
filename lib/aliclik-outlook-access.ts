// Lectura de la entrega estimada de Aliclik para la ficha (09-10-2026). La
// decisión es pura y vive en lib/aliclik-outlook.ts; aquí solo el acceso.
//
// Las tasas cambian despacio (ventana de 70 a 14 días atrás), y la ficha se
// abre muchas veces seguidas: se guardan media hora por usuario. Por usuario y
// no global, porque la función corre con RLS y cada quien ve sus tiendas.

import type { createServerSupabase } from "@/lib/db";
import { getCurrentUser } from "@/lib/access";
import { COURIER_TBD } from "@/lib/shipment-output";
import {
  buildAliclikOutlook,
  orderAgeDays,
  type AliclikAgeRateRow,
  type AliclikOutlook,
} from "@/lib/aliclik-outlook";

const TTL_MS = 30 * 60_000;
const memo = new Map<string, { at: number; rows: AliclikAgeRateRow[] }>();

async function ageRates(sb: Awaited<ReturnType<typeof createServerSupabase>>, now: number): Promise<AliclikAgeRateRow[]> {
  const user = await getCurrentUser();
  const key = user?.id ?? "";
  const hit = key ? memo.get(key) : undefined;
  if (hit && now - hit.at < TTL_MS) return hit.rows;
  const { data, error } = await sb.rpc("aliclik_delivery_by_order_age");
  if (error) {
    // Antes de la migración 0236, o si falla: la ficha sale sin el aviso.
    console.error("[aliclik-outlook]", error.message);
    return [];
  }
  const rows = (data ?? []) as AliclikAgeRateRow[];
  if (key) memo.set(key, { at: now, rows });
  return rows;
}

/**
 * La entrega estimada si la guía de Aliclik se crea hoy. Solo para la primera
 * guía del pedido —las cifras son de primeras guías; un reenvío es otra
 * historia— y null si no hay muestra suficiente.
 */
export async function loadAliclikOutlook(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  row: { store_id: string | null; order_created_at: string | null },
  guides: readonly { courier: string | null }[],
  now: Date = new Date(),
): Promise<AliclikOutlook | null> {
  if (!row.store_id || !row.order_created_at) return null;
  if (guides.some((g) => g.courier && g.courier !== COURIER_TBD)) return null;
  const age = orderAgeDays(row.order_created_at, now);
  if (age == null) return null;
  const rows = await ageRates(sb, now.getTime());
  return buildAliclikOutlook(rows, row.store_id, age);
}
