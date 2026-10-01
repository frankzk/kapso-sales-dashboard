import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeRoutePayout,
  groupByStore,
  isForceableBlocker,
  masterEffects,
  missingEvidenceMessage,
  nonDeliveryNeedsPhoto,
  REJECTION_PHOTO_FROM,
  rejectionNeedsPhoto,
  routeCloseBlockerMessage,
  routeCloseBlockers,
  stopEffect,
  routeTotals,
  stopsMissingEvidence,
  stopsNotReceived,
  stopsToSettlementLines,
  validateStopReport,
  type OpenLoad,
  type RouteStop,
  type StopReport,
} from "@/lib/routes";
import type { CostContext, CostTariff } from "@/lib/costs";

function report(over: Partial<StopReport> = {}): StopReport {
  return {
    status: over.status ?? "entregado",
    paymentMethod: over.paymentMethod !== undefined ? over.paymentMethod : "efectivo",
    collectedAmount: over.collectedAmount !== undefined ? over.collectedAmount : 100,
    outcomeReason: over.outcomeReason !== undefined ? over.outcomeReason : null,
    note: over.note !== undefined ? over.note : null,
    hasPhoto: over.hasPhoto ?? true,
    hasVoucher: over.hasVoucher ?? false,
  };
}

function stop(over: Partial<RouteStop> = {}): RouteStop {
  return {
    id: over.id ?? "s1",
    order_id: over.order_id ?? "o1",
    status: over.status ?? "entregado",
    payment_method: over.payment_method !== undefined ? over.payment_method : "efectivo",
    collected_amount: over.collected_amount !== undefined ? over.collected_amount : 100,
  };
}

const CTX: CostContext = {
  storeId: "store-a",
  courier: null,
  region: "Lima",
  province: "Lima",
  district: "Miraflores",
};

function tariff(over: Partial<CostTariff> = {}): CostTariff {
  return {
    id: over.id ?? "t1",
    store_id: over.store_id !== undefined ? over.store_id : null,
    courier: over.courier !== undefined ? over.courier : null,
    region: over.region !== undefined ? over.region : null,
    province: over.province !== undefined ? over.province : null,
    district: over.district !== undefined ? over.district : null,
    concept: over.concept ?? "motorizado_entrega",
    amount: over.amount ?? 8.5,
    effective_from: over.effective_from ?? "2026-01-01",
    effective_to: over.effective_to !== undefined ? over.effective_to : null,
  };
}

