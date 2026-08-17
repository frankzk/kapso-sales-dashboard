import type { AliclikOrder } from "@/lib/aliclik";

export interface AliclikExistingGuideTarget {
  guideCode?: string | null;
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
const compact = (value: string | null | undefined) =>
  text(value).replace(/[^a-z0-9]/g, "");
const samePlace = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(text(a) && text(b) && text(a) === text(b));

/**
 * ¿El código impreso lleva dentro el número del pedido Shopify?
 *
 * La API oficial solo lista pedidos creados por la integración (ALC…). Las guías
 * creadas directamente en el portal AURELA/KENKU usan códigos impresos AUR5X… y
 * no aparecen allí, así que al vincularlas no hay nada que consultar.
 *
 * ESTO CORROBORA, NO AUTORIZA. Se usó como requisito para vincular, y era una
 * regla que solo cumple una de las tres familias de código: medido sobre 3.976
 * guías, las de 6 dígitos terminan en su pedido 1.162 veces de 1.179, y de las
 * de 7 y 12 dígitos (2.853 guías) ninguna lo hace. Exigirlo dejaba sin vincular
 * una guía real creada en el portal solo porque Aliclik le dio un código largo.
 *
 * Quien autoriza es la confirmación auditada —escribir el código del pedido y
 * dar un motivo— y la guarda de que la guía no cuelgue ya de otro pedido. Esta
 * función decide si además hay respaldo en el propio código, para poder decirlo
 * o advertir de su ausencia.
 */
export function isCompatibleManualPortalGuide(
  guideCode: string | null | undefined,
  orderName: string | null | undefined,
): boolean {
  const normalizedGuide = compact(guideCode).toUpperCase();
  const orderDigits = digits(orderName);
  if (!normalizedGuide || orderDigits.length < 5) return false;
  if (/^ALC/i.test(normalizedGuide)) return false;
  return normalizedGuide.endsWith(orderDigits);
}

function compactOrderPayload(order: AliclikOrder): string {
  // Aliclik agrega campos a esta respuesta sin incorporarlos siempre a su
  // documentación. JSON.stringify conserva esos campos adicionales en runtime
  // y nos permite reconocer identificadores exactos sin depender de su nombre.
  try {
    return compact(JSON.stringify(order));
  } catch {
    return "";
  }
}

export function scoreExistingAliclikOrder(
  order: AliclikOrder,
  target: AliclikExistingGuideTarget,
): AliclikExistingGuideMatch {
  let score = 0;
  const reasons: string[] = [];
  const payload = compactOrderPayload(order);
  const guideCode = compact(target.guideCode);
  if (guideCode && payload.includes(guideCode)) {
    score += 200;
    reasons.push("código de guía");
  }
  const orderRef = digits(target.orderName);
  if (orderRef && (digits(order.note).includes(orderRef) || payload.includes(orderRef))) {
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
