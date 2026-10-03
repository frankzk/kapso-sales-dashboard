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

// El Master dejó las columnas congeladas el 02-10-2026: la tabla compacta
// (celdas de dos renglones, MOM §25) entra entera en la pantalla y ya no hay
// scroll horizontal del que proteger el nombre del pedido.
describe("la tabla del Master entra en la pantalla", () => {
  const source = readFileSync(
    resolve(process.cwd(), "components/orders-master.tsx"),
    "utf8",
  );

  it("no vuelve a un ancho mínimo ni a columnas congeladas", () => {
    expect(source).not.toMatch(/min-w-\[1\d{3}px\]/);
    expect(source).not.toContain("frozenOffsets(");
    expect(source).toContain("xl:table-fixed");
  });

  it("ningún dato de las columnas de antes se pierde", () => {
    for (const field of [
      "r.order_name",
      "storeName(r.store_id)",
      "r.order_created_at",
      "r.customer_name",
      "r.customer_phone",
      "r.region",
      "r.province",
      "r.district",
      "<CoverageBadge coverage={r.coverage} />",
      "r.last_courier",
      "r.courier_count",
      "r.attempt_count",
      "<MacroStageBadge stage={r.macro_stage} />",
      "macroSubstageLabel(r.macro_substage)",
      "r.confirmation_day_count",
      "<NextContactCell row={r} />",
      "fmtDate(r.last_movement_at)",
      "fmtAge(since)",
    ]) {
      expect(source).toContain(field);
    }
  });
});
