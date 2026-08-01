import { describe, expect, it } from "vitest";
import {
  directOrderSearchTerm,
  evaluateSettlementCandidateScope,
  settlementStoreMatchesHint,
} from "@/lib/settlement-order-search";

describe("settlement order search", () => {
  it("permite un código Shopify exacto aunque la pista de tienda sea incorrecta", () => {
    expect(
      evaluateSettlementCandidateScope({
        orderName: "#KP124715",
        storeName: "Kenku Peru",
        storeHint: "AURELA",
        query: "KP124715",
      }),
    ).toEqual({
      exactOrderCode: true,
      storeMatches: false,
      allowed: true,
      warning: "La liquidación indica AURELA, pero el pedido pertenece a Kenku Peru.",
    });
  });

  it("mantiene el filtro de tienda para búsquedas difusas", () => {
    expect(
      evaluateSettlementCandidateScope({
        orderName: "#KP124715",
        storeName: "Kenku Peru",
        storeHint: "AURELA",
        query: "Dario Orlando",
      }).allowed,
    ).toBe(false);
  });

  it("reconoce pistas abreviadas de tienda", () => {
    expect(settlementStoreMatchesHint("Aurela Shop", "AURELA")).toBe(true);
  });

  it("limpia el código antes de consultarlo directamente", () => {
    expect(directOrderSearchTerm(" #KP124715 ")).toBe("KP124715");
    expect(directOrderSearchTerm("__")).toBeNull();
  });
});
