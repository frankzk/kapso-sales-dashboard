// Liquidaciones 2 — el puente parada ↔ fila de cuaderno (MOM §29.12).
import { describe, expect, it } from "vitest";
import { NON_DELIVERY_REASONS } from "@/lib/routes";
import { REPARTO_PROPIO_STATUSES } from "@/lib/sheets/statuses";
import {
  domainStatusToStop,
  sheetPaymentToStop,
  stopPaymentToSheet,
  stopToSheetValues,
} from "@/lib/sheets/stop-bridge";

const known = new Set(NON_DELIVERY_REASONS.map((r) => r.code));

describe("domainStatusToStop", () => {
  it("entrega → entregado; sin salida y en ruta → pendiente; sin código → null", () => {
    expect(domainStatusToStop("entregado", "entrega")).toEqual({ status: "entregado", outcome_reason: null });
    expect(domainStatusToStop("no_salio", "sin_salida")).toEqual({ status: "pendiente", outcome_reason: null });
    expect(domainStatusToStop("en_ruta", "informa")).toEqual({ status: "pendiente", outcome_reason: null });
    expect(domainStatusToStop(null, null)).toBeNull();
    expect(domainStatusToStop("lo_que_sea", null)).toBeNull();
  });

  it("todo estado del dominio Reparto propio cae en un motivo del catálogo de Rutas", () => {
    for (const s of REPARTO_PROPIO_STATUSES) {
      const target = domainStatusToStop(s.code, s.effect);
      expect(target, s.code).not.toBeNull();
      if (target!.status === "no_entregado") expect(known.has(target!.outcome_reason!), `${s.code} → ${target!.outcome_reason}`).toBe(true);
    }
    expect(domainStatusToStop("no_responde", "informa")).toEqual({ status: "no_entregado", outcome_reason: "no_contesta" });
    expect(domainStatusToStop("dato_errado", "informa")).toEqual({ status: "no_entregado", outcome_reason: "direccion_errada" });
    expect(domainStatusToStop("desarmar", "devolucion")).toEqual({ status: "no_entregado", outcome_reason: "otro" });
  });

  it("rechazado y cancelado van al motivo «rechazado» de Rutas (asimetría documentada)", () => {
    expect(domainStatusToStop("rechazado", "anulacion")).toEqual({ status: "no_entregado", outcome_reason: "rechazado" });
    expect(domainStatusToStop("cancelado", "anulacion")).toEqual({ status: "no_entregado", outcome_reason: "rechazado" });
  });
});

describe("métodos de pago", () => {
  it("van y vuelven entre la parada y la lista cerrada del cuaderno", () => {
    expect(stopPaymentToSheet("efectivo")).toBe("Efectivo");
    expect(stopPaymentToSheet("yape")).toBe("Yape Grupo GF");
    expect(stopPaymentToSheet("pos")).toBe("Izipay");
    expect(stopPaymentToSheet("sin_cobro")).toBe("Sin cobro");
    expect(stopPaymentToSheet(null)).toBeNull();
    expect(sheetPaymentToStop("Yape/Plin Frankz")).toBe("yape");
    expect(sheetPaymentToStop("Izipay")).toBe("pos");
    expect(sheetPaymentToStop("Sin cobro")).toBe("sin_cobro");
    expect(sheetPaymentToStop("VENDE MAS")).toBeNull();
  });
});

describe("stopToSheetValues", () => {
  const order = { order_name: "#KP134494", customer_name: "Fredy Guzman", order_total: 149, store_name: "Kenku Peru" };

  it("una entrega reportada desde la pantalla vieja se deriva del enum", () => {
    const values = stopToSheetValues(
      { id: "s1", status: "entregado", outcome_reason: null, payment_method: "efectivo", collected_amount: "149.00", note: "portería", voucher_path: null },
      order,
      { fecha: "2026-09-15", punto: "Punto 03" },
    );
    expect(values).toMatchObject({
      fecha: "2026-09-15",
      punto: "Punto 03",
      tienda: "Kenku",
      cliente: "Fredy Guzman",
      pedido: "#KP134494",
      estado: "entregado",
      estado_reportado: "ENTREGADO",
      efectivo: 149,
      a_cobrar: 149,
      metodo_pago: "Efectivo",
      metodo_pago_reportado: "Efectivo",
      observacion_1: "portería",
      revision: null,
    });
  });

  it("el estado escrito manda sobre el enum, y un motivo «otro» sin escrito queda a revisión", () => {
    const written = stopToSheetValues(
      { id: "s2", status: "no_entregado", outcome_reason: "otro", payment_method: null, collected_amount: null, note: null, voucher_path: null, written_status: "LO DEJA", written_status_code: "no_salio" },
      order,
      { fecha: "2026-09-15", punto: "Punto 04" },
    );
    expect(written).toMatchObject({ estado: "no_salio", estado_reportado: "LO DEJA", a_cobrar: 149, metodo_pago: null, revision: null });
    const otro = stopToSheetValues(
      { id: "s3", status: "no_entregado", outcome_reason: "otro", payment_method: null, collected_amount: null, note: "ver nota", voucher_path: null },
      order,
      { fecha: "2026-09-15", punto: "Punto 05" },
    );
    expect(otro).toMatchObject({ estado: null, estado_reportado: "Otro (ver nota)", revision: "estado_sin_equivalente" });
  });

  it("un no contesta del catálogo vuelve como no_responde, y el Yape trae su captura", () => {
    const values = stopToSheetValues(
      { id: "s4", status: "no_entregado", outcome_reason: "no_contesta", payment_method: null, collected_amount: null, note: null, voucher_path: null },
      order,
      { fecha: "2026-09-15", punto: "Punto 06" },
    );
    expect(values).toMatchObject({ estado: "no_responde", estado_reportado: "No contesta", efectivo: null });
    const yape = stopToSheetValues(
      { id: "s5", status: "entregado", outcome_reason: null, payment_method: "yape", collected_amount: 89, note: null, voucher_path: "r/s5/yape.jpg" },
      order,
      { fecha: "2026-09-15", punto: "Punto 07" },
    );
    expect(yape).toMatchObject({ estado: "entregado", efectivo: null, a_cobrar: 89, metodo_pago: "Yape Grupo GF", comprobante_path: "r/s5/yape.jpg" });
  });
});
