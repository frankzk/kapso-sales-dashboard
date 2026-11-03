import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => null, getAccessibleStores: async () => [] }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => true }) }));
vi.mock("@/lib/agent-names", () => ({ resolveAgentNames: async () => ({}) }));
import {
  CHAIN_MAX_DAYS,
  aliclikCarrier,
  aliclikChainReason,
  chainChipText,
  chainFailureText,
  isChainRider,
  limaRetryChain,
  urpiChainReason,
  type ChainAttempt,
} from "@/lib/lima-retry-chain";
import { retryChainOf } from "@/lib/repro-lima-access";
import { attentionCounts, attentionRows, LIMA_QUEUE_CARDS, type LimaPendingOrder } from "@/lib/repro-lima-pending";
import { permissionsFor } from "@/lib/permissions";

/**
 * La cadena de reintentos por Aliclik en Lima (MOM §9.5, 03-11-2026, decisión
 * del owner): Alexis o Urpi → AUTOECOM → ALIDRIVER, y AUTOECOM → ALIDRIVER.
 */

const NOW = new Date("2026-11-03T15:00:00Z");
const a = (carrier: ChainAttempt["carrier"], reason: string | null, at: string): ChainAttempt => ({ carrier, reason, at });

describe("quién abre la cadena y con qué motivo", () => {
  it("de Grupo GF, solo Alexis", () => {
    expect(isChainRider("Alexis")).toBe(true);
    expect(isChainRider("alexis ")).toBe(true);
    expect(isChainRider("Álexis")).toBe(true);
    expect(isChainRider("Roy")).toBe(false);
    expect(isChainRider("Alexandra")).toBe(false);
    expect(isChainRider(null)).toBe(false);
  });

  it("Aliclik: rechazo en puerta, reprogramado, no contestó; lo demás es «otro»", () => {
    expect(aliclikChainReason("REFUSED · LEFT_IN_WAREHOUSE · CONFIRMED")).toBe("rechazado");
    expect(aliclikChainReason("RESCHEDULED · PICKED · CONFIRMED")).toBe("reprogramado");
    expect(aliclikChainReason("NOT_RESPOND · LEFT_IN_WAREHOUSE · CONFIRMED")).toBe("no_contesta");
    expect(aliclikChainReason("CANCEL · LEFT_IN_WAREHOUSE · CONFIRMED")).toBe("otro");
    expect(aliclikCarrier("AutoEcom Logistic")).toBe("autoecom");
    expect(aliclikCarrier("ALIDRIVER")).toBe("alidriver");
    expect(aliclikCarrier(null)).toBe("otro");
  });

  it("Urpi: el resultado y su motivo en texto libre", () => {
    expect(urpiChainReason("reprogramado", null)).toBe("reprogramado");
    expect(urpiChainReason("cancelado", "Cliente rechazó el pedido")).toBe("rechazado");
    expect(urpiChainReason("cancelado", "No contesta el teléfono")).toBe("no_contesta");
    expect(urpiChainReason("cancelado", "Dirección no existe")).toBe("direccion_errada");
    expect(urpiChainReason("cancelado", "")).toBe("otro");
  });
});

