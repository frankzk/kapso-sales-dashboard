import { describe, expect, it } from "vitest";
import { drain } from "@/lib/voice-recovery-server";

// PostgREST corta en 1000 filas sin avisar. El 24-09-2026 la subetapa tenía
// 1338 pedidos y la cola del agente salió vacía todo el día.
describe("drain", () => {
  const table = Array.from({ length: 2338 }, (_, i) => ({ id: i }));
  const fake = (from: number, to: number) =>
    Promise.resolve({ data: table.slice(from, Math.min(to + 1, from + 1000)), error: null });

  it("lee más allá de las 1000 filas", async () => {
    expect(await drain("order_master", fake)).toHaveLength(2338);
  });

  it("para con una página justa de 1000 y con la tabla vacía", async () => {
    const exact = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    let calls = 0;
    const rows = await drain("t", (from, to) => {
      calls++;
      return Promise.resolve({ data: exact.slice(from, to + 1), error: null });
    });
    expect(rows).toHaveLength(1000);
    expect(calls).toBe(2);
    expect(await drain("t", () => Promise.resolve({ data: null, error: null }))).toEqual([]);
  });

  it("un error no se traga en silencio", async () => {
    await expect(drain("shipments", () => Promise.resolve({ data: null, error: { message: "boom" } }))).rejects.toThrow(
      "shipments: boom",
    );
  });
});
