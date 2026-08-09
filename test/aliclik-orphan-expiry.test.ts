import { describe, expect, it } from "vitest";
import {
  lockedIntentMessage,
  selectExpiredOrphans,
  type ExpiryCandidate,
} from "@/lib/aliclik-orphan-expiry";

const NOW = new Date("2026-08-08T20:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;

/** Una intención huérfana creada hace `minutes` minutos. */
const candidate = (id: string, minutes: number, orderId: string | null = "o1"): ExpiryCandidate => ({
  id,
  orderId,
  createdAt: new Date(NOW.getTime() - minutes * MIN).toISOString(),
});

const opts = (over: Partial<Parameters<typeof selectExpiredOrphans>[1]> = {}) => ({
  ambiguous: new Set<string>(),
  sweepComplete: true,
  expiryMs: 90 * MIN,
  lookbackMs: 14 * DAY,
  now: NOW,
  ...over,
});

describe("selectExpiredOrphans", () => {
  it("caduca la intención que el barrido lleva de sobra sin encontrar", () => {
    const sel = selectExpiredOrphans([candidate("i1", 181)], opts());
    const [first] = sel.expire;
    expect(sel.expire).toHaveLength(1);
    expect(first).toMatchObject({ id: "i1", orderId: "o1", verified: true });
    expect(first?.reason).toContain("nunca llegó a existir");
    expect(sel.held).toEqual({ tooYoung: 0, ambiguous: 0, sweepIncomplete: 0 });
  });

  it("NO caduca antes del margen: el rescate normal todavía puede encontrarla", () => {
    const sel = selectExpiredOrphans([candidate("i1", 89)], opts());
    expect(sel.expire).toHaveLength(0);
    expect(sel.held.tooYoung).toBe(1);
  });

  // La condición que evita que una caída de Aliclik libere los candados que
  // protegen justo de esa caída.
  it("NO caduca NADA si el barrido no pudo recorrerse entero", () => {
    const sel = selectExpiredOrphans(
      [candidate("i1", 500), candidate("i2", 900)],
      opts({ sweepComplete: false }),
    );
    expect(sel.expire).toHaveLength(0);
    expect(sel.held.sweepIncomplete).toBe(2);
  });

  it("NO caduca una intención cuya ausencia quedó en duda por teléfono ambiguo", () => {
    const sel = selectExpiredOrphans(
      [candidate("i1", 500), candidate("i2", 500)],
      opts({ ambiguous: new Set(["i1"]) }),
    );
    expect(sel.expire.map((e) => e.id)).toEqual(["i2"]);
    expect(sel.held.ambiguous).toBe(1);
  });

  it("marca como NO verificada la que ya cayó fuera de la ventana del barrido", () => {
    const sel = selectExpiredOrphans([candidate("i1", 20 * 24 * 60)], opts());
    const [first] = sel.expire;
    expect(first?.verified).toBe(false);
    expect(first?.reason).toContain("no pudo comprobarse");
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
      [candidate("vieja", 500), candidate("nueva", 10), candidate("dudosa", 500)],
      opts({ ambiguous: new Set(["dudosa"]) }),
    );
    expect(sel.expire.map((e) => e.id)).toEqual(["vieja"]);
    expect(sel.held).toEqual({ tooYoung: 1, ambiguous: 1, sweepIncomplete: 0 });
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
