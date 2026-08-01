import { describe, expect, it } from "vitest";
import {
  MASTER_PAGE_SIZE,
  MASTER_VIEWS,
  isMasterView,
  reduceMasterMomCounts,
} from "@/lib/orders-master-access";

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

  it("limita cada página a 100 pedidos para proteger el navegador", () => {
    expect(MASTER_PAGE_SIZE).toBe(100);
  });

  it("suma macroetapas y subetapas desde un único resultado agrupado", () => {
    const result = reduceMasterMomCounts([
      { macro_stage: "preparacion", macro_substage: "por_generar_rotulo", total: 541 },
      { macro_stage: "preparacion", macro_substage: "por_armar", total: "413" },
      { macro_stage: "en_curso", macro_substage: "en_reparto", total: 692 },
    ]);

    expect(result.stages.todos).toBe(1646);
    expect(result.stages.preparacion).toBe(954);
    expect(result.stages.en_curso).toBe(692);
    expect(result.substages.por_generar_rotulo).toBe(541);
    expect(result.substages.por_armar).toBe(413);
  });
});
