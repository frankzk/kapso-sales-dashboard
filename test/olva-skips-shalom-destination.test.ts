import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #KP143233 (owner, 01-11-2026): con su guía de Olva creada, el paso 1 del
// cobro seguía pidiendo DNI y agencia de Shalom.
describe("pedido que va por Olva: no se pide el destino de Shalom (MOM §Pagos)", () => {
  const actions = readFileSync("app/dashboard/pedidos/payment-actions.ts", "utf8");
  const panel = readFileSync("components/pickup-key-panel.tsx", "utf8");

  it("el panel lee las guías de Shalom y de Olva, y la de Olva solo cuenta sin una de Shalom", () => {
    expect(actions).toContain('.in("courier", ["shalom", "olva"])');
    expect(actions).toContain('const olvaLive = shalomLive ? undefined : agencyRows.find((row) => row.courier === "olva" && isLive(row));');
    expect(actions).toContain("olvaGuide: olvaLive ? { guideCode: olvaLive.guide_code } : null,");
  });

  it("una guía anulada o devuelta no es viva", () => {
    expect(actions).toContain(
      'row.custody_state !== "devuelto" && ["pendiente", "en_ruta", "por_preparar"].includes(row.delivery_status)',
    );
  });

  it("el paso 1 dice «Va por Olva» y el pedido pagado no ofrece el bloque", () => {
    expect(panel).toContain('title="Va por Olva"');
    expect(panel).toContain("no hace falta DNI ni agencia de Shalom.");
    expect(panel).toContain("shalomDestination && panel.canEditShalomDraft && !panel.olvaGuide && (");
  });
});
