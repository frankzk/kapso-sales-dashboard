import "server-only";

// Subir a GF un SKU que le falta (owner, 26-11-2026, #KP201969: «el shampoo de cebolla de kenku.pe no está en GF
// courier… sí, así automatizamos»; MOM §29.17). Lo usa la creación de la guía cuando GF responde SKU_NOT_FOUND: un
// solo producto, por el mismo POST /v1/products/batch de la sincronización de cada hora (permiso catalogue:write).
// GF lo crea «En existencias» y sin conteo; nunca borra ni cambia el modo o el conteo de lo que ya tenía.
import { createHash } from "node:crypto";
import { gfCourier } from "@/lib/gf-courier";
import type { GfSyncItem } from "@/lib/gf-courier-catalog";

export const GF_CATALOGUE_WRITE_MISSING =
  "Al token de GF de la tienda le falta el permiso catalogue:write: en GF → Comercios → la tienda → Conexión, crea una credencial con «Sincronizar su catálogo desde su sistema» y pégala en Configuración → GF Courier.";

export type GfSkuUpload = { ok: true; status: "created" | "updated" | "unchanged" } | { ok: false; error: string };

export async function uploadGfSku(apiToken: string, item: GfSyncItem): Promise<GfSkuUpload> {
  // La misma subida reintenta con la misma clave: GF devuelve el mismo resultado sin volver a aplicarla.
  const key = `KP-SKU-${createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 40)}`;
  const r = await gfCourier.productsBatch({ apiToken, timeoutMs: 20_000 }, [item], key);
  if (!r.ok) return { ok: false, error: r.status === 403 ? GF_CATALOGUE_WRITE_MISSING : r.error.message };
  const result = r.data.results?.[0];
  if (!result) return { ok: false, error: "GF no devolvió el resultado de la subida del producto." };
  if (result.status === "error") return { ok: false, error: result.error?.message ?? "GF no aceptó el producto." };
  return { ok: true, status: result.status };
}
