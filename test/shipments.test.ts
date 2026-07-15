import { describe, it, expect } from "vitest";
import {
  DELIVERY_STATUSES,
  categoryOf,
  isCallable,
  isTerminal,
  isValidStatus,
  isPending,
  attemptLabel,
  hasShipmentContact,
  isFutureShipmentFollowup,
  isShipmentFollowupDue,
  isShipmentReadyForContact,
  normalizeCity,
  isFenixCity,
  isFenixDistrict,
  nextShipmentTransition,
  MAX_INTENTOS,
  FENIX_CITIES,
  reconcileDeliveryStatus,
  autoFenixGuideCode,
  rescheduleGuideCode,
  statusSince,
} from "@/lib/shipments";

describe("delivery status model", () => {
  it("has the five global states with consistent categories", () => {
    const codes = DELIVERY_STATUSES.map((s) => s.code);
    expect(new Set(codes)).toEqual(
      new Set(["pendiente", "en_ruta", "entregado", "anulado", "transferido"]),
    );
    expect(categoryOf("pendiente")).toBe("pending");
    expect(categoryOf("en_ruta")).toBe("in_route");
    expect(categoryOf("entregado")).toBe("delivered");
    expect(categoryOf("anulado")).toBe("closed");
    expect(categoryOf("transferido")).toBe("transferred");
  });

  it("flags callable/terminal/pending states", () => {
    expect(isCallable("pendiente")).toBe(true);
    expect(isCallable("en_ruta")).toBe(true);
    expect(isCallable("entregado")).toBe(false);
    expect(isCallable("transferido")).toBe(false);
    expect(isTerminal("entregado")).toBe(true);
    expect(isTerminal("anulado")).toBe(true);
    expect(isTerminal("transferido")).toBe(true);
    expect(isTerminal("pendiente")).toBe(false);
    expect(isPending("pendiente")).toBe(true);
    expect(isPending("en_ruta")).toBe(false);
    expect(isValidStatus("nope")).toBe(false);
  });

  it("labels the pending sub-state from the intento counter", () => {
    expect(attemptLabel(0)).toBe("Ingestión");
    expect(attemptLabel(null)).toBe("Ingestión");
    expect(attemptLabel(3)).toBe("Intento 3");
    expect(attemptLabel(7)).toBe("Intento 7");
    expect(attemptLabel(99)).toBe("Intento 7"); // clamped to MAX_INTENTOS
  });

  it("distinguishes guides with a logged call", () => {
    expect(hasShipmentContact(null)).toBe(false);
    expect(hasShipmentContact(0)).toBe(false);
    expect(hasShipmentContact(1)).toBe(true);
    expect(hasShipmentContact(7)).toBe(true);
  });

  it("returns contacted guides to the queue when their programmed date is due", () => {
    const now = new Date("2026-07-21T15:00:00.000Z"); // July 21 in Lima
    expect(isShipmentReadyForContact(0, null, now)).toBe(true);
    expect(isShipmentReadyForContact(1, "2026-07-22T00:00:00.000Z", now)).toBe(false);
    expect(isShipmentReadyForContact(1, "2026-07-21T00:00:00.000Z", now)).toBe(true);
    expect(isShipmentReadyForContact(1, "2026-07-20T00:00:00.000Z", now)).toBe(true);
  });

  it("compares programmed dates as Lima calendar days", () => {
    // At 8 p.m. Lima it is already July 21 in UTC, but a July 21 follow-up is
    // still due today and July 22 is still future.
    const evening = new Date("2026-07-22T01:00:00.000Z");
    expect(isShipmentFollowupDue("2026-07-21T00:00:00.000Z", evening)).toBe(true);
    expect(isFutureShipmentFollowup("2026-07-22T00:00:00.000Z", evening)).toBe(true);
    expect(isFutureShipmentFollowup("2026-07-21T00:00:00.000Z", evening)).toBe(false);
    expect(isFutureShipmentFollowup("not-a-date", evening)).toBe(false);
  });
});

