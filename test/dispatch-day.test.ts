// Despacho del día (MOM §29.13): lo puro de la pantalla de dos pasos.
import { describe, expect, it } from "vitest";
import { activeFilterCount, boxNextStep, boxTileCounts, queueFacetCounts, queueSubstageOptions, queueTileActive, queueTileCounts, scheduledBucket, setStages, toggleBoxTile, toggleInList, toggleQueueTile, dayBoxes, declinedPackages, EMPTY_QUEUE_FILTERS, filterBoxItems, filterQueue, inCreatedWindow, packageStage, splitAssignment, type DayManifest, type QueueRow } from "@/lib/dispatch-day";

const item = (over: Partial<DayManifest["items"][number]> = {}) => ({
  id: over.id ?? crypto.randomUUID(),
  shipment_id: over.shipment_id ?? "s1",
  removed_at: null,
  office_checked_at: null,
  pickup_checked_at: null,
  pickup_declined_at: null,
  pickup_declined_reason: null,
  shipment: { order_id: "o1", order_name: "#KP1", customer_name: "Ana", district: "Surco", output_code: "KP1-S01", guide_code: "g" },
  ...over,
});

const manifest = (over: Partial<DayManifest> = {}): DayManifest => ({
  id: over.id ?? "m1",
  courier: "propio",
  route_date: "2026-09-19",
  state: "office_check",
  rider_id: "roy",
  driver_name: "Roy",
  load_number: 1,
  items: [],
  ...over,
});

describe("dayBoxes", () => {
  it("agrupa por motorizado solo las cajas propias del día, y suma cargas", () => {
    const boxes = dayBoxes(
      [
        manifest({ id: "a", items: [item({ office_checked_at: "x" }), item({ shipment_id: "s2" })] }),
        manifest({ id: "b", load_number: 2, state: "draft", items: [item({ shipment_id: "s3" })] }),
        manifest({ id: "c", rider_id: "yhoni", driver_name: "Yhoni", items: [item({ shipment_id: "s4", pickup_declined_at: "x", pickup_declined_reason: "dañado", removed_at: "x", removal_reason: "No recogido" })] }),
        manifest({ id: "d", route_date: "2026-09-18", items: [item({ shipment_id: "s5" })] }),
        manifest({ id: "e", courier: "aliclik", items: [item({ shipment_id: "s6" })] }),
        manifest({ id: "f", state: "cancelled", items: [item({ shipment_id: "s7" })] }),
      ],
      "2026-09-19",
    );
    expect(boxes.map((b) => b.riderName)).toEqual(["Roy", "Yhoni"]);
    const roy = boxes[0]!;
    expect(roy).toMatchObject({ assigned: 3, officeChecked: 1, pickupChecked: 0, declined: 0 });
    // La carga más reciente es la que se trabaja.
    expect(roy.loads[0]!.id).toBe("b");
    expect(roy.state).toBe("draft");
    const yhoni = boxes[1]!;
    // Un rechazado del motorizado sale de la carga (removed) pero se cuenta aparte.
    expect(yhoni).toMatchObject({ assigned: 0, declined: 1 });
  });
});

describe("declinedPackages", () => {
  it("lista lo que cada motorizado no recogió, con motivo y pedido", () => {
    const boxes = dayBoxes(
      [manifest({ items: [item({ pickup_declined_at: "x", pickup_declined_reason: "no estaba en la caja", removed_at: "x", removal_reason: "r" }), item({ shipment_id: "s2" })] })],
      "2026-09-19",
    );
    expect(declinedPackages(boxes)).toEqual([
      expect.objectContaining({ riderName: "Roy", reason: "no estaba en la caja", orderName: "#KP1", shipmentId: "s1", manifestId: "m1" }),
    ]);
  });
});

