import { describe, expect, it } from "vitest";
import {
  lockedIntentMessage,
  selectExpiredOrphans,
  type ExpiryCandidate,
  type SweepEvidence,
} from "@/lib/aliclik-orphan-expiry";

const NOW = new Date("2026-08-08T20:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;

const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MIN).toISOString();

/** Una intención huérfana creada hace `minutes` minutos. */
const candidate = (
  id: string,
  minutes: number,
  over: Partial<ExpiryCandidate> = {},
): ExpiryCandidate => ({
  id,
  orderId: "o1",
  createdAt: ago(minutes),
  ...over,
});

/** Constancia de un barrido completo recién terminado. */
const sweep = (over: Partial<SweepEvidence> = {}): SweepEvidence => ({
  startedAt: ago(5),
  completedAt: ago(2),
  windowFrom: new Date(NOW.getTime() - 14 * DAY).toISOString(),
  ...over,
});

const opts = (over: Partial<Parameters<typeof selectExpiredOrphans>[1]> = {}) => ({
  sweep: sweep(),
  expiryMs: 90 * MIN,
  sweepMaxAgeMs: 120 * MIN,
  now: NOW,
  ...over,
});

const NADA_RETENIDO = { tooYoung: 0, ambiguous: 0, noSweep: 0, notSearched: 0 };

describe("selectExpiredOrphans", () => {
  it("caduca la intención que el barrido lleva de sobra sin encontrar", () => {
    const sel = selectExpiredOrphans([candidate("i1", 181)], opts());
    const [first] = sel.expire;
    expect(sel.expire).toHaveLength(1);
    expect(first).toMatchObject({ id: "i1", orderId: "o1", verified: true });
    expect(first?.reason).toContain("nunca llegó a existir");
    expect(sel.held).toEqual(NADA_RETENIDO);
  });

  it("NO caduca antes del margen: el rescate normal todavía puede encontrarla", () => {
    const sel = selectExpiredOrphans([candidate("i1", 89)], opts());
    expect(sel.expire).toHaveLength(0);
    expect(sel.held.tooYoung).toBe(1);
  });

  // La condición que evita que una caída de Aliclik libere los candados que
  // protegen justo de esa caída. Antes era un booleano de la misma invocación;
  // ahora es la constancia que el barrido dejó escrita, y la ausencia de
  // constancia tiene que pesar igual que un barrido roto.
  it("NO caduca NADA si no consta ningún barrido completo", () => {
    const sel = selectExpiredOrphans(
      [candidate("i1", 500), candidate("i2", 900)],
      opts({ sweep: null }),
    );
    expect(sel.expire).toHaveLength(0);
    expect(sel.held.noSweep).toBe(2);
  });

  it("NO caduca NADA si el último barrido completo ya quedó rancio", () => {
    const sel = selectExpiredOrphans(
      [candidate("i1", 500)],
      opts({ sweep: sweep({ startedAt: ago(200), completedAt: ago(190) }) }),
    );
    expect(sel.expire).toHaveLength(0);
    expect(sel.held.noSweep).toBe(1);
  });

  // Un barrido que arrancó antes de que la intención existiera pudo pasar de
  // largo por la zona del listado donde estaría el pedido.
  it("NO caduca si el barrido empezó ANTES de que naciera la intención", () => {
    const sel = selectExpiredOrphans(
      [candidate("i1", 100)],
      opts({ sweep: sweep({ startedAt: ago(110), completedAt: ago(105) }) }),
    );
    expect(sel.expire).toHaveLength(0);
    expect(sel.held.notSearched).toBe(1);
  });

  it("NO caduca una intención cuya ausencia quedó en duda por teléfono ambiguo", () => {
    const sel = selectExpiredOrphans(
      [candidate("i1", 500, { ambiguousAt: ago(3) }), candidate("i2", 500)],
      opts(),
    );
    expect(sel.expire.map((e) => e.id)).toEqual(["i2"]);
    expect(sel.held.ambiguous).toBe(1);
  });

  // La duda vale para el barrido que la vio. Si el último barrido completo no la
  // volvió a marcar, la intención vuelve a ser caducable.
  it("una duda ANTERIOR al último barrido completo ya no retiene", () => {
    const sel = selectExpiredOrphans(
      [candidate("i1", 500, { ambiguousAt: ago(400) })],
      opts(),
    );
    expect(sel.expire.map((e) => e.id)).toEqual(["i1"]);
    expect(sel.held.ambiguous).toBe(0);
  });

  it("una marca de duda ilegible retiene, que es el lado seguro", () => {
    const sel = selectExpiredOrphans(
      [candidate("i1", 500, { ambiguousAt: "no-es-una-fecha" })],
      opts(),
    );
    expect(sel.expire).toHaveLength(0);
    expect(sel.held.ambiguous).toBe(1);
  });

  it("marca como NO verificada la que ya cayó fuera de la ventana del barrido", () => {
    const sel = selectExpiredOrphans(
      [candidate("i1", 20 * 24 * 60)],
      opts({ sweep: sweep({ startedAt: ago(5), completedAt: ago(2) }) }),
    );
    const [first] = sel.expire;
    expect(first?.verified).toBe(false);
    expect(first?.reason).toContain("no pudo comprobarse");
  });

  it("sin ventana legible caduca igual, pero sin poder llamarse comprobada", () => {
    const sel = selectExpiredOrphans([candidate("i1", 181)], opts({ sweep: sweep({ windowFrom: "" }) }));
    expect(sel.expire).toHaveLength(1);
    expect(sel.expire[0]?.verified).toBe(false);
  });

  it("una fecha ilegible retiene: no poder medir no es haber comprobado", () => {
    const sel = selectExpiredOrphans(
      [{ id: "i1", orderId: "o1", createdAt: "no-es-una-fecha" }],
      opts(),
    );
    expect(sel.expire).toHaveLength(0);
    expect(sel.held.tooYoung).toBe(1);
  });

  it("cuenta cada retención por separado en un lote mixto", () => {
    const sel = selectExpiredOrphans(
      [candidate("vieja", 500), candidate("nueva", 10), candidate("dudosa", 500, { ambiguousAt: ago(3) })],
      opts(),
    );
    expect(sel.expire.map((e) => e.id)).toEqual(["vieja"]);
    expect(sel.held).toEqual({ tooYoung: 1, ambiguous: 1, noSweep: 0, notSearched: 0 });
  });
});

