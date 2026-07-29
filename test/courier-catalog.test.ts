import { describe, expect, it } from "vitest";
import {
  AGENCY_COURIER_IDS,
  COURIERS,
  courierInfo,
  courierName,
  DIRECT_GUIDE_COURIERS,
  isDirectGuideCourier,
} from "@/lib/couriers/catalog";
import { courierLabel } from "@/lib/couriers/registry";
import { isAgencyCourier } from "@/lib/order-status";
import { earliestDispatchDay } from "@/lib/shipments";

describe("catálogo de couriers", () => {
  it("no repite ids: el id es lo que se guarda en shipments.courier", () => {
    expect(new Set(COURIERS.map((c) => c.id)).size).toBe(COURIERS.length);
  });

  it("los ids van en minúsculas, como los valores ya escritos en shipments", () => {
    for (const c of COURIERS) expect(c.id).toBe(c.id.toLowerCase());
  });

  it("Axel está dado de alta y admite guía directa", () => {
    expect(courierInfo("axel")).toEqual({
      id: "axel",
      label: "Axel Courier",
      agency: false,
      direct: true,
    });
    expect(isDirectGuideCourier("axel")).toBe(true);
  });

  it("resuelve sin importar mayúsculas: los reportes escriben como quieren", () => {
    expect(courierName("AXEL")).toBe("Axel Courier");
    expect(courierInfo("Fenix")?.id).toBe("fenix");
  });

  it("un courier desconocido se ve con su id, no desaparece", () => {
    expect(courierName("courier_nuevo")).toBe("courier_nuevo");
    expect(courierName(null)).toBe("—");
    expect(isDirectGuideCourier("courier_nuevo")).toBe(false);
  });

  it("solo son directos los couriers a los que despachamos por nuestra cuenta", () => {
    expect(DIRECT_GUIDE_COURIERS.map((c) => c.id).sort()).toEqual(["axel", "fenix"]);
    // Aliclik crea la guía por API y Shalom/Olva llegan por reporte: no se les
    // inventa una guía desde un pedido.
    expect(isDirectGuideCourier("aliclik")).toBe(false);
    expect(isDirectGuideCourier("shalom")).toBe(false);
  });
});

describe("el catálogo es la única fuente de quién es agencia", () => {
  it("order-status usa los ids del catálogo", () => {
    expect(AGENCY_COURIER_IDS.sort()).toEqual(["olva", "shalom"]);
    for (const id of AGENCY_COURIER_IDS) expect(isAgencyCourier(id)).toBe(true);
    // Axel reparte a domicilio: si entrara como agencia, sus pedidos pasarían a
    // tener el ciclo de vida de recojo en sucursal (§10).
    expect(isAgencyCourier("axel")).toBe(false);
    expect(isAgencyCourier("fenix")).toBe(false);
  });
});

describe("courierLabel", () => {
  it("cae al catálogo cuando el courier no tiene adaptador de reporte", () => {
    // Axel nunca tendrá adaptador: solo manda liquidación.
    expect(courierLabel("axel")).toBe("Axel Courier");
    expect(courierLabel("fenix")).toBe("Fenix");
  });

  it("sigue prefiriendo la etiqueta del adaptador cuando la hay", () => {
    expect(courierLabel("aliclik")).toBe("Aliclik");
    expect(courierLabel("shalom")).toBe("Shalom");
  });
});

describe("earliestDispatchDay", () => {
  // 2026-07-29 15:00 UTC = 10:00 en Lima (UTC−5), mismo día calendario.
  const now = new Date("2026-07-29T15:00:00Z");

  it("Fénix no admite hoy: su Excel de programación del día ya salió", () => {
    expect(earliestDispatchDay("fenix", now)).toBe("2026-07-30");
  });

  it("Axel recoge el mismo día", () => {
    expect(earliestDispatchDay("axel", now)).toBe("2026-07-29");
  });

  it("cruza el fin de mes sin inventar el día 32", () => {
    expect(earliestDispatchDay("fenix", new Date("2026-07-31T15:00:00Z"))).toBe("2026-08-01");
  });
});
