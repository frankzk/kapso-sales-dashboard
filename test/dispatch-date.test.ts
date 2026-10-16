import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  currentDispatchDate,
  dispatchDateBadge,
  dispatchDateError,
  dispatchDateLabel,
  dispatchDateState,
} from "@/lib/dispatch-date";
import { emptyFilters, matchesDispatchDate } from "@/lib/order-master-filters";
import { buildMasterQuery, parseMasterQuery } from "@/lib/master-query";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const set = (at: string, date: string, reason: string | null = null) => ({ kind: "dispatch_date_set", occurred_at: at, reason, payload: { date } });
const cleared = (at: string) => ({ kind: "dispatch_date_cleared", occurred_at: at, reason: "ya no", payload: {} });

describe("Programar envío (MOM §6.2, 15-10-2026)", () => {
  it("#KP140347: la última fecha manda, con su nota", () => {
    expect(currentDispatchDate([set("2026-10-15T15:00:00Z", "2026-10-19"), set("2026-10-15T16:00:00Z", "2026-10-26", "recibe en su trabajo")])).toEqual({
      date: "2026-10-26",
      note: "recibe en su trabajo",
      at: "2026-10-15T16:00:00Z",
    });
  });
  it("quitarla, o crear una guía después, la deja sin efecto; una guía anterior no", () => {
    expect(currentDispatchDate([set("2026-10-15T15:00:00Z", "2026-10-26"), cleared("2026-10-15T17:00:00Z")])).toBeNull();
    expect(currentDispatchDate([set("2026-10-15T15:00:00Z", "2026-10-26")], ["2026-10-16T10:00:00Z"])).toBeNull();
    expect(currentDispatchDate([set("2026-10-15T15:00:00Z", "2026-10-26")], ["2026-10-10T10:00:00Z"])?.date).toBe("2026-10-26");
    expect(currentDispatchDate([{ kind: "dispatch_date_set", occurred_at: "2026-10-15T15:00:00Z", payload: { date: "26/10" } }])).toBeNull();
    expect(currentDispatchDate([])).toBeNull();
  });
  it("programado a futuro, sale hoy, o su día pasó sin guía", () => {
    expect(dispatchDateState("2026-10-26", "2026-10-16")).toBe("programado");
    expect(dispatchDateState("2026-10-16", "2026-10-16")).toBe("hoy");
    expect(dispatchDateState("2026-10-15", "2026-10-16")).toBe("vencido");
    expect(dispatchDateBadge("2026-10-26", "2026-10-16")).toEqual({ text: "Programado · sale lun 26/10", tone: "info" });
    expect(dispatchDateBadge("2026-10-16", "2026-10-16")).toEqual({ text: "Programado · sale hoy", tone: "warn" });
    expect(dispatchDateBadge("2026-10-14", "2026-10-16")).toEqual({ text: "Programado para el mié 14/10 y no salió", tone: "danger" });
    expect(dispatchDateLabel("2026-10-19")).toBe("lun 19/10");
  });
  it("solo hoy o después, y hasta 45 días", () => {
    expect(dispatchDateError("2026-10-15", "2026-10-16")).toBe("La fecha ya pasó: elige hoy o un día siguiente.");
    expect(dispatchDateError("2026-10-16", "2026-10-16")).toBeNull();
    expect(dispatchDateError("2026-11-30", "2026-10-16")).toBeNull();
    expect(dispatchDateError("2026-12-01", "2026-10-16")).toBe("Programa hasta 45 días adelante.");
    expect(dispatchDateError("26/10", "2026-10-16")).toBe("Elige una fecha válida.");
  });
  it("el filtro del Master: URL, navegador y base", () => {
    expect(matchesDispatchDate("2026-10-26", "programado", "2026-10-16")).toBe(true);
    expect(matchesDispatchDate("2026-10-16", "hoy", "2026-10-16")).toBe(true);
    expect(matchesDispatchDate("2026-10-14", "vencido", "2026-10-16")).toBe(true);
    expect(matchesDispatchDate(null, "sin", "2026-10-16")).toBe(true);
    expect(matchesDispatchDate(null, "programado", "2026-10-16")).toBe(false);
    expect(matchesDispatchDate("2026-10-26", "", "2026-10-16")).toBe(true);
    expect(parseMasterQuery(new URLSearchParams("ep=vencido")).filters.dispatchDate).toBe("vencido");
    expect(parseMasterQuery(new URLSearchParams("ep=otro")).filters.dispatchDate).toBe("");
    const f = emptyFilters();
    f.dispatchDate = "hoy";
    expect(buildMasterQuery({ filters: f, sortKey: "created", page: 1 }).toString()).toBe("ep=hoy");
    expect(read("lib/orders-master-access.ts")).toContain('else if (f.dispatchDate === "programado") q = q.gt("dispatch_scheduled_on", today);');
  });
  it("solo se programa sin guía, con permiso, y queda en el historial con actor y motivo", () => {
    const actions = read("app/dashboard/pedidos/actions.ts");
    expect(actions).toContain('if (!perms.can("master.edit")) return { error: "Tu rol no permite programar envíos." };');
    expect(actions).toContain('if (ctx.row.macro_stage !== "preparacion" || ctx.row.macro_substage !== "por_generar_rotulo") {');
    expect(actions).toContain('if (why.length < 3) return { error: "Escribe por qué se quita la fecha." };');
    const master = read("lib/order-master.ts");
    expect(master).toContain('macro.stage === "preparacion" && macro.substage === "por_generar_rotulo"');
    expect(master).toContain("? currentDispatchDate(orderEvents, guides.map((g) => g.created_at))?.date ?? null");
    expect(read("db/migrations/0267_order_master_dispatch_scheduled_on.sql")).toContain("add column if not exists dispatch_scheduled_on date");
  });
  it("en vivo: «Confirmó el pedido» acepta «Sale el», validado antes de registrar el intento", () => {
    const actions = read("app/dashboard/pedidos/actions.ts");
    expect(actions).toContain('const dispatchOn = result.confirms ? input.dispatchOn?.trim() ?? "" : "";');
    expect(actions).toContain("if (dateError) return { error: `Fecha de envío: ${dateError}` };");
    expect(actions).toContain("if (dispatchOn && !response.duplicate) {");
    expect(actions).toContain("payload: { date: dispatchOn, at_confirmation: true },");
    const drawer = read("components/order-drawer.tsx");
    expect(drawer).toContain("Sale el (opcional)");
    expect(drawer).toContain('dispatchOn: selected?.confirms ? dispatchOn : "",');
  });
  it("el MOM lo documenta", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    expect(mom).toContain("#### Programar envío (15-10-2026)");
    expect(mom).toContain("Programado para el lun 19/10 y no salió");
    expect(mom).toContain("el campo **«Sale el (opcional)»** guarda la fecha acordada en la llamada");
  });
});
