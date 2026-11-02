// El filtro «Producto» del Master (MOM §6, pedido del owner 02-11-2026, 0300).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), unstable_cache: (fn: () => unknown) => fn }));

import {
  decodeProductParam,
  encodeProductParam,
  orderProductTitles,
  pgTextArrayLiteral,
  productFilterOptions,
} from "@/lib/order-product-titles";
import { emptyFilters, hasActiveFilters, matchesFilters, type MasterFilters } from "@/lib/order-master-filters";
import { buildMasterQuery, hasQueryFilters, parseMasterQuery } from "@/lib/master-query";
import { applyServerFilters, withAvailableProductFilter } from "@/lib/orders-master-access";
import { isMissingProductTitles } from "@/lib/order-master";
import type { OrderMasterRow } from "@/lib/types";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("los productos del pedido (orderProductTitles)", () => {
  it("toma el título sin variante, recorta espacios y junta los repetidos en el orden de las líneas", () => {
    expect(
      orderProductTitles([
        { title: "  Faja  Reductora ", variant_title: "S", quantity: 1, sku: "F-S" },
        { title: "Faja Reductora", variant_title: "M", quantity: 2, sku: "F-M" },
        { title: "Crema, 50ml", quantity: 1 },
      ]),
    ).toEqual(["Faja Reductora", "Crema, 50ml"]);
  });
  it("lo que no es un título no es un producto", () => {
    expect(orderProductTitles([{ title: "" }, { title: null }, { sku: "x" }, "raro", null, { title: { a: 1 } }, { title: 12 }])).toEqual(["12"]);
    expect(orderProductTitles(null)).toEqual([]);
    expect(orderProductTitles({ title: "no es lista" })).toEqual([]);
  });
  it("la 0300 aplica la MISMA regla en SQL para el relleno", () => {
    // Misma entrada que arriba: el SELECT de solo lectura del 02-11-2026 sobre
    // este cuerpo devolvió {"Faja Reductora","Crema, 50ml","12"}.
    const sql = read("db/migrations/0300_order_master_product_titles.sql");
    expect(sql).toContain("btrim(regexp_replace(e.li ->> 'title', '\\s+', ' ', 'g'))");
    expect(sql).toContain("where jsonb_typeof(e.li -> 'title') in ('string', 'number')");
    expect(sql).toContain("array_agg(x.title order by x.first_line)");
    expect(sql).toContain("where x.title <> ''");
  });
});

describe("la migración 0300", () => {
  const sql = read("db/migrations/0300_order_master_product_titles.sql");
  it("crea la columna, rellena lo existente y DESPUÉS el índice GIN", () => {
    expect(sql).toContain("add column if not exists product_titles text[] not null default '{}'");
    const update = sql.indexOf("update order_master om");
    const index = sql.indexOf("create index if not exists order_master_product_titles_idx");
    expect(update).toBeGreaterThan(0);
    expect(index).toBeGreaterThan(update);
    expect(sql).toContain("on order_master using gin (product_titles)");
    // Re-aplicarla no reescribe nada.
    expect(sql).toContain("om.product_titles is distinct from order_product_titles(o.line_items)");
  });
  it("la función de opciones respeta la RLS y no la ejecuta anon", () => {
    expect(sql).toMatch(/order_master_product_options\(p_store_ids uuid\[\]\)\s+returns jsonb[\s\S]*security invoker/);
    expect(sql).not.toMatch(/security definer/i);
    expect(sql).toContain("revoke all on function public.order_master_product_options(uuid[]) from public, anon;");
    expect(sql).toContain("grant execute on function public.order_master_product_options(uuid[]) to authenticated, service_role;");
  });
  it("está en apply.sql y DEPLOY.md la manda aplicar antes del código", () => {
    expect(read("db/apply.sql")).toContain("\\ir migrations/0300_order_master_product_titles.sql");
    const deploy = read("DEPLOY.md");
    expect(deploy).toContain("0300_order_master_product_titles.sql");
    expect(deploy).toContain("«Producto»");
  });
});

