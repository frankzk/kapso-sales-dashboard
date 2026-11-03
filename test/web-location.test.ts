import { describe, expect, it } from "vitest";
import { leadCoverage } from "@/lib/lead-coverage";
import { parseOrderSignals } from "@/lib/kapso";
import { parseWebLocation, webLocationCoverage, webLocationLeadFields } from "@/lib/web-location";

const msg = (ubicacion: string, tienda = "kenku.pe") =>
  `Hola, quiero pedir SUPER HUMAN Ethiopian Black Seed Oil – Aceite de Semilla Negra Etíope Alta Potencia (60 Cápsulas). Soy de ${ubicacion}. https://${tienda}/products/purely-nutrient-ethiopian-black-seed-oil/`;

const lead = (first_inbound_text: string | null, patch: Record<string, string | null> = {}) => ({
  store_id: "store-1",
  region: null,
  province: null,
  district: null,
  first_inbound_text,
  ...patch,
});

describe("parseWebLocation: el mensaje con que se salta de la web al WhatsApp", () => {
  it("lee departamento, provincia y distrito", () => {
    expect(parseWebLocation(msg("Lima / Lima / Santa Anita"))).toEqual({
      department: "Lima",
      province: "Lima",
      district: "Santa Anita",
    });
    expect(parseWebLocation(msg("Cajamarca / San Marcos / Eduardo Villanueva", "aurela.pe"))).toEqual({
      department: "Cajamarca",
      province: "San Marcos",
      district: "Eduardo Villanueva",
    });
  });

  it("aguanta el final sin punto ni link, y los espacios de más", () => {
    expect(parseWebLocation("Hola, quiero pedir X. Soy de  Junín /Tarma/ Tarma")).toEqual({
      department: "Junín",
      province: "Tarma",
      district: "Tarma",
    });
  });

  it("null si no trae las tres partes", () => {
    expect(parseWebLocation("¡Hola! Quiero más información")).toBeNull();
    expect(parseWebLocation("Soy de Arequipa")).toBeNull();
    expect(parseWebLocation(null)).toBeNull();
  });
});

describe("webLocationCoverage y la cola de leads", () => {
  it("Lima / Lima y Callao son Lima; el resto, Provincia", () => {
    expect(leadCoverage(lead(msg("Lima / Lima / Santa Anita")))).toBe("lima");
    expect(leadCoverage(lead(msg("Callao / Callao / Bellavista")))).toBe("lima");
    expect(leadCoverage(lead(msg("Junín / Tarma / Tarma")))).toBe("provincia");
    // Huaral es del departamento de Lima, pero no de la metropolitana.
    expect(leadCoverage(lead(msg("Lima / Huaral / Chancay")))).toBe("provincia");
  });

  it("la provincia desempata los homónimos: San Luis de Cañete no es el de Lima", () => {
    expect(leadCoverage(lead(msg("Lima / Cañete / San Luis")))).toBe("provincia");
    expect(leadCoverage(lead(msg("Lima / Lima / San Luis")))).toBe("lima");
  });

  it("las excepciones de district_coverage mandan (Pucusana va por agencia)", () => {
    const overrides = [{ store_id: null, district: "pucusana", coverage: "agencia" as const }];
    expect(leadCoverage(lead(msg("Lima / Lima / Pucusana")), { overrides })).toBe("provincia");
    expect(
      webLocationCoverage({ department: "Lima", province: "Lima", district: "Pucusana" }, "store-1", overrides),
    ).toBe("provincia");
  });

  it("gana a un distrito suelto del chat, pero no a una región guardada", () => {
    expect(leadCoverage(lead(msg("Junín / Tarma / Tarma"), { district: "Lima" }))).toBe("provincia");
    expect(
      leadCoverage(lead(msg("Junín / Tarma / Tarma"), { region: "Lima (provincia)", district: "Los Olivos" })),
    ).toBe("lima");
  });

  it("gana al pedido anterior: es lo que dijo hoy", () => {
    expect(leadCoverage(lead(msg("Lima / Lima / Ate")), { priorCoverage: "agencia" })).toBe("lima");
  });
});

describe("webLocationLeadFields: cómo se guarda en el lead", () => {
  it("la región con la convención del carrito; la provincia, la del INEI", () => {
    expect(webLocationLeadFields({ department: "Lima", province: "Lima", district: "Santa Anita" })).toEqual({
      region: "Lima (provincia)",
      province: "Lima",
      district: "Santa Anita",
    });
    expect(webLocationLeadFields({ department: "Lima", province: "Huaral", district: "Chancay" })).toEqual({
      region: "Lima (departamento)",
      province: "Huaral",
      district: "Chancay",
    });
    expect(webLocationLeadFields({ department: "Junín", province: "Tarma", district: "Tarma" })).toEqual({
      region: "Junín",
      province: "Tarma",
      district: "Tarma",
    });
  });

  it("lo guardado se lee igual en la cola, ya sin el mensaje", () => {
    for (const [ubicacion, esperado] of [
      ["Lima / Lima / Santa Anita", "lima"],
      ["Lima / Huaral / Chancay", "provincia"],
      ["Lima / Cañete / San Luis", "provincia"],
      ["Callao / Callao / Bellavista", "lima"],
      ["Cajamarca / San Marcos / Eduardo Villanueva", "provincia"],
    ] as const) {
      const loc = parseWebLocation(msg(ubicacion))!;
      expect(leadCoverage(lead(null, webLocationLeadFields(loc)))).toBe(esperado);
    }
  });
});

describe("parseOrderSignals con la ubicación de la web", () => {
  it("el distrito elegido en la web gana a la respuesta del chat", () => {
    const s = parseOrderSignals([
      { t: 1, dir: "inbound", text: msg("Lima / Lima / Santa Anita") },
      { t: 2, dir: "outbound", text: "¿A qué distrito sería el envío?" },
      { t: 3, dir: "inbound", text: "Precio" },
    ]);
    expect(s.web_location).toEqual({ department: "Lima", province: "Lima", district: "Santa Anita" });
    expect(s.district).toBe("Santa Anita");
  });

  it("sin el mensaje de la web, todo sigue como antes", () => {
    const s = parseOrderSignals([
      { t: 1, dir: "outbound", text: "¿A qué distrito sería el envío?" },
      { t: 2, dir: "inbound", text: "Chosica" },
    ]);
    expect(s.web_location).toBeNull();
    expect(s.district).toBe("Chosica");
  });
});
