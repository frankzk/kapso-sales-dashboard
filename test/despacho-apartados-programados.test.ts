import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEPARTURE_EVENT_KINDS,
  EMPTY_QUEUE_FILTERS,
  filterQueue,
  programDayLabel,
  programNeedsConfirm,
  QUEUE_SEGMENTS,
  queueFacetCounts,
  queueSegment,
  setStages,
  sortQueue,
  STALE_AFTER_DAYS,
  type QueueRow,
} from "@/lib/dispatch-day";

/**
 * «Si quiero dejar un pedido programado para otro día, o para un día en
 * especial, cuando llegue ese día ¿cómo sé cuál es la lista de los
 * programados? Y ¿cómo sé cuáles no han salido ni una sola vez, versus los
 * que han salido alguna vez? Dar prioridad siempre a los que nunca salieron.»
 *
 * Respuestas de Frankz (29-09-2026): un apartado como «Sin llamar» que se
 * busca dejar en cero; programar solo guarda la fecha; asignar un programado
 * a otro día avisa y pide confirmar; lo de más de 30 días va después de lo
 * reciente. Medido ese día: 1.863 pedidos en cola, 0 con «salida previa».
 */

const today = "2026-09-29";

const row = (over: Partial<QueueRow>): QueueRow => ({
  orderId: over.orderId ?? crypto.randomUUID(),
  orderName: "#KP1",
  storeName: "Kenku",
  customerName: "Ana",
  customerPhone: null,
  district: "Surco",
  orderTotal: 100,
  createdAt: "2026-09-28T15:00:00Z",
  scheduledFor: today,
  tariffAmount: 10,
  taken: false,
  requestId: null,
  armed: null,
  observation: null,
  hasPriorDispatch: false,
  programmedFor: null,
  macroStage: "preparacion",
  macroSubstage: "por_generar_rotulo",
  assignable: true,
  route: null,
  ...over,
});

describe("cada pedido asignable cae en un solo apartado", () => {
  it("separa hoy y vencidos, mañana y fechas posteriores", () => {
    expect(queueSegment(row({ programmedFor: today }), today)).toBe("programados_hoy");
    expect(queueSegment(row({ programmedFor: "2026-09-27" }), today)).toBe("programados_hoy");
    expect(queueSegment(row({ programmedFor: "2026-09-30" }), today)).toBe("programados_manana");
    expect(queueSegment(row({ programmedFor: "2026-10-02" }), today)).toBe("programados_despues");
  });

  it.each([
    ["2026-09-30", "2026-10-01"],
    ["2026-12-31", "2027-01-01"],
    ["2028-02-28", "2028-02-29"],
    ["2028-02-29", "2028-03-01"],
  ])("mañana cruza correctamente de %s a %s", (day, nextDay) => {
    expect(queueSegment(row({ programmedFor: nextDay }), day)).toBe("programados_manana");
  });

  it("la fecha programada pasa de después a mañana y luego a hoy", () => {
    const scheduled = row({ programmedFor: "2026-10-02" });
    expect(queueSegment(scheduled, "2026-09-30")).toBe("programados_despues");
    expect(queueSegment(scheduled, "2026-10-01")).toBe("programados_manana");
    expect(queueSegment(scheduled, "2026-10-02")).toBe("programados_hoy");
  });

  it("la programación manda sobre «ya salió» y sobre la antigüedad", () => {
    expect(queueSegment(row({ programmedFor: "2026-09-30", hasPriorDispatch: true, createdAt: "2026-06-01T12:00:00Z" }), today)).toBe("programados_manana");
    expect(queueSegment(row({ programmedFor: "2026-10-02", hasPriorDispatch: true }), today)).toBe("programados_despues");
    expect(queueSegment(row({ programmedFor: today, createdAt: "2026-06-01T12:00:00Z" }), today)).toBe("programados_hoy");
  });

  it("salió alguna vez → «Ya salieron», aunque sea viejo", () => {
    expect(queueSegment(row({ hasPriorDispatch: true, createdAt: "2026-06-01T12:00:00Z" }), today)).toBe("ya_salieron");
  });

  it(`nunca salió: «Nunca salieron» hasta ${STALE_AFTER_DAYS} días; después, «+30 días»`, () => {
    // 29-09 menos 30 días es el 30-08, en el día de Lima.
    expect(queueSegment(row({ createdAt: "2026-08-30T15:00:00Z" }), today)).toBe("nunca_salieron");
    expect(queueSegment(row({ createdAt: "2026-08-29T15:00:00Z" }), today)).toBe("mas_de_30");
    // 2026-08-30T03:00Z todavía es el 29-08 en Lima.
    expect(queueSegment(row({ createdAt: "2026-08-30T03:00:00Z" }), today)).toBe("mas_de_30");
  });

  it("sin fecha de creación no se esconde en «+30 días»", () => {
    expect(queueSegment(row({ createdAt: null }), today)).toBe("nunca_salieron");
  });
});

