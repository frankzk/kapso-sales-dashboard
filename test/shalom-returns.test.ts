// Recepción de las cajas que Shalom devuelve (MOM §9.4 y §12, 03-10-2026).
//
// EL CASO. La caja de #KP128064 llegó al almacén con la etiqueta «CAMBIO DE
// DESTINO» de Shalom, y la pantalla de devoluciones no tenía dónde recibirla:
// era solo de Tanders, y además rechazaba toda guía que el courier hubiera dado
// por ENTREGADA. Shalom la había dado por recogida. Lo que se fija aquí es
// cuándo esa caja se recibe —la clienta nunca tuvo la clave— y cuándo no.

import { describe, expect, it } from "vitest";
import {
  decideShalomReception,
  shalomReceptionPatch,
  type ShalomReturnGuide,
} from "@/lib/shalom/return-reception";
import {
  bucketShalomReturns,
  normalizeReturnGuide,
  shalomReturnSince,
  type ShalomReturnRow,
} from "@/lib/shalom/returns";

const guia = (over: Partial<ShalomReturnGuide>): ShalomReturnGuide => ({
  delivery_status: "anulado",
  custody_state: "retorno",
  returned_at: null,
  pickup_state: "retorno_iniciado",
  dispatched_at: null,
  out_for_delivery_at: null,
  ...over,
});
const sinDar = { hasKey: true, keyGiven: false };

describe("decideShalomReception", () => {
  it("lo que el rastreo dejó de vuelta se recibe y se sella", () => {
    expect(decideShalomReception(guia({}), sinDar, false)).toEqual({ ok: true, seal: true, correct: false, close: false });
  });

  it("#KP128064: Shalom la dio por recogida y la clienta nunca tuvo la clave → se recibe y se corrige", () => {
    // Así estaba: entregada, en custodia de la empresa (las guías por API no
    // escriben custodia) y recogida.
    const recogida = guia({ delivery_status: "entregado", custody_state: "empresa", pickup_state: "recogido" });
    expect(decideShalomReception(recogida, sinDar, false)).toEqual({ ok: true, seal: true, correct: true, close: true });
  });

  it("si la clave se reveló o se envió, puede que la clienta la recogiera: es devolución del cliente", () => {
    const recogida = guia({ delivery_status: "entregado", custody_state: "empresa", pickup_state: "recogido" });
    const d = decideShalomReception(recogida, { hasKey: true, keyGiven: true }, false);
    expect(d).toMatchObject({ ok: false, reason: "entregada" });
    expect(!d.ok && d.message).toContain("devolución del cliente");
  });

  it("sin clave registrada no hay cómo saber si la recogió: se escala", () => {
    const recogida = guia({ delivery_status: "entregado", custody_state: "empresa", pickup_state: "recogido" });
    expect(decideShalomReception(recogida, { hasKey: false, keyGiven: false }, false)).toMatchObject({
      ok: false,
      reason: "sin_clave",
    });
  });

  it("una caja que vuelve antes de que Shalom lo diga se recibe, y la guía viva se cierra", () => {
    // Si se quedara viva, el rastreo la seguiría consultando y la daría por
    // recogida cuando Shalom cierre la guía original.
    const enAgencia = guia({ delivery_status: "pendiente", custody_state: "empresa", pickup_state: "disponible_para_recojo" });
    expect(decideShalomReception(enAgencia, sinDar, false)).toEqual({ ok: true, seal: true, correct: false, close: true });
  });

  it("no se recibe lo que nunca salió del almacén", () => {
    const sinSalir = guia({ delivery_status: "pendiente", custody_state: "empresa", pickup_state: "pendiente_de_envio" });
    expect(decideShalomReception(sinSalir, sinDar, false)).toMatchObject({ ok: false, reason: "nunca_salio" });
  });

  it("«ya recibida» es que una persona la registró, y no se vuelve a sellar", () => {
    expect(decideShalomReception(guia({}), sinDar, true)).toMatchObject({ ok: false, reason: "ya_recibida" });
    const sellada = guia({ custody_state: "devuelto", returned_at: "2026-10-01T15:00:00Z" });
    expect(decideShalomReception(sellada, sinDar, false)).toEqual({ ok: true, seal: false, correct: false, close: false });
  });
});

