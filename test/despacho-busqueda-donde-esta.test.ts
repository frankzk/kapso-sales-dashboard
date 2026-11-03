import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMPTY_QUEUE_FILTERS,
  filterQueue,
  locateOutsideList,
  matchesOrderSearch,
  normalizeOrderSearch,
  setStages,
  type LocateBlocked,
  type LocateSources,
  type QueueFilters,
  type QueueRow,
} from "@/lib/dispatch-day";

/**
 * 24-10-2026: el owner buscó #KP141876 en «Desde la lista» para reprogramarlo
 * y la lista respondió «Nada por asignar con ese filtro.». El pedido estaba en
 * «Sin condiciones» (76 ese día): Ancón no tiene tarifa y está pausado para
 * Grupo GF. Nada en la pantalla lo decía. Ahora el vacío dice dónde está, por
 * qué y la acción que lleva allí, con lo que el tablero ya tiene en memoria.
 */

const today = "2026-10-24";

const row = (over: Partial<QueueRow>): QueueRow => ({
  orderId: over.orderId ?? crypto.randomUUID(),
  orderName: "#KP1",
  storeName: "Kenku",
  customerName: "Ana",
  customerPhone: null,
  district: "Surco",
  orderTotal: 100,
  createdAt: "2026-10-23T15:00:00Z",
  scheduledFor: today,
  tariffAmount: 10,
  taken: false,
  requestId: null,
  armed: null,
  observation: null,
  hasPriorDispatch: false,
  programmedFor: null,
  macroStage: "por_despachar",
  macroSubstage: "listo_para_asignar",
  assignable: true,
  route: null,
  ...over,
});

const ancon: LocateBlocked = { orderId: "kp141876", orderName: "#KP141876", district: "Ancón", reason: "tarifa_faltante", customerPhone: "+51 962 820 897" };
const search = (query: string, over: Partial<QueueFilters> = {}): QueueFilters => ({ ...EMPTY_QUEUE_FILTERS, query, ...over });
const sources = (over: Partial<LocateSources> = {}): LocateSources => ({ rows: [row({ orderId: "otro", orderName: "#KP100001" })], blocked: [ancon], ...over });

describe("buscar un pedido que no está por asignar (#KP141876, 24-10-2026)", () => {
  it("en «Sin condiciones» por tarifa: dice el distrito y manda al Tarifario", () => {
    const { found, more } = locateOutsideList(search("#KP141876"), sources(), today, { canEditTariffs: true });
    expect(more).toBe(0);
    expect(found).toEqual([{
      orderId: "kp141876",
      orderName: "#KP141876",
      tone: "warn",
      text: "#KP141876 está en «Sin condiciones»: tarifa faltante para Ancón. Ponle tarifa en Tarifario.",
      action: { kind: "tarifario", label: "Abrir Tarifario" },
    }]);
  });

  it("si además está pausado, lo dice: ponerle tarifa no basta", () => {
    const { found } = locateOutsideList(search("#KP141876"), sources({ blocked: [{ ...ancon, paused: true }] }), today, { canEditTariffs: true });
    expect(found[0]!.text).toBe("#KP141876 está en «Sin condiciones»: tarifa faltante para Ancón, y el servicio está pausado ahí. Ponle tarifa y reanuda el servicio en Tarifario.");
  });

  it("sin el Tarifario a mano, dice quién lo corrige y abre «Sin condiciones»", () => {
    const { found } = locateOutsideList(search("#KP141876"), sources(), today);
    expect(found[0]!.text).toBe("#KP141876 está en «Sin condiciones»: tarifa faltante para Ancón. La tarifa la pone quien administra Grupo GF (Daysi o Frankz) en Tarifario.");
    expect(found[0]!.action).toEqual({ kind: "sin_condiciones", label: "Ver «Sin condiciones»" });
  });

  it("servicio pausado y distrito inválido llevan cada uno a su sitio", () => {
    const blocked: LocateBlocked[] = [
      { orderId: "a", orderName: "#KP200001", district: "Pucusana", reason: "servicio_pausado" },
      { orderId: "b", orderName: "#KP200002", district: "Lima", reason: "distrito_invalido" },
      { orderId: "c", orderName: "#KP200003", district: "Surco", reason: "otra_salida_viva" },
    ];
    const text = (q: string) => locateOutsideList(search(q), sources({ blocked }), today, { canEditTariffs: true }).found[0]!;
    expect(text("KP200001").text).toBe("#KP200001 está en «Sin condiciones»: servicio pausado en Pucusana. Reanúdalo en Tarifario.");
    expect(text("KP200002")).toMatchObject({
      text: "#KP200002 está en «Sin condiciones»: distrito inválido o sin contrato (Lima). Corrige el distrito en la ficha del pedido.",
      action: { kind: "ficha", orderId: "b", section: "informacion", label: "Abrir el pedido" },
    });
    // Los motivos de un «Por reprogramar» que no se puede sacar usan su etiqueta.
    expect(text("KP200003").text).toBe("#KP200003 está en «Sin condiciones»: otra salida sigue viva: la lleva su courier. Revísalo en la ficha del pedido.");
  });

  it("el número se reconoce sin «#», en minúsculas o en parte; lo muy corto no busca fuera", () => {
    for (const q of ["#KP141876", "kp141876", "KP141876 ", "141876"]) {
      expect(locateOutsideList(search(q), sources(), today).found.map((f) => f.orderId)).toEqual(["kp141876"]);
    }
    expect(locateOutsideList(search("kp1"), sources(), today).found).toEqual([]);
    expect(locateOutsideList(search(""), sources(), today).found).toEqual([]);
    expect(normalizeOrderSearch(" #KP 141876")).toBe("kp141876");
  });

  it("también por teléfono, como la búsqueda de la lista", () => {
    expect(matchesOrderSearch("962 820 897", "#KP141876", "+51 962 820 897")).toBe(true);
    expect(matchesOrderSearch("962820", "#KP141876", "51962820897")).toBe(true);
    expect(matchesOrderSearch("962820", "#KP141876", null)).toBe(false);
    expect(locateOutsideList(search("962 820 897"), sources(), today).found.map((f) => f.orderId)).toEqual(["kp141876"]);
  });

  it("si la lista lo enseña, no hay nada que explicar", () => {
    const visible = row({ orderId: "visible", orderName: "#KP141876" });
    expect(locateOutsideList(search("#KP141876"), sources({ rows: [visible], blocked: [] }), today).found).toEqual([]);
  });
});