describe("el orden de la lista es el de los apartados", () => {
  const rows = [
    row({ orderId: "viejo", createdAt: "2026-07-01T12:00:00Z" }),
    row({ orderId: "futuro-2", programmedFor: "2026-10-03" }),
    row({ orderId: "manana", programmedFor: "2026-09-30" }),
    row({ orderId: "reintento", hasPriorDispatch: true }),
    row({ orderId: "nuevo-ayer", createdAt: "2026-09-28T12:00:00Z" }),
    row({ orderId: "seguimiento", assignable: false, route: { riderName: "Roy", routeDate: today, loadNumber: 1, state: "in_custody", officeCheckedAt: null, pickupCheckedAt: null, undeliveredReason: "no_estaba" } }),
    row({ orderId: "hoy", programmedFor: today }),
    row({ orderId: "nuevo-hoy", createdAt: "2026-09-29T14:00:00Z" }),
    row({ orderId: "vencido", programmedFor: "2026-09-26" }),
    row({ orderId: "futuro-1", programmedFor: "2026-10-01" }),
  ];

  it("programados hoy (vencidos primero) → mañana → nunca salieron (recientes primero) → ya salieron → +30 días → programados después → lo que no se asigna", () => {
    expect(sortQueue(rows, today).map((r) => r.orderId)).toEqual([
      "vencido", "hoy", "manana", "nuevo-hoy", "nuevo-ayer", "reintento", "viejo", "futuro-1", "futuro-2", "seguimiento",
    ]);
  });

  it("no muta la lista de entrada", () => {
    const before = rows.map((r) => r.orderId);
    sortQueue(rows, today);
    expect(rows.map((r) => r.orderId)).toEqual(before);
  });

  it("los apartados van en ese mismo orden en la fila de chips", () => {
    expect(QUEUE_SEGMENTS).toEqual(["programados_hoy", "programados_manana", "nunca_salieron", "ya_salieron", "mas_de_30", "programados_despues"]);
  });
});

