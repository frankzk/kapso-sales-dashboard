// Verificar una caja: el paquete de otra caja dice cuál es (07-10-2026).
// KP136825-S01 estaba en la caja de Alexis y se escaneó en la verificación de
// Roy; «no pertenece a esta ruta» parecía un bloqueo.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boxWho, notInThisBoxMessage } from "@/lib/scan-other-box";

const ROY = { who: "Roy", routeDate: "2026-10-07" };

describe("notInThisBoxMessage", () => {
  it("#KP136825: nombra la caja donde está y la que se verifica", () => {
    expect(notInThisBoxMessage(ROY, { who: "Alexis", routeDate: "2026-10-07" })).toBe(
      "Está en la caja de Alexis (07/10), no en la de Roy. Verifícalo en esa caja.",
    );
  });

  it("otra caja del mismo motorizado, de otro día", () => {
    expect(notInThisBoxMessage(ROY, { who: "Roy", routeDate: "2026-10-06" })).toBe(
      "Está en otra caja de Roy (06/10), no en la de Roy. Verifícalo en esa caja.",
    );
  });

  it("en ninguna caja: hay que agregarlo primero", () => {
    expect(notInThisBoxMessage(ROY, null)).toBe("No está en la caja de Roy ni en otra. Agrégalo primero a una caja.");
  });

  it("quién se lleva la caja: quien recoge, el motorizado o el courier", () => {
    expect(boxWho({ received_by: "Juan", driver_name: "Roy" }, "Grupo GF")).toBe("Juan");
    expect(boxWho({ received_by: null, driver_name: "Roy" }, "Grupo GF")).toBe("Roy");
    expect(boxWho({}, "Urpi")).toBe("Urpi");
  });
});

describe("la cámara de verificación nombra la caja", () => {
  const workspace = readFileSync(join(process.cwd(), "components/dispatch-workspace.tsx"), "utf8");
  it("«Verificar caja · Roy», no «Escanear QR»", () => {
    expect(workspace).toContain('`${mode === "office" ? "Verificar caja" : "Recibir carga"} · ${routeHeading(selected).title}`');
  });
});
