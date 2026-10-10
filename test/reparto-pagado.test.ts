// Un pedido pagado antes de la entrega va «Sin cobro» y cuadra (MOM §30.9,
// 10-10-2026: #KP139362, S/ 268.20 pagados por adelantado).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { amountDue, montoDiffers } from "@/lib/sheets/monto";

const read = (f: string) => readFileSync(`${process.cwd()}/${f}`, "utf8");

describe("lo que había que cobrar es el saldo", () => {
  it("pagado antes: «Sin cobro» cuadra; con adelanto, el saldo; sin saldo legible, el total", () => {
    expect(amountDue(268.2, 0)).toBe(0);
    expect(montoDiffers(0, amountDue(268.2, 0))).toBe(false);
    expect(montoDiffers(218.2, amountDue(268.2, 218.2))).toBe(false);
    expect(montoDiffers(150, amountDue(268.2, 218.2))).toBe(true);
    expect(amountDue(268.2, null)).toBe(268.2);
    expect(amountDue(268.2, undefined)).toBe(268.2);
  });

  it("servidor y pantalla piden el motivo con la misma regla", () => {
    const server = read("app/reparto/actions.ts");
    expect(server).toContain("const due = amountDue(orderTotal, remaining);");
    expect(server).toContain("if (hasSheet && montoDiffers(collectedForReason ?? null, due) && !reasonCode)");
    expect(server).not.toContain("el pedido es de S/");
    const screen = read("components/rider-route.tsx");
    expect(screen).toContain("const mustExplain = status === \"entregado\" && Boolean(vocabulary) && montoDiffers(collectedForReason, due);");
    // Saldo cero: «Sin cobro» elegido solo y el aviso en verde.
    expect(screen).toContain('if (status === "entregado" && fullyPaid && !method) setMethod("sin_cobro");');
    expect(screen).toContain("Ya está pagado.");
    expect(read("docs/mom/master-pedidos-v1.md")).toContain("**Lo que había que cobrar es el saldo (10-10-2026, decisión de Frankz).**");
  });
});
