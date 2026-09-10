import { describe, expect, it } from "vitest";
import {
  mapTandersStatus,
  reconcileTandersCustodyState,
  tandersStatusCode,
} from "@/lib/tanders/status";

describe("tandersStatusCode", () => {
  it("normaliza mayúsculas y el castellano que su API también devuelve", () => {
    // Al crear se ha visto tanto `PENDING` como `Pendiente`.
    expect(tandersStatusCode("PENDING")).toBe("PENDING");
    expect(tandersStatusCode("Pendiente")).toBe("PENDING");
    expect(tandersStatusCode(" delivered ")).toBe("DELIVERED");
    expect(tandersStatusCode(null)).toBe("");
  });
});

describe("mapTandersStatus", () => {
  it("PENDING es la guía viva en la empresa", () => {
    const mapped = mapTandersStatus("PENDING");
    expect(mapped.known).toBe(true);
    expect(mapped.deliveryStatus).toBe("pendiente");
    expect(mapped.custodyState).toBe("empresa");
  });

  it("DELIVERED acredita custodia del courier, NO el cobro", () => {
    // En Tanders cobra el motorizado: la guía solo pasa a `entregado` con la
    // constancia validada (§9.4). Traducirlo aquí daría por cobrado un dinero
    // que nadie confirmó, y se saltaría el barrido de cobros.
    const mapped = mapTandersStatus("DELIVERED");
    expect(mapped.custodyState).toBe("courier");
    expect(mapped.deliveryStatus).toBe("en_ruta");
    expect(mapped.deliveryStatus).not.toBe("entregado");
  });

  it("PICKED es el paquete en manos del motorizado", () => {
    const mapped = mapTandersStatus("PICKED");
    expect(mapped.deliveryStatus).toBe("en_ruta");
    expect(mapped.custodyState).toBe("courier");
    expect(mapped.returned).toBe(false);
  });

  it("RETURNING todavía NO es una devolución: la guía sigue viva", () => {
    // El paquete va de camino de vuelta pero no ha llegado. Sellar aquí
    // `returned_at` metería en la cola de recuperación —y pediría un adelanto
    // a la clienta— por un paquete que nadie ha recibido aún.
    const mapped = mapTandersStatus("RETURNING");
    expect(mapped.deliveryStatus).toBe("en_ruta");
    expect(mapped.custodyState).toBe("retorno");
    expect(mapped.returned).toBe(false);
  });

  it("RETURNED cierra la GUÍA pero deja el pedido disponible", () => {
    // Confirmado por la operación (10-09-2026): el paquete ya está en el
    // almacén y puede volver a salir con otro courier mientras no se anule en
    // Shopify. Por eso `anulado` es de la guía, no del pedido.
    const mapped = mapTandersStatus("RETURNED");
    expect(mapped.deliveryStatus).toBe("anulado");
    expect(mapped.custodyState).toBe("devuelto");
    expect(mapped.returned).toBe(true);
  });

  it("CANCELLED no afirma dónde está el paquete", () => {
    // Que la guía muera no dice si el paquete volvió. Inventar `devuelto`
    // mandaría a buscar al almacén algo que puede seguir en la calle.
    const mapped = mapTandersStatus("CANCELLED");
    expect(mapped.deliveryStatus).toBe("anulado");
    expect(mapped.custodyState).toBeNull();
    expect(mapped.returned).toBe(false);
  });

  it("un estado que nunca hemos visto NO se traduce", () => {
    // Su vocabulario no está documentado. Adivinar es inventar estados que el
    // MOM no tiene; lo correcto es guardarlo crudo y no tocar la guía.
    for (const raw of ["IN_ROUTE", "ASSIGNED", "", "cualquier cosa"]) {
      const mapped = mapTandersStatus(raw);
      expect(mapped.known).toBe(false);
      expect(mapped.deliveryStatus).toBeNull();
      expect(mapped.custodyState).toBeNull();
      expect(mapped.returned).toBe(false);
    }
  });

  it("conserva el código crudo normalizado para poder reportarlo", () => {
    expect(mapTandersStatus("IN_ROUTE").code).toBe("IN_ROUTE");
  });
});

describe("reconcileTandersCustodyState", () => {
  it("la custodia solo avanza", () => {
    // Un snapshot atrasado no puede devolver a la empresa un paquete que ya se
    // llevó el motorizado.
    expect(reconcileTandersCustodyState("courier", "empresa")).toBe("courier");
    expect(reconcileTandersCustodyState("empresa", "courier")).toBe("courier");
    expect(reconcileTandersCustodyState("devuelto", "courier")).toBe("devuelto");
  });

  it("el retorno va entre el courier y el almacén", () => {
    // «De camino de vuelta» avanza sobre «en manos del motorizado», pero un
    // snapshot con RETURNING no puede deshacer un paquete YA recibido.
    expect(reconcileTandersCustodyState("courier", "retorno")).toBe("retorno");
    expect(reconcileTandersCustodyState("retorno", "devuelto")).toBe("devuelto");
    expect(reconcileTandersCustodyState("devuelto", "retorno")).toBe("devuelto");
  });

  it("sin dato entrante no cambia nada", () => {
    expect(reconcileTandersCustodyState("empresa", null)).toBe("empresa");
    expect(reconcileTandersCustodyState(null, null)).toBeNull();
  });

  it("sin estado previo acepta el entrante", () => {
    expect(reconcileTandersCustodyState(null, "courier")).toBe("courier");
  });
});
