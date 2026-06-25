import { describe, it, expect } from "vitest";
import { leadsByWaNumber } from "@/lib/metrics";
import { waKindLabel, waLabel } from "@/lib/wa-numbers";
import type { LeadRow, OrderRow } from "@/lib/types";

const orders = [
  { customer_phone: "51999", total_amount: 100, total_refunded: 0, cancelled_at: null },
] as unknown as OrderRow[];

const leads = [
  { phone: "51999", wa_phone_number_id: "API1", has_order: true },
  { phone: "51888", wa_phone_number_id: "API1", has_order: false },
  { phone: "51777", wa_phone_number_id: "BUS1", has_order: false },
  { phone: "51666", wa_phone_number_id: null, has_order: false }, // not yet attributed → "" bucket
] as unknown as LeadRow[];

describe("leadsByWaNumber", () => {
  it("groups leads by WhatsApp number and attributes revenue by phone", () => {
    const rows = leadsByWaNumber(leads, orders);
    expect(rows.map((r) => r.phoneNumberId)).toEqual(["API1", "BUS1", ""]); // by leads desc
    const api = rows.find((r) => r.phoneNumberId === "API1")!;
    expect(api).toMatchObject({ leads: 2, pedidos: 1, ingresos: 100 });
    expect(api.conversion).toBeCloseTo(0.5);
  });

  it("returns [] when no lead carries a number", () => {
    const none = [{ phone: "x", wa_phone_number_id: null, has_order: false }] as unknown as LeadRow[];
    expect(leadsByWaNumber(none, orders)).toEqual([]);
  });
});

describe("wa-numbers helpers", () => {
  it("waKindLabel maps known kinds, null otherwise", () => {
    expect(waKindLabel("api")).toBe("API");
    expect(waKindLabel("business")).toBe("Business");
    expect(waKindLabel("sandbox")).toBe("Sandbox");
    expect(waKindLabel(null)).toBeNull();
    expect(waKindLabel("weird")).toBeNull();
  });

  it("waLabel falls back name → phone → id", () => {
    expect(waLabel({ phoneNumberId: "1", name: "Aurela", displayPhone: "+51 9", kind: "api" }, "1")).toBe(
      "Aurela",
    );
    expect(waLabel({ phoneNumberId: "1", name: null, displayPhone: "+51 9", kind: null }, "1")).toBe("+51 9");
    expect(waLabel(null, "1")).toBe("1");
  });
});
