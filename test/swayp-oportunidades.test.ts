import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { FenixStockRow } from "@/lib/fenix";
import {
  buildSwaypOportunidades,
  direccionCompleta,
  origenDeOportunidad,
  type OportunidadItem,
  type OportunidadMasterRow,
} from "@/lib/swayp-oportunidades";

/**
 * Oportunidades en Stock Swayp (10-10-2026): qué mandar a cada bodega para que
 * salgan pedidos de Repro Provincia y de Por confirmar que hoy esperan.
 */

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");
const NOW = new Date("2026-10-10T17:00:00Z");

const OIL = { title: "ETHIOPIAN OIL", sku: "AURE003" };
const SERUM = { title: "NAILS REPAIRING - SERUM PARA UÑAS", sku: "AURE020" };
const PULSERA = { title: "Crucis+ Pulsera Magnética de Cobre", sku: "645731546" };

const stock: FenixStockRow[] = [
  { id: "s-aqp-oil", city: "arequipa", product: "ETHIOPIAN OIL", sku: "AURE003", quantity: 1 },
  { id: "s-aqp-serum", city: "arequipa", product: "NAILS REPAIRING - SERUM PARA UÑAS", sku: "AURE020", quantity: 0 },
  { id: "s-hyo-oil", city: "huancayo", product: "ETHIOPIAN OIL", sku: "AURE003", quantity: 5 },
];

const AREQUIPA = { district: "Cayma", province: "Arequipa", region: "Arequipa" };
const CUSCO = { district: "Wanchaq", province: "Cusco", region: "Cusco" };
const HUANCAYO = { district: "Chupaca", province: "Chupaca", region: "Junín" };
const IQUITOS = { district: "Iquitos", province: "Maynas", region: "Loreto" };
const LIMA = { district: "Miraflores", province: "Lima", region: "Lima" };

function pedido(
  id: string,
  kind: "repro" | "por_confirmar",
  destino: { district: string; province: string; region: string },
  over: Partial<OportunidadMasterRow> = {},
): OportunidadMasterRow {
  return {
    order_id: id,
    order_name: `#${id}`,
    macro_stage: kind === "repro" ? "en_curso" : "por_confirmar",
    macro_substage: kind === "repro" ? "gestion_reproprovincia" : "por_confirmar",
    macro_since: "2026-10-05T12:00:00Z",
    coverage: "provincia_cod",
    address: "Calle Falsa 123",
    order_total: 149,
    ...destino,
    ...over,
  };
}

describe("quién entra", () => {
  it("Repro Provincia, y Por confirmar con la misma regla que el botón «Enviar por Swayp»", () => {
    expect(origenDeOportunidad({ macro_stage: "en_curso", macro_substage: "gestion_reproprovincia", coverage: "provincia_cod" })).toBe("repro");
    expect(origenDeOportunidad({ macro_stage: "por_confirmar", macro_substage: "por_confirmar", coverage: "provincia_cod" })).toBe("por_confirmar");
    expect(origenDeOportunidad({ macro_stage: "por_confirmar", macro_substage: "sin_llamar", coverage: "provincia_cod" })).toBe("por_confirmar");
  });

  it("no: «Swayp no entregó», Lima ni las demás etapas", () => {
    expect(origenDeOportunidad({ macro_stage: "por_confirmar", macro_substage: "swayp_no_entrego", coverage: "provincia_cod" })).toBeNull();
    expect(origenDeOportunidad({ macro_stage: "por_confirmar", macro_substage: "por_confirmar", coverage: "lima_cod" })).toBeNull();
    expect(origenDeOportunidad({ macro_stage: "en_curso", macro_substage: "en_transito", coverage: "provincia_cod" })).toBeNull();
  });

  it("la dirección completa es dirección, distrito y provincia (o departamento)", () => {
    expect(direccionCompleta({ address: "Av. 1", district: "Cayma", province: "Arequipa", region: null })).toBe(true);
    expect(direccionCompleta({ address: "Av. 1", district: "Cayma", province: null, region: "Arequipa" })).toBe(true);
    expect(direccionCompleta({ address: " ", district: "Cayma", province: "Arequipa", region: null })).toBe(false);
    expect(direccionCompleta({ address: "Av. 1", district: null, province: "Arequipa", region: null })).toBe(false);
  });
});

