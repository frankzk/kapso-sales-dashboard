// MOM §38.12: las tres partes de la salida de Shopify (la base de WooCommerce,
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

const S38_12 = section("### 38.12 Lo que decide la plataforma del pedido");
const S35_10 = section("### 35.10 La foto del pedido");

describe("las migraciones: 0274 es la base de WooCommerce y 0275 la foto, en ese orden", () => {
  const files = readdirSync(resolve(process.cwd(), "db/migrations")).filter((f) => /^\d{4}_/.test(f));

  it("un archivo por número, y 0275 justo después de 0274", () => {
    expect(files.filter((f) => f.startsWith("0274_"))).toEqual(["0274_woocommerce_base.sql"]);
    expect(files.filter((f) => f.startsWith("0275_"))).toEqual(["0275_invoice_snapshots.sql"]);
    // Era «0275 es la última» hasta que llegó la 0276 (historial de Shopify por
    // API, MOM §37.5): lo que importa es el orden entre las dos.
    const sorted = [...files].sort();
    expect(sorted.indexOf("0275_invoice_snapshots.sql")).toBe(sorted.indexOf("0274_woocommerce_base.sql") + 1);
  });

  it("db/apply.sql las aplica en orden: 0274 antes que 0275", () => {
    const apply = read("db/apply.sql");
    const a = apply.indexOf("\\ir migrations/0274_woocommerce_base.sql");
    const b = apply.indexOf("\\ir migrations/0275_invoice_snapshots.sql");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
  });

  it("la 0275 se detiene sin la columna que crea la 0274", () => {
    const sql0274 = flat(read("db/migrations/0274_woocommerce_base.sql"));
    const sql0275 = flat(read("db/migrations/0275_invoice_snapshots.sql"));
    expect(sql0274).toContain("alter table orders add column platform text not null default 'shopify';");
    expect(sql0274).toContain(
      "alter table orders add constraint orders_platform_check check (platform in ('shopify', 'woocommerce')) not valid;",
    );
    expect(sql0275).toContain("column_name = 'platform'");
    expect(sql0275).toContain("0275: falta la 0274 (orders.platform). Aplicar la 0274 primero.");
  });

  it("los valores de la columna son los del código", () => {
    expect([...ORDER_PLATFORMS]).toEqual(["shopify", "woocommerce"]);
    expect(WOO_PLATFORM).toBe("woocommerce");
  });
});

describe("orders.platform en la foto de la boleta (0275, §35.10)", () => {
  const sql = flat(read("db/migrations/0275_invoice_snapshots.sql"));
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

describe("MOM §38.12", () => {
  it("dice dónde manda orders.platform y remite a las otras partes", () => {
    expect(S38_12).toContain("**Dónde manda `orders.platform` hoy**");
    expect(S38_12).toContain("(`invoice_snapshot_candidates`)");
    expect(S38_12).toContain("(`invoice_snapshot_put`)");
    expect(S38_12).toContain("§35.10");
    expect(S38_12).toContain("(38.11)");
    expect(S35_10).toContain("(0274, §38)");
  });

  it("la dirección de un pedido de WooCommerce nunca va a Shopify, con el aviso del código", () => {
    const actions = read("app/dashboard/envios/actions.ts");
    const capture = read("lib/shipment-order-capture.ts");
    const notice = "El pedido es de WooCommerce: allí no se cambió";
    expect(S38_12).toContain(`«${notice}»`);
    expect(actions).toContain(`${notice}.`);
    expect(S38_12).toContain("(`orderPlatformOf`)");
    expect(capture).toContain('if (input.platform === "woocommerce") return { ok: true, wrote: false, why: "woocommerce" };');
  });

  it("deja escrito lo que falta: el lector de boletas de WooCommerce y la búsqueda de Envíos", () => {
    expect(S38_12).toContain("**La boleta de un pedido de WooCommerce** espera su lector");
    expect(S38_12).toContain("**Auto-vínculo y búsqueda de Envíos** buscan en Shopify");
  });

  it("las secciones de WooCommerce siguen en orden y sin repetirse", () => {
    const heads = [...MOM.matchAll(/^### 38\.(\d+) /gm)].map((m) => Number(m[1]));
    expect(heads).toEqual(Array.from({ length: heads.length }, (_, i) => i + 1));
    // 38.13: los pedidos del bot de Kapso por Kapta (test/bot-orders-mom.test.ts).
    // 38.14: la revisión de los webhooks de WooCommerce
    // (test/woocommerce-webhooks-health.test.ts).
    expect(heads.at(-1)).toBe(14);
  });
});

describe("DEPLOY.md y los crons", () => {
  it("las tres entradas en el orden de aplicación: 0274, 0275 y la entrada de pedidos", () => {
    const a = DEPLOY.indexOf("### 23-10-2026 · Base de WooCommerce (0274, MOM §38)");
    const b = DEPLOY.indexOf("### 23-10-2026 · La foto de los pedidos de Shopify para sus boletas (0275, MOM §35.10)");
    const c = DEPLOY.indexOf("### 25-10-2026 · Entrada de pedidos de WooCommerce");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it("si salen en un mismo despliegue, el orden está escrito", () => {
    expect(flat(DEPLOY)).toContain("aplicar la 0274, después la 0275 y recién entonces el código");
  });

  it("la foto tiene su cron y la entrada de WooCommerce no agrega ninguno (va dentro del sync); el único de WooCommerce es la revisión de los webhooks", () => {
    const vercel = JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] };
    expect(vercel.crons.filter((c) => c.path === "/api/cron/invoice-snapshots")).toEqual([
      { path: "/api/cron/invoice-snapshots", schedule: "1-59/2 * * * *" },
    ]);
    // La entrada de pedidos va dentro de /api/cron/sync. El único cron de
    // WooCommerce es el que solo LEE la lista de webhooks (MOM §38.14).
    expect(vercel.crons.filter((c) => /woo/i.test(c.path)).map((c) => c.path)).toEqual(["/api/cron/woo-webhooks"]);
    expect(read("lib/ingest.ts")).toContain("const woo = await syncWooOrders(admin, storeId);");
  });
});
