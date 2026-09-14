import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Un conjunto de anuncios promociona un solo producto.
 *
 * El conjunto —no la campaña— es la unidad de prueba: mismo público, mismo
 * presupuesto, mismo producto, y lo que cambia entre sus anuncios es el
 * creativo. Asignar uno a mano y dejar los otros treinta en «Por mapear» era
 * pedirle a una persona que copiara un dato que el sistema ya tenía.
 *
 * Medido el 14-09-2026: 5.213 anuncios, 68 asignados a mano, 523 alcanzables
 * por herencia, y CERO conjuntos con dos productos distintos asignados.
 */

const server = readFileSync(resolve(process.cwd(), "app/dashboard/actions.ts"), "utf8");
const ui = readFileSync(resolve(process.cwd(), "components/campaign-table.tsx"), "utf8");
// Se busca por el NOMBRE, no por el número. Esta migración nació 0162 y se
// renumeró a 0163 porque `0162_rider_daily_pay.sql` ya ocupaba ese número: dos
// ramas en paralelo lo eligieron sin verse. Anclar el número aquí convertía un
// renombre legítimo en una prueba roja, que es ruido y no una señal.
const MIGRACION = "_meta_ads_heredar_producto_por_conjunto.sql";
const nombreMigracion = readdirSync(resolve(process.cwd(), "db/migrations")).find((f) =>
  f.endsWith(MIGRACION),
);
if (!nombreMigracion) throw new Error(`No existe ninguna migración *${MIGRACION}`);
const migracion = readFileSync(
  resolve(process.cwd(), "db/migrations", nombreMigracion),
  "utf8",
);

describe("la herencia va por conjunto, no por campaña", () => {
  it("el filtro del update es `adset_id`", () => {
    const fn = server.slice(server.indexOf("async function heredarAlConjunto"));
    expect(fn.slice(0, 1800)).toContain('.eq("adset_id", adsetId)');
    // La campaña NO: en «Cayenne Pepper 0608» conviven 23 conjuntos.
    expect(fn.slice(0, 1800)).not.toContain('.eq("campaign_id"');
  });

  it("nunca pisa una asignación existente", () => {
    const fn = server.slice(server.indexOf("async function heredarAlConjunto"));
    expect(fn.slice(0, 1800)).toContain('.is("promoted_product_name", null)');
    expect(fn.slice(0, 1800)).toContain('.neq("ad_id", adId)');
  });

  it("si la herencia falla, el guardado que se pidió sigue en pie", () => {
    const fn = server.slice(server.indexOf("async function heredarAlConjunto"));
    expect(fn.slice(0, 1800)).toContain("if (error) return 0;");
  });

  it("sin conjunto no hereda nada", () => {
    const fn = server.slice(server.indexOf("async function heredarAlConjunto"));
    expect(fn.slice(0, 1800)).toContain("if (!adsetId) return 0;");
  });
});

describe("lo que cambia solo, se dice", () => {
  it("la acción devuelve cuántos heredaron", () => {
    expect(server).toContain("Promise<{ ok: true; heredados: number } | { ok: false; error: string }>");
    expect(server).toContain("return { ok: true, heredados };");
  });

  it("y el panel lo cuenta en singular y en plural", () => {
    expect(ui).toContain("Se aplicó también a ${result.heredados}");
    expect(ui).toContain('result.heredados === 1 ? "anuncio" : "anuncios"');
  });
});

describe("el ID del anuncio se ve", () => {
  it("junto al conjunto del que hereda, y se puede copiar", () => {
    // Se usaba para guardar y no se mostraba en ninguna parte: era el dato con
    // el que se busca el anuncio en Ads Manager.
    expect(ui).toContain("<span className=\"font-mono\">{row.metaAdId}</span>");
    expect(ui).toContain('<CopyButton value={row.metaAdId} label="Copiar ID" />');
    expect(ui).toContain("row.meta?.adsetName");
  });
});

describe("el relleno de lo ya existente es igual de conservador", () => {
  it("solo escribe sobre nulos y solo desde conjuntos sin conflicto", () => {
    expect(migracion).toContain("having count(distinct promoted_product_name) = 1");
    expect(migracion).toContain("and m.promoted_product_name is null");
  });
});
