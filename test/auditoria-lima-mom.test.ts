// Auditoría del atraso de Lima (14-10-2026): las reglas que el MOM registró el
// 15-10-2026 (§9.4, §11.4, §14, §17.1, §24, §29.12, §29.13, §30 «Qué impide
// terminar la ruta», §30.8, §30.11 y §32 regla 12), atadas al código que de verdad corre. Cada regla está
// probada a fondo en su archivo (test/pedidos-*.test.ts,
// test/rutas-anulado-shopify.test.ts, test/tanders-sweep-missing-collection.test.ts,
// test/visibilidad-*.test.ts); aquí, que lo que el MOM cita —textos, topes,
// nombres de funciones— sea lo mismo que hace el código, para que no se
// separen sin que nadie lo note.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GF_OPEN_ROUTE_CANCELLED_ERROR,
  GF_OPEN_ROUTE_ERROR,
  GF_ROUTE_PATH_LABEL,
  OVERRIDE_PERMISSION_LABEL,
  gfOpenRouteBlock,
  liquidationCostBlock,
} from "@/lib/closure-blocks";
import { costCourier } from "@/lib/delivery-courier";
import { OBSERVATIONS_SCREEN_HREF } from "@/lib/bulk-status-guard";
import { masterLogisticsCost } from "@/lib/order-master";
import { bulkDeliveredSkips } from "@/lib/bulk-status-guard";
import { masterDoorVerdict, shopifyCancelledNotice } from "@/lib/master-door";
import { MAX_FICHAS_POR_PASADA, MAX_VALIDADAS_POR_PASADA } from "@/lib/tanders/payment-sweep";
import { mismaComprobacion } from "@/lib/tanders/payment-sweep-rules";
import { settlementCourier, settlementDeliveredAt, type MomOwnerOrderFact } from "@/lib/mom-owner-summary";
import { URPI_RESULTS_DAYS } from "@/lib/urpi-report-apply";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const mom = flat(read("docs/mom/master-pedidos-v1.md"));

