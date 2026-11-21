// GF Courier volvió a programar su guía después de la novedad (owner, 21-11-2026, #KP207270; MOM §9.5 y §29.17):
// el último cambio de fecha recibido después del último cambio de estado.
import { describe, expect, it } from "vitest";
import { gfRescheduleAfterIncident } from "@/lib/gf-reschedule";

const status = (at: string) => ({ type: "order.status_changed", received_at: at });
const date = (at: string, newDate: string | null) => ({ type: "order.delivery_date_changed", received_at: at, new_date: newDate });

describe("gfRescheduleAfterIncident", () => {
  it("#KP207270: la novedad del 19/11 y GF la cambia al 24/11 el 20/11 → vuelve a salir el 24/11", () => {
    expect(gfRescheduleAfterIncident([
      status("2026-11-19T15:36:23Z"), // en reparto
      status("2026-11-19T18:11:36Z"), // INCIDENT:NO_ANSWER
      { type: "order.returned_to_warehouse", received_at: "2026-11-20T15:01:52Z" },
      date("2026-11-20T15:06:06Z", "2026-11-24"),
    ])).toEqual({ date: "2026-11-24", at: "2026-11-20T15:06:06Z" });
  });

  it("un cambio de estado posterior (salió otra vez, otra visita fallida) lo deja sin efecto", () => {
    expect(gfRescheduleAfterIncident([status("2026-11-19T18:11:36Z"), date("2026-11-20T15:06:06Z", "2026-11-24"), status("2026-11-24T14:00:00Z")])).toBeNull();
  });

  it("un cambio de fecha de antes de la novedad («No respondió antes de salir») no cuenta", () => {
    expect(gfRescheduleAfterIncident([date("2026-11-17T13:00:00Z", "2026-11-18"), status("2026-11-18T15:00:00Z"), status("2026-11-18T18:00:00Z")])).toBeNull();
  });

  it("manda el último cambio de fecha; uno sin día válido no cuenta", () => {
    expect(gfRescheduleAfterIncident([
      status("2026-11-19T18:11:36Z"),
      date("2026-11-20T15:06:06Z", "2026-11-24"),
      date("2026-11-21T10:00:00Z", "2026-11-25"),
      date("2026-11-21T11:00:00Z", "mañana"),
    ])).toEqual({ date: "2026-11-25", at: "2026-11-21T10:00:00Z" });
    expect(gfRescheduleAfterIncident([status("2026-11-19T18:11:36Z"), date("2026-11-20T15:06:06Z", null)])).toBeNull();
  });

  it("sin un cambio de estado conocido no se sabe de cuándo es la fecha: no cuenta", () => {
    expect(gfRescheduleAfterIncident([date("2026-11-20T15:06:06Z", "2026-11-24")])).toBeNull();
    expect(gfRescheduleAfterIncident([])).toBeNull();
  });
});