describe("validateStopReport", () => {
  it("acepta una entrega completa", () => {
    expect(validateStopReport(report()).ok).toBe(true);
  });

  it("una entrega sin método de cobro no pasa", () => {
    // Sin método, la liquidación queda con un agujero silencioso.
    const v = validateStopReport(report({ paymentMethod: null }));
    expect(v.ok).toBe(false);
    expect(v.errors).toContain("Indica cómo cobraste.");
  });

  it("una entrega cobrada sin monto no pasa", () => {
    const v = validateStopReport(report({ collectedAmount: null }));
    expect(v.ok).toBe(false);
    expect(v.errors).toContain("Escribe cuánto cobraste.");
    expect(validateStopReport(report({ collectedAmount: 0 })).ok).toBe(false);
  });

  it("cobrar por Yape exige la captura", () => {
    const sin = validateStopReport(report({ paymentMethod: "yape", hasVoucher: false }));
    expect(sin.ok).toBe(false);
    expect(sin.errors).toContain("Adjunta la captura del Yape.");
    expect(validateStopReport(report({ paymentMethod: "yape", hasVoucher: true })).ok).toBe(true);
  });

  it("toda entrega exige la foto", () => {
    const v = validateStopReport(report({ hasPhoto: false }));
    expect(v.ok).toBe(false);
    expect(v.errors).toContain("Adjunta la foto de la entrega.");
  });

  it("un pedido ya pagado se entrega sin monto", () => {
    // "sin_cobro" es el caso del pedido prepagado: hay entrega, no hay plata.
    const v = validateStopReport(
      report({ paymentMethod: "sin_cobro", collectedAmount: 0 }),
    );
    expect(v.ok).toBe(true);
  });

  it("una no entrega exige motivo del catálogo", () => {
    const sin = validateStopReport(
      report({ status: "no_entregado", paymentMethod: null, collectedAmount: null }),
    );
    expect(sin.ok).toBe(false);
    expect(sin.errors).toContain("Indica por qué no se entregó.");

    const con = validateStopReport(
      report({
        status: "no_entregado",
        paymentMethod: null,
        collectedAmount: null,
        outcomeReason: "no_contesta",
        hasPhoto: false,
      }),
    );
    expect(con.ok).toBe(true); // una no-entrega no exige foto
  });

  // 28-09-2026: de 204 rechazos, ninguno tenía foto. El teléfono no la pedía y
  // la liquidación la exigía días después. Ahora se pide al reportar.
  it("un rechazo exige la foto; las otras no entregas no", () => {
    const rechazo = { status: "no_entregado" as const, paymentMethod: null, collectedAmount: null, outcomeReason: "rechazado" };
    const sin = validateStopReport(report({ ...rechazo, hasPhoto: false }));
    expect(sin.ok).toBe(false);
    expect(sin.errors).toContain("Adjunta la foto del rechazo.");
    expect(validateStopReport(report({ ...rechazo, hasPhoto: true })).ok).toBe(true);
    for (const outcomeReason of ["no_contesta", "no_estaba", "reprogramado", "direccion_errada", "sin_dinero"]) {
      expect(validateStopReport(report({ ...rechazo, outcomeReason, hasPhoto: false })).ok, outcomeReason).toBe(true);
    }
  });

  it("el teléfono muestra el campo de foto en el rechazo, y en todo si reporta otra persona", () => {
    expect(nonDeliveryNeedsPhoto("rechazado", false)).toBe(true);
    expect(nonDeliveryNeedsPhoto("no_contesta", false)).toBe(false);
    expect(nonDeliveryNeedsPhoto("", false)).toBe(false);
    expect(nonDeliveryNeedsPhoto(null, false)).toBe(false);
    expect(nonDeliveryNeedsPhoto("no_contesta", true)).toBe(true);
  });

  it("'otro' exige explicar en la nota", () => {
    const v = validateStopReport(
      report({
        status: "no_entregado",
        paymentMethod: null,
        collectedAmount: null,
        outcomeReason: "otro",
      }),
    );
    expect(v.ok).toBe(false);
    expect(v.errors).toContain("Escribe en la nota qué pasó.");
  });

  it("no entregar y declarar dinero es una contradicción", () => {
    const v = validateStopReport(
      report({ status: "no_entregado", outcomeReason: "no_contesta", collectedAmount: 50 }),
    );
    expect(v.ok).toBe(false);
    expect(v.errors).toContain("Marcaste que no se entregó pero declaraste dinero cobrado.");
  });

  it("dejar la parada pendiente no es un reporte", () => {
    expect(validateStopReport(report({ status: "pendiente" })).ok).toBe(false);
  });
});

describe("routeTotals", () => {
  const stops = [
    stop({ id: "a", payment_method: "efectivo", collected_amount: 100 }),
    stop({ id: "b", payment_method: "efectivo", collected_amount: 50 }),
    stop({ id: "c", payment_method: "yape", collected_amount: 80 }),
    stop({ id: "d", payment_method: "pos", collected_amount: 30 }),
    stop({ id: "e", status: "no_entregado", payment_method: null, collected_amount: null }),
    stop({ id: "f", status: "pendiente", payment_method: null, collected_amount: null }),
  ];

  it("separa lo cobrado por método", () => {
    const t = routeTotals(stops);
    expect(t.efectivo).toBe(150);
    expect(t.yape).toBe(80);
    expect(t.pos).toBe(30);
    expect(t.cobradoTotal).toBe(260);
  });

  it("cuenta las paradas por estado", () => {
    const t = routeTotals(stops);
    expect(t.total).toBe(6);
    expect(t.entregados).toBe(4);
    expect(t.noEntregados).toBe(1);
    expect(t.pendientes).toBe(1);
    expect(t.completa).toBe(false);
  });

  it("la ruta está completa cuando no queda nada pendiente", () => {
    expect(routeTotals(stops.filter((s) => s.status !== "pendiente")).completa).toBe(true);
    // Una ruta vacía no está "completa": no hay nada que cerrar.
    expect(routeTotals([]).completa).toBe(false);
  });
});

