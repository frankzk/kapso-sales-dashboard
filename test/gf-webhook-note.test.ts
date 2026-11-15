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
