import { describe, expect, it } from "vitest";
import { MASTER_VIEWS, isMasterView } from "@/lib/orders-master-access";

describe("navegación del Master por macroetapas", () => {
  it("usa el MOM y no las pestañas heredadas", () => {
    expect(MASTER_VIEWS.map((view) => view.key)).toEqual([
      "todos",
      "por_confirmar",
      "preparacion",
      "por_despachar",
      "en_curso",
      "por_cerrar",
      "finalizado",
    ]);
  });

  it("rechaza URLs heredadas para volver de forma segura a Todos", () => {
    expect(isMasterView("preparacion")).toBe(true);
    expect(isMasterView("pendiente")).toBe(false);
    expect(isMasterView("en_proceso")).toBe(false);
  });
});
