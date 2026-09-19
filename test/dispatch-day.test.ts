// Despacho del día (MOM §29.13): lo puro de la pantalla de dos pasos.
import { describe, expect, it } from "vitest";
import { boxNextStep, dayBoxes, declinedPackages, splitAssignment, type DayManifest } from "@/lib/dispatch-day";

const item = (over: Partial<DayManifest["items"][number]> = {}) => ({
  id: over.id ?? crypto.randomUUID(),
  shipment_id: over.shipment_id ?? "s1",
  removed_at: null,
  office_checked_at: null,
  pickup_checked_at: null,
  pickup_declined_at: null,
  pickup_declined_reason: null,
  shipment: { order_id: "o1", order_name: "#KP1", customer_name: "Ana", district: "Surco", output_code: "KP1-S01", guide_code: "g" },
  ...over,
});

const manifest = (over: Partial<DayManifest> = {}): DayManifest => ({
  id: over.id ?? "m1",
  courier: "propio",
  route_date: "2026-09-19",
  state: "office_check",
  rider_id: "roy",
  driver_name: "Roy",
  load_number: 1,
  items: [],
  ...over,
});

describe("dayBoxes", () => {
  it("agrupa por motorizado solo las cajas propias del día, y suma cargas", () => {
    const boxes = dayBoxes(
      [
        manifest({ id: "a", items: [item({ office_checked_at: "x" }), item({ shipment_id: "s2" })] }),
        manifest({ id: "b", load_number: 2, state: "draft", items: [item({ shipment_id: "s3" })] }),
        manifest({ id: "c", rider_id: "yhoni", driver_name: "Yhoni", items: [item({ shipment_id: "s4", pickup_declined_at: "x", pickup_declined_reason: "dañado", removed_at: "x", removal_reason: "No recogido" })] }),
        manifest({ id: "d", route_date: "2026-09-18", items: [item({ shipment_id: "s5" })] }),
        manifest({ id: "e", courier: "aliclik", items: [item({ shipment_id: "s6" })] }),
        manifest({ id: "f", state: "cancelled", items: [item({ shipment_id: "s7" })] }),
      ],
      "2026-09-19",
    );
    expect(boxes.map((b) => b.riderName)).toEqual(["Roy", "Yhoni"]);
    const roy = boxes[0]!;
    expect(roy).toMatchObject({ assigned: 3, officeChecked: 1, pickupChecked: 0, declined: 0 });
    // La carga más reciente es la que se trabaja.
    expect(roy.loads[0]!.id).toBe("b");
    expect(roy.state).toBe("draft");
    const yhoni = boxes[1]!;
    // Un rechazado del motorizado sale de la carga (removed) pero se cuenta aparte.
    expect(yhoni).toMatchObject({ assigned: 0, declined: 1 });
  });
});

describe("declinedPackages", () => {
  it("lista lo que cada motorizado no recogió, con motivo y pedido", () => {
    const boxes = dayBoxes(
      [manifest({ items: [item({ pickup_declined_at: "x", pickup_declined_reason: "no estaba en la caja", removed_at: "x", removal_reason: "r" }), item({ shipment_id: "s2" })] })],
      "2026-09-19",
    );
    expect(declinedPackages(boxes)).toEqual([
      expect.objectContaining({ riderName: "Roy", reason: "no estaba en la caja", orderName: "#KP1", shipmentId: "s1", manifestId: "m1" }),
    ]);
  });
});

describe("splitAssignment", () => {
  it("separa disponibles (tomar+asignar) de tomados sin ruta (solo asignar)", () => {
    const split = splitAssignment(
      new Set(["o1", "o2", "o3", "o4"]),
      [{ orderId: "o1" }, { orderId: "o4" }],
      [
        { orderId: "o2", requestId: "r2", route: null, shipmentId: "s2" },
        { orderId: "o3", requestId: "r3", route: { manifestId: "m" }, shipmentId: "s3" },
        { orderId: "o4", requestId: "r4", route: null, shipmentId: null },
      ],
    );
    // o3 ya tiene caja y o4 tomado sin salida física: ninguno se asigna; o4 cae a «tomar» porque sigue disponible.
    expect(split).toEqual({ orderIds: ["o1", "o4"], requestIds: ["r2"] });
  });
});

describe("boxNextStep", () => {
  it("dice qué falta para que el motorizado salga", () => {
    expect(boxNextStep({ assigned: 0, officeChecked: 0, pickupChecked: 0, state: "draft" })).toBe("Sin paquetes");
    expect(boxNextStep({ assigned: 5, officeChecked: 2, pickupChecked: 0, state: "office_check" })).toBe("Cotejar 3 en oficina");
    expect(boxNextStep({ assigned: 5, officeChecked: 5, pickupChecked: 1, state: "pickup_check" })).toBe("Esperando que el motorizado reciba 4");
    expect(boxNextStep({ assigned: 5, officeChecked: 5, pickupChecked: 5, state: "in_custody" })).toBe("En poder del motorizado");
  });
});
