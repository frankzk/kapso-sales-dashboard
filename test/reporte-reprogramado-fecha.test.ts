// «Reprogramado por el cliente» con fecha. El 10-10-2026 la fecha del reporte
// agendaba la salida de Grupo GF de una vez (#908). Desde el 12-10-2026 (D9,
// decisión 7: la fecha que da el cliente en la puerta se confirma, NUNCA de
// forma automática) es la «Fecha que pidió el cliente»: queda en la parada
// (`delivery_stops.requested_date`) y la tienda la confirma en Repro Lima, que
// programa por el mismo camino que «Programar».

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

  it("el reporte ya no programa: la fecha queda en la parada y la tienda la confirma (D9)", () => {
    expect(actions).not.toContain("programFromReport");
    expect(actions).not.toContain("writeGfDispatchProgram");
    expect(actions).not.toContain("rescheduleDateProblem");
    const body = actions.slice(actions.indexOf("export async function reportStop("), actions.indexOf("async function syncStopForRoute("));
    // `rescheduleOn` queda como alias de las pestañas abiertas sin recargar.
    expect(body).toContain("const requested = input.requestedDate !== undefined ? input.requestedDate : input.rescheduleOn;");
    expect(body).toContain("const requestedDate = requested === undefined ? undefined : requested?.trim() || null;");
    const write = body.slice(body.indexOf("await writeStopReport("));
    expect(write.slice(0, write.indexOf("}, { stop, routeStatus });"))).toContain("requestedDate,");
    expect(body).toContain("Fecha que pidió el cliente: ${programDayLabel(requestedDate)}. La tienda la confirma antes de programarla.");
    expect(body).not.toContain("prográmalo en Grupo GF.");
  });

  it("la valida el único camino de reporte, ANTES de escribir y solo con «Reprogramado por el cliente»", () => {
    expect(report).toContain('const keeps = input.status === "no_entregado" && reason === "reprogramado";');
    expect(report.indexOf("rescheduleDateProblem(")).toBeGreaterThan(0);
    expect(report.indexOf("rescheduleDateProblem(")).toBeLessThan(report.indexOf('.from("delivery_stops")'));
    expect(report).toContain("...(keeps ? (requestedDate === undefined ? {} : { requested_date: requestedDate }) : { requested_date: null }),");
  });

  it("el campo es opcional, sale solo con ese motivo, va de hoy a 60 días y dice que la tienda la confirma", () => {
    expect(form).toContain('{status === "no_entregado" && reason === "reprogramado" && (');
    expect(form).toContain('Fecha que pidió el cliente <span className="font-normal text-ink-500">(opcional)</span>');
    expect(form).toContain("min={limaToday()}");
    expect(form).toContain("max={limaDayPlus(REQUESTED_DATE_MAX_DAYS)}");
    // El tope del teléfono es el mismo que valida el servidor.
    expect(form).toContain(`const REQUESTED_DATE_MAX_DAYS = ${RESCHEDULE_MAX_DAYS};`);
    expect(form).toContain("La tienda la confirma con el cliente antes de programarla.");
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