describe("escondido por un apartado o un filtro", () => {
  it("programado para después: dice el apartado y su botón lo abre", () => {
    const later = row({ orderId: "p", orderName: "#KP300001", programmedFor: "2026-10-27" });
    const filters = search("#KP300001", { segment: "nunca_salieron" });
    const { found } = locateOutsideList(filters, sources({ rows: [later] }), today);
    expect(found).toEqual([{
      orderId: "p",
      orderName: "#KP300001",
      tone: "info",
      text: "#KP300001 está por asignar en «Programados después» (programado mar 27/10).",
      action: { kind: "apartado", segment: "programados_despues", label: "Ver en «Programados después»" },
    }]);
    // El botón deja el texto y abre ese apartado: ahí aparece.
    expect(filterQueue([later], { ...EMPTY_QUEUE_FILTERS, query: filters.query, segment: "programados_despues" }, today)).toHaveLength(1);
  });

  it("otro filtro (la tienda) también lo dice", () => {
    const aurela = row({ orderId: "t", orderName: "#AUR178551", storeName: "Aurela" });
    const { found } = locateOutsideList(search("AUR178551", { store: "Kenku" }), sources({ rows: [aurela] }), today);
    expect(found[0]!.text).toBe("#AUR178551 está por asignar en «Nunca salieron», pero lo esconden los filtros de la lista.");
  });

  it("un «No entregado» que sigue en una caja: quitar filtros lo enseña para recibirlo", () => {
    const back = row({
      orderId: "r",
      orderName: "#KP400001",
      assignable: false,
      taken: true,
      macroStage: "en_curso",
      macroSubstage: "por_reprogramar_lima",
      route: { riderName: "Alexis", routeDate: "2026-10-22", loadNumber: 1, state: "in_custody", officeCheckedAt: "x", pickupCheckedAt: "x", undeliveredReason: "no_responde" },
    });
    const { found } = locateOutsideList(search("KP400001", { segment: "nunca_salieron" }), sources({ rows: [back] }), today);
    expect(found[0]).toMatchObject({
      text: "#KP400001 sigue en la caja de Alexis del jue 22/10 («No entregado»): se recibe en oficina para volver a asignarlo, y lo esconden los filtros de la lista.",
      action: { kind: "quitar_filtros", label: "Quitar filtros" },
    });
  });
});

