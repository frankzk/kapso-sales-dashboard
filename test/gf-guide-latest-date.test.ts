// Owner, 23-11-2026, #KP207897: «si este es para el 25/11, ¿por qué sale como para
// mañana?». La guía GF se creó el 21/11 con fecha estimada 21/11; GF la movió al
// 23/11 (no contestó) y el acuerdo de Repro Lima, al 25/11 con la misma guía. La
// fila decía «lun 23/11» (el 21/11 corrido al lunes). Ahora manda el último cambio
// de fecha que avisó GF (MOM §9.5).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { gfLatestDeliveryDate } from "@/lib/gf-reschedule";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const status = (at: string) => ({ type: "order.status_changed", received_at: at });
const date = (at: string, newDate: string | null) => ({ type: "order.delivery_date_changed", received_at: at, new_date: newDate });

describe("el día vigente de una guía GF que no salió", () => {
  it("#KP207897: el último cambio, aunque haya estados antes o después", () => {
    expect(gfLatestDeliveryDate([
      status("2026-11-21T13:42:05Z"), // creada
      status("2026-11-21T13:46:58Z"), // impresa
      status("2026-11-21T13:49:52Z"), // por asignar
      date("2026-11-21T18:47:56Z", "2026-11-23"), // GF: no contestó
      date("2026-11-23T00:00:53Z", "2026-11-25"), // Repro Lima: acuerdo
    ])).toBe("2026-11-25");
    expect(gfLatestDeliveryDate([date("2026-11-21T18:47:56Z", "2026-11-23"), status("2026-11-22T13:00:00Z")])).toBe("2026-11-23");
  });

  it("manda el más reciente por hora de llegada, no por el orden de la lista ni por el día", () => {
    expect(gfLatestDeliveryDate([date("2026-11-23T00:00:53Z", "2026-11-25"), date("2026-11-21T18:47:56Z", "2026-11-28")])).toBe("2026-11-25");
  });

  it("sin cambios, o sin un día válido, no hay día: se usa el pedido a GF", () => {
    expect(gfLatestDeliveryDate([])).toBeNull();
    expect(gfLatestDeliveryDate([status("2026-11-21T13:42:05Z")])).toBeNull();
    expect(gfLatestDeliveryDate([date("2026-11-21T18:47:56Z", "mañana"), date("sin hora", "2026-11-24")])).toBeNull();
  });

  it("la lectura de Repro Lima lee los cambios de fecha junto al pedido a GF y el cambio manda", () => {
    const src = read("lib/repro-lima-pending-access.ts");
    const body = src.slice(src.indexOf("async function loadGfGuideDays("), src.indexOf("async function loadGfReschedules("));
    expect(body).toContain('.eq("type", "order.delivery_date_changed")');
    expect(body).toContain("const day = changed ?? gfGuideDay(r.scheduled_date, r.estimated);");
    expect(body).not.toMatch(/for \(let offset[^\n]*\n[^\n]*await /);
  });
});
