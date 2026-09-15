// El mapa SKU de Shopify → codbar de Swayp, leído por ORGANIZACIÓN.
//
// POR QUÉ NO POR TIENDA, QUE ES COMO SE GUARDA. La tabla tiene clave
// `(store_id, shopify_sku)` porque el catálogo se gestiona desde una tienda,
// pero el codbar es un hecho del producto EN SWAYP: el mismo frasco tiene el
// mismo código lo venda Aurela o Kenku Peru, que son la misma organización y
// despachan de la misma bodega. Leerlo acotado a una tienda convertía ese dato
// compartido en dos datos privados.
//
// LO QUE COSTÓ, EL 15-09-2026. De los 19 productos vinculados, 18 estaban bajo
// Kenku Peru y uno bajo Aurela. Cualquier pedido de Aurela de esos 18 —con el
// codbar ya conocido y escrito— moría en la reja «Falta vincular a Swayp» y
// salía con código manual. El importador de inventario YA leía por organización
// («el stock es de la organización, no de una tienda»), así que las dos mitades
// del mismo sistema no coincidían.
//
// Las escrituras siguen siendo por tienda —es donde el usuario está parado—,
// pero desvincular borra en toda la organización: si no, quitar el vínculo en
// una tienda lo dejaba vivo por la otra y la pantalla mentiría.

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeSku } from "@/lib/swayp-productos";

export interface FilaMapaSwayp {
  store_id: string;
  shopify_sku: string;
  codbar: string;
  nombre: string | null;
  updated_at?: string | null;
}

export interface VinculoSwayp {
  codbar: string;
  nombre: string | null;
  /** La tienda donde está escrito el vínculo, para poder decirlo en pantalla. */
  storeId: string;
}

/**
 * Con qué fila se queda cada SKU cuando varias tiendas lo tienen escrito.
 *
 * La propia tienda manda: si alguien corrigió el codbar ahí, esa corrección es
 * la que se estaba mirando. Si no la hay, gana la más reciente, y a igualdad de
 * fecha el codbar menor — no para que sea «el correcto», sino para que la
 * respuesta no cambie entre dos lecturas de los mismos datos. Dos codbar
 * distintos para un SKU son un error de captura que hay que ver, y por eso
 * `conflictosDeCodbar` los devuelve en vez de esconderlos.
 *
 * Pura, para poder probarla sin base.
 */
export function unVinculoPorSku(
  filas: FilaMapaSwayp[],
  storeIdPropio: string,
): Map<string, VinculoSwayp> {
  const out = new Map<string, VinculoSwayp>();
  const elegidas = new Map<string, FilaMapaSwayp>();
  for (const fila of filas) {
    const sku = normalizeSku(fila.shopify_sku);
    if (!sku || !fila.codbar) continue;
    const previa = elegidas.get(sku);
    if (!previa || ganaSobre(fila, previa, storeIdPropio)) elegidas.set(sku, fila);
  }
  for (const [sku, fila] of elegidas) {
    out.set(sku, { codbar: fila.codbar, nombre: fila.nombre, storeId: fila.store_id });
  }
  return out;
}

function ganaSobre(
  candidata: FilaMapaSwayp,
  actual: FilaMapaSwayp,
  storeIdPropio: string,
): boolean {
  const propiaCandidata = candidata.store_id === storeIdPropio;
  const propiaActual = actual.store_id === storeIdPropio;
  if (propiaCandidata !== propiaActual) return propiaCandidata;
  const fechaCandidata = candidata.updated_at ?? "";
  const fechaActual = actual.updated_at ?? "";
  if (fechaCandidata !== fechaActual) return fechaCandidata > fechaActual;
  return candidata.codbar < actual.codbar;
}

/**
 * Los SKU que dos tiendas de la misma organización mandaron a codbar distintos.
 *
 * No bloquea nada: la guía sale igual con el vínculo elegido arriba, porque
 * negarla dejaría el pedido parado por un dato que alguien puede arreglar en
 * dos minutos. Existe para poder enseñarlo en el catálogo en vez de que la
 * discrepancia viva callada.
 */
export function conflictosDeCodbar(filas: FilaMapaSwayp[]): Map<string, string[]> {
  const porSku = new Map<string, Set<string>>();
  for (const fila of filas) {
    const sku = normalizeSku(fila.shopify_sku);
    if (!sku || !fila.codbar) continue;
    const set = porSku.get(sku) ?? new Set<string>();
    set.add(fila.codbar.toUpperCase());
    porSku.set(sku, set);
  }
  const out = new Map<string, string[]>();
  for (const [sku, set] of porSku) {
    if (set.size > 1) out.set(sku, Array.from(set).sort());
  }
  return out;
}

/** Los ids de las tiendas de la misma organización que `storeId`, ella incluida. */
export async function tiendasDeLaOrg(
  admin: SupabaseClient,
  storeId: string,
): Promise<string[]> {
  const { data: propia } = await admin
    .from("stores")
    .select("org_id")
    .eq("id", storeId)
    .maybeSingle();
  const orgId = (propia as { org_id?: string } | null)?.org_id;
  // Sin organización no se inventa un alcance mayor: se lee la tienda y ya.
  if (!orgId) return [storeId];
  const { data: hermanas } = await admin.from("stores").select("id").eq("org_id", orgId);
  const ids = ((hermanas as { id: string }[]) ?? []).map((s) => s.id);
  return ids.includes(storeId) ? ids : [...ids, storeId];
}

async function filasDeTiendas(
  admin: SupabaseClient,
  storeIds: string[],
): Promise<FilaMapaSwayp[]> {
  if (!storeIds.length) return [];
  const { data, error } = await admin
    .from("swayp_sku_map")
    .select("store_id,shopify_sku,codbar,nombre,updated_at")
    .in("store_id", storeIds);
  if (error) {
    // No conseguir el dato no tumba una operación viva: la guía sale sin
    // `productos`, que es la conducta que ya había. Pero se deja dicho.
    console.error("[swayp] no se pudo leer swayp_sku_map:", error.message);
    return [];
  }
  return ((data as FilaMapaSwayp[]) ?? []);
}

/** Las filas del mapa de toda la organización a la que pertenece `storeId`. */
export async function filasDelMapaSwayp(
  admin: SupabaseClient,
  storeId: string,
): Promise<FilaMapaSwayp[]> {
  return filasDeTiendas(admin, await tiendasDeLaOrg(admin, storeId));
}

/** El mapa listo para usar: SKU normalizado → vínculo. */
export async function cargarMapaSwayp(
  admin: SupabaseClient,
  storeId: string,
): Promise<Map<string, VinculoSwayp>> {
  return unVinculoPorSku(await filasDelMapaSwayp(admin, storeId), storeId);
}

/**
 * El mismo mapa entrando por la organización, para quien no está parado en una
 * tienda — el importador de inventario trabaja sobre el stock de la org.
 * Sin tienda propia no hay desempate por «la mía»; queda el de fecha.
 */
export async function cargarMapaSwaypDeOrg(
  admin: SupabaseClient,
  orgId: string,
): Promise<Map<string, VinculoSwayp>> {
  const { data } = await admin.from("stores").select("id").eq("org_id", orgId);
  const storeIds = ((data as { id: string }[]) ?? []).map((s) => s.id);
  return unVinculoPorSku(await filasDeTiendas(admin, storeIds), "");
}
