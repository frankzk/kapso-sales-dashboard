// «Ya estaba» dice la carga y lo que falta (MOM §29.13, 12-10-2026). #KP139615
// estaba en la Carga 5 de Alexis sin verificar: no salía en su ruta y el
// escaneo respondía solo «Ya estaba».

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { alreadyInBoxChip, alreadyInBoxMessage, alreadyInBoxStage } from "@/lib/gf-scan-already-in-box";

describe("en qué punto está la carga", () => {
  it("sin verificar, verificada sin entregar, entregada", () => {
    expect(alreadyInBoxStage({ officeCheckedAt: null, manifestState: "draft" })).toBe("por_verificar");
    expect(alreadyInBoxStage({ officeCheckedAt: "2026-10-12T17:50:00Z", manifestState: "ready_for_pickup" })).toBe("por_entregar");
    expect(alreadyInBoxStage({ officeCheckedAt: "2026-10-12T17:50:00Z", manifestState: "in_custody" })).toBe("entregada");
  });
});

describe("lo que dice la fila", () => {
  it("el caso de #KP139615: la Carga 5, sin verificar", () => {
    expect(alreadyInBoxChip({ riderName: "Alexis", loadNumber: 5, stage: "por_verificar" })).toBe("Ya está en la Carga 5 · falta verificarla");
    expect(alreadyInBoxMessage({ riderName: "Alexis", loadNumber: 5, stage: "por_verificar" })).toBe(
      "Ya está en la Carga 5 de Alexis: falta verificar esa carga en «Cajas de hoy». Hasta entonces no sale en su ruta.",
    );
  });

  it("verificada sin entregar, y ya entregada", () => {
    expect(alreadyInBoxChip({ riderName: "Alexis", loadNumber: 5, stage: "por_entregar" })).toBe("Ya está en la Carga 5 · falta entregarla");
    expect(alreadyInBoxChip({ riderName: "Alexis", loadNumber: 3, stage: "entregada" })).toBe("Ya está en la Carga 3 · la tiene Alexis");
    expect(alreadyInBoxMessage({ riderName: "Alexis", loadNumber: 3, stage: "entregada" })).toBe("Ya está en la Carga 3 de Alexis, que Alexis ya tiene.");
  });

  it("sin número de carga, nombra la caja", () => {
    expect(alreadyInBoxChip({ riderName: "Yhoni", loadNumber: null, stage: "por_verificar" })).toBe("Ya está en su caja · falta verificarla");
    expect(alreadyInBoxMessage({ riderName: "Yhoni", loadNumber: null, stage: "por_entregar" })).toBe(
      "Ya está en la caja de Yhoni, verificado en oficina: falta entregársela.",
    );
    // Una respuesta vieja, sin etapa, no inventa lo que falta.
    expect(alreadyInBoxChip({ riderName: "Yhoni" })).toBe("Ya está en su caja");
  });
});

describe("dónde se usa", () => {
  it("el escaneo lee el número de carga y las dos pantallas usan la chapa", () => {
    const actions = readFileSync(resolve(process.cwd(), "app/dashboard/courier/actions.ts"), "utf8");
    expect(actions).toContain("dispatch_manifests!inner(id,rider_id,driver_name,route_date,state,load_number)");
    expect(actions).toContain("alreadyInBoxMessage({ riderName: rider.full_name, loadNumber, stage: boxStage })");
    for (const file of ["components/dispatch-day-board.tsx", "components/gf-box-add-packages.tsx"]) {
      const ui = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(ui).toContain("alreadyInBoxChip({ riderName: l.riderName ?? riderName, loadNumber: l.loadNumber, stage: l.boxStage })");
      expect(ui).not.toContain('text: "Ya estaba"');
    }
  });
});
