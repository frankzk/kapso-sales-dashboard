import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAIM_TTL_MINUTES, MAX_OPEN_LEADS, cartLinesOf, dayTimeLabel, isClaimCapError, leadAfter, pickNextLead, usableAddress } from "@/lib/leads";

/**
 * El siguiente lead de cada vendedora (14-10-2026, MOM §11).
 *
 * La tarjeta de arriba de la cola le reserva a cada vendedora un lead para
 * llamar ahora. Lo que tiene que cumplirse: nunca el mismo a dos, la reserva es
 * la de siempre (10 minutos) y cuenta como una de las dos que puede tener.
 */

const NOW = new Date("2026-10-14T15:00:00.000Z");
const hace = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const YO = "yo";

const lead = (id: string, extra: Partial<{ status: string; claimed_by: string | null; claimed_at: string | null }> = {}) => ({
  id,
  status: "nuevo",
  claimed_by: null,
  claimed_at: null,
  ...extra,
});

describe("pickNextLead", () => {
  it("toma el primero de la cola en el orden en que se mira", () => {
    expect(pickNextLead([lead("a"), lead("b")], { userId: YO, now: NOW })?.id).toBe("a");
  });

  it("salta el que otra vendedora tiene reservado", () => {
    const cola = [lead("a", { claimed_by: "rosa", claimed_at: hace(2) }), lead("b")];
    expect(pickNextLead(cola, { userId: YO, now: NOW })?.id).toBe("b");
  });

  it("una reserva ajena vencida ya no estorba", () => {
    const cola = [lead("a", { claimed_by: "rosa", claimed_at: hace(CLAIM_TTL_MINUTES + 1) }), lead("b")];
    expect(pickNextLead(cola, { userId: YO, now: NOW })?.id).toBe("a");
  });

  it("uno reservado por mí sí sirve", () => {
    const cola = [lead("a", { claimed_by: YO, claimed_at: hace(2) }), lead("b")];
    expect(pickNextLead(cola, { userId: YO, now: NOW })?.id).toBe("a");
  });

  it("los que saltó no vuelven", () => {
    expect(pickNextLead([lead("a"), lead("b")], { userId: YO, skipped: new Set(["a"]), now: NOW })?.id).toBe("b");
  });

  it("solo los que siguen sin llamar", () => {
    expect(pickNextLead([lead("a", { status: "no_responde" }), lead("b")], { userId: YO, now: NOW })?.id).toBe("b");
  });

  it("el que ya tiene se queda aunque suba otro con más puntaje", () => {
    const cola = [lead("nuevo-arriba"), lead("a", { claimed_by: YO, claimed_at: hace(1) })];
    expect(pickNextLead(cola, { userId: YO, current: "a", now: NOW })?.id).toBe("a");
  });

  it("pero si el que tenía ya se gestionó, pasa al primero", () => {
    const cola = [lead("b"), lead("a", { status: "no_responde" })];
    expect(pickNextLead(cola, { userId: YO, current: "a", now: NOW })?.id).toBe("b");
  });

  it("y si otra se lo llevó al vencer la reserva, también", () => {
    const cola = [lead("b"), lead("a", { claimed_by: "rosa", claimed_at: hace(1) })];
    expect(pickNextLead(cola, { userId: YO, current: "a", now: NOW })?.id).toBe("b");
  });

  it("cola vacía o toda tomada: no hay siguiente", () => {
    expect(pickNextLead([], { userId: YO, now: NOW })).toBeNull();
    expect(pickNextLead([lead("a", { claimed_by: "rosa", claimed_at: hace(1) })], { userId: YO, now: NOW })).toBeNull();
  });
});

describe("el aviso del tope se distingue del de «X está atendiendo»", () => {
  it("reconoce el texto del tope que arma claimLead", () => {
    expect(isClaimCapError(`Ya tienes ${MAX_OPEN_LEADS} leads abiertos (Ana y Luis). Cierra uno para tomar este.`)).toBe(true);
    expect(isClaimCapError("Rosa está atendiendo este lead.")).toBe(false);
    expect(isClaimCapError(null)).toBe(false);
  });

  it("y el texto sigue siendo el que arma la acción", () => {
    const server = readFileSync(resolve(process.cwd(), "app/dashboard/leads/actions.ts"), "utf8");
    expect(server).toContain("error: `Ya tienes ${abiertos.length} leads abiertos (${nombres}). Cierra uno para tomar este.`");
  });
});

