import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { topProducts } from "@/lib/metrics";
import type { OrderRow } from "@/lib/types";

// Panel «Productos» del Consolidado (owner, 26-10-2026): la lista completa, no
// solo los 10 con más unidades.
describe("Productos del Consolidado: la lista completa", () => {
  it("el panel no corta la lista", () => {
    const src = readFileSync(resolve(process.cwd(), "components/executive-dashboard.tsx"), "utf8");
    expect(src).not.toContain("topProducts(orders, 10)");
    expect(src).toContain("topProducts(productOrders ?? orders, Number.POSITIVE_INFINITY)");
    expect(src).toContain('"Todas las ventas"');
    const page = readFileSync(resolve(process.cwd(), "app/dashboard/page.tsx"), "utf8");
    expect(page).toContain("productOrders={productOrders}");
    const access = readFileSync(resolve(process.cwd(), "lib/access.ts"), "utf8");
    const loader = access.slice(access.indexOf("export async function getSalesProductOrders"));
    expect(loader.slice(0, loader.indexOf("\n}\n"))).not.toContain('contains("tags"');
  });

  it("topProducts sin tope devuelve todos los productos, de más a menos unidades", () => {
    const orders = Array.from({ length: 14 }, (_, i) => ({
      id: `o${i}`,
      cancelled_at: null,
      line_items: [{ sku: `S${i}`, title: `P${i}`, quantity: i + 1, price: 10 }],
    })) as unknown as OrderRow[];
    const all = topProducts(orders, Number.POSITIVE_INFINITY);
    expect(all).toHaveLength(14);
    expect(all[0]?.key).toBe("S13");
  });
});
