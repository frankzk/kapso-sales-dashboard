import { describe, expect, it } from "vitest";
import {
  canAdoptExistingGuide,
  planOrphanLinks,
  type MasterOrder,
  type OrphanShipment,
} from "@/lib/aliclik-orphans";

describe("canAdoptExistingGuide", () => {
  it("adopta una guía huérfana (sin pedido)", () => {
    expect(canAdoptExistingGuide({ order_id: null }, "o1")).toBe(true);
  });
  it("adopta si la guía ya es de este mismo pedido (reintento inocuo)", () => {
    expect(canAdoptExistingGuide({ order_id: "o1" }, "o1")).toBe(true);
  });
  it("NO adopta si la guía es de otro pedido", () => {
    expect(canAdoptExistingGuide({ order_id: "o2" }, "o1")).toBe(false);
  });
  it("NO adopta si no existe ninguna fila: hay que insertar", () => {
    expect(canAdoptExistingGuide(null, "o1")).toBe(false);
    expect(canAdoptExistingGuide(undefined, "o1")).toBe(false);
  });
});

const orphan = (id: string, order_name: string, store_id: string | null = "s-envio"): OrphanShipment => ({
  id,
  order_name,
  store_id,
});
const master = (
  order_id: string,
  order_name: string,
  store_id = "s-pedido",
  guide_code: string | null = null,
): MasterOrder => ({ order_id, order_name, store_id, guide_code });

describe("planOrphanLinks", () => {
  it("engancha una guía huérfana a su pedido y adopta la tienda del pedido", () => {
    const plan = planOrphanLinks(
      [orphan("g1", "#KP120399", "s-otra")],
      [master("o1", "#KP120399", "s-kenku")],
    );
    // La tienda sale del PEDIDO, no del envío: corrige el tag que dejó el import.
    expect(plan.link).toEqual([{ shipmentId: "g1", orderId: "o1", storeId: "s-kenku" }]);
    expect(plan.skipped).toEqual({ multiOrphan: 0, noOrder: 0, orderHasGuide: 0 });
  });

  it("NO engancha si el nombre tiene más de una guía huérfana (ambiguo)", () => {
    const plan = planOrphanLinks(
      [orphan("g1", "#KP1"), orphan("g2", "#KP1")],
      [master("o1", "#KP1")],
    );
    expect(plan.link).toHaveLength(0);
    expect(plan.skipped.multiOrphan).toBe(2);
  });

  it("NO engancha si el pedido no está en el Master", () => {
    const plan = planOrphanLinks([orphan("g1", "#KP2")], []);
    expect(plan.link).toHaveLength(0);
    expect(plan.skipped.noOrder).toBe(1);
  });

  it("NO engancha si el pedido ya tiene una guía", () => {
    const plan = planOrphanLinks(
      [orphan("g1", "#KP3")],
      [master("o1", "#KP3", "s-pedido", "AUR5X999")],
    );
    expect(plan.link).toHaveLength(0);
    expect(plan.skipped.orderHasGuide).toBe(1);
  });

  it("procesa un lote mixto contando cada motivo de descarte por separado", () => {
    const plan = planOrphanLinks(
      [
        orphan("ok", "#KP-OK"), // engancha
        orphan("dup1", "#KP-DUP"),
        orphan("dup2", "#KP-DUP"), // dos huérfanas: ambiguo
        orphan("sin", "#KP-SINPEDIDO"), // pedido no está
        orphan("cong", "#KP-CONGUIA"), // pedido ya con guía
      ],
      [
        master("o-ok", "#KP-OK"),
        master("o-dup", "#KP-DUP"),
        master("o-cong", "#KP-CONGUIA", "s-pedido", "AUR5X1"),
      ],
    );
    expect(plan.link).toEqual([{ shipmentId: "ok", orderId: "o-ok", storeId: "s-pedido" }]);
    expect(plan.skipped).toEqual({ multiOrphan: 2, noOrder: 1, orderHasGuide: 1 });
  });
});
