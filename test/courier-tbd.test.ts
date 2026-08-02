import { describe, expect, it } from "vitest";
import { COURIER_TBD, isCourierTbd, outputDisplayCode } from "@/lib/shipment-output";

describe("courier por definir", () => {
  it("reconoce el centinela sin importar espacios ni mayúsculas", () => {
    expect(isCourierTbd(COURIER_TBD)).toBe(true);
    expect(isCourierTbd(" POR_DEFINIR ")).toBe(true);
    expect(isCourierTbd("axel")).toBe(false);
    expect(isCourierTbd(null)).toBe(false);
    expect(isCourierTbd("")).toBe(false);
  });

  it("el código visible NO lleva sufijo mientras el courier esté por definir", () => {
    // La identidad de la salida es pedido + consecutivo (MOM §4); el courier es
    // metadato. Un sufijo "POR-DEFINIR" ensuciaría un código que va a cambiar.
    expect(outputDisplayCode("KP123-S01", COURIER_TBD)).toBe("KP123-S01");
  });

  it("al fijarse el courier, el código visible lo incorpora", () => {
    expect(outputDisplayCode("KP123-S01", "axel")).toBe("KP123-S01-AXEL");
    expect(outputDisplayCode("KP123-S01", "motorizado propio")).toBe("KP123-S01-MOTORIZADO-PROPIO");
  });

  it("sin output_code no hay etiqueta que mostrar", () => {
    expect(outputDisplayCode(null, COURIER_TBD)).toBe("");
  });
});
