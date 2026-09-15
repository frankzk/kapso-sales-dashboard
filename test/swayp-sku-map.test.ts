import { describe, expect, it } from "vitest";
import {
  conflictosDeCodbar,
  unVinculoPorSku,
  type FilaMapaSwayp,
} from "@/lib/swayp-sku-map";

/**
 * EL CODBAR ES DEL PRODUCTO EN SWAYP, NO DE LA TIENDA QUE LO VENDIÓ.
 *
 * EL CASO, 15-09-2026. La organización tiene dos tiendas —Aurela y Kenku Perú—
 * que comparten la misma bodega de Swayp. De los 19 productos vinculados, 18
 * estaban escritos bajo Kenku Perú y uno bajo Aurela. Como el mapa se leía
 * acotado a la tienda del pedido, cualquier pedido de Aurela de esos 18 moría
 * en «Falta vincular a Swayp: …» y salía con código manual, teniendo el codbar
 * ya escrito a un metro de distancia.
 *
 * El importador de inventario ya leía por organización —«el stock es de la
 * organización, no de una tienda»—, así que las dos mitades del mismo sistema
 * no coincidían. Estas pruebas fijan la regla en un solo sitio.
 */

const fila = (
  store_id: string,
  shopify_sku: string,
  codbar: string,
  updated_at?: string,
): FilaMapaSwayp => ({ store_id, shopify_sku, codbar, nombre: codbar, updated_at });

const AURELA = "aurela";
const KENKU = "kenku";

describe("unVinculoPorSku", () => {
  it("encuentra el vínculo escrito en la tienda hermana", () => {
    const mapa = unVinculoPorSku([fila(KENKU, "765545233", "AURE001")], AURELA);
    expect(mapa.get("765545233")?.codbar).toBe("AURE001");
  });

  it("normaliza el SKU, así que mayúsculas y espacios no parten el vínculo", () => {
    const mapa = unVinculoPorSku([fila(KENKU, " prueba-ethiopian ", "AURE003")], AURELA);
    expect(mapa.get("PRUEBA-ETHIOPIAN")?.codbar).toBe("AURE003");
  });

  it("cuando las dos tiendas lo tienen, manda la propia", () => {
    // Si alguien corrigió el codbar en la tienda desde la que se está
    // operando, esa corrección es la que tiene delante.
    const mapa = unVinculoPorSku(
      [fila(KENKU, "818531465", "AURE020"), fila(AURELA, "818531465", "AURE099")],
      AURELA,
    );
    expect(mapa.get("818531465")?.codbar).toBe("AURE099");
    expect(mapa.get("818531465")?.storeId).toBe(AURELA);
  });

  it("sin tienda propia gana la más reciente, y el resultado no baila", () => {
    const filas = [
      fila(KENKU, "64565434", "AURE018", "2026-09-10T00:00:00Z"),
      fila(AURELA, "64565434", "AURE077", "2026-09-14T00:00:00Z"),
    ];
    expect(unVinculoPorSku(filas, "")?.get("64565434")?.codbar).toBe("AURE077");
    // El orden de llegada de las filas no puede cambiar la respuesta.
    expect(unVinculoPorSku([...filas].reverse(), "")?.get("64565434")?.codbar).toBe("AURE077");
  });

  it("ignora las filas sin SKU o sin codbar en vez de guardar un vínculo vacío", () => {
    const mapa = unVinculoPorSku(
      [fila(KENKU, "", "AURE001"), fila(KENKU, "123", ""), fila(KENKU, "456", "AURE002")],
      AURELA,
    );
    expect(mapa.size).toBe(1);
    expect(mapa.get("456")?.codbar).toBe("AURE002");
  });
});

describe("conflictosDeCodbar", () => {
  it("delata el SKU que dos tiendas mandan a codbar distintos", () => {
    const conflictos = conflictosDeCodbar([
      fila(KENKU, "64565434", "AURE018"),
      fila(AURELA, "64565434", "AURE077"),
      fila(KENKU, "765545233", "AURE001"),
    ]);
    expect(conflictos.get("64565434")).toEqual(["AURE018", "AURE077"]);
    expect(conflictos.has("765545233")).toBe(false);
  });

  it("el mismo codbar escrito dos veces no es un conflicto", () => {
    const conflictos = conflictosDeCodbar([
      fila(KENKU, "765545233", "AURE001"),
      fila(AURELA, "765545233", "aure001"),
    ]);
    expect(conflictos.size).toBe(0);
  });
});
