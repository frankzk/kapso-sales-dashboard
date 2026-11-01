// «Reprogramado por el cliente» con fecha. El 10-10-2026 la fecha del reporte
// agendaba la salida de Grupo GF de una vez (#908). Del 12-10 al 01-11-2026
// (D9, decisión 7) solo se anotaba y la tienda la confirmaba en Repro Lima.
// Desde el 01-11-2026 (decisión del owner: Grupo GF le impone el acuerdo a la
// tienda) la «Fecha que pidió el cliente» queda en la parada y programa la
// salida de ese día (`syncDoorDateProgram`, lib/door-date-program.ts), por el
// mismo camino que «Programar».

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RESCHEDULE_MAX_DAYS, rescheduleDateProblem, writeGfDispatchProgram } from "@/lib/gf-dispatch-program";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("la fecha que se acepta", () => {
  it("hoy y los próximos dos meses, sí; antes de hoy, más allá o mal escrita, no", () => {
    expect(rescheduleDateProblem("2026-10-10", "2026-10-10")).toBeNull();
    expect(rescheduleDateProblem("2026-10-13", "2026-10-10")).toBeNull();
    expect(rescheduleDateProblem("2026-12-09", "2026-10-10")).toBeNull();
    expect(rescheduleDateProblem("2026-10-09", "2026-10-10")).toBe("La nueva fecha no puede ser anterior a hoy.");
    expect(rescheduleDateProblem("2026-12-10", "2026-10-10")).toMatch(/60 días/);
    expect(rescheduleDateProblem("13/10/2026", "2026-10-10")).toBe("Elige una fecha válida.");
  });
});

describe("el programa se escribe igual desde «Programar» de Grupo GF y desde Repro Lima", () => {
  function fakeAdmin(opts: { upsertError?: string } = {}) {
    const calls: { table: string; op: string; arg: unknown }[] = [];
    const admin = {
      from: (table: string) => ({
        upsert: async (arg: unknown) => { calls.push({ table, op: "upsert", arg }); return { error: opts.upsertError ? { message: opts.upsertError } : null }; },
        update: (arg: unknown) => ({ eq: async () => { calls.push({ table, op: "update", arg }); return { error: null }; } }),
        insert: async (arg: unknown) => { calls.push({ table, op: "insert", arg }); return { error: null }; },
      }),
    } as never;
    return { admin, calls };
  }

  it("guarda el día, mueve la solicitud y deja el evento con el motivo", async () => {
    const { admin, calls } = fakeAdmin();
    const result = await writeGfDispatchProgram(admin, {
      orderId: "o1", storeId: "s1", day: "2026-10-13", reason: "Reprogramado por el cliente (reporte de la parada de Alexis)",
      actor: "u1", request: { id: "r1", scheduled_for: "2026-10-10", shipment_id: "sh1" }, from: null, now: "2026-10-10T15:00:00Z",
    });
    expect(result).toEqual({ written: true, error: null });
    expect(calls.map((c) => `${c.table}.${c.op}`)).toEqual(["gf_dispatch_programs.upsert", "logistics_requests.update", "order_events.insert"]);
    const event = calls[2]!.arg as { kind: string; note: string };
    expect(event.kind).toBe("dispatch_programmed");
    expect(event.note).toBe("Salida programada para el mar 13/10: Reprogramado por el cliente (reporte de la parada de Alexis).");
  });

  it("si el programa no se guarda, lo dice y no deja evento", async () => {
    const { admin, calls } = fakeAdmin({ upsertError: "boom" });
    const result = await writeGfDispatchProgram(admin, {
      orderId: "o1", storeId: "s1", day: "2026-10-13", reason: "x", actor: "u1", request: null, from: null,
    });
    expect(result).toEqual({ written: false, error: "boom" });
    expect(calls.map((c) => c.table)).toEqual(["gf_dispatch_programs"]);
  });
});