/** El texto de una sección del MOM, desde su título hasta el siguiente del mismo nivel o superior. */
function section(title: string): string {
  const raw = read("docs/mom/master-pedidos-v1.md");
  const start = raw.indexOf(title);
  expect(start, title).toBeGreaterThan(-1);
  const level = title.match(/^#+/)![0].length;
  const rest = raw.slice(start + title.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return flat(next === -1 ? rest : rest.slice(0, next));
}

describe("§14 Falta no es cero", () => {
  const s14 = section("## 14. Liquidaciones");

  it("el MOM registra la regla con su fecha y la función que la aplica", () => {
    expect(s14).toContain("**Falta no es cero (15-10-2026).**");
    expect(s14).toContain("`masterLogisticsCost`, `lib/order-master.ts`");
    expect(s14).toContain("`MOM_RESOLUTION_VERSION` no cambia");
  });

  it("sin tarifa el costo queda vacío; un cero legítimo sigue siendo cero", () => {
    const input = {
      ctx: { storeId: "s", courier: "propio", region: "Lima", province: "Lima", district: "Surco" },
      attempts: 1,
      generalStatus: "entregado",
      agency: false,
      day: "2026-10-15",
    };
    expect(masterLogisticsCost([], input)).toEqual({ cost: null, missing: ["primer_intento"] });
    // El acompañante viaja en la caja del principal (§32).
    expect(masterLogisticsCost([], { ...input, ridesInHostBox: true })).toEqual({ cost: 0, missing: [] });
    // El precio real del courier en cero no es una tarifa que falte.
    expect(masterLogisticsCost([], { ...input, actual: { delivery: 0 } })).toEqual({ cost: 0, missing: [] });
  });

  it("la conciliación se niega con el costo vacío y dice dónde se carga la tarifa", () => {
    const block = liquidationCostBlock({ cost: null, missing: ["primer_intento"], courier: "propio", district: "Surco" });
    expect(block).toContain("Costos › Costos logísticos (courier «propio»)");
    expect(s14).toContain("Costos › Costos logísticos con el código de ese courier («propio» para Grupo GF)");
    expect(liquidationCostBlock({ cost: 0, courier: "propio", district: "Surco" })).toBeNull();
  });

  it("con qué courier: el de la entrega si el vigente está vacío o «por definir», solo en un entregado", () => {
    expect(s14).toContain("**Con qué courier se busca la tarifa (16-10-2026).**");
    expect(s14).toContain("(§17.1; `costCourier` y `deliveryCourier`, `lib/delivery-courier.ts`)");
    expect(s14).toContain("1.868 son entregas de Grupo GF del cuaderno, 323 de Urpi y 2.056 sin courier conocido");
    expect(costCourier({ generalStatus: "entregado", currentCourier: "por_definir", dispatchedWith: ["gf:Roy"] })).toBe("propio");
    expect(costCourier({ generalStatus: "en_proceso", currentCourier: null, dispatchedWith: ["gf:Roy"] })).toBeNull();
  });

  it("«por definir» no es un courier y sin courier no se pide tarifa", () => {
    expect(s14).toContain("**«Por definir» no es un courier.**");
    expect(s14).toContain("**Sin courier conocido**, el aviso lo dice y no pide tarifa");
    for (const courier of ["por_definir", null]) {
      const block = liquidationCostBlock({ cost: null, missing: ["primer_intento"], courier, district: "Ate" })!;
      expect(block).not.toContain("Cárgala");
      expect(block).not.toContain("por_definir");
    }
  });

  it("la tarifa tiene que regir el día del pedido; cargarla es de administración", () => {
    expect(s14).toContain("**La tarifa tiene que regir el día del pedido (16-10-2026).**");
    expect(s14).toContain("(«vigente desde el DD-MM-AAAA o antes»)");
    expect(s14).toContain("(`upsertTariff` borra la que empezaría después)");
    expect(s14).toContain("Cargar una tarifa exige `costs.manage` (administración)");
    const block = liquidationCostBlock({ cost: null, courier: "propio", district: "Surco", day: "2026-07-24", canManageCosts: false });
    expect(block).toContain("vigente desde el 24-07-2026 o antes");
    expect(block).toContain("Pídele a quien administra Costos");
  });
});

describe("§24 y §29.13 la ruta de Grupo GF abierta no se finaliza", () => {
  it("el MOM cita el mismo camino que dicen la Mesa y el servidor", () => {
    expect(GF_OPEN_ROUTE_ERROR).toContain(`Termina la ruta en ${GF_ROUTE_PATH_LABEL}`);
    expect(section("## 24. Criterios de aceptación del primer bloque de la Fase 4")).toContain(
      `«Termina la ruta en ${GF_ROUTE_PATH_LABEL}»`,
    );
    expect(mom).toContain(
      `**La Mesa de cierre no finaliza lo que cierra la ruta (15-10-2026).**`,
    );
    expect(mom).toContain(`dice «Termina la ruta en ${GF_ROUTE_PATH_LABEL}»`);
    expect(mom).toContain("(`gfOpenRouteBlock`, `lib/closure-blocks.ts`)");
  });

  it("aplica solo con la única salida viva propia y la parada entregada en una ruta abierta", () => {
    const own = [{ id: "s1", courier: "propio", delivery_status: "pendiente" }];
    const open = [{ shipmentId: "s1", stop: { status: "entregado", routeStatus: "en_curso", routeId: "r1" } }];
    expect(gfOpenRouteBlock(own, open)).toEqual({ kind: "ruta_abierta", routeIds: ["r1"] });
    expect(gfOpenRouteBlock(own, [{ shipmentId: "s1", stop: { status: "entregado", routeStatus: "cerrada" } }])).toBeNull();
    expect(
      gfOpenRouteBlock([...own, { id: "s2", courier: "tanders", delivery_status: "en_ruta" }], open),
    ).toBeNull();
  });

  it("anulado en Shopify (#KP137541): el MOM y el texto no prometen que cerrar la ruta lo marque entregado", () => {
    expect(section("### 29.13 Despacho en dos pasos y el gesto único (19-09-2026)")).toContain(
      "**Si está anulado en Shopify, cerrar la ruta no lo marca entregado (16-10-2026).**",
    );
    expect(section("## 24. Criterios de aceptación del primer bloque de la Fase 4")).toContain(
      "Si además está anulado en Shopify, no promete que cerrar la ruta lo pase a entregado",
    );
    const own = [{ id: "s1", courier: "propio", delivery_status: "pendiente", custody_state: "courier" }];
    const open = [{ shipmentId: "s1", stop: { status: "entregado", routeStatus: "en_curso", routeId: "00bd7063" } }];
    expect(gfOpenRouteBlock(own, open, { cancelledInShopify: true })?.kind).toBe("anulado_shopify");
    expect(GF_OPEN_ROUTE_CANCELLED_ERROR).not.toContain("pasa a entregado");
    expect(GF_OPEN_ROUTE_CANCELLED_ERROR).toContain(`«${OVERRIDE_PERMISSION_LABEL}»`);
    expect(mom).toContain("quien tenga «Corregir pedidos cerrados»; el servidor responde lo mismo");
  });
});

describe("§11.4, §29.12, §30 y §32 la puerta no escribe sobre una anulación de Shopify", () => {
  it("el MOM registra la regla y el código de rechazo", () => {
    expect(mom).toContain("**La puerta a «entregado» no escribe sobre una anulación de Shopify (15-10-2026).**");
    expect(mom).toContain("rechazado con el código `anulado_en_shopify`");
    expect(section("### 29.12 Convergencia con Liquidaciones 2: la parada es la verdad")).toContain(
      "lo devuelve como `anulado_en_shopify`",
    );
    expect(section("## 32. Pedido acompañante")).toContain("la puerta lo deja en `companionsCancelled`");
  });

  it("la anulación manda antes que cualquier guarda, y también sin guarda", () => {
    const verdict = masterDoorVerdict({ target: "entregado" }, { cancelledAt: "2026-10-05T17:45:00Z" });
    expect(verdict).toMatchObject({ ok: false, code: "anulado_en_shopify" });
    expect(masterDoorVerdict({ target: "entregado" })).toEqual({ ok: true });
  });

  it("el aviso del cierre que cita §30 («Qué impide terminar la ruta») es el que arma el código", () => {
    const notice = shopifyCancelledNotice([{ orderId: "o1", name: "#KP137541" }]);
    const s30 = section("## 30. Liquidaciones 2 — hojas por dominio");
    expect(s30).toContain("**Un pedido anulado en Shopify no impide terminar la ruta, pero no cruza al Master (15-10-2026).**");
    expect(s30).toContain(`«${notice}»`);
  });
});

describe("§30.8 el lote del Master respeta la observación de cuadre abierta", () => {
  it("el MOM lo registra", () => {
    const s308 = section("### 30.8 Cierre por pedido desde la hoja");
    expect(s308).toContain("**El lote del Master respeta la misma guarda (15-10-2026).**");
    expect(s308).toContain(`el aviso trae el enlace «Abrir Liquidaciones 2» y los textos dan su dirección (${OBSERVATIONS_SCREEN_HREF};`);
    expect(s308).toContain("**Pendiente del owner:** dónde se aceptan las observaciones con la pantalla oculta.");
    expect(s308).toContain("(`applyOrderStatusBulk`) a «entregado»");
    expect(s308).toContain("`sheet_observations.status = 'abierta'`");
    expect(s308).toContain("Hacia otros estados no se salta ninguno.");
  });

  it("salta solo hacia entregado", () => {
    const open = new Set(["b"]);
    expect(bulkDeliveredSkips("entregado", ["a", "b"], open).map((s) => s.orderId)).toEqual(["b"]);
    expect(bulkDeliveredSkips("pendiente", ["a", "b"], open)).toEqual([]);
  });
});

describe("§9.4 cobros Tanders: la validada sin ficha y la comprobación repetida", () => {
  it("los topes del MOM son los del barrido", () => {
    expect(MAX_VALIDADAS_POR_PASADA).toBe(60);
    expect(MAX_FICHAS_POR_PASADA).toBe(20);
    expect(mom).toContain(
      `hasta ${MAX_VALIDADAS_POR_PASADA} guías miradas y ${MAX_FICHAS_POR_PASADA} fichas creadas por pasada`,
    );
    expect(mom).toContain("**La guía validada que se quedó sin ficha la recibe ahora (15-10-2026).**");
    expect(mom).toContain("la ficha entra **`pendiente_revision`**");
  });

  it("la anulada en Shopify no recibe ficha, y la que falló va primera", () => {
    expect(mom).toContain("**Un pedido anulado en Shopify no recibe ficha (16-10-2026).**");
    expect(mom).toContain("los cuenta aparte (`fichasAnuladas`, con sus nombres)");
    expect(mom).toContain("**La que el barrido validó y cuya ficha falló va primera (16-10-2026).**");
    expect(mom).toContain("se le **borra** el sello (`payment_checked_at` = null)");
  });

  it("releer y llegar a lo mismo no es un hecho nuevo", () => {
    expect(mom).toContain("**Releer y llegar a lo mismo no deja otra fila (15-10-2026).**");
    const fila = { state: "rechazado", reasons: ["a", "b"], image_url: "u", operation_number: "1", amount: "89.00" };
    expect(mismaComprobacion(fila, { ...fila, reasons: ["b", "a"], amount: 89 })).toBe(true);
    expect(mismaComprobacion(fila, { ...fila, state: "validado" })).toBe(false);
  });
});

describe("§17.1 «Liquidación vencida» con las entregas registradas a mano", () => {
  const base: MomOwnerOrderFact = {
    orderId: "o",
    createdAt: null,
    coverage: "lima",
    orderTotal: 100,
    stage: "por_cerrar",
    substage: "pendiente_liquidacion",
    reasons: ["pendiente_liquidacion"],
    paymentState: null,
    deliveredAt: null,
    deliveredCourier: null,
    lastMovementAt: null,
  };

  it("el MOM nombra las funciones y el orden del courier", () => {
    const s171 = section("### 17.1 Primer tablero diario del owner");
    expect(s171).toContain("**Entregas registradas a mano (15-10-2026).**");
    expect(s171).toContain("(`settlementDeliveredAt` y `settlementCourier`, `lib/mom-owner-summary.ts`)");
    expect(s171).toContain("`Recogido sin pago completo`: razón crítica abierta en el Master.");
    expect(s171).toContain("**La cifra y su lista no siempre cuadran (16-10-2026).**");
    expect(s171).toContain("**Pendiente del owner:** si la cifra pasa a contar por subetapa");
  });

  it("fecha: status_since de un entregado; courier: vigente, último y «Salió con»", () => {
    expect(settlementDeliveredAt({ ...base, generalStatus: "entregado", statusSince: "2026-10-01T00:00:00Z" })).toBe(
      "2026-10-01T00:00:00Z",
    );
    expect(settlementDeliveredAt({ ...base, generalStatus: "en_proceso", statusSince: "2026-10-01T00:00:00Z" })).toBeNull();
    expect(settlementCourier({ ...base, currentCourier: "por_definir", lastCourier: "urpi" })).toBe("urpi");
    expect(settlementCourier({ ...base, dispatchedWith: ["gf:Roy", "gf"] })).toBe("propio");
    expect(settlementCourier({ ...base, dispatchedWith: ["gf:Roy", "urpi"] })).toBeNull();
  });
});

describe("§30.11 entregados de Urpi de antes de la ventana", () => {
  it("el MOM cita la misma ventana y el módulo que la amplía", () => {
    expect(URPI_RESULTS_DAYS).toBe(60);
    expect(mom).toContain("**Entregados de antes de la ventana (15-10-2026).**");
    expect(mom).toContain(`intentos de los últimos ${URPI_RESULTS_DAYS} días, y el botón «Pasar a salida de Urpi entregada»`);
    expect(mom).toContain("(`lib/urpi-results-window.ts`, con la misma regla del botón)");
  });
});
