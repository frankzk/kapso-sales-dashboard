// Auditoría del atraso de Lima (14-10-2026): las alertas del dueño en el
// Consolidado. (F) «Liquidación vencida» no veía las entregas registradas con
// `status_override` —sin `delivered_at` ni `delivered_courier`—; (F2) «Recogido
// sin pago completo» cuenta por motivo y su enlace lista por subetapa: se deja
// así, y el descuadre queda como decisión del owner (MOM §17.1).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMomOwnerSummary,
  settlementCourier,
  settlementDeliveredAt,
  type MomOwnerOrderFact,
} from "@/lib/mom-owner-summary";

const TODAY = "2026-10-16";

function order(orderId: string, over: Partial<MomOwnerOrderFact> = {}): MomOwnerOrderFact {
  return {
    orderId,
    createdAt: "2026-10-01T15:00:00.000Z",
    coverage: "lima",
    orderTotal: 100,
    stage: "por_cerrar",
    substage: "pendiente_liquidacion",
    reasons: ["pendiente_liquidacion"],
    paymentState: "sin_pago",
    deliveredAt: null,
    deliveredCourier: null,
    lastMovementAt: "2026-10-10T15:00:00.000Z",
    ...over,
  };
}

/** Entrega por `status_override`: el cuaderno, un lote, la ruta, Urpi. */
function override(orderId: string, since: string, over: Partial<MomOwnerOrderFact> = {}) {
  return order(orderId, { generalStatus: "entregado", statusSince: since, ...over });
}

function alerts(orders: MomOwnerOrderFact[]) {
  const summary = buildMomOwnerSummary({
    today: TODAY,
    nowIso: "2026-10-16T15:00:00.000Z",
    orders,
    shipments: [],
    payments: [],
    events: [],
    manifests: [],
  });
  return Object.fromEntries(summary.alerts.map((alert) => [alert.key, alert]));
}

describe("(F) fecha de la entrega para el plazo de liquidación", () => {
  it("delivered_at manda cuando existe", () => {
    expect(
      settlementDeliveredAt(order("a", { deliveredAt: "2026-10-10T15:00:00.000Z", generalStatus: "entregado", statusSince: "2026-10-12T15:00:00.000Z" })),
    ).toBe("2026-10-10T15:00:00.000Z");
  });

  it("sin delivered_at, la de un pedido entregado es desde cuándo está entregado", () => {
    expect(settlementDeliveredAt(override("a", "2026-10-12T15:00:00.000Z"))).toBe("2026-10-12T15:00:00.000Z");
  });

  it("fuera de «entregado» status_since no es una entrega", () => {
    expect(
      settlementDeliveredAt(order("a", { reasons: ["liquidacion_observada"], generalStatus: "devuelto", statusSince: "2026-10-12T15:00:00.000Z" })),
    ).toBeNull();
    expect(settlementDeliveredAt(order("a"))).toBeNull();
  });
});

describe("(F) quién entregó, para el plazo de liquidación", () => {
  it("el courier de la entrega manda cuando se registró", () => {
    expect(settlementCourier(order("a", { deliveredCourier: "aliclik", currentCourier: "fenix" }))).toBe("aliclik");
  });

  it("si no, el courier vigente, y si no el último; «por definir» se salta", () => {
    expect(settlementCourier(order("a", { currentCourier: "propio", lastCourier: "urpi" }))).toBe("propio");
    expect(settlementCourier(order("a", { currentCourier: "por_definir", lastCourier: "urpi" }))).toBe("urpi");
    expect(settlementCourier(order("a", { currentCourier: "por_definir", lastCourier: "por_definir", dispatchedWith: ["urpi"] }))).toBe("urpi");
  });

  it("«Salió con» solo Grupo GF es motorizado propio, también sin salida en Kapta (cuaderno)", () => {
    expect(settlementCourier(order("a", { dispatchedWith: ["gf:Roy"] }))).toBe("propio");
    expect(settlementCourier(order("a", { dispatchedWith: ["gf:Roy", "gf:Yhoni"] }))).toBe("propio");
    expect(settlementCourier(order("a", { dispatchedWith: ["gf"] }))).toBe("propio");
  });

  it("varios couriers distintos, o ninguno, no dicen quién entregó", () => {
    expect(settlementCourier(order("a", { dispatchedWith: ["gf:Alexis", "urpi"] }))).toBeNull();
    expect(settlementCourier(order("a", { dispatchedWith: [] }))).toBeNull();
    expect(settlementCourier(order("a"))).toBeNull();
  });
});

