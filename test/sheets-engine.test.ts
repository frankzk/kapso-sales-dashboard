// Liquidaciones 2 — el motor de columnas sobre la plantilla del Consolidado.
import { describe, expect, it } from "vitest";
import { computeRows } from "@/lib/sheets/engine";
import { DOMAIN_TEMPLATES, CATALOGO_ZONAS_KEY, perStoreSheetKey, slugify } from "@/lib/sheets/templates";
import { limaMonthRange } from "@/lib/sheets/resolver";
import type { OrderFacts, SheetColumnRow, StoredRow } from "@/lib/sheets/types";

function columnsOf(domainKey: string): SheetColumnRow[] {
  const tpl = DOMAIN_TEMPLATES.find((d) => d.key === domainKey)!;
  return tpl.columns.map((c, i) => ({
    id: `c${i}`,
    sheet_id: "sheet",
    key: c.key,
    label: c.label,
    kind: c.kind,
    data_type: c.data_type ?? "text",
    source: c.source ?? {},
    options: [...(c.options ?? [])],
    position: i,
    width: c.width ?? null,
    visible: c.visible ?? true,
    pinned: c.pinned ?? false,
    required: c.required ?? false,
    from_template: true,
  }));
}

const facts = (over: Partial<OrderFacts> = {}): OrderFacts => ({
  order_id: "o1",
  store_id: "s1",
  order_name: "#AUR168773",
  customer_name: "Nadina Susanibar",
  customer_phone: "51999",
  district: "Surquillo",
  province: "Lima",
  region: "Lima",
  coverage: "lima",
  shipping_mode: "cod",
  order_created_at: "2025-12-21T20:00:00Z",
  order_total: 149,
  general_status: "en_proceso",
  operational_status: "en_reparto",
  current_courier: "propio",
  delivered_courier: null,
  attempt_count: 1,
  delivered_at: null,
  returned_at: null,
  guide_code: null,
  cancelled_at: null,
  cancel_reason: null,
  ...over,
});

const catalog: StoredRow[] = [
  { id: "r1", sheet_id: "cat", order_id: null, row_key: "surquillo", values: { distrito: "Surquillo", region: "Lima", zona: "Lima Centrico" }, source: "importacion" },
];

describe("computeRows · Consolidado", () => {
  const columns = columnsOf("consolidado");

  it("llena campo, derivadas, lookup del catálogo y lo manual guardado, en una sola fila por pedido", () => {
    const stored: StoredRow[] = [
      { id: "s1", sheet_id: "sheet", order_id: "o1", row_key: "#AUR168773", values: { comentario: "llamar 5pm" }, source: "manual" },
    ];
    const row = computeRows({
      rowKey: "pedido",
      columns,
      facts: [facts()],
      stored,
      lookups: [{ key: CATALOGO_ZONAS_KEY, rows: catalog }],
    })[0]!;
    expect(row.row_key).toBe("#AUR168773");
    expect(row.stored_id).toBe("s1");
    expect(row.cells).toMatchObject({
      pedido: "#AUR168773",
      cliente: "Nadina Susanibar",
      fecha: "2025-12-21",
      mes: "2025/12",
      monto: 149,
      zona: "Lima Centrico",
      estatus: "Tránsito",
      intentos_lima: 1,
      estado_kapta: "En proceso",
      diferencia: "Coincide",
      comentario: "llamar 5pm",
    });
  });

  it("un pedido entregado por Aliclik según Kapta sale Entregado y dice quién", () => {
    const row = computeRows({
      rowKey: "pedido",
      columns,
      facts: [facts({ general_status: "entregado", delivered_courier: "aliclik", district: "Huancayo", region: "Junín", coverage: "provincia_cod" })],
      stored: [],
      lookups: [{ key: CATALOGO_ZONAS_KEY, rows: catalog }],
    })[0]!;
    expect(row.cells).toMatchObject({ zona: "Provincia COD", estatus: "Entregado", entregado_por: "aliclik (Kapta)", intentos_lima: null });
  });

  it("los aportes de otras hojas se suman a los de Kapta y la diferencia se explica", () => {
    const contributions = new Map([["#AUR168773", [{ sheet_key: "reparto_roy", mark: "E" as const }]]]);
    const row = computeRows({
      rowKey: "pedido",
      columns,
      facts: [facts({ general_status: "pendiente", operational_status: "sin_confirmar", current_courier: null })],
      stored: [],
      lookups: [{ key: CATALOGO_ZONAS_KEY, rows: catalog }],
      contributions,
    })[0]!;
    expect(row.cells.estatus).toBe("Entregado");
    expect(row.cells.entregado_por).toBe("reparto_roy");
    expect(row.cells.diferencia).toBe("Hoja: Entregado · Kapta: Pendiente");
  });

  it("anulado en Shopify sin entrega ni devolución resuelve Anulado", () => {
    const row = computeRows({
      rowKey: "pedido",
      columns,
      facts: [facts({ general_status: "anulado", cancelled_at: "2026-01-01T00:00:00Z", current_courier: null })],
      stored: [],
    })[0]!;
    expect(row.cells).toMatchObject({ estatus: "Anulado", entregado_por: null, diferencia: "Coincide" });
  });
});

describe("computeRows · Pedidos y catálogos", () => {
  it("la hoja de Pedidos marca Anulado y expone el estado operativo", () => {
    const row = computeRows({ rowKey: "pedido", columns: columnsOf("pedidos"), facts: [facts({ cancelled_at: "2026-01-01T00:00:00Z", general_status: "anulado" })], stored: [] })[0]!;
    expect(row.cells).toMatchObject({ anulado: true, estado: "Anulado", estado_operativo: "en_reparto", intentos: 1 });
  });

  it("una hoja de catálogo pinta sus filas guardadas tal cual", () => {
    const columns: SheetColumnRow[] = [
      { id: "a", sheet_id: "cat", key: "distrito", label: "Distrito", kind: "manual", data_type: "text", source: {}, options: [], position: 0, width: null, visible: true, pinned: true, required: true, from_template: true },
      { id: "b", sheet_id: "cat", key: "zona", label: "Zona", kind: "manual", data_type: "select", source: {}, options: ["Lima Centrico"], position: 1, width: null, visible: true, pinned: false, required: true, from_template: true },
    ];
    const rows = computeRows({ rowKey: "valor", columns, stored: catalog });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cells).toEqual({ distrito: "Surquillo", zona: "Lima Centrico" });
  });
});

describe("claves y rangos", () => {
  it("las hojas por tienda tienen clave estable a partir del nombre", () => {
    expect(slugify("Kenku Perú")).toBe("kenku_peru");
    expect(perStoreSheetKey("consolidado", "Aurela")).toBe("consolidado_aurela");
  });

  it("el rango de un mes de Lima empieza a las 05:00 UTC del día 1", () => {
    expect(limaMonthRange("2026/9")).toEqual({ from: "2026-09-01T05:00:00.000Z", to: "2026-10-01T05:00:00.000Z" });
    expect(limaMonthRange("2026/13")).toBeNull();
    expect(limaMonthRange("septiembre")).toBeNull();
  });
});
