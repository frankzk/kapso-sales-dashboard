import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  avisoDistritoQueAliclikNoTiene,
  distritoQueAliclikNoTiene,
} from "@/lib/aliclik-status";
import { resolveUbigeo } from "@/lib/ubigeo";

/**
 * «Es imposible que no hayan almacenes compatibles» — y quien lo dijo tenía
 * razón.
 *
 * #AUR177131, 18-09-2026. La cotización de Aliclik devolvía «No se encontró el
 * distrito en ubigeo para SAN MIGUEL (SAN ROMAN, PUNO)» y nuestro aviso le
 * pegaba detrás «Almacén(es) compatibles probados: 133», así que el mensaje
 * entero se leía como un problema de almacén. El almacén estaba bien.
 */

const ERROR_REAL = "No se encontró el distrito en ubigeo para SAN MIGUEL (SAN ROMAN, PUNO)";

describe("distritoQueAliclikNoTiene", () => {
  it("reconoce el error real y devuelve el distrito tal como lo nombró Aliclik", () => {
    expect(distritoQueAliclikNoTiene(ERROR_REAL)).toBe("SAN MIGUEL (SAN ROMAN, PUNO)");
  });

  it("aguanta la falta de tilde y el punto final", () => {
    expect(distritoQueAliclikNoTiene("No se encontro el distrito en ubigeo para CACHICADAN.")).toBe(
      "CACHICADAN",
    );
  });

  it("no se queda con cualquier otro fallo de Aliclik", () => {
    for (const otro of [
      "Aliclik no respondió.",
      "El almacén 133 no atiende esa zona.",
      "",
      null,
      undefined,
    ]) {
      expect(distritoQueAliclikNoTiene(otro)).toBeNull();
    }
  });
});

describe("el aviso dice la causa y descarta la pista falsa", () => {
  const aviso = avisoDistritoQueAliclikNoTiene("SAN MIGUEL (SAN ROMAN, PUNO)");

  it("nombra el distrito y dice que la tabla es de Aliclik", () => {
    expect(aviso).toContain("SAN MIGUEL (SAN ROMAN, PUNO)");
    expect(aviso).toContain("su tabla de ubigeo");
  });

  /**
   * Las dos pistas falsas que se persiguieron antes de dar con esto, descartadas
   * en el propio aviso para que nadie las vuelva a perseguir: el almacén 133
   * despachó 267 envíos a Puno y 96 a Ucayali en 30 días.
   */
  it("descarta el almacén y el stock, que fue lo que se persiguió dos veces", () => {
    expect(aviso).toContain("No es el almacén ni el stock");
  });

  it("y explica la causa real: los dos nombres del distrito", () => {
    // Su geolocalizador devuelve el oficial y su tabla usa el comercial.
    expect(aviso).toContain("nombre oficial del distrito");
    expect(aviso).toContain("Callería/Pucallpa");
  });

  it("manda a un panel que existe de verdad", () => {
    // El drawer vive en su propio archivo desde que salió del Master.
    const drawer = readFileSync(resolve(process.cwd(), "components/order-drawer.tsx"), "utf8");
    expect(aviso).toContain("Ubicación y cobertura");
    expect(drawer).toContain("Ubicación y cobertura");
  });
});

describe("la cotización deja de nombrar el almacén cuando el problema es el distrito", () => {
  const src = readFileSync(
    resolve(process.cwd(), "app/dashboard/pedidos/aliclik-actions.ts"),
    "utf8",
  );

  it("sale por una rama propia, antes del mensaje que lista almacenes", () => {
    const rama = src.indexOf("const distritoDesconocido = distritoQueAliclikNoTiene(ultimo);");
    const almacenes = src.indexOf("`Almacén(es) compatibles probados:");
    expect(rama).toBeGreaterThan(-1);
    expect(almacenes).toBeGreaterThan(rama);
  });

  it("conserva las referencias, que son lo que se le reenvía a Aliclik", () => {
    const rama = src.slice(src.indexOf("if (distritoDesconocido) {"));
    expect(rama.slice(0, 400)).toContain("Referencia(s):");
  });
});

describe("el distrito sí existe: la diferencia es de Aliclik, no nuestra", () => {
  it("nuestra tabla resuelve San Miguel en la zona de Juliaca", () => {
    const r = resolveUbigeo("juliaca", "San Miguel");
    // `resolveUbigeo` devuelve null cuando ni la ciudad se conoce; que aquí no
    // lo sea es parte de lo que se está afirmando.
    expect(r).not.toBeNull();
    expect(r!.exact).toBe(true);
    expect(r!.code).toBe("211105");
  });
});
