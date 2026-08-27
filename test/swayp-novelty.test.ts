import { describe, expect, it } from "vitest";

import {
  NOVELTY_ACTIONS,
  buildNoveltySolution,
  isNoveltyAction,
  noveltyActionIsReturn,
} from "@/lib/swayp-novelty";

// 2026-06-16 12:00 UTC = 07:00 en Lima, mismo día. «Mañana» es el 17.
const NOW = new Date("2026-06-16T12:00:00Z");

const base = { guia: "10000022753", comentario: "La clienta pidió que vuelvan", now: NOW };

describe("buildNoveltySolution", () => {
  it("arma la acción 1 sin fecha", () => {
    const r = buildNoveltySolution({ ...base, accion: "1" });
    expect(r).toEqual({
      ok: true,
      input: { guia: "10000022753", accion: "1", comentario: "La clienta pidió que vuelvan" },
    });
  });

  it("no manda fechaEntrega en las acciones 1 y 2, aunque venga cargada", () => {
    // La documentación dice que se ignora. Preferimos no mandarla a confiar en
    // que la ignoren.
    for (const accion of ["1", "2"] as const) {
      const r = buildNoveltySolution({ ...base, accion, fechaEntregaIso: "2026-06-20" });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.input).not.toHaveProperty("fechaEntrega");
    }
  });

  it("exige fecha en la acción 3 y la conserva tal cual", () => {
    expect(buildNoveltySolution({ ...base, accion: "3" })).toMatchObject({
      ok: false,
      error: "Elige la nueva fecha de entrega.",
    });
    const r = buildNoveltySolution({ ...base, accion: "3", fechaEntregaIso: "2026-06-20" });
    expect(r).toMatchObject({ ok: true, input: { accion: "3", fechaEntrega: "2026-06-20" } });
  });

  it("rechaza reprogramar para hoy o para ayer: la ruta del día ya salió", () => {
    for (const day of ["2026-06-16", "2026-06-15"]) {
      expect(buildNoveltySolution({ ...base, accion: "3", fechaEntregaIso: day })).toMatchObject({
        ok: false,
        error: "La nueva fecha de entrega tiene que ser desde mañana.",
      });
    }
  });

  it("acepta un ISO 8601 completo, no sólo YYYY-MM-DD", () => {
    const r = buildNoveltySolution({
      ...base,
      accion: "3",
      fechaEntregaIso: "2026-06-20T14:30:00.000Z",
    });
    expect(r).toMatchObject({ ok: true, input: { fechaEntrega: "2026-06-20T14:30:00.000Z" } });
  });

  it("rechaza una fecha con forma de fecha pero imposible", () => {
    expect(
      buildNoveltySolution({ ...base, accion: "3", fechaEntregaIso: "2026-13-45" }),
    ).toMatchObject({ ok: false, error: "La nueva fecha de entrega no es válida." });
  });

  it("exige comentario: Swayp se lo muestra al mensajero", () => {
    for (const comentario of ["", "   ", null, undefined]) {
      expect(buildNoveltySolution({ ...base, comentario, accion: "1" })).toMatchObject({
        ok: false,
        error: "Escribe un comentario: el mensajero lo lee para saber qué hacer.",
      });
    }
  });

  it("recorta los espacios de guía y comentario", () => {
    const r = buildNoveltySolution({
      guia: "  10000022753  ",
      comentario: "  vuelve mañana  ",
      accion: "1",
      now: NOW,
    });
    expect(r).toMatchObject({ ok: true, input: { guia: "10000022753", comentario: "vuelve mañana" } });
  });

  it("se niega sin guía de Swayp: una guía manual no tiene novedad que resolver", () => {
    for (const guia of ["", "   ", null, undefined]) {
      expect(buildNoveltySolution({ ...base, guia, accion: "1" })).toMatchObject({
        ok: false,
        error: "Este envío no tiene guía de Swayp, así que no hay novedad que resolver.",
      });
    }
  });

  it("rechaza acciones que Swayp no acepta", () => {
    for (const accion of ["0", "4", "9", "", "volver", null, undefined]) {
      expect(buildNoveltySolution({ ...base, accion })).toMatchObject({
        ok: false,
        error: "Elige qué hacer con la novedad.",
      });
    }
  });

  it("valida la guía ANTES que la acción: sin guía no se pregunta el resto", () => {
    // Refleja el orden real de la API, que resuelve la guía antes del payload.
    expect(buildNoveltySolution({ ...base, guia: null, accion: "99" })).toMatchObject({
      ok: false,
      error: "Este envío no tiene guía de Swayp, así que no hay novedad que resolver.",
    });
  });
});

describe("NOVELTY_ACTIONS", () => {
  it("sólo «devolver al remitente» cuenta como devolución", () => {
    expect(noveltyActionIsReturn("2")).toBe(true);
    expect(noveltyActionIsReturn("1")).toBe(false);
    expect(noveltyActionIsReturn("3")).toBe(false);
  });

  it("sólo «reprogramar» pide fecha", () => {
    expect(NOVELTY_ACTIONS["3"].needsDate).toBe(true);
    expect(NOVELTY_ACTIONS["1"].needsDate).toBe(false);
    expect(NOVELTY_ACTIONS["2"].needsDate).toBe(false);
  });

  it("isNoveltyAction acepta exactamente 1, 2 y 3", () => {
    expect(["1", "2", "3"].every(isNoveltyAction)).toBe(true);
    expect([1, "4", "", null, undefined, {}].some(isNoveltyAction)).toBe(false);
  });
});
