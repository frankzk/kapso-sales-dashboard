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
  chainReadyOn,
  isChainRider,
  limaRetryChain,
  urpiChainReason,
  withDismissal,
  CHAIN_EVENT_KINDS,
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

  it("#KP200665: Yordani no contestó y después Urpi la canceló con su misma caja → el de Urpi abre la cadena", () => {
    // La programación de Urpi tomó la caja de Grupo GF (0305): Kapta ve los dos
    // intentos, la parada de Yordani y la salida de Urpi anulada.
    const r = limaRetryChain([
      a("otro", "no_contesta", "2026-10-29T17:00:00.000Z"),
      a("urpi", urpiChainReason("cancelado", "Otras razones"), "2026-10-31T17:00:00.000Z"),
    ], NOW);
    expect(r).toMatchObject({ state: "siguiente", attempt: 2, of: 3, next: "autoecom", startedAt: "2026-10-31T17:00:00.000Z" });
    // Sin la salida de Urpi —antes de la 0305— solo quedaba Yordani: sin cadena.
    expect(limaRetryChain([a("otro", "no_contesta", "2026-10-29T17:00:00.000Z")], NOW)).toMatchObject({ state: "fuera", why: "sin_cadena" });
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

  it("propone el reintento y se aprueba desde el día siguiente, sin esperar la devolución", () => {
    expect(retryChainOf(base, null, "2026-11-03")).toEqual({ attempt: 2, of: 3, next: "autoecom", failedText: "Falló con Alexis (Grupo GF) el 02/11: otro motivo", inOffice: true, ready: true });
    // Con el paquete todavía con Alexis también se aprueba (owner, 03-11-2026).
    const withRider = retryChainOf({ ...base, box: { kind: "con_motorizado", riderName: "Alexis", since: null } }, null, "2026-11-03");
    expect(withRider).toMatchObject({ inOffice: false, ready: true });
    // El mismo día que falló, no: sale otro día.
    expect(retryChainOf(base, null, "2026-11-02")?.ready).toBe(false);
  });

  it("chainReadyOn compara el día de Lima, no el de UTC", () => {
    // 23:30 de Lima del 02-11 son las 04:30 UTC del 03-11.
    expect(chainReadyOn({ at: "2026-11-03T04:30:00Z" }, "2026-11-03")).toBe(true);
    expect(chainReadyOn({ at: "2026-11-03T15:00:00Z" }, "2026-11-03")).toBe(false);
    expect(chainReadyOn({ at: "no-es-fecha" }, "2026-11-03")).toBe(false);
  });

  it("anulado, fuera de la etapa o con acuerdo de la tienda: no hay reintento", () => {
    expect(retryChainOf({ ...base, cancelled: true }, null, "2026-11-03")).toBeNull();
    expect(retryChainOf({ ...base, inStage: false }, null, "2026-11-03")).toBeNull();
    expect(retryChainOf(base, { agreed_on: "2026-11-04" }, "2026-11-03")).toBeNull();
  });

  it("la tarjeta «Reintentos Aliclik» va primera y cuenta solo esos", () => {
    expect(LIMA_QUEUE_CARDS[0]?.key).toBe("reintentos_aliclik");
    const rows = [{ orderId: "o1" }, { orderId: "o2" }] as unknown as LimaPendingOrder[];
    const cases = [
      { orderId: "o1", list: "por_decidir" as const, retryChain: retryChainOf(base, null, "2026-11-03") },
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

describe("entrega 2: la bandeja «Aprobar» / «A Repro Lima»", () => {
  const chain = limaRetryChain([a("alexis", "no_contesta", "2026-11-01T17:00:00Z")], NOW);

  it("«A Repro Lima» después del fallo la saca; un fallo nuevo la vuelve a abrir", () => {
    expect(withDismissal(chain, "2026-11-02T15:00:00Z")).toMatchObject({ state: "fuera", why: "descartada" });
    expect(withDismissal(chain, null)).toBe(chain);
    // Descartada antes del último fallo: no cuenta.
    expect(withDismissal(chain, "2026-10-31T15:00:00Z")).toMatchObject({ state: "siguiente" });
  });

  const actions = readFileSync(resolve(process.cwd(), "app/dashboard/pedidos/repro-lima/retry-actions.ts"), "utf8");
  // Desde la entrega 3 (04-11-2026) la cotización y la creación viven en el
  // núcleo compartido con la pasada automática.
  const core = readFileSync(resolve(process.cwd(), "lib/lima-retry-approve.ts"), "utf8");

  it("aprobar pide los reintentos y crear guías, y recalcula la cadena antes de crear", () => {
    expect(actions).toContain('perms.can("repro_lima.retries")');
    expect(actions).toContain('perms.can("aliclik.create_guide")');
    const approve = actions.slice(actions.indexOf("export async function approveAliclikRetry"));
    // El orden: la cadena de ahora, otro día que el fallo, y recién el núcleo.
    const order = ["readChain(orderId)", "if (!chain.ready)", "approveLimaRetry({"].map((t) => approve.indexOf(t));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    // En el núcleo: la cotización antes de la guía.
    const body = core.slice(core.indexOf("export async function approveLimaRetry"));
    const coreOrder = ["previewAliclikGuideFor(ctx", "createAliclikGuideFor(ctx"].map((t) => body.indexOf(t));
    expect(coreOrder.every((i) => i > -1)).toBe(true);
    expect([...coreOrder].sort((x, y) => x - y)).toEqual(coreOrder);
    // Por el mismo camino que la ficha, con el motivo de la salida adicional de Lima.
    expect(body).toContain("`Reintento Aliclik ${chain.attempt} de ${chain.of} aprobado en Repro Lima. ${chain.failedText}.`");
    expect(body).toContain("motivoSalidaAdicional: motive");
    expect(body).toContain("CHAIN_EVENT_KINDS.approved");
  });

  it("sin ese transporte para la dirección pasa a Repro Lima; fuera de horario solo avisa", () => {
    const approve = core.slice(core.indexOf("export async function approveLimaRetry"));
    const missing = approve.slice(approve.indexOf("if (!courier) {"), approve.indexOf("if (!courier.selectable)"));
    expect(missing).toContain("CHAIN_EVENT_KINDS.dismissed");
    const closed = approve.slice(approve.indexOf("if (!courier.selectable)"), approve.indexOf("createAliclikGuideFor(ctx"));
    expect(closed).not.toContain("CHAIN_EVENT_KINDS.dismissed");
  });

  it("«A Repro Lima» pide motivo y deja el hecho que la cadena lee", () => {
    expect(actions).toContain('if (why.length < 3) return { error: "Escribe por qué pasa a Repro Lima." };');
    expect(CHAIN_EVENT_KINDS.dismissed).toBe("lima_retry_dismissed");
    const program = readFileSync(resolve(process.cwd(), "lib/repro-lima-program.ts"), "utf8");
    expect(program).toContain('"lima_retry_dismissed",');
    expect(program).toContain("withDismissal(");
  });

  it("«Aprobar todos» los que ya se pueden aprobar, con confirmación; no espera la devolución", () => {
    const board = readFileSync(resolve(process.cwd(), "components/repro-lima-board.tsx"), "utf8");
    expect(board).toContain("caseById.get(row.orderId)?.retryChain?.ready");
    expect(actions).not.toContain("chain.inOffice");
    // Con confirmación; desde el 06-11-2026 también para «Aprobar elegidos».
    expect(board).toContain('window.confirm(`Se crearán ${rows.length} ${rows.length === 1 ? "guía" : "guías"} de Aliclik${targets.picked ? " (las elegidas)" : ""}. ¿Seguir?`)');
  });
});
