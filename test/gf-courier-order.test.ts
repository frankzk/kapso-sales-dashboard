import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    expect(buildGfOrderInput({ ...base, customerName: "   " })).toMatchObject({ ok: false, reason: expect.stringContaining("nombre") });
    // Solo nombre (#KP205891 «Mariela»): GF lo acepta sin apellido.
    const solo = buildGfOrderInput({ ...base, customerName: "Mariela" });
    expect(solo.ok && solo.input.recipient).toMatchObject({ first_name: "Mariela" });
    expect(solo.ok && "last_name" in solo.input.recipient).toBe(false);
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

describe("cobro de la guía GF", () => {
  it("un pedido pagado completo viaja con cobro cero", () => {
    const r = buildGfOrderInput({ ...base, advancePaid: 129 });
    expect(r.ok && r.input.payment).toEqual({ total: 129, advance_paid: 129, amount_to_collect: 0 });
  });
  it("descuenta adelanto, diferencia y total validados (como Aliclik) y no filtra por modalidad", () => {
    const src = readFileSync(join(process.cwd(), "lib/gf-courier-guide.ts"), "utf8");
    expect(src).toContain('.in("kind", [...CUSTOMER_PAYMENT_KINDS])');
    expect(src).not.toContain("shipping_mode !==");
    expect(readFileSync(join(process.cwd(), "app/dashboard/pedidos/gf-courier-actions.ts"), "utf8")).not.toContain("shipping_mode !==");
  });
});

describe("pagado en el checkout web: la guía sale sin cobro (17-11-2026, #KP206871)", () => {
  it("advance_paid = total y amount_to_collect = 0", () => {
    const r = buildGfOrderInput({ ...base, orderTotal: 134.1, advancePaid: 0, webPrepaid: true });
    expect(r.ok && r.input.payment).toEqual({ total: 134.1, advance_paid: 134.1, amount_to_collect: 0 });
  });
  it("los tres caminos que crean la guía leen el prepago web", () => {
    for (const f of ["lib/gf-courier-guide.ts", "lib/gf-auto-guide-server.ts", "lib/gf-courier-simulate-server.ts"])
      expect(readFileSync(join(process.cwd(), f), "utf8")).toContain("webPrepaid: isWebPrepaid(");
  });
});
