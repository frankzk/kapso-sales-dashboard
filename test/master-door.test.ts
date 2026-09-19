// La puerta única al Master (MOM §11.4, §29.12, §30.8): sus guardas, puras.
import { describe, expect, it } from "vitest";
import { masterDoorVerdict } from "@/lib/master-door";

const stop = (over: Partial<{ status: string; photo_path: string | null; voucher_path: string | null }> = {}) => ({
  status: "entregado",
  photo_path: "r/s/foto.jpg",
  voucher_path: null,
  ...over,
});

describe("masterDoorVerdict", () => {
  it("sin guarda pasa: líneas de Liquidaciones 1 y filas del Excel histórico sin parada", () => {
    expect(masterDoorVerdict({ target: "entregado" })).toEqual({ ok: true });
    expect(masterDoorVerdict({ target: "anulado", guard: {} })).toEqual({ ok: true });
  });

  it("una observación abierta en la fila retiene el cruce, venga de donde venga", () => {
    expect(masterDoorVerdict({ target: "entregado", guard: { openObservations: 1 } })).toMatchObject({ ok: false, code: "observacion_abierta" });
    expect(masterDoorVerdict({ target: "entregado", guard: { openObservations: 0, stop: stop() } })).toEqual({ ok: true });
  });

  it("con parada, la parada manda: debe estar entregada, y con evidencia cuando se exige", () => {
    expect(masterDoorVerdict({ target: "entregado", guard: { stop: stop({ status: "no_entregado" }) } })).toMatchObject({ ok: false, code: "sin_entrega_en_parada" });
    expect(masterDoorVerdict({ target: "entregado", guard: { stop: stop({ photo_path: null }), requireEvidence: true } })).toMatchObject({ ok: false, code: "sin_evidencia" });
    expect(masterDoorVerdict({ target: "entregado", guard: { stop: stop({ photo_path: null, voucher_path: "r/s/yape.jpg" }), requireEvidence: true } })).toEqual({ ok: true });
    expect(masterDoorVerdict({ target: "entregado", guard: { stop: stop({ photo_path: null }), requireEvidence: false } })).toEqual({ ok: true });
  });

  it("un rechazo (anulado) desde Rutas no exige que la parada esté entregada", () => {
    expect(masterDoorVerdict({ target: "anulado", guard: { stop: stop({ status: "no_entregado" }), requireEvidence: true } })).toEqual({ ok: true });
  });
});
