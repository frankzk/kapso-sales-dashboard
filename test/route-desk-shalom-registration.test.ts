import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrderRouteDesk } from "@/components/order-route-desk";
import { buildOrderRoutePlan, type OrderRoutePlan, type RouteDeskGate } from "@/lib/order-route-plan";

const plan = buildOrderRoutePlan({
  operation: "agencia",
  paymentState: "adelanto_validado",
  outputs: [{ id: "old-guide", courier: "shalom", deliveryStatus: "pendiente", guideCode: "102321353", shortCode: "HWND", shalomUnrecognized: true }],
});

function render({ allowed = true, gate, registration = true, routePlan = plan }: { allowed?: boolean; gate?: RouteDeskGate; registration?: boolean; routePlan?: OrderRoutePlan } = {}) {
  return renderToStaticMarkup(createElement(OrderRouteDesk, {
    plan: routePlan,
    gate,
    actionEnabled: () => allowed,
    onSelect: () => {},
    onRegisterShalom: registration ? () => {} : undefined,
  }));
}

function button(html: string, label: string) {
  return [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]).find((markup) => markup.includes(label));
}

describe("existing Shalom guides remain reachable when creation is blocked", () => {
  it.each([
    ["pendiente", undefined],
    ["en_transito", false],
    ["en_destino", false],
    ["disponible_para_recojo", false],
    ["en_retorno", false],
  ])("hides replacement for a normal or unconfirmed guide: %s", (pickupState, shalomUnrecognized) => {
    const routePlan = buildOrderRoutePlan({
      operation: "agencia", paymentState: "adelanto_validado",
      outputs: [{ id: "healthy-guide", courier: "shalom", deliveryStatus: "pendiente", guideCode: "103120594", shortCode: "D39C", pickupState, shalomUnrecognized }],
    });
    const html = render({ routePlan });
    expect(button(html, "Ya la creé en Shalom Pro")).toBeUndefined();
    expect(button(html, "Ya tiene salida activa")).toMatch(/\sdisabled(?:=|\s|>)/);
    expect(routePlan.candidates.find((route) => route.key === "shalom")?.reason).not.toContain("Ya la creé");
  });

  it.each(["olva", "shalom"])("another live %s output prevents replacement", (courier) => {
    const routePlan = buildOrderRoutePlan({
      operation: "agencia", paymentState: "adelanto_validado",
      outputs: [
        { id: "dead", courier: "shalom", deliveryStatus: "pendiente", guideCode: "102321353", shalomUnrecognized: true },
        { id: "live", courier, deliveryStatus: "en_ruta", guideCode: "12345" },
      ],
    });
    expect(button(render({ routePlan }), "Ya la creé en Shalom Pro")).toBeUndefined();
  });

  it("KP201035 can open manual registration while creating another guide remains disabled", () => {
    const html = render();
    expect(button(html, "Ya tiene salida activa")).toMatch(/\sdisabled(?:=|\s|>)/);
    expect(button(html, "Ya la creé en Shalom Pro")).toBeDefined();
    expect(button(html, "Ya la creé en Shalom Pro")).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(html).toContain("102321353");
    expect(plan.candidates.find((route) => route.key === "shalom")?.availability).toBe("blocked");
  });

  it("does not grant access to operators without the Shalom guide permission", () => {
    expect(button(render({ allowed: false }), "Ya la creé en Shalom Pro")).toMatch(/\sdisabled(?:=|\s|>)/);
  });

  it("respects order closure blockers", () => {
    const gate: RouteDeskGate = { blockedActions: ["shalom"], blockers: [] };
    expect(button(render({ gate }), "Ya la creé en Shalom Pro")).toMatch(/\sdisabled(?:=|\s|>)/);
  });

  it("does not render a dead button without a registration handler", () => {
    expect(button(render({ registration: false }), "Ya la creé en Shalom Pro")).toBeUndefined();
  });

  it("keeps the ordinary API entry when there is no active guide", () => {
    const html = renderToStaticMarkup(createElement(OrderRouteDesk, {
      plan: buildOrderRoutePlan({ operation: "agencia", outputs: [], paymentState: "adelanto_validado" }),
      actionEnabled: () => true,
      onSelect: () => {},
      onRegisterShalom: () => {},
    }));
    expect(button(html, "Abrir Shalom")).toBeDefined();
    expect(button(html, "Ya la creé en Shalom Pro")).toBeUndefined();
  });
});
