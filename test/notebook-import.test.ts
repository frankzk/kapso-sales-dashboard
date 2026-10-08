// La hoja del motorizado sin app, cargada desde Kapta (MOM §29.7, 08-10-2026).
// Los casos salen de las hojas de Alexis del 01 al 06/10.
import { describe, expect, it } from "vitest";
import {
  buildNotebookPlan,
  codeCandidates,
  interpretWritten,
  nameScore,
  nextNamedDay,
  notebookStopNote,
  planTotals,
  type NotebookContext,
  type NotebookLine,
} from "@/lib/notebook-import";

const line = (over: Partial<NotebookLine>): NotebookLine => ({
  item: 1, store: "AURELA", customer: null, district: null, written: "EFECTIVO", amount: null, fee: 10, order: null, notes: null, ...over,
});

describe("lo escrito en F. PAGO", () => {
  it("las entregas: efectivo, POS y lo que ya estaba pagado", () => {
    expect(interpretWritten("EFECTIVO", 189).outcome).toEqual({ status: "entregado", method: "efectivo", amount: 189 });
    expect(interpretWritten("PAGO POS", 149).outcome).toEqual({ status: "entregado", method: "pos", amount: 149 });
    expect(interpretWritten("Yape", 89).outcome).toEqual({ status: "entregado", method: "yape", amount: 89 });
    // La celda cortada en la captura («OLO ENTREGA») sigue siendo SOLO ENTREGA.
    for (const w of ["SOLO ENTREGA", "solo entrega", "OLO ENTREGA", "YAPE PROV", "PAGADO"]) {
      expect(interpretWritten(w, 0).outcome).toEqual({ status: "entregado", method: "sin_cobro", amount: 0 });
    }
  });

  it("una entrega sin monto legible no se adivina", () => {
    const r = interpretWritten("EFECTIVO", null);
    expect(r.outcome).toBeNull();
    expect(r.problem).toContain("no se lee cuánto cobró");
  });

  it("las no entregas con su código de Reparto propio", () => {
    expect(interpretWritten("COBRO CAIDA", 0)).toMatchObject({ outcome: { status: "no_entregado", reason: "rechazado" }, code: "rechazado" });
    expect(interpretWritten("RECHAZO", 0)).toMatchObject({ outcome: { reason: "rechazado" } });
    expect(interpretWritten("CAIDA", 0)).toMatchObject({ outcome: { reason: "otro" }, code: "cancelado" });
    expect(interpretWritten("Caída", 0)).toMatchObject({ outcome: { reason: "otro" } });
    expect(interpretWritten("ANULADO", 0)).toMatchObject({ outcome: { reason: "otro" }, code: "cancelado" });
    expect(interpretWritten("DE VIAJE", 0)).toMatchObject({ outcome: { reason: "otro" } });
    expect(interpretWritten("NO CONTESTO", 0)).toMatchObject({ outcome: { reason: "no_contesta" }, code: "no_responde" });
    expect(interpretWritten("NO ESTABA", 0)).toMatchObject({ outcome: { reason: "no_estaba" }, code: "no_recibe" });
    expect(interpretWritten("REPRO", 0)).toMatchObject({ outcome: { reason: "reprogramado" }, code: "reprogramado", day: null });
    expect(interpretWritten("MAÑANA", 0)).toMatchObject({ outcome: { reason: "reprogramado" } });
    expect(interpretWritten("MIERCOLES", 0)).toMatchObject({ outcome: { reason: "reprogramado" }, day: "MIERCOLES" });
    expect(interpretWritten("Sábado", 0)).toMatchObject({ outcome: { reason: "reprogramado" }, day: "SABADO" });
  });

  it("lo que no se entiende queda para una persona", () => {
    const r = interpretWritten("CAMBIO", 0);
    expect(r.outcome).toBeNull();
    expect(r.problem).toContain("«CAMBIO»");
    expect(interpretWritten("", 0).problem).toContain("no dice qué pasó");
  });

  it("«MIÉRCOLES» en la ruta del lunes 05/10 es el 07/10", () => {
    expect(nextNamedDay("2026-10-05", "MIERCOLES")).toBe("miércoles 07/10");
    expect(nextNamedDay("2026-10-05", "SABADO")).toBe("sábado 10/10");
    // El mismo día de la semana es la semana siguiente.
    expect(nextNamedDay("2026-10-05", "LUNES")).toBe("lunes 12/10");
  });
});

