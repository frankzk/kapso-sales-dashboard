// La zona «Anular pedido» de la ficha (MOM §38.15), renderizada: con algo que
// lo impide, el aviso con la lista y sin botón; sin nada, el botón que abre la
// confirmación.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WooCancelZone } from "@/components/woo-cancel-zone";
import type { WooCancelFacts } from "@/lib/woo-cancel";

const FACTS: WooCancelFacts = {
  platform: "woocommerce",
  generalStatus: "pendiente",
  financialStatus: "pending",
  shipments: [],
  payments: null,
  companion: { travelsIn: null, carries: [] },
};

function render(facts: WooCancelFacts) {
  return renderToStaticMarkup(
    createElement(WooCancelZone, { orderName: "#KP200010", facts, pending: false, onCancel: async () => true }),
  );
}

describe("WooCancelZone", () => {
  it("sin nada que lo impida: explica y ofrece «Anular pedido…»", () => {
    const html = render(FACTS);
    expect(html).toContain("Anular pedido");
    expect(html).toContain("No lo manda a la papelera");
    expect(html).toContain("Anular pedido…");
    expect(html).not.toContain("Todavía no se puede anular");
  });

  it("con una guía viva: el aviso con lo que hay que hacer, y sin botón", () => {
    const html = render({
      ...FACTS,
      shipments: [{ courier: "aliclik", guide_code: "AUR5X1", delivery_status: "pendiente", custody_state: "empresa" }],
    });
    expect(html).toContain("Todavía no se puede anular");
    expect(html).toContain("AUR5X1");
    expect(html).not.toContain("Anular pedido…");
  });
});
