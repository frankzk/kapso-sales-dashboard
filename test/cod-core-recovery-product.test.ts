// El producto del abandono que llega sin lista, desde su enlace de recuperación (16-11-2026).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCodCoreForm, recoveryLineItem } from "@/lib/cod-core-abandoned";

const store = { id: "4c6522f9-c775-4be3-95b0-160a3c16d27a", siteKey: "aur" };
const body = (over: Record<string, unknown> = {}) => ({
  evento: "abandonado",
  id: 13071,
  cliente: { celular: "984706412", nombre: "Clienta" },
  creado: "2026-11-16 07:14:34",
  productos: [],
  total: null,
  recuperacion: "https://aurela.pe/products/posturefit-brasier-corrector-de-postura-soykora/#cod-recuperar=O3SS",
  ...over,
});

describe("recoveryLineItem", () => {
  it("saca el producto de la ficha del enlace", () => {
    expect(recoveryLineItem("https://aurela.pe/products/crucis-pulsera-magnetica-de-cobre/#cod-recuperar=x")).toEqual({
      title: "Crucis pulsera magnetica de cobre",
      quantity: 1,
      sku: null,
      product_id: null,
      variant_id: null,
      variant_title: null,
      price: null,
      product_handle: "crucis-pulsera-magnetica-de-cobre",
    });
  });

  it("sin ficha de producto o sin enlace, nada", () => {
    expect(recoveryLineItem("https://aurela.pe/checkout/#cod-recuperar=x")).toBeNull();
    expect(recoveryLineItem(null)).toBeNull();
    expect(recoveryLineItem("posturefit")).toBeNull();
  });
});

describe("parseCodCoreForm", () => {
  it("con la lista vacía, la línea sale del enlace (sin precio)", () => {
    const parsed = parseCodCoreForm(body(), store);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.row.line_items).toHaveLength(1);
    expect(parsed.row.line_items[0]).toMatchObject({ title: "Posturefit brasier corrector de postura soykora", product_handle: "posturefit-brasier-corrector-de-postura-soykora", price: null });
    expect(parsed.row.total_amount).toBeNull();
  });

  it("con lista, manda la lista", () => {
    const parsed = parseCodCoreForm(body({ productos: [{ nombre: "Otro producto", cantidad: 2, precio: 89 }] }), store);
    expect(parsed.ok && parsed.row.line_items.map((li) => li.title)).toEqual(["Otro producto"]);
  });
});

describe("la ficha y la pasada", () => {
  it("la pasada corrige los que ya llegaron vacíos y la ficha no inventa «1 producto»", () => {
    const ingest = readFileSync(resolve(process.cwd(), "lib/cod-core-abandoned-ingest.ts"), "utf8");
    expect(ingest).toContain("const item = recoveryLineItem(body?.recuperacion);");
    const drawer = readFileSync(resolve(process.cwd(), "components/leads-drawer.tsx"), "utf8");
    expect(drawer).toContain("El formulario no mandó el producto: pregúntale en la llamada");
  });
});
