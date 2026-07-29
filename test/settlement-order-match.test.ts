import { describe, expect, it } from "vitest";
import { scoreSettlementOrderMatch } from "@/lib/settlement-order-match";

describe("scoreSettlementOrderMatch", () => {
  it("no descarta un código exacto de otra tienda", () => {
    const result = scoreSettlementOrderMatch(
      {
        orderName: "#KP124715",
        storeName: "Kenku Peru",
        customerName: "Dario Orlando Tapia Campos",
        district: "San Juan de Lurigancho",
        total: 99,
      },
      {
        storeHint: "AURELA",
        customerName: "Dario Orlando T",
        district: "San Juan de Luz",
        declaredAmount: 99,
        query: "#KP124715",
      },
    );

    expect(result).not.toBeNull();
    expect(result?.storeMatchesHint).toBe(false);
    expect(result?.reasons).toContain("código exacto");
    expect(result?.reasons).toContain("tienda distinta a AURELA");
  });

  it("sigue priorizando la tienda declarada cuando coincide", () => {
    const context = {
      storeHint: "AURELA",
      customerName: "Dario Orlando",
      district: "San Juan de Lurigancho",
      declaredAmount: 99,
      query: "",
    };
    const sameStore = scoreSettlementOrderMatch(
      {
        orderName: "#AUR124715",
        storeName: "Aurela",
        customerName: "Dario Orlando",
        district: "San Juan de Lurigancho",
        total: 99,
      },
      context,
    );
    const otherStore = scoreSettlementOrderMatch(
      {
        orderName: "#KP124715",
        storeName: "Kenku Peru",
        customerName: "Dario Orlando",
        district: "San Juan de Lurigancho",
        total: 99,
      },
      context,
    );

    expect(sameStore!.score).toBeGreaterThan(otherStore!.score);
    expect(otherStore?.storeMatchesHint).toBe(false);
  });
});
