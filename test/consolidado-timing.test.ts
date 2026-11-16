// Una semana midiendo el Consolidado (16-11-2026).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONSOLIDADO_TIMING_UNTIL, consolidadoTimer } from "@/lib/consolidado-timing";

describe("consolidadoTimer", () => {
  it("anota cada consulta, el total, la más lenta y si fue en frío", async () => {
    let clock = 0;
    const lines: string[] = [];
    const timer = consolidadoTimer({ now: () => clock, log: (l) => lines.push(l), until: "2999-01-01T00:00:00Z" });
    const a = timer.time("rollups", Promise.resolve(1).then((v) => { clock += 300; return v; }));
    expect(await a).toBe(1);
    const b = timer.time("pedidos", Promise.reject(new Error("x")).finally(() => { clock += 900; }));
    await expect(b).rejects.toThrow("x");
    const line = timer.done({ tiendas: 2 })!;
    expect(line).toMatchObject({ totalMs: 1200, cold: true, slowest: "pedidos", tiendas: 2, ms: { rollups: 300, pedidos: 900 } });
    expect(lines[0]).toMatch(/^\[consolidado-timing\] \{/);
    // La segunda página de la misma instancia ya no es en frío.
    expect(consolidadoTimer({ now: () => 0, log: () => {}, until: "2999-01-01T00:00:00Z" }).done()).toMatchObject({ cold: false });
  });

  it("pasada la semana no escribe nada", () => {
    expect(CONSOLIDADO_TIMING_UNTIL).toBe("2026-11-23T05:00:00Z");
    const lines: string[] = [];
    expect(consolidadoTimer({ log: (l) => lines.push(l), until: "2000-01-01T00:00:00Z" }).done()).toBeNull();
    expect(lines).toEqual([]);
  });

  it("el Consolidado mide su bloque principal", () => {
    const page = readFileSync(resolve(process.cwd(), "app/dashboard/page.tsx"), "utf8");
    expect(page).toContain("const timer = consolidadoTimer();");
    expect(page).toContain('t("rollups", getRollups(storeIds, range))');
    expect(page).toContain("timer.done(");
  });
});
