import { describe, expect, it } from "vitest";
import { collectionBalance, reportedCollection } from "@/lib/route-collection";
import { validateStopReport, stopsToSettlementLines } from "@/lib/routes";
import { riderPayBlockers, type RiderPaySnapshot } from "@/lib/rider-pay";

describe("collection only once", () => {
  const p = (amount: number, validation_status = "validado", kind = "adelanto") => ({ kind, amount, validation_status });
  it("deducts validated advances from the suggested collection", () => {
    expect(collectionBalance(89, {}, [p(30)]).remaining).toBe(59);
  });
  it("does not silently treat pending or rejected receipts as money received", () => {
    expect(collectionBalance(89, {}, [p(30,"pendiente"),p(20,"rechazado")])).toEqual({ remaining: 89, validated: 0, pending: 30 });
  });
  it("does not deduct courier remittances a second time", () => {
    expect(collectionBalance(89, {}, [p(30),p(59,"validado","cobro_courier")]).remaining).toBe(59);
  });
  it("checkout prepaid is zero, not an extra deduction", () => {
    expect(collectionBalance(89, { financialStatus: "paid", paymentGateway: "checkout" }, [p(89)])).toEqual({ remaining: 0, validated: 89, pending: 0 });
  });
  it("manual paid is not proof of checkout receipt", () => {
    expect(collectionBalance(89, { financialStatus: "paid", paymentGateway: "manual" }, []).remaining).toBe(89);
  });
  it("does not invent a balance when the order is missing", () => {
    expect(collectionBalance(null, {}, []).remaining).toBeNull();
  });
  it("rounds cents and never suggests a negative collection", () => {
    expect(collectionBalance(89.1, {}, [p(30.05)]).remaining).toBe(59.05);
    expect(collectionBalance(89, {}, [p(100)]).remaining).toBe(0);
  });
  it("sin cobro always writes zero even with a stale hidden value", () => {
    expect(reportedCollection("sin_cobro",89)).toBe(0);
    expect(reportedCollection("yape",89)).toBe(89);
    expect(stopsToSettlementLines([{ id:"s",order_id:"o",status:"entregado",payment_method:"sin_cobro",collected_amount:89 }])[0]?.declared_amount).toBe(0);
  });
  it("rejects absent method, NaN and hidden sin-cobro amounts", () => {
    const report = { status:"entregado" as const,paymentMethod:null,collectedAmount:89,outcomeReason:null,note:null,hasPhoto:true,hasVoucher:true };
    expect(validateStopReport(report).ok).toBe(false);
    expect(validateStopReport({ ...report,paymentMethod:"efectivo",collectedAmount:NaN }).ok).toBe(false);
    expect(validateStopReport({ ...report,paymentMethod:"sin_cobro",collectedAmount:89 }).ok).toBe(false);
    expect(validateStopReport({ ...report,paymentMethod:"sin_cobro",collectedAmount:0 }).ok).toBe(true);
  });
});

describe("daily rider approval blockers", () => {
  const snapshot = { route_status:"cerrada",rows:[{}],missing:0,pending:0,evidence_missing:0,conflicts:0 } as RiderPaySnapshot;
  it("permits reviewing a complete daily calculation", () => expect(riderPayBlockers(snapshot)).toEqual([]));
  it("blocks missing tariffs, evidence, contradictory reports and pending stops", () => {
    expect(riderPayBlockers({ ...snapshot,missing:1,pending:1,evidence_missing:1,conflicts:1 })).toHaveLength(4);
  });
  it("operational closure is distinct from financial approval", () => expect(riderPayBlockers({ ...snapshot,route_status:"en_curso" })).toHaveLength(1));
});
