// Catálogo de Aliclik: espejo local, mapeo SKU→EAN y el resolutor que decide si
// un pedido es creable.
//
// La parte que importa (`resolveAliclikItems`) es PURA y está testeada: es la
// que contesta "¿este pedido se puede crear en Aliclik, y si no, por qué?".
// Contestar eso ANTES de llamar a la API es lo que permite mostrar una cola de
// trabajo — y no descubrir el problema con un 400 delante de la clienta.
//
// Reglas que impone Aliclik y que aquí se comprueban en local:
//   * `products[].ean` debe existir en SU catálogo.
//   * Todos los productos del pedido, del MISMO almacén (varios almacenes son
//     pedidos independientes).
//   * Agencia: solo SKUs marcados como despachables por Shalom, con stock, y
//     un máximo de 6 unidades en total.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { pickOperationalWarehouse } from "@/lib/aliclik-warehouse";
import {
  listAgencies,
  listAllProducts,
  listPackageSizes,
  type AliclikClientOpts,
  type AliclikProduct,
} from "@/lib/aliclik";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Una fila del espejo del catálogo (subconjunto que usa el resolutor). */
export interface AliclikSkuRow {
  ean: string;
  sku: string | null;
  product_name: string | null;
  stock_virtual: number | null;
  warehouse_id: number | null;
  warehouse_name: string | null;
  format_time_agency: string | null;
  shalom_origin_in: string | null;
  is_agency_eligible: boolean;
}

export interface AliclikSkuMapRow {
  shopify_sku: string;
  ean: string;
}

/** Lo que el resolutor necesita de cada línea del pedido. */
export interface OrderLineInput {
  title: string | null;
  sku: string | null;
  quantity: number;
  price: number | null;
}

export interface ResolvedItem {
  ean: string;
  quantity: number;
  price: number;
  title: string | null;
  stockVirtual: number | null;
}

export type ResolveBlockerKind =
  | "sin_lineas"
  | "sin_sku"
  | "sku_sin_mapeo"
  | "ean_desconocido"
  | "multi_almacen"
  | "sin_almacen"
  | "no_apto_agencia"
  | "sin_stock"
  | "max_6_unidades"
  | "precio_invalido";

export interface ResolveBlocker {
  kind: ResolveBlockerKind;
  /** Mensaje listo para enseñar. En español, concreto, con los productos. */
  message: string;
  /** Los títulos/SKUs implicados, para poder señalarlos en la interfaz. */
  offenders: string[];
}

export type ResolveResult =
  | {
      ok: true;
      warehouseId: number;
      warehouseName: string | null;
      items: ResolvedItem[];
      /** Hora de corte del almacén (solo relevante en agencia). */
      formatTimeAgency: string | null;
      /** Avisos que NO bloquean (p. ej. stock justo en contraentrega). */
      warnings: string[];
    }
  | { ok: false; blocker: ResolveBlocker };

/** Máximo de unidades por pedido de agencia, impuesto por Aliclik. */
export const AGENCY_MAX_UNITS = 6;

/**
 * Normaliza un SKU para comparar. Sin esto "ABC ", "abc" y "ABC" serían tres
 * productos distintos, y el mapeo se llenaría de duplicados invisibles.
 */
export function normalizeSku(raw: string | null | undefined): string {
  return (raw ?? "").trim().toUpperCase();
}

/**
 * Sufijo de tienda que Aliclik añade al nombre de cada producto de la cuenta,
 * p. ej. "… (30 mL) - AUR5X". No es parte del producto: es la marca del
 * proveedor dentro de su catálogo.
 */
const STORE_SUFFIX_RE = /\s*[-–—]\s*AUR\d?X?[A-Z0-9]*\s*$/i;

/**
 * Normaliza el NOMBRE de un producto para poder emparejar Shopify con Aliclik.
 *
 * POR QUÉ HACE FALTA. Los SKUs de las dos plataformas no tienen nada que ver
 * (Shopify usa numéricos como "818531465", Aliclik códigos como "SXOW1"), así
 * que emparejar por SKU no encuentra nada. El nombre, en cambio, es casi
 * idéntico — Aliclik solo le añade el sufijo de tienda:
 *
 *   Shopify: "FEEL VIRGIN – Gel Íntimo … (30 mL)"
 *   Aliclik: "FEEL VIRGIN – Gel Íntimo … (30 mL) - AUR5X"
 *
 * Se neutraliza todo lo que varía sin cambiar el producto: el sufijo, los
 * símbolos ™/® (158 de los 337 productos los llevan), los acentos, los guiones
 * de distinto tipo y los espacios de más.
 *
 * NO es una coincidencia difusa: tras normalizar se exige igualdad exacta. Un
 * emparejamiento por parecido podría mandar el producto equivocado a una
 * clienta, y eso es peor que dejarlo sin mapear.
 */
