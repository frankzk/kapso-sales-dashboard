// MOM §37.12: las tres partes de la salida de Shopify (la base de WooCommerce,
// su entrada y los respaldos de Shopify con la foto de las boletas) atadas
// entre sí. Lo que una parte promete de otra tiene que ser verdad en el código:
// los números de migración, la columna `orders.platform` en cada lugar que la
// usa, las secciones del MOM, las entradas de DEPLOY.md y los crons. Nada aquí
// llama a Shopify, a WooCommerce ni a una base.

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mapGraphqlDraftOrder, mapGraphqlOrder, mapRestDraftOrder, mapRestOrder } from "@/lib/shopify";
import { WOO_PLATFORM } from "@/lib/woocommerce";
import { ORDER_PLATFORMS } from "@/lib/types";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const MOM = read("docs/mom/master-pedidos-v1.md");
const DEPLOY = read("DEPLOY.md");

function section(title: string): string {
  const start = MOM.indexOf(title);
  expect(start, title).toBeGreaterThan(-1);
  const level = title.match(/^#+/)![0].length;
  const rest = MOM.slice(start + title.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return flat(next === -1 ? rest : rest.slice(0, next));
}

const S37_12 = section("### 37.12 Lo que decide la plataforma del pedido");
const S35_10 = section("### 35.10 La foto del pedido");

describe("las migraciones: 0273 es la base de WooCommerce y 0274 la foto, en ese orden", () => {
  const files = readdirSync(resolve(process.cwd(), "db/migrations")).filter((f) => /^\d{4}_/.test(f));

  it("un archivo por número, y 0274 es la última", () => {
    expect(files.filter((f) => f.startsWith("0273_"))).toEqual(["0273_woocommerce_base.sql"]);
    expect(files.filter((f) => f.startsWith("0274_"))).toEqual(["0274_invoice_snapshots.sql"]);
    expect([...files].sort().at(-1)).toBe("0274_invoice_snapshots.sql");
  });

  it("db/apply.sql las aplica en orden: 0273 antes que 0274", () => {
    const apply = read("db/apply.sql");
    const a = apply.indexOf("\\ir migrations/0273_woocommerce_base.sql");
    const b = apply.indexOf("\\ir migrations/0274_invoice_snapshots.sql");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
  });

  it("la 0274 se detiene sin la columna que crea la 0273", () => {
    const sql0273 = flat(read("db/migrations/0273_woocommerce_base.sql"));
    const sql0274 = flat(read("db/migrations/0274_invoice_snapshots.sql"));
    expect(sql0273).toContain(
      "alter table orders add column if not exists platform text not null default 'shopify' constraint orders_platform_check check (platform in ('shopify', 'woocommerce'))",
    );
    expect(sql0274).toContain("column_name = 'platform'");
    expect(sql0274).toContain("0274: falta la 0273 (orders.platform). Aplicar la 0273 primero.");
  });

  it("los valores de la columna son los del código", () => {
    expect([...ORDER_PLATFORMS]).toEqual(["shopify", "woocommerce"]);
    expect(WOO_PLATFORM).toBe("woocommerce");
  });
});

describe("orders.platform en la foto de la boleta (0274, §35.10)", () => {
  const sql = flat(read("db/migrations/0274_invoice_snapshots.sql"));
  const fn = (name: string) => {
    const start = sql.indexOf(`create or replace function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    return sql.slice(start, sql.indexOf("$$;", start) === -1 ? undefined : sql.indexOf("$$;", start));
  };

  it("qué falta y qué se guarda: solo pedidos de Shopify según la columna", () => {
    expect(fn("invoice_snapshot_candidates")).toContain("and o.platform = 'shopify'");
    expect(fn("invoice_snapshot_put")).toContain("and o.platform = 'shopify'");
  });

  it("y la lectura de la foto mira la columna del pedido, no su id", () => {
    const src = read("lib/invoicing/shopify-order.ts");
    expect(src).toContain('.select("platform,shopify_order_id")');
    expect(src).toContain('order.platform !== "shopify"');
  });
});

describe("la entrada no mezcla plataformas", () => {
  it("los mapeadores de Shopify no escriben la plataforma (la columna queda en shopify)", () => {
    expect("platform" in mapRestOrder({ id: 1, name: "#KP1", line_items: [] }, "s")).toBe(false);
    expect("platform" in mapGraphqlOrder({ id: "gid://shopify/Order/1", name: "#KP1" }, "s")).toBe(false);
    expect("platform" in mapRestDraftOrder({ id: 1, line_items: [] }, "s")).toBe(false);
    expect("platform" in mapGraphqlDraftOrder({ id: "gid://shopify/DraftOrder/1" }, "s")).toBe(false);
  });

  it("upsertOrders no descarta `platform` en silencio (un pedido de WooCommerce no se guarda como shopify)", () => {
    const ingest = read("lib/ingest.ts");
    const late = /const LATE_ORDER_COLUMNS = \[([^\]]*)\]/.exec(ingest);
    expect(late).not.toBeNull();
    expect(late![1]).not.toContain("platform");
  });
});

describe("MOM §37.12", () => {
  it("dice dónde manda orders.platform y remite a las otras partes", () => {
    expect(S37_12).toContain("**Dónde manda `orders.platform` hoy**");
    expect(S37_12).toContain("(`invoice_snapshot_candidates`)");
    expect(S37_12).toContain("(`invoice_snapshot_put`)");
    expect(S37_12).toContain("§35.10");
    expect(S37_12).toContain("(37.11)");
    expect(S35_10).toContain("(0273, §37)");
  });

  it("la dirección de un pedido de WooCommerce nunca va a Shopify, con el aviso del código", () => {
    const actions = read("app/dashboard/envios/actions.ts");
    const capture = read("lib/shipment-order-capture.ts");
    const notice = "El pedido es de WooCommerce: allí no se cambió";
    expect(S37_12).toContain(`«${notice}»`);
    expect(actions).toContain(`${notice}.`);
    expect(S37_12).toContain("(`orderPlatformOf`)");
    expect(capture).toContain('if (input.platform === "woocommerce") return { ok: true, wrote: false, why: "woocommerce" };');
  });

  it("deja escrito lo que falta: el lector de boletas de WooCommerce y la búsqueda de Envíos", () => {
    expect(S37_12).toContain("**La boleta de un pedido de WooCommerce** espera su lector");
    expect(S37_12).toContain("**Auto-vínculo y búsqueda de Envíos** buscan en Shopify");
  });

  it("las secciones de WooCommerce siguen en orden y sin repetirse", () => {
    const heads = [...MOM.matchAll(/^### 37\.(\d+) /gm)].map((m) => Number(m[1]));
    expect(heads).toEqual(Array.from({ length: heads.length }, (_, i) => i + 1));
    expect(heads.at(-1)).toBe(12);
  });
});

describe("DEPLOY.md y los crons", () => {
  it("las tres entradas en el orden de aplicación: 0273, 0274 y la entrada de pedidos", () => {
    const a = DEPLOY.indexOf("### 23-10-2026 · Base de WooCommerce (0273, MOM §37)");
    const b = DEPLOY.indexOf("### 23-10-2026 · La foto de los pedidos de Shopify para sus boletas (0274, MOM §35.10)");
    const c = DEPLOY.indexOf("### 25-10-2026 · Entrada de pedidos de WooCommerce");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it("si salen en un mismo despliegue, el orden está escrito", () => {
    expect(flat(DEPLOY)).toContain("aplicar la 0273, después la 0274 y recién entonces el código");
  });

  it("la foto tiene su cron y la entrada de WooCommerce no agrega ninguno (va dentro del sync)", () => {
    const vercel = JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] };
    expect(vercel.crons.filter((c) => c.path === "/api/cron/invoice-snapshots")).toEqual([
      { path: "/api/cron/invoice-snapshots", schedule: "4,14,24,34,44,54 * * * *" },
    ]);
    expect(vercel.crons.some((c) => /woo/i.test(c.path))).toBe(false);
    expect(read("lib/ingest.ts")).toContain("const woo = await syncWooOrders(admin, storeId);");
  });
});
