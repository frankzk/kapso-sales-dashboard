import { describe, expect, it } from "vitest";
import { countLeadCoverage, isLeadCoverage, leadCoverage } from "@/lib/lead-coverage";

const lead = (patch: { region?: string | null; province?: string | null; district?: string | null }) => ({
  store_id: "store-1",
  region: null,
  province: null,
  district: null,
  ...patch,
});

describe("cobertura del lead — dirección del carrito de Shopify", () => {
  it("Lima (provincia) es Lima; el distrito confirma", () => {
    expect(leadCoverage(lead({ region: "Lima (provincia)", province: "Lima (provincia)", district: "Los Olivos" }))).toBe(
      "lima",
    );
  });

  it("Callao es Lima", () => {
    expect(leadCoverage(lead({ region: "Callao", province: "Callao", district: "Ventanilla" }))).toBe("lima");
  });

  it("otro departamento es provincia aunque el distrito se llame como uno de Lima", () => {
    expect(leadCoverage(lead({ region: "Arequipa", province: "Arequipa", district: "Miraflores" }))).toBe("provincia");
    expect(leadCoverage(lead({ region: "Áncash", province: "Áncash", district: "Casma" }))).toBe("provincia");
  });

  it("las provincias del departamento de Lima van a provincia (agencia)", () => {
    for (const district of ["Huaura", "Barranca", "Cañete"]) {
      expect(leadCoverage(lead({ region: "Lima (departamento)", province: "Lima (departamento)", district }))).toBe(
        "provincia",
      );
    }
  });

  it("Lima (departamento) con un distrito metropolitano es Lima (el distrito gana)", () => {
    expect(leadCoverage(lead({ region: "Lima (departamento)", district: "San Juan de Lurigancho" }))).toBe("lima");
  });

  it("Lima (departamento) sin distrito legible NO se da por provincia: 30 % resulta ser Lima", () => {
    expect(leadCoverage(lead({ region: "Lima (departamento)", province: "Lima (departamento)", district: "-" }))).toBe(
      "sin_identificar",
    );
  });
});

describe("cobertura del lead — dirección guardada (Flow) y respuestas del chat", () => {
  it("el Flow deja el departamento en `province` y nada en `region`: se lee igual", () => {
    // Medido: 18 leads así salían como agencia por mirar solo `region`.
    expect(leadCoverage(lead({ province: "Lima (provincia)", district: "indicarte bien 🚚" }))).toBe("lima");
    expect(leadCoverage(lead({ province: "Callao", district: "indicarte bien 🚚" }))).toBe("lima");
    expect(leadCoverage(lead({ province: "Cuzco", district: "indicarte bien 🚚" }))).toBe("provincia");
    expect(leadCoverage(lead({ province: "Lima (departamento)", district: "indicarte bien 🚚" }))).toBe(
      "sin_identificar",
    );
  });

  it("los botones «¿Lima o provincia?» del bot", () => {
    expect(leadCoverage(lead({ district: "Selected: Lima" }))).toBe("lima");
    expect(leadCoverage(lead({ district: "Selected: Provincia" }))).toBe("provincia");
    expect(leadCoverage(lead({ district: "Provincia" }))).toBe("provincia");
    expect(leadCoverage(lead({ district: "lima" }))).toBe("lima");
  });

  it("la pregunta del bot o frases del bot no son un lugar", () => {
    for (const district of [
      "Lima o provincia",
      "indicarte bien 🚚",
      "dejártelo listo",
      "coordinarlo",
      "Precio",
      "tu zona",
      "¡Hola! Quiero más información",
      "-",
    ]) {
      expect(leadCoverage(lead({ district })), district).toBe("sin_identificar");
    }
  });

  it("distritos de Lima escritos por la clienta", () => {
    for (const district of [
      "Comas",
      "En Comas",
      "San Isidro",
      "La Molina",
      "San juan de lurigancho",
      "Ate vitarte x Santa Clara",
      "Chosica 🏠✨",
      "De Liam chorrillos",
      "Hantes de ventanilla",
      "Cercado de lima",
    ]) {
      expect(leadCoverage(lead({ district })), district).toBe("lima");
    }
  });

  it("ciudades y provincias escritas por la clienta", () => {
    for (const district of [
      "Trujillo",
      "Cusco",
      "En HUANCAYO",
      "Arequipa cuanto tarda en llegar",
      "Chimbote",
      "Juliaca",
      "Distrito de piura",
      "Desde Ancash distrito de huantar",
      "EN provincias. EN pucallpa",
      "A chulucanas llega igual mañana mismo",
      "Chiclayo la victoria",
      "En la ciudad de HUACHO",
    ]) {
      expect(leadCoverage(lead({ district })), district).toBe("provincia");
    }
  });

  it("un distrito que existe en Lima y en provincia, dicho a secas, no se adivina", () => {
    expect(leadCoverage(lead({ district: "Independencia" }))).toBe("sin_identificar");
    expect(leadCoverage(lead({ district: "en la victoria" }))).toBe("sin_identificar");
    expect(leadCoverage(lead({ district: "Bellavista" }))).toBe("sin_identificar");
  });

  it("si nombra Lima y provincia a la vez, no se adivina", () => {
    expect(leadCoverage(lead({ district: "Av Arequipa Chorrillos" }))).toBe("sin_identificar");
  });

  it("un distrito de Lima que contiene el nombre de una provincia sigue siendo Lima", () => {
    expect(leadCoverage(lead({ district: "San Martin de Porres" }))).toBe("lima");
    expect(leadCoverage(lead({ district: "Santa Anita" }))).toBe("lima");
    expect(leadCoverage(lead({ district: "San Miguel" }))).toBe("sin_identificar"); // también es Cajamarca y Puno
  });

  it("sin nada no hay cobertura", () => {
    expect(leadCoverage(lead({}))).toBe("sin_identificar");
  });
});

