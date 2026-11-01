// El reprogramado que el motorizado conserva, sin esperar su hoja (MOM §29.7,
// «El reprogramado que el motorizado conserva», 01-11-2026, pedido del owner).
//
// Antes solo pasaba a la ruta siguiente cuando la hoja del día siguiente lo
// nombraba: sin hoja (Alexis, del 21 al 31/10), quedaba «Por devolver» en la
// caja vieja aunque él lo tuviera. Ahora:
//   - Reparto y liquidación lo pasa con un clic al día que se elija, y lista
//     los que el motorizado conserva de rutas anteriores sin ruta nueva;
//   - en la app, «Me lo quedo y lo llevo mañana» lo pasa al reportarlo.
// El traspaso es `gf_carry_over` (0234, 0248), sin migración nueva.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeDb } from "./woocommerce-fake-db";
import { addDaysIso, carryKeptProblem, defaultCarryDate, isKeptReprogrammed } from "@/lib/gf-carry-kept";
import { carryKeptStop, limaTodayIso, loadKeptReprogrammed } from "@/lib/gf-carry-kept-server";

const read = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");

describe("las reglas", () => {
  it("el día: después de la ruta del reprogramado y hasta 7 días adelante; uno ya pasado vale", () => {
    expect(carryKeptProblem("2026-10-21", "2026-10-22", "2026-11-01")).toBeNull();
    expect(carryKeptProblem("2026-10-21", "2026-10-21", "2026-11-01")).toContain("después del 21/10");
    expect(carryKeptProblem("2026-10-21", "2026-11-09", "2026-11-01")).toContain("hasta el 08/11");
    expect(carryKeptProblem("2026-10-21", "mañana", "2026-11-01")).toBe("Elige el día de la ruta en que sale.");
  });

  it("propone el día siguiente a la ruta, o mañana si ese ya pasó", () => {
    expect(defaultCarryDate("2026-11-01", "2026-11-01")).toBe("2026-11-02");
    expect(defaultCarryDate("2026-10-21", "2026-11-01")).toBe("2026-11-02");
    expect(addDaysIso("2026-10-31", 1)).toBe("2026-11-01");
    expect(limaTodayIso(Date.parse("2026-11-02T03:00:00Z"))).toBe("2026-11-01");
  });

  it("solo un reprogramado que sigue en su caja, sin devolver ni pasar", () => {
    const base = { status: "no_entregado", outcome_reason: "reprogramado", dispatch_manifest_id: "m", shipment_id: "sh", manifest_item_id: "i" };
    expect(isKeptReprogrammed(base)).toBe(true);
    expect(isKeptReprogrammed({ ...base, outcome_reason: "no_contesta" })).toBe(false);
    expect(isKeptReprogrammed({ ...base, manifest_item_id: null })).toBe(false);
    expect(isKeptReprogrammed({ ...base, returned_at: "2026-10-22T10:00:00Z" })).toBe(false);
    expect(isKeptReprogrammed({ ...base, carried_to: "2026-10-22" })).toBe(false);
    expect(isKeptReprogrammed({ ...base, dispatch_manifest_id: null })).toBe(false);
  });
});

const NOW = Date.parse("2026-11-01T15:00:00Z");

function db(over: { stop?: Record<string, unknown>; item?: boolean } = {}) {
  return new FakeDb({
    delivery_stops: [{ id: "s1", status: "no_entregado", outcome_reason: "reprogramado", shipment_id: "sh1", dispatch_manifest_id: "m1", route_id: "r1", ...over.stop }],
    delivery_routes: [{ id: "r1", rider_id: "alexis", route_date: "2026-10-28" }],
    dispatch_manifest_items: over.item === false ? [] : [{ id: "i1", manifest_id: "m1", shipment_id: "sh1", removed_at: null }],
  });
}

describe("carryKeptStop", () => {
  it("llama a gf_carry_over con el motorizado de la ruta, el día y el paquete", async () => {
    const fake = db();
    const res = await carryKeptStop(fake.client(), { stopId: "s1", toDate: "2026-10-29", actor: "u1", now: NOW });
    expect(res).toEqual({ ok: true, toDate: "2026-10-29" });
    expect(fake.rpcCalls).toEqual([
      { name: "gf_carry_over", args: { p_rider_id: "alexis", p_to_date: "2026-10-29", p_shipment_ids: ["sh1"], p_actor: "u1" } },
    ]);
  });

  it("no llama a la base con otra cosa que un reprogramado que sigue en su caja", async () => {
    for (const [fake, error] of [
      [db({ stop: { outcome_reason: "no_contesta" } }), "Solo pasa a otra ruta un «No entregado · Reprogramado»."],
      [db({ stop: { dispatch_manifest_id: null } }), "Esta parada no salió en una caja de Grupo GF: no hay paquete que pasar."],
      [db({ item: false }), "El paquete ya no está en esa caja: volvió a la oficina o ya pasó a otra ruta."],
    ] as const) {
      const res = await carryKeptStop(fake.client(), { stopId: "s1", toDate: "2026-10-29", actor: "u1", now: NOW });
      expect(res).toEqual({ ok: false, error });
      expect(fake.rpcCalls).toEqual([]);
    }
    const fake = db();
    const res = await carryKeptStop(fake.client(), { stopId: "s1", toDate: "2026-10-28", actor: "u1", now: NOW });
    expect(res).toMatchObject({ ok: false });
    expect(fake.rpcCalls).toEqual([]);
  });
});

