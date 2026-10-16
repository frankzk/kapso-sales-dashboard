import { describe, expect, it } from "vitest";
import {
  shalomTrackItem,
  TRACK_BURST,
  TRACK_QUOTA_PER_MINUTE,
  TrackQuota,
  trackRetryAfterMs,
  type TrackableGuide,
} from "@/lib/shalom/track-pace";
import { SHALOM_ORIGIN } from "@/lib/shalom/origin";

// 16-10-2026, 04:00 de Lima: la primera pasada con bitácora preguntó dos lotes
// de 50 y el tercero volvió con 429 «pediste 50 guías y superás tu cupo de
// rastreo por minuto; reintentá en 12s». La pasada terminó en 4 s con 100 de
// 459 guías preguntadas.
describe("el cupo del rastreo de Shalom", () => {
  const reloj = (t0 = 0) => {
    let t = t0;
    return { now: () => t, avanza: (ms: number) => (t += ms) };
  };

  it("120 guías de golpe y después 2 por segundo", () => {
    expect(TRACK_BURST).toBe(120);
    expect(TRACK_QUOTA_PER_MINUTE).toBe(120);
    const r = reloj();
    const q = new TrackQuota(r.now);
    expect(q.waitFor(50)).toBe(0);
    q.spend(50);
    expect(q.waitFor(50)).toBe(0);
    q.spend(50);
    // Quedan 20: para 50 faltan 30, a 2 por segundo son 15 s (+ un margen).
    expect(q.waitFor(50)).toBe(15_250);
    r.avanza(15_250);
    expect(q.waitFor(50)).toBe(0);
  });

  it("nunca acumula más de lo que Shalom deja de una vez", () => {
    const r = reloj();
    const q = new TrackQuota(r.now);
    r.avanza(10 * 60_000);
    q.spend(120);
    expect(q.waitFor(50)).toBe(25_250);
  });

  it("un 429 manda: se espera lo que dice Shalom para ese lote", () => {
    const r = reloj();
    const q = new TrackQuota(r.now);
    // Nuestra cuenta dice que hay cupo, pero el panel también rastreó.
    expect(q.waitFor(50)).toBe(0);
    q.exhausted(12_500, 50);
    expect(q.waitFor(50)).toBe(12_750);
    r.avanza(12_750);
    expect(q.waitFor(50)).toBe(0);
  });

  it("lee la espera del mensaje de Shalom, con tope", () => {
    expect(trackRetryAfterMs("pediste 50 guías y superás tu cupo de rastreo por minuto; reintentá en 12s")).toBe(12_500);
    expect(trackRetryAfterMs("reintenta en 3 s")).toBe(3_500);
    expect(trackRetryAfterMs("cupo agotado")).toBe(15_000);
    expect(trackRetryAfterMs(null)).toBe(15_000);
    expect(trackRetryAfterMs("reintentá en 600s")).toBe(60_000);
  });
});

describe("cómo se pregunta por cada guía", () => {
  const guia = (over: Partial<TrackableGuide> = {}): TrackableGuide => ({
    id: "s-1",
    guide_code: "98130498",
    shalom_codigo: "D7MN",
    shalom_ose_id: null,
    created_via: SHALOM_ORIGIN.api,
    ...over,
  });
  const item = (g: TrackableGuide) => shalomTrackItem(g, SHALOM_ORIGIN.manual);

  it("la de la API, por número y código: los dio la propia API", () => {
    expect(item(guia())).toEqual({ custom_id: "s-1", numero: "98130498", codigo: "D7MN" });
    expect(item(guia({ shalom_ose_id: 101602527 }))).toEqual({ custom_id: "s-1", numero: "98130498", codigo: "D7MN" });
  });

  it("#KP137651: la hecha a mano con OSE ID va por OSE ID, aunque el código esté mal", () => {
    const kp137651 = guia({ shalom_codigo: "V929", shalom_ose_id: 101602527, created_via: SHALOM_ORIGIN.manual });
    expect(item(kp137651)).toEqual({ custom_id: "s-1", ose_id: "101602527" });
  });

  it("la hecha a mano sin OSE ID, por número y código", () => {
    expect(item(guia({ created_via: SHALOM_ORIGIN.manual }))).toEqual({
      custom_id: "s-1",
      numero: "98130498",
      codigo: "D7MN",
    });
  });

  it("sin código, por OSE ID; sin ninguno de los dos, no se pregunta", () => {
    expect(item(guia({ shalom_codigo: null, shalom_ose_id: 101602527 }))).toEqual({ custom_id: "s-1", ose_id: "101602527" });
    // La salida de mentira de un estado atestiguado: gastaba cupo en cada pasada.
    expect(item(guia({ guide_code: "MOM-KP123525-SHALOM-C63A25DC", shalom_codigo: null, created_via: "status_attested" }))).toBeNull();
    expect(item(guia({ shalom_codigo: "  " }))).toBeNull();
  });

  it("el OSE ID va como texto: como número tumba el lote entero", () => {
    const it2 = item(guia({ shalom_codigo: null, shalom_ose_id: 101602527 }));
    expect(typeof it2?.ose_id).toBe("string");
    expect(item(guia({ shalom_codigo: null, shalom_ose_id: 0 }))).toBeNull();
  });
});
