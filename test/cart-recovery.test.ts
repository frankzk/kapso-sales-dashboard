import { describe, it, expect } from "vitest";
import { cartRecovery } from "@/lib/metrics";
import type { LeadRow, OrderRow } from "@/lib/types";

const orders = [
  { customer_phone: "51111", total_amount: 200, total_refunded: 0, cancelled_at: null },
  { customer_phone: "51555", total_amount: 99, total_refunded: 0, cancelled_at: null },
] as unknown as OrderRow[];

const leads = [
  // recovered via has_order → +200 net
  { phone: "51111", draft_order_gid: "gid1", has_order: true, category: "won" },
  // recovered via draft_order_status completed → +99 net
  { phone: "51555", draft_order_gid: "gid2", has_order: false, draft_order_status: "completed", category: "won" },
  // cod_cart marked lost → perdido
  { phone: "51222", source: "cod_cart", has_order: false, category: "lost" },
  // cod_cart still open with a S/150 cart → pendiente + value at risk
  { phone: "51333", source: "cod_cart", has_order: false, category: "open", cart_value: 150 },
  // NOT a cart (no draft, source meta_ad) → excluded entirely
  { phone: "51444", source: "meta_ad", has_order: false, category: "open" },
] as unknown as LeadRow[];

describe("cartRecovery (abandoned-cart recovery)", () => {
  it("counts carts, recovery rate, recovered revenue and value at risk", () => {
    const s = cartRecovery(leads, orders)!;
    expect(s.total).toBe(4); // the meta_ad lead is not a cart
    expect(s.recuperados).toBe(2); // has_order + draft completed
    expect(s.perdidos).toBe(1);
    expect(s.pendientes).toBe(1);
    expect(s.tasaRecuperacion).toBeCloseTo(0.5); // 2 / 4
    expect(s.ingresosRecuperados).toBe(299); // 200 + 99
    expect(s.ticketPromedio).toBe(149.5);
    expect(s.valorEnRiesgo).toBe(150); // only the open cart's value
  });

  it("returns null when there are no cart leads (module stays hidden)", () => {
    const noCarts = [{ phone: "x", source: "meta_ad", has_order: false, category: "open" }] as unknown as LeadRow[];
    expect(cartRecovery(noCarts, orders)).toBeNull();
  });
});
