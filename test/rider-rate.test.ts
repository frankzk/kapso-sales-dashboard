// Tarifa personal del motorizado por distrito (0162), vista desde el Tarifario.
import { describe, expect, it } from "vitest";
import { resolveRiderRate, type RiderRateVersion } from "@/lib/rider-pay";

const v = (district_key: string | null, amount: number, effective_from: string, created_at = `${effective_from}T10:00:00Z`): RiderRateVersion => ({ district_key, amount, effective_from, created_at });

describe("resolveRiderRate", () => {
  const rates = [v(null, 8.5, "2026-09-01"), v("surco", 10, "2026-09-10"), v("surco", 11, "2026-09-20"), v(null, 9, "2026-09-25")];
  it("la del distrito gana a la general, y cuenta la vigencia", () => {
    expect(resolveRiderRate(rates, "surco", "2026-09-22")).toEqual({ amount: 11, source: "distrito", effectiveFrom: "2026-09-20" });
    expect(resolveRiderRate(rates, "surco", "2026-09-15")).toMatchObject({ amount: 10 });
    expect(resolveRiderRate(rates, "surco", "2026-09-05")).toMatchObject({ amount: 8.5, source: "general" });
  });
  it("sin tarifa de distrito usa la general vigente; sin nada, null", () => {
    expect(resolveRiderRate(rates, "ate", "2026-09-22")).toMatchObject({ amount: 8.5, source: "general" });
    expect(resolveRiderRate(rates, "ate", "2026-09-26")).toMatchObject({ amount: 9 });
    expect(resolveRiderRate(rates, "ate", "2026-08-01")).toBeNull();
  });
  it("a igual vigencia, la última registrada", () => {
    expect(resolveRiderRate([v("ate", 7, "2026-09-01", "2026-09-01T10:00:00Z"), v("ate", 7.5, "2026-09-01", "2026-09-02T10:00:00Z")], "ate", "2026-09-22")).toMatchObject({ amount: 7.5 });
  });
});
