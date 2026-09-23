// El gesto único (MOM §29.13): el contexto decide la acción y el evento.
import { describe, expect, it } from "vitest";
import { receptionEvent, scanActionPlan, SCAN_PLANS } from "@/lib/scan-action";

describe("scanActionPlan", () => {
  it("cada contexto tiene su evento, su etapa y su actor", () => {
    expect(scanActionPlan("oficina_cotejo")).toMatchObject({ gesture: "scan", eventKind: "office_checked", stage: "office", actor: "supervisor", needsReason: false });
    expect(scanActionPlan("motorizado_recepcion")).toMatchObject({ gesture: "scan", eventKind: "pickup_checked", stage: "pickup", actor: "motorizado" });
    expect(scanActionPlan("motorizado_entrega")).toMatchObject({ gesture: "photo", eventKind: "delivered", stage: null, actor: "motorizado" });
    expect(scanActionPlan("supervisor_retiro")).toMatchObject({ gesture: "scan", eventKind: "package_removed", needsReason: true, actor: "supervisor" });
    expect(scanActionPlan("supervisor_asignacion")).toMatchObject({ gesture: "scan", eventKind: "dispatch_route_assigned", stage: "office", actor: "supervisor", alsoEmits: ["logistics_request_accepted", "office_checked"] });
  });

  it("no hay dos contextos que dejen el mismo evento", () => {
    const kinds = Object.values(SCAN_PLANS).map((p) => p.eventKind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("recibir y rechazar son eventos distintos del mismo gesto", () => {
    expect(receptionEvent(false)).toBe("pickup_checked");
    expect(receptionEvent(true)).toBe("pickup_declined");
  });
});
