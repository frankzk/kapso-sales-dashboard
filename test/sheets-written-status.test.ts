// Liquidaciones 2 — edición a mano del estado en una hoja cuaderno (MOM §30.7):
// lo escrito se guarda tal cual y el grupo se deriva por alias.
import { describe, expect, it } from "vitest";
import { applyWrittenPayment, applyWrittenStatus } from "@/lib/sheets/written-status";
import { REPARTO_PROPIO_STATUSES, lookupFromTemplates } from "@/lib/sheets/statuses";

const lookup = lookupFromTemplates(REPARTO_PROPIO_STATUSES);

describe("applyWrittenStatus", () => {
  it("guarda el texto tal cual y deriva el estado del grupo", () => {
    const r = applyWrittenStatus({ fecha: "2026-09-15", revision: null }, "cel apagado", lookup);
    expect(r.changes).toEqual({ estado_reportado: "cel apagado", estado: "no_responde", reprogramar_para: null, revision: null });
    expect(r.unknownAlias).toBeNull();
  });

  it("un día de la semana es reprogramado con fecha calculada desde la ruta", () => {
    const r = applyWrittenStatus({ fecha: "2026-09-15" }, "Jueves", lookup);
    expect(r.changes).toMatchObject({ estado_reportado: "Jueves", estado: "reprogramado", reprogramar_para: "2026-09-17" });
  });

  it("lo que no resuelve queda literal, a revisión y como alias sin equivalente", () => {
    const r = applyWrittenStatus({ fecha: "2026-09-15", revision: "sin_fecha" }, "portería no deja", lookup);
    expect(r.changes).toMatchObject({ estado_reportado: "portería no deja", estado: null, revision: "sin_fecha, estado_sin_equivalente" });
    expect(r.unknownAlias).toBe("PORTERIA NO DEJA");
  });

  it("corregir un estado que estaba a revisión limpia solo esa marca", () => {
    const r = applyWrittenStatus({ fecha: "2026-09-15", revision: "sin_fecha, estado_sin_equivalente" }, "ENTREGADO", lookup);
    expect(r.changes.revision).toBe("sin_fecha");
    expect(r.changes.estado).toBe("entregado");
  });

  it("vaciar la celda vacía el estado y el escrito", () => {
    const r = applyWrittenStatus({ revision: "estado_sin_equivalente" }, "", lookup);
    expect(r.changes).toEqual({ estado_reportado: null, estado: null, reprogramar_para: null, revision: null });
  });
});

describe("applyWrittenPayment", () => {
  it("guarda lo escrito y lo traduce a la lista cerrada", () => {
    expect(applyWrittenPayment("yape gf")).toEqual({ metodo_pago_reportado: "yape gf", metodo_pago: "Yape Grupo GF" });
    expect(applyWrittenPayment("cosa rara")).toEqual({ metodo_pago_reportado: "cosa rara", metodo_pago: null });
    expect(applyWrittenPayment("")).toEqual({ metodo_pago_reportado: null, metodo_pago: null });
  });
});
