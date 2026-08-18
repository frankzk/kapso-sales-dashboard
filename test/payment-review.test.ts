import { describe, expect, it } from "vitest";
import {
  limaDayBounds,
  paymentKindLabel,
  paymentObservationLabel,
  paymentReviewLane,
} from "@/lib/payment-review";

describe("payment review lanes", () => {
  const today = "2026-08-18T05:00:00.000Z";

  it("mantiene pendientes y observados como trabajo activo", () => {
    expect(paymentReviewLane("pendiente_revision", null, today)).toBe("pending");
    expect(paymentReviewLane("posible_duplicado", null, today)).toBe("observed");
    expect(paymentReviewLane("info_incompleta", null, today)).toBe("observed");
    expect(paymentReviewLane("revision_admin", null, today)).toBe("observed");
  });

  it("solo muestra las validaciones del día y nunca deja un rechazo como tarea", () => {
    expect(paymentReviewLane("validado", "2026-08-18T06:00:00.000Z", today)).toBe("validated");
    expect(paymentReviewLane("validado", "2026-08-17T23:00:00.000Z", today)).toBeNull();
    expect(paymentReviewLane("rechazado", "2026-08-18T06:00:00.000Z", today)).toBeNull();
  });

  it("calcula el día operativo en hora de Lima", () => {
    expect(limaDayBounds(new Date("2026-08-18T12:00:00.000Z"))).toEqual({
      date: "2026-08-18",
      startIso: "2026-08-18T05:00:00.000Z",
      endIso: "2026-08-19T05:00:00.000Z",
    });
  });

  it("expone etiquetas operativas claras", () => {
    expect(paymentKindLabel("total")).toBe("Pago total");
    expect(paymentObservationLabel("info_incompleta")).toBe("Información incompleta");
  });
});
