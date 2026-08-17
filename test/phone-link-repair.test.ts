import { describe, expect, it } from "vitest";
import {
  derivedOrderName,
  planPhoneLinkRepairs,
  type PhoneLinkedGuide,
} from "@/lib/phone-link-repair";

// UN VÍNCULO POR TELÉFONO CADUCA.
//
// `matchShipment` vincula por teléfono cuando hay UN solo pedido con ese número.
// Es cierto en el instante en que corre, y deja de serlo cuando llega el pedido
// bueno: AUR5X121336 entró el 10-07, cuando #KP121336 (creado el 06-07) aún no
// estaba importado, y se colgó del pedido anterior del mismo cliente —anulado
// desde junio—. Así se juntaron 15 guías en pedidos ajenos y 15 pedidos
// legítimos sin ninguna.
//
// La evidencia que faltaba venía escrita en el código de la guía.

describe("derivedOrderName — el pedido que nombra la guía", () => {
  it("saca el número del código con el prefijo de la tienda", () => {
    expect(derivedOrderName("AUR5X121336", "KP")).toBe("#KP121336");
    expect(derivedOrderName("AUR5X174316", "AUR")).toBe("#AUR174316");
  });

  it("tolera el prefijo escrito con # o en minúscula", () => {
    expect(derivedOrderName("aur5x121336", "#kp")).toBe("#KP121336");
  });

  it("no adivina sin prefijo de tienda", () => {
    // Ponerle el prefijo de otra tienda convertiría «no sé de quién es» en «es
    // de aquella», que es peor que no responder.
    expect(derivedOrderName("AUR5X121336", null)).toBeNull();
    expect(derivedOrderName("AUR5X121336", "  ")).toBeNull();
  });

  it("ignora códigos que no siguen la numeración de Aliclik", () => {
    expect(derivedOrderName("ALC000123", "KP")).toBeNull();
    expect(derivedOrderName("AUR5X12AB34", "KP")).toBeNull();
    expect(derivedOrderName(null, "KP")).toBeNull();
    // Las familias de 7 y 12 dígitos son identificadores de Aliclik, no pedidos:
    // quien lo decide es `orderRefInGuideCode`, y acá se comprueba que este
    // barrido hereda esa misma lectura en vez de tener la suya.
    expect(derivedOrderName("AUR5X5086616", "KP")).toBeNull();
    expect(derivedOrderName("AUR5X000340013716", "KP")).toBeNull();
  });
});

const TIENDA = "store-kenku";

function guia(over: Partial<PhoneLinkedGuide> = {}): PhoneLinkedGuide {
  return {
    id: "guia-1",
    guide_code: "AUR5X121336",
    store_id: TIENDA,
    order_id: "pedido-viejo",
    customer_phone: "51972971210",
    derived_order_name: "#KP121336",
    ...over,
  };
}

const pedido = (
  id: string,
  name: string,
  phone: string | null,
  guide_count = 0,
  store_id = TIENDA,
) => ({ id, store_id, name, customer_phone: phone, guide_count });

describe("planPhoneLinkRepairs — a qué pedido pertenece de verdad", () => {
  it("mueve la guía al pedido que nombra su código cuando el teléfono también coincide", () => {
    const plan = planPhoneLinkRepairs(
      [guia()],
      [pedido("pedido-nuevo", "#KP121336", "51972971210")],
    );
    expect(plan.move).toEqual([
      {
        shipmentId: "guia-1",
        guideCode: "AUR5X121336",
        fromOrderId: "pedido-viejo",
        toOrderId: "pedido-nuevo",
        toOrderName: "#KP121336",
      },
    ]);
  });

  it("NO la mueve si el teléfono del destino no coincide", () => {
    // Sin la segunda señal esto sería exactamente el error que se corrige, al
    // revés: mover por una coincidencia de numeración.
    const plan = planPhoneLinkRepairs(
      [guia()],
      [pedido("pedido-nuevo", "#KP121336", "51999999999")],
    );
    expect(plan.move).toEqual([]);
    expect(plan.skipped).toEqual([{ guideCode: "AUR5X121336", reason: "telefono_no_coincide" }]);
  });

  it("NO la mueve a un pedido que ya tiene sus propias guías", () => {
    // El patrón que esto arregla es «pedido legítimo sin ninguna guía». Con
    // guías propias, encimarle otra es decisión de una persona.
    const plan = planPhoneLinkRepairs(
      [guia()],
      [pedido("pedido-nuevo", "#KP121336", "51972971210", 1)],
    );
    expect(plan.move).toEqual([]);
    expect(plan.skipped).toEqual([{ guideCode: "AUR5X121336", reason: "destino_ya_tiene_guias" }]);
  });

  it("no inventa un pedido que no existe en la base", () => {
    const plan = planPhoneLinkRepairs([guia()], []);
    expect(plan.move).toEqual([]);
    expect(plan.skipped).toEqual([
      { guideCode: "AUR5X121336", reason: "pedido_derivado_no_existe" },
    ]);
  });

  it("deja en paz a la que ya está donde debe", () => {
    const plan = planPhoneLinkRepairs(
      [guia({ order_id: "pedido-nuevo" })],
      [pedido("pedido-nuevo", "#KP121336", "51972971210")],
    );
    expect(plan.move).toEqual([]);
    expect(plan.skipped).toEqual([{ guideCode: "AUR5X121336", reason: "ya_esta_en_su_pedido" }]);
  });

  it("no cruza tiendas: el mismo nombre en otra tienda no es el mismo pedido", () => {
    const plan = planPhoneLinkRepairs(
      [guia()],
      [pedido("pedido-otra", "#KP121336", "51972971210", 0, "store-aurela")],
    );
    expect(plan.move).toEqual([]);
    expect(plan.skipped).toEqual([
      { guideCode: "AUR5X121336", reason: "pedido_derivado_no_existe" },
    ]);
  });

  it("descarta la guía sin teléfono en vez de moverla a ciegas", () => {
    const plan = planPhoneLinkRepairs(
      [guia({ customer_phone: null })],
      [pedido("pedido-nuevo", "#KP121336", null)],
    );
    expect(plan.move).toEqual([]);
    expect(plan.skipped).toEqual([{ guideCode: "AUR5X121336", reason: "telefono_no_coincide" }]);
  });

  it("informa el motivo de cada descarte por separado", () => {
    const plan = planPhoneLinkRepairs(
      [
        guia({ id: "a", guide_code: "AUR5X100001", derived_order_name: null }),
        guia({ id: "b", guide_code: "AUR5X100002", derived_order_name: "#KP100002" }),
      ],
      [],
    );
    expect(plan.skipped).toEqual([
      { guideCode: "AUR5X100001", reason: "sin_nombre_derivado" },
      { guideCode: "AUR5X100002", reason: "pedido_derivado_no_existe" },
    ]);
  });
});