export function normalizeProductName(raw: string | null | undefined): string {
  return (raw ?? "")
    .replace(STORE_SUFFIX_RE, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // acentos
    .replace(/[™®©]/g, "")
    .replace(/[–—]/g, "-") // guion largo → corto
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function label(line: { title: string | null; sku: string | null }): string {
  return line.title?.trim() || line.sku?.trim() || "(sin nombre)";
}

// ---------------------------------------------------------------------------
// El resolutor
// ---------------------------------------------------------------------------

/**
 * ¿Es creable este pedido en Aliclik? Devuelve los items listos para el body, o
 * el primer bloqueo encontrado con un mensaje accionable.
 *
 * El orden de comprobación no es casual: va de lo más barato de arreglar (falta
 * mapear un SKU) a lo más estructural (los productos son de almacenes distintos
 * y hay que partir el pedido), para que el mensaje que ve la operadora sea el
 * de la acción más útil.
 */
export function resolveAliclikItems(
  lines: readonly OrderLineInput[],
  mapping: readonly AliclikSkuMapRow[],
  skus: readonly AliclikSkuRow[],
  opts: { modality: "cod" | "agency" },
): ResolveResult {
  const real = lines.filter((l) => (l.quantity ?? 0) > 0);
  if (!real.length) {
    return {
      ok: false,
      blocker: { kind: "sin_lineas", message: "El pedido no tiene productos.", offenders: [] },
    };
  }

  const bySku = new Map(mapping.map((m) => [normalizeSku(m.shopify_sku), m.ean]));
  const mappedEans = new Set(mapping.map((m) => m.ean));
  const operationalWarehouseId = pickOperationalWarehouse(skus, mappedEans);
  const byEan = new Map<string, AliclikSkuRow[]>();
  for (const row of skus) {
    const rows = byEan.get(row.ean) ?? [];
    rows.push(row);
    byEan.set(row.ean, rows);
  }

  // El mismo EAN puede existir en varios almacenes. Se prioriza el almacén
  // operativo de la tienda y se deja un desempate estable para no depender del
  // orden arbitrario de Postgres.
  const pickSkuRow = (ean: string): AliclikSkuRow | null => {
    const rows = byEan.get(ean) ?? [];
    const eligible =
      opts.modality === "agency" ? rows.filter((row) => row.is_agency_eligible) : rows;
    const candidates = eligible.length ? eligible : rows;
    return (
      candidates
        .slice()
        .sort((a, b) => {
          const aPreferred = a.warehouse_id === operationalWarehouseId ? 1 : 0;
          const bPreferred = b.warehouse_id === operationalWarehouseId ? 1 : 0;
          if (aPreferred !== bPreferred) return bPreferred - aPreferred;
          return (a.warehouse_id ?? Number.MAX_SAFE_INTEGER) -
            (b.warehouse_id ?? Number.MAX_SAFE_INTEGER);
        })[0] ?? null
    );
  };

  // 1. ¿Todas las líneas traen SKU?
  const noSku = real.filter((l) => !normalizeSku(l.sku));
  if (noSku.length) {
    return {
      ok: false,
      blocker: {
        kind: "sin_sku",
        message:
          "Hay productos sin SKU en Shopify, así que no se pueden identificar en Aliclik. Corrige el SKU en el producto de Shopify.",
        offenders: noSku.map(label),
      },
    };
  }

  // 2. ¿Están todos mapeados a un EAN?
  const unmapped = real.filter((l) => !bySku.has(normalizeSku(l.sku)));
  if (unmapped.length) {
    return {
      ok: false,
      blocker: {
        kind: "sku_sin_mapeo",
        message:
          "Estos SKUs todavía no están asociados a un producto de Aliclik. Mapéalos en Envíos → Catálogo Aliclik.",
        offenders: unmapped.map((l) => `${label(l)} (${normalizeSku(l.sku)})`),
      },
    };
  }

  // 3. ¿El EAN mapeado sigue existiendo en el catálogo?
  const resolved = real.map((l) => {
    const ean = bySku.get(normalizeSku(l.sku))!;
    return { line: l, ean, sku: pickSkuRow(ean) };
  });
  const unknown = resolved.filter((r) => !r.sku);
  if (unknown.length) {
    return {
      ok: false,
      blocker: {
        kind: "ean_desconocido",
        message:
          "Estos productos están mapeados a un EAN que ya no aparece en el catálogo de Aliclik. Vuelve a sincronizar el catálogo o corrige el mapeo.",
        offenders: unknown.map((r) => `${label(r.line)} (EAN ${r.ean})`),
      },
    };
  }

  // 4. Agencia: el SKU tiene que estar habilitado para Shalom.
  if (opts.modality === "agency") {
    const notAgency = resolved.filter((r) => !r.sku!.is_agency_eligible);
    if (notAgency.length) {
      return {
        ok: false,
        blocker: {
          kind: "no_apto_agencia",
          message:
            "Estos productos no se pueden despachar por agencia Shalom (su almacén no está habilitado o no tiene stock). Usa contraentrega.",
          offenders: notAgency.map((r) => label(r.line)),
        },
      };
    }
  }

  // 5. Un solo almacén. Es la regla estructural: si falla, hay que partir el
  //    pedido, no corregir un dato.
  const warehouses = new Map<number, string | null>();
  for (const r of resolved) {
    const id = r.sku!.warehouse_id;
    if (id === null || id === undefined) {
      return {
        ok: false,
        blocker: {
          kind: "sin_almacen",
          message:
            "El catálogo de Aliclik no indica almacén para estos productos. Vuelve a sincronizar el catálogo.",
          offenders: [label(r.line)],
        },
      };
    }
    warehouses.set(id, r.sku!.warehouse_name ?? null);
  }
  if (warehouses.size > 1) {
    const names = [...warehouses.entries()].map(([id, name]) => name ?? `almacén ${id}`);
    return {
      ok: false,
      blocker: {
        kind: "multi_almacen",
        message: `Los productos salen de almacenes distintos (${names.join(", ")}). Aliclik exige un pedido por almacén: hay que dividirlo.`,
        offenders: resolved.map((r) => `${label(r.line)} → ${r.sku!.warehouse_name ?? r.sku!.warehouse_id}`),
      },
    };
  }
  const only = [...warehouses.entries()][0];
  if (!only) {
    return {
      ok: false,
      blocker: { kind: "sin_almacen", message: "No se pudo determinar el almacén.", offenders: [] },
    };
  }
  const [warehouseId, warehouseName] = only;

  // 6. Cantidades. Varias líneas pueden compartir EAN: se agregan, porque
  //    Aliclik valida stock y el tope de 6 por EAN, no por línea.
  const agg = new Map<string, ResolvedItem>();
  for (const r of resolved) {
    const price = r.line.price;
    if (price === null || price === undefined || !Number.isFinite(price) || price < 0) {
      return {
        ok: false,
        blocker: {
          kind: "precio_invalido",
          message: "Hay productos sin precio válido; Aliclik exige un precio unitario ≥ 0.",
          offenders: [label(r.line)],
        },
      };
    }
    const prev = agg.get(r.ean);
    if (prev) {
      prev.quantity += r.line.quantity;
    } else {
      agg.set(r.ean, {
        ean: r.ean,
        quantity: r.line.quantity,
        price,
        title: r.line.title,
        stockVirtual: r.sku!.stock_virtual ?? null,
      });
    }
  }
  const items = [...agg.values()];

  // 7. Tope de 6 unidades — solo en agencia; en contraentrega no existe.
  if (opts.modality === "agency") {
    const total = items.reduce((n, i) => n + i.quantity, 0);
    if (total > AGENCY_MAX_UNITS) {
      return {
        ok: false,
        blocker: {
          kind: "max_6_unidades",
          message: `Un pedido por agencia admite como máximo ${AGENCY_MAX_UNITS} unidades y este tiene ${total}.`,
          offenders: items.map((i) => `${i.title ?? i.ean} ×${i.quantity}`),
        },
      };
    }
  }

  // 8. Stock. En agencia bloquea (el servidor de Aliclik lo exige igualmente);
  //    en contraentrega solo avisa, porque `stockVirtual` es stock RESERVABLE y
  //    nuestro espejo puede llevar horas de retraso: bloquear con un dato viejo
  //    frenaría ventas buenas.
  const short = items.filter((i) => i.stockVirtual !== null && i.stockVirtual < i.quantity);
  if (short.length && opts.modality === "agency") {
    return {
      ok: false,
      blocker: {
        kind: "sin_stock",
        message: "Aliclik no tiene stock suficiente para estos productos.",
        offenders: short.map((i) => `${i.title ?? i.ean}: piden ${i.quantity}, hay ${i.stockVirtual}`),
      },
    };
  }

  const warnings = short.map(
    (i) => `Stock ajustado en ${i.title ?? i.ean}: piden ${i.quantity}, el catálogo marcaba ${i.stockVirtual}.`,
  );

  const formatTimeAgency =
    resolved.map((r) => r.sku!.format_time_agency).find((t) => t && t.trim()) ?? null;

  return { ok: true, warehouseId, warehouseName, items, formatTimeAgency, warnings };
}

// ---------------------------------------------------------------------------
// Sincronización (impura)
// ---------------------------------------------------------------------------

/** Aplana la respuesta del catálogo a filas de `aliclik_skus`. */
export function flattenCatalog(
  products: readonly AliclikProduct[],
  isAgency: boolean,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const p of products) {
    for (const s of p.skus ?? []) {
      const ean = (s.ean ?? "").trim();
      if (!ean) continue; // sin EAN no sirve: es la clave con la que se pide
      out.push({
        ean,
        sku: s.sku?.trim() || null,
        product_id: p.id ?? null,
        product_name: p.name ?? null,
        sku_name: s.name ?? null,
        category: p.category ?? null,
        url_image: p.urlImage ?? null,
        regular_price: s.regularPrice ?? null,
        drop_price: s.dropPrice ?? null,
        stock_virtual: s.stockVirtual ?? null,
        warehouse_id: s.warehouseId ?? null,
        warehouse_name: s.warehouseName ?? null,
        format_time_agency: s.formatTimeAgency ?? null,
        shalom_origin_in: s.shalomOriginIn ?? null,
        is_agency_eligible: isAgency,
      });
    }
  }
  return out;
}

export interface CatalogSyncResult {
  ok: boolean;
  skus: number;
  agencySkus: number;
  agencies: number;
  packageSizes: number;
  autoMapped: number;
  errors: string[];
}

/**
 * Refresca el espejo del catálogo de una tienda.
 *
 * Dos pasadas contra el mismo endpoint, como manda la documentación: la normal
 * y la de `isAgency=true`, que es la que dice qué SKUs son despachables por
 * Shalom y añade la hora de corte del almacén.
 *
 * El sync NO borra el mapeo manual: solo siembra los `source='auto'` por
 * igualdad exacta de SKU, que es el caso mayoritario, y deja el resto al equipo.
 */
export async function syncAliclikCatalog(
  storeId: string,
  opts: AliclikClientOpts,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<CatalogSyncResult> {
  const out: CatalogSyncResult = {
    ok: true,
    skus: 0,
    agencySkus: 0,
    agencies: 0,
    packageSizes: 0,
    autoMapped: 0,
    errors: [],
  };

  const base = await listAllProducts(opts, {});
  if (!base.ok) {
    return { ...out, ok: false, errors: [`Catálogo: ${base.error}`] };
  }
  const agency = await listAllProducts(opts, { isAgency: true });
  if (!agency.ok) out.errors.push(`Catálogo de agencia: ${agency.error}`);

  const rows = new Map<string, Record<string, unknown>>();
  for (const r of flattenCatalog(base.data, false)) rows.set(String(r.ean), r);
  if (agency.ok) {
    for (const r of flattenCatalog(agency.data, true)) {
      const prev = rows.get(String(r.ean));
      // La pasada de agencia gana en sus campos propios y marca la elegibilidad,
      // pero no debe perder lo que solo trae la pasada normal.
      rows.set(String(r.ean), prev ? { ...prev, ...r, is_agency_eligible: true } : r);
    }
    out.agencySkus = agency.data.reduce((n, p) => n + (p.skus?.length ?? 0), 0);
  }

  const payload: Record<string, unknown>[] = [...rows.values()].map((r) => ({
    ...r,
    store_id: storeId,
    synced_at: new Date().toISOString(),
  }));
  out.skus = payload.length;

  if (payload.length) {
    const { error } = await admin.from("aliclik_skus").upsert(payload, { onConflict: "store_id,ean" });
    if (error) {
      out.ok = false;
      out.errors.push(`Guardar catálogo: ${error.message}`);
    }
  }

  // Siembra automática del mapeo. Dos señales, en este orden:
  //
  //   1. Mismo SKU en ambas plataformas. Es lo ideal, pero en la práctica casi
  //      nunca ocurre: Shopify usa numéricos ("818531465") y Aliclik códigos
  //      propios ("SXOW1"), así que por sí sola encuentra casi nada.
  //   2. Mismo NOMBRE normalizado. Aliclik replica el título del producto y solo
  //      le añade su sufijo de tienda, así que tras normalizar coinciden exacto.
  //      Esta es la que realmente hace el trabajo.
  //
  // `ignoreDuplicates` protege las decisiones del equipo: una fila que ya existe
  // (manual o auto) no se toca nunca.
  const seeds = new Map<string, { shopify_sku: string; ean: string }>();

  for (const r of payload) {
    const s = typeof r.sku === "string" ? normalizeSku(r.sku) : "";
    if (s) seeds.set(s, { shopify_sku: s, ean: String(r.ean) });
  }

  // Por nombre: hace falta el catálogo de Shopify, que aquí se deriva de las
  // líneas de pedido — es la única fuente de SKU+título que tiene el sistema.
  const shopifyProducts = await loadShopifySkuNames(storeId, admin);
  if (shopifyProducts.size) {
    // Un nombre que apunta a DOS EAN distintos es ambiguo: no se siembra ninguno
    // y queda para que lo decida una persona.
    const byName = new Map<string, string | null>();
    for (const r of payload) {
      const name = normalizeProductName(r.product_name as string | null);
      if (!name) continue;
      const ean = String(r.ean);
      if (!byName.has(name)) byName.set(name, ean);
      else if (byName.get(name) !== ean) byName.set(name, null); // ambiguo
    }
    for (const [shopifySku, title] of shopifyProducts) {
      if (seeds.has(shopifySku)) continue; // el SKU ya ganó
      const ean = byName.get(normalizeProductName(title));
      if (ean) seeds.set(shopifySku, { shopify_sku: shopifySku, ean });
    }
  }

  if (seeds.size) {
    const { error, count } = await admin.from("aliclik_sku_map").upsert(
      [...seeds.values()].map((s) => ({ ...s, store_id: storeId, source: "auto" as const })),
      { onConflict: "store_id,shopify_sku", ignoreDuplicates: true, count: "exact" },
    );
    if (error) out.errors.push(`Mapeo automático: ${error.message}`);
    else out.autoMapped = count ?? 0;
  }

  // Directorio de agencias. Su fallo NO invalida el sync: el catálogo ya sirve
  // para contraentrega, y por eso mismo lo cacheamos (su origen puede dar 502).
  const agencies = await listAgencies(opts);
  if (!agencies.ok) {
    out.errors.push(`Agencias: ${agencies.error}`);
  } else {
    const rowsA = agencies.data
      .filter((a) => a.id !== null && a.id !== undefined && String(a.id).trim())
      .map((a) => ({
        store_id: storeId,
        agency_id: String(a.id),
        name: a.name ?? null,
        address: a.address ?? null,
        department: a.department ?? null,
        province: a.province ?? null,
        district: a.district ?? null,
        synced_at: new Date().toISOString(),
      }));
    out.agencies = rowsA.length;
    if (rowsA.length) {
      const { error } = await admin
        .from("aliclik_agencies")
        .upsert(rowsA, { onConflict: "store_id,agency_id" });
      if (error) out.errors.push(`Guardar agencias: ${error.message}`);
    }
  }

  const sizes = await listPackageSizes(opts);
  if (!sizes.ok) {
    out.errors.push(`Tamaños de paquete: ${sizes.error}`);
  } else {
    const rowsP = sizes.data
      .filter((s) => (s.title ?? "").trim())
      .map((s, i) => ({
        store_id: storeId,
        title: (s.title ?? "").trim(),
        position: i,
        synced_at: new Date().toISOString(),
      }));
    out.packageSizes = rowsP.length;
    if (rowsP.length) {
      const { error } = await admin
        .from("aliclik_package_sizes")
        .upsert(rowsP, { onConflict: "store_id,title" });
      if (error) out.errors.push(`Guardar tamaños: ${error.message}`);
    }
  }

  return out;
}

/**
 * SKU → título de los productos de Shopify de una tienda.
 *
 * El sistema no guarda un catálogo de Shopify: los productos solo existen dentro
 * de `orders.line_items`. Así que se derivan de ahí, quedándose con el título
 * más reciente de cada SKU (un producto puede haberse renombrado, y el nombre
 * que Aliclik tiene es el de ahora).
 *
 * Se limita a los pedidos recientes a propósito: un SKU que no se vende desde
 * hace un año no necesita mapeo, y recorrer la tabla entera para eso sería caro.
 */
export interface ShopifySkuDetails {
  title: string;
  variantTitle: string | null;
}

/**
 * SKU → producto y variante de Shopify.
 *
 * La variante forma parte de la identidad del SKU. Dos filas pueden compartir
 * el producto y diferir solo en talla, color o presentación.
 */
export async function loadShopifySkuDetails(
  storeId: string,
  admin: SupabaseClient = createAdminSupabase(),
  sinceDays = 365,
): Promise<Map<string, ShopifySkuDetails>> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const out = new Map<string, ShopifySkuDetails>();
  const seenAt = new Map<string, string>();

  // Paginado: PostgREST corta en 1000 filas por respuesta.
  const PAGE = 1000;
  for (let from = 0; from < 50_000; from += PAGE) {
    const { data, error } = await admin
      .from("orders")
      .select("created_at,line_items")
      .eq("store_id", storeId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error || !data?.length) break;

    for (const row of data as { created_at: string; line_items: unknown }[]) {
      const items = Array.isArray(row.line_items) ? row.line_items : [];
      for (const it of items as {
        sku?: string | null;
        title?: string | null;
        variant_title?: string | null;
        variantTitle?: string | null;
      }[]) {
        const sku = normalizeSku(it.sku);
        const title = (it.title ?? "").trim();
        if (!sku || !title) continue;
        const rawVariant = (it.variant_title ?? it.variantTitle ?? "").trim();
        const variantTitle =
          rawVariant && rawVariant.toLowerCase() !== "default title" ? rawVariant : null;
        const prev = seenAt.get(sku);
        if (!prev || row.created_at > prev) {
          seenAt.set(sku, row.created_at);
          out.set(sku, { title, variantTitle });
        }
      }
    }
    if (data.length < PAGE) break;
  }
  return out;
}

/** Compatibilidad para el mapeo automático, que solo compara nombres. */
export async function loadShopifySkuNames(
  storeId: string,
  admin: SupabaseClient = createAdminSupabase(),
  sinceDays = 365,
): Promise<Map<string, string>> {
  const details = await loadShopifySkuDetails(storeId, admin, sinceDays);
  return new Map([...details].map(([sku, item]) => [sku, item.title]));
}

/** Columnas del espejo que necesita el resolutor. */
const SKU_COLUMNS =
  "ean,sku,product_name,sku_name,stock_virtual,warehouse_id,warehouse_name," +
  "format_time_agency,shalom_origin_in,is_agency_eligible,synced_at";

/** PostgREST corta cada respuesta en `db-max-rows` (1000 en Supabase). */
const PAGE = 1000;

/**
 * Lee TODAS las filas de una tabla del catálogo, paginando.
 *
 * Sin esto se leen solo las primeras 1000. Con un catálogo de 3.666 SKUs eso
 * significaba que el resolutor daba "ean_desconocido" para mapeos correctos, y
 * que la pantalla no ofrecía dos tercios de los productos — un fallo silencioso
 * y de los peores, porque el sistema parece funcionar y simplemente miente.
 */
async function readAll<T>(
  admin: SupabaseClient,
  table: string,
  columns: string,
  storeId: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from(table)
      .select(columns)
      .eq("store_id", storeId)
      .order("ean", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error || !data?.length) break;
    out.push(...(data as T[]));
    if (data.length < PAGE) break;
    // Tope de seguridad: 50.000 filas es mucho más de lo que cabe esperar y
    // evita un bucle infinito si el orden no fuera estable.
    if (out.length >= 50_000) break;
  }
  return out;
}

/** Carga el catálogo y el mapeo de una tienda (para el resolutor). */
export async function loadCatalogFor(
  storeId: string,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<{ skus: AliclikSkuRow[]; mapping: AliclikSkuMapRow[] }> {
  const [skus, mapping] = await Promise.all([
    readAll<AliclikSkuRow>(admin, "aliclik_skus", SKU_COLUMNS, storeId),
    readAll<AliclikSkuMapRow>(admin, "aliclik_sku_map", "shopify_sku,ean", storeId),
  ]);
  return { skus, mapping };
}

/** Igual que `loadCatalogFor`, pero con las columnas que la pantalla muestra. */
export async function loadAllAliclikSkus(
  storeId: string,
  admin: SupabaseClient = createAdminSupabase(),
): Promise<(AliclikSkuRow & { sku_name: string | null; synced_at: string })[]> {
  return readAll(admin, "aliclik_skus", SKU_COLUMNS, storeId);
}
