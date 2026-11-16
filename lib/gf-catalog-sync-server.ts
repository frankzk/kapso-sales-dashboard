import "server-only";

// Catálogo sincronizado con GF Courier (MOM §29.17, owner 16-11-2026). Lee el catálogo vivo de la tienda y su
// catálogo en GF, arma el plan (lib/gf-courier-catalog.ts, puro) y lo manda a POST /v1/products/batch en lotes de
// 200. Corre cada hora (cron gf-catalog-sync) y con «Sincronizar ahora» en Configuración → GF Courier.
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { gfCourier } from "@/lib/gf-courier";
import { loadGfStore } from "@/lib/gf-courier-guide";
import { loadGfProducts, loadStoreCatalogForGf } from "@/lib/gf-courier-catalog-server";
import { gfSyncBatches, planGfCatalogSync } from "@/lib/gf-courier-catalog";

export interface GfCatalogSyncReport {
  ok: boolean;
  storeId: string;
  /** Falta catalogue:write, no hay token o falló la lectura: no se mandó nada. */
  error?: string;
  storeSkus: number;
  created: number;
  updated: number;
  unchanged: number;
  discontinued: number;
  discontinueSkipped: string | null;
  withoutSku: number;
  repeatedSkus: string[];
  errors: { sku: string; message: string }[];
  dry: boolean;
}

const empty = (storeId: string, dry: boolean, error?: string): GfCatalogSyncReport =>
  ({ ok: !error, storeId, error, storeSkus: 0, created: 0, updated: 0, unchanged: 0, discontinued: 0, discontinueSkipped: null, withoutSku: 0, repeatedSkus: [], errors: [], dry });

export async function syncGfCatalog(admin: SupabaseClient, storeId: string, opts: { dry?: boolean } = {}): Promise<GfCatalogSyncReport> {
  const dry = Boolean(opts.dry);
  const store = await loadGfStore(admin, storeId);
  if (!store?.token) return empty(storeId, dry, "Esta tienda no tiene token de GF Courier.");
  const me = await gfCourier.me({ apiToken: store.token });
  if (!me.ok) return empty(storeId, dry, `GF Courier respondió: ${me.error.message}`);
  if (!me.data.permissions.includes("catalogue:write"))
    return empty(storeId, dry, "Al token le falta el permiso catalogue:write. En GF → Comercios → ficha → Conexión, crea una credencial con «Sincronizar su catálogo desde su sistema» y pégala aquí.");
  const [local, gf] = await Promise.all([loadStoreCatalogForGf(admin, storeId), loadGfProducts(store.token)]);
  if (!gf.ok) return empty(storeId, dry, `GF Courier respondió: ${gf.message}`);
  if (!local.rows.length) return empty(storeId, dry, `No se pudo leer el catálogo de la tienda${local.problems.length ? `: ${local.problems.join(" ")}` : "."}`);
  const plan = planGfCatalogSync(local.rows, gf.products, { partial: local.problems.length > 0 });
  const report: GfCatalogSyncReport = { ...empty(storeId, dry), storeSkus: local.rows.length, discontinueSkipped: plan.discontinueSkipped,
    withoutSku: local.withoutSku.length, repeatedSkus: local.repeatedSkus };
  if (dry) {
    report.created = plan.create.length; report.updated = plan.rename.length; report.discontinued = plan.discontinue.length;
    return report;
  }
  const discontinuing = new Set(plan.discontinue.map((i) => i.sku));
  for (const batch of gfSyncBatches(plan)) {
    // La misma tanda reintenta con la misma clave: GF devuelve el mismo resultado sin volver a aplicarla.
    const key = `KP-CAT-${storeId.slice(0, 8)}-${createHash("sha256").update(JSON.stringify(batch)).digest("hex").slice(0, 40)}`;
    const r = await gfCourier.productsBatch({ apiToken: store.token, timeoutMs: 60_000 }, batch, key);
    if (!r.ok) { report.ok = false; report.errors.push(...batch.map((i) => ({ sku: i.sku, message: r.error.message }))); continue; }
    for (const res of r.data.results ?? []) {
      if (res.status === "error") report.errors.push({ sku: res.sku, message: res.error?.message ?? "Error en GF." });
      else if (res.status === "created") report.created++;
      else if (res.status === "updated") { if (discontinuing.has(res.sku)) report.discontinued++; else report.updated++; }
      else report.unchanged++;
    }
  }
  if (report.errors.length) report.ok = false;
  return report;
}

/** Una línea legible del resultado, para el botón y el registro del cron. */
export function describeGfCatalogSync(r: GfCatalogSyncReport): string {
  if (r.error) return r.error;
  const parts = [
    `${r.dry ? "Habría que crear" : "Creados"} ${r.created}`, `${r.dry ? "renombrar" : "actualizados"} ${r.updated}`,
    `${r.dry ? "agotar" : "pasados a Agotado"} ${r.discontinued}`,
  ];
  const tail = [
    r.discontinueSkipped,
    r.errors.length ? `${r.errors.length} con error: ${r.errors.slice(0, 5).map((e) => `${e.sku} (${e.message})`).join("; ")}${r.errors.length > 5 ? "…" : ""}` : "",
    r.withoutSku ? `${r.withoutSku} variantes sin SKU no se pueden subir: ponles SKU en la tienda.` : "",
    r.repeatedSkus.length ? `SKU repetido en dos variantes: ${r.repeatedSkus.slice(0, 5).join(", ")}.` : "",
  ].filter(Boolean).join(" ");
  return `Catálogo de ${r.storeSkus} SKU sincronizado con GF: ${parts.join(", ")}.${tail ? ` ${tail}` : ""}`;
}
