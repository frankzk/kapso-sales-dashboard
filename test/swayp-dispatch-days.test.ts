import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SWAYP_SUNDAY_ERROR,
  firstSwaypDispatchDay,
  isSwaypDispatchDay,
  swaypDispatchDayOptions,
} from "@/lib/swayp-dispatch-days";

/**
 * Swayp despacha de lunes a sábado (owner, 10-10-2026). El selector nativo no
 * dejaba apagar los domingos; ahora se ofrecen solo días válidos y el servidor
 * rechaza el domingo igual.
 */
const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");

describe("los días de despacho Swayp", () => {
  it("el domingo no es día de despacho; el sábado y el lunes sí", () => {
    expect(isSwaypDispatchDay("2026-10-11")).toBe(false); // domingo
    expect(isSwaypDispatchDay("2026-10-10")).toBe(true); // sábado
    expect(isSwaypDispatchDay("2026-10-12")).toBe(true); // lunes
  });

  it("lee también el ISO que guarda la app (medianoche UTC del día)", () => {
    expect(isSwaypDispatchDay(new Date("2026-10-11").toISOString())).toBe(false);
    expect(isSwaypDispatchDay(new Date("2026-10-12").toISOString())).toBe(true);
  });

  it("sin fecha válida no es día de despacho", () => {
    expect(isSwaypDispatchDay("")).toBe(false);
    expect(isSwaypDispatchDay(null)).toBe(false);
    expect(isSwaypDispatchDay("mañana")).toBe(false);
  });

  it("las opciones empiezan mañana y nunca traen un domingo", () => {
    const opts = swaypDispatchDayOptions("2026-10-09", 12); // viernes
    expect(opts[0]!.value).toBe("2026-10-10");
    expect(opts[0]!.label.startsWith("Mañana")).toBe(true);
    expect(opts).toHaveLength(12);
    expect(opts.every((o) => isSwaypDispatchDay(o.value))).toBe(true);
    expect(opts.map((o) => o.value)).not.toContain("2026-10-11");
  });

  it("si mañana es domingo, la primera fecha es el lunes", () => {
    expect(firstSwaypDispatchDay("2026-10-10")).toBe("2026-10-12");
    expect(swaypDispatchDayOptions("2026-10-10", 1)[0]!.label.startsWith("Mañana")).toBe(false);
  });
});

describe("todas las puertas lo aplican", () => {
  it("el servidor rechaza el domingo en la guía directa, la guía manual y el reenvío", () => {
    const actions = read("app/dashboard/envios/actions.ts");
    expect(actions).toContain("if (!isSwaypDispatchDay(dispatchDay)) return { error: SWAYP_SUNDAY_ERROR };");
    expect(actions).toContain("if (!isSwaypDispatchDay(input.nextFollowupAt)) return { error: SWAYP_SUNDAY_ERROR };");
    expect(read("lib/swayp-reenvio.ts")).toContain("if (!isSwaypDispatchDay(input.nextFollowupAt)) return { error: SWAYP_SUNDAY_ERROR };");
    // «Cliente confirma» por Swayp emite la guía nueva con esa fecha.
    expect(actions).toContain('(input.reprogramProvider ?? "fenix") === "fenix" &&\n    !isSwaypDispatchDay(input.nextFollowupAt)');
    expect(SWAYP_SUNDAY_ERROR).toContain("lunes a sábado");
  });

  it("las pantallas ofrecen la lista de días, no el calendario nativo", () => {
    const modal = read("components/direct-fenix-guide-modal.tsx");
    expect(modal).toContain("<SwaypDispatchDateSelect");
    expect(modal).not.toContain('type="date"');
    const envios = read("components/shipments.tsx");
    // Guía a mano, excepción de la anulada y «Cliente confirma» por Swayp.
    expect(envios.match(/<SwaypDispatchDateSelect/g) ?? []).toHaveLength(3);
    expect(envios).toContain('const confirmaPorSwayp = disposition === "confirma" && reprogramProvider !== "aliclik";');
  });
});

describe("la emisión Swayp se enlaza con su guía al rellenar una salida (0239)", () => {
  const sql = read("db/migrations/0239_swayp_link_emission_on_fill.sql");
  it("hay trigger en UPDATE, además del de INSERT", () => {
    expect(sql).toContain("create trigger swayp_link_emission_on_fill after update of swayp_guide, courier on shipments");
    expect(sql).toContain("execute function swayp_link_emission();");
  });
  it("y enlaza las que quedaron sueltas, solo con child_id vacío", () => {
    expect(sql).toContain("where e.child_id is null");
    expect(sql).toContain("and s.swayp_guide = e.guide_code;");
  });
  it("el smoke de la base lo prueba", () => {
    expect(read("scripts/sql/swayp_auto_smoke.sql")).toContain("filled output did not link its emission");
  });
});
