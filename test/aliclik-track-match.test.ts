import { describe, expect, it } from "vitest";
import { applyAliclikSnapshot } from "@/lib/aliclik-track";

// Cómo encuentra `applyAliclikSnapshot` la guía a la que aplicar un estado.
//
// Importa porque hasta ahora buscaba SOLO por `external_order_number`, que solo
// tienen las guías que creamos nosotros por API (550 de 3.818). Las que entran
// por el Excel no lo tienen, así que el barrido las descartaba como
// `unknown_order` y su estado dependía de que alguien subiera un archivo.

interface Row {
  id: string;
  store_id: string;
  order_id: string | null;
  courier: string;
  guide_code: string | null;
  external_order_number: string | null;
  delivery_status: string;
  last_report_at: string | null;
  preparation_state: string | null;
  custody_state: string | null;
  ready_at: string | null;
  custody_transferred_at: string | null;
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: "ship-1",
    store_id: "store-1",
    order_id: null, // sin pedido: evita el recálculo del Master en el test
    courier: "aliclik",
    guide_code: "AUR5X000768785036",
    external_order_number: null,
    delivery_status: "pendiente",
    last_report_at: null,
    preparation_state: null,
    custody_state: null,
    ready_at: null,
    custody_transferred_at: null,
    ...over,
  };
}

/** Doble mínimo de PostgREST: filtra por los `.eq()` acumulados. */
function fakeAdmin(rows: Row[]) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const admin = {
    from() {
      const filters: Record<string, unknown> = {};
      let patch: Record<string, unknown> | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          patch = p;
          return chain;
        },
        eq: (col: string, val: unknown) => {
          if (patch && col === "id") {
            updates.push({ id: String(val), patch });
            return Promise.resolve({ error: null });
          }
          filters[col] = val;
          return chain;
        },
        limit: () => chain,
        maybeSingle: async () => ({
          data:
            rows.find((r) =>
              Object.entries(filters).every(
                ([k, v]) => (r as unknown as Record<string, unknown>)[k] === v,
              ),
            ) ?? null,
          error: null,
        }),
      };
      return chain;
    },
  };
  return { admin: admin as never, updates };
}

const snapshot = (orderNumber: string) => ({
  orderNumber,
  status: "DELIVERED",
  callStatus: "CONFIRMED",
  dispatchStatus: "PICKED",
  updatedAt: "2026-08-07T12:00:00.000Z",
});

describe("applyAliclikSnapshot — cómo encuentra la guía", () => {
  it("la encuentra por external_order_number (guía creada por API)", async () => {
    const { admin, updates } = fakeAdmin([
      row({ external_order_number: "AUR5X000768785036" }),
    ]);
    const res = await applyAliclikSnapshot(snapshot("AUR5X000768785036") as never, admin);
    expect(res.outcome).toBe("applied");
    expect(updates[0]?.patch.delivery_status).toBe("entregado");
  });

  it("la encuentra por guide_code cuando el Excel la creó sin external_order_number", async () => {
    const { admin, updates } = fakeAdmin([row({ external_order_number: null })]);
    const res = await applyAliclikSnapshot(snapshot("AUR5X000768785036") as never, admin);
    expect(res.outcome).toBe("applied");
    expect(updates[0]?.patch.delivery_status).toBe("entregado");
  });

  it("graba el identificador al encontrarla por guide_code, para no re-deducirlo", async () => {
    const { admin, updates } = fakeAdmin([row({ external_order_number: null })]);
    await applyAliclikSnapshot(snapshot("AUR5X000768785036") as never, admin);
    expect(updates[0]?.patch.external_order_number).toBe("AUR5X000768785036");
  });

  it("no pisa un external_order_number ya grabado", async () => {
    const { admin, updates } = fakeAdmin([
      row({ external_order_number: "AUR5X000768785036" }),
    ]);
    await applyAliclikSnapshot(snapshot("AUR5X000768785036") as never, admin);
    expect(updates[0]?.patch).not.toHaveProperty("external_order_number");
  });

  it("no toca una guía de otro courier aunque el código coincida", async () => {
    const { admin, updates } = fakeAdmin([
      row({ courier: "fenix", external_order_number: null }),
    ]);
    const res = await applyAliclikSnapshot(snapshot("AUR5X000768785036") as never, admin);
    expect(res.outcome).toBe("unknown_order");
    expect(updates).toHaveLength(0);
  });

  it("sigue reportando unknown_order cuando no hay ninguna guía", async () => {
    const { admin } = fakeAdmin([]);
    const res = await applyAliclikSnapshot(snapshot("AUR5X999999999999") as never, admin);
    expect(res.outcome).toBe("unknown_order");
  });
});
