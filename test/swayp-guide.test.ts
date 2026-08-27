import { describe, it, expect } from "vitest";
import {
  buildSwaypGuideInput,
  buildContenido,
  parseSenders,
  PLACEHOLDER_NIT,
  type SwaypSender,
} from "@/lib/swayp-guide";

const SENDER: SwaypSender = {
  nombre: "Kenku",
  nit: "20600000000",
  direccion: "Av. Ejercito 123",
  telefono: "959000000",
  email: "ventas@kenku.pe",
};

const senders = { arequipa: SENDER, cusco: SENDER };

const base = {
  city: "arequipa",
  district: "Yanahuara",
  customerName: "Juan Pérez",
  customerPhone: "959111222",
  address1: "Calle Misti 100",
  reference: "Frente al parque",
  lineItems: [{ title: "Cápsulas X", quantity: 2 }],
  codAmount: 129,
  senders,
};

describe("buildContenido", () => {
  it("uses Swayp's «cantidad x producto» notation", () => {
    expect(buildContenido([{ title: "Camiseta", quantity: 2 }, { title: "Pantalón", quantity: 1 }]))
      .toBe("2 x Camiseta, 1 x Pantalón");
  });

  it("floors quantity at 1 and drops blank titles", () => {
    expect(buildContenido([{ title: "X", quantity: 0 }, { title: "  ", quantity: 3 }])).toBe("1 x X");
  });
});

describe("buildSwaypGuideInput", () => {
  it("maps a complete shipment", () => {
    const r = buildSwaypGuideInput(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.ciudadRemitente).toBe("040101"); // bodega Arequipa
    expect(r.input.ciudadDestinatario).toBe("040126"); // Yanahuara
    expect(r.input.nombreDestinatario).toBe("Juan Pérez");
    expect(r.input.telefonoDestinatario).toBe("959111222");
    expect(r.input.direccionDestinatario).toBe("Calle Misti 100");
    // Swayp concatena este campo al final de la dirección SIN separador, así
    // que lo lleva incorporado (verificado sobre una guía real).
    expect(r.input.adicionalDireccion).toBe(" - Frente al parque");
    expect(r.input.contenido).toBe("2 x Cápsulas X");
    expect(r.input.valorRecaudo).toBe("129");
    expect(r.input.nitDestinatario).toBe(PLACEHOLDER_NIT);
    expect(r.input.telefonoRecogida).toBe(SENDER.telefono);
  });

  describe("idBusiness", () => {
    // La documentación lo marca obligatorio; el entorno de pruebas acepta la
    // guía sin él. Se manda cuando está configurado y se omite cuando no, en
    // vez de mandar un 0 que Swayp leería como un comercio.
    it("lo incluye cuando es un número positivo", () => {
      const r = buildSwaypGuideInput({ ...base, idBusiness: 69956 });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.input.idBusiness).toBe(69956);
    });

    it("lo omite —no lo manda vacío— cuando no está configurado", () => {
      for (const idBusiness of [null, undefined, 0, -1, Number.NaN]) {
        const r = buildSwaypGuideInput({ ...base, idBusiness });
        expect(r.ok, String(idBusiness)).toBe(true);
        if (r.ok) expect(r.input, String(idBusiness)).not.toHaveProperty("idBusiness");
      }
    });
  });

  it("refuses an inexact district — a cercado fallback would misroute the package", () => {
    const r = buildSwaypGuideInput({ ...base, district: "Distrito Inventado" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/distrito/i);
  });

  it("refuses a city with no warehouse configured", () => {
    const r = buildSwaypGuideInput({ ...base, city: "trujillo" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/bodega/i);
  });

  it("refuses a city outside Swayp coverage", () => {
    const r = buildSwaypGuideInput({ ...base, city: "lima", senders: { lima: SENDER } });
    expect(r.ok).toBe(false);
  });

  it("refuses an address shorter than the API's 5-character minimum", () => {
    const r = buildSwaypGuideInput({ ...base, address1: "Av." });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/dirección/i);
  });

  it("refuses a shipment with no name, phone or products", () => {
    expect(buildSwaypGuideInput({ ...base, customerName: "  " }).ok).toBe(false);
    expect(buildSwaypGuideInput({ ...base, customerPhone: null }).ok).toBe(false);
    expect(buildSwaypGuideInput({ ...base, lineItems: [] }).ok).toBe(false);
  });

  it("keeps valorDeclarado non-zero when there is no COD", () => {
    const r = buildSwaypGuideInput({ ...base, codAmount: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.valorRecaudo).toBe("0");
    expect(r.input.valorDeclarado).toBe("1");
  });

  it("omits the optional fields instead of sending empty strings", () => {
    const r = buildSwaypGuideInput({ ...base, reference: null, observaciones: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.adicionalDireccion).toBeUndefined();
    expect(r.input.observaciones).toBeUndefined();
    expect(r.input.fechaEntrega).toBeUndefined();
  });

  it("passes the dispatch date through as fechaEntrega", () => {
    const r = buildSwaypGuideInput({ ...base, dispatchDateIso: "2026-08-01T00:00:00.000Z" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.fechaEntrega).toBe("2026-08-01T00:00:00.000Z");
  });

  it("ships Puno out of the Juliaca warehouse (verified live)", () => {
    const r = buildSwaypGuideInput({
      ...base,
      city: "puno",
      district: "Puno",
      senders: { puno: SENDER },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.ciudadRemitente).toBe("211101");
    expect(r.input.ciudadDestinatario).toBe("210101");
  });
});

describe("parseSenders", () => {
  it("parses a valid map", () => {
    const p = parseSenders(JSON.stringify({ arequipa: SENDER }));
    expect(p.arequipa?.nombre).toBe("Kenku");
  });

  it("returns {} for blank, malformed JSON or an invalid shape", () => {
    // A config typo must not take down the shipments page — it only disables
    // API creation, which falls back to the manual flow.
    expect(parseSenders(undefined)).toEqual({});
    expect(parseSenders("")).toEqual({});
    expect(parseSenders("{not json")).toEqual({});
    expect(parseSenders(JSON.stringify({ arequipa: { nombre: "X" } }))).toEqual({});
    expect(parseSenders(JSON.stringify({ arequipa: { ...SENDER, direccion: "abc" } }))).toEqual({});
  });
});
