import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planSweep, SWEEP_CYCLE_MAX_AGE_MS, type SweepCursor } from "@/lib/aliclik-sweep-state";
import { followUpFreshSince, FOLLOW_UP_FRESH_MS, selectFollowUpGuides, type FollowUpCandidate } from "@/lib/aliclik-followup";

// 0217: el barrido de Aliclik dejó de completarse el 29-09-2026 porque cada
// pasada cortada volvía a la página 1, y el pase de rezagadas excluía a toda
// guía leída después del último barrido completo. Estas pruebas fijan los dos
// arreglos.

const NOW = new Date("2026-10-02T17:20:00.000Z");
const LOOKBACK = 14 * 86_400_000;

const cursor = (over: Partial<SweepCursor> = {}): SweepCursor => ({
  cycleStartedAt: "2026-10-02T17:00:00.000Z",
  cycleFrom: "2026-09-18T17:00:00.000Z",
  resumePage: 7,
  ...over,
});

describe("planSweep — el barrido sigue donde se quedó", () => {
  it("sin cursor empieza un ciclo nuevo por la página 1, con ventana de 14 días", () => {
    const plan = planSweep(null, NOW, LOOKBACK);
    expect(plan.startPage).toBe(1);
    expect(plan.resumed).toBe(false);
    expect(plan.cycleStartedAt).toEqual(NOW);
    expect(plan.windowFrom.toISOString()).toBe("2026-09-18T17:20:00.000Z");
  });

  it("con un ciclo cortado continúa su página, con SU ventana y SU inicio", () => {
    const plan = planSweep(cursor(), NOW, LOOKBACK);
    expect(plan.startPage).toBe(7);
    expect(plan.resumed).toBe(true);
    // El inicio del CICLO es la evidencia de §10.2: una intención nacida a mitad
    // del ciclo no cuenta como buscada aunque el ciclo termine después.
    expect(plan.cycleStartedAt.toISOString()).toBe("2026-10-02T17:00:00.000Z");
    expect(plan.windowFrom.toISOString()).toBe("2026-09-18T17:00:00.000Z");
  });

  it("un ciclo demasiado viejo se descarta y se vuelve a la página 1", () => {
    const old = new Date(NOW.getTime() - SWEEP_CYCLE_MAX_AGE_MS - 60_000).toISOString();
    expect(planSweep(cursor({ cycleStartedAt: old }), NOW, LOOKBACK).startPage).toBe(1);
  });

  it("ante un cursor ilegible o sin página útil, página 1", () => {
    expect(planSweep(cursor({ cycleStartedAt: "no es fecha" }), NOW, LOOKBACK).startPage).toBe(1);
    expect(planSweep(cursor({ cycleFrom: "" }), NOW, LOOKBACK).startPage).toBe(1);
    expect(planSweep(cursor({ resumePage: 1 }), NOW, LOOKBACK).startPage).toBe(1);
    expect(planSweep(cursor({ resumePage: Number.NaN }), NOW, LOOKBACK).startPage).toBe(1);
  });

  it("la ruta del barrido usa el plan y anota dónde seguir", () => {
    const src = readFileSync(join(process.cwd(), "app/api/cron/aliclik-reconcile/route.ts"), "utf8");
    expect(src).toContain("planSweep(await readSweepCursor(admin, storeId)");
    expect(src).toContain("for (let page = plan.startPage; page <= lastPage; page++)");
    expect(src).toContain("startedAt: plan.cycleStartedAt");
    expect(src).toContain("resumePage: sweepComplete ? null : resumePage");
  });
});

describe("followUpFreshSince — «recién leída» es una ventana fija", () => {
  const guide = (over: Partial<FollowUpCandidate>): FollowUpCandidate => ({
    id: "g", external_order_number: "AUR5X833230866120", guide_code: null,
    delivery_status: "en_ruta", last_report_at: "2026-09-25T23:59:09.036Z",
    created_at: "2026-09-18T00:29:53.560Z", ...over,
  });

  it("vale 30 minutos hacia atrás", () => {
    expect(NOW.getTime() - followUpFreshSince(NOW).getTime()).toBe(FOLLOW_UP_FRESH_MS);
    expect(FOLLOW_UP_FRESH_MS).toBe(30 * 60_000);
  });

  it("una guía leída hace días vuelve a tener turno aunque no haya barrido completo reciente (#AUR177107)", () => {
    const selection = selectFollowUpGuides(
      [guide({ id: "vieja", api_report_at: "2026-09-29T17:44:02.538Z" }), guide({ id: "fresca", api_report_at: "2026-10-02T17:05:00.000Z" })],
      { refreshedSince: followUpFreshSince(NOW), limit: 150, maxSilenceMs: 60 * 86_400_000, now: NOW },
    );
    expect(selection.due.map((g) => g.id)).toEqual(["vieja"]);
  });

  it("el cierre ya no excluye por el inicio del último barrido completo", () => {
    const src = readFileSync(join(process.cwd(), "app/api/cron/aliclik-close/route.ts"), "utf8");
    expect(src).toContain("const refreshedSince = followUpFreshSince(now);");
    expect(src).not.toContain("const sweptAt = sweep ? new Date(sweep.startedAt) : null;");
  });
});
