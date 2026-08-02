import { describe, expect, it } from "vitest";
import { operationFitsCourier, routeKindForCourier } from "@/lib/dispatch-routing";
import { deriveDispatchManifestState, needsRiderCheck, routeDay, routeName } from "@/lib/dispatch";

describe("routeKindForCourier", () => {
  it("los que reparten con motorizado son rutas de reparto", () => {
    for (const courier of ["propio", "axel", "urpi", "tanders", "fenix"]) {
      expect(routeKindForCourier(courier)).toBe("reparto");
    }
  });

  it("Aliclik y las agencias son entregas al courier", () => {
    // Nadie del otro lado escanea: Aliclik recoge y a Shalom/Olva se les lleva
    // la caja. Exigirles el cotejo del motorizado dejaba la ruta trabada.
    for (const courier of ["aliclik", "shalom", "olva"]) {
      expect(routeKindForCourier(courier)).toBe("entrega_courier");
    }
  });

  it("un courier desconocido reparte, que es el caso con más control", () => {
    expect(routeKindForCourier("courier nuevo")).toBe("reparto");
    expect(routeKindForCourier(null)).toBe("reparto");
  });
});

describe("needsRiderCheck", () => {
  it("solo el reparto termina con el cotejo del motorizado", () => {
    expect(needsRiderCheck("reparto")).toBe(true);
    expect(needsRiderCheck("entrega_courier")).toBe(false);
  });
});

describe("operationFitsCourier", () => {
  it("un pedido de provincia no entra en la caja de un motorizado de Lima", () => {
    const verdict = operationFitsCourier("propio", "provincia_cod");
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("Provincia COD");
    expect(verdict.reason).toContain("Lima");
  });

  it("Tanders es exclusivo de Lima (MOM §5)", () => {
    expect(operationFitsCourier("tanders", "lima").ok).toBe(true);
    expect(operationFitsCourier("tanders", "provincia_cod").ok).toBe(false);
    expect(operationFitsCourier("tanders", "agencia").ok).toBe(false);
  });

  it("Swayp atiende Lima y provincia (Reproprovincia, MOM §11)", () => {
    expect(operationFitsCourier("fenix", "lima").ok).toBe(true);
    expect(operationFitsCourier("fenix", "provincia_cod").ok).toBe(true);
    expect(operationFitsCourier("fenix", "agencia").ok).toBe(false);
  });

  it("Aliclik es provincia; las agencias, agencia", () => {
    expect(operationFitsCourier("aliclik", "provincia_cod").ok).toBe(true);
    expect(operationFitsCourier("aliclik", "lima").ok).toBe(false);
    expect(operationFitsCourier("shalom", "agencia").ok).toBe(true);
    expect(operationFitsCourier("olva", "lima").ok).toBe(false);
  });

  it("una operación sin clasificar NO bloquea", () => {
    // El dato falta; negarle el despacho a una caja que existe físicamente es
    // peor que dejarla pasar. Lo que se bloquea es la contradicción explícita.
    expect(operationFitsCourier("propio", "desconocida").ok).toBe(true);
    expect(operationFitsCourier("propio", null).ok).toBe(true);
  });

  it("un courier fuera del catálogo no inventa restricciones", () => {
    expect(operationFitsCourier("courier nuevo", "provincia_cod").ok).toBe(true);
  });
});

describe("routeName (el texto que evita mandar los paquetes con el motorizado equivocado)", () => {
  it("empieza por la persona, que es lo que distingue dos rutas del mismo día", () => {
    expect(
      routeName({ driver_name: "Roy", received_by: null, route_label: "Surco", route_date: "2026-08-03" }),
    ).toBe("Roy · Surco · 03/08");
  });

  it("en una entrega al courier nombra a quien recogió", () => {
    expect(
      routeName({ driver_name: null, received_by: "Rosa (Aliclik)", route_label: "Recojo", route_date: "2026-08-03" }),
    ).toBe("Rosa (Aliclik) · Recojo · 03/08");
  });

  it("sin persona no deja un separador huérfano", () => {
    expect(
      routeName({ driver_name: null, received_by: null, route_label: "Surco", route_date: "2026-08-03" }),
    ).toBe("Surco · 03/08");
  });

  it("la fecha se lee como en la tarjeta", () => {
    expect(routeDay("2026-12-25")).toBe("25/12");
  });
});

describe("deriveDispatchManifestState según el tipo de ruta", () => {
  const item = (office: boolean, pickup: boolean) => ({
    office_checked_at: office ? "2026-08-02T10:00:00Z" : null,
    pickup_checked_at: pickup ? "2026-08-02T11:00:00Z" : null,
  });

  it("sin paquetes es borrador", () => {
    expect(deriveDispatchManifestState([], "draft", "reparto")).toBe("draft");
  });

  it("el reparto pasa por el cotejo del motorizado", () => {
    expect(deriveDispatchManifestState([item(false, false)], "draft", "reparto")).toBe("office_check");
    expect(deriveDispatchManifestState([item(true, false)], "office_check", "reparto")).toBe("ready_for_pickup");
    expect(deriveDispatchManifestState([item(true, true), item(true, false)], "ready_for_pickup", "reparto")).toBe("pickup_check");
  });

  it("la entrega al courier se queda en «listo para recojo» hasta que se cierra", () => {
    // Antes derivaba a un estado que esperaba un cotejo imposible.
    expect(deriveDispatchManifestState([item(true, false)], "office_check", "entrega_courier")).toBe("ready_for_pickup");
    expect(deriveDispatchManifestState([item(true, true)], "ready_for_pickup", "entrega_courier")).toBe("ready_for_pickup");
  });

  it("cerrada o cancelada no se recalcula", () => {
    expect(deriveDispatchManifestState([item(true, true)], "in_custody", "reparto")).toBe("in_custody");
    expect(deriveDispatchManifestState([item(false, false)], "cancelled", "entrega_courier")).toBe("cancelled");
  });

  it("sin tipo explícito se comporta como reparto", () => {
    expect(deriveDispatchManifestState([item(true, false)], "office_check")).toBe("ready_for_pickup");
  });
});
