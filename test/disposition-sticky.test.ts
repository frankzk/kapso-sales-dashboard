import { describe, it, expect } from "vitest";
import { eventOverridesDisposition } from "@/lib/leads-ingest";

// Guards a registered manual call result (e.g. "ya compró en otro lado") from
// being reverted to "Sin llamar" by an order/cart event that predates it. The
// auto-sync may only change state when the event post-dates the disposition.
describe("eventOverridesDisposition (manual disposition sticky)", () => {
  const disp = "2026-06-30T01:24:00Z";

  it("overrides when there is no manual disposition", () => {
    expect(eventOverridesDisposition("2026-06-29T17:08:00Z", null)).toBe(true);
    expect(eventOverridesDisposition(null, undefined)).toBe(true);
  });

  it("respects the disposition when the event predates it (Leji case)", () => {
    // order/cart at 17:08 < disposition at 01:24 next day → keep the result.
    expect(eventOverridesDisposition("2026-06-29T17:08:00Z", disp)).toBe(false);
  });

  it("overrides when the event post-dates the disposition (legit recompra)", () => {
    // a new cart created AFTER the result → reopen/win is correct.
    expect(eventOverridesDisposition("2026-06-30T18:00:00Z", disp)).toBe(true);
  });

  it("respects the disposition when the event time is unknown", () => {
    // can't prove the event is newer → don't clobber the human result.
    expect(eventOverridesDisposition(null, disp)).toBe(false);
    expect(eventOverridesDisposition(undefined, disp)).toBe(false);
  });

  it("does not override on an exact tie (event == disposition)", () => {
    expect(eventOverridesDisposition(disp, disp)).toBe(false);
  });
});