describe("qué mandar a dónde", () => {
  const master: OportunidadMasterRow[] = [
    pedido("A", "repro", AREQUIPA),
    pedido("B", "por_confirmar", AREQUIPA, { order_total: 200, macro_since: "2026-10-01T12:00:00Z" }),
    pedido("C", "por_confirmar", AREQUIPA),
    pedido("D", "repro", IQUITOS),
    pedido("E", "por_confirmar", AREQUIPA, { address: null }),
    pedido("F", "repro", LIMA),
    pedido("G", "repro", HUANCAYO),
    pedido("H", "repro", CUSCO),
    pedido("I", "repro", CUSCO, { order_total: 99 }),
    pedido("J", "por_confirmar", AREQUIPA, { macro_stage: "en_curso", macro_substage: "en_transito" }),
  ];
  const items = new Map<string, OportunidadItem[]>([
    ["A", [{ ...OIL, quantity: 1 }]],
    ["B", [{ ...OIL, quantity: 1 }]],
    ["C", [{ ...SERUM, quantity: 1 }, { ...OIL, quantity: 1 }]],
    ["D", [{ ...OIL, quantity: 1 }]],
    ["E", [{ ...OIL, quantity: 1 }]],
    ["F", [{ ...OIL, quantity: 1 }]],
    ["G", [{ ...OIL, quantity: 1 }]],
    ["H", [{ ...PULSERA, quantity: 2 }]],
    ["I", [{ ...PULSERA, quantity: 1 }]],
    ["J", [{ ...OIL, quantity: 1 }]],
  ]);
  const { rows, resumen } = buildSwaypOportunidades(stock, master, items, NOW);
  const fila = (city: string, sku: string) => rows.find((r) => r.city === city && r.sku === sku);

  it("con stock que no alcanza: 1 en bodega para 3 pedidos son 2 por mandar", () => {
    const oil = fila("arequipa", "AURE003")!;
    expect(oil.unidades).toBe(3);
    expect(oil.stock).toBe(1);
    expect(oil.faltan).toBe(2);
    expect(oil.repro).toBe(1);
    expect(oil.porConfirmar).toBe(2);
    expect(oil.stockId).toBe("s-aqp-oil");
  });

  it("en 0 en la bodega: todo lo que piden", () => {
    const serum = fila("arequipa", "AURE020")!;
    expect(serum.faltan).toBe(1);
    expect(serum.pedidos.map((p) => p.orderId)).toEqual(["C"]);
  });

  it("un producto que la bodega ni tiene anotado también es oportunidad, con sus unidades", () => {
    const pulsera = fila("cusco", "645731546")!;
    expect(pulsera.stockId).toBeNull();
    expect(pulsera.faltan).toBe(3);
    expect(pulsera.pedidos).toHaveLength(2);
    expect(pulsera.valor).toBe(149 + 99);
  });

  it("marca a quién le falta solo ese producto", () => {
    const oil = fila("arequipa", "AURE003")!;
    const solo = Object.fromEntries(oil.pedidos.map((p) => [p.orderId, p.soloEste]));
    expect(solo).toEqual({ A: true, B: true, C: false });
    expect(oil.soloEste).toBe(2);
    // Primero los que salen solo con esto; entre ellos, el que más espera.
    expect(oil.pedidos.map((p) => p.orderId)).toEqual(["B", "A", "C"]);
    expect(oil.pedidos[0]!.dias).toBe(9);
  });

  it("lo cubierto no aparece: Huancayo tiene 5 para 1", () => {
    expect(rows.some((r) => r.city === "huancayo")).toBe(false);
  });

  it("sin bodega, sin dirección, Lima y otras etapas no entran", () => {
    expect(resumen.fueraDeCobertura).toBe(1); // D, Iquitos
    expect(resumen.sinDireccion).toBe(1); // E
    const ids = new Set(rows.flatMap((r) => r.pedidos.map((p) => p.orderId)));
    expect([...ids].sort()).toEqual(["A", "B", "C", "H", "I"]);
  });

  it("el resumen cuenta pedidos, no filas", () => {
    expect(resumen).toEqual({ pedidos: 5, repro: 3, porConfirmar: 2, fueraDeCobertura: 1, sinDireccion: 1 });
  });

  it("primero lo que destraba más pedidos", () => {
    expect(rows.map((r) => `${r.city}:${r.sku}`)).toEqual(["arequipa:AURE003", "cusco:645731546", "arequipa:AURE020"]);
  });
});

describe("la pantalla", () => {
  it("lee del Master las dos fuentes, con la sesión de quien mira", () => {
    const page = read("app/dashboard/envios/stock/page.tsx");
    expect(page).toContain('.or("macro_substage.eq.gestion_reproprovincia,macro_stage.eq.por_confirmar")');
    expect(page).toContain("oportunidades={oportunidades}");
  });

  it("una lectura que falla se dice, no se muestra como lista vacía", () => {
    expect(read("app/dashboard/envios/stock/page.tsx").match(/if \(error\) return null;/g) ?? []).toHaveLength(2);
    expect(read("components/fenix-stock.tsx")).toContain("No se pudieron leer los pedidos del Master.");
  });

  it("tiene su tarjeta y su tabla, con enlace a cada pedido", () => {
    const ui = read("components/fenix-stock.tsx");
    expect(ui).toContain('label="Oportunidades"');
    expect(ui).toContain("<OportunidadesSection");
    expect(ui).toContain("href={`/dashboard/pedidos?abrir=${encodeURIComponent(p.orderId)}`}");
  });
});