describe("el código del pedido", () => {
  it("con prefijo, sin espacios ni almohadilla, y un número suelto prueba las dos tiendas", () => {
    expect(codeCandidates("#KP138029")).toEqual(["#KP138029"]);
    expect(codeCandidates("kp 138029")).toEqual(["#KP138029"]);
    expect(codeCandidates("#AUR177790")).toEqual(["#AUR177790"]);
    expect(codeCandidates("138029")).toEqual(["#138029", "#KP138029", "#AUR138029"]);
    expect(codeCandidates("No especificado")).toEqual([]);
    expect(codeCandidates(null)).toEqual([]);
  });

  it("el nombre abreviado de la hoja se parece al del pedido", () => {
    expect(nameScore("Gisenia Cayc.", "Gisenia Caycho Ramos")).toBe(1);
    expect(nameScore("Clay Sena Caya", "Clay Sena Cayatopa")).toBe(1);
    expect(nameScore("Pablo", "Juan Pérez")).toBe(0);
  });
});

const ctx = (): NotebookContext => ({
  routeDate: "2026-10-05",
  riderName: "Alexis",
  stops: [
    { stopId: "s1", orderId: "o1", orderName: "#KP138910", customerName: "Dotty Pinedo", status: "pendiente", reportedLabel: null, total: 189, remaining: 189 },
    { stopId: "s2", orderId: "o2", orderName: "#KP138923", customerName: "Clay Sena Cayatopa", status: "pendiente", reportedLabel: null, total: 297, remaining: 297 },
    { stopId: "s3", orderId: "o3", orderName: "#KP138918", customerName: "Jossyfin Gonzales", status: "pendiente", reportedLabel: null, total: 149, remaining: 0 },
    { stopId: "s4", orderId: "o4", orderName: "#KP138611", customerName: "Carlos Castañeda", status: "entregado", reportedLabel: "Entregado · Sin cobro", total: 99, remaining: 0 },
    { stopId: "s5", orderId: "o5", orderName: "#KP138995", customerName: "Rosa Díaz", status: "pendiente", reportedLabel: null, total: 89, remaining: 89 },
    { stopId: "s6", orderId: "o6", orderName: "#KP138900", customerName: "Alex Carrillo", status: "pendiente", reportedLabel: null, total: 149, remaining: 149 },
    { stopId: "s7", orderId: "o7", orderName: "#KP138994", customerName: "José Alcas", status: "pendiente", reportedLabel: null, total: 298, remaining: 298 },
  ],
  carry: [
    { shipmentId: "sh9", orderId: "o9", orderName: "#KP138029", customerName: "Gisenia Caycho", fromDate: "2026-10-03", total: 159, remaining: 159 },
  ],
  elsewhere: new Map([
    ["#KP137156", { orderId: "o10", orderName: "#KP137156", cancelled: true, where: "está en la caja de Alexis del 04/10" }],
    ["#KP138433", { orderId: "o11", orderName: "#KP138433", cancelled: false, where: "está en la caja de Roy del 05/10" }],
  ]),
});

