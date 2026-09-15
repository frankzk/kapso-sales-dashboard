import type { SupabaseClient } from "@supabase/supabase-js";
import { shopifyGraphQL, type ShopifyClientOpts } from "./shopify";

/**
 * EL ESPEJO DE LA FOTO DE CATÁLOGO.
 *
 * Shopify no manda imagen en el line item de un pedido —0 de 15.726 ítems
 * medidos el 14-09-2026—, así que el desglose de productos dibujaba el hueco de
 * una miniatura que nadie podía llenar. Esto lo llena.
 *
 * Se espeja en vez de pedirla en vivo por una razón de tamaño: en 180 días los
 * pedidos citan **331 productos distintos** sobre 21.789 ítems. Es un catálogo
 * diminuto, que cambia poco, leído desde una pantalla que se abre cientos de
 * veces al día. Pedirla al abrir el cajón sería una llamada de red por apertura
 * —con su latencia y su modo de fallo— para releer 331 valores casi siempre
 * iguales.
 *
 * QUÉ SE SINCRONIZA: los productos que los PEDIDOS citan, no el catálogo
 * entero. Un catálogo puede tener miles de productos que nunca se vendieron, y
 * de esos no hay ningún pedido que mostrar. La lista sale de
 * `orders.line_items`, que es exactamente el conjunto que la pantalla puede
 * llegar a pedir.
 */

/** Ventana de pedidos de la que se saca la lista de productos a espejar. */
export const IMAGE_SYNC_WINDOW_DAYS = 180;

/**
 * Cada cuánto se vuelve a preguntar por un producto ya espejado.
 *
 * Una foto de catálogo cambia cuando alguien reemplaza la imagen del producto,
 * que en esta operación pasa muy de vez en cuando. Siete días es suficiente
 * para no mostrar una foto vieja durante semanas y bastante para que la pasada
 * diaria casi siempre no tenga nada que hacer.
 */
export const IMAGE_TTL_DAYS = 7;

/** Cuántos ids se piden por consulta. Shopify admite `nodes` en lote. */
const BATCH = 50;

export interface ProductImageSyncReport {
  ok: boolean;
  /** Productos citados por pedidos dentro de la ventana. */
  citados: number;
  /** De esos, los que hacía falta preguntar (nuevos o vencidos). */
  pedidos_a_shopify: number;
  /** Filas escritas, con imagen o sin ella. */
  guardados: number;
  /** Los que Shopify no devolvió: producto borrado del catálogo. */
  no_encontrados: number;
  error?: string;
}

const QUERY = `
  query ProductImages($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        featuredImage { url altText }
      }
    }
  }
`;

/** El id numérico del pedido → el `gid` que entiende GraphQL. */
export function productGid(productId: string): string {
  return `gid://shopify/Product/${productId}`;
}

/** El camino inverso: del `gid` de la respuesta al id numérico que guardamos. */
export function productIdFromGid(gid: string): string {
  const i = gid.lastIndexOf("/");
  return i === -1 ? gid : gid.slice(i + 1);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Los productos que los pedidos de una tienda citan dentro de la ventana.
 *
 * Se lee en TypeScript y no en SQL porque `line_items` es JSON y la consulta
 * equivalente con `jsonb_array_elements` no pasa por PostgREST. Son pocas filas
 * y solo se recorren una vez al día.
 */
export async function citedProductIds(
  storeId: string,
  admin: SupabaseClient,
  windowDays = IMAGE_SYNC_WINDOW_DAYS,
): Promise<string[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const ids = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("orders")
      .select("line_items")
      .eq("store_id", storeId)
      .gte("created_at", since)
      .range(from, from + PAGE - 1);
    if (error) break;
    const rows = (data ?? []) as { line_items?: unknown }[];
    for (const row of rows) {
      if (!Array.isArray(row.line_items)) continue;
      for (const item of row.line_items as { product_id?: unknown }[]) {
        const pid = item?.product_id;
        if (pid == null) continue;
        const s = String(pid).trim();
        // Los ids llegan numéricos desde la API REST. Si alguna vez llegara un
        // `gid`, se normaliza acá y no en la tabla.
        if (s) ids.add(s.startsWith("gid://") ? productIdFromGid(s) : s);
      }
    }
    if (rows.length < PAGE) break;
  }
  return [...ids];
}

