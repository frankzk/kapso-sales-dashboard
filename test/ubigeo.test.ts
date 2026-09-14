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
    // Lima dejó de ser el ejemplo el 14-09-2026, cuando entró a cobertura.
    expect(resolveUbigeo("Tacna", "Pocollay")).toBeNull();
    expect(resolveUbigeo("", "")).toBeNull();
  });

  it("resuelve Lima y Callao con ubigeo exacto", () => {
    // Surquillo (150141) es el distrito del `curl` de ejemplo que mandó Swayp.
    expect(resolveUbigeo("Lima", "Surquillo")).toEqual({ code: "150141", district: "surquillo", exact: true });
    expect(resolveUbigeo("Lima", "Miraflores")?.code).toBe("150122");
    expect(resolveUbigeo("Lima", "San Isidro")?.code).toBe("150131");
    expect(resolveUbigeo("Lima", "San Juan de Lurigancho")?.code).toBe("150132");
    // Distrito creado en 2023: el padrón viejo no lo traía.
    expect(resolveUbigeo("Lima", "Santa María de Huachipa")?.code).toBe("150144");
    expect(resolveUbigeo("Callao", "Ventanilla")?.code).toBe("070106");
    expect(resolveUbigeo("Callao", "Mi Perú")?.code).toBe("070107");
  });

  it("«Surco» y «Cercado de Lima» son lo que escribe la calle", () => {
    // «Surco» no es prefijo de «santiago de surco», así que sin alias la guía
    // de uno de los distritos que más compra se rechazaba.
    expect(resolveUbigeo("Lima", "Surco")).toEqual({ code: "150140", district: "santiago de surco", exact: true });
    expect(resolveUbigeo("Lima", "Santiago de Surco")?.code).toBe("150140");
    expect(resolveUbigeo("Lima", "Cercado de Lima")?.code).toBe("150101");
    expect(resolveUbigeo("Lima", "Lima")?.code).toBe("150101");
    // Y un alias sigue acotado a su ciudad.
    expect(resolveUbigeo("Chiclayo", "Surco")?.exact).toBe(false);
  });

  it("nombres repetidos entre Lima y otras ciudades resuelven por ciudad", () => {
    // Santa Rosa, San Miguel y La Victoria existen en Lima y en otra ciudad de
    // la cobertura: la ciudad acota, el nombre solo no basta.
    expect(resolveUbigeo("Lima", "Santa Rosa")?.code).toBe("150139");
    expect(resolveUbigeo("Chiclayo", "Santa Rosa")?.code).toBe("140114");
    expect(resolveUbigeo("Lima", "San Miguel")?.code).toBe("150136");
    expect(resolveUbigeo("Juliaca", "San Miguel")?.code).toBe("211105");
    expect(resolveUbigeo("Lima", "La Victoria")?.code).toBe("150115");
    expect(resolveUbigeo("Chiclayo", "La Victoria")?.code).toBe("140106");
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
    expect(warehouseUbigeo("Tacna")).toBeNull();
  });

  it("el Callao se despacha desde la bodega de Lima, como Puno desde Juliaca", () => {
    // Swayp tiene una bodega en Lima y ninguna en el Callao. El destino es
    // propio (tabla `callao`); el origen y el stock son los de Lima.
    expect(warehouseUbigeo("Lima")).toBe("150101");
    expect(warehouseUbigeo("Callao")).toBe("150101");
    expect(resolveUbigeo("Callao", "Callao")?.code).toBe("070101");
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

  it("trae las provincias completas, no solo el cercado", () => {
    expect(Object.keys(UBIGEO_BY_CITY.ica!)).toHaveLength(14);
    expect(Object.keys(UBIGEO_BY_CITY.piura!)).toHaveLength(10);
    expect(Object.keys(UBIGEO_BY_CITY.chimbote!)).toHaveLength(9);
    expect(Object.keys(UBIGEO_BY_CITY.chiclayo!)).toHaveLength(20);
    // 44 y no 43: Santa María de Huachipa (150144) se creó en 2023.
    expect(Object.keys(UBIGEO_BY_CITY.lima!)).toHaveLength(44);
    expect(Object.keys(UBIGEO_BY_CITY.callao!)).toHaveLength(7);
  });

  it("resuelve los distritos grandes de cada provincia nueva", () => {
    expect(resolveUbigeo("Ica", "La Tinguiña")?.code).toBe("110102");
    expect(resolveUbigeo("Ica", "Parcona")?.code).toBe("110106");
    expect(resolveUbigeo("Piura", "Castilla")?.code).toBe("200104");
    expect(resolveUbigeo("Piura", "Catacaos")?.code).toBe("200105");
    expect(resolveUbigeo("Chimbote", "Nuevo Chimbote")?.code).toBe("021809");
    expect(resolveUbigeo("Chiclayo", "José Leonardo Ortiz")?.code).toBe("140105");
    expect(resolveUbigeo("Chiclayo", "Pimentel")?.code).toBe("140112");
  });

  it("Piura salta códigos porque esos distritos se fueron a Sechura en 1994", () => {
    // 200102, 200103 y 200106 no existen en la provincia de Piura. El salto es
    // del padrón, no una transcripción incompleta: una lista inventada saldría
    // correlativa.
    const codes = Object.values(UBIGEO_BY_CITY.piura!);
    expect(codes).not.toContain("200102");
    expect(codes).not.toContain("200103");
    expect(codes).not.toContain("200106");
    expect(codes).toContain("200115");
  });

  it("acepta la grafía de la calle cuando el padrón escribe distinto", () => {
    // Sin estos alias la guía se rechaza aunque el distrito SÍ esté en la
    // tabla, porque `buildSwaypGuideInput` exige `exact`.
    expect(resolveUbigeo("Piura", "Veintiséis de Octubre")?.code).toBe("200115");
    expect(resolveUbigeo("Piura", "26 de Octubre")?.code).toBe("200115");
    expect(resolveUbigeo("Chiclayo", "Puerto Eten")?.code).toBe("140104");
    expect(resolveUbigeo("Chiclayo", "Eten Puerto")?.code).toBe("140104");
    expect(resolveUbigeo("Chiclayo", "Zaña")?.code).toBe("140115");
    expect(resolveUbigeo("Chiclayo", "Saña")?.code).toBe("140115");
    // Y siguen siendo exactos: un alias no puede colar un cercado disfrazado.
    expect(resolveUbigeo("Piura", "Veintiséis de Octubre")?.exact).toBe(true);
  });

  it("un alias no cruza de ciudad", () => {
    // «Zaña» es de Chiclayo; pedirlo en Ica no puede resolver a nada exacto.
    expect(resolveUbigeo("Ica", "Zaña")?.exact).toBe(false);
  });

  it("el mismo nombre en dos ciudades resuelve por ciudad", () => {
    // Santiago existe en Cusco (080106) y en Ica (110111).
    expect(resolveUbigeo("Cusco", "Santiago")?.code).toBe("080106");
    expect(resolveUbigeo("Ica", "Santiago")?.code).toBe("110111");
    // Santa Rosa (Chiclayo) y Santa (Chimbote) no se pisan.
    expect(resolveUbigeo("Chiclayo", "Santa Rosa")?.code).toBe("140114");
    expect(resolveUbigeo("Chimbote", "Santa")?.code).toBe("021808");
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