describe("el apartado filtra y cuenta como un chip más", () => {
  const rows = [
    row({ orderId: "a" }),
    row({ orderId: "b", hasPriorDispatch: true }),
    row({ orderId: "c", programmedFor: today }),
    row({ orderId: "d", createdAt: "2026-07-01T12:00:00Z", storeName: "Aurela" }),
    // Un «No entregado» en la caja se ve en la cola, pero no es de ningún apartado.
    row({ orderId: "nd", assignable: false, hasPriorDispatch: true, route: { riderName: "Roy", routeDate: today, loadNumber: 1, state: "in_custody", officeCheckedAt: "x", pickupCheckedAt: "x", undeliveredReason: "no_estaba" } }),
  ];
  const ids = (out: QueueRow[]) => out.map((r) => r.orderId);

  it("un apartado solo reúne pedidos que se pueden asignar", () => {
    expect(ids(filterQueue(rows, EMPTY_QUEUE_FILTERS, today))).toEqual(["a", "b", "c", "d", "nd"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, segment: "ya_salieron" }, today))).toEqual(["b"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, segment: "programados_hoy" }, today))).toEqual(["c"]);
    expect(ids(filterQueue(rows, { ...EMPTY_QUEUE_FILTERS, segment: "mas_de_30" }, today))).toEqual(["d"]);
  });

  it("cada chip dice cuántos hay con el resto de filtros; «Todos» es lo que muestra la lista sin apartado", () => {
    const all = queueFacetCounts(rows, { ...EMPTY_QUEUE_FILTERS, segment: "nunca_salieron" }, today);
    expect(all.segment).toEqual({ programados_hoy: 1, programados_manana: 0, nunca_salieron: 1, ya_salieron: 1, mas_de_30: 1, programados_despues: 0 });
    expect(all.segmentTotal).toBe(5);
    const aurela = queueFacetCounts(rows, { ...EMPTY_QUEUE_FILTERS, store: "Aurela" }, today);
    expect(aurela.segment.mas_de_30).toBe(1);
    expect(aurela.segment.nunca_salieron).toBe(0);
  });

  it("elegir una etapa (seguimiento) apaga el apartado", () => {
    expect(setStages({ ...EMPTY_QUEUE_FILTERS, segment: "nunca_salieron" }, ["en_curso"]).segment).toBeNull();
    expect(setStages({ ...EMPTY_QUEUE_FILTERS, segment: "nunca_salieron" }, []).segment).toBe("nunca_salieron");
  });

  it("mañana filtra y cuenta solo asignables, sin duplicarlos en después ni ignorar la tienda", () => {
    const scheduled = [
      row({ orderId: "manana-kenku", programmedFor: "2026-09-30" }),
      row({ orderId: "manana-aurela", programmedFor: "2026-09-30", storeName: "Aurela" }),
      row({ orderId: "despues", programmedFor: "2026-10-01" }),
      row({ orderId: "seguimiento", programmedFor: "2026-09-30", assignable: false }),
    ];
    const filters = { ...EMPTY_QUEUE_FILTERS, segment: "programados_manana" as const };
    expect(ids(filterQueue(scheduled, filters, today))).toEqual(["manana-kenku", "manana-aurela"]);
    const counts = queueFacetCounts(scheduled, filters, today);
    expect(counts.segment.programados_manana).toBe(2);
    expect(counts.segment.programados_despues).toBe(1);
    expect(Object.values(counts.segment).reduce((sum, count) => sum + count, 0)).toBe(3);
    const kenku = { ...filters, store: "Kenku" };
    expect(ids(filterQueue(scheduled, kenku, today))).toEqual(["manana-kenku"]);
    expect(queueFacetCounts(scheduled, kenku, today).segment.programados_manana).toBe(1);
  });
});

describe("asignar un programado a otro día pide confirmar", () => {
  it("programado para otro día futuro, o para hoy en la caja de mañana: confirmar", () => {
    expect(programNeedsConfirm("2026-10-02", today, today)).toBe(true);
    expect(programNeedsConfirm(today, "2026-09-30", today)).toBe(true);
    expect(programNeedsConfirm("2026-10-02", "2026-10-03", today)).toBe(true);
  });

  it("el mismo día de la caja, sin programar o vencido: no pregunta", () => {
    expect(programNeedsConfirm(today, today, today)).toBe(false);
    expect(programNeedsConfirm("2026-10-02", "2026-10-02", today)).toBe(false);
    expect(programNeedsConfirm(null, today, today)).toBe(false);
    // Vencido: que salga es justo lo que falta.
    expect(programNeedsConfirm("2026-09-26", today, today)).toBe(false);
  });

  it("el día se dice como en la operación: «vie 02/10»", () => {
    expect(programDayLabel("2026-10-02")).toBe("vie 02/10");
    expect(programDayLabel("2026-09-29")).toBe("mar 29/09");
  });
});

describe("salir a reparto es salir de verdad", () => {
  const sql = readFileSync(resolve(process.cwd(), "db/migrations/0199_gf_dispatch_programs.sql"), "utf8");

  it("la función SQL y la constante listan los mismos eventos", () => {
    const listed = /e\.kind in \(([^)]*)\)/.exec(sql)?.[1] ?? "";
    const kinds = [...listed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(kinds.sort()).toEqual([...DEPARTURE_EVENT_KINDS].sort());
  });

  /**
   * En el modo «confirmar» la custodia pasa al asignar. #AUR176041 recibió
   * `custody_transferred` dos veces el 19-09 y el paquete nunca salió del
   * almacén: contarlo sería mandar un pedido nuevo a «Ya salieron».
   */
  it("la custodia al asignar no es una salida", () => {
    expect(DEPARTURE_EVENT_KINDS).not.toContain("custody_transferred" as never);
    expect(DEPARTURE_EVENT_KINDS).not.toContain("dispatch_route_assigned" as never);
  });

  it("también cuentan las rutas anteriores y los otros couriers", () => {
    expect(sql).toContain("d.reported_at is not null");
    expect(sql).toContain("s.dispatched_at is not null");
  });
});

