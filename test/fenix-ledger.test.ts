import { describe, it, expect } from "vitest";
import { ajusteDelta, STOCK_MOVEMENT_LABEL } from "@/lib/fenix-ledger";

describe("ajusteDelta (reconciliación con el conteo de Fénix)", () => {
  it("lleva el saldo actual al conteo real (delta con signo)", () => {
    expect(ajusteDelta(10, 8)).toBe(-2); // sobran 2 en el sistema → baja
    expect(ajusteDelta(5, 9)).toBe(4); // faltaban 4 → sube
    expect(ajusteDelta(7, 7)).toBe(0); // ya coincide
  });
  it("trunca decimales de ambos lados", () => {
    expect(ajusteDelta(10.9, 8.2)).toBe(-2);
  });
  it("permite llevar a un conteo mayor desde saldo negativo (sobreventa previa)", () => {
    expect(ajusteDelta(-3, 5)).toBe(8);
  });
});

describe("STOCK_MOVEMENT_LABEL", () => {
  it("cubre los cuatro tipos", () => {
    expect(Object.keys(STOCK_MOVEMENT_LABEL).sort()).toEqual(
      ["ajuste", "entrada", "salida_entrega", "salida_merma"].sort(),
    );
    expect(STOCK_MOVEMENT_LABEL.salida_entrega).toMatch(/entrega/i);
  });
});