describe("normalizeCity", () => {
  it("collapses Juliaca/Puno and strips accents/casing", () => {
    expect(normalizeCity("Cusco")).toBe("cusco");
    expect(normalizeCity("CUSCO ")).toBe("cusco");
    expect(normalizeCity("Juliaca/Puno")).toBe("juliaca");
    expect(normalizeCity("Juliaca - Puno")).toBe("juliaca");
    expect(normalizeCity("Puno")).toBe("puno");
  });
  it("knows the Fenix coverage set", () => {
    for (const c of FENIX_CITIES) expect(isFenixCity(c)).toBe(true);
    expect(isFenixCity("Lima")).toBe(false);
    expect(isFenixCity(null)).toBe(false);
  });
  it("matches Fenix-served districts tolerantly (accents, (cercado), longer names)", () => {
    expect(isFenixDistrict("Cerro Colorado")).toBe(true);
    expect(isFenixDistrict("San Sebastián")).toBe(true); // accents
    expect(isFenixDistrict("Arequipa (Cercado)")).toBe(true); // (cercado) → bare form
    expect(isFenixDistrict("Jose Luis Bustamante")).toBe(true); // shorter than "… y Rivero"
    expect(isFenixDistrict("Miraflores")).toBe(false); // Lima district, not served
    expect(isFenixDistrict(null)).toBe(false);
  });
});

describe("nextShipmentTransition (gestión flow)", () => {
  it("pending: no_contesta advances the intento", () => {
    const r = nextShipmentTransition("pendiente", "no_contesta", 2);
    expect(r.status).toBe("pendiente");
    expect(r.attempts).toBe(3);
    expect(r.closed).toBe(false);
  });
  it("pending: failing past intento 7 gives up → anulado", () => {
    const r = nextShipmentTransition("pendiente", "no_contesta", MAX_INTENTOS);
    expect(r.status).toBe("anulado");
    expect(r.closed).toBe(true);
  });
  it("pending: confirma → en_ruta keeping the intento", () => {
    const r = nextShipmentTransition("pendiente", "confirma", 4);
    expect(r.status).toBe("en_ruta");
    expect(r.attempts).toBe(4);
    expect(r.closed).toBe(false);
  });
  it("programar keeps the current state and intento", () => {
    expect(nextShipmentTransition("pendiente", "programar", 2)).toEqual({
      status: "pendiente",
      attempts: 2,
      deliveredSource: null,
      closed: false,
    });
    expect(nextShipmentTransition("en_ruta", "programar", 4)).toEqual({
      status: "en_ruta",
      attempts: 4,
      deliveredSource: null,
      closed: false,
    });
  });
  it("pending: cancela → anulado", () => {
    expect(nextShipmentTransition("pendiente", "cancela", 1).status).toBe("anulado");
  });
  it("en_ruta: entregado → entregado por Fenix", () => {
    const r = nextShipmentTransition("en_ruta", "entregado", 3);
    expect(r.status).toBe("entregado");
    expect(r.deliveredSource).toBe("fenix");
    expect(r.closed).toBe(true);
  });
  it("en_ruta: no_contesta returns to pending at the SAME intento", () => {
    const r = nextShipmentTransition("en_ruta", "no_contesta", 2);
    expect(r.status).toBe("pendiente");
    expect(r.attempts).toBe(2); // does not increment
    expect(r.closed).toBe(false);
  });
  it("en_ruta: cancela → anulado", () => {
    expect(nextShipmentTransition("en_ruta", "cancela", 5).status).toBe("anulado");
  });
});

describe("reconcileDeliveryStatus (re-import merge)", () => {
  it("keeps En ruta when the report still says pendiente", () => {
    expect(reconcileDeliveryStatus("en_ruta", "pendiente")).toBe("en_ruta");
  });
  it("adopts a fresh ENTREGADO to close the guide", () => {
    expect(reconcileDeliveryStatus("pendiente", "entregado")).toBe("entregado");
    expect(reconcileDeliveryStatus("en_ruta", "entregado")).toBe("entregado");
  });
  it("never reopens a terminal state", () => {
    expect(reconcileDeliveryStatus("entregado", "pendiente")).toBe("entregado");
    expect(reconcileDeliveryStatus("anulado", "pendiente")).toBe("anulado");
    expect(reconcileDeliveryStatus("entregado", "entregado")).toBe("entregado");
  });
  it("never reverts a transferido guide (highest precedence)", () => {
    expect(reconcileDeliveryStatus("transferido", "entregado")).toBe("transferido");
    expect(reconcileDeliveryStatus("transferido", "pendiente")).toBe("transferido");
  });
  it("keeps pendiente idempotent on re-import (attempts preserved elsewhere)", () => {
    expect(reconcileDeliveryStatus("pendiente", "pendiente")).toBe("pendiente");
  });
  it("takes the incoming status for a brand-new guide (no existing)", () => {
    expect(reconcileDeliveryStatus(null, "pendiente")).toBe("pendiente");
    expect(reconcileDeliveryStatus(undefined, "entregado")).toBe("entregado");
  });
});

