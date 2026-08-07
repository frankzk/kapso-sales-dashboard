import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SHALOM_ORIGIN } from "@/lib/shalom/origin";

const read = (...parts: string[]) => readFileSync(resolve(process.cwd(), ...parts), "utf8");

const ACTIONS = "app/dashboard/pedidos/shalom-actions.ts";
const MIGRATION = "db/migrations/0108_shalom_created_via.sql";

describe("origen de las salidas de Shalom", () => {
  it("las dos vías tienen marcas distintas y estables", () => {
    // Los valores viven en una columna de base de datos ya poblada: renombrarlos
    // sin migrar deja huérfanas las filas escritas con el nombre viejo.
    expect(SHALOM_ORIGIN.api).toBe("shalom_pro_api");
    expect(SHALOM_ORIGIN.manual).toBe("shalom_pro_manual");
    expect(SHALOM_ORIGIN.api).not.toBe(SHALOM_ORIGIN.manual);
  });

  it("toda inserción de salida declara su origen", () => {
    // ESTA es la regresión: durante 185 guías la vía API insertaba sin
    // `created_via` mientras la de contingencia sí lo escribía, así que la
    // columna no distinguía la vía normal de una guía importada del reporte.
    const source = read(ACTIONS);
    const inserts = source.match(/from\("shipments"\)\s*\.insert/g) ?? [];
    const origins = source.match(/created_via:/g) ?? [];

    expect(inserts.length).toBeGreaterThan(0);
    expect(origins.length).toBe(inserts.length);
  });

  it("la server action no repite los literales a mano", () => {
    // Si el literal se escribe suelto, el siguiente insert puede olvidarlo sin
    // que nada avise; obligando a pasar por la constante, el test de arriba lo ve.
    const source = read(ACTIONS).replace(/^import[\s\S]*?from "@\/lib\/shalom\/origin";$/m, "");
    expect(source).not.toContain(`"${SHALOM_ORIGIN.api}"`);
    expect(source).not.toContain(`"${SHALOM_ORIGIN.manual}"`);
  });

  it("el backfill escribe la misma marca que el código", () => {
    // Una migración con el literal desincronizado repuebla la columna con un
    // valor que ya nadie escribe, y el desajuste solo se ve consultando datos.
    const migration = read(MIGRATION);
    expect(migration).toContain(`created_via = '${SHALOM_ORIGIN.api}'`);
    // No debe tocar filas que ya tienen origen ni las importadas del reporte,
    // que no traen el identificador interno que devuelve la API al crear.
    expect(migration).toContain("created_via is null");
    expect(migration).toContain("shalom_ose_id is not null");
  });
});
