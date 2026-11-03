// Historial de Shopify (MOM §37.2, 23-10-2026): la tienda de la carga es la de
// la pestaña. Con un selector propio en la carga, cambiar de pestaña dejaba el
// título en Aurela y la subida en Kenku Peru.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const UPLOAD = read("components/shopify-history-upload.tsx");
const PAGE = read("app/dashboard/stores/historial/page.tsx");
const MOM = flat(read("docs/mom/master-pedidos-v1.md"));

describe("Historial de Shopify: una sola forma de elegir la tienda", () => {
  it("la carga no tiene selector de tienda: recibe la de la pestaña", () => {
    expect(UPLOAD).not.toMatch(/<select/);
    expect(UPLOAD).not.toMatch(/setStoreId/);
    expect(UPLOAD).toContain("export function ShopifyHistoryUpload({ storeId, storeName }");
  });

  it("la página la monta por tienda: cambiar de pestaña empieza de cero con la tienda nueva", () => {
    expect(PAGE).toContain("<ShopifyHistoryUpload key={store.id} storeId={store.id} storeName={store.name} />");
  });

  it("el botón dice en qué tienda carga", () => {
    expect(UPLOAD).toContain("en ${storeName}");
  });

  it("el MOM lo dice (§37.2)", () => {
    expect(MOM).toContain("La tienda es la de la pestaña de arriba (Aurela, Kenku Peru): la carga no tiene otro selector");
  });
});
