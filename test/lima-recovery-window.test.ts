import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { withRecoveryState } from "@/lib/shipments-access";
import type { ShipmentRow } from "@/lib/types";
import { LIMA_RECOVERY_DAYS, recoveryWindowDaysForOperation } from "@/lib/reproprovincia";

// Decisión del owner (03-11-2026, MOM §11): la ventana de 7 días de Kenku y
// Aurela es de Provincia. Lima tiene unas tres semanas: 21 días. Envíos decide
// con la misma ventana que el Master, leyendo de él solo la operación.

const DAY = 86_400_000;
const hace = (d: number) => new Date(Date.now() - d * DAY).toISOString();

function fakeSb(tables: Record<string, Record<string, unknown>[]>) {
  const from = (table: string) => {
    const filters: ((r: Record<string, unknown>) => boolean)[] = [];
    const q: Record<string, unknown> = {};
    Object.assign(q, {
      select: () => q,
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
      in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return q; },
      not: (k: string, _op: string, _v: unknown) => { filters.push((r) => r[k] != null); return q; },
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null }).then(resolve),
    });
    return q;
  };
  return { from } as never;
}

const guia = (orderId: string, closedDaysAgo: number) => ({
  id: `g-${orderId}`,
  order_id: orderId,
  store_id: "kenku",
  courier: "aliclik",
  delivery_status: "anulado",
  status_category: "closed",
  reported_status: "NOT_RESPOND · RETURNED · ",
  swayp_state: null,
  dispatched_at: hace(closedDaysAgo + 1),
  closed_at: hace(closedDaysAgo),
  returned_at: null,
  updated_at: hace(closedDaysAgo),
});

describe("la ventana de Lima es de 21 días; la de Provincia, la de la tienda", () => {
  it("la función elige por operación", () => {
    expect(LIMA_RECOVERY_DAYS).toBe(21);
    expect(recoveryWindowDaysForOperation("lima", 7)).toBe(21);
    expect(recoveryWindowDaysForOperation("provincia_cod", 7)).toBe(7);
    // Sin operación conocida, la de la tienda: nada se alarga sin saber que es Lima.
    expect(recoveryWindowDaysForOperation("", 7)).toBe(7);
  });

  it("Envíos: un intento fallido de hace 10 días sigue activo en Lima y vence en Provincia", async () => {
    const shipments = [guia("lima10", 10), guia("prov10", 10), guia("lima25", 25)];
    const sb = fakeSb({
      shipments,
      order_events: [],
      orders: [],
      shipment_calls: [],
      stores: [{ id: "kenku", return_recovery_max_days: 7 }],
      order_master: [
        { order_id: "lima10", macro_operation: "lima" },
        { order_id: "prov10", macro_operation: "provincia_cod" },
        { order_id: "lima25", macro_operation: "lima" },
      ],
    });
    const out = await withRecoveryState(sb, shipments as unknown as ShipmentRow[]);
    const byOrder = new Map(out.map((r) => [r.order_id, r.recovery]));
    expect(byOrder.get("lima10")).toBe("activa");
    expect(byOrder.get("prov10")).not.toBe("activa");
    expect(byOrder.get("lima25")).not.toBe("activa");
  });

  it("y el MOM lo dice", () => {
    const mom = readFileSync("docs/mom/master-pedidos-v1.md", "utf8").replace(/\s+/g, " ");
    expect(mom).toContain("**Lima tiene su ventana: 21 días (decisión del owner, 03-11-2026).**");
    expect(mom).toContain("(`LIMA_RECOVERY_DAYS`, `recoveryWindowDaysForOperation`, `lib/reproprovincia.ts`)");
  });
});