describe("(F) «Liquidación vencida» cuenta las entregas por status_override", () => {
  it("cuaderno de Grupo GF, ruta propia y Urpi vencen con su plazo; sin courier, no", () => {
    const result = alerts([
      // Motorizado propio: vence al día siguiente.
      override("cuaderno-roy", "2026-10-14T15:00:00.000Z", { dispatchedWith: ["gf:Roy"] }),
      override("ruta-propia", "2026-10-14T15:00:00.000Z", { currentCourier: "propio", lastCourier: "propio" }),
      // Urpi: a los 3 días. Esta lleva 4; la siguiente, ninguno.
      override("urpi-late", "2026-10-11T17:00:00.000Z", { currentCourier: "por_definir", lastCourier: "por_definir", dispatchedWith: ["urpi"] }),
      override("urpi-on-time", "2026-10-15T17:00:00.000Z", { currentCourier: "urpi", lastCourier: "urpi" }),
      // Sin salida ni «Salió con»: no se sabe el plazo, no entra.
      override("sin-courier", "2026-09-01T15:00:00.000Z"),
      // Tanders no genera la alerta, tampoco por esta vía.
      override("tanders", "2026-09-01T15:00:00.000Z", { currentCourier: "tanders" }),
      // Sin delivered_at y sin estar entregado no hay entrega que medir.
      order("no-entregado", { reasons: ["liquidacion_observada"], generalStatus: "devuelto", statusSince: "2026-09-01T15:00:00.000Z", currentCourier: "propio" }),
    ]);
    expect(result.overdue_settlement!.count).toBe(3);
  });

  it("las entregas con delivered_at siguen igual", () => {
    const result = alerts([
      order("aliclik-late", { coverage: "provincia_cod", deliveredAt: "2026-10-14T15:00:00.000Z", deliveredCourier: "aliclik" }),
      order("swayp-on-time", { deliveredAt: "2026-10-14T15:00:00.000Z", deliveredCourier: "fenix" }),
    ]);
    expect(result.overdue_settlement!.count).toBe(1);
  });
});

describe("(F2) «Recogido sin pago completo» sigue contando por motivo", () => {
  it("cuenta la razón crítica aunque la subetapa delante sea otra; el enlace abre la subetapa", () => {
    const result = alerts([
      order("recogido", { coverage: "agencia", substage: "recogido_sin_pago_completo", reasons: ["recogido_sin_pago_completo"] }),
      // El motivo está y la subetapa —lo que filtra el enlace— es otra: cuenta
      // igual. Contar por subetapa escondería dinero recogido sin cobrar; el
      // descuadre con la lista queda para el owner (MOM §17.1).
      order("salida-adicional", {
        coverage: "lima",
        substage: "salida_adicional_activa",
        reasons: ["salida_adicional_activa", "recogido_sin_pago_completo"],
      }),
    ]);
    expect(result.picked_without_payment!.count).toBe(2);
    expect(result.picked_without_payment!.href).toBe("/dashboard/pedidos?view=por_cerrar&substage=recogido_sin_pago_completo");
  });
});

describe("(F) el tablero lee de order_master lo que la alerta necesita", () => {
  const access = readFileSync(resolve(process.cwd(), "lib/mom-owner-summary-access.ts"), "utf8").replace(/\s+/g, " ");

  it("pide las columnas y las pasa al hecho del pedido", () => {
    expect(access).toContain('"general_status,status_since,current_courier,last_courier,dispatched_with"');
    for (const pair of [
      "generalStatus: row.general_status",
      "statusSince: row.status_since",
      "currentCourier: row.current_courier",
      "lastCourier: row.last_courier",
      "dispatchedWith: row.dispatched_with",
    ]) {
      expect(access).toContain(pair);
    }
  });
});
