import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { allCourierRows, COURIER_ROWS_CONCURRENCY, courierRowsByIds, nextDispatchMode } from "../lib/courier-flow";

describe("next task, not repeated assignment", () => {
  it("preserves load membership and custody against legacy route actions", () => {
    const source = readFileSync(new URL("../app/dashboard/rutas/actions.ts", import.meta.url), "utf8");
    for (const name of ["addStops", "removeStop", "startRoute"]) {
      const body = source.split("export async function " + name)[1]?.split("export async function ")[0] ?? "";
      expect(body).toContain("await gfPlanningBlocker(");
      expect(body).toContain("if (gfBlocker) return");
    }
  });
  it("opens an assigned draft directly in office verification", () => {
    expect(nextDispatchMode({ state: "draft", kind: "reparto", items: [{}] }, true)).toBe("office");
  });
  it("opens an empty box for planning and ignores removed packages", () => {
    expect(nextDispatchMode({ state: "draft", kind: "reparto", items: [{ removed_at: "now" }] }, true)).toBe("build");
  });
  it("moves to receipt only after office completion", () => {
    expect(nextDispatchMode({ state: "ready_for_pickup", kind: "reparto", items: [{ office_checked_at: "now" }] }, true)).toBe("pickup");
    expect(nextDispatchMode({ state: "ready_for_pickup", kind: "entrega_courier", items: [{ office_checked_at: "now" }] }, true)).toBe("office");
  });
  it("does not offer assignment to pickup-only staff", () => {
    expect(nextDispatchMode({ state: "draft", kind: "reparto", items: [] }, false)).toBe("pickup");
  });
});

describe("whole eligible universe", () => {
  it("loads beyond 300 and beyond the database row cap", async () => {
    const source = Array.from({ length: 1247 }, (_, i) => i);
    const result = await allCourierRows(async (from, to) => ({ data: source.slice(from, to + 1), error: null }));
    expect(result).toEqual(source);
    expect(result.includes(1246)).toBe(true);
  });
  it("handles an exact full page and an empty source", async () => {
    const source = Array.from({ length: 500 }, (_, i) => i);
    expect(await allCourierRows(async (from, to) => ({ data: source.slice(from, to + 1), error: null }))).toEqual(source);
    expect(await allCourierRows(async () => ({ data: [], error: null }))).toEqual([]);
  });
  it("does not present a partial read as a complete list", async () => {
    await expect(allCourierRows(async () => ({ data: null, error: { message: "unavailable" } }))).rejects.toThrow("unavailable");
  });
  it("chunks dependent lookups without omitting older rows", async () => {
    const ids = Array.from({ length: 1107 }, (_, i) => String(i));
    const result = await courierRowsByIds(ids, async (batch) => {
      expect(batch.length).toBeLessThanOrEqual(100);
      return { data: batch, error: null };
    });
    expect(result.data).toEqual(ids);
  });
  // Owner, 21-11-2026: «Repro Lima anda cargando súper lento». Los lotes iban de a uno.
  it("lee hasta cuatro lotes a la vez y devuelve las filas en el orden de los lotes", async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => String(i));
    let inFlight = 0;
    let peak = 0;
    const result = await courierRowsByIds(ids, async (batch) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // El primer lote tarda más: igual tiene que salir primero.
      await new Promise((resolve) => setTimeout(resolve, batch[0] === "0" ? 20 : 1));
      inFlight--;
      return { data: batch, error: null };
    });
    expect(peak).toBe(COURIER_ROWS_CONCURRENCY);
    expect(COURIER_ROWS_CONCURRENCY).toBe(4);
    expect(result.data).toEqual(ids);
  });
  it("un lote con error corta la lectura: nunca una lista parcial", async () => {
    const ids = Array.from({ length: 700 }, (_, i) => String(i));
    await expect(courierRowsByIds(ids, async (batch) => (
      batch[0] === "300" ? { data: null, error: { message: "caído" } } : { data: batch, error: null }
    ))).rejects.toThrow("caído");
    expect((await courierRowsByIds([], async () => ({ data: ["x"], error: null }))).data).toEqual([]);
  });
});
