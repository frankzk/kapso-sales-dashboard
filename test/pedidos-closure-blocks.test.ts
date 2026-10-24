import { describe, expect, it } from "vitest";
import {
  ACTIVE_OUTPUTS_ERROR,
  COSTS_SCREEN_LABEL,
  GF_OPEN_ROUTE_CANCELLED_ERROR,
  GF_OPEN_ROUTE_ERROR,
  GF_ROUTE_PATH_LABEL,
  activeOutputs,
  costBlockNeedsTariff,
  gfOpenRouteBlock,
  gfOpenRouteError,
  gfRouteReportHref,
  liquidationCostBlock,
  logisticsCostFactsFromRow,
  type ClosureGfDelivery,
  type ClosureShipment,
} from "@/lib/closure-blocks";

// Auditoría del atraso de Lima, 14-10-2026 (MOM §14, §29.13).

describe("liquidationCostBlock — conciliar exige un costo que exista", () => {
  it("un costo conocido no bloquea, tampoco un cero legítimo (tarifa en S/ 0, acompañante)", () => {
    expect(liquidationCostBlock({ cost: 12.5, courier: "aliclik", district: "Ate" })).toBeNull();
    expect(liquidationCostBlock({ cost: 0, courier: "aliclik", district: "Ate" })).toBeNull();
  });

  it("sin saber el costo (undefined) no afirma nada", () => {
    expect(liquidationCostBlock({ cost: undefined, courier: "propio", district: "Ate" })).toBeNull();
  });

  it("sin tarifa dice qué falta, de quién, dónde y dónde se carga", () => {
    const text = liquidationCostBlock({
      cost: null,
      missing: ["primer_intento"],
      courier: "aliclik",
      district: "San Juan de Lurigancho",
    });
    expect(text).toBe(
      "Falta la tarifa de «Primer intento» de Aliclik para San Juan de Lurigancho. Sin ella el flete quedaría en S/ 0" +
        " y la liquidación no cuadra. Cárgala en Costos › Costos logísticos (courier «aliclik») y vuelve a conciliar.",
    );
  });

  it("varios conceptos se nombran todos; sin la lista dice «la tarifa logística»", () => {
    expect(
      liquidationCostBlock({ cost: null, missing: ["primer_intento", "intento_adicional"], courier: "urpi", district: "Ate" }),
    ).toContain("la tarifa de «Primer intento» y «Intento adicional» de Urpi para Ate.");
    const generic = liquidationCostBlock({ cost: null, courier: "urpi", district: null });
    expect(generic).toContain("Falta la tarifa logística de Urpi.");
    expect(generic).toContain(`Cárgala en ${COSTS_SCREEN_LABEL} (courier «urpi»)`);
  });

  it("sin saber quién lo entregó lo dice, sin pedir una tarifa ni sugerir una sin courier", () => {
    const text = liquidationCostBlock({ cost: null, missing: ["primer_intento"], courier: null, district: "Ate" })!;
    expect(text).toBe(
      "Falta la tarifa de «Primer intento»: no se sabe qué courier entregó el pedido (ni su salida ni «Salió con» lo" +
        " dicen), así que ninguna tarifa le aplica. Sin ella el flete quedaría en S/ 0 y la liquidación no cuadra." +
        " Kapta todavía no tiene un paso para registrar quién lo entregó, y una tarifa sin courier no es la salida:" +
        " se aplicaría a todos los couriers sin tarifa propia.",
    );
    expect(text).not.toContain("Cárgala");
  });

  it("«por definir» no es un courier: no pide una tarifa para él ni lo nombra como courier", () => {
    // 761 pedidos esperando liquidación con la salida «por definir» (16-10-2026).
    const text = liquidationCostBlock({
      cost: null,
      missing: ["primer_intento"],
      courier: "por_definir",
      district: "Ate",
      day: "2026-10-03",
    })!;
    expect(text).not.toContain("por_definir");
    expect(text).not.toContain("de Por definir para");
    expect(text).not.toContain("Cárgala");
    expect(text).toContain("la salida sigue «Por definir» y no se sabe qué courier la entregó");
    // Urpi es un camino, no el único: la mayoría son de Grupo GF, del cuaderno.
    expect(text).toContain("Si la entregó Urpi, pásala en Urpi › Resultados («Pasar a salida de Urpi entregada»)");
    expect(text).toContain("para otro courier, Kapta todavía no tiene ese paso.");
    expect(liquidationCostBlock({ cost: null, courier: " Por_Definir ", district: null })).not.toContain("Cárgala");
  });

  it("nombra el día desde el que tiene que regir la tarifa: una cargada desde hoy no le llega", () => {
    const text = liquidationCostBlock({
      cost: null,
      missing: ["primer_intento"],
      courier: "urpi",
      district: "Ate",
      day: "2026-10-03",
    });
    expect(text).toBe(
      "Falta la tarifa de «Primer intento» de Urpi para Ate. Sin ella el flete quedaría en S/ 0 y la liquidación no" +
        " cuadra. Cárgala en Costos › Costos logísticos (courier «urpi»), vigente desde el 03-10-2026 o antes, y vuelve" +
        " a conciliar. Una que empiece después de ese día no le llega: el costo se calcula con la del día de su último" +
        " movimiento.",
    );
  });

  it("quien no administra Costos recibe a quién pedírsela, no «Cárgala»", () => {
    const text = liquidationCostBlock({
      cost: null,
      missing: ["primer_intento"],
      courier: "urpi",
      district: "Ate",
      day: "2026-07-24",
      canManageCosts: false,
    })!;
    expect(text).toContain(
      "Pídele a quien administra Costos que la cargue en Costos › Costos logísticos (courier «urpi»), vigente desde el" +
        " 24-07-2026 o antes, y luego vuelve a conciliar.",
    );
    expect(text).not.toContain("Cárgala");
  });

  it("solo una tarifa con courier conocido arregla el bloqueo", () => {
    expect(costBlockNeedsTariff({ cost: null, courier: "propio" })).toBe(true);
    expect(costBlockNeedsTariff({ cost: null, courier: "urpi" })).toBe(true);
    expect(costBlockNeedsTariff({ cost: null, courier: "por_definir" })).toBe(false);
    expect(costBlockNeedsTariff({ cost: null, courier: null })).toBe(false);
    expect(costBlockNeedsTariff({ cost: 0, courier: "propio" })).toBe(false);
  });
});

