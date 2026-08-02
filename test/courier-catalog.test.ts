import { describe, expect, it } from "vitest";
import {
  courierLabelFor,
  courierOptionByKey,
  ridersForCourier,
} from "@/lib/couriers/catalog";

const riders = [
  { id: "1", full_name: "Johnny", courier: null },
  { id: "2", full_name: "Roy", courier: "  " },
  { id: "3", full_name: "Ana", courier: "Aliclik" },
  { id: "4", full_name: "Beto", courier: "Swayp" },
  { id: "5", full_name: "Caro", courier: "Axel" },
];

describe("ridersForCourier", () => {
  it("propios = fichas sin transportadora", () => {
    const propios = ridersForCourier(riders, courierOptionByKey("propios"));
    expect(propios.map((r) => r.full_name).sort()).toEqual(["Johnny", "Roy"]);
  });
  it("empareja por transportadora sin distinguir formato", () => {
    expect(ridersForCourier(riders, courierOptionByKey("aliclik")).map((r) => r.full_name)).toEqual(["Ana"]);
    expect(ridersForCourier(riders, courierOptionByKey("swayp")).map((r) => r.full_name)).toEqual(["Beto"]);
    expect(ridersForCourier(riders, courierOptionByKey("axel")).map((r) => r.full_name)).toEqual(["Caro"]);
  });
  it("no incluye motorizados de otro courier", () => {
    expect(ridersForCourier(riders, courierOptionByKey("tanders"))).toEqual([]);
  });
  it("sin courier elegido → lista vacía", () => {
    expect(ridersForCourier(riders, null)).toEqual([]);
  });
});

describe("catálogo de couriers", () => {
  it("Swayp se guarda como token fenix pero se muestra como Swayp", () => {
    const swayp = courierOptionByKey("swayp")!;
    expect(swayp.value).toBe("fenix");
    expect(courierLabelFor("fenix")).toBe(swayp.label);
  });
  it("courierLabelFor cae al valor crudo fuera del catálogo", () => {
    expect(courierLabelFor("otro")).toBe("otro");
    expect(courierLabelFor(null)).toBe("—");
  });
});