describe("splitAssignment", () => {
  it("separa disponibles (tomar+asignar) de tomados sin ruta (solo asignar)", () => {
    const split = splitAssignment(
      new Set(["o1", "o2", "o3", "o4"]),
      [{ orderId: "o1" }, { orderId: "o4" }],
      [
        { orderId: "o2", requestId: "r2", route: null, shipmentId: "s2" },
        { orderId: "o3", requestId: "r3", route: { manifestId: "m" }, shipmentId: "s3" },
        { orderId: "o4", requestId: "r4", route: null, shipmentId: null },
      ],
    );
    // o3 ya tiene caja y o4 tomado sin salida física: ninguno se asigna; o4 cae a «tomar» porque sigue disponible.
    expect(split).toEqual({ orderIds: ["o1", "o4"], requestIds: ["r2"] });
  });
});

describe("boxNextStep", () => {
  it("dice qué falta para que el motorizado salga", () => {
    expect(boxNextStep({ assigned: 0, officeChecked: 0, pickupChecked: 0, state: "draft" })).toBe("Sin paquetes");
    expect(boxNextStep({ assigned: 5, officeChecked: 2, pickupChecked: 0, state: "office_check" })).toBe("Cotejar 3 en oficina");
    expect(boxNextStep({ assigned: 5, officeChecked: 5, pickupChecked: 1, state: "pickup_check" })).toBe("Esperando que el motorizado reciba 4");
    expect(boxNextStep({ assigned: 5, officeChecked: 5, pickupChecked: 5, state: "in_custody" })).toBe("En poder del motorizado");
  });
});