describe("el cruce de la hoja con la ruta", () => {
  const lines: NotebookLine[] = [
    line({ item: 2, order: "#KP138611", written: "YAPE PROV", amount: 0, customer: "Carlos Castan." }),
    line({ item: 3, order: "#KP138918", written: "SOLO ENTREGA", amount: 0 }),
    line({ item: 5, order: "#KP138910", written: "EFECTIVO", amount: 189 }),
    line({ item: 14, order: null, customer: "Clay Sena Caya", written: "EFECTIVO", amount: 297 }),
    line({ item: 20, order: "#KP138029", written: "EFECTIVO", amount: 159, customer: "Gisenia Cayc." }),
    line({ item: 26, order: "#KP137156", written: "DE VIAJE", amount: 0, fee: 0 }),
    line({ item: 27, order: "#KP138433", written: "EFECTIVO", amount: 120 }),
    line({ item: 28, order: "#KP999999", written: "EFECTIVO", amount: 50 }),
    line({ item: 29, order: "#KP138900", written: "EFECTIVO", amount: 100 }),
    line({ item: 30, order: "#KP138994", written: "EFECTIVO", amount: 400 }),
    line({ item: 31, order: null, customer: "Edith", written: "NO CONTESTO", amount: 0, fee: 0 }),
  ];
  const plan = buildNotebookPlan(lines, ctx(), { amount: 1491, fee: 105 });
  const row = (item: number) => plan.rows.find((r) => r.line.item === item)!;

  it("la ya reportada no se toca", () => {
    expect(row(2).match.kind).toBe("reportada");
    expect(row(2).action).toBe("omitir");
    expect(row(2).warnings[0]).toContain("Ya reportada: Entregado · Sin cobro");
  });

  it("pendientes por código: se reportan con lo escrito", () => {
    expect(row(3)).toMatchObject({ action: "reportar", match: { kind: "pendiente", stopId: "s3", via: "codigo" } });
    expect(row(3).outcome).toEqual({ status: "entregado", method: "sin_cobro", amount: 0 });
    expect(row(3).warnings).toEqual([]);
    expect(row(5)).toMatchObject({ action: "reportar", outcome: { method: "efectivo", amount: 189 } });
  });

  it("sin código, por nombre y monto si hay un solo candidato, y avisando", () => {
    expect(row(14).match).toMatchObject({ kind: "pendiente", via: "nombre", stopId: "s2" });
    expect(row(14).action).toBe("reportar");
    expect(row(14).warnings[0]).toContain("Cruzado por nombre");
  });

  it("el reprogramado que él conserva pasa a esta ruta y se reporta", () => {
    expect(row(20)).toMatchObject({ action: "pasar_y_reportar", match: { kind: "arrastre", shipmentId: "sh9", fromDate: "2026-10-03" } });
    expect(row(20).warnings[0]).toContain("Reprogramado el 03/10");
  });

  it("anulado, en la caja de otro o inexistente: se enseña y no se carga", () => {
    expect(row(26)).toMatchObject({ action: "omitir", match: { kind: "anulado" } });
    expect(row(26).warnings[0]).toContain("si Alexis tiene el paquete, vuelve a la oficina");
    expect(row(27)).toMatchObject({ action: "omitir", match: { kind: "otra_caja" } });
    expect(row(27).warnings[0]).toBe("No está en esta ruta: está en la caja de Roy del 05/10.");
    expect(row(28)).toMatchObject({ action: "omitir", match: { kind: "no_existe" } });
    expect(row(31)).toMatchObject({ action: "omitir", match: { kind: "sin_codigo" } });
  });

  it("cobro parcial avisa; cobro mayor que el saldo no se carga", () => {
    expect(row(29).action).toBe("reportar");
    expect(row(29).warnings).toContain("Cobró S/ 100.00 de S/ 149.00; la hoja no dice por qué.");
    expect(row(30).action).toBe("omitir");
    expect(row(30).warnings[0]).toContain("no se puede registrar más que el saldo");
  });

  it("las pendientes que la hoja no menciona y los totales", () => {
    expect(plan.missing).toEqual([{ stopId: "s5", orderName: "#KP138995", customerName: "Rosa Díaz" }]);
    expect(plan.totals).toMatchObject({
      sheetAmount: 1315, sheetFee: 90, declaredAmount: 1491, matchesDeclared: false,
      loadCash: 189 + 297 + 159 + 100, loadPos: 0, loadYape: 0, notLoadedAmount: 120 + 50 + 400,
    });
  });

  it("dos candidatos igual de parecidos: no se elige ninguno", () => {
    const c = ctx();
    c.stops.push({ stopId: "s8", orderId: "o8", orderName: "#KP1", customerName: "Clay Sena Cayatopa", status: "pendiente", reportedLabel: null, total: 297, remaining: 297 });
    const p = buildNotebookPlan([line({ order: null, customer: "Clay Sena Caya", amount: 297 })], c);
    expect(p.rows[0]!.match.kind).toBe("sin_codigo");
  });

  it("una fila «sin cobro» con saldo pendiente lo avisa", () => {
    const p = buildNotebookPlan([line({ order: "#KP138910", written: "SOLO ENTREGA", amount: 0 })], ctx());
    expect(p.rows[0]!.action).toBe("reportar");
    expect(p.rows[0]!.warnings[0]).toContain("«Sin cobro» no lo marca pagado");
  });

  it("al editar se recalculan los totales a cargar", () => {
    const rows = plan.rows.map((r) => (r.line.item === 29 ? { ...r, action: "omitir" as const } : r));
    expect(planTotals(rows, { amount: null, fee: null })).toMatchObject({ loadCash: 189 + 297 + 159, matchesDeclared: null });
  });
});

describe("la nota de la parada", () => {
  it("tiene la forma de las cargas a mano del 01 al 06/10", () => {
    const plan = buildNotebookPlan(
      [
        line({ item: 3, order: "#KP138918", written: "SOLO ENTREGA", amount: 0 }),
        line({ item: 20, order: "#KP138029", written: "MIERCOLES", amount: 0 }),
        line({ item: 14, order: null, customer: "Clay Sena Caya", written: "EFECTIVO", amount: 297 }),
      ],
      ctx(),
    );
    const note = (i: number) => notebookStopNote({
      riderName: "Alexis", routeDate: "2026-10-05", row: plan.rows[i]!, outcome: plan.rows[i]!.outcome!,
      loadedBy: "Frankz Kastner", loadedOn: "2026-10-06",
    });
    expect(note(0)).toBe(
      "Cuaderno de Alexis del 05/10 (punto 3): aún no usa la app, va sin foto. Cargado por Frankz Kastner el 06/10. " +
        "SOLO ENTREGA en el cuaderno: el pedido ya estaba pagado y no se cobró nada.",
    );
    expect(note(1)).toContain("Lo traía desde su ruta del 03/10 (reprogramado) y salió en la del 05/10.");
    expect(note(1)).toContain("MIERCOLES en el cuaderno: reprogramado para el miércoles 07/10.");
    expect(note(2)).toContain("La hoja no trae el código; se cruzó por el nombre (Clay Sena Caya) y el monto (S/ 297.00).");
  });
});

