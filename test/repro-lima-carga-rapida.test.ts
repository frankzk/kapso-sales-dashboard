// Owner, 21-11-2026: «Repro Lima anda cargando súper lento». Los lotes de 100 ids
// iban uno tras otro (15 por tabla con 1.417 pedidos) y la lectura de pendientes
// esperaba etapas que no dependían entre sí. La regla del negocio no cambia: solo
// cuánto se espera. Y queda una línea por carga en los logs para medirlo.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("Repro Lima carga sin esperas en fila", () => {
  const src = read("lib/repro-lima-pending-access.ts");
  const body = src.slice(src.indexOf("export async function loadLimaPending("));

  it("las salidas de Grupo GF y las guías por recoger van junto a las demás lecturas", () => {
    const wave = body.slice(body.indexOf("departureRows, pickupRows] = await Promise.all(["), body.indexOf("for (const d of departureRows)"));
    expect(wave).toContain("loadGfPlanFacts(");
    expect(wave).toContain('admin.rpc("gf_order_departures", { p_order_ids: batch })');
    expect(wave).toContain('.in("courier", ["aliclik", "gf_courier"])');
  });

  it("ningún lote se espera dentro de un bucle", () => {
    expect(body).not.toMatch(/for \(let offset[^\n]*\n[^\n]*await /);
    expect(src).toContain("return (await Promise.all(batches.map(read))).flat();");
  });

  it("los que nunca salieron y los reprogramados por GF se leen junto a los días de GF Courier", () => {
    const start = body.indexOf("const [gfPickups, gfAssigned, neverLeftRows, gfReschedules] = await Promise.all([");
    expect(start).toBeGreaterThan(-1);
    const last = body.slice(start, body.indexOf("]);", start));
    expect(last).toContain("inBatchesOf500(neverLeftCandidates,");
    // Reprogramado por GF tras la novedad (21-11-2026, #KP207270): en la misma espera, sin una más.
    expect(last).toContain("loadGfReschedules(admin, incidentGuides).catch(() => new Map<string, string>())");
  });

  it("cada carga deja su tiempo en los logs", () => {
    const page = read("app/dashboard/pedidos/repro-lima/page.tsx");
    expect(page).toContain('timed(times, "casos", loadReproLima(');
    expect(page).toContain('timed(times, "pendientes", loadLimaPending(');
    expect(page).toContain("console.info(`[repro-lima] carga ${JSON.stringify({ totalMs: Date.now() - started, ...times })}`);");
  });
});
