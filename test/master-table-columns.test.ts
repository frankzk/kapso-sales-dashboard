import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FROZEN_W,
  FROZEN_PAD,
  frozenCellStyle,
  frozenOffsets,
  frozenOrder,
  frozenTextWidth,
} from "@/lib/master-table-columns";

/**
 * Las columnas congeladas del Master y el ancho que las sostiene.
 *
 * QUÉ PASÓ. Un nombre de cliente de 94 caracteres —el mismo nombre concatenado
 * cinco veces— ensanchó la columna «Cliente» y empujó fuera de pantalla todo lo
 * que va detrás. La celda ya pedía `truncate`, pero `truncate` sin un ancho que
 * no se pueda rebasar no recorta nada: en `table-layout: auto`, `width` sobre un
 * `<td>` es una sugerencia y el navegador la ignora si el contenido pide más.
 *
 * Y no es solo estética: el desplazamiento de cada columna pegada es la SUMA de
 * los anchos de las anteriores. En cuanto una crece de verdad, los offsets
 * calculados con los anchos nominales dejan de corresponder.
 */

describe("orden de las columnas congeladas", () => {
  it("«Tienda» solo aparece en multitienda", () => {
    expect(frozenOrder(false)).toEqual(["check", "pedido", "creado", "cliente"]);
    expect(frozenOrder(true)).toEqual(["check", "pedido", "tienda", "creado", "cliente"]);
  });
});

describe("desplazamientos: la suma de las anteriores", () => {
  it("una tienda", () => {
    const left = frozenOffsets(false);
    expect(left.check).toBe(0);
    expect(left.pedido).toBe(FROZEN_W.check);
    expect(left.creado).toBe(FROZEN_W.check + FROZEN_W.pedido);
    expect(left.cliente).toBe(FROZEN_W.check + FROZEN_W.pedido + FROZEN_W.creado);
  });

  it("«Tienda» corre todo lo que viene después", () => {
    // Es la razón por la que los offsets se calculan y no se escriben a mano.
    const una = frozenOffsets(false);
    const dos = frozenOffsets(true);
    expect(dos.creado - una.creado).toBe(FROZEN_W.tienda);
    expect(dos.cliente - una.cliente).toBe(FROZEN_W.tienda);
    expect(dos.pedido).toBe(una.pedido);
  });

  it("ninguna columna se solapa con la siguiente", () => {
    // La comprobación de verdad: cada una empieza donde acaba la anterior.
    for (const multi of [false, true]) {
      const left = frozenOffsets(multi);
      const order = frozenOrder(multi);
      for (let i = 1; i < order.length; i++) {
        const prev = order[i - 1]!;
        const curr = order[i]!;
        expect(left[curr], `${prev}→${curr}`).toBe(left[prev]! + FROZEN_W[prev]);
      }
    }
  });
});

describe("el ancho es un TECHO, no una sugerencia", () => {
  it("cada celda congelada declara el mismo ancho mínimo y máximo", () => {
    // ESTA es la regresión. Sin `maxWidth`, el contenido ensancha la columna y
    // los offsets de arriba —que se calculan con el ancho nominal— pasan a
    // apuntar a un sitio que ya no existe.
    const left = frozenOffsets(true);
    for (const key of frozenOrder(true)) {
      const style = frozenCellStyle(key, left, 5);
      expect(style.width, key).toBe(FROZEN_W[key]);
      expect(style.minWidth, key).toBe(FROZEN_W[key]);
      expect(style.maxWidth, key).toBe(FROZEN_W[key]);
    }
  });

  it("la celda se coloca donde dicen los desplazamientos", () => {
    const left = frozenOffsets(true);
    expect(frozenCellStyle("cliente", left, 7).left).toBe(left.cliente);
    expect(frozenCellStyle("cliente", left, 7).zIndex).toBe(7);
  });
});

describe("el recorte del texto", () => {
  it("deja sitio al padding de la celda", () => {
    // Sin descontarlo, el bloque interno mide lo mismo que la celda y el texto
    // se recorta tarde: los últimos caracteres quedan bajo el padding.
    expect(frozenTextWidth("cliente")).toBe(FROZEN_W.cliente - FROZEN_PAD);
  });

  it("nunca es negativo aunque el padding se coma la columna", () => {
    expect(frozenTextWidth("check", 999)).toBe(0);
  });
});

describe("la tabla usa la geometría, no números sueltos", () => {
  it("el componente no vuelve a declarar sus propios anchos", () => {
    // El invariante solo se sostiene si hay UNA definición. Una copia local de
    // los anchos en el componente volvería a divergir de los offsets el día que
    // alguien ajuste una columna, y eso no se ve en ninguna prueba de esta
    // función pura: se ve en pantalla, cizallado.
    const source = readFileSync(
      resolve(process.cwd(), "components/orders-master.tsx"),
      "utf8",
    );
    expect(source).toContain("frozenOffsets(multiStore)");
    expect(source).toContain("frozenCellStyle(");
    expect(source).not.toMatch(/const FROZEN_W = \{/);
  });

  it("el nombre del cliente se recorta contra un ancho real", () => {
    // `truncate` a secas en el `<td>` fue justo lo que no funcionó.
    const source = readFileSync(
      resolve(process.cwd(), "components/orders-master.tsx"),
      "utf8",
    );
    expect(source).toContain('frozenTextWidth("cliente")');
    expect(source).toMatch(/className="block truncate"/);
  });
});
