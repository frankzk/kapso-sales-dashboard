import { describe, expect, it } from "vitest";
import { gfOutputIsCancelableBeforeDispatch } from "@/lib/gf-output-cancel";
import { cancelledAsRecordCorrection } from "@/lib/shipment-output";
import { wooCancelBlocks } from "@/lib/woo-cancel";

const output = { id: "s1", courier: "propio", created_via: "grupo_gf_courier", delivery_status: "pendiente", custody_state: "empresa",
  dispatched_at: null, custody_transferred_at: null, returned_at: null, reported_status: null };
describe("retirar salida de Grupo GF antes del despacho", () => {
  it("ofrece retiro en almacén, nunca ante prueba de movimiento, reporte u otro courier", () => {
    expect(gfOutputIsCancelableBeforeDispatch(output)).toBe(true);
    for (const patch of [{ courier: "aliclik" }, { created_via: "mom_manual_route" }, { custody_state: null },
      { custody_state: "courier" }, { delivery_status: "anulado" }, { delivery_status: "en_ruta" },
      { dispatched_at: "2026-10-28" }, { custody_transferred_at: "2026-10-28" }, { returned_at: "2026-10-28" }, { reported_status: "No entregado" }]) {
      expect(gfOutputIsCancelableBeforeDispatch({ ...output, ...patch })).toBe(false);
    }
  });
  it("cancelar la salida es una corrección de registro, y no la anulación de la venta", () => {
    expect(cancelledAsRecordCorrection({ ...output, delivery_status: "anulado" }, new Set([output.id]))).toBe(true);
    const facts = { platform: "woocommerce", generalStatus: "en_proceso", financialStatus: "pending", shipments: [output], payments: [] };
    expect(wooCancelBlocks(facts)[0]?.message).toContain("Retirar y anular salida");
    expect(wooCancelBlocks({ ...facts, shipments: [{ ...output, delivery_status: "anulado" }] })).toEqual([]);
    expect(wooCancelBlocks({ ...facts, shipments: [{ ...output, delivery_status: "anulado", custody_state: "courier" }] })[0]?.code).toBe("caja_afuera");
  });
});