describe("lo que cambia quien liquida", () => {
  it("queda en la nota y el código sigue al resultado cargado", async () => {
    const { outcomeCode } = await import("@/lib/notebook-import");
    const plan = buildNotebookPlan([line({ item: 7, order: "#KP138910", written: "CAMBIO", amount: 0 })], ctx());
    const row = plan.rows[0]!;
    expect(row.action).toBe("omitir");
    const outcome = { status: "no_entregado" as const, reason: "otro" };
    const note = notebookStopNote({ riderName: "Alexis", routeDate: "2026-10-05", row, outcome, loadedBy: "frankz", loadedOn: "2026-10-08" });
    expect(note).toContain("La hoja dice «CAMBIO»; quien cargó eligió No entregado · Otro (ver nota).");
    expect(outcomeCode(outcome)).toBe("cancelado");
    expect(outcomeCode({ status: "entregado", method: "pos", amount: 10 })).toBe("entregado");
  });
});

describe("lo que manda la pantalla al aplicar", () => {
  it("el servidor no se fía: resultados mal formados quedan sin decidir", async () => {
    const { cleanDecisions, cleanOutcome } = await import("@/lib/notebook-import");
    expect(cleanOutcome({ status: "entregado", method: "efectivo", amount: 89.999 })).toEqual({ status: "entregado", method: "efectivo", amount: 90 });
    expect(cleanOutcome({ status: "entregado", method: "efectivo", amount: 0 })).toBeNull();
    expect(cleanOutcome({ status: "entregado", method: "sin_cobro", amount: 50 })).toEqual({ status: "entregado", method: "sin_cobro", amount: 0 });
    expect(cleanOutcome({ status: "entregado", method: "bitcoin", amount: 5 })).toBeNull();
    expect(cleanOutcome({ status: "no_entregado", reason: "reprogramado" })).toEqual({ status: "no_entregado", reason: "reprogramado" });
    expect(cleanOutcome({ status: "no_entregado", reason: "se fue" })).toBeNull();
    expect(cleanDecisions([{ index: 2, action: "borrar", outcome: null }, { index: -1 }, { index: 3, action: "reportar", outcome: { status: "no_entregado", reason: "no_contesta" }, stopId: "s5" }]))
      .toEqual([
        { index: 2, action: "omitir", outcome: null, stopId: null },
        { index: 3, action: "reportar", outcome: { status: "no_entregado", reason: "no_contesta" }, stopId: "s5" },
      ]);
  });
});

describe("la hoja se carga desde Kapta (08-10-2026)", () => {
  it("MOM, runbook, panel, rutas y migración dicen lo mismo", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (f: string) => readFileSync(`${process.cwd()}/${f}`, "utf8");
    expect(read("docs/mom/master-pedidos-v1.md")).toContain("**La hoja del motorizado sin app se carga desde Kapta (08-10-2026, decisión de\nFrankz).**");
    expect(read("docs/runbooks/cuaderno-a-rutas.md")).toContain("**Desde el 08/10/2026 se hace en Kapta, no con SQL**");
    expect(read("components/courier-route-report-drawer.tsx")).toContain("<RiderNotebookImport");
    // Solo quien arma rutas, y el reporte por el único camino, en modo cuaderno.
    expect(read("lib/notebook-import-access.ts")).toContain('permissions.can("routes.manage")');
    expect(read("app/api/courier/notebook/apply/route.ts")).toContain('permissions.can("routes.manage")');
    const apply = read("lib/notebook-apply.ts");
    expect(apply).toContain("writeStopReport(");
    expect(apply).toContain("notebook: { riderName, importId }");
    expect(apply).toContain('admin.rpc("gf_carry_over"');
    const report = read("lib/stop-report.ts");
    expect(report).toContain('reported_by: input.status === "pendiente" || notebook ? null : input.actor,');
    const migration = read("db/migrations/0234_gf_notebook_carry_over.sql");
    expect(migration).toContain("Despacho está armando la carga de");
    expect(migration).toContain("revoke all on public.rider_notebook_imports from anon, authenticated;");
  });
});