describe("lo que ya no está por asignar", () => {
  it("en la caja de un motorizado: cuál, de qué día y si lo lleva; «Ver en seguimiento» abre su etapa", () => {
    const boxed = row({
      orderId: "b",
      orderName: "#KP500001",
      assignable: false,
      taken: true,
      macroStage: "en_curso",
      macroSubstage: "en_reparto",
      route: { riderName: "Roy", routeDate: "2026-10-24", loadNumber: 2, state: "in_custody", officeCheckedAt: "x", pickupCheckedAt: "x" },
    });
    const filters = search("#KP500001");
    const { found } = locateOutsideList(filters, sources({ rows: [boxed] }), today);
    expect(found).toEqual([{
      orderId: "b",
      orderName: "#KP500001",
      tone: "info",
      text: "#KP500001 ya no está por asignar: está en la caja de Roy del sáb 24/10 (carga 2), lo lleva (En curso · En reparto).",
      action: { kind: "etapa", stage: "en_curso", label: "Ver en seguimiento" },
    }]);
    expect(filterQueue([boxed], setStages({ ...EMPTY_QUEUE_FILTERS, query: filters.query }, ["en_curso"]), today)).toHaveLength(1);
  });

  it("tomado pero cerrándose: dice la etapa", () => {
    const closing = row({ orderId: "c", orderName: "#KP500002", assignable: false, taken: true, macroStage: "por_cerrar", macroSubstage: "validacion_cierre_pendiente" });
    expect(locateOutsideList(search("KP500002"), sources({ rows: [closing] }), today).found[0]!.text)
      .toBe("#KP500002 ya no se asigna: está en «Por cerrar · Validación de cierre pendiente».");
  });

  it("«En devolución» y «Devoluciones» abren su hoja y su escáner", () => {
    const { found: returning } = locateOutsideList(search("KP600001"), sources({
      returning: [{ orderId: "d", orderName: "#KP600001", outputCode: "KP600001-S01", riderName: "Alexis", routeDate: "2026-10-21", replacedByCode: "KP600001-S02" }],
    }), today);
    expect(returning[0]).toMatchObject({
      text: "#KP600001 está en «En devolución»: KP600001-S01 vuelve con Alexis (caja del mié 21/10) y el pedido sale con KP600001-S02.",
      action: { kind: "en_devolucion" },
    });
    const { found: pending } = locateOutsideList(search("KP600002"), sources({
      pendingReturns: [{ orderId: "e", orderName: "#KP600002", riderName: "Johnny", routeDate: "2026-10-23" }],
    }), today);
    expect(pending[0]).toMatchObject({
      text: "#KP600002 está en «Devoluciones»: Johnny tiene que traerlo de su caja del vie 23/10 («No entregado»).",
      action: { kind: "devoluciones", label: "Abrir «Devoluciones»" },
    });
  });

  it("cada pedido una vez, el número entero primero, y los que no caben se cuentan", () => {
    const blocked: LocateBlocked[] = [
      { orderId: "x1", orderName: "#KP1418760", district: "Ancón", reason: "tarifa_faltante" },
      { orderId: "x2", orderName: "#KP1418761", district: "Ancón", reason: "tarifa_faltante" },
      ancon,
      { orderId: "x3", orderName: "#KP1418762", district: "Ancón", reason: "tarifa_faltante" },
    ];
    const { found, more } = locateOutsideList(search("KP141876"), {
      rows: [],
      blocked,
      // El mismo pedido también en «Devoluciones»: se dice una sola vez.
      pendingReturns: [{ orderId: "kp141876", orderName: "#KP141876", riderName: "Roy", routeDate: "2026-10-23" }],
    }, today);
    expect(found.map((f) => f.orderId)).toEqual(["kp141876", "x1", "x2"]);
    expect(more).toBe(1);
  });
});

describe("el tablero lo pinta en los dos vacíos de «Desde la lista»", () => {
  const board = readFileSync(resolve(process.cwd(), "components/dispatch-day-board.tsx"), "utf8");
  it("tabla y teléfono", () => {
    expect(board.match(/<LocatedNotice /g)).toHaveLength(2);
    expect(board).toContain("locateOutsideList(filters, { rows: allRows, blocked: props.blocked");
  });
});
