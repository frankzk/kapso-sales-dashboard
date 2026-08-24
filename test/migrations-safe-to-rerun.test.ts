import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `db/apply_bundled.sql` tiene que poder pegarse en una base CON DATOS.
 *
 * QUÉ PASÓ (24-08-2026). La migración 0006 llevaba una limpieza de una sola vez:
 *
 *     delete from orders o
 *      where not exists (select 1 from unnest(o.tags) t where lower(t) = 'kapso');
 *
 * Escrita cuando `order_events` no existía y borrar un pedido era inofensivo.
 * Hoy `order_events` cuelga de `orders` con ON DELETE CASCADE y es append-only.
 * Al pegar el bundle en producción —que es literalmente lo que la documentación
 * ofrece hacer— esa línea intentó borrar TODOS los pedidos sin la etiqueta
 * `kapso`, que hoy incluye los pagados en el checkout.
 *
 * Lo abortó el trigger de auditoría inmutable. Esa cerradura fue lo único que
 * impidió perder miles de pedidos, y no estaba puesta para eso.
 *
 * POR QUÉ NO LO VIO NADIE: `scripts/verify-db.sh` verifica el bundle «desde
 * cero», sobre una base vacía. Ahí un `delete` destructivo y uno inofensivo son
 * indistinguibles: los dos borran cero filas.
 *
 * Esta prueba mira el FUENTE, que es donde sí se distinguen.
 */

const DIR = resolve(process.cwd(), "db", "migrations");
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

/**
 * Una sentencia destructiva a NIVEL DE MIGRACIÓN empieza en la columna 0.
 *
 * No es una convención inventada para esta prueba: en este repositorio todo lo
 * que vive dentro del cuerpo de una función o de un bloque `do $$` va indentado,
 * y ahí un `delete` es el trabajo normal de la función (los rollups se borran y
 * se reinsertan en cada recálculo). Lo que se persigue es el `delete` suelto,
 * que corre una vez al aplicar y no vuelve a estar bajo el control de nadie.
 */
const TOP_LEVEL_DESTRUCTIVE = /^(delete\s+from|truncate|drop\s+table(?!\s+if\s+exists\s+\w*_tmp))/gim;

describe("las migraciones se pueden re-aplicar sobre una base con datos", () => {
  it("ninguna borra datos a nivel de migración", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const sql = readFileSync(resolve(DIR, file), "utf8");
      const hits = sql.match(TOP_LEVEL_DESTRUCTIVE);
      if (hits?.length) offenders.push(`${file}: ${hits.join(", ")}`);
    }
    // Si esto falla, la sentencia nueva tiene que ir dentro de un `do $$` con
    // una guarda que la haga inofensiva en una base ya instalada — como la de
    // 0006. Borrar en una migración es correr una vez y no poder deshacerlo.
    expect(offenders).toEqual([]);
  });

  it("el purgado de 0006 sigue existiendo, pero guardado", () => {
    // No se elimina: reescribir lo que ya pasó sería mentir sobre la historia
    // del esquema. Se vuelve inofensivo en cualquier base que haya pasado de
    // 0045, que es exactamente «esta no es la instalación original».
    const sql = readFileSync(resolve(DIR, "0006_kapso_only_orders.sql"), "utf8");
    expect(sql).toContain("delete from orders o");
    expect(sql).toContain("to_regclass('public.order_events') is null");
    // La guarda tiene que ir ANTES del borrado, no decorando después.
    expect(sql.indexOf("to_regclass('public.order_events') is null")).toBeLessThan(
      sql.indexOf("delete from orders o"),
    );
  });

  it("y el bundle generado se lleva la guarda", () => {
    // El bundle es lo que se pega en el SQL Editor. Si la guarda viviera solo en
    // la migración suelta, el fichero peligroso seguiría siendo el que se usa.
    const bundle = readFileSync(resolve(process.cwd(), "db", "apply_bundled.sql"), "utf8");
    expect(bundle).toContain("to_regclass('public.order_events') is null");
    expect(bundle.indexOf("to_regclass('public.order_events') is null")).toBeLessThan(
      bundle.indexOf("delete from orders o"),
    );
  });
});
