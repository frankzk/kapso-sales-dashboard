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

  it("un estado que nunca hemos visto NO se traduce", () => {
    // Su vocabulario no está documentado. Adivinar es inventar estados que el
    // MOM no tiene; lo correcto es guardarlo crudo y no tocar la guía.
    for (const raw of ["IN_ROUTE", "CANCELLED", "ASSIGNED", "", "cualquier cosa"]) {
      const mapped = mapTandersStatus(raw);
      expect(mapped.known).toBe(false);
      expect(mapped.deliveryStatus).toBeNull();
      expect(mapped.custodyState).toBeNull();
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

  it("sin dato entrante no cambia nada", () => {
    expect(reconcileTandersCustodyState("empresa", null)).toBe("empresa");
    expect(reconcileTandersCustodyState(null, null)).toBeNull();
  });

  it("sin estado previo acepta el entrante", () => {
    expect(reconcileTandersCustodyState(null, "courier")).toBe("courier");
  });
});
