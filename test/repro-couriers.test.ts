import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COURIERS_FUERA_DE_REPRO, esperaSalidaDeAliclik, perteneceARepro } from "@/lib/shipments";
import { esColaDeReprogramacion } from "@/lib/shipments-access";

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

/**
 * El segundo recorte: lo que Aliclik todavía no ha sacado del almacén.
 *
 * EL CASO REAL. Entre las pendientes había 92 guías de Aliclik en custodia
 * `empresa` —89 sin un solo intento, varias creadas ese mismo día— con estado
 * «PENDING_DELIVERY · PREPARED · CONFIRMED». La cola es para lo que Aliclik
 * intentó entregar y no pudo; una guía recién preparada no tiene nada que
 * reprogramar, y aun así la pantalla le ofrecía ruta Fenix como a cualquier otra.
 */
describe("una guía que todavía no salió del almacén no se reprograma", () => {
  it("Aliclik con el paquete en casa se va de la cola", () => {
    expect(esperaSalidaDeAliclik("aliclik", "empresa")).toBe(true);
  });

  it("en cuanto el courier lo recoge, vuelve", () => {
    expect(esperaSalidaDeAliclik("aliclik", "courier")).toBe(false);
    expect(esperaSalidaDeAliclik("aliclik", "devuelto")).toBe(false);
  });

  it("el criterio es la custodia, NO el contador de intentos", () => {
    // `aliclik_attempts` sale del Excel y puede no venir —la pantalla ya lo dice,
    // «Sin NRO. INTENTOS en Excel»—. Hay 2 guías en poder del courier sin
    // intentos informados: filtrar por el contador las escondería, y esconder
    // trabajo por un dato que falta es el error que este repo ya cometió con la
    // cobertura (§19.0.2). La custodia es un hecho, no un dato que puede faltar.
    expect(esperaSalidaDeAliclik("aliclik", "courier")).toBe(false);
  });

  it("solo aplica a Aliclik: `por_definir` y Fénix se quedan", () => {
    // Las dos están en custodia `empresa` y salir de la cola es, para ellas,
    // otra decisión que no está tomada (MOM §11).
    expect(esperaSalidaDeAliclik("por_definir", "empresa")).toBe(false);
    expect(esperaSalidaDeAliclik("fenix", "empresa")).toBe(false);
    expect(esperaSalidaDeAliclik("swayp", "empresa")).toBe(false);
  });

  it("no se cae por mayúsculas, espacios ni vacíos", () => {
    expect(esperaSalidaDeAliclik(" Aliclik ", " EMPRESA ")).toBe(true);
    expect(esperaSalidaDeAliclik(null, "empresa")).toBe(false);
    expect(esperaSalidaDeAliclik("aliclik", null)).toBe(false);
  });

  it("la lista y el contador lo aplican los dos, desde la misma constante", () => {
    const source = read(ACCESS);
    expect(source.match(/query\.or\(YA_SALIO_O_NO_ES_ALICLIK\)/g) ?? []).toHaveLength(2);
    // Es la negación de «Aliclik Y en el almacén»: basta con que el courier sea
    // otro, o que el paquete ya haya salido.
    expect(source).toContain('"courier.neq.aliclik,custody_state.neq.empresa"');
  });

  it("va en la consulta, no después de traer las filas", () => {
    const source = read(ACCESS);
    const start = source.indexOf("export async function getStoreShipments(");
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(body).toContain("query.or(YA_SALIO_O_NO_ES_ALICLIK)");
    expect(body).not.toContain("esperaSalidaDeAliclik");
  });

  // ESTO ES LO QUE CASI SE ROMPE. Medido contra producción antes de acotarlo, el
  // mismo recorte sobre todas las pestañas se llevaba 317 anuladas, 78
  // entregadas, 46 en ruta y 15 transferidas: `custody_state` no se actualiza al
  // entregar, así que en una guía cerrada el valor es viejo y no significa «sigue
  // en el almacén». Esas pestañas son el REGISTRO de lo que pasó; esconder ahí
  // una guía entregada sería perder historial, no limpiar una cola.
  describe("solo recorta la cola de Pendiente", () => {
    it("las dos consultas lo condicionan a la categoría", () => {
      // Se mide el RECORTE emparejado con su condición, no cada uso de
      // `esColaDeReprogramacion`: ese guarda responde «¿es la cola de repro?» y
      // hay más de una decisión que depende de eso —anexar las cerradas por
      // recuperar es otra—. Contar el guarda a secas mezclaba las dos y fallaba
      // al añadir la segunda, que no tiene nada que ver con la custodia.
      const source = read(ACCESS);
      const emparejado = /if \(esColaDeReprogramacion\(cats\)\) query = query\.or\(YA_SALIO_O_NO_ES_ALICLIK\);/g;
      expect(source.match(emparejado) ?? []).toHaveLength(2);
    });

    it("Pendiente sí; entregado, anulado, en ruta y transferido no", () => {
      expect(esColaDeReprogramacion(["pending"])).toBe(true);
      for (const cat of ["delivered", "closed", "in_route", "transferred"]) {
        expect(esColaDeReprogramacion([cat]), cat).toBe(false);
      }
    });

    it("una vista que MEZCLA pendientes con otra cosa tampoco recorta", () => {
      // Revisión es ["pending","in_route"]: recortar ahí escondería guías en
      // ruta, que no es lo que se pidió.
      expect(esColaDeReprogramacion(["pending", "in_route"])).toBe(false);
      expect(esColaDeReprogramacion([])).toBe(false);
    });
  });
});