describe("la tarjeta usa la reserva de siempre", () => {
  const next = readFileSync(resolve(process.cwd(), "components/leads-next.tsx"), "utf8");
  const board = readFileSync(resolve(process.cwd(), "components/leads.tsx"), "utf8");
  const page = readFileSync(resolve(process.cwd(), "app/dashboard/leads/page.tsx"), "utf8");

  it("reserva con claimLead (el tope de 2 y el TTL de 10 min) y suelta con releaseLead", () => {
    expect(next).toContain("claimLead(");
    expect(next).toContain("releaseLead(");
    expect(next).toContain("pickNextLead(");
  });

  it("se renueva mientras la pestaña se ve y se suelta al cerrarla", () => {
    expect(next).toContain("RENEW_MS");
    expect(next).toContain('"/api/leads/release-claim"');
    expect(next).toContain('window.addEventListener("pagehide", onPageHide);');
  });

  it("abrir otro lead de la cola suelta el siguiente ANTES de reservar el otro", () => {
    const open = board.slice(board.indexOf("function openLead("));
    const body = open.slice(0, open.indexOf("\n  }\n"));
    expect(body).toContain("await nextLead.release()");
    expect(body.indexOf("await nextLead.release()")).toBeLessThan(body.indexOf("abrirLeadPorId("));
  });

  it("solo para quien vende", () => {
    expect(page).toContain('roles.includes("vendedora")');
  });
});

describe("lo que la tarjeta del siguiente lead pone primero", () => {
  it("lee los artículos del borrador con su cantidad y sin la variante", () => {
    expect(
      cartLinesOf([
        { title: "Cayenne Pepper – Suplemento Botánico para Circulación Saludable", quantity: 3, product_id: 1 },
        { title: "Reloj minimal (Negro / 40 mm)", quantity: "1" },
        { title: "   ", quantity: 2 },
        { quantity: 1 },
        null,
      ]),
    ).toEqual([
      { title: "Cayenne Pepper – Suplemento Botánico para Circulación Saludable", quantity: 3 },
      { title: "Reloj minimal", quantity: 1 },
    ]);
  });

  it("una cantidad rota cuenta como una unidad, y sin borrador no hay artículos", () => {
    expect(cartLinesOf([{ title: "Pulsera", quantity: 0 }, { title: "Collar", quantity: "dos" }])).toEqual([
      { title: "Pulsera", quantity: 1 },
      { title: "Collar", quantity: 1 },
    ]);
    expect(cartLinesOf(null)).toEqual([]);
    expect(cartLinesOf({ title: "x" })).toEqual([]);
  });

  it("el guion que deja el formulario no es una dirección: falta pedirla", () => {
    for (const vacio of ["-", " - ", ".", "--", "s/n", "S/N", "sin dirección", "", null, undefined]) {
      expect(usableAddress(vacio)).toBeNull();
    }
    expect(usableAddress("Av. José Pardo 610, dpto. 302")).toBe("Av. José Pardo 610, dpto. 302");
    expect(usableAddress("Jr. Lima s/n")).toBe("Jr. Lima s/n");
  });

  it("dice cuándo como en la mesa: hoy, ayer o la fecha, en la hora de Lima", () => {
    // NOW = 14-10-2026 10:00 en Lima.
    expect(dayTimeLabel("2026-10-14T13:06:00.000Z", NOW)).toBe("hoy 08:06");
    expect(dayTimeLabel("2026-10-13T23:05:00.000Z", NOW)).toBe("ayer 18:05");
    // 04:30 UTC del 14 son las 23:30 del 13 en Lima: ayer, no hoy.
    expect(dayTimeLabel("2026-10-14T04:30:00.000Z", NOW)).toBe("ayer 23:30");
    expect(dayTimeLabel("2026-10-12T21:40:00.000Z", NOW)).toBe("12 oct 16:40");
    expect(dayTimeLabel(null, NOW)).toBeNull();
    expect(dayTimeLabel("no es fecha", NOW)).toBeNull();
  });
});

