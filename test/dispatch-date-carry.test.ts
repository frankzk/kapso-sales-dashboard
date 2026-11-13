// El rótulo de Lima conserva la fecha de «Programar envío» (12-11-2026, MOM
// §6.2): #KP204348 se programó para el 16/11 y, al imprimir su rótulo «por
// definir», Repro Lima lo puso a salir el jue 12/11.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { carriedDispatchDay, currentDispatchDate } from "@/lib/dispatch-date";

const read = (p: string) => readFileSync(p, "utf8");

describe("la fecha programada pasa al rótulo de Lima", () => {
  it("solo hoy o un día que viene", () => {
    expect(carriedDispatchDay("2026-11-16", "2026-11-12")).toBe("2026-11-16");
    expect(carriedDispatchDay("2026-11-12", "2026-11-12")).toBe("2026-11-12");
    expect(carriedDispatchDay("2026-11-10", "2026-11-12")).toBeNull();
    expect(carriedDispatchDay(null, "2026-11-12")).toBeNull();
    expect(carriedDispatchDay("16/11", "2026-11-12")).toBeNull();
  });

  it("se lee ANTES de crear la salida: la salida nueva no la anula", () => {
    const events = [{ kind: "dispatch_date_set", occurred_at: "2026-11-08T20:11:20Z", payload: { date: "2026-11-16" } }];
    expect(currentDispatchDate(events, [])?.date).toBe("2026-11-16");
    expect(currentDispatchDate(events, ["2026-11-08T21:25:28Z"])).toBeNull();
  });

  it("la acción la escribe como programa de Grupo GF sin pisar uno existente", () => {
    const actions = read("app/dashboard/pedidos/actions.ts");
    const fn = actions.slice(actions.indexOf("export async function createManualRouteOutput("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain('tbd && operation === "lima"');
    expect(body).toContain("programmedDayForOutput(admin, orderId, outputs.map((output) => output.created_at))");
    expect(body.indexOf("programmedDayForOutput(")).toBeLessThan(body.indexOf('.from("shipments")\n    .insert('));
    expect(body).toContain("next_followup_at: `${plannedDate}T12:00:00-05:00`");
    expect(body).toContain("if (carriedDay) await carryDispatchDateToGfProgram(admin, ctx, carriedDay);");
    const carry = actions.slice(actions.indexOf("async function carryDispatchDateToGfProgram("));
    expect(carry.slice(0, carry.indexOf("\n}\n"))).toMatch(/if \(error \|\| existing\) return;[\s\S]*writeGfDispatchProgram/);
  });

  it("el MOM lo documenta", () => {
    expect(read("docs/mom/master-pedidos-v1.md")).toContain("**En Lima, el rótulo la hereda (12-11-2026).**");
  });
});
