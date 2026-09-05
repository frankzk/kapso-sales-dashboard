import { describe, expect, it } from "vitest";
import {
  courierLabelFor,
  courierOptionByKey,
  isGroupGfRiderCourier,
  ridersForCourier,
  routeChoiceByValue,
  routeChoices,
} from "@/lib/couriers/catalog";

const riders = [
  { id: "1", full_name: "Johnny", courier: null },
  { id: "2", full_name: "Roy", courier: "  " },
  { id: "3", full_name: "Ana", courier: "Aliclik" },
  { id: "4", full_name: "Beto", courier: "Swayp" },
  { id: "5", full_name: "Caro", courier: "Axel" },
  { id: "6", full_name: "Daysi", courier: "Grupo GF Courier" },
];

describe("ridersForCourier", () => {
  it("Grupo GF = fichas históricas sin transportadora y afiliación formal", () => {
    const propios = ridersForCourier(riders, courierOptionByKey("propios"));
    expect(propios.map((r) => r.full_name).sort()).toEqual(["Daysi", "Johnny", "Roy"]);
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

describe("routeChoices (el desplegable único de «Nueva ruta»)", () => {
  it("los motorizados propios van por nombre, y guardan courier propio", () => {
    const { own } = routeChoices(riders);
    expect(own.map((c) => c.label).sort()).toEqual(["Daysi", "Johnny", "Roy"]);
    for (const choice of own) {
      expect(choice.courier).toBe("propio");
      expect(choice.riderId).toBeTruthy();
    }
  });

  it("los couriers van sin motorizado: la ruta ES el courier", () => {
    const { couriers } = routeChoices(riders);
    expect(couriers.every((c) => c.riderId === null)).toBe(true);
    // «Motorizados propios» ya no aparece como courier suelto: sus rutas se
    // eligen por el nombre de la persona.
    expect(couriers.map((c) => c.label)).not.toContain("Motorizados propios");
    expect(couriers.find((c) => c.label.startsWith("Swayp"))?.courier).toBe("fenix");
  });

  it("los motorizados de un courier externo NO son opciones sueltas", () => {
    // Ana (Aliclik) o Caro (Axel) no abren una ruta propia: la ruta es del
    // courier, y quién conduce no se conoce ni hace falta.
    const { own, couriers } = routeChoices(riders);
    const labels = [...own, ...couriers].map((c) => c.label);
    expect(labels).not.toContain("Ana");
    expect(labels).not.toContain("Caro");
  });

  it("sin fichas propias registradas el grupo no queda vacío", () => {
    const { own } = routeChoices([{ id: "9", full_name: "Ana", courier: "Aliclik" }]);
    expect(own).toHaveLength(1);
    expect(own[0]!.riderId).toBeNull();
    expect(own[0]!.courier).toBe("propio");
  });

  it("routeChoiceByValue devuelve exactamente lo elegido", () => {
    expect(routeChoiceByValue(riders, "rider:2")).toMatchObject({ label: "Roy", riderId: "2", courier: "propio" });
    expect(routeChoiceByValue(riders, "courier:aliclik")).toMatchObject({ courier: "aliclik", riderId: null });
    expect(routeChoiceByValue(riders, "no-existe")).toBeNull();
  });
});

describe("catálogo de couriers", () => {
  it("reconoce la afiliación formal sin perder alias históricos", () => {
    expect(isGroupGfRiderCourier("Grupo GF Courier")).toBe(true);
    expect(isGroupGfRiderCourier("motorizado propio")).toBe(true);
    expect(isGroupGfRiderCourier(null)).toBe(true);
    expect(isGroupGfRiderCourier("Aliclik")).toBe(false);
  });
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