describe("filterQueue (Desde la lista)", () => {
  const row = (over: Partial<QueueRow>): QueueRow => ({
    orderId: over.orderId ?? crypto.randomUUID(),
    orderName: "#KP1",
    storeName: "Aurela",
    customerName: "Ana Pérez",
    customerPhone: "+51 962 820 897",
    district: "Surco",
    orderTotal: 100,
    createdAt: "2026-09-19T14:00:00Z",
    scheduledFor: "2026-09-19",
    tariffAmount: 10,
    taken: false,
    requestId: null,
    armed: null,
    observation: null,
    hasPriorDispatch: false,
    macroStage: "preparacion",
    macroSubstage: "por_generar_rotulo",
    assignable: true,
    route: null,
    ...over,
  });
  const today = "2026-09-19";
  const rows = [
    row({ orderId: "a" }),
    row({ orderId: "b", storeName: "Kenku", district: "Miraflores", hasPriorDispatch: true, customerPhone: "51999111222", createdAt: "2026-09-18T20:00:00Z", scheduledFor: "2026-09-20" }),
    row({ orderId: "c", taken: true, requestId: "r", armed: true, createdAt: "2026-09-10T10:00:00Z", customerName: "Luis", macroStage: "por_despachar", macroSubstage: "listo_para_asignar", scheduledFor: "2026-09-17" }),
    row({ orderId: "d", taken: true, requestId: "r2", armed: false, createdAt: null, macroStage: "preparacion", macroSubstage: "por_armar" }),
  ];
  const ids = (out: QueueRow[]) => out.map((r) => r.orderId);

  it("tienda × distrito × salida previa × armados × tomados", () => {
    expect(ids(filterQueue(rows, EMPTY_QUEUE_FILTERS, today))).toEqual(["a", "b", "c", "d"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, store: "Kenku" }, today))).toEqual(["b"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, district: "Surco" }, today))).toEqual(["a", "c", "d"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, secondAttempt: true }, today))).toEqual(["b"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, armedOnly: true }, today))).toEqual(["c"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, takenOnly: true }, today))).toEqual(["c", "d"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, takenOnly: true, district: "Miraflores" }, today))).toEqual([]);
  });

  it("fecha de creación: hoy, ayer, últimos 7 días; sin fecha solo entra en «todo»", () => {
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, created: "hoy" }, today))).toEqual(["a"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, created: "ayer" }, today))).toEqual(["b"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, created: "7d" }, today))).toEqual(["a", "b"]);
    // 2026-09-19T03:00Z todavía es el 18 en Lima.
    expect(inCreatedWindow("2026-09-19T03:00:00Z", "hoy", today)).toBe(false);
    expect(inCreatedWindow("2026-09-19T03:00:00Z", "ayer", today)).toBe(true);
    expect(inCreatedWindow(null, "todo", today)).toBe(true);
  });

  it("el texto busca pedido, cliente, distrito y teléfono (con o sin espacios y prefijo)", () => {
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, query: "962 820" }, today))).toEqual(["a", "c", "d"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, query: "999111222" }, today))).toEqual(["b"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, query: "luis" }, today))).toEqual(["c"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, query: "miraflores" }, today))).toEqual(["b"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, query: "kp1", store: "Kenku" }, today))).toEqual(["b"]);
  });

  it("cuenta los filtros activos sin contar el texto; cada grupo de chips cuenta una vez", () => {
    expect(activeFilterCount(EMPTY_QUEUE_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...EMPTY_QUEUE_FILTERS, query: "x", store: "Aurela", created: "hoy", secondAttempt: true })).toBe(3);
    expect(activeFilterCount({ ...EMPTY_QUEUE_FILTERS, substages: ["por_armar", "por_generar_rotulo"], due: ["hoy"] })).toBe(2);
    expect(activeFilterCount({ ...EMPTY_QUEUE_FILTERS, stages: ["preparacion"] })).toBe(1);
  });

  it("etapas: cualquiera de las encendidas entra; se combina con subetapas y plazos", () => {
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, stages: ["por_despachar"] }, today))).toEqual(["c"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, stages: ["preparacion", "por_despachar"] }, today))).toEqual(["a", "b", "c", "d"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, stages: ["en_curso"] }, today))).toEqual([]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, stages: ["preparacion"], substages: ["por_armar"], due: ["hoy"] }, today))).toEqual(["d"]);
    expect(ids(filterQueue([row({ orderId: "z", macroStage: null, macroSubstage: null })], { ...EMPTY_QUEUE_FILTERS, stages: ["sin_etapa"] }, today))).toEqual(["z"]);
  });

  it("subetapas: cualquiera de las encendidas entra; se combinan con el resto de filtros", () => {
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, substages: ["por_armar"] }, today))).toEqual(["d"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, substages: ["por_armar", "listo_para_asignar"] }, today))).toEqual(["c", "d"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, substages: ["por_generar_rotulo"], store: "Kenku" }, today))).toEqual(["b"]);
    // Sin subetapa en el Master cae en «sin_subetapa».
    expect(ids(filterQueue([row({ orderId: "z", macroStage: null, macroSubstage: null })], { ...EMPTY_QUEUE_FILTERS, substages: ["sin_subetapa"] }, today))).toEqual(["z"]);
  });

  it("fecha pactada: vencidos, hoy y próximos según la salida prevista; varios plazos suman", () => {
    expect(scheduledBucket("2026-09-17", today)).toBe("vencido");
    expect(scheduledBucket("2026-09-19", today)).toBe("hoy");
    expect(scheduledBucket("2026-09-20", today)).toBe("proximo");
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, due: ["vencido"] }, today))).toEqual(["c"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, due: ["hoy"] }, today))).toEqual(["a", "d"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, due: ["vencido", "hoy"] }, today))).toEqual(["a", "c", "d"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, due: ["proximo"], substages: ["por_generar_rotulo"] }, today))).toEqual(["b"]);
  });

  it("toggleInList enciende y apaga sin mutar", () => {
    const base = ["a"] as const;
    expect(toggleInList(base, "b")).toEqual(["a", "b"]);
    expect(toggleInList(base, "a")).toEqual([]);
    expect(base).toEqual(["a"]);
  });

  it("las opciones de subetapa: ninguna sin etapa; con etapa, las del MOM de esa etapa y detrás lo raro que traiga una fila", () => {
    expect(queueSubstageOptions(rows, [])).toEqual([]);
    expect(queueSubstageOptions(rows, ["preparacion"]).map((o) => o.substage)).toEqual(["por_generar_rotulo", "por_armar", "incidencia_preparacion"]);
    expect(queueSubstageOptions(rows, ["por_despachar", "preparacion"]).map((o) => o.stage)).toEqual(["preparacion", "preparacion", "preparacion", "por_despachar", "por_despachar", "por_despachar", "por_despachar", "por_despachar", "por_despachar"]);
    const moved = [...rows, row({ orderId: "m", macroStage: "por_despachar", macroSubstage: "raro" }), row({ orderId: "n", macroStage: null, macroSubstage: null })];
    const opts = queueSubstageOptions(moved, ["por_despachar"]);
    expect(opts[opts.length - 1]).toEqual({ stage: "por_despachar", substage: "raro" });
    expect(opts.some((o) => o.substage === "sin_subetapa")).toBe(false);
    expect(queueSubstageOptions(moved, ["sin_etapa"])).toEqual([{ stage: null, substage: "sin_subetapa" }]);
  });

  it("cambiar de etapa apaga las subetapas que dejan de verse", () => {
    const on = { ...EMPTY_QUEUE_FILTERS, stages: ["preparacion"], substages: ["por_armar", "raro"] };
    expect(setStages(on, ["por_despachar"])).toMatchObject({ stages: ["por_despachar"], substages: ["raro"] });
    expect(setStages(on, ["por_despachar", "preparacion"]).substages).toEqual(["por_armar", "raro"]);
    expect(setStages(on, []).substages).toEqual([]);
  });

  describe("los que ya salieron (seguimiento)", () => {
    const out = [
      row({ orderId: "r1", macroStage: "en_curso", macroSubstage: "en_reparto", assignable: false, taken: true, route: { riderName: "Roy", routeDate: "2026-09-19", loadNumber: 1, state: "in_custody", officeCheckedAt: "x", pickupCheckedAt: "x" } }),
      row({ orderId: "r2", macroStage: "por_cerrar", macroSubstage: "pendiente_liquidacion", assignable: false, taken: true, route: { riderName: "Roy", routeDate: "2026-09-18", loadNumber: 1, state: "in_custody", officeCheckedAt: "x", pickupCheckedAt: "x" } }),
    ];
    const all = [...rows, ...out];
    it("un «No entregado» que sigue en la caja aparece en la cola para recibirlo en oficina", () => {
      const back = row({ orderId: "nd", macroStage: "en_curso", macroSubstage: "por_reprogramar_lima", assignable: false, taken: true, route: { riderName: "Roy", routeDate: "2026-09-19", loadNumber: 1, state: "in_custody", officeCheckedAt: "x", pickupCheckedAt: "x", undeliveredReason: "direccion_errada" } });
      expect(ids(filterQueue([...all, back], EMPTY_QUEUE_FILTERS, today))).toEqual(["a", "b", "c", "d", "nd"]);
    });
    it("sin etapa elegida la lista es la cola de asignación", () => {
      expect(ids(filterQueue(all, EMPTY_QUEUE_FILTERS, today))).toEqual(["a", "b", "c", "d"]);
      expect(ids(filterQueue(all, { ...EMPTY_QUEUE_FILTERS, query: "kp1" }, today))).toEqual(["a", "b", "c", "d"]);
    });
    it("elegir una etapa abre esa etapa entera, incluidos los que ya salieron", () => {
      expect(ids(filterQueue(all, { ...EMPTY_QUEUE_FILTERS, stages: ["en_curso"] }, today))).toEqual(["r1"]);
      expect(ids(filterQueue(all, { ...EMPTY_QUEUE_FILTERS, stages: ["en_curso", "por_cerrar"], substages: ["pendiente_liquidacion"] }, today))).toEqual(["r2"]);
      expect(ids(filterQueue(all, { ...EMPTY_QUEUE_FILTERS, stages: ["preparacion"] }, today))).toEqual(["a", "b", "d"]);
    });
    it("Etapa cuenta todos los pedidos de Grupo GF; los demás grupos cuentan lo que se ve", () => {
      const none = queueFacetCounts(all, EMPTY_QUEUE_FILTERS, today);
      expect(none.stage).toEqual({ preparacion: 3, por_despachar: 1, en_curso: 1, por_cerrar: 1 });
      expect(none.substageTotal).toBe(4);
      const inCourse = queueFacetCounts(all, { ...EMPTY_QUEUE_FILTERS, stages: ["en_curso"] }, today);
      expect(inCourse.substage).toEqual({ en_reparto: 1 });
      expect(inCourse.due).toEqual({ vencido: 0, hoy: 1, proximo: 0 });
      // Las tiles siguen contando solo la cola.
      expect(queueTileCounts(all.filter((r) => r.assignable)).por_asignar).toBe(4);
    });
  });

  it("cantidades facetadas: cada chip dice cuántas quedarían con el resto de filtros, sin contar su propio grupo", () => {
    const none = queueFacetCounts(rows, EMPTY_QUEUE_FILTERS, today);
    expect(none.stage).toEqual({ preparacion: 3, por_despachar: 1 });
    expect(none.substageTotal).toBe(4);
    expect(none.substage).toEqual({ por_generar_rotulo: 2, por_armar: 1, listo_para_asignar: 1 });
    expect(none.dueTotal).toBe(4);
    expect(none.due).toEqual({ vencido: 1, hoy: 2, proximo: 1 });
    // Con «por armar» encendido, los plazos se cuentan solo sobre d; las
    // subetapas siguen contando sobre todo (su propio grupo no se aplica).
    const armed = queueFacetCounts(rows, { ...EMPTY_QUEUE_FILTERS, substages: ["por_armar"] }, today);
    expect(armed.stage).toEqual({ preparacion: 1 });
    expect(armed.due).toEqual({ vencido: 0, hoy: 1, proximo: 0 });
    expect(armed.dueTotal).toBe(1);
    expect(armed.substage).toEqual({ por_generar_rotulo: 2, por_armar: 1, listo_para_asignar: 1 });
    // Y al revés: el plazo «hoy» reduce las subetapas a a y d.
    const due = queueFacetCounts(rows, { ...EMPTY_QUEUE_FILTERS, due: ["hoy"], store: "Aurela" }, today);
    expect(due.substage).toEqual({ por_generar_rotulo: 1, por_armar: 1 });
    // Etapa encendida: el resto de grupos cuenta solo sobre ella; ella misma no se aplica a su grupo.
    const staged = queueFacetCounts(rows, { ...EMPTY_QUEUE_FILTERS, stages: ["por_despachar"] }, today);
    expect(staged.stage).toEqual({ preparacion: 3, por_despachar: 1 });
    expect(staged.substage).toEqual({ listo_para_asignar: 1 });
    expect(staged.due).toEqual({ vencido: 1, hoy: 0, proximo: 0 });
    expect(due.substageTotal).toBe(2);
    expect(due.due).toEqual({ vencido: 1, hoy: 2, proximo: 0 });
  });
});

