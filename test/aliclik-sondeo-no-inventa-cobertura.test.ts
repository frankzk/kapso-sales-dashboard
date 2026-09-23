import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * EL SONDEO DE TARIFAS NO DECLARA COBERTURA.
 *
 * #AUR177128, 19-09-2026. Caravelí salía como Provincia COD y la operación sabe
 * que ahí solo llega la agencia. La causa no estaba en un mapa sino en la matriz
 * de costos: el cron nocturno cotiza distritos de pedidos pendientes y, si
 * Aliclik devuelve un precio, escribe una tarifa — y la cobertura la decide esa
 * misma matriz. Una cotización bastaba para convertir un distrito de Agencia en
 * Provincia COD, sin que nadie hubiera entregado nunca ahí.
 *
 * Medido entonces: cero envíos de Aliclik en Caravelí, entrega suya más cercana
 * a 247 km, y 8 envíos reales por Shalom. El patrón alcanzaba a seis lugares y a
 * seis cadenas que ni siquiera son distritos («frente al grifo amazonas»).
 */

const migracion = (() => {
  const dir = resolve(process.cwd(), "db/migrations");
  const nombre = readdirSync(dir).find((f) => f.includes("aliclik_tariff_probes_sin_inventar"));
  expect(nombre, "falta la migración del sondeo").toBeTruthy();
  return readFileSync(resolve(dir, nombre!), "utf8");
})();

/** El filtro de «esto no es un distrito», tal como quedó en la migración. */
const RX_NO_ES_DISTRITO =
  /(^| )(frente|grifo|cuadra|paradero|altura|costado|espalda|referencia|lote|mz|manzana|av|avenida|jr|jiron|calle|pasaje|psje)( |$)/;

/** Misma normalización que `coverage_norm` en la base. */
function norm(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

describe("el filtro distingue un distrito de un trozo de dirección", () => {
  it("descarta lo que la clienta escribió como referencia", () => {
    for (const basura of [
      "frente al grifo amazonas",
      "2do puente de la av. 28 de julio",
      "por el grifo gamarra via vitamiento",
      "frente a cable estar",
    ]) {
      expect(RX_NO_ES_DISTRITO.test(norm(basura)), basura).toBe(true);
    }
  });

  /**
   * LOS DOS QUE OBLIGARON A AFINARLO. «Puente Piedra» sobrevive porque «puente»
   * no entra en la lista. Y «26 de Octubre» —distrito de Piura con 44 entregas
   * reales de Aliclik— sobrevive porque la primera versión descartaba cualquier
   * cadena con un dígito y se lo llevaba por delante.
   */
  it("no toca ningún distrito real, ni los que parecen sospechosos", () => {
    for (const real of [
      "Puente Piedra",
      "26 de Octubre",
      "San José de los Molinos",
      "Caravelí",
      "Santiago de Surco",
      "Villa El Salvador",
      "Alto Selva Alegre",
    ]) {
      expect(RX_NO_ES_DISTRITO.test(norm(real)), real).toBe(false);
    }
  });
});

describe("la migración", () => {
  it("aplica el filtro de «no es un distrito» al elegir a quién cotizar", () => {
    expect(migracion).toContain("coverage_norm(om.district) !~");
    expect(migracion).toContain("frente|grifo|cuadra");
  });

  it("no sondea donde ya consta que Aliclik no entrega", () => {
    expect(migracion).toContain(
      "not (coalesce(e.aliclik, 0) = 0 and coalesce(e.agencia_entregados, 0) > 0)",
    );
  });

  it("mira la ENTREGA de la agencia, no la guía creada", () => {
    // Una guía anulada no prueba cobertura: es lo que pasó con Tumbes (0149).
    expect(migracion).toContain("sh.delivery_status = 'entregado'");
  });

  it("deja escrito qué se pierde, en vez de venderlo como gratis", () => {
    expect(migracion).toContain("el sondeo no lo va a descubrir");
  });

  it("y deja escrito por qué la lista de palabras es corta", () => {
    // Sin esto, el siguiente que la vea le añade «puente» y rompe Puente Piedra.
    expect(migracion).toContain("Puente Piedra es un distrito");
    expect(migracion).toContain("26 de Octubre");
  });
});
