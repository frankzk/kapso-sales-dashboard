import { describe, it, expect } from "vitest";
import {
  MASTER_EXPORT_COLUMNS,
  ageInDays,
  exportFilename,
  toExportRow,
  type MasterExportContext,
} from "@/lib/master-export";
import type { OrderMasterRow } from "@/lib/types";

const NOW = new Date("2026-08-07T12:00:00.000Z");
const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS).toISOString();

const ctx: MasterExportContext = {
  storeNames: { "store-1": "Kenku Peru", "store-2": "Aurela" },
  now: NOW,
};

const row = (over: Partial<OrderMasterRow> = {}): OrderMasterRow =>
  ({
    id: "m1",
    store_id: "store-1",
    order_id: "o1",
    order_name: "#KP126434",
    order_created_at: daysAgo(2),
    customer_name: "Charles Sánchez Maldonado",
    customer_phone: "51910876229",
    region: "Lambayeque",
    province: "Lambayeque",
    district: "Lambayeque",
    coverage: "provincia_cod",
    shipping_mode: "cod",
    order_total: 89,
    general_status: "pendiente",
    operational_status: "sin_confirmar",
    macro_stage: "por_confirmar",
    macro_substage: "sin_llamar",
    status_since: daysAgo(2),
    status_locked: false,
    current_courier: null,
    last_courier: null,
    courier_count: 0,
    attempt_count: 0,
    guide_code: null,
    dispatched_at: null,
    delivered_at: null,
    returned_at: null,
    last_movement_at: daysAgo(1),
    comment_count: 0,
    logistics_cost: null,
    ...over,
  }) as OrderMasterRow;

const cell = (r: OrderMasterRow, header: string) => {
  const index = MASTER_EXPORT_COLUMNS.findIndex((c) => c.header === header);
  expect(index).toBeGreaterThanOrEqual(0);
  return toExportRow(r, ctx)[index];
};

describe("toExportRow — lo que ve el usuario", () => {
  it("traduce la tienda a su nombre, no el UUID", () => {
    expect(cell(row(), "Tienda")).toBe("Kenku Peru");
    expect(cell(row({ store_id: "store-2" }), "Tienda")).toBe("Aurela");
  });

  it("deja el id crudo si la tienda no está en el mapa (mejor que una celda vacía)", () => {
    expect(cell(row({ store_id: "desconocida" }), "Tienda")).toBe("desconocida");
  });

  // La hoja tiene que poder leerse sin traducir códigos a mano.
  it("usa las mismas etiquetas que la tabla", () => {
    const r = row();
    expect(cell(r, "Macroetapa")).toBe("Por confirmar");
    expect(cell(r, "Subetapa")).toBe("Sin llamar");
    expect(cell(r, "Cobertura")).toBe("Provincia COD");
  });

  it("el teléfono sale como texto para no perder el formato en Excel", () => {
    const columna = MASTER_EXPORT_COLUMNS.find((c) => c.header === "Teléfono");
    expect(columna?.kind).toBe("text");
    expect(cell(row(), "Teléfono")).toBe("51910876229");
  });

  it("las fechas salen como Date, no como texto", () => {
    expect(cell(row(), "Creado")).toBeInstanceOf(Date);
    expect(cell(row({ delivered_at: daysAgo(1) }), "Entregado")).toBeInstanceOf(Date);
  });

  it("una fecha ausente deja la celda vacía en vez de 'Invalid Date'", () => {
    expect(cell(row({ delivered_at: null }), "Entregado")).toBeNull();
    expect(cell(row({ order_created_at: "no-es-fecha" }), "Creado")).toBeNull();
  });

  it("los nulos de texto salen vacíos, no 'null'", () => {
    const r = row({ customer_name: null, guide_code: null, current_courier: null });
    expect(cell(r, "Cliente")).toBe("");
    expect(cell(r, "Guía")).toBe("");
    expect(cell(r, "Courier actual")).toBe("");
  });

  it("incluye la devolución, que la tabla no enseña", () => {
    expect(cell(row({ returned_at: daysAgo(3) }), "Devuelto")).toBeInstanceOf(Date);
  });

  it("cada fila tiene tantas celdas como columnas", () => {
    expect(toExportRow(row(), ctx)).toHaveLength(MASTER_EXPORT_COLUMNS.length);
  });

  it("no hay cabeceras repetidas", () => {
    const headers = MASTER_EXPORT_COLUMNS.map((c) => c.header);
    expect(new Set(headers).size).toBe(headers.length);
  });
});

describe("ageInDays", () => {
  it("cuenta desde el último movimiento", () => {
    expect(ageInDays(row({ last_movement_at: daysAgo(5) }), NOW)).toBe(5);
  });

  it("sin movimiento, cuenta desde la creación", () => {
    expect(ageInDays(row({ last_movement_at: null, order_created_at: daysAgo(9) }), NOW)).toBe(9);
  });

  it("sin ninguna fecha devuelve null", () => {
    expect(ageInDays(row({ last_movement_at: null, order_created_at: null }), NOW)).toBeNull();
  });

  // Un reloj adelantado no debe producir antigüedades negativas.
  it("nunca es negativa", () => {
    expect(ageInDays(row({ last_movement_at: new Date(NOW.getTime() + DAY_MS).toISOString() }), NOW)).toBe(0);
  });
});

describe("exportFilename", () => {
  it("lleva la pestaña y la fecha", () => {
    expect(exportFilename("por_confirmar", NOW)).toBe("pedidos_por_confirmar_2026-08-07.xlsx");
  });

  it("sin pestaña concreta, solo la fecha", () => {
    expect(exportFilename("todos", NOW)).toBe("pedidos_2026-08-07.xlsx");
    expect(exportFilename(null, NOW)).toBe("pedidos_2026-08-07.xlsx");
  });

  // Distinguir la selección importa: es la diferencia que no se puede
  // reconstruir después mirando el contenido del fichero.
  it("una selección se nombra como tal, por encima de la pestaña", () => {
    expect(exportFilename(null, NOW, true)).toBe("pedidos_seleccion_2026-08-07.xlsx");
    expect(exportFilename("por_confirmar", NOW, true)).toBe("pedidos_seleccion_2026-08-07.xlsx");
  });

  it("por defecto no es una selección", () => {
    expect(exportFilename("por_confirmar", NOW, false)).toBe(
      "pedidos_por_confirmar_2026-08-07.xlsx",
    );
  });
});
