import { describe, expect, it } from "vitest";
import {
  OBSERVATIONS_SCREEN_HREF,
  OBSERVATIONS_SCREEN_LABEL,
  OPEN_OBSERVATION_SKIP_REASON,
  bulkAllSkippedError,
  bulkDeliveredSkips,
  bulkStatusNotice,
} from "@/lib/bulk-status-guard";

// MOM §30.8: una observación de cuadre abierta no deja pasar a entregado.
// Auditoría del 14-10-2026: el cambio de estado en lote no la miraba.

describe("bulkDeliveredSkips", () => {
  const open = new Set(["b", "d"]);

  it("a entregado salta los pedidos con observación abierta, en el orden de la selección", () => {
    expect(bulkDeliveredSkips("entregado", ["a", "b", "c", "d"], open)).toEqual([
      { orderId: "b", error: OPEN_OBSERVATION_SKIP_REASON },
      { orderId: "d", error: OPEN_OBSERVATION_SKIP_REASON },
    ]);
  });

  it("a otro estado no salta ninguno: §30.8 cierra la puerta a entregado", () => {
    expect(bulkDeliveredSkips("en_proceso", ["a", "b"], open)).toEqual([]);
    expect(bulkDeliveredSkips("devuelto", ["b"], open)).toEqual([]);
  });

  it("sin observaciones abiertas no salta ninguno", () => {
    expect(bulkDeliveredSkips("entregado", ["a", "c"], open)).toEqual([]);
  });

  it("el motivo dice qué falta, quién lo resuelve y cómo se llega a Liquidaciones 2", () => {
    // Fuera del menú desde el 22-09-2026 y sin enlace desde otra pantalla: el
    // texto dice la dirección (auditoría del 14-10-2026).
    expect(OBSERVATIONS_SCREEN_HREF).toBe("/dashboard/liquidaciones-2");
    expect(OBSERVATIONS_SCREEN_LABEL).toBe("Liquidaciones 2 (/dashboard/liquidaciones-2; no está en el menú)");
    expect(OPEN_OBSERVATION_SKIP_REASON).toBe(
      "Saltado: tiene una observación de cuadre abierta en Liquidaciones 2 (/dashboard/liquidaciones-2; no está en el menú)." +
        " Quien liquida debe aceptar el motivo antes de marcarlo entregado.",
    );
  });

  it("si se saltaron todos, el error lo dice con la misma dirección", () => {
    expect(bulkAllSkippedError(1)).toBe(
      "Ningún pedido se marcó entregado: tiene una observación de cuadre abierta en Liquidaciones 2" +
        " (/dashboard/liquidaciones-2; no está en el menú). Quien liquida debe aceptar el motivo primero.",
    );
    expect(bulkAllSkippedError(3)).toContain("los 3 tienen una observación de cuadre abierta en Liquidaciones 2 (");
  });
});

describe("bulkStatusNotice", () => {
  it("cuenta aplicados, saltados y con problemas", () => {
    expect(bulkStatusNotice({ applied: 3, skipped: 2, failed: 1 })).toBe(
      "3 pedidos actualizados. 2 saltados por una observación de cuadre abierta en Liquidaciones 2" +
        " (/dashboard/liquidaciones-2; no está en el menú). 1 con problemas.",
    );
  });

  it("en singular y sin partes vacías", () => {
    expect(bulkStatusNotice({ applied: 1, skipped: 1, failed: 0 })).toBe(
      "1 pedido actualizado. 1 saltado por una observación de cuadre abierta en Liquidaciones 2" +
        " (/dashboard/liquidaciones-2; no está en el menú).",
    );
    expect(bulkStatusNotice({ applied: 4, skipped: 0, failed: 0 })).toBe("4 pedidos actualizados.");
    expect(bulkStatusNotice({ applied: 0, skipped: 0, failed: 0 })).toBeUndefined();
  });
});