/**
 * «Siguiente lead» de la ficha (25-10-2026): el de debajo en la lista que se
 * está mirando, sin cerrar la ficha.
 */
describe("leadAfter", () => {
  const cola = [lead("a"), lead("b"), lead("c"), lead("d")];
  const ids = (l: { id: string } | null) => l?.id ?? null;

  it("es el de debajo del abierto", () => {
    expect(ids(leadAfter(cola, { openId: "b", userId: YO, now: NOW }))).toBe("c");
  });

  it("salta los que otra tiene reservados, no los míos ni los vencidos", () => {
    const tomada = [lead("a"), lead("b", { claimed_by: "rosa", claimed_at: hace(2) }), lead("c")];
    expect(ids(leadAfter(tomada, { openId: "a", userId: YO, now: NOW }))).toBe("c");
    const mia = [lead("a"), lead("b", { claimed_by: YO, claimed_at: hace(2) })];
    expect(ids(leadAfter(mia, { openId: "a", userId: YO, now: NOW }))).toBe("b");
    const vencida = [lead("a"), lead("b", { claimed_by: "rosa", claimed_at: hace(CLAIM_TTL_MINUTES + 1) })];
    expect(ids(leadAfter(vencida, { openId: "a", userId: YO, now: NOW }))).toBe("b");
  });

  it("al final de la lista no hay siguiente", () => {
    expect(leadAfter(cola, { openId: "d", userId: YO, now: NOW })).toBeNull();
  });

  it("si guardar la gestión lo sacó de la lista, sigue el que venía detrás", () => {
    const sinB = [lead("a"), lead("c"), lead("d")];
    expect(ids(leadAfter(sinB, { openId: "b", userId: YO, rememberedNextId: "c", now: NOW }))).toBe("c");
  });

  it("si el que venía detrás ahora lo tiene otra, el libre después de él", () => {
    const sinB = [lead("a"), lead("c", { claimed_by: "rosa", claimed_at: hace(1) }), lead("d")];
    expect(ids(leadAfter(sinB, { openId: "b", userId: YO, rememberedNextId: "c", now: NOW }))).toBe("d");
  });

  it("si tampoco está el que venía detrás, o no se sabe, el primero libre", () => {
    const quedan = [lead("a", { claimed_by: "rosa", claimed_at: hace(1) }), lead("d")];
    expect(ids(leadAfter(quedan, { openId: "b", userId: YO, rememberedNextId: "c", now: NOW }))).toBe("d");
    expect(ids(leadAfter(quedan, { openId: "x", userId: YO, now: NOW }))).toBe("d");
  });
});

describe("«Siguiente lead» salta al siguiente libre si se lo ganaron (owner, 26-10-2026)", () => {
  const board = readFileSync(resolve(process.cwd(), "components/leads.tsx"), "utf8");
  const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");

  it("si el servidor dice que otra lo tiene, prueba con el siguiente libre de la misma lista", () => {
    expect(board).toContain("const NEXT_LEAD_MAX_SKIPS = 5;");
    expect(board).toMatch(/onTaken: \(message\) => \{\s*taken = true;/);
    expect(board).toContain("candidate = leadAfter(queue, { openId: candidate.id, userId: currentUserId });");
  });

  it("el tope de dos abiertos no se salta: sigue saliendo su aviso", () => {
    expect(board).toContain("if (opts?.onTaken && !isClaimCapError(d.error) && opts.onTaken(d.error))");
  });

  it("el MOM lo dice", () => {
    expect(mom).toContain("**salta al siguiente libre** de la misma lista");
  });

  it("después de un tomado, el siguiente libre de la lista es el que sigue", () => {
    const ids = (l: { id: string } | null) => l?.id ?? null;
    const cola = [lead("a"), lead("b"), lead("c", { claimed_by: "rosa", claimed_at: hace(1) }), lead("d")];
    // «b» resultó tomado al abrirlo: se busca desde «b», saltando «c» (reservado).
    expect(ids(leadAfter(cola, { openId: "b", userId: YO, now: NOW }))).toBe("d");
  });
});