describe("shalomReceptionPatch", () => {
  const now = "2026-10-03T15:00:00.000Z";

  it("la corrección anula la guía y la sella a nombre de quien escanea", () => {
    expect(shalomReceptionPatch({ ok: true, seal: true, correct: true, close: true }, "persona", now)).toEqual({
      custody_state: "devuelto",
      returned_at: now,
      pickup_state: "devuelto",
      returned_source: "manual",
      returned_by: "persona",
      delivery_status: "anulado",
      status_category: "closed",
    });
  });

  it("lo que ya venía de vuelta solo se sella: la guía ya estaba anulada", () => {
    const patch = shalomReceptionPatch({ ok: true, seal: true, correct: false, close: false }, "persona", now);
    expect(patch).not.toHaveProperty("delivery_status");
    expect(patch).toMatchObject({ custody_state: "devuelto", returned_source: "manual" });
  });

  it("una guía viva que vuelve se anula al recibirla: si no, el rastreo la daría por recogida", () => {
    expect(shalomReceptionPatch({ ok: true, seal: true, correct: false, close: true }, "persona", now)).toMatchObject({
      delivery_status: "anulado",
      status_category: "closed",
      custody_state: "devuelto",
    });
  });

  it("un sello anterior no se pisa", () => {
    expect(shalomReceptionPatch({ ok: true, seal: false, correct: false, close: false }, "persona", now)).toEqual({
      custody_state: "devuelto",
    });
  });
});

describe("normalizeReturnGuide", () => {
  it("se anota tal como la trae la etiqueta, sin espacios", () => {
    expect(normalizeReturnGuide(" 9690 8440 ")).toBe("96908440");
    expect(normalizeReturnGuide("ab-1234")).toBe("AB-1234");
  });

  it("vacía no es un error; con otra forma, sí", () => {
    expect(normalizeReturnGuide("")).toBeNull();
    expect(normalizeReturnGuide(null)).toBeNull();
    expect(normalizeReturnGuide("96/908")).toBe(false);
    expect(normalizeReturnGuide("12")).toBe(false);
  });
});

const fila = (over: Partial<ShalomReturnRow>): ShalomReturnRow => ({
  id: "x",
  guide_code: "92083386",
  order_name: "#KP128064",
  custody_state: "retorno",
  returned_at: null,
  closed_at: "2026-09-22 10:25:24",
  updated_at: "2026-09-23T01:00:17Z",
  received_at: null,
  ...over,
});

describe("bucketShalomReturns", () => {
  it("lo que Shalom devolvió y nadie escaneó está por recibir, de lo más antiguo a lo más reciente", () => {
    const b = bucketShalomReturns([
      fila({ id: "nueva", closed_at: "2026-10-01 10:10:00" }),
      fila({ id: "vieja", closed_at: "2026-09-09 09:52:00" }),
    ]);
    expect(b.porRecibir.map((r) => r.id)).toEqual(["vieja", "nueva"]);
    expect(b.recibidas).toEqual([]);
  });

  it("lo escaneado cuenta como recibido, lo más reciente arriba", () => {
    const b = bucketShalomReturns([
      fila({ id: "a", custody_state: "devuelto", returned_at: "2026-10-02T10:00:00Z", received_at: "2026-10-02T10:00:00Z" }),
      fila({ id: "b", custody_state: "devuelto", returned_at: "2026-10-03T01:13:29Z", received_at: "2026-10-03T01:13:29Z" }),
    ]);
    expect(b.recibidas.map((r) => r.id)).toEqual(["b", "a"]);
    expect(b.porRecibir).toEqual([]);
  });

  it("una guía sellada sin evento de recepción cuenta como recibida en la fecha del sello", () => {
    const b = bucketShalomReturns([fila({ id: "a", custody_state: "devuelto", returned_at: "2026-10-01T15:00:00Z" })]);
    expect(b.recibidas).toEqual([expect.objectContaining({ id: "a", received_at: "2026-10-01T15:00:00Z" })]);
  });

  it("la antigüedad se cuenta desde que Shalom la sacó de la agencia", () => {
    expect(shalomReturnSince(fila({}))).toBe("2026-09-22 10:25:24");
    expect(shalomReturnSince(fila({ closed_at: null }))).toBe("2026-09-23T01:00:17Z");
  });
});
