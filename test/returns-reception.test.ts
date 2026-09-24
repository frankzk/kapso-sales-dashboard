// Recepción física de devoluciones frente a lo que el courier declara.
//
// EL CASO (24-09-2026). Tanders reportaba RETURNED en 108 guías y el sistema
// las daba por devueltas, pero nadie había confirmado físicamente ni una. El
// botón manual del drawer estaba además bloqueado para ellas, porque leía el
// sello del courier como «ya se recibió en almacén». Lo que se fija acá es que
// esa confusión no vuelva: sello del courier ≠ caja recibida.

import { describe, expect, it } from "vitest";
import {
  bucketReturns,
  daysSince,
  decideReception,
  type ReconciliationRow,
} from "@/lib/returns-reception";

describe("decideReception", () => {
  it("una guía que Tanders ya selló como devuelta SÍ se puede recibir", () => {
    // Es el caso de las 108: `returned_at` puesto por la API del courier. Eso
    // no es «recibida», es justo lo que hay que confirmar. Y no se vuelve a
    // sellar: la procedencia de una devolución no se pisa (0118).
    expect(
      decideReception(
        { delivery_status: "anulado", custody_state: "devuelto", returned_at: "2026-09-20T10:00:00Z" },
        false,
      ),
    ).toEqual({ ok: true, seal: false });
  });

  it("si el courier aún no la reportó, quien la tiene en la mano la sella", () => {
    // Llega la caja mientras Tanders todavía dice RETURNING.
    expect(
      decideReception({ delivery_status: "en_ruta", custody_state: "retorno", returned_at: null }, false),
    ).toEqual({ ok: true, seal: true });
  });

  it("«ya recibida» es que una PERSONA la registró, no el sello del courier", () => {
    const d = decideReception(
      { delivery_status: "anulado", custody_state: "devuelto", returned_at: "2026-09-20T10:00:00Z" },
      true,
    );
    expect(d).toMatchObject({ ok: false, reason: "ya_recibida" });
  });

  it("una guía que el courier dio por ENTREGADA no se recibe como devolución", () => {
    // Si la caja está físicamente acá, es una incidencia que hay que escalar,
    // no una devolución más que se registra en silencio.
    const d = decideReception({ delivery_status: "entregado", custody_state: "courier", returned_at: null }, false);
    expect(d).toMatchObject({ ok: false, reason: "entregada" });
  });

  it("no se recibe lo que nunca salió del almacén", () => {
    const d = decideReception({ delivery_status: "pendiente", custody_state: "empresa", returned_at: null }, false);
    expect(d).toMatchObject({ ok: false, reason: "nunca_salio" });
  });
});

const fila = (over: Partial<ReconciliationRow>): ReconciliationRow => ({
  id: "x",
  guide_code: "TANDER1",
  order_name: "#KP1",
  reported_status: "RETURNED",
  custody_state: "devuelto",
  returned_at: "2026-09-20T10:00:00Z",
  returned_source: "tanders_api",
  received_at: null,
  ...over,
});

describe("bucketReturns", () => {
  it("lo que Tanders dio por devuelto y nadie escaneó, falta", () => {
    const b = bucketReturns([fila({ id: "a" })]);
    expect(b.faltan.map((r) => r.id)).toEqual(["a"]);
    expect(b.recibidas).toEqual([]);
  });

  it("lo escaneado cuenta como recibido, lo diga como lo diga el courier", () => {
    const b = bucketReturns([
      fila({ id: "a", received_at: "2026-09-24T10:00:00Z" }),
      fila({ id: "b", reported_status: "RETURNING", returned_at: null, returned_source: null, received_at: "2026-09-24T11:00:00Z" }),
    ]);
    expect(b.recibidas.map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(b.faltan).toEqual([]);
  });

  it("lo que aún viene de vuelta no se reclama todavía", () => {
    const b = bucketReturns([
      fila({ id: "a", reported_status: "RETURNING", custody_state: "retorno", returned_at: null, returned_source: null }),
    ]);
    expect(b.enCamino.map((r) => r.id)).toEqual(["a"]);
    expect(b.faltan).toEqual([]);
  });

  it("el sello de la API cuenta como «dice que la devolvió» aunque el estado haya cambiado", () => {
    // El último reporte pudo sobrescribir `reported_status`, pero el sello de
    // su API sigue diciendo que la dio por devuelta.
    const b = bucketReturns([fila({ id: "a", reported_status: "PICKED", returned_source: "tanders_api" })]);
    expect(b.faltan.map((r) => r.id)).toEqual(["a"]);
  });

  it("las que faltan salen de la más antigua a la más reciente", () => {
    const b = bucketReturns([
      fila({ id: "nueva", returned_at: "2026-09-23T10:00:00Z" }),
      fila({ id: "vieja", returned_at: "2026-09-10T10:00:00Z" }),
    ]);
    expect(b.faltan.map((r) => r.id)).toEqual(["vieja", "nueva"]);
  });
});

describe("daysSince", () => {
  it("cuenta días enteros y no inventa con fechas vacías", () => {
    const now = new Date("2026-09-24T12:00:00Z");
    expect(daysSince("2026-09-20T13:00:00Z", now)).toBe(3);
    expect(daysSince(null, now)).toBeNull();
  });
});
