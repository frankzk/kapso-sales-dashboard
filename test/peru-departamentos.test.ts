import { describe, expect, it } from "vitest";
import { isKnownDepartment, normalizeDepartment } from "@/lib/peru-departamentos";
import { limaRegionKind } from "@/lib/order-coverage";

/**
 * El departamento se escribe de una sola manera… menos Lima, que son tres.
 *
 * Medido el 14-09-2026: 77 valores distintos en `shipments.region` para 25
 * departamentos. El filtro de la cola agrupa por esa columna, así que Junín
 * salía dos veces en el desplegable y elegir una escondía la otra.
 */

describe("la misma palabra escrita de dos formas es un solo departamento", () => {
  it("tildes", () => {
    for (const [a, b] of [
      ["Junin", "Junín"],
      ["Ancash", "Áncash"],
      ["Huanuco", "Huánuco"],
      ["Apurimac", "Apurímac"],
      ["San Martin", "San Martín"],
    ] as const) {
      expect(normalizeDepartment(a)).toBe(normalizeDepartment(b));
    }
  });

  it("mayúsculas y espacios", () => {
    expect(normalizeDepartment("ICA")).toBe("Ica");
    expect(normalizeDepartment("  arequipa ")).toBe("Arequipa");
    expect(normalizeDepartment("LIMA")).toBe("Lima");
  });

  it("Cuzco es Cusco", () => {
    expect(normalizeDepartment("Cuzco")).toBe("Cusco");
    expect(normalizeDepartment("Cusco")).toBe("Cusco");
  });
});

describe("las tres Limas NO se fusionan", () => {
  /**
   * Parecen la misma etiqueta mal escrita y no lo son. `limaRegionKind` lee el
   * sufijo para decidir cobertura, y los distritos lo confirman: en
   * «(provincia)» están Miraflores y Surco; en «(departamento)», Barranca,
   * Cañete y Canta. Fusionarlas rompía el ruteo.
   */
  it("cada una conserva su significado de cobertura", () => {
    expect(normalizeDepartment("Lima (provincia)")).toBe("Lima (provincia)");
    expect(normalizeDepartment("Lima (departamento)")).toBe("Lima (departamento)");
    expect(normalizeDepartment("Lima")).toBe("Lima");
    expect(normalizeDepartment("Lima (provincia)")).not.toBe(normalizeDepartment("Lima (departamento)"));
  });

  it("«Lima Metropolitana» es la ciudad, o sea «Lima (provincia)»", () => {
    expect(normalizeDepartment("Lima Metropolitana")).toBe("Lima (provincia)");
    expect(limaRegionKind(normalizeDepartment("Lima Metropolitana"))).toBe("metropolitana");
  });

  it("normalizar no cambia NINGUNA decisión de cobertura", () => {
    for (const raw of [
      "Lima (provincia)", "lima (PROVINCIA)", "Lima Metropolitana",
      "Lima (departamento)", "Región Lima",
      "Lima", "lima", "LIMA",
      "Callao", "callao",
      "Junin", "Junín", "Cuzco", "Cusco", "Áncash", "Ancash",
    ]) {
      expect(limaRegionKind(normalizeDepartment(raw)), raw).toBe(limaRegionKind(raw));
    }
  });
});

describe("no se inventa lo que no consta", () => {
  it("un distrito suelto en la columna se deja como vino", () => {
    // «Trujillo» es La Libertad y «Chorrillos» es Lima, pero adivinarlo es
    // inventar: un dato sucio que se ve es mejor que uno limpio que miente.
    expect(normalizeDepartment("Trujillo")).toBe("Trujillo");
    expect(normalizeDepartment("Chorrillos")).toBe("Chorrillos");
    expect(isKnownDepartment("Trujillo")).toBe(false);
  });

  it("la basura tampoco se toca, solo se recorta", () => {
    expect(normalizeDepartment("  Av Mariátegui   mercado orizonte ")).toBe("Av Mariátegui mercado orizonte");
    expect(isKnownDepartment("Av Mariátegui mercado orizonte")).toBe(false);
  });

  it("vacío es vacío", () => {
    for (const v of [null, undefined, "", "   "]) expect(normalizeDepartment(v)).toBeNull();
  });

  it("los 25 nombres oficiales se reconocen", () => {
    for (const d of [
      "Amazonas","Áncash","Apurímac","Arequipa","Ayacucho","Cajamarca","Callao","Cusco",
      "Huancavelica","Huánuco","Ica","Junín","La Libertad","Lambayeque","Loreto",
      "Madre de Dios","Moquegua","Pasco","Piura","Puno","San Martín","Tacna","Tumbes","Ucayali",
    ]) {
      expect(normalizeDepartment(d), d).toBe(d);
      expect(isKnownDepartment(d), d).toBe(true);
    }
  });
});
