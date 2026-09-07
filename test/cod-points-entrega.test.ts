import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Un punto COD lo siembra una ENTREGA, no una cotización.
 *
 * EL CASO. Tumbes salía «Provincia COD» y la operación lo despacha por agencia.
 * Aliclik no ha entregado nunca un paquete allí: sus dos únicas guías del
 * departamento —#KP125436 y #KP125474, ambas del 31-jul-2026— se anularon sin
 * salir. Las cuatro entregas reales de Tumbes son de Shalom.
 *
 * POR QUÉ EL SISTEMA CREÍA LO CONTRARIO. `refresh_aliclik_cod_points` decía en
 * su propio comentario que armaba el mapa de «dónde Aliclik ya ENTREGÓ a
 * domicilio», pero solo exigía que la guía tuviera cotización. Aliclik cotizó
 * Tumbes a S/ 18,50 al crear esas dos guías y con eso quedaron sembrados dos
 * puntos a 6 km de la dirección; desde entonces todo Tumbes caía dentro del
 * radio de 10 km. El comentario afirmaba un hecho que el código no comprobaba.
 *
 * POR QUÉ NO SE BORRAN «LOS PUNTOS QUE FRACASARON». Medido: de los 954 puntos,
 * 103 solo tienen guías anuladas o devueltas — pero están en Arequipa, Huancayo,
 * Ica, Trujillo, Chiclayo… ciudades donde Aliclik SÍ entrega y donde una
 * dirección fallida está rodeada de cientos de entregas buenas. Borrarlas sería
 * ruido. Lo que se cambia es qué SIEMBRA un punto, y con eso la única región que
 * pierde cobertura es Tumbes.
 *
 * Estas pruebas leen el SQL porque la regla vive en la base, que es su única
 * definición: recalcularla en TypeScript es el bug que motivó la 0104.
 */

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");
const migracion = () => read("db/migrations/0146_cod_points_require_delivery.sql");

/** El cuerpo del `insert` que rellena el mapa. */
function insertDelMapa(sql: string): string {
  const start = sql.indexOf("insert into aliclik_cod_points");
  expect(start, "no se encontró el insert del mapa").toBeGreaterThanOrEqual(0);
  return sql.slice(start, sql.indexOf("on conflict do nothing", start));
}

describe("la regla nueva", () => {
  it("exige que la guía se haya ENTREGADO", () => {
    expect(insertDelMapa(migracion())).toContain("s.delivery_status = 'entregado'");
  });

  it("y no le basta con que estuviera cotizada", () => {
    // La cotización sigue en la condición —distingue una guía COD de una que no
    // lo era— pero ya no puede sostener el punto ella sola.
    const cuerpo = insertDelMapa(migracion());
    const posEntrega = cuerpo.indexOf("s.delivery_status = 'entregado'");
    const posCotizacion = cuerpo.indexOf("s.quoted_delivery_cost is not null");
    expect(posEntrega).toBeGreaterThanOrEqual(0);
    expect(posCotizacion).toBeGreaterThanOrEqual(0);
    // La entrega es una condición `and` de primer nivel, no una alternativa
    // dentro del `or` de la cotización.
    expect(posEntrega).toBeLessThan(posCotizacion);
  });

  it("reconstruye el mapa en la propia migración", () => {
    // Sin esto, los 190 puntos que ninguna entrega respalda seguirían en la
    // tabla hasta que algo disparara un refresco, que puede no pasar en semanas.
    expect(migracion()).toContain("select refresh_aliclik_cod_points(null);");
  });

  it("NO borra puntos por haber fracasado", () => {
    // El arreglo cambia qué siembra un punto. Filtrar por `anulado`/`devuelto`
    // sería otra regla —y en Arequipa o Trujillo quitaría direcciones válidas
    // rodeadas de entregas buenas—.
    const cuerpo = insertDelMapa(migracion());
    expect(cuerpo).not.toContain("anulado");
    expect(cuerpo).not.toContain("devuelto");
  });
});

describe("el cinturón manual de Tumbes", () => {
  it("los tres distritos reales quedan como agencia", () => {
    const sql = migracion();
    const start = sql.indexOf("insert into district_coverage");
    expect(start).toBeGreaterThanOrEqual(0);
    const cuerpo = sql.slice(start);
    for (const distrito of ["'tumbes'", "'zarumilla'", "'corrales'"]) {
      expect(cuerpo).toContain(distrito);
    }
    expect(cuerpo).toContain("'agencia'");
  });

  it("van normalizados y sin tildes, como exige la tabla", () => {
    // `district_coverage.district` se guarda ya pasado por `coverage_norm`, para
    // que la búsqueda sea una igualdad. Una mayúscula acá no casaría nunca.
    const sql = migracion();
    const cuerpo = sql.slice(sql.indexOf("insert into district_coverage"));
    const distritos = [...cuerpo.matchAll(/\(null, '([^']+)', 'agencia'/g)].map((m) => m[1]!);
    expect(distritos.length).toBe(3);
    for (const d of distritos) expect(d).toBe(d.toLowerCase());
    expect(distritos.join()).not.toMatch(/[áéíóúñ]/);
  });

  it("cada fila dice POR QUÉ", () => {
    // La propia tabla lo pide: «una excepción sin motivo es indistinguible de un
    // error de dedo dentro de seis meses».
    const sql = migracion();
    const cuerpo = sql.slice(sql.indexOf("insert into district_coverage"));
    expect(cuerpo).toContain("0146");
    expect(cuerpo).toContain("Aliclik nunca entregó en Tumbes");
  });

  it("no pisa una excepción que ya exista", () => {
    expect(migracion()).toContain("do nothing");
  });
});

describe("queda escrito donde manda", () => {
  it("el MOM recoge la regla", () => {
    // CLAUDE.md: una implementación que cambia una regla de negocio actualiza la
    // especificación en el mismo commit.
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("Un punto COD lo siembra una ENTREGA, no una cotización");
    expect(mom).toContain("delivery_status = 'entregado'");
  });

  it("y la función lleva su propio comentario en la base", () => {
    expect(migracion()).toContain("comment on function refresh_aliclik_cod_points(uuid)");
  });
});