describe("computeRoutePayout", () => {
  const day = "2026-07-27";

  it("paga la tarifa plana por entrega", () => {
    const stops = [stop({ id: "a" }), stop({ id: "b" }), stop({ id: "c", status: "no_entregado" })];
    const p = computeRoutePayout(stops, [tariff({ amount: 8.5 })], CTX, day);
    expect(p.entregas).toBe(2);
    expect(p.visitas).toBe(1);
    expect(p.amount).toBe(17); // 2 × 8.50; la visita no se paga si no hay tarifa
    expect(p.missingTariffs).toBe(0);
  });

  it("paga la visita solo si hay tarifa configurada", () => {
    const stops = [stop({ id: "a" }), stop({ id: "b", status: "no_entregado" })];
    const p = computeRoutePayout(
      stops,
      [tariff({ amount: 8.5 }), tariff({ id: "v", concept: "motorizado_visita", amount: 3 })],
      CTX,
      day,
    );
    expect(p.amount).toBe(11.5); // 8.50 + 3.00
  });

  it("sin tarifa de entrega avisa, en vez de pagar cero en silencio", () => {
    const p = computeRoutePayout([stop()], [], CTX, day);
    expect(p.amount).toBe(0);
    expect(p.missingTariffs).toBe(1);
  });

  it("una tarifa que aún no regía ese día no se usa", () => {
    const p = computeRoutePayout(
      [stop()],
      [tariff({ amount: 9, effective_from: "2026-08-01" })],
      CTX,
      day,
    );
    expect(p.amount).toBe(0);
    expect(p.missingTariffs).toBe(1);
  });

  it("una ruta sin entregas no reclama tarifa", () => {
    const p = computeRoutePayout([stop({ status: "no_entregado" })], [], CTX, day);
    expect(p.missingTariffs).toBe(0);
  });
});

describe("stopsToSettlementLines", () => {
  it("las líneas nacen ya vinculadas: sin cola de revisión", () => {
    const lines = stopsToSettlementLines([
      stop({ id: "a", order_id: "o1", collected_amount: 100 }),
      stop({ id: "b", order_id: "o2", status: "no_entregado", payment_method: null, collected_amount: null }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.match_status === "ok")).toBe(true);
    expect(lines[0]).toMatchObject({ order_id: "o1", declared_amount: 100 });
  });

  it("una no entrega declara cero, no 'no lo declaró'", () => {
    // 0 = "reportó que no cobró"; null sería "no lo reportó". Son distintos.
    const lines = stopsToSettlementLines([
      stop({ status: "no_entregado", payment_method: null, collected_amount: null }),
    ]);
    expect(lines[0]!.declared_amount).toBe(0);
  });

  it("las paradas sin reportar no entran en la liquidación", () => {
    const lines = stopsToSettlementLines([stop({ status: "pendiente" })]);
    expect(lines).toHaveLength(0);
  });
});

describe("stopEffect y masterEffects", () => {
  it("una entrega mueve el pedido a entregado", () => {
    // Es el hueco que esto tapa: con motorizado propio no viene detrás el
    // reporte de ningún courier, así que sin esto el pedido se quedaría
    // "pendiente" y el cuadre lo marcaría como "cobro sin entrega".
    expect(stopEffect({ status: "entregado" })).toBe("entregado");
  });

  it("el rechazo tampoco cierra el pedido: solo Shopify anula (v1.23)", () => {
    expect(stopEffect({ status: "no_entregado", outcome_reason: "rechazado" })).toBeNull();
  });

  it("los motivos de reintento NO tocan el pedido", () => {
    // Cerrar un pedido por error cuesta una venta; dejarlo abierto solo cuesta
    // otra visita. Ante la duda, no se cierra.
    for (const reason of ["no_contesta", "no_estaba", "reprogramado", "sin_dinero", "direccion_errada", "otro"]) {
      expect(stopEffect({ status: "no_entregado", outcome_reason: reason })).toBeNull();
    }
    expect(stopEffect({ status: "no_entregado", outcome_reason: null })).toBeNull();
  });

  it("una parada sin reportar no toca nada", () => {
    expect(stopEffect({ status: "pendiente" })).toBeNull();
  });

  it("masterEffects devuelve solo lo que cambia, con su motivo", () => {
    const effects = masterEffects([
      { order_id: "o1", status: "entregado" },
      { order_id: "o2", status: "no_entregado", outcome_reason: "rechazado" },
      { order_id: "o3", status: "no_entregado", outcome_reason: "no_contesta" },
      { order_id: "o4", status: "pendiente" },
    ]);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ order_id: "o1", target: "entregado" });
    expect(effects.every((e) => e.reason.length > 0)).toBe(true);
  });
});

describe("groupByStore", () => {
  it("una ruta mixta se parte por tienda", () => {
    // El viaje es uno, pero el dinero y el cuadre son por tienda: cerrarla
    // produce una liquidación por cada una.
    const grouped = groupByStore([
      { store_id: "aurela", id: "a" },
      { store_id: "kenku", id: "b" },
      { store_id: "aurela", id: "c" },
    ]);
    expect([...grouped.keys()].sort()).toEqual(["aurela", "kenku"]);
    expect(grouped.get("aurela")).toHaveLength(2);
    expect(grouped.get("kenku")).toHaveLength(1);
  });

  it("una parada sin tienda no se pierde en un grupo falso", () => {
    const grouped = groupByStore([{ store_id: null, id: "a" }, { store_id: "kenku", id: "b" }]);
    expect(grouped.size).toBe(1);
    expect(grouped.has("kenku")).toBe(true);
  });
});

