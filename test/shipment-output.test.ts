import { describe, expect, it } from "vitest";
import {
  buildOutputCode,
  canRepeatCourier,
  normalizeOrderCode,
  outputDisplayCode,
} from "@/lib/shipment-output";

describe("identidad de salida MOM", () => {
  it("normaliza el pedido y construye un consecutivo estable", () => {
    expect(normalizeOrderCode(" #kp123 ")).toBe("KP123");
    expect(buildOutputCode("#KP123", 2)).toBe("KP123-S02");
    expect(buildOutputCode(null, 2)).toBe("");
    expect(buildOutputCode("#KP123", 0)).toBe("");
  });

  it("agrega el courier solo a la etiqueta visible", () => {
    expect(outputDisplayCode("KP123-S02", "Axel Courier")).toBe("KP123-S02-AXEL-COURIER");
    expect(outputDisplayCode("KP123-S02", null)).toBe("KP123-S02");
  });
});

describe("política de repetición", () => {
  const base = { priorOutputsWithCourier: 1, totalOutputs: 2 };

  it("permite repetir Axel y motorizados propios", () => {
    expect(canRepeatCourier({ ...base, courier: "Axel Courier", operation: "lima" }).allowed).toBe(true);
    expect(canRepeatCourier({ ...base, courier: "motorizado propio", operation: "lima" }).allowed).toBe(true);
  });

  it("Swayp se repite en provincia, pero no en Lima", () => {
    expect(canRepeatCourier({ ...base, courier: "swayp", operation: "provincia_cod" }).allowed).toBe(true);
    expect(canRepeatCourier({ ...base, courier: "swayp", operation: "lima" })).toEqual({
      allowed: false,
      reason: "courier_already_used",
    });
  });

  it("no inventa todavía un bloqueo para Aliclik", () => {
    expect(canRepeatCourier({ ...base, courier: "aliclik", operation: "provincia_cod" }).allowed).toBe(true);
  });

  it("el máximo global gana sobre la política del courier", () => {
    expect(canRepeatCourier({
      courier: "Axel Courier",
      operation: "lima",
      priorOutputsWithCourier: 2,
      totalOutputs: 5,
    })).toEqual({ allowed: false, reason: "max_outputs" });
  });
});