describe("logisticsCostFactsFromRow — la Mesa avisa con el courier y el día del recálculo", () => {
  const row = {
    logistics_cost: null,
    general_status: "entregado",
    current_courier: "por_definir",
    last_courier: null,
    delivered_courier: null,
    dispatched_with: ["gf:Roy"],
    district: "Ate",
    last_movement_at: "2026-07-24T15:00:00Z",
    order_created_at: "2026-07-20T10:00:00Z",
  };

  it("entrega del cuaderno con la caja «por definir»: Grupo GF, al día de su último movimiento", () => {
    expect(logisticsCostFactsFromRow(row)).toEqual({ cost: null, courier: "propio", district: "Ate", day: "2026-07-24" });
  });

  it("Grupo GF, como cualquier courier, al día del último movimiento (MOM §14, mom-v1.31)", () => {
    const later = { ...row, last_movement_at: "2026-10-21T11:00:00Z" };
    expect(logisticsCostFactsFromRow(later)).toMatchObject({ courier: "propio", day: "2026-10-21" });
    expect(logisticsCostFactsFromRow({ ...later, dispatched_with: ["urpi"] })).toMatchObject({ courier: "urpi", day: "2026-10-21" });
  });

  it("un pedido no entregado no infiere el courier", () => {
    expect(logisticsCostFactsFromRow({ ...row, general_status: "anulado" }).courier).toBe("por_definir");
  });

  it("sin fechas en la fila, no nombra el día", () => {
    expect(logisticsCostFactsFromRow({ ...row, last_movement_at: null, order_created_at: null }).day).toBeNull();
  });
});

const gf = (id: string, over: Partial<ClosureShipment> = {}): ClosureShipment => ({
  id,
  courier: "propio",
  delivery_status: "pendiente",
  custody_state: "courier",
  ...over,
});
const stop = (shipmentId: string, status: string, routeStatus: string | null, routeId: string | null = "r-1"): ClosureGfDelivery => ({
  shipmentId,
  stop: { status, routeStatus, routeId },
});

