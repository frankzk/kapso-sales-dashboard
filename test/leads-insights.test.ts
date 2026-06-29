import { describe, it, expect } from "vitest";
import { buildBurndown, buildTrend, SHIFT_START, SHIFT_END } from "@/lib/leads-insights";

describe("buildTrend (saldo walked back from the current backlog)", () => {
  it("reconstructs saldo via saldo(d-1) = saldo(d) − entran(d) + cierran(d)", () => {
    const days = [
      { date: "2026-06-27", label: "Sáb" },
      { date: "2026-06-28", label: "Dom" },
      { date: "2026-06-29", label: "Hoy" },
    ];
    const { trend, saldoInicio } = buildTrend({
      days,
      pendingNow: 100,
      entranByDate: { "2026-06-27": 10, "2026-06-28": 20, "2026-06-29": 30 },
      cierranByDate: { "2026-06-27": 5, "2026-06-28": 8, "2026-06-29": 12 },
    });
    // today's saldo is the anchor; walk back: 100 -30+12=82 ; 82 -20+8=70
    expect(trend.map((t) => t.saldo)).toEqual([70, 82, 100]);
    expect(trend.map((t) => t.entran)).toEqual([10, 20, 30]);
    expect(trend.map((t) => t.cierran)).toEqual([5, 8, 12]);
    expect(trend[2]!.dia).toBe("Hoy");
    expect(saldoInicio).toBe(70);
  });
});

describe("buildBurndown (today's backlog reconstructed by hour)", () => {
  it("real = now − entró-desde-h + salió-desde-h; ritmo→0; proy extends the pace", () => {
    // backlog now=10; 3 entered (9,10,11h), 1 left (10h) → started the day at 8.
    const pts = buildBurndown({
      pendingNow: 10,
      nowHour: 12,
      entrantHours: [9, 10, 11],
      leaverHours: [10],
    });
    expect(pts).toHaveLength(SHIFT_END - SHIFT_START + 1); // 08h..20h

    const at = (h: string) => pts.find((p) => p.h === h)!;
    expect(at("08h").real).toBe(8); // inicial
    expect(at("08h").ritmo).toBe(8); // ideal line starts at inicial
    expect(at("12h").real).toBe(10); // "ahora" = current backlog
    expect(at("12h").proy).toBe(10); // proy empalma con real en "ahora"

    const last = pts.at(-1)!;
    expect(last.h).toBe("20h");
    expect(last.real).toBeNull(); // future hours have no real
    expect(last.ritmo).toBe(0); // meta-0 at end of shift
    // backlog grew (net +2 over 4h ⇒ pace −0.5/h) ⇒ projection rises to ~14
    expect(last.proy).toBe(14);

    // hours after "ahora" carry the projection, not real
    expect(at("15h").real).toBeNull();
    expect(at("07h" as string)).toBeUndefined(); // shift starts at 08h
  });

  it("clamps before the shift and never goes negative", () => {
    const pts = buildBurndown({ pendingNow: 5, nowHour: 3, entrantHours: [], leaverHours: [] });
    // nowHour clamps to SHIFT_START → only 08h is 'real', rest projected/ideal
    expect(pts[0]!.real).toBe(5);
    expect(pts.every((p) => p.ritmo >= 0 && (p.real == null || p.real >= 0))).toBe(true);
  });
});