describe("autoFenixGuideCode", () => {
  it("appends today's DDMMYYYY to the order name", () => {
    expect(autoFenixGuideCode("#KP118847", new Date(2026, 6, 1))).toBe("#KP11884701072026");
  });
  it("pads single-digit day/month", () => {
    expect(autoFenixGuideCode("#AUR173123", new Date(2026, 0, 5))).toBe("#AUR17312305012026");
  });
  it("returns empty string when there's no order name", () => {
    expect(autoFenixGuideCode(null)).toBe("");
    expect(autoFenixGuideCode(undefined)).toBe("");
    expect(autoFenixGuideCode("  ")).toBe("");
  });
});

describe("rescheduleGuideCode (unique Fenix guide per confirmed reprogramación)", () => {
  it("stamps the operator-picked reprogramación date (UTC calendar day) onto the code", () => {
    // <input type=date> "2026-07-10" → client encodes it as UTC midnight
    const iso = "2026-07-10T00:00:00.000Z";
    expect(rescheduleGuideCode("#KP118847", iso)).toBe("#KP11884710072026");
  });

  it("reads the UTC day even when the ISO carries a time component", () => {
    expect(rescheduleGuideCode("#AUR173123", "2026-01-05T09:30:00.000Z")).toBe("#AUR17312305012026");
  });

  it("produces a DIFFERENT code for a different reprogramación date (so Fenix accepts it)", () => {
    const a = rescheduleGuideCode("#KP118847", "2026-07-10T00:00:00.000Z");
    const b = rescheduleGuideCode("#KP118847", "2026-07-15T00:00:00.000Z");
    expect(a).not.toBe(b);
    expect(b).toBe("#KP11884715072026");
  });

  it("falls back to `now` when no reprogramación date was picked", () => {
    expect(rescheduleGuideCode("#KP118847", null, new Date(2026, 6, 1))).toBe("#KP11884701072026");
    expect(rescheduleGuideCode("#KP118847", "", new Date(2026, 0, 5))).toBe("#KP11884705012026");
  });

  it("falls back to `now` when the reprogramación date is unparseable", () => {
    expect(rescheduleGuideCode("#KP118847", "not-a-date", new Date(2026, 6, 1))).toBe("#KP11884701072026");
  });

  it("returns empty string when there's no order name (caller keeps the manual path)", () => {
    expect(rescheduleGuideCode(null, "2026-07-10T00:00:00.000Z")).toBe("");
    expect(rescheduleGuideCode("  ", "2026-07-10T00:00:00.000Z")).toBe("");
  });
});

describe("statusSince (when the shipment entered its current status)", () => {
  it("returns the occurred_at of the most recent transition INTO the status", () => {
    const calls = [
      { new_status: "pendiente", occurred_at: "2026-07-01T10:00:00Z" },
      { new_status: "en_ruta", occurred_at: "2026-07-03T15:20:00Z" }, // dispatched
      { new_status: null, occurred_at: "2026-07-04T09:00:00Z", note: "nota" } as any,
    ];
    expect(statusSince(calls, "en_ruta")).toBe("2026-07-03T15:20:00Z");
    expect(statusSince(calls, "pendiente")).toBe("2026-07-01T10:00:00Z");
  });

  it("picks the LATEST when a status was entered more than once (re-route back to en_ruta)", () => {
    const calls = [
      { new_status: "en_ruta", occurred_at: "2026-07-02T10:00:00Z" },
      { new_status: "pendiente", occurred_at: "2026-07-03T10:00:00Z" },
      { new_status: "en_ruta", occurred_at: "2026-07-05T12:00:00Z" }, // most recent → wins
    ];
    expect(statusSince(calls, "en_ruta")).toBe("2026-07-05T12:00:00Z");
  });

  it("returns null when the status was never recorded, or calls lack a timestamp", () => {
    expect(statusSince([], "en_ruta")).toBeNull();
    expect(statusSince([{ new_status: "pendiente", occurred_at: "2026-07-01T10:00:00Z" }], "en_ruta")).toBeNull();
    expect(statusSince([{ new_status: "en_ruta" }], "en_ruta")).toBeNull(); // no occurred_at
  });
});
