// «Pasar a Costos» nunca borra un costo que una persona cargó desde la llegada
// o después (14-11-2026); Costos, a mano, sí lo reemplaza.
import { describe, expect, it } from "vitest";
import { insertProductCostPeriod } from "@/lib/product-cost-periods";

function fakeAdmin(open: { id: string; effective_from: string }[]) {
  const calls: string[] = [];
  const builder = (op: string) => {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    Object.assign(b, {
      select: chain, eq: chain, is: chain,
      update: () => { calls.push("update"); return b; },
      delete: () => { calls.push("delete"); return b; },
      insert: () => { calls.push("insert"); return Promise.resolve({ error: null }); },
      then: (resolve: (v: unknown) => unknown) => resolve(op === "select" ? { data: open, error: null } : { error: null }),
    });
    return b;
  };
  const admin = { from: () => ({ select: () => builder("select"), update: () => { calls.push("update"); return builder("w"); }, delete: () => { calls.push("delete"); return builder("w"); }, insert: () => { calls.push("insert"); return Promise.resolve({ error: null }); } }) };
  return { admin: admin as never, calls };
}
const period = { org_id: "o", store_id: null, sku: "SKU1", product_name: "P", supplier: null, batch: "IMP-2026-001", unit_cost: 10, effective_from: "2026-11-10", created_by: "u" };

describe("insertProductCostPeriod", () => {
  it("keep: con un costo abierto desde la llegada o después no borra ni escribe", async () => {
    const { admin, calls } = fakeAdmin([{ id: "c1", effective_from: "2026-11-12" }]);
    const res = await insertProductCostPeriod(admin, period, { laterOpen: "keep" });
    expect(res.laterFrom).toBe("2026-11-12");
    expect(calls).toEqual([]);
  });
  it("replace (Costos a mano): lo reemplaza como siempre", async () => {
    const { admin, calls } = fakeAdmin([{ id: "c1", effective_from: "2026-11-12" }]);
    const res = await insertProductCostPeriod(admin, period);
    expect(res.error).toBeUndefined();
    expect(calls).toEqual(["delete", "insert"]);
  });
  it("un costo anterior se cierra el día anterior y se abre el nuevo", async () => {
    const { admin, calls } = fakeAdmin([{ id: "c0", effective_from: "2026-10-01" }]);
    expect(await insertProductCostPeriod(admin, period, { laterOpen: "keep" })).toEqual({});
    expect(calls).toEqual(["update", "insert"]);
  });
});