describe("lockedIntentMessage", () => {
  const at = (minutes: number) => new Date(NOW.getTime() - minutes * MIN).toISOString();

  it("con la guía ya creada, dice su número en vez de hablar de 'creación en curso'", () => {
    const msg = lockedIntentMessage(
      { status: "sent", order_number: "ALC123", created_at: at(5) },
      { expiryMs: 90 * MIN, now: NOW },
    );
    expect(msg).toContain("ALC123");
    expect(msg).not.toContain("en curso");
  });

  it("con una intención en 'pending', dice cuánto queda para que se libere sola", () => {
    const msg = lockedIntentMessage(
      { status: "pending", order_number: null, created_at: at(30) },
      { expiryMs: 90 * MIN, now: NOW },
    );
    expect(msg).toContain("60 min");
    expect(msg).toContain("No reintentes");
  });

  // El caso del 08-08: tres horas trabado. El mensaje no puede prometer una
  // espera que ya venció.
  it("pasado el plazo, remite al próximo barrido y no a un tiempo negativo", () => {
    const msg = lockedIntentMessage(
      { status: "pending", order_number: null, created_at: at(181) },
      { expiryMs: 90 * MIN, now: NOW },
    );
    expect(msg).toContain("próximo barrido");
    expect(msg).not.toMatch(/-\d+ min/);
  });

  it("si la intención ya no está, el reintento es inocuo y se dice", () => {
    const msg = lockedIntentMessage(null, { expiryMs: 90 * MIN, now: NOW });
    expect(msg).toContain("Vuelve a intentarlo");
  });
});