describe("limaRetryChain", () => {
  it("Alexis no contestó → intento 2 de 3 con AUTOECOM", () => {
    const r = limaRetryChain([a("alexis", "no_contesta", "2026-11-01T17:00:00Z")], NOW);
    expect(r).toMatchObject({ state: "siguiente", attempt: 2, of: 3, next: "autoecom" });
  });

  it("Urpi «otro» → AUTOECOM; luego AUTOECOM falla → 3 de 3 con ALIDRIVER", () => {
    expect(limaRetryChain([a("urpi", "otro", "2026-11-01T17:00:00Z")], NOW)).toMatchObject({ attempt: 2, of: 3, next: "autoecom" });
    const r = limaRetryChain([
      a("urpi", "otro", "2026-10-31T17:00:00Z"),
      a("autoecom", "no_contesta", "2026-11-02T14:00:00Z"),
    ], NOW);
    expect(r).toMatchObject({ state: "siguiente", attempt: 3, of: 3, next: "alidriver", startedAt: "2026-10-31T17:00:00Z" });
  });

  it("AUTOECOM como primer intento → 2 de 2 con ALIDRIVER (#KP143987)", () => {
    expect(limaRetryChain([a("autoecom", "otro", "2026-10-29T13:58:09Z")], NOW)).toMatchObject({ attempt: 2, of: 2, next: "alidriver" });
    // Después de otro motorizado (no Alexis), AUTOECOM también abre su cadena de 2.
    expect(limaRetryChain([a("otro", "no_contesta", "2026-10-30T17:00:00Z"), a("autoecom", "no_contesta", "2026-11-01T14:00:00Z")], NOW))
      .toMatchObject({ attempt: 2, of: 2, next: "alidriver" });
  });

  it("ALIDRIVER que falla agota la cadena: a Repro Lima", () => {
    const r = limaRetryChain([
      a("alexis", "no_contesta", "2026-10-30T17:00:00Z"),
      a("autoecom", "no_contesta", "2026-11-01T14:00:00Z"),
      a("alidriver", "otro", "2026-11-02T14:00:00Z"),
    ], NOW);
    expect(r).toMatchObject({ state: "fuera", why: "agotada" });
  });

  it("rechazo, reprogramado, dirección errada o sin dinero: fuera, siguen su flujo", () => {
    for (const reason of ["rechazado", "reprogramado", "direccion_errada", "sin_dinero"]) {
      expect(limaRetryChain([a("alexis", reason, "2026-11-01T17:00:00Z")], NOW), reason).toMatchObject({ state: "fuera", why: "motivo" });
    }
    // Un rechazo de AUTOECOM corta la cadena aunque Alexis no contestara antes.
    expect(limaRetryChain([a("alexis", "no_contesta", "2026-10-31T17:00:00Z"), a("autoecom", "rechazado", "2026-11-02T14:00:00Z")], NOW))
      .toMatchObject({ state: "fuera", why: "motivo" });
  });

  it("otros motorizados, Swayp o Axel no abren cadena", () => {
    expect(limaRetryChain([a("otro", "no_contesta", "2026-11-01T17:00:00Z")], NOW)).toMatchObject({ state: "fuera", why: "sin_cadena" });
    expect(limaRetryChain([], NOW)).toMatchObject({ state: "fuera", why: "sin_cadena" });
  });

  it(`pasados ${CHAIN_MAX_DAYS} días desde el primer intento, vence`, () => {
    expect(limaRetryChain([a("alexis", "no_contesta", "2026-10-26T17:00:00Z")], NOW)).toMatchObject({ state: "fuera", why: "vencida" });
    expect(limaRetryChain([a("alexis", "no_contesta", "2026-10-29T17:00:00Z")], NOW)).toMatchObject({ state: "siguiente" });
  });

  it("los textos de la chapa y del fallo", () => {
    const r = limaRetryChain([a("alexis", "no_contesta", "2026-10-29T17:00:00Z")], NOW);
    if (r.state !== "siguiente") throw new Error("esperaba siguiente");
    expect(chainChipText(r)).toBe("Reintento Aliclik 2 de 3 · AUTOECOM");
    expect(chainFailureText(r.failed)).toBe("Falló con Alexis (Grupo GF) el 29/10: no contestó");
  });
});

describe("la fila de Repro Lima", () => {
  const chain = limaRetryChain([a("alexis", "otro", "2026-11-02T17:00:00Z")], NOW);
  const base = { retryChain: chain, cancelled: false, inStage: true, box: { kind: "en_oficina" as const, since: "2026-11-02T22:00:00Z" } };

  it("propone el reintento con el paquete en oficina", () => {
    expect(retryChainOf(base, null)).toEqual({ attempt: 2, of: 3, next: "autoecom", failedText: "Falló con Alexis (Grupo GF) el 02/11: otro motivo", inOffice: true });
    expect(retryChainOf({ ...base, box: { kind: "con_motorizado", riderName: "Alexis", since: null } }, null)?.inOffice).toBe(false);
  });

  it("anulado, fuera de la etapa o con acuerdo de la tienda: no hay reintento", () => {
    expect(retryChainOf({ ...base, cancelled: true }, null)).toBeNull();
    expect(retryChainOf({ ...base, inStage: false }, null)).toBeNull();
    expect(retryChainOf(base, { agreed_on: "2026-11-04" })).toBeNull();
  });

  it("la tarjeta «Reintentos Aliclik» va primera y cuenta solo esos", () => {
    expect(LIMA_QUEUE_CARDS[0]?.key).toBe("reintentos_aliclik");
    const rows = [{ orderId: "o1" }, { orderId: "o2" }] as unknown as LimaPendingOrder[];
    const cases = [
      { orderId: "o1", list: "por_decidir" as const, retryChain: retryChainOf(base, null) },
      { orderId: "o2", list: "por_decidir" as const, retryChain: null },
    ];
    expect(attentionCounts(rows, cases, "2026-11-03").reintentos_aliclik).toBe(1);
    expect(attentionRows(rows, cases, "reintentos_aliclik", "2026-11-03").map((r) => r.orderId)).toEqual(["o1"]);
  });
});

describe("quién lo ve", () => {
  it("asesoras y Despacho; Despacho sigue sin llamar (sin repro_lima.manage)", () => {
    expect(permissionsFor(["vendedora"], [], ["asesora"]).has("repro_lima.retries")).toBe(true);
    const despacho = permissionsFor(["vendedora"], [], ["despacho"]);
    expect(despacho.has("repro_lima.retries")).toBe(true);
    expect(despacho.has("repro_lima.manage")).toBe(false);
  });

  it("la pantalla abre con «retries» solo; las acciones siguen pidiendo manage", () => {
    const page = readFileSync(resolve(process.cwd(), "app/dashboard/pedidos/repro-lima/page.tsx"), "utf8");
    expect(page).toContain("requireReproLima({ retries: true })");
    const actions = readFileSync(resolve(process.cwd(), "app/dashboard/pedidos/repro-lima/actions.ts"), "utf8");
    expect(actions).not.toContain("retries: true");
    const board = readFileSync(resolve(process.cwd(), "components/repro-lima-board.tsx"), "utf8");
    expect(board).toContain('if (retriesOnly) return null;');
  });
});
