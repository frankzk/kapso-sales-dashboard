import { describe, expect, it } from "vitest";
import {
  deriveDispatchManifestState,
  dispatchProgress,
  normalizeDispatchScan,
} from "@/lib/dispatch";

describe("dispatchProgress", () => {
  it("ignora paquetes retirados expresamente", () => {
    expect(
      dispatchProgress([
        { office_checked_at: "2026-07-31", pickup_checked_at: "2026-07-31" },
        { office_checked_at: null, pickup_checked_at: null, removed_at: "2026-07-31" },
      ]),
    ).toMatchObject({ total: 1, officeChecked: 1, pickupChecked: 1, pickupComplete: true });
  });
});

describe("deriveDispatchManifestState", () => {
  it("no declara lista una ruta incompleta", () => {
    expect(
      deriveDispatchManifestState(
        [{ office_checked_at: "2026-07-31" }, { office_checked_at: null }],
        "office_check",
      ),
    ).toBe("office_check");
  });

  it("espera la confirmación atómica antes de transferir custodia", () => {
    const items = [{ office_checked_at: "2026-07-31", pickup_checked_at: "2026-07-31" }];
    expect(deriveDispatchManifestState(items, "pickup_check")).toBe("pickup_check");
    expect(deriveDispatchManifestState(items, "in_custody")).toBe("in_custody");
  });
});

describe("normalizeDispatchScan", () => {
  it("acepta token, URL y código con numeral", () => {
    expect(normalizeDispatchScan("  KP123-S02  ")).toBe("KP123-S02");
    expect(normalizeDispatchScan("#KP123")).toBe("KP123");
    expect(normalizeDispatchScan("https://kapta.pe/s/abc-123")).toBe("abc-123");
    expect(normalizeDispatchScan("https://kapta.pe/s?qr=token-9")).toBe("token-9");
  });
});

