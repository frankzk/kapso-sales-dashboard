import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { phoneKey, priorCountsByOrder, priorCountsLabel } from "@/lib/customer-prior-counts";

// La etiqueta «¿tuvo pedidos antes?» del panel de Repro Lima (owner, 13-11-2026; MOM §8.1).
const row = (order_id: string, customer_phone: string | null, general_status: string | null, macro_stage = "finalizado") =>
  ({ order_id, customer_phone, general_status, macro_stage });

describe("priorCountsByOrder", () => {
  it("cuenta los otros pedidos del mismo teléfono, sin el propio, y en qué terminaron", () => {
    const counts = priorCountsByOrder(
      [{ order_id: "a", customer_phone: "987654321" }],
      [row("a", "987654321", null, "en_curso"), row("b", "987654321", "entregado"), row("c", "987654321", "devuelto"), row("d", "987654321", "anulado"), row("e", "911111111", "entregado")],
    );
    expect(counts.get("a")).toEqual({ others: 3, delivered: 1, failed: 2 });
  });

  it("primer pedido: cero otros; sin teléfono: sin dato (no aparece)", () => {
    const counts = priorCountsByOrder(
      [{ order_id: "a", customer_phone: "987654321" }, { order_id: "z", customer_phone: null }],
      [row("a", "987654321", null, "en_curso")],
    );
    expect(counts.get("a")).toEqual({ others: 0, delivered: 0, failed: 0 });
    expect(counts.has("z")).toBe(false);
  });

  it("el teléfono se compara por sus últimos 9 dígitos", () => {
    expect(phoneKey("+51 987 654 321")).toBe("987654321");
    expect(phoneKey("12345")).toBeNull();
    const counts = priorCountsByOrder([{ order_id: "a", customer_phone: "987654321" }], [row("b", "51987654321", "entregado")]);
    expect(counts.get("a")?.others).toBe(1);
  });
});

describe("priorCountsLabel", () => {
  it("dice primer pedido, recibidos en verde y «ninguno recibido» en rojo", () => {
    expect(priorCountsLabel({ others: 0, delivered: 0, failed: 0 })).toMatchObject({ text: "Primer pedido", tone: "info" });
    expect(priorCountsLabel({ others: 3, delivered: 2, failed: 1 })).toMatchObject({ text: "3 pedidos más · 2 recibidos", tone: "ok" });
    expect(priorCountsLabel({ others: 1, delivered: 1, failed: 0 }).text).toBe("1 pedido más · 1 recibido");
    expect(priorCountsLabel({ others: 2, delivered: 0, failed: 2 })).toMatchObject({ text: "2 pedidos más · ninguno recibido", tone: "crit" });
    expect(priorCountsLabel({ others: 1, delivered: 0, failed: 0 })).toMatchObject({ text: "1 pedido más", tone: "neutral" });
  });
});

describe("el panel de Repro Lima", () => {
  const list = readFileSync("components/repro-lima-pending.tsx", "utf8");
  const actions = readFileSync("app/dashboard/pedidos/repro-lima/prior-counts-actions.ts", "utf8");
  it("pide los conteos solo de las filas visibles y los muestra en la tabla y en el celular", () => {
    expect(list).toContain("usePriorCounts(visible.map((row) => row.orderId))");
    expect(list.match(/<PriorCountsTag counts=\{priors\.get\(row\.orderId\)\} \/>/g)?.length).toBe(2);
  });
  it("la acción pide el permiso de Repro Lima y se queda en las tiendas de quien mira", () => {
    const body = actions.slice(actions.indexOf("export async function loadPriorOrderCounts("));
    expect(body).toContain("requireReproLima({ retries: true })");
    expect(body.match(/\.in\("store_id", stores\)/g)?.length).toBe(2);
    expect(body).toContain("PRIOR_COUNTS_MAX_ORDERS");
  });
});

it("el MOM documenta la etiqueta del panel (§8.1)", () => {
  expect(readFileSync("docs/mom/master-pedidos-v1.md", "utf8")).toContain("Y una etiqueta en el panel de Repro Lima (13-11-2026");
});
