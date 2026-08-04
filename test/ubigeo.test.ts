import { describe, it, expect } from "vitest";
import { resolveUbigeo, warehouseUbigeo, UBIGEO_BY_CITY } from "@/lib/ubigeo";
import { FENIX_CITIES } from "@/lib/shipments";

describe("resolveUbigeo", () => {
  it("resolves districts verified against the Swayp quotation API", () => {
    // These exact codes were confirmed live: each quoted a different tariff,
    // which means Swayp really resolved them (a bogus code is rejected).
    expect(resolveUbigeo("Arequipa", "Yanahuara")?.code).toBe("040126");
    expect(resolveUbigeo("Arequipa", "Paucarpata")?.code).toBe("040112");
    expect(resolveUbigeo("Arequipa", "Cerro Colorado")?.code).toBe("040104");
    expect(resolveUbigeo("Cusco", "Wanchaq")?.code).toBe("080108");
    expect(resolveUbigeo("Cusco", "Santiago")?.code).toBe("080106");
    expect(resolveUbigeo("Trujillo", "El Porvenir")?.code).toBe("130102");
    expect(resolveUbigeo("Juliaca", "San Miguel")?.code).toBe("211105");
  });

  it("does not confuse the districts that share a prefix with another city's", () => {
    // San Jerónimo exists in Cusco (080104) and as "San Jerónimo de Tunán" in
    // Huancayo (120130) — the city scopes the lookup.
    expect(resolveUbigeo("Cusco", "San Jerónimo")?.code).toBe("080104");
    expect(resolveUbigeo("Huancayo", "San Jerónimo")?.code).toBe("120130");
  });

  it("is accent- and case-insensitive", () => {
    expect(resolveUbigeo("AREQUIPA", "SABANDÍA")?.code).toBe("040116");
    expect(resolveUbigeo("cusco", "san sebastián")?.code).toBe("080105");
  });

  it("handles the cercado forms operators type", () => {
    for (const d of ["Arequipa", "Cercado", "Cercado de Arequipa", "Arequipa (Cercado)"]) {
      const m = resolveUbigeo("Arequipa", d);
      expect(m?.code, d).toBe("040101");
    }
  });

  it("marks a blank or unknown district as a non-exact cercado fallback", () => {
    const blank = resolveUbigeo("Arequipa", "");
    expect(blank).toEqual({ code: "040101", district: "arequipa", exact: false });

    const unknown = resolveUbigeo("Arequipa", "Distrito Que No Existe");
    expect(unknown?.exact).toBe(false);
    expect(unknown?.code).toBe("040101");
  });

  it("resolves Ayaviri out of the Juliaca/Puno tables (different province)", () => {
    expect(resolveUbigeo("Juliaca", "Ayaviri")).toEqual({
      code: "210801",
      district: "ayaviri",
      exact: true,
    });
  });

  it("returns null for a city outside coverage", () => {
    expect(resolveUbigeo("Lima", "Miraflores")).toBeNull();
    expect(resolveUbigeo("", "")).toBeNull();
  });

  it("keeps Puno and Juliaca as distinct destinations", () => {
    expect(resolveUbigeo("Puno", "Puno")?.code).toBe("210101");
    expect(resolveUbigeo("Juliaca", "Juliaca")?.code).toBe("211101");
  });
});

describe("warehouseUbigeo", () => {
  it("gives the cercado of each covered city", () => {
    expect(warehouseUbigeo("Arequipa")).toBe("040101");
    expect(warehouseUbigeo("Cusco")).toBe("080101");
    expect(warehouseUbigeo("Trujillo")).toBe("130101");
    expect(warehouseUbigeo("Huancayo")).toBe("120101");
  });

  it("draws Puno from the Juliaca warehouse, like the stock gate does", () => {
    expect(warehouseUbigeo("Puno")).toBe("211101");
    expect(warehouseUbigeo("Juliaca")).toBe("211101");
  });

  it("returns null outside coverage", () => {
    expect(warehouseUbigeo("Lima")).toBeNull();
  });
});

describe("coverage table", () => {
  it("covers every city in FENIX_CITIES", () => {
    for (const city of FENIX_CITIES) {
      expect(UBIGEO_BY_CITY[city], city).toBeDefined();
    }
  });

  it("las ciudades nuevas resuelven su cercado y su bodega", () => {
    expect(resolveUbigeo("Ica", "Ica")).toEqual({ code: "110101", district: "ica", exact: true });
    expect(resolveUbigeo("Piura", "Piura")?.code).toBe("200101");
    expect(resolveUbigeo("Chimbote", "Chimbote")?.code).toBe("021801");
    expect(resolveUbigeo("Chiclayo", "Chiclayo")?.code).toBe("140101");
    expect(warehouseUbigeo("Ica")).toBe("110101");
    expect(warehouseUbigeo("Chiclayo")).toBe("140101");
  });

  it("un distrito todavía sin transcribir NO se adivina: cae en no-exacto", () => {
    // Las cuatro nuevas entraron solo con su cercado. Mientras falte el resto
    // de la provincia, un distrito desconocido tiene que devolver
    // `exact: false` —lo que hace que la creación de guía se niegue— y no un
    // código aproximado, que crearía la guía y desviaría el paquete.
    const tinguina = resolveUbigeo("Ica", "La Tinguiña");
    expect(tinguina?.exact).toBe(false);
    expect(resolveUbigeo("Chiclayo", "José Leonardo Ortiz")?.exact).toBe(false);
    expect(resolveUbigeo("Chimbote", "Nuevo Chimbote")?.exact).toBe(false);
  });

  it("holds only well-formed 6-digit INEI codes, with no duplicates", () => {
    const seen = new Set<string>();
    for (const [city, districts] of Object.entries(UBIGEO_BY_CITY)) {
      for (const [district, code] of Object.entries(districts)) {
        expect(code, `${city}/${district}`).toMatch(/^\d{6}$/);
        expect(seen.has(code), `duplicate ${code} at ${city}/${district}`).toBe(false);
        seen.add(code);
      }
    }
  });

  it("keys every city's cercado by the city name (resolveUbigeo relies on it)", () => {
    for (const [city, districts] of Object.entries(UBIGEO_BY_CITY)) {
      expect(districts[city], city).toMatch(/^\d{6}$/);
    }
  });
});