describe("loadKeptReprogrammed: lo que conserva sin ruta nueva", () => {
  it("los reprogramados que siguen en su caja, el más reciente por pedido, sin los que ya están en la ruta del día", async () => {
    const fake = new FakeDb({
      delivery_routes: [
        { id: "r26", rider_id: "alexis", route_date: "2026-10-26" },
        { id: "r27", rider_id: "alexis", route_date: "2026-10-27" },
        { id: "r28", rider_id: "alexis", route_date: "2026-10-28" },
      ],
      delivery_stops: [
        // Reprogramado el 26 y el 27: cuenta el del 27.
        { id: "a26", order_id: "oA", route_id: "r26", status: "no_entregado", outcome_reason: "reprogramado", shipment_id: "shA", dispatch_manifest_id: "m26" },
        { id: "a27", order_id: "oA", route_id: "r27", status: "no_entregado", outcome_reason: "reprogramado", shipment_id: "shA2", dispatch_manifest_id: "m27" },
        // Ya volvió a la oficina: su ítem no está activo.
        { id: "b27", order_id: "oB", route_id: "r27", status: "no_entregado", outcome_reason: "reprogramado", shipment_id: "shB", dispatch_manifest_id: "m27" },
        // Ya está en la ruta del 28.
        { id: "c27", order_id: "oC", route_id: "r27", status: "no_entregado", outcome_reason: "reprogramado", shipment_id: "shC", dispatch_manifest_id: "m27" },
        { id: "c28", order_id: "oC", route_id: "r28", status: "pendiente", outcome_reason: null, shipment_id: "shC", dispatch_manifest_id: "m28" },
        // No contesta: vuelve a la oficina, no es de esta lista.
        { id: "d27", order_id: "oD", route_id: "r27", status: "no_entregado", outcome_reason: "no_contesta", shipment_id: "shD", dispatch_manifest_id: "m27" },
      ],
      dispatch_manifest_items: [
        { manifest_id: "m26", shipment_id: "shA", removed_at: null },
        { manifest_id: "m27", shipment_id: "shA2", removed_at: null },
        { manifest_id: "m27", shipment_id: "shB", removed_at: "2026-10-28T10:00:00Z" },
        { manifest_id: "m27", shipment_id: "shC", removed_at: null },
        { manifest_id: "m27", shipment_id: "shD", removed_at: null },
      ],
      order_master: [{ order_id: "oA", order_name: "#KP200305", customer_name: "Carlos", district: "Ventanilla", order_total: 149 }],
      orders: [{ id: "oA", cancelled_at: null }],
    });
    const kept = await loadKeptReprogrammed(fake.client(), "alexis", "2026-10-28");
    expect(kept).toEqual([
      { stopId: "a27", orderId: "oA", orderName: "#KP200305", customerName: "Carlos", district: "Ventanilla", total: 149, fromDate: "2026-10-27", cancelled: false },
    ]);
  });
});

describe("dónde se usa", () => {
  it("Reparto y liquidación: el botón en la parada y la lista arriba, solo para quien arma rutas", () => {
    const routes = read("components/routes.tsx");
    expect(routes).toContain("Sale con él en otra ruta…");
    expect(routes).toContain("Pasar a esta ruta");
    expect(routes).toContain("canCarryKept={detailOnly}");
    const action = read("app/dashboard/rutas/actions.ts");
    expect(action).toContain("export async function carryKeptReprogrammed(stopId: string, toDate: string)");
    expect(read("app/dashboard/courier/actions.ts")).toContain("loadKeptReprogrammed(createAdminSupabase(), detail.route.rider_id, day)");
  });

  it("la app: «Me lo quedo y lo llevo mañana», y el reporte se guarda aunque el traspaso falle", () => {
    expect(read("components/rider-route.tsx")).toContain("Me lo quedo y lo llevo mañana");
    const action = read("app/reparto/actions.ts");
    const report = action.indexOf("const written = await writeStopReport(admin, {");
    const carry = action.indexOf("await carryKeptStop(admin, { stopId: input.stopId, toDate: input.keepForDate, actor: user.id })");
    expect(report).toBeGreaterThan(-1);
    expect(carry).toBeGreaterThan(report);
  });

  it("el MOM lo cuenta", () => {
    expect(read("docs/mom/master-pedidos-v1.md")).toContain("**El reprogramado que el motorizado conserva, sin su hoja (01-11-2026, pedido");
  });
});
