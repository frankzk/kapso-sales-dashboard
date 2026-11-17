import { describe, expect, it } from "vitest";
import { gfWebhookNote } from "@/lib/gf-webhook-note";

describe("gfWebhookNote", () => {
  it("«No responde antes de salir» deja la línea con el intento y la nueva fecha", () => {
    expect(gfWebhookNote({ type: "order.delivery_date_changed", data: { reason: "No respondió antes de salir (1 de 2)", new_date: "2026-11-17", no_answer: { attempt: 1, limit: 2 } } }))
      .toBe("GF Courier: No respondió antes de salir (1 de 2). Vuelve a salir el 17/11, con la misma guía.");
  });
  it("la anulación dice su motivo", () => {
    expect(gfWebhookNote({ type: "order.status_changed", data: { status: { code: "CANCELLED" }, reason: "No respondió 3 veces antes de salir: guía anulada" } }))
      .toBe("GF Courier: No respondió 3 veces antes de salir: guía anulada.");
  });
  it("sin motivo no hay línea (el cambio de estado ya deja la suya)", () => {
    expect(gfWebhookNote({ type: "order.status_changed", data: { reason: null } })).toBeNull();
    expect(gfWebhookNote({ type: "order.delivery_date_changed", data: { new_date: "2026-11-17" } })).toBeNull();
    expect(gfWebhookNote({ type: "order.delivered", data: { reason: "x" } })).toBeNull();
  });
});

describe("GF: etapa y cambio de fecha (17-11-2026)", () => {
  it("al asignarse a un motorizado deja «asignado a Alexis para la ruta del 18/11»", () => {
    expect(gfWebhookNote({ type: "order.status_changed", data: { stage: { code: "AWAITING_OFFICE_CHECK", name: "x", rider_name: "Alexis", route_date: "2026-11-18" } } }))
      .toBe("GF Courier: asignado a Alexis para la ruta del 18/11.");
  });
  it("un cambio de fecha pedido por la tienda u oficina dice el día y el motivo, con la misma guía", () => {
    expect(gfWebhookNote({ type: "order.delivery_date_changed", data: { new_date: "2026-11-19", reason: "La clienta lo quiere el jueves", changed_by: "GF" } }))
      .toBe("GF Courier: fecha de entrega cambiada al 19/11 (La clienta lo quiere el jueves), con la misma guía.");
  });
  it("las otras etapas no dejan línea propia", () => {
    expect(gfWebhookNote({ type: "order.status_changed", data: { stage: { code: "AWAITING_ASSIGNMENT", name: "Por asignar" } } })).toBeNull();
  });
});
