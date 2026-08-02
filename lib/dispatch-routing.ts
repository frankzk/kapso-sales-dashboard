// Qué puede entrar en cada ruta de la Mesa de despacho.
//
// Hasta ahora una ruta solo validaba el courier: nada impedía meter un pedido de
// provincia en la caja de un motorizado de Lima, ni exigirle a Aliclik el
// "cotejo del motorizado" que nunca va a hacer porque no hay motorizado — su
// gente recoge las cajas y firma.
//
// Aquí viven las dos reglas que faltaban, en código puro para poder probarlas:
// de qué TIPO es cada ruta y qué OPERACIONES (MOM §5) acepta cada courier.

import { courierKey, type DispatchRouteKind } from "@/lib/dispatch";
import type { OperationKind } from "@/lib/order-macro-stage";

interface CourierRule {
  kind: DispatchRouteKind;
  /** Operaciones que este courier atiende (MOM §5). */
  operations: OperationKind[];
}

/**
 * Reglas por courier, tomadas del MOM:
 *
 * - Lima reparte con motorizados propios, Axel, Urpi, Tanders y Swayp (§9.2).
 * - Tanders es **exclusivo de Lima**: el servidor no lo acepta para provincia ni
 *   agencia (§5).
 * - Swayp atiende Lima y además provincia por Reproprovincia (§11).
 * - Aliclik es provincia COD (§10) y recoge; no hay motorizado que coteje.
 * - Shalom y Olva son agencia (§12): la caja se lleva al local.
 */
const COURIER_RULES: Record<string, CourierRule> = {
  propio: { kind: "reparto", operations: ["lima"] },
  axel: { kind: "reparto", operations: ["lima"] },
  urpi: { kind: "reparto", operations: ["lima"] },
  tanders: { kind: "reparto", operations: ["lima"] },
  fenix: { kind: "reparto", operations: ["lima", "provincia_cod"] },
  aliclik: { kind: "entrega_courier", operations: ["provincia_cod"] },
  shalom: { kind: "entrega_courier", operations: ["agencia"] },
  olva: { kind: "entrega_courier", operations: ["agencia"] },
};

function ruleFor(courier: string | null | undefined): CourierRule | null {
  return COURIER_RULES[courierKey(courier)] ?? null;
}

/** Tipo de ruta que le corresponde a un courier. Lo desconocido reparte. */
export function routeKindForCourier(courier: string | null | undefined): DispatchRouteKind {
  return ruleFor(courier)?.kind ?? "reparto";
}

export const OPERATION_LABELS: Record<OperationKind, string> = {
  lima: "Lima",
  provincia_cod: "Provincia COD",
  agencia: "Agencia",
  desconocida: "Sin clasificar",
};

export interface OperationVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * ¿Puede este pedido entrar en una ruta de este courier?
 *
 * Una operación `desconocida` **no bloquea**: el dato falta, y negarle el
 * despacho a una caja que existe físicamente es peor que dejarla pasar. Lo que
 * se bloquea es la contradicción explícita — un pedido de provincia en la caja
 * de un motorizado de Lima.
 */
export function operationFitsCourier(
  courier: string | null | undefined,
  operation: OperationKind | null | undefined,
): OperationVerdict {
  const rule = ruleFor(courier);
  if (!rule) return { ok: true };
  if (!operation || operation === "desconocida") return { ok: true };
  if (rule.operations.includes(operation)) return { ok: true };
  const accepted = rule.operations.map((op) => OPERATION_LABELS[op]).join(" y ");
  return {
    ok: false,
    reason: `Ese pedido es ${OPERATION_LABELS[operation]} y esta ruta atiende ${accepted}.`,
  };
}
