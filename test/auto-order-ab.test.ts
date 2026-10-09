import { describe, it, expect } from "vitest";
import {
  abArm,
  abRow,
  cohortIsLive,
  enrollAbCohorts,
  limaDayStartIso,
  type AbCandidate,
  type AbCohort,
  type AbDeps,
} from "@/lib/auto-order-ab";

// Prueba A/B de recompra (MOM, 09-10-2026; 0238): cada carrito que cumple la
// regla se sortea entre `auto` (se genera el pedido) y `control` (se queda en la
// cola). Se mide entregados por carrito en cada mitad.

const COHORT = "ab-recompra-prov-1";
const NOW = Date.parse("2026-10-12T15:00:00Z");

const cohort = (over: Partial<AbCohort> = {}): AbCohort => ({
  cohort: COHORT,
  enabled: true,
  starts_at: "2026-10-10T00:00:00Z",
  ends_at: "2026-10-24T00:00:00Z",
  max_enroll_per_day: 30,
  ...over,
});

const cand = (n: number, over: Partial<AbCandidate> = {}): AbCandidate => ({
  lead_id: `lead-${n}`,
  draft_order_gid: `gid://shopify/DraftOrder/${1000 + n}`,
  draft_name: `#D${1000 + n}`,
  cart_created_at: new Date(NOW - (10 + n) * 3_600_000).toISOString(),
  phone9: `9${String(n).padStart(8, "0")}`,
  same_district: true,
  ...over,
});

describe("abArm (la moneda)", () => {
  it("el mismo carrito cae siempre en la misma mitad", () => {
    const gid = "gid://shopify/DraftOrder/1352025080103";
    expect(abArm(COHORT, gid)).toBe(abArm(COHORT, gid));
  });

  it("reparte cerca de mitad y mitad", () => {
    let auto = 0;
    for (let i = 0; i < 2000; i++) if (abArm(COHORT, `gid://shopify/DraftOrder/${i}`) === "auto") auto += 1;
    expect(auto).toBeGreaterThan(900);
    expect(auto).toBeLessThan(1100);
  });

  it("otra cohorte vuelve a sortear: no hereda la mitad", () => {
    const gids = Array.from({ length: 200 }, (_, i) => `gid://shopify/DraftOrder/${i}`);
    const distintos = gids.filter((g) => abArm(COHORT, g) !== abArm("otra-cohorte", g)).length;
    expect(distintos).toBeGreaterThan(50);
  });
});

describe("cohortIsLive", () => {
  it("encendida y dentro de la ventana → inscribe", () => {
    expect(cohortIsLive(cohort(), NOW)).toBe(true);
  });
  it("apagada no inscribe aunque esté en fecha", () => {
    expect(cohortIsLive(cohort({ enabled: false }), NOW)).toBe(false);
  });
  it("fuera de la ventana no inscribe", () => {
    expect(cohortIsLive(cohort({ ends_at: "2026-10-12T00:00:00Z" }), NOW)).toBe(false);
    expect(cohortIsLive(cohort({ starts_at: "2026-10-13T00:00:00Z" }), NOW)).toBe(false);
  });
  it("sin ventana no inscribe: una cohorte sin fin sería automatizar sin decidirlo", () => {
    expect(cohortIsLive(cohort({ ends_at: null }), NOW)).toBe(false);
    expect(cohortIsLive(cohort({ starts_at: null }), NOW)).toBe(false);
  });
});

describe("abRow", () => {
  it("la mitad auto entra pendiente (la genera el procesador); control queda en control", () => {
    const rows = Array.from({ length: 40 }, (_, i) => abRow("s1", COHORT, cand(i)));
    for (const r of rows) {
      expect(r.status).toBe(r.arm === "auto" ? "pendiente" : "control");
    }
    expect(rows.some((r) => r.arm === "auto")).toBe(true);
    expect(rows.some((r) => r.arm === "control")).toBe(true);
  });

  it("guarda lo que la medición necesita: teléfono y fecha del carrito", () => {
    const r = abRow("s1", COHORT, cand(1));
    expect(r).toMatchObject({ phone9: "900000001", cart_created_at: cand(1).cart_created_at, cohort: COHORT });
  });

  it("grupo A si el carrito va al distrito donde ya recibió, C si es otro", () => {
    expect(abRow("s1", COHORT, cand(1)).grupo).toBe("A");
    expect(abRow("s1", COHORT, cand(1, { same_district: false })).grupo).toBe("C");
  });
});

function fakeDeps(over: Partial<AbDeps> & { today?: number; list?: AbCandidate[] } = {}) {
  const inserted: ReturnType<typeof abRow>[] = [];
  let candidatesCalled = 0;
  const deps: AbDeps = {
    listCohorts: async () => [cohort()],
    countToday: async () => over.today ?? 0,
    candidates: async () => {
      candidatesCalled += 1;
      return over.list ?? [cand(1), cand(2), cand(3)];
    },
    insert: async (rows) => {
      inserted.push(...rows);
      return rows.length;
    },
    now: () => NOW,
    ...over,
  };
  return { deps, inserted, calls: () => candidatesCalled };
}

describe("enrollAbCohorts", () => {
  it("inscribe a todos los candidatos y cuenta cada mitad", async () => {
    const { deps, inserted } = fakeDeps();
    const r = await enrollAbCohorts("s1", deps);
    expect(inserted).toHaveLength(3);
    expect(r.enrolledAuto + r.enrolledControl).toBe(3);
    expect(r.enrolledAuto).toBe(inserted.filter((x) => x.arm === "auto").length);
  });

  it("respeta el tope diario, y entran primero los carritos más viejos", async () => {
    const { deps, inserted } = fakeDeps({ today: 28, list: [cand(1), cand(5), cand(3)] });
    await enrollAbCohorts("s1", deps);
    expect(inserted.map((r) => r.draft_name)).toEqual(["#D1005", "#D1003"]);
  });

  it("con el tope lleno no consulta candidatos", async () => {
    const { deps, inserted, calls } = fakeDeps({ today: 30 });
    await enrollAbCohorts("s1", deps);
    expect(inserted).toHaveLength(0);
    expect(calls()).toBe(0);
  });

  it("una cohorte fuera de fecha no inscribe ni consulta", async () => {
    const { deps, inserted, calls } = fakeDeps({
      listCohorts: async () => [cohort({ ends_at: "2026-10-11T00:00:00Z" })],
    });
    await enrollAbCohorts("s1", deps);
    expect(inserted).toHaveLength(0);
    expect(calls()).toBe(0);
  });
});

describe("limaDayStartIso", () => {
  it("el día empieza a medianoche de Lima (05:00 UTC)", () => {
    expect(limaDayStartIso(Date.parse("2026-10-12T15:00:00Z"))).toBe("2026-10-12T05:00:00.000Z");
    // 02:00 UTC del 13 son las 21:00 del 12 en Lima: sigue siendo el día 12.
    expect(limaDayStartIso(Date.parse("2026-10-13T02:00:00Z"))).toBe("2026-10-12T05:00:00.000Z");
  });
});