describe("estado de cada paquete en la caja (segmentos de «Pedidos tomados»)", () => {
  const armed = { order_id: "o", order_name: "#A", customer_name: "A", district: "D", output_code: "c", guide_code: "g", preparation_state: "listo_despacho" };
  const raw = { ...armed, preparation_state: "en_armado" };
  it("la etapa más avanzada manda, y «no lo llevó» sobre todo", () => {
    expect(packageStage(item({ shipment: raw }))).toBe("por_armar");
    expect(packageStage(item({ shipment: armed }))).toBe("armado");
    expect(packageStage(item({ shipment: armed, office_checked_at: "x" }))).toBe("cotejado");
    expect(packageStage(item({ shipment: armed, office_checked_at: "x", pickup_checked_at: "x" }))).toBe("confirmado");
    expect(packageStage(item({ shipment: armed, pickup_checked_at: "x", pickup_declined_at: "x" }))).toBe("no_lo_llevo");
  });
  it("filtro rápido: por armar · listos para cotejo · sin confirmar, solo activos", () => {
    const items = [
      item({ id: "1", shipment: raw }),
      item({ id: "2", shipment: armed }),
      item({ id: "3", shipment: armed, office_checked_at: "x" }),
      item({ id: "4", shipment: armed, office_checked_at: "x", pickup_checked_at: "x" }),
      item({ id: "5", shipment: armed, removed_at: "x" }),
    ];
    const ids = (f: Parameters<typeof filterBoxItems>[1]) => filterBoxItems(items, f).map((i) => i.id);
    expect(ids("todos")).toEqual(["1", "2", "3", "4"]);
    expect(ids("por_armar")).toEqual(["1"]);
    expect(ids("listos_cotejo")).toEqual(["2"]);
    expect(ids("sin_confirmar")).toEqual(["1", "2", "3"]);
  });
  it("la caja cuenta armados además de cotejados y confirmados", () => {
    const boxes = dayBoxes([manifest({ items: [item({ shipment: armed, office_checked_at: "x" }), item({ shipment_id: "s2", shipment: raw })] })], "2026-09-19");
    expect(boxes[0]).toMatchObject({ assigned: 2, armed: 1, officeChecked: 1, pickupChecked: 0 });
  });
});

