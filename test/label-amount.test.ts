import { describe, expect, it } from "vitest";
import { formatCollectAmount } from "@/lib/labels/amount";

describe("formatCollectAmount", () => {
  it("soles sin céntimos cuando el total es entero", () => {
    expect(formatCollectAmount(298, "PEN")).toBe("S/ 298");
  });

  it("escribe los céntimos cuando existen", () => {
    expect(formatCollectAmount(297.99, "PEN")).toBe("S/ 297.99");
    expect(formatCollectAmount(297.9, "PEN")).toBe("S/ 297.90");
  });

  it("separa los miles", () => {
    expect(formatCollectAmount(1299.5, "PEN")).toBe("S/ 1,299.50");
    expect(formatCollectAmount(12000, "PEN")).toBe("S/ 12,000");
  });

  it("sin moneda asume soles, y la que no conocemos va con su código", () => {
    expect(formatCollectAmount(100, null)).toBe("S/ 100");
    expect(formatCollectAmount(100, "usd")).toBe("$ 100");
    expect(formatCollectAmount(100, "JPY")).toBe("JPY 100");
  });

  it("cero es un monto válido: hay pedidos de canje", () => {
    expect(formatCollectAmount(0, "PEN")).toBe("S/ 0");
  });

  it("sin dato devuelve null, NUNCA cero", () => {
    // Un cero impreso manda a entregar sin cobrar. Quien llama decide qué poner
    // en su lugar; aquí no se inventa una cifra.
    expect(formatCollectAmount(null, "PEN")).toBeNull();
    expect(formatCollectAmount(undefined, "PEN")).toBeNull();
    expect(formatCollectAmount(Number.NaN, "PEN")).toBeNull();
    expect(formatCollectAmount(-5, "PEN")).toBeNull();
  });
});
