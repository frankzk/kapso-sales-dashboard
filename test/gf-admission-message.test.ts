// Por qué Grupo GF no toma un pedido, con nombre (09-10-2026). Escanear la S02
// de #KP139675 en la caja de Alexis decía «ya tiene una salida asignada a otro
// courier» sin decir cuál: la S02 era de Axel Courier y la S01 seguía en ruta
// con Swayp.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { otherCourierBlockMessage } from "@/lib/gf-admission-message";

const S01 = { id: "s1", courier: "fenix", output_code: "KP139675-S01", delivery_status: "en_ruta", custody_state: "courier", dispatched_at: "2026-10-09T05:39:52Z" };
const S02 = { id: "s2", courier: "axel", output_code: "KP139675-S02", delivery_status: "pendiente", custody_state: "empresa", dispatched_at: null };

describe("el mensaje nombra la salida, su courier, dónde está y qué hacer", () => {
  it("#KP139675: la S02 de Axel en almacén y la S01 en ruta con Swayp", () => {
    expect(otherCourierBlockMessage([S01, S02])).toBe(
      "KP139675-S01 está en ruta con Swayp · KP139675-S02 es de Axel Courier y sigue en almacén. " +
        "Para llevarlo en Grupo GF, anula la de almacén en la ficha («Salidas y guías») y registra antes el resultado de la que está en ruta.",
    );
  });

  it("solo una en almacén: basta anularla", () => {
    expect(otherCourierBlockMessage([S02])).toBe(
      "KP139675-S02 es de Axel Courier y sigue en almacén. Para llevarlo en Grupo GF, anula la de almacén en la ficha («Salidas y guías»).",
    );
  });

  it("no cuenta las de Grupo GF, las por definir ni las ya cerradas", () => {
    expect(
      otherCourierBlockMessage([
        { ...S02, courier: "propio" },
        { ...S02, courier: "por_definir" },
        { ...S01, delivery_status: "entregado" },
        { ...S01, delivery_status: "anulado" },
      ]),
    ).toBeNull();
  });

  it("las dos negativas de Grupo GF lo usan y conservan el texto de siempre si no aplica", () => {
    const actions = readFileSync(resolve(process.cwd(), "app/dashboard/courier/actions.ts"), "utf8");
    expect(actions).toContain('otherCourierBlockMessage(outputs) ?? "El pedido ya avanzó y salió de Pedidos disponibles."');
    expect(actions).toContain('?? "El pedido ya tiene una salida asignada a otro courier."');
  });
});

describe("la mesa de ruta pliega lo que casi no se usa", () => {
  const desk = readFileSync(resolve(process.cwd(), "components/order-route-desk.tsx"), "utf8");
  it("«Otros couriers» se abre solo si una de esas tarjetas tiene una salida viva", () => {
    expect(desk).toContain("Otros couriers");
    expect(desk).toContain("const rareOpen = showRare || rare.some((route) => Boolean(route.blockingOutput) || route.recommended);");
    expect(desk).toContain("aria-expanded={rareOpen}");
  });
});