describe("el servidor: programar no toma, y asignar confirma", () => {
  const action = readFileSync(resolve(process.cwd(), "app/dashboard/courier/actions.ts"), "utf8");
  const body = (name: string) => {
    const start = action.indexOf(`export async function ${name}(`);
    const next = action.indexOf("\nexport async function ", start + 1);
    return action.slice(start, next === -1 ? undefined : next);
  };

  it("programar solo guarda la fecha, con permiso de despacho y motivo", () => {
    const program = body("rescheduleGroupGfCourierOrders");
    expect(program).not.toContain("takeOrdersCore");
    expect(program).toContain("if (!auth.canManageDispatch)");
    expect(program).toContain("Escribe el motivo");
    expect(program).toContain('.from("gf_dispatch_programs").upsert(');
    expect(program).toContain('kind: "dispatch_programmed"');
  });

  it("«en caja» es tener un paquete activo en una caja, no el estado de la solicitud", () => {
    const program = body("rescheduleGroupGfCourierOrders");
    expect(program).toContain('.from("dispatch_manifest_items").select("shipment_id")');
    expect(program).not.toContain('request.status === "scheduled"');
  });

  it("la lista mira la programación ANTES de tomar", () => {
    const takeAndAssign = body("takeAndAssignGroupGfCourierOrders");
    expect(takeAndAssign.indexOf("programConflicts(")).toBeGreaterThan(-1);
    expect(takeAndAssign.indexOf("programConflicts(")).toBeLessThan(takeAndAssign.indexOf("takeGroupGfCourierOrders("));
  });

  it("el QR avisa antes de tomar y ofrece «Asignar igual»", () => {
    const scan = body("scanAssignToRider");
    expect(scan).toContain('status: "programado_otro_dia"');
    expect(scan.indexOf('status: "programado_otro_dia"')).toBeLessThan(scan.indexOf("takeOrdersCore("));
  });

  it("la caja comprueba antes de mover la fecha prevista y cierra la programación al asignar", () => {
    const start = action.indexOf("async function assignRouteCore(");
    const core = action.slice(start, action.indexOf("async function routeCashForecast(", start));
    expect(core.indexOf("programNeedsConfirm(")).toBeGreaterThan(-1);
    expect(core.indexOf("programNeedsConfirm(")).toBeLessThan(core.indexOf('kind: "logistics_request_rescheduled"'));
    expect(core).toContain("await settlePrograms(admin, auth.userId, settled)");
    expect(action).toContain('kind: "dispatch_program_overridden"');
  });

  it("la cola lee la salida real y lo programado", () => {
    expect(action).toContain('admin.rpc("gf_order_departures"');
    expect(action).toContain("programmedFor: program?.scheduled_for ?? null");
  });
});

describe("la pantalla", () => {
  const board = readFileSync(resolve(process.cwd(), "components/dispatch-day-board.tsx"), "utf8");
  const drawer = readFileSync(resolve(process.cwd(), "components/gf-box-add-packages.tsx"), "utf8");
  const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");

  it("ordena por apartado y muestra la fila de apartados", () => {
    expect(board).toContain("sortQueue(filterQueue(allRows, filters, day), day)");
    expect(board).toContain('aria-label="Apartados de la cola"');
  });

  it("pregunta antes de asignar un programado a otro día, desde la lista y por QR", () => {
    expect(board).toContain("programNeedsConfirm(q.programmedFor, scanDay, day)");
    expect(board).toContain("Asignar igual {target}");
    expect(board).toContain("confirmProgrammed: true");
    expect(drawer).toContain('l.status === "programado_otro_dia"');
  });

  it("programar pide motivo y se puede deshacer", () => {
    expect(board).toContain('title="Programar salida"');
    expect(board).toContain("clearGroupGfCourierPrograms");
    expect(board).not.toContain("Solo con salida previa");
  });

  it("el MOM lo documenta", () => {
    expect(mom).toContain("Programar la salida sin tomar el pedido (29-09-2026)");
    expect(mom).toContain("Apartados de la cola: nunca salieron, ya salieron y programados");
    expect(mom).toContain("**`custody_transferred` no\ncuenta**");
  });
});