describe("el reporte y la pantalla", () => {
  const actions = read("app/reparto/actions.ts");
  const report = read("lib/stop-report.ts");
  const form = read("components/rider-route.tsx");

  it("la app no programa por su cuenta: lo hace el único camino de reporte (01-11-2026)", () => {
    expect(actions).not.toContain("programFromReport");
    expect(actions).not.toContain("writeGfDispatchProgram");
    expect(actions).not.toContain("rescheduleDateProblem");
    const body = actions.slice(actions.indexOf("export async function reportStop("), actions.indexOf("async function syncStopForRoute("));
    // `rescheduleOn` queda como alias de las pestañas abiertas sin recargar.
    expect(body).toContain("const requested = input.requestedDate !== undefined ? input.requestedDate : input.rescheduleOn;");
    expect(body).toContain("const requestedDate = requested === undefined ? undefined : requested?.trim() || null;");
    const write = body.slice(body.indexOf("await writeStopReport("));
    expect(write.slice(0, write.indexOf("}, { stop, routeStatus });"))).toContain("requestedDate,");
    expect(body).toContain("Sale con Grupo GF el ${programDayLabel(requestedDate)}, la fecha que pidió el cliente.");
    expect(body).not.toContain("prográmalo en Grupo GF.");
  });

  it("la valida el único camino de reporte, ANTES de escribir y solo con «Reprogramado por el cliente»", () => {
    expect(report).toContain('const keeps = input.status === "no_entregado" && reason === "reprogramado";');
    expect(report.indexOf("rescheduleDateProblem(")).toBeGreaterThan(0);
    expect(report.indexOf("rescheduleDateProblem(")).toBeLessThan(report.indexOf('.from("delivery_stops")'));
    expect(report).toContain("...(keeps ? (requestedDate === undefined ? {} : { requested_date: requestedDate }) : { requested_date: null }),");
  });

  it("el campo es opcional, sale solo con ese motivo, va de hoy a 60 días y dice que se programa solo", () => {
    expect(form).toContain('{status === "no_entregado" && reason === "reprogramado" && (');
    expect(form).toContain('Fecha que pidió el cliente <span className="font-normal text-ink-500">(opcional)</span>');
    expect(form).toContain("min={limaToday()}");
    expect(form).toContain("max={limaDayPlus(REQUESTED_DATE_MAX_DAYS)}");
    // El tope del teléfono es el mismo que valida el servidor.
    expect(form).toContain(`const REQUESTED_DATE_MAX_DAYS = ${RESCHEDULE_MAX_DAYS};`);
    expect(form).toContain("Sale ese día con Grupo GF: Kapta lo programa solo.");
    expect(form).not.toContain("Nueva fecha <span");
    expect(form).not.toContain("No se pudo agendar");
    // Abre con la fecha guardada y, sin tocarla, no se manda: una fecha que ya
    // pasó no se vuelve a validar al corregir otra cosa del reporte.
    expect(form).toContain('useState(stop.requested_date ?? "")');
    expect(form).toContain('? (requestedDate === (stop.requested_date ?? "") ? undefined : requestedDate || null)');
  });

  it("la ruta del teléfono trae la fecha y el borrador la recuerda", () => {
    expect(read("lib/routes-access.ts")).toContain('"shipment_id,dispatch_manifest_id,pickup_confirmed,requested_date";');
    expect(read("lib/rider-draft.ts")).toContain("requestedDate?: string;");
    expect(form).toContain("if (draft.requestedDate !== undefined) setRequestedDate(draft.requestedDate);");
  });

  it("«Programar» de Grupo GF y Repro Lima usan la misma escritura", () => {
    expect(read("app/dashboard/courier/actions.ts")).toContain("await writeGfDispatchProgram(admin, {");
    expect(read("lib/repro-lima-program.ts")).toContain("await writeGfDispatchProgram(admin, {");
  });
});

describe("la fecha de la puerta programa la salida (01-11-2026)", () => {
  it("el reporte la programa después de guardar, y la quita si el reporte ya no la trae", () => {
    const report = read("lib/stop-report.ts");
    const recompute = report.lastIndexOf("await recomputeOrderMasterSafe(admin, [stop.order_id])");
    const sync = report.indexOf("await syncDoorDateProgram(admin, {");
    expect(sync).toBeGreaterThan(recompute);
    expect(report).toContain("day: keeps && requestedDate ? requestedDate : null,");
    expect(report).toContain("if (!keeps || requestedDate !== undefined) {");
  });

  it("con el motivo del motorizado, que Repro Lima lee como «Acordado en la puerta»", async () => {
    const { doorProgramReason } = await import("@/lib/door-date-program");
    const { programOrigin } = await import("@/lib/repro-lima");
    const reason = doorProgramReason("Alexis", "2026-10-31");
    expect(reason).toBe("Reprogramado por el cliente (reporte de la parada de Alexis del 31/10): acordado en la puerta.");
    expect(programOrigin(reason)).toBe("motorizado");
    expect(reason.length).toBeLessThanOrEqual(200);
    const door = read("lib/door-date-program.ts");
    // Nunca toca un programa de Repro Lima ni de Despacho.
    expect(door).toContain('if (program && programOrigin(program.reason) === "motorizado") {');
  });

  it("al pasar el paquete a la ruta siguiente se borra el programa: ya está en la caja", () => {
    expect(read("lib/gf-carry-kept-server.ts")).toContain('await clearGfDispatchPrograms(admin, [program as GfProgramRow], input.actor, "Pasó a la ruta del motorizado, que conserva el paquete.");');
  });
});
