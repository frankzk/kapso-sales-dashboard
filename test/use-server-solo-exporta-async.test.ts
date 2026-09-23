import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * UN ARCHIVO `"use server"` SOLO PUEDE EXPORTAR FUNCIONES ASYNC.
 *
 * Next lo exige porque cada export de ese archivo se publica como endpoint. Una
 * función pura exportada desde ahí rompe la compilación con «Server Actions must
 * be async functions».
 *
 * LO CARO NO ES LA REGLA, ES CUÁNDO SE ENTERA UNO. `tsc --noEmit` no la conoce y
 * las pruebas tampoco: el fallo aparece en `next build`, o sea en el despliegue.
 * Pasó el 17-09-2026 con `avisoSinVinculoSwayp`, exportada desde
 * `app/dashboard/envios/actions.ts` — dos despliegues seguidos rotos con la
 * suite entera en verde.
 *
 * Los `type` y las `interface` se borran al compilar, así que no cuentan.
 */

const RAIZ = process.cwd();

function archivosTs(dir: string, out: string[] = []): string[] {
  for (const nombre of readdirSync(dir)) {
    if (nombre === "node_modules" || nombre === ".next" || nombre.startsWith(".")) continue;
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) archivosTs(ruta, out);
    else if (ruta.endsWith(".ts") || ruta.endsWith(".tsx")) out.push(ruta);
  }
  return out;
}

const archivosDeAcciones = archivosTs(resolve(RAIZ, "app"))
  .concat(archivosTs(resolve(RAIZ, "lib")))
  .filter((ruta) => /^["']use server["'];/m.test(readFileSync(ruta, "utf8")));

describe("cada archivo de acciones de servidor", () => {
  it("hay archivos que revisar (si no, la prueba no prueba nada)", () => {
    expect(archivosDeAcciones.length).toBeGreaterThan(15);
  });

  for (const ruta of archivosDeAcciones) {
    it(`${relative(RAIZ, ruta)} solo exporta funciones async`, () => {
      const src = readFileSync(ruta, "utf8");
      const prohibidos = [...src.matchAll(/^export\s+(?!async\s|type\s|interface\s)(\S+\s+\S+)/gm)]
        .map((m) => m[0].trim())
        // `export default async function` y `export { x }` de re-exportación no
        // son el caso; lo que rompe es declarar algo NO async aquí.
        .filter((linea) => !linea.startsWith("export default async"))
        .filter((linea) => !linea.startsWith("export {"));
      expect(prohibidos).toEqual([]);
    });
  }
});
