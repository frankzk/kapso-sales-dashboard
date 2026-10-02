import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeUrpiOrder, type UrpiProgrammingData } from "./urpi-programming";

export interface UrpiSource {
  id: string;
  store_id: string;
  spreadsheet_id: string;
  month: string;
  order_prefix: string;
  name: string;
  current_snapshot_id: string | null;
  last_checked_at: string | null;
}

export interface UrpiSnapshot {
  id: string;
  source_id: string;
  created_at: string;
  origin: "google" | "excel";
  filename: string | null;
  row_count: number;
  linked_count: number;
  payload: UrpiProgrammingData;
}

/** Exact code match inside ONE store; duplicate names remain unlinked. */
export async function linkUrpiOrders(admin: SupabaseClient, storeId: string, data: UrpiProgrammingData): Promise<UrpiProgrammingData> {
  const codes = [...new Set(data.rows.map((row) => row.orderCode))];
  const found = new Map<string, Set<string>>();
  for (let i = 0; i < codes.length; i += 100) {
    const names = codes.slice(i, i + 100).flatMap((code) => [`#${code}`, code, `#${code.toLowerCase()}`, code.toLowerCase()]);
    const { data: orders, error } = await admin.from("orders").select("id,name").eq("store_id", storeId).in("name", names).limit(1000);
    if (error) throw new Error("No se pudieron vincular los pedidos. No se guardó una importación parcial.");
    if (orders?.length === 1000) throw new Error("Demasiadas coincidencias de pedidos. Revisa los códigos antes de importar.");
    for (const order of orders ?? []) {
      const code = normalizeUrpiOrder(order.name);
      const ids = found.get(code) ?? new Set<string>();
      ids.add(String(order.id));
      found.set(code, ids);
    }
  }
  return {
    ...data,
    rows: data.rows.map((row) => {
      const ids = [...(found.get(row.orderCode) ?? [])];
      return { ...row, orderId: ids.length === 1 ? ids[0]! : null, issues: [...row.issues, ...(ids.length > 1 ? ["Más de un pedido coincide en Kapta"] : ids.length === 0 ? ["Pedido no encontrado en Kapta"] : [])] };
    }),
  };
}

export async function saveUrpiProgramming(admin: SupabaseClient, source: UrpiSource, data: UrpiProgrammingData, options: {
  actor: string; startedAt: string; origin: "google" | "excel"; filename: string | null;
}): Promise<{ changed: boolean; rows: number; linked: number }> {
  if (source.current_snapshot_id) {
    const { data: previous, error } = await admin.from("urpi_programming_snapshots").select("payload").eq("source_id", source.id).eq("id", source.current_snapshot_id).single();
    if (error) throw new Error("No se pudo verificar la lectura anterior.");
    const oldTabs = (previous.payload as UrpiProgrammingData).tabs;
    if (oldTabs.some((tab) => !data.tabs.some((current) => current.title === tab.title))) {
      throw new Error("Faltan pestañas que existían en la lectura anterior. Carga el libro mensual completo; no se reemplazó la programación.");
    }
  }
  const payload = await linkUrpiOrders(admin, source.store_id, data);
  const linked = payload.rows.filter((row) => row.orderId).length;
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const { data: result, error } = await admin.rpc("save_urpi_programming_snapshot", {
    p_source_id: source.id, p_actor: options.actor, p_started_at: options.startedAt,
    p_digest: digest, p_payload: payload, p_origin: options.origin, p_filename: options.filename,
  });
  if (error) throw new Error(error.message.includes("newer_import") ? "Otra importación más reciente terminó primero. Vuelve a actualizar." : error.message.includes("missing_tabs") ? "Faltan pestañas de la última versión. No se reemplazó la programación." : "No se pudo guardar la programación. La versión anterior se conserva.");
  return { changed: result === true, rows: payload.rows.length, linked };
}