describe("activeOutputs — la misma regla que el servidor", () => {
  it("vive lo pendiente, en ruta o por preparar que no volvió", () => {
    const rows = [
      gf("a"),
      gf("b", { delivery_status: "en_ruta" }),
      gf("c", { delivery_status: "por_preparar" }),
      gf("d", { custody_state: "devuelto" }),
      gf("e", { delivery_status: "entregado" }),
      gf("f", { delivery_status: "anulado" }),
    ];
    expect(activeOutputs(rows).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

const open = (routeIds: string[]) => ({ kind: "ruta_abierta", routeIds });

describe("gfOpenRouteBlock — la salida GF entregada con la ruta abierta la cierra la ruta", () => {
  it("salida propia viva con parada entregada en ruta en curso: bloquea y da la ruta", () => {
    expect(gfOpenRouteBlock([gf("s1")], [stop("s1", "entregado", "en_curso")])).toEqual(open(["r-1"]));
    expect(gfOpenRouteBlock([gf("s1")], [stop("s1", "entregado", "planificada")])).toEqual(open(["r-1"]));
  });

  it("sin id de ruta conocido sigue bloqueando, sin enlace", () => {
    expect(gfOpenRouteBlock([gf("s1")], [stop("s1", "entregado", "en_curso", null)])).toEqual(open([]));
  });

  it("con la ruta cerrada o sin saber su estado, manda el mensaje de siempre", () => {
    expect(gfOpenRouteBlock([gf("s1")], [stop("s1", "entregado", "cerrada")])).toBeNull();
    expect(gfOpenRouteBlock([gf("s1")], [stop("s1", "entregado", null)])).toBeNull();
  });

  it("la parada no entregada o sin parada: no aplica", () => {
    expect(gfOpenRouteBlock([gf("s1")], [stop("s1", "no_entregado", "en_curso")])).toBeNull();
    expect(gfOpenRouteBlock([gf("s1")], [stop("s1", "pendiente", "en_curso")])).toBeNull();
    expect(gfOpenRouteBlock([gf("s1")], [])).toBeNull();
  });

  it("si otra salida viva es de otro courier, no es la única: no aplica", () => {
    const aliclik = gf("s2", { courier: "aliclik", delivery_status: "en_ruta" });
    expect(gfOpenRouteBlock([gf("s1"), aliclik], [stop("s1", "entregado", "en_curso")])).toBeNull();
  });

  it("una salida ya devuelta o anulada no cuenta como viva", () => {
    const old = gf("s0", { custody_state: "devuelto" });
    const otherDead = gf("s2", { courier: "aliclik", delivery_status: "anulado" });
    expect(gfOpenRouteBlock([old, otherDead, gf("s1")], [stop("s1", "entregado", "en_curso")])).toEqual(open(["r-1"]));
  });

  it("sin salidas vivas no hay nada que decir", () => {
    expect(gfOpenRouteBlock([gf("s1", { delivery_status: "entregado" })], [stop("s1", "entregado", "en_curso")])).toBeNull();
  });

  it("courier con mayúsculas o espacios sigue siendo propio", () => {
    expect(gfOpenRouteBlock([gf("s1", { courier: " Propio " })], [stop("s1", "entregado", "en_curso")])).toEqual(open(["r-1"]));
  });
});

describe("gfOpenRouteBlock — anulado en Shopify, cerrar la ruta no lo marca entregado (§11.4)", () => {
  // #KP137541 (producción, 16-10-2026): anulado en Shopify el 05/10; su única
  // salida es propia, pendiente, con custodia courier, y su última parada está
  // entregada en la ruta del 01/10, en curso. La puerta lo rechaza como
  // `anulado_en_shopify` al cerrar la ruta.
  const kp137541 = [gf("s1")];
  const paradas = [stop("s1", "entregado", "en_curso", "00bd7063")];

  it("sigue bloqueando Finalizar, con otra clase y otro texto", () => {
    const block = gfOpenRouteBlock(kp137541, paradas, { cancelledInShopify: true });
    expect(block).toEqual({ kind: "anulado_shopify", routeIds: ["00bd7063"] });
    const error = gfOpenRouteError(block!);
    expect(error).toBe(GF_OPEN_ROUTE_CANCELLED_ERROR);
    expect(error).not.toBe(GF_OPEN_ROUTE_ERROR);
    expect(error).not.toContain("pasa a entregado");
    // Un solo texto para Shopify y WooCommerce (MOM §38.12, owner 24-10-2026).
    expect(error).toContain("está anulado en la tienda");
    expect(error).not.toContain("Shopify");
    expect(error).toContain(`terminar la ruta en ${GF_ROUTE_PATH_LABEL} no lo marca entregado`);
    expect(error).toContain("quien tenga «Corregir pedidos cerrados»");
  });

  it("sin la anulación de Shopify —aunque el Master diga anulado— queda el bloqueo de siempre", () => {
    // #KP130784 y #KP139661 están «anulado» sin `cancelled_at`: la puerta sí
    // escribe su entrega, así que el texto de siempre es verdad.
    const block = gfOpenRouteBlock(kp137541, paradas);
    expect(block?.kind).toBe("ruta_abierta");
    expect(gfOpenRouteError(block!)).toBe(GF_OPEN_ROUTE_ERROR);
  });

  it("con la ruta ya cerrada no aplica: manda el mensaje de siempre", () => {
    expect(gfOpenRouteBlock(kp137541, [stop("s1", "entregado", "cerrada")], { cancelledInShopify: true })).toBeNull();
  });
});

describe("textos del bloqueo de la ruta GF", () => {
  it("la Mesa y el servidor nombran el mismo camino", () => {
    expect(GF_ROUTE_PATH_LABEL).toBe("Grupo GF Courier › Rutas › «Reparto y liquidación»");
    expect(GF_OPEN_ROUTE_ERROR).toContain(`Termina la ruta en ${GF_ROUTE_PATH_LABEL}`);
    expect(ACTIVE_OUTPUTS_ERROR).toBe("Todavía existen salidas activas. Cancélalas o recibe su retorno antes de finalizar.");
  });

  it("el enlace pasa por la redirección con permisos de /dashboard/courier/reparto", () => {
    expect(gfRouteReportHref("r 1")).toBe("/dashboard/courier/reparto?id=r%201");
  });
});