// La ruta de Yhoni del 23/09 no se podía liquidar por UNA parada: el rechazo de
// #KP136057 sin foto. El error decía «Falta evidencia de entrega o rechazo» y
// había que revisar las 19 filas para encontrarla.
describe("liquidar: qué paradas no tienen foto, con su pedido", () => {
  const parada = (over: Partial<{ seq: number; status: string; outcome_reason: string | null; photo_path: string | null; name: string | null }>) => ({
    seq: over.seq ?? 1,
    status: over.status ?? "entregado",
    outcome_reason: over.outcome_reason ?? null,
    photo_path: over.photo_path ?? null,
    order: { name: over.name === undefined ? "#KP1" : over.name },
  });

  it("cuenta las entregas y los rechazos sin foto, nada más", () => {
    const stops = [
      parada({ seq: 1, status: "entregado", photo_path: "f.jpg" }),
      parada({ seq: 2, status: "entregado", name: "#KP2" }),
      parada({ seq: 3, status: "no_entregado", outcome_reason: "rechazado", name: "#KP136057" }),
      parada({ seq: 4, status: "no_entregado", outcome_reason: "no_contesta", name: "#KP4" }),
      parada({ seq: 5, status: "no_entregado", outcome_reason: "rechazado", photo_path: "r.jpg", name: "#KP5" }),
    ];
    expect(stopsMissingEvidence(stops, "2026-09-28").map((s) => s.seq)).toEqual([2, 3]);
  });

  // Decisión de Frankz (28-09-2026): hasta el 27/09 el teléfono no pedía foto
  // al rechazar, así que esos rechazos no la exigen. La entrega, siempre.
  it("un rechazo de una ruta anterior al 28/09 no exige foto; la entrega sí", () => {
    const stops = [
      parada({ seq: 2, status: "entregado", name: "#KP2" }),
      parada({ seq: 3, status: "no_entregado", outcome_reason: "rechazado", name: "#KP136057" }),
    ];
    expect(REJECTION_PHOTO_FROM).toBe("2026-09-28");
    expect(stopsMissingEvidence(stops, "2026-09-27").map((s) => s.seq)).toEqual([2]);
    expect(stopsMissingEvidence(stops, "2026-09-23").map((s) => s.seq)).toEqual([2]);
    expect(stopsMissingEvidence(stops, "2026-09-28").map((s) => s.seq)).toEqual([2, 3]);
    expect(stopsMissingEvidence(stops, "2026-10-01").map((s) => s.seq)).toEqual([2, 3]);
    expect(rejectionNeedsPhoto("2026-09-27")).toBe(false);
    expect(rejectionNeedsPhoto("2026-09-28")).toBe(true);
    // Una fecha con hora sigue contando por el día.
    expect(rejectionNeedsPhoto("2026-09-28T00:00:00")).toBe(true);
    expect(rejectionNeedsPhoto("2026-09-27T23:59:59")).toBe(false);
  });

  it("el mensaje nombra cada pedido y dice cómo arreglarlo", () => {
    const una = missingEvidenceMessage([parada({ seq: 16, status: "no_entregado", outcome_reason: "rechazado", name: "#KP136057" })]);
    expect(una).toBe("Falta la foto en 1 parada: #KP136057 (rechazó el pedido). Adjúntala con «Corregir» en la ruta del motorizado o desde «Reportar entregas», y vuelve a terminar la ruta.");
    const dos = missingEvidenceMessage([
      parada({ seq: 2, status: "entregado", name: "#KP2" }),
      parada({ seq: 7, status: "no_entregado", outcome_reason: "rechazado", name: null }),
    ]);
    expect(dos).toContain("Falta la foto en 2 paradas: #KP2 (entregado), parada 7 (rechazó el pedido).");
    expect(missingEvidenceMessage([])).toBeNull();
  });

  // closeRoute y la pantalla del motorizado son un server action y un
  // componente: estas guardas prueban que usan las funciones de arriba.
  it("liquidar y el teléfono usan esas mismas reglas", () => {
    const rutas = readFileSync(resolve(process.cwd(), "app/dashboard/rutas/actions.ts"), "utf8");
    // La foto que falta es un bloqueo más de `routeCloseBlockers` (sin_foto →
    // missingEvidenceMessage), la misma regla que enseña el panel de la ruta.
    expect(rutas).toContain("routeCloseBlockers({ isGf: context.isGf, openLoads: context.openLoads, stops, routeDate: route.route_date })");
    // Forzar solo salta lo forzable: en Grupo GF, solo los «No entregado» que
    // siguen en la caja (29-09-2026).
    expect(rutas).toContain(".find((blocker) => !(isForceableBlocker(blocker) && opts.force));");
    expect(rutas).toContain('if (!context) return { ok: false, error: "No se pudo comprobar la recepción de las cargas." };');
    expect(rutas).toContain("const requireEvidence = context.isGf;");
    expect(rutas).toContain("error: routeCloseBlockerMessage(bloqueo)");
    expect(rutas).not.toContain("Falta evidencia de entrega o rechazo. Completa el reporte antes de liquidar.");
    const telefono = readFileSync(resolve(process.cwd(), "components/rider-route.tsx"), "utf8");
    expect(telefono).toContain('status === "no_entregado" && nonDeliveryNeedsPhoto(reason, delegated) && <PhotoCapture');
    expect(telefono).toContain('label={delegated ? "Evidencia del reporte" : "Foto del rechazo"}');
  });

  it("y el MOM lo dice", () => {
    const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");
    expect(mom).toContain("**La foto del rechazo se pide al reportarlo, no al liquidar (28-09-2026,\ndecisión de Frankz).**");
    expect(mom).toContain("**Excepción: los rechazos de rutas anteriores al 28-09-2026 no exigen foto\n(28-09-2026, decisión de Frankz).**");
  });

  it("la excepción vive en el cierre, en el panel y en el pago del motorizado (0197)", () => {
    const sql = readFileSync(resolve(process.cwd(), "db/migrations/0197_rejection_photo_exemption.sql"), "utf8");
    expect(sql).toContain("create or replace function rider_pay_preview(p_route uuid, p_actor uuid)");
    // La misma fecha que REJECTION_PHOTO_FROM: si una cambia, la otra también.
    expect(sql).toContain(`or (x->>'outcome_reason'='rechazado' and v_route.route_date >= date '${REJECTION_PHOTO_FROM}'))`);
    expect(sql).toContain("revoke all on function rider_pay_preview(uuid,uuid) from public,anon,authenticated;");
    const verify = readFileSync(resolve(process.cwd(), "scripts/verify-db.sh"), "utf8");
    expect(verify).toContain('$PSQL -f "$ROOT/scripts/sql/rider_pay_rejection_photo_smoke.sql"');
    const panel = readFileSync(resolve(process.cwd(), "components/routes.tsx"), "utf8");
    expect(panel).toContain('const exemptRejection = (s: StopWithOrder) => !rejectionsNeedPhoto && s.outcome_reason === "rechazado" && !s.photo_path;');
    expect(panel).toContain("Sin foto · no se exige (antes del 28/09)");
    expect(panel).toContain('"Todo reportado; los rechazos antes del 28/09 no exigen foto. Al terminarla se crea la liquidación de cada tienda."');
  });
});

