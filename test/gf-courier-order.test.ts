import { describe, expect, it } from "vitest";
import { allocateLines, buildGfOrderInput, splitName, type GfOrderSource } from "@/lib/gf-courier-order";
import { mapGfStatus } from "@/lib/gf-courier-status";

const sum = (items: { quantity: number; unit_price: number }[]) => Math.round(items.reduce((s, i) => s + i.unit_price * 100 * i.quantity, 0));
const base: GfOrderSource = { externalId: "#1001", customerName: "María Quispe Rojas", customerPhone: "987654321", district: "San Juan de Lurigancho",
  address: "Av. Próceres 1234", reference: "Frente al parque", latitude: -11.98, longitude: -77.01, orderTotal: 129, advancePaid: 30,
  lines: [{ sku: "FAJ-M", title: "Faja", quantity: 1, price: 149 }] };

describe("pedido Kapta → GF", () => {
  it("arma el cuerpo con nombre separado, gps, adelanto y monto a cobrar", () => {
    const r = buildGfOrderInput(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.recipient).toEqual({ first_name: "María", last_name: "Quispe Rojas", phone: "987654321" });
    expect(r.input.destination).toEqual({ district: "San Juan de Lurigancho", address: "Av. Próceres 1234", reference: "Frente al parque", gps: "-11.98,-77.01" });
    expect(r.input.payment).toEqual({ total: 129, advance_paid: 30, amount_to_collect: 99 });
    expect(sum(r.input.items)).toBe(12900);
  });
  it("prefiere el ubigeo del territorio cuando existe", () => {
    const r = buildGfOrderInput({ ...base, ubigeo: "150132" });
    expect(r.ok && r.input.destination.ubigeo).toBe("150132");
  });
  it("cuadra al céntimo aunque el importe no se divida entre las unidades", () => {
    const items = allocateLines([{ sku: "A", quantity: 3, price: 10 }, { sku: "B", quantity: 2, price: 7.5 }], 4999)!;
    expect(sum(items)).toBe(4999);
    expect(items.filter((i) => i.sku === "A").reduce((s, i) => s + i.quantity, 0)).toBe(3);
    expect(new Set(items.filter((i) => i.sku === "A").map((i) => i.unit_price)).size).toBeLessThanOrEqual(2);
  });
  it("no inventa datos: rechaza sin SKU, sin apellido, sin distrito o con adelanto mayor al total", () => {
    expect(buildGfOrderInput({ ...base, lines: [{ sku: null, quantity: 1, price: 10 }] })).toMatchObject({ ok: false });
    expect(buildGfOrderInput({ ...base, customerName: "María" })).toMatchObject({ ok: false, reason: expect.stringContaining("apellido") });
    expect(buildGfOrderInput({ ...base, district: null, ubigeo: null })).toMatchObject({ ok: false, reason: expect.stringContaining("distrito") });
    expect(buildGfOrderInput({ ...base, advancePaid: 200 })).toMatchObject({ ok: false });
    expect(splitName("  Ana   Pérez  ")).toEqual({ first_name: "Ana", last_name: "Pérez" });
  });
});

describe("estados GF → salida Kapta", () => {
  it("traduce la tabla sin inventar estados", () => {
    expect(mapGfStatus("CREATED")).toMatchObject({ deliveryStatus: "pendiente", terminal: false });
    expect(mapGfStatus("OUT_FOR_DELIVERY")).toMatchObject({ deliveryStatus: "en_ruta", custodyState: "courier" });
    expect(mapGfStatus("INCIDENT", "NO_ANSWER")).toMatchObject({ deliveryStatus: "en_ruta", operational: "intento_de_entrega", attemptFailed: true });
    expect(mapGfStatus("INCIDENT", "RESCHEDULE_REQUESTED")).toMatchObject({ operational: "reprogramado", attemptFailed: false });
    expect(mapGfStatus("REFUSED")).toMatchObject({ deliveryStatus: "en_ruta", terminal: false });
    expect(mapGfStatus("RETURNED")).toMatchObject({ deliveryStatus: "anulado", returned: true, terminal: true, custodyState: "devuelto" });
    expect(mapGfStatus("DELIVERED")).toMatchObject({ deliveryStatus: "entregado", terminal: true });
    expect(mapGfStatus("CANCELLED")).toMatchObject({ deliveryStatus: "anulado", returned: false, terminal: true });
    expect(mapGfStatus("LOST")).toMatchObject({ deliveryStatus: null, unknown: ["status=LOST"] });
  });
});