describe("cobertura del lead — excepciones de distrito (0121)", () => {
  const overrides = [{ store_id: null, district: "pucusana", coverage: "agencia" as const }];

  it("Pucusana va por agencia, igual que el pedido", () => {
    expect(leadCoverage(lead({ district: "Pucusana" }))).toBe("lima");
    expect(leadCoverage(lead({ district: "Pucusana" }), { overrides })).toBe("provincia");
    expect(leadCoverage(lead({ region: "Lima (provincia)", district: "Pucusana" }), { overrides })).toBe("provincia");
  });

  it("la regla de una tienda gana sobre la global", () => {
    const rules = [
      ...overrides,
      { store_id: "store-1", district: "pucusana", coverage: "lima" as const },
    ];
    expect(leadCoverage(lead({ district: "Pucusana" }), { overrides: rules })).toBe("lima");
  });
});

describe("cobertura del lead — pedido anterior del mismo teléfono", () => {
  it("decide solo cuando la dirección del lead no dice nada", () => {
    expect(leadCoverage(lead({}), { priorCoverage: "lima" })).toBe("lima");
    expect(leadCoverage(lead({}), { priorCoverage: "provincia_cod" })).toBe("provincia");
    expect(leadCoverage(lead({}), { priorCoverage: "agencia" })).toBe("provincia");
    expect(leadCoverage(lead({ district: "Precio" }), { priorCoverage: "lima" })).toBe("lima");
  });

  it("lo que el lead dijo hoy gana sobre su pedido anterior", () => {
    expect(leadCoverage(lead({ district: "Trujillo" }), { priorCoverage: "lima" })).toBe("provincia");
    expect(leadCoverage(lead({ district: "Comas" }), { priorCoverage: "agencia" })).toBe("lima");
  });

  it("«Por revisar» no es pista", () => {
    expect(leadCoverage(lead({}), { priorCoverage: "por_revisar" })).toBe("sin_identificar");
  });
});

describe("conteo", () => {
  it("cuenta las tres y valida la clave", () => {
    expect(countLeadCoverage(["lima", "lima", "provincia", "sin_identificar"])).toEqual({
      lima: 2,
      provincia: 1,
      sin_identificar: 1,
    });
    expect(isLeadCoverage("lima")).toBe(true);
    expect(isLeadCoverage("agencia")).toBe(false);
  });
});

describe("cobertura del lead — dirección del cliente en Shopify (0228)", () => {
  it("es la última pista: se lee con las mismas reglas que la del lead", () => {
    expect(leadCoverage(lead({}), { shopifyAddress: { province: "Lima (provincia)", city: "Los Olivos" } })).toBe("lima");
    expect(leadCoverage(lead({}), { shopifyAddress: { province: "Arequipa", city: "Cayma" } })).toBe("provincia");
    expect(leadCoverage(lead({}), { shopifyAddress: { province: "Lima (departamento)", city: "Huaral" } })).toBe(
      "provincia",
    );
    // «Lima (departamento)» sin distrito legible sigue sin decir nada.
    expect(leadCoverage(lead({}), { shopifyAddress: { province: "Lima (departamento)", city: null } })).toBe(
      "sin_identificar",
    );
  });

  it("lo que dijo el lead y su último pedido mandan sobre la dirección de Shopify", () => {
    const shopifyAddress = { province: "Arequipa", city: "Cayma" };
    expect(leadCoverage(lead({ district: "Comas" }), { shopifyAddress })).toBe("lima");
    expect(leadCoverage(lead({}), { priorCoverage: "lima", shopifyAddress })).toBe("lima");
  });

  it("las excepciones de distrito también valen para la dirección de Shopify", () => {
    const overrides = [{ store_id: null, district: "pucusana", coverage: "agencia" as const }];
    expect(
      leadCoverage(lead({}), { shopifyAddress: { province: "Lima (provincia)", city: "Pucusana" }, overrides }),
    ).toBe("provincia");
  });
});
