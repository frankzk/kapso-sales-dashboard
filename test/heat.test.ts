import { describe, it, expect } from "vitest";
import { RITMO_MIN_HORA, heatStatuses, ritmoPorHora } from "@/lib/heat";

describe("heatStatuses (semáforo de ritmo dentro de la jornada real)", () => {
  it("juzga solo entre la primera y la última hora con actividad; el resto queda 'fuera'", () => {
    //           08 09  10 11 12 13 14 15..20 (celdas de ejemplo, 13 en total)
    const heat = [0, 8, 3, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0];
    const s = heatStatuses(heat);
    expect(s[0]).toBe("fuera"); // antes de empezar
    expect(s[1]).toBe("ok"); // 8 ≥ 6
    expect(s[2]).toBe("bajo"); // 3 < 6 con actividad
    expect(s[3]).toBe("muerta"); // 0 en plena jornada (entre 09 y 12)
    expect(s[4]).toBe("ok"); // 6 = mínimo → a ritmo
    expect(s.slice(5)).toEqual(new Array(8).fill("fuera")); // después de su última gestión (incl. horas futuras)
  });

  it("un día sin actividad no se juzga (todo 'fuera', nada en rojo)", () => {
    expect(heatStatuses(new Array(13).fill(0))).toEqual(new Array(13).fill("fuera"));
  });

  it("en modo promedio compara el decimal contra el mismo mínimo (5.9 → bajo; 6 → ok)", () => {
    const s = heatStatuses([5.9, 6, 0.3]);
    expect(s).toEqual(["bajo", "ok", "bajo"]);
  });

  it("el umbral es RITMO_MIN_HORA y es parametrizable", () => {
    expect(RITMO_MIN_HORA).toBe(6);
    expect(heatStatuses([4, 4], 4)).toEqual(["ok", "ok"]);
  });
});

describe("ritmoPorHora (chip de ritmo global de la fila)", () => {
  it("leads ÷ horas activas a 1 decimal", () => {
    expect(ritmoPorHora(7, 1.2)).toBeCloseTo(5.8);
    expect(ritmoPorHora(83, 7.9)).toBeCloseTo(10.5);
  });
  it("sin horas inferidas no se juzga (null)", () => {
    expect(ritmoPorHora(1, 0)).toBeNull();
  });
});