describe("el filtro «Producto»: URL, navegador, base y opciones", () => {
  it("viaja por `pr` y sobrevive a las comas y los % de los títulos", () => {
    const f: MasterFilters = { ...emptyFilters(), products: new Set(["Crema, 50ml", "Sérum 100%", "Faja Reductora"]) };
    expect(hasActiveFilters(f)).toBe(true);
    expect(hasQueryFilters(f)).toBe(true);
    const qs = buildMasterQuery({ filters: f, sortKey: "created", page: 1 });
    expect([...qs.keys()]).toEqual(["pr"]);
    expect([...parseMasterQuery(new URLSearchParams(qs.toString())).filters.products]).toEqual([
      "Crema, 50ml",
      "Sérum 100%",
      "Faja Reductora",
    ]);
    expect(decodeProductParam(encodeProductParam(["%2C literal", "a,b"]))).toEqual(["%2C literal", "a,b"]);
    // `p` sigue siendo Provincia.
    const both = parseMasterQuery(new URLSearchParams("p=arequipa&pr=Faja"));
    expect([...both.filters.provinces]).toEqual(["arequipa"]);
    expect([...both.filters.products]).toEqual(["Faja"]);
    expect(parseMasterQuery(new URLSearchParams("")).filters.products.size).toBe(0);
    expect(buildMasterQuery({ filters: emptyFilters(), sortKey: "created", page: 1 }).toString()).toBe("");
  });
  it("en el navegador basta con un producto", () => {
    const f: MasterFilters = { ...emptyFilters(), products: new Set(["Faja Reductora"]) };
    const row = (product_titles: string[] | null) => ({ product_titles } as unknown as OrderMasterRow);
    const now = new Date().toISOString();
    expect(matchesFilters(row(["Crema", "Faja Reductora"]), f, now)).toBe(true);
    expect(matchesFilters(row(["Crema"]), f, now)).toBe(false);
    expect(matchesFilters(row(null), f, now)).toBe(false);
    expect(matchesFilters(row(null), emptyFilters(), now)).toBe(true);
  });
  it("en la base es un `&&` sobre la columna, con el arreglo entre comillas", () => {
    const sb = createClient("http://local", "anon");
    const url = (f: MasterFilters) =>
      (applyServerFilters(sb.from("order_master").select("id"), f, new Date()) as unknown as { url: URL }).url;
    const params = url({ ...emptyFilters(), products: new Set(['Crema, 50ml', 'Faja "Pro"']) }).searchParams;
    expect(params.get("product_titles")).toBe('ov.{"Crema, 50ml","Faja \\"Pro\\""}');
    expect(url(emptyFilters()).searchParams.get("product_titles")).toBeNull();
    expect(pgTextArrayLiteral(["a\\b"])).toBe('{"a\\\\b"}');
  });
  it("sin la 0300 el filtro se quita en vez de romper el Master", () => {
    const f: MasterFilters = { ...emptyFilters(), products: new Set(["Faja"]) };
    expect(withAvailableProductFilter(f, null).products.size).toBe(0);
    expect(withAvailableProductFilter(f, []).products).toEqual(new Set(["Faja"]));
    const page = read("app/dashboard/pedidos/page.tsx");
    expect(page).toContain("withAvailableProductFilter(urlFilters, await productOptionsPromise)");
    // El Excel respeta el filtro con la misma guarda que la tabla.
    expect(read("app/api/export/pedidos/route.ts")).toContain("withAvailableProductFilter(urlFilters, await getMasterProductOptionsCached(storeIds))");
  });
  it("las opciones suman las tiendas elegidas, las más pedidas primero, y no pierden lo elegido", () => {
    const rows = [
      { store_id: "s1", title: "Faja", orders: 10 },
      { store_id: "s2", title: "Faja", orders: 5 },
      { store_id: "s2", title: "Crema", orders: 12 },
      { store_id: "s1", title: "Bálsamo", orders: 1 },
    ];
    expect(productFilterOptions(rows, new Set())).toEqual([
      { value: "Faja", label: "Faja", count: 15 },
      { value: "Crema", label: "Crema", count: 12 },
      { value: "Bálsamo", label: "Bálsamo", count: 1 },
    ]);
    expect(productFilterOptions(rows, new Set(["s1"]), new Set(["Crema"]))).toEqual([
      { value: "Faja", label: "Faja", count: 10 },
      { value: "Bálsamo", label: "Bálsamo", count: 1 },
      { value: "Crema", label: "Crema", count: 0 },
    ]);
    expect(productFilterOptions(null, new Set())).toEqual([]);
  });
});

describe("el recálculo del Master escribe la columna", () => {
  const src = read("lib/order-master.ts");
  it("desde orders.line_items, con la función probada", () => {
    expect(src).toContain("product_titles: orderProductTitles(order.line_items),");
    expect(src).toMatch(/const ORDER_COLUMNS =\s+"[^"]*,line_items"/);
  });
  it("y si la 0300 no está, el upsert sigue sin ella", () => {
    expect(isMissingProductTitles("Could not find the 'product_titles' column of 'order_master' in the schema cache")).toBe(true);
    expect(isMissingProductTitles('column "product_titles" of relation "order_master" does not exist')).toBe(true);
    expect(isMissingProductTitles("duplicate key value violates unique constraint")).toBe(false);
    expect(isMissingProductTitles(null)).toBe(false);
    expect(src).toContain("if (error && isMissingProductTitles(error.message)) {");
  });
});

describe("el MOM lo documenta", () => {
  it("con la fecha del pedido del owner", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    expect(mom).toContain("**Filtro «Producto» (owner, 02-11-2026).**");
    expect(mom).toContain("`order_master.product_titles`");
  });
});