// Roy, 19/09: el coordinador pulsaba «Terminar ruta operativa», leía UN error
// («Grupo GF: todas las paradas deben tener reporte»), lo arreglaba y volvía a
// pulsar para descubrir el siguiente —8 sin reportar, 8 sin foto—. Ahora una
// sola regla dice TODO lo que impide terminar: el panel lo enseña antes de
// pulsar y el servidor rechaza con el primero que no se pueda forzar.
describe("qué impide terminar la ruta", () => {
  const parada = (over: Partial<{ seq: number; status: string; outcome_reason: string | null; photo_path: string | null; name: string | null; manifest_item_id: string | null }>) => ({
    seq: over.seq ?? 1,
    status: over.status ?? "entregado",
    outcome_reason: over.outcome_reason ?? null,
    photo_path: over.photo_path === undefined ? "f.jpg" : over.photo_path,
    order: { name: over.name === undefined ? `#KP${over.seq ?? 1}` : over.name },
    manifest_item_id: over.manifest_item_id ?? null,
  });
  // Ruta del 28/09 o después: sus rechazos también exigen foto.
  const HOY = "2026-09-28";
  const carga = (over: Partial<OpenLoad>): OpenLoad => ({ id: over.id ?? "m1", load_number: over.load_number ?? 1, state: over.state ?? "office_check", items: over.items ?? 0 });
  // Lo que hace closeRoute: el primero que no se pueda forzar.
  const cierre = (input: Parameters<typeof routeCloseBlockers>[0], force = false) =>
    routeCloseBlockers(input).find((b) => !(isForceableBlocker(b) && force)) ?? null;

  it("una ruta de Grupo GF reportada y con fotos está lista", () => {
    const stops = [parada({ seq: 1 }), parada({ seq: 2, status: "no_entregado", outcome_reason: "rechazado" }), parada({ seq: 3, status: "no_entregado", outcome_reason: "no_contesta", photo_path: null })];
    expect(routeCloseBlockers({ isGf: true, openLoads: [], stops, routeDate: HOY })).toEqual([]);
  });

  it("Grupo GF: dice a la vez las sin reportar y las sin foto, y ninguna se fuerza", () => {
    const stops = [
      parada({ seq: 1, status: "pendiente", photo_path: null }),
      parada({ seq: 2, photo_path: null }),
      parada({ seq: 3, status: "no_entregado", outcome_reason: "rechazado", photo_path: null }),
      parada({ seq: 4, status: "pendiente", photo_path: null }),
    ];
    const blockers = routeCloseBlockers({ isGf: true, openLoads: [], stops, routeDate: HOY });
    expect(blockers.map((b) => b.kind)).toEqual(["sin_reportar", "sin_foto"]);
    expect(blockers[0]).toMatchObject({ kind: "sin_reportar", forceable: false });
    expect(blockers[0]!.kind === "sin_reportar" && blockers[0]!.stops.map((s) => s.seq)).toEqual([1, 4]);
    expect(blockers[1]!.kind === "sin_foto" && blockers[1]!.stops.map((s) => s.seq)).toEqual([2, 3]);
    expect(cierre({ isGf: true, openLoads: [], stops, routeDate: HOY }, true)?.kind).toBe("sin_reportar");
  });

  it("antes del 28/09 los rechazos sin foto no frenan; las entregas sin foto sí", () => {
    const rechazos = [parada({ seq: 1 }), parada({ seq: 2, status: "no_entregado", outcome_reason: "rechazado", photo_path: null })];
    expect(routeCloseBlockers({ isGf: true, openLoads: [], stops: rechazos, routeDate: "2026-09-25" })).toEqual([]);
    expect(routeCloseBlockers({ isGf: true, openLoads: [], stops: rechazos, routeDate: HOY }).map((b) => b.kind)).toEqual(["sin_foto"]);
    const entrega = [parada({ seq: 1, photo_path: null }), ...rechazos.slice(1)];
    const blockers = routeCloseBlockers({ isGf: true, openLoads: [], stops: entrega, routeDate: "2026-09-25" });
    expect(blockers.map((b) => b.kind)).toEqual(["sin_foto"]);
    expect(blockers[0]!.kind === "sin_foto" && blockers[0]!.stops.map((s) => s.seq)).toEqual([1]);
  });

  it("fuera de Grupo GF las sin reportar se pueden forzar y la foto no frena el cierre", () => {
    const stops = [parada({ seq: 1, status: "pendiente", photo_path: null }), parada({ seq: 2, photo_path: null })];
    const blockers = routeCloseBlockers({ isGf: false, openLoads: [], stops, routeDate: HOY });
    expect(blockers).toEqual([{ kind: "sin_reportar", stops: [stops[0]], forceable: true }]);
    expect(cierre({ isGf: false, openLoads: [], stops, routeDate: HOY })?.kind).toBe("sin_reportar");
    expect(cierre({ isGf: false, openLoads: [], stops, routeDate: HOY }, true)).toBeNull();
  });

  it("con una carga abierta la causa es la carga, no «sin paradas», y van en orden", () => {
    const openLoads = [carga({ id: "b", load_number: 2 }), carga({ id: "a", load_number: 1, items: 3, state: "ready_for_pickup" })];
    const blockers = routeCloseBlockers({ isGf: true, openLoads, stops: [], routeDate: HOY });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.kind === "carga_sin_recibir" && blockers[0]!.loads.map((l) => l.load_number)).toEqual([1, 2]);
    expect(openLoads.map((l) => l.load_number)).toEqual([2, 1]);
    expect(routeCloseBlockerMessage(blockers[0]!)).toBe(
      "La carga 1 tiene 3 paquetes sin recibir: que el motorizado la reciba o retira desde la caja los paquetes que no van. La carga 2 está abierta y vacía: cancélala con motivo.",
    );
  });

  it("una carga abierta frena aunque todo lo demás esté listo", () => {
    const blockers = routeCloseBlockers({ isGf: true, openLoads: [carga({ load_number: 2, items: 1 })], stops: [parada({ seq: 1 })], routeDate: HOY });
    expect(blockers.map((b) => b.kind)).toEqual(["carga_sin_recibir"]);
    expect(routeCloseBlockerMessage(blockers[0]!)).toContain("La carga 2 tiene 1 paquete sin recibir");
  });

  it("sin paradas no hay nada que terminar, sea o no de Grupo GF", () => {
    for (const isGf of [true, false]) {
      const blockers = routeCloseBlockers({ isGf, openLoads: [], stops: [], routeDate: HOY });
      expect(blockers).toEqual([{ kind: "sin_paradas" }]);
      expect(cierre({ isGf, openLoads: [], stops: [], routeDate: HOY }, true)?.kind).toBe("sin_paradas");
      expect(routeCloseBlockerMessage(blockers[0]!)).toBe("La ruta no tiene paradas: no hay nada que terminar ni liquidar.");
    }
  });

  it("los mensajes nombran los pedidos y concuerdan en número", () => {
    const ocho = Array.from({ length: 8 }, (_, i) => parada({ seq: i + 1, status: "pendiente", name: `#KP13605${i}` }));
    expect(routeCloseBlockerMessage({ kind: "sin_reportar", stops: ocho, forceable: false })).toBe(
      "Faltan 8 paradas por reportar: #KP136050, #KP136051, #KP136052, #KP136053, #KP136054 y 3 más. Repórtalas en «Reportar entregas»; en Grupo GF no se cierra sin reporte.",
    );
    expect(routeCloseBlockerMessage({ kind: "sin_reportar", stops: [parada({ seq: 4, status: "pendiente", name: null })], forceable: false })).toBe(
      "Falta 1 parada por reportar: parada 4. Repórtalas en «Reportar entregas»; en Grupo GF no se cierra sin reporte.",
    );
    expect(routeCloseBlockerMessage({ kind: "sin_reportar", stops: ocho.slice(0, 1), forceable: true })).toBe(
      "Queda 1 parada sin reportar. Espera a que las reporte o ciérrala igual a conciencia.",
    );
    expect(routeCloseBlockerMessage({ kind: "sin_reportar", stops: ocho.slice(0, 2), forceable: true })).toMatch(/^Quedan 2 paradas sin reportar\./);
    const sinFoto = [parada({ seq: 16, status: "no_entregado", outcome_reason: "rechazado", photo_path: null, name: "#KP136057" })];
    expect(routeCloseBlockerMessage({ kind: "sin_foto", stops: sinFoto })).toBe(missingEvidenceMessage(sinFoto));
  });

  // #KP136779 y #KP136896: Yhoni los reportó «No entregado» el 26/09, la ruta
  // se cerró el 28/09 y seguían en la caja; el escaneo del 29/09 decía «Ya
  // estaba». Eran 78 así. Cerrar ahora lo dice, y se puede hacer a conciencia.
  it("un «No entregado» que sigue en la caja frena el cierre de Grupo GF, pero se puede cerrar igual", () => {
    const stops = [
      parada({ seq: 1 }),
      parada({ seq: 2, status: "no_entregado", outcome_reason: "reprogramado", name: "#KP136779", manifest_item_id: "i2" }),
      parada({ seq: 3, status: "no_entregado", outcome_reason: "rechazado", name: "#KP136896", manifest_item_id: "i3" }),
      // Ya recibido en oficina: el ítem salió de la caja.
      parada({ seq: 4, status: "no_entregado", outcome_reason: "no_contesta", manifest_item_id: null }),
    ];
    const blockers = routeCloseBlockers({ isGf: true, openLoads: [], stops, routeDate: HOY });
    expect(blockers).toEqual([{ kind: "sin_recibir", stops: [stops[1], stops[2]], forceable: true }]);
    expect(isForceableBlocker(blockers[0]!)).toBe(true);
    expect(stopsNotReceived(stops).map((s) => s.seq)).toEqual([2, 3]);
    expect(cierre({ isGf: true, openLoads: [], stops, routeDate: HOY })?.kind).toBe("sin_recibir");
    expect(cierre({ isGf: true, openLoads: [], stops, routeDate: HOY }, true)).toBeNull();
  });

  it("forzar no salta nada más en Grupo GF: ni lo sin reportar ni la foto", () => {
    const stops = [
      parada({ seq: 1, status: "pendiente", photo_path: null }),
      parada({ seq: 2, status: "no_entregado", outcome_reason: "no_contesta", manifest_item_id: "i2" }),
    ];
    expect(routeCloseBlockers({ isGf: true, openLoads: [], stops, routeDate: HOY }).map((b) => b.kind)).toEqual(["sin_reportar", "sin_recibir"]);
    expect(cierre({ isGf: true, openLoads: [], stops, routeDate: HOY }, true)?.kind).toBe("sin_reportar");
  });

  it("fuera de Grupo GF no hay caja: no se pide recibir nada", () => {
    const stops = [parada({ seq: 1, status: "no_entregado", outcome_reason: "no_contesta", manifest_item_id: "i1" })];
    expect(routeCloseBlockers({ isGf: false, openLoads: [], stops, routeDate: HOY })).toEqual([]);
  });

  it("el mensaje nombra los pedidos y dice las dos salidas", () => {
    const dos = [
      parada({ seq: 2, status: "no_entregado", name: "#KP136779", manifest_item_id: "i2" }),
      parada({ seq: 3, status: "no_entregado", name: "#KP136896", manifest_item_id: "i3" }),
    ];
    expect(routeCloseBlockerMessage({ kind: "sin_recibir", stops: dos, forceable: true })).toBe(
      "Faltan recibir en oficina 2 paquetes «No entregado»: #KP136779, #KP136896. Si ya volvieron, recíbelos con «Recibir en oficina»; si vuelven después, ciérrala igual: quedan en «Devoluciones» y se reciben al escanearlos.",
    );
    expect(routeCloseBlockerMessage({ kind: "sin_recibir", stops: dos.slice(0, 1), forceable: true })).toBe(
      "Falta recibir en oficina 1 paquete «No entregado»: #KP136779. Si ya volvió, recíbelo con «Recibir en oficina»; si vuelve después, ciérrala igual: queda en «Devoluciones» y se recibe al escanearlo.",
    );
  });

  it("el panel ofrece recibirlos ahí mismo, con la misma puerta que «Devoluciones»", () => {
    const panel = readFileSync(resolve(process.cwd(), "components/routes.tsx"), "utf8");
    expect(panel).toContain("onRun(() => receiveRouteReturns(routeId))");
    expect(panel).toContain("const hardBlockers = blockers.filter((b) => !isForceableBlocker(b));");
    expect(panel).toContain('{ key: "por_devolver", label: "Por devolver", count: notReceivedIds.size }');
    const rutas = readFileSync(resolve(process.cwd(), "app/dashboard/rutas/actions.ts"), "utf8");
    expect(rutas).toContain("const pending = stopsNotReceived(detail.stops);");
    expect(rutas).toContain("await returnUndeliveredToOffice(orgId, [...new Set(pending.map((stop) => stop.order_id))]);");
    // La caja la dice el ítem activo que ya carga el detalle de la ruta.
    const access = readFileSync(resolve(process.cwd(), "lib/routes-access.ts"), "utf8");
    expect(access).toContain("manifest_item_id: pickups.get(pickupKey(s))?.id ?? null,");
    expect(access).toContain('.is("removed_at", null);');
    const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");
    expect(mom).toContain("**Cerrar una ruta no vacía la caja: los «No entregado» se reciben o se dejan a\nconciencia (29-09-2026).**");
  });

  it("el panel de la ruta y el cierre usan la misma regla", () => {
    const panel = readFileSync(resolve(process.cwd(), "components/routes.tsx"), "utf8");
    expect(panel).toContain("routeCloseBlockers({ isGf: closeContext.isGf, openLoads: closeContext.openLoads, stops, routeDate: route.route_date })");
    expect(panel).toContain("stopsMissingEvidence(stops, route.route_date)");
    // «Terminar» solo se habilita cuando el cierre va a pasar, y forzar solo
    // existe fuera de Grupo GF (bloqueo forzable y nada más).
    expect(panel).toContain("disabled={disabled || !ready}");
    expect(panel).toContain("const canForce = known && hardBlockers.length === 0 && !!forceable;");
    expect(panel).toContain("onRun(() => closeRoute(routeId, { force: true }))");
    // Una carga vacía se cancela ahí mismo, con motivo y con el permiso de despacho.
    expect(panel).toContain("cancelDispatchManifest(load.id, reason)");
    const loader = readFileSync(resolve(process.cwd(), "app/dashboard/courier/actions.ts"), "utf8");
    expect(loader).toContain("loadRouteCloseContext(createAdminSupabase(), id)");
    expect(loader).toContain('canCancelLoads: permissions.can("dispatch.manage")');
    const drawer = readFileSync(resolve(process.cwd(), "components/courier-route-report-drawer.tsx"), "utf8");
    expect(drawer).toContain("closeContext={report.closeContext}");
    // Leer las cargas y fallar no es «no hay cargas»: el cierre se niega.
    const close = readFileSync(resolve(process.cwd(), "lib/route-close.ts"), "utf8");
    expect(close).toContain("if (error) return null;");
    expect(close).toContain("if (itemsError) return null;");
  });

  it("y el MOM lo dice", () => {
    const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");
    expect(mom).toContain("**Qué impide terminar la ruta, a la vista (28-09-2026).**");
    expect(mom).toContain("- Una sola regla, `routeCloseBlockers` (`lib/routes.ts`), para el panel y\n  para `closeRoute`");
  });
});
