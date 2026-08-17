import { describe, it, expect } from "vitest";
import {
  ordersTouchedBy,
  planRelinkByGuideCode,
  type RelinkOrder,
  type RelinkShipment,
} from "@/lib/aliclik-relink";

const order = (over: Partial<RelinkOrder> = {}): RelinkOrder => ({
  id: "junio",
  name: "#KP120351",
  store_id: "store-1",
  customer_phone: "51985169380",
  ...over,
});

const julio = order({ id: "julio", name: "#KP122767" });

const ship = (over: Partial<RelinkShipment> = {}): RelinkShipment => ({
  id: "s1",
  guide_code: "AUR5X122767",
  order_id: "junio",
  ...over,
});

describe("planRelinkByGuideCode", () => {
  it("devuelve la guía al pedido que su código nombra", () => {
    const plan = planRelinkByGuideCode([ship()], [order(), julio]);
    expect(plan.review).toEqual([]);
    expect(plan.relink).toEqual([
      {
        shipmentId: "s1",
        guideCode: "AUR5X122767",
        fromOrderId: "junio",
        fromOrderName: "#KP120351",
        toOrderId: "julio",
        toOrderName: "#KP122767",
        toStoreId: "store-1",
      },
    ]);
  });

  it("no toca la guía que ya cuelga de su pedido", () => {
    const plan = planRelinkByGuideCode([ship({ order_id: "julio" })], [order(), julio]);
    expect(plan.relink).toEqual([]);
    expect(plan.review).toEqual([]);
  });

  it("es idempotente: sobre el resultado ya aplicado no propone nada", () => {
    const first = planRelinkByGuideCode([ship()], [order(), julio]);
    const applied = [ship({ order_id: first.relink[0]!.toOrderId })];
    expect(planRelinkByGuideCode(applied, [order(), julio]).relink).toEqual([]);
  });

  it("ignora las familias de 7 y 12 dígitos, que no nombran ningún pedido", () => {
    // Medido en producción: ninguna de esas 2.853 guías termina en el nº de su
    // pedido. Leer un pedido ahí dentro sería leer ruido, y mudaría guías sanas.
    for (const code of ["AUR5X5086616", "AUR5X000340013716"]) {
      const plan = planRelinkByGuideCode([ship({ guide_code: code })], [order(), julio]);
      expect(plan.relink).toEqual([]);
      expect(plan.review).toEqual([]);
    }
  });
});

describe("planRelinkByGuideCode — se niega a adivinar", () => {
  it("manda a revisión si el pedido del código no existe", () => {
    const plan = planRelinkByGuideCode([ship()], [order()]);
    expect(plan.relink).toEqual([]);
    expect(plan.review[0]!.reason).toContain("no existe el pedido 122767");
  });

  it("manda a revisión si dos pedidos comparten ese número", () => {
    // Los prefijos son por tienda, así que #KP122767 y #AUR122767 conviven.
    const plan = planRelinkByGuideCode(
      [ship()],
      [order(), julio, order({ id: "otra-tienda", name: "#AUR122767", store_id: "store-2" })],
    );
    expect(plan.relink).toEqual([]);
    expect(plan.review[0]!.reason).toContain("2 pedidos");
  });

  it("manda a revisión si el dueño no comparte teléfono: no es este caso", () => {
    // Sin teléfono compartido no hay «mismo cliente con dos pedidos», y aplicar
    // aquí el arreglo sería usar la receta de un problema en otro distinto.
    const plan = planRelinkByGuideCode(
      [ship()],
      [order(), order({ id: "julio", name: "#KP122767", customer_phone: "51999888777" })],
    );
    expect(plan.relink).toEqual([]);
    expect(plan.review[0]!.reason).toContain("otro teléfono");
  });

  it("compara el teléfono normalizado, no el texto", () => {
    const plan = planRelinkByGuideCode(
      [ship()],
      [order({ customer_phone: "985169380" }), order({ id: "julio", name: "#KP122767", customer_phone: "+51 985 169 380" })],
    );
    expect(plan.relink).toHaveLength(1);
  });
});

describe("ordersTouchedBy", () => {
  it("devuelve los dos lados de cada mudanza, sin repetir", () => {
    const plan = planRelinkByGuideCode([ship()], [order(), julio]);
    expect(ordersTouchedBy(plan.relink).sort()).toEqual(["julio", "junio"]);
  });

  it("sin mudanzas no hay nada que recalcular", () => {
    expect(ordersTouchedBy([])).toEqual([]);
  });
});
