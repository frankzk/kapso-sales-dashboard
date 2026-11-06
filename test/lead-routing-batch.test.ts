import { describe, expect, it } from "vitest";
import {
  SINGLE_LEAD_SCOPE_MAX,
  createBlockedLeadChecker,
  mapBounded,
  type ScopeReader,
} from "@/lib/lead-routing-batch";

/**
 * 06-11-2026: la rotación de Yapes leía la cola ENTERA (`lead_routing_scope`
 * sin lead, ~1 s de base) de cada asesora en línea, en cada pestaña, cada
 * 15 s. Aquí se fija que un puñado de leads se pregunta de a uno (~decenas de
 * ms), que nada se pregunta dos veces en la misma pasada y que la respuesta es
 * la misma que la de la cola entera.
 */

/** Una base de mentira: la asesora `a` tiene bloqueados `blocked[a]`. */
function fakeScope(blocked: Record<string, string[]>) {
  const calls: Array<{ actor: string; storeIds: string[]; leadId: string | null }> = [];
  const read: ScopeReader = async (actor, storeIds, leadId) => {
    calls.push({ actor, storeIds, leadId });
    const all = blocked[actor] ?? [];
    // Igual que la función SQL: con lead, solo ese lead puede salir bloqueado.
    return { blockedIds: leadId === null ? all : all.filter((id) => id === leadId) };
  };
  return { read, calls };
}

describe("createBlockedLeadChecker", () => {
  it("asks one lead at a time when there are few, with the same answer as the whole queue", async () => {
    const { read, calls } = fakeScope({ A: ["y1", "x9"] });
    const blockedFor = createBlockedLeadChecker(read, ["store-1"]);
    expect(await blockedFor("A", ["y1", "y2"])).toEqual(new Set(["y1"]));
    expect(calls).toEqual([
      { actor: "A", storeIds: ["store-1"], leadId: "y1" },
      { actor: "A", storeIds: ["store-1"], leadId: "y2" },
    ]);
  });

  it("never asks twice for the same advisor and lead in one pass", async () => {
    const { read, calls } = fakeScope({ A: ["y1"] });
    const blockedFor = createBlockedLeadChecker(read, ["s"]);
    await blockedFor("A", ["y1"]);
    expect(await blockedFor("A", ["y1", "y1"])).toEqual(new Set(["y1"]));
    expect(calls).toHaveLength(1);
    await blockedFor("B", ["y1"]);
    expect(calls).toHaveLength(2); // otra asesora, otra pregunta
  });

  it("reads the whole queue once when there are many leads, then answers from it", async () => {
    const ids = Array.from({ length: SINGLE_LEAD_SCOPE_MAX + 1 }, (_, i) => `y${i}`);
    const { read, calls } = fakeScope({ A: ["y0", "y3", "elsewhere"] });
    const blockedFor = createBlockedLeadChecker(read, ["s"]);
    expect(await blockedFor("A", ids)).toEqual(new Set(["y0", "y3"]));
    expect(await blockedFor("A", ["y3", "z"])).toEqual(new Set(["y3"]));
    expect(calls).toEqual([{ actor: "A", storeIds: ["s"], leadId: null }]);
  });

  it("propagates a failed read (the caller decides, as before)", async () => {
    const blockedFor = createBlockedLeadChecker(async () => {
      throw new Error("No se pudo comprobar la asignación de leads.");
    }, ["s"]);
    await expect(blockedFor("A", ["y1"])).rejects.toThrow("asignación");
  });
});

describe("mapBounded", () => {
  it("keeps order and never runs more than the limit at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapBounded([5, 1, 4, 2, 3, 0], 2, async (ms) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
      return ms * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
  });

  it("handles an empty list", async () => {
    expect(await mapBounded([], 3, async () => 1)).toEqual([]);
  });
});