/**
 * Sincroniza las fotos de los productos que esta tienda vendió.
 *
 * Best-effort por lote: si una consulta a Shopify falla, las demás siguen. Una
 * foto que falta degrada a la inicial del producto en la pantalla, que es
 * exactamente lo que se mostraba antes de que esto existiera.
 */
export async function syncShopifyProductImages(
  storeId: string,
  shopify: ShopifyClientOpts,
  admin: SupabaseClient,
  opts: { ttlDays?: number; windowDays?: number } = {},
): Promise<ProductImageSyncReport> {
  const ttlDays = opts.ttlDays ?? IMAGE_TTL_DAYS;
  const citados = await citedProductIds(storeId, admin, opts.windowDays);
  if (!citados.length) {
    return { ok: true, citados: 0, pedidos_a_shopify: 0, guardados: 0, no_encontrados: 0 };
  }

  // Lo ya espejado y todavía fresco no se vuelve a preguntar.
  const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const frescos = new Set<string>();
  for (const part of chunk(citados, 500)) {
    const { data } = await admin
      .from("shopify_product_images")
      .select("product_id")
      .eq("store_id", storeId)
      .gte("synced_at", cutoff)
      .in("product_id", part);
    for (const r of (data ?? []) as { product_id: string }[]) frescos.add(r.product_id);
  }

  const pendientes = citados.filter((id) => !frescos.has(id));
  let guardados = 0;
  let noEncontrados = 0;

  for (const part of chunk(pendientes, BATCH)) {
    let nodes: unknown[] = [];
    try {
      const data = await shopifyGraphQL<{ nodes?: unknown[] }>({
        ...shopify,
        query: QUERY,
        variables: { ids: part.map(productGid) },
      });
      nodes = data?.nodes ?? [];
    } catch {
      // Un lote caído no cancela la pasada: la próxima lo reintenta porque
      // sigue sin fila, o con una vencida.
      continue;
    }

    const filas: {
      store_id: string;
      product_id: string;
      image_url: string | null;
      image_alt: string | null;
      catalog_title: string | null;
      synced_at: string;
    }[] = [];
    const now = new Date().toISOString();

    for (const node of nodes) {
      // `nodes` devuelve null en la posición de un id que ya no existe: el
      // producto se borró del catálogo. No es un error y no se reintenta cada
      // día — se registra sin imagen y el TTL decidirá cuándo volver a mirar.
      if (!node || typeof node !== "object") {
        noEncontrados += 1;
        continue;
      }
      const p = node as { id?: unknown; title?: unknown; featuredImage?: unknown };
      const gid = typeof p.id === "string" ? p.id : "";
      if (!gid) {
        noEncontrados += 1;
        continue;
      }
      const img = p.featuredImage as { url?: unknown; altText?: unknown } | null | undefined;
      filas.push({
        store_id: storeId,
        product_id: productIdFromGid(gid),
        image_url: typeof img?.url === "string" ? img.url : null,
        image_alt: typeof img?.altText === "string" ? img.altText : null,
        catalog_title: typeof p.title === "string" ? p.title : null,
        synced_at: now,
      });
    }

    if (filas.length) {
      const { error } = await admin
        .from("shopify_product_images")
        .upsert(filas, { onConflict: "store_id,product_id" });
      if (!error) guardados += filas.length;
    }
  }

  return {
    ok: true,
    citados: citados.length,
    pedidos_a_shopify: pendientes.length,
    guardados,
    no_encontrados: noEncontrados,
  };
}

/** Las fotos de un puñado de productos, para armar el desglose de un pedido. */
export async function productImagesFor(
  sb: SupabaseClient,
  storeId: string,
  productIds: (string | null | undefined)[],
): Promise<Map<string, string>> {
  const ids = [...new Set(productIds.filter((id): id is string => !!id))];
  if (!ids.length) return new Map();
  const { data, error } = await sb
    .from("shopify_product_images")
    .select("product_id,image_url")
    .eq("store_id", storeId)
    .in("product_id", ids);
  // Sin espejo, la pantalla degrada a la inicial del producto. No es un fallo
  // que merezca romper la carga de un pedido.
  if (error) return new Map();
  const out = new Map<string, string>();
  for (const r of (data ?? []) as { product_id: string; image_url: string | null }[]) {
    if (r.image_url) out.set(r.product_id, r.image_url);
  }
  return out;
}
