import { describe, expect, it } from "vitest";
import { OVER_TABLE_Z, STICKY_HEAD, TABLE_LAYER } from "@/components/ui";

// Guarda de la escalera de capas de una tabla.
//
// POR QUÉ EXISTE ESTE TEST. Este defecto ya apareció dos veces, y las dos con el
// mismo síntoma: dos capas con el MISMO z-index. A igual z-index gana el último
// del DOM —la tabla, que va después de los filtros—, así que el desplegable
// quedaba debajo. Primero fue el encabezado fijo contra los popovers (ambos en
// 10); al subir los popovers a 30, la esquina congelada del Master ya estaba en
// 30 y los siguió tapando, pero SOLO los de la izquierda, que son los que caen
// sobre ella. Un empate no rompe el build ni ninguna otra prueba: se ve recién
// al abrir el desplegable en la pantalla correcta.

describe("TABLE_LAYER", () => {
  it("cada capa está estrictamente por encima de la anterior", () => {
    const ladder = [
      TABLE_LAYER.frozenCell,
      TABLE_LAYER.head,
      TABLE_LAYER.frozenHead,
      TABLE_LAYER.popover,
    ];
    for (let i = 1; i < ladder.length; i += 1) {
      expect(ladder[i], `capa ${i} debe superar a la anterior`).toBeGreaterThan(ladder[i - 1]!);
    }
  });

  it("no hay dos capas empatadas", () => {
    const values = Object.values(TABLE_LAYER);
    expect(new Set(values).size).toBe(values.length);
  });

  it("el z de STICKY_HEAD es el que declara la escalera", () => {
    // La clase y la constante tienen que decir lo mismo: si `STICKY_HEAD` sube a
    // z-20 sin tocar TABLE_LAYER, la esquina congelada deja de ganarle y se
    // pierde al scrollear en horizontal.
    expect(STICKY_HEAD).toContain(`[&_th]:z-${TABLE_LAYER.head}`);
  });

  it("la clase de los desplegables coincide con su capa", () => {
    expect(OVER_TABLE_Z).toBe(`z-${TABLE_LAYER.popover}`);
  });
});