describe("tiles de métricas → filtros", () => {
  const row = (over: Partial<QueueRow>): QueueRow => ({
    orderId: over.orderId ?? crypto.randomUUID(), orderName: "#K", storeName: "A", customerName: "C", customerPhone: null, district: "D",
    orderTotal: 1, createdAt: null, scheduledFor: "2026-09-19", tariffAmount: 1, taken: false, requestId: null, armed: null, observation: null, hasPriorDispatch: false, macroStage: "preparacion", macroSubstage: "por_armar", assignable: true, route: null, ...over,
  });
  it("cuenta cada tile sobre la cola y sobre las cajas", () => {
    const rows = [row({}), row({ taken: true, armed: true }), row({ taken: true, armed: false }), row({ hasPriorDispatch: true })];
    expect(queueTileCounts(rows)).toEqual({ por_asignar: 4, tomados_sin_caja: 2, armados: 1, segundo_intento: 1 });
    const armed = { order_id: "o", order_name: "#A", customer_name: "A", district: "D", output_code: "c", guide_code: "g", preparation_state: "listo_despacho" };
    const boxes = dayBoxes([manifest({ items: [item({ shipment: armed }), item({ shipment_id: "s2", shipment: { ...armed, preparation_state: "en_armado" } }), item({ shipment_id: "s3", shipment: armed, office_checked_at: "x", pickup_checked_at: "x" })] })], "2026-09-19");
    expect(boxTileCounts(boxes)).toEqual({ por_armar: 1, listos_cotejo: 1, sin_confirmar: 2 });
  });
  it("tocar enciende el filtro, volver a tocar lo apaga; «Por asignar» limpia todo menos el texto", () => {
    const on = toggleQueueTile({ ...EMPTY_QUEUE_FILTERS, query: "ana", store: "A" }, "segundo_intento");
    expect(on).toMatchObject({ secondAttempt: true, store: "A", query: "ana" });
    expect(queueTileActive(on, "segundo_intento")).toBe(true);
    expect(toggleQueueTile(on, "segundo_intento").secondAttempt).toBe(false);
    expect(toggleQueueTile(on, "tomados_sin_caja")).toMatchObject({ takenOnly: true, secondAttempt: true });
    expect(toggleQueueTile(toggleQueueTile(on, "armados"), "armados").armedOnly).toBe(false);
    expect(toggleQueueTile(on, "por_asignar")).toEqual({ ...EMPTY_QUEUE_FILTERS, query: "ana" });
    expect(queueTileActive(EMPTY_QUEUE_FILTERS, "por_asignar")).toBe(false);
    expect(toggleBoxTile("todos", "por_armar")).toBe("por_armar");
    expect(toggleBoxTile("por_armar", "por_armar")).toBe("todos");
    expect(toggleBoxTile("por_armar", "sin_confirmar")).toBe("sin_confirmar");
  });
});
