import type { AliclikOrder } from "@/lib/aliclik";

export interface AliclikExistingGuideTarget {
  orderName?: string | null;
  customerPhone?: string | null;
  orderTotal?: number | null;
  region?: string | null;
  province?: string | null;
  district?: string | null;
}

export interface AliclikExistingGuideMatch {
  order: AliclikOrder;
  score: number;
  reasons: string[];
}

const text = (value: string | null | undefined) =>
  (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
const digits = (value: string | null | undefined) => (value ?? "").replace(/\D/g, "");
const samePlace = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(text(a) && text(b) && text(a) === text(b));

export function scoreExistingAliclikOrder(
  order: AliclikOrder,
  target: AliclikExistingGuideTarget,
): AliclikExistingGuideMatch {
  let score = 0;
  const reasons: string[] = [];
  const orderRef = digits(target.orderName);
  if (orderRef && digits(order.note).includes(orderRef)) {
    score += 100;
    reasons.push("pedido Shopify");
  }
  const localPhone = digits(target.customerPhone).slice(-9);
  const remotePhone = digits(order.customer?.phone).slice(-9);
  if (localPhone && remotePhone && localPhone === remotePhone) {
    score += 35;
    reasons.push("teléfono");
  }
  if (
    target.orderTotal != null &&
    order.total != null &&
    Math.abs(target.orderTotal - order.total) <= 0.01
  ) {
    score += 20;
    reasons.push("monto");
  }
  if (samePlace(target.district, order.shipping?.districtName)) {
    score += 12;
    reasons.push("distrito");
  }
  if (samePlace(target.province, order.shipping?.provinceName)) {
    score += 8;
    reasons.push("provincia");
  }
  if (samePlace(target.region, order.shipping?.departmentName)) {
    score += 5;
    reasons.push("región");
  }
  return { order, score, reasons };
}

export function selectExistingAliclikOrder(
  orders: AliclikOrder[],
  target: AliclikExistingGuideTarget,
):
  | { ok: true; match: AliclikExistingGuideMatch }
  | { ok: false; reason: "not_found" | "ambiguous"; matches: AliclikExistingGuideMatch[] } {
  const matches = orders
    .map((order) => scoreExistingAliclikOrder(order, target))
    .sort((a, b) => b.score - a.score);
  const best = matches[0];
  if (!best || best.score < 120) return { ok: false, reason: "not_found", matches };
  const second = matches[1];
  if (second && second.score >= best.score - 15) {
    return { ok: false, reason: "ambiguous", matches: matches.slice(0, 3) };
  }
  return { ok: true, match: best };
}
