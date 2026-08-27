import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COURIERS_FUERA_DE_REPRO, perteneceARepro } from "@/lib/shipments";

/**
 * Qué se trabaja desde Repro Provincia y qué no.
 *
 * EL CASO REAL. La cola listaba 2255 pendientes y 255 eran de Shalom. Se vio en
 * una guía de Shalom en Arequipa a la que la pantalla ofrecía «Fenix Ok»:
 * proponerle una ruta a un paquete que ya está esperando en el mostrador de la
 * agencia. La consulta filtraba por tienda y por categoría, y nunca preguntaba
 * de qué courier venía la guía.
 *
 * El MOM §11 nombra la entrada elegible a Reproprovincia —no contesta, intento
 * fallido, rechazo sujeto a revisión, guía cancelada por courier y devolución—
 * y §11.1 pone a la agencia como DESTINO de una recuperación, no como insumo.
 */

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");
const ACCESS = "lib/shipments-access.ts";

describe("los cuatro que salen", () => {
  it("Shalom no se reprograma: es agencia, la clienta recoge en el terminal", () => {
    expect(perteneceARepro("shalom")).toBe(false);
  });

  it("tampoco Tanders, Urpi ni el reparto propio", () => {
    expect(perteneceARepro("tanders")).toBe(false);
    expect(perteneceARepro("urpi")).toBe(false);
    expect(perteneceARepro("propio")).toBe(false);
  });

  it("Aliclik y Fénix se quedan: son la cola de verdad", () => {
    expect(perteneceARepro("aliclik")).toBe(true);
    expect(perteneceARepro("fenix")).toBe(true);
  });

  it("y los pedidos sin courier asignado también", () => {
    // `por_definir` son filas sintéticas (MOM-KP…-POR_DEFINIR-…) de pedidos que
    // todavía no tienen salida. Sacarlas es otra decisión, no esta.
    expect(perteneceARepro("por_definir")).toBe(true);
  });
});

describe("es lista de EXCLUIDOS, no de admitidos", () => {
  it("un courier que nadie ha nombrado se queda en la cola", () => {
    // La diferencia importa. Con una lista de admitidos, un courier nuevo
    // desaparecería de la pantalla sin que nadie se entere; así aparece, y
    // alguien pregunta qué hace ahí. Trabajo que sobra se ve; el que falta, no.
    expect(perteneceARepro("olva")).toBe(true);
    expect(perteneceARepro("swayp")).toBe(true);
    expect(perteneceARepro("axel")).toBe(true);
  });

  it("no se cae por mayúsculas ni por un espacio de más", () => {
    expect(perteneceARepro(" Shalom ")).toBe(false);
    expect(perteneceARepro("SHALOM")).toBe(false);
  });

  it("courier vacío no se descarta en silencio", () => {
    // La columna es NOT NULL en la base, pero si algún día llega vacío, la
    // respuesta correcta es mostrarlo, no esconderlo.
    expect(perteneceARepro(null)).toBe(true);
    expect(perteneceARepro("")).toBe(true);
  });
});

describe("la lista y el contador recortan IGUAL", () => {
  // El chip dice «Pendiente 1827» justo encima de la tabla. Si cada uno filtrara
  // por su cuenta, el día que uno cambiara el número y las filas dirían cosas
  // distintas y no habría forma de saber cuál miente. Es el fallo que este repo
  // repite: el mismo hecho escrito en dos sitios.
  it("las dos consultas aplican el recorte", () => {
    const source = read(ACCESS);
    const veces = source.match(/\.not\("courier", "in", FUERA_DE_REPRO\)/g) ?? [];
    expect(veces, "la lista y el contador").toHaveLength(2);
  });

  it("y las dos lo sacan de la MISMA constante", () => {
    const source = read(ACCESS);
    expect(source).toContain("const FUERA_DE_REPRO = `(${COURIERS_FUERA_DE_REPRO.join(\",\")})`");
    // Nadie vuelve a escribir los nombres a mano en la consulta.
    for (const courier of COURIERS_FUERA_DE_REPRO) {
      expect(source, `«${courier}» escrito a mano en la consulta`).not.toContain(`"${courier}"`);
    }
  });

  it("el recorte va en la consulta, no después de traer las filas", () => {
    // Filtrar en memoria dejaría el conteo bien y la lista corta: la consulta
    // pagina de 1000 en 1000 con un tope, así que descartar después de traer
    // significa traer 434 filas que no van y perder otras tantas al final.
    const source = read(ACCESS);
    const start = source.indexOf("export async function getStoreShipments(");
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(body).toContain('.not("courier", "in", FUERA_DE_REPRO)');
    expect(body).not.toContain("perteneceARepro");
  });
});
