// El núcleo de «Aprobar» del reintento Aliclik de Lima (MOM §9.5, entregas 2 y
// 3, 04-11-2026): el mismo camino para la persona de la bandeja y para la
// pasada automática. Lo que se prueba: que «Aprobar» sigue diciendo lo mismo
// que antes, que el sistema firma como sistema (actor null, origen
// `reintento_lima`, scope de la organización) y que la simulación no escribe.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  events: [] as Record<string, unknown>[],
  revalidated: [] as string[],
  preview: null as null | Record<string, unknown>,
  create: null as null | Record<string, unknown>,
  ctxError: null as string | null,
  calls: { preview: [] as unknown[][], create: [] as unknown[][], context: [] as unknown[][], scope: 0 },
  chain: null as null | Record<string, unknown>,
  raw: null as null | Record<string, unknown>,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => h.revalidated.push(p) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/shipments", () => ({ limaTodayKey: () => "2026-11-04" }));
vi.mock("@/lib/permissions-access", () => ({ getMasterPermissions: async () => ({ can: () => true }) }));

const fakeAdmin = {
  from: (table: string) => ({
    insert: async (value: Record<string, unknown>) => {
      if (table === "order_events") h.events.push(value);
      return { error: null };
    },
  }),
};
const ROW = { order_id: "o1", store_id: "s1", order_name: "#KP1" };

vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => fakeAdmin,
  createServerSupabase: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "ana" } } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: ROW }) }) }) }),
  }),
}));
vi.mock("@/lib/repro-lima-access", () => ({
  loadReproFacts: async () => new Map([["o1", { open: null, episode: { key: "e" }, retryChain: h.raw }]]),
  retryChainOf: () => h.chain,
}));
vi.mock("@/lib/aliclik-guide", () => ({
  aliclikReadScopeFor: async () => {
    h.calls.scope += 1;
    return { scope: { client: fakeAdmin, storeIds: ["s1"] } };
  },
  aliclikContextFor: async (...args: unknown[]) => {
    h.calls.context.push(args);
    return h.ctxError ? { error: h.ctxError } : { ctx: { userId: args[1], row: args[0] } };
  },
  previewAliclikGuideFor: async (...args: unknown[]) => {
    h.calls.preview.push(args);
    return h.preview;
  },
  createAliclikGuideFor: async (...args: unknown[]) => {
    h.calls.create.push(args);
    return h.create;
  },
}));

import { approveLimaRetry } from "@/lib/lima-retry-approve";
import { approveAliclikRetry } from "@/app/dashboard/pedidos/repro-lima/retry-actions";
import { autoRetryMotive } from "@/lib/lima-retry-auto";

const RAW = {
  state: "siguiente",
  attempt: 2,
  of: 3,
  next: "autoecom",
  failed: { carrier: "alexis", reason: "no_contesta", at: "2026-11-02T17:00:00Z" },
  startedAt: "2026-11-02T17:00:00Z",
} as const;
const CHAIN = { attempt: 2, of: 3, next: "autoecom" as const, failedText: "Falló con Alexis (Grupo GF) el 02/11: no contesta", inOffice: false, ready: true };
const AUTOECOM = { transportId: 7, transportName: "AUTOECOM", deliveryCost: 9, selectable: true };

beforeEach(() => {
  h.events = [];
  h.revalidated = [];
  h.calls = { preview: [], create: [], context: [], scope: 0 };
  h.ctxError = null;
  h.preview = { ok: true, collectTotal: 120, couriers: [AUTOECOM] };
  h.create = { orderNumber: "AL-1" };
  h.chain = { ...CHAIN };
  h.raw = { ...RAW };
});

const system = (extra: Record<string, unknown> = {}) => approveLimaRetry({
  admin: fakeAdmin as never, row: ROW as never, chain: CHAIN, raw: RAW as never,
  actor: { system: true, variant: "alexis_autoecom:no_contesta" }, today: "2026-11-04", ...extra,
});

describe("«Aprobar» dice lo mismo que antes de la entrega 3", () => {
  it("crea con el motivo de la bandeja, sin scope ni origen, y firma con la persona", async () => {
    expect(await approveAliclikRetry("o1")).toEqual({ notice: "Guía con AUTOECOM creada: AL-1.", done: true });
    expect(h.calls.context[0]?.[1]).toBe("ana");
    expect(h.calls.preview[0]).toHaveLength(2);
    expect(h.calls.create[0]).toHaveLength(2);
    expect((h.calls.create[0]![1] as { motivoSalidaAdicional: string }).motivoSalidaAdicional)
      .toBe(`Reintento Aliclik 2 de 3 aprobado en Repro Lima. ${CHAIN.failedText}.`);
    expect(h.calls.scope).toBe(0);
    expect(h.events).toEqual([expect.objectContaining({
      kind: "lima_retry_approved", actor: "ana", source: "manual",
      reason: "Reintento Aliclik 2 de 3 aprobado: guía con AUTOECOM (AL-1).",
      payload: { attempt: 2, of: 3, transport: "AUTOECOM", guide: "AL-1", failed: CHAIN.failedText },
    })]);
    expect(h.revalidated).toEqual(["/dashboard/pedidos/repro-lima", "/dashboard/pedidos"]);
  });

  it("fuera de la cadena, o el mismo día del fallo", async () => {
    h.chain = null;
    expect(await approveAliclikRetry("o1")).toEqual({
      error: "Este pedido ya no está en la cadena (se entregó, se acordó otra cosa en Repro Lima o venció). Recarga la lista.", done: true,
    });
    h.chain = { ...CHAIN, ready: false };
    expect(await approveAliclikRetry("o1")).toEqual({ error: "El intento falló hoy: el reintento sale otro día. Apruébalo desde mañana." });
  });

  it("sin el transporte pasa a Repro Lima con el hecho de siempre", async () => {
    h.preview = { ok: true, collectTotal: 120, couriers: [{ ...AUTOECOM, transportName: "ALIDRIVER" }] };
    expect(await approveAliclikRetry("o1")).toEqual({ error: "Aliclik no ofrece AUTOECOM para esta dirección. El pedido pasa a Repro Lima.", done: true });
    expect(h.events).toEqual([expect.objectContaining({
      kind: "lima_retry_dismissed", actor: "ana", source: "manual",
      reason: "Aliclik no ofrece AUTOECOM para esta dirección: pasa a Repro Lima.",
      payload: { attempt: 2, of: 3, transport: "AUTOECOM", why: "sin_transporte" },
    })]);
    expect(h.revalidated).toHaveLength(2);
  });

  it("no seleccionable, contexto, cotización y errores de creación", async () => {
    h.preview = { ok: true, couriers: [{ ...AUTOECOM, selectable: false, reason: "Cerrado hoy." }] };
    expect(await approveAliclikRetry("o1")).toEqual({ error: "Cerrado hoy." });
    h.preview = { ok: true, couriers: [{ ...AUTOECOM, selectable: false }] };
    expect(await approveAliclikRetry("o1")).toEqual({ error: "AUTOECOM no se puede agendar ahora. Vuelve a aprobar más tarde." });
    h.preview = { ok: false };
    expect(await approveAliclikRetry("o1")).toEqual({ error: "No se pudo cotizar el envío." });
    h.ctxError = "Agencia no va por Aliclik.";
    expect(await approveAliclikRetry("o1")).toEqual({ error: "Agencia no va por Aliclik." });
    h.ctxError = null;
    h.preview = { ok: true, collectTotal: 120, couriers: [AUTOECOM] };
    h.create = { error: "Monto distinto." };
    expect(await approveAliclikRetry("o1")).toEqual({ error: "Monto distinto. Si hace falta un motivo o una excepción, créala desde la ficha del pedido." });
    h.create = { error: "Otra creación en curso.", locked: true };
    expect(await approveAliclikRetry("o1")).toEqual({ error: "Otra creación en curso." });
    expect(h.events).toEqual([]);
    expect(h.revalidated).toEqual([]);
  });
});

describe("la pasada automática por el mismo núcleo", () => {
  it("lee con el scope de la organización, sin persona, con el origen reintento_lima", async () => {
    expect(await system()).toEqual({ outcome: "creada", transport: "AUTOECOM", guide: "AL-1" });
    expect(h.calls.scope).toBe(1);
    expect(h.calls.context[0]?.[1]).toBeNull();
    expect(h.calls.preview[0]?.[2]).toEqual({ client: fakeAdmin, storeIds: ["s1"] });
    const [, input, scope, origin] = h.calls.create[0]!;
    const motive = autoRetryMotive(RAW as never, CHAIN.failedText);
    expect((input as { motivoSalidaAdicional: string }).motivoSalidaAdicional).toBe(motive);
    expect(motive).toContain("automático (regla encendida en Automatizaciones)");
    expect(scope).toEqual({ client: fakeAdmin, storeIds: ["s1"] });
    expect(origin).toEqual({ kind: "reintento_lima", scheduledOn: "2026-11-04", reason: motive });
    expect(h.events).toEqual([expect.objectContaining({
      kind: "lima_retry_approved", actor: null, source: "system",
      reason: "Reintento Aliclik 2 de 3 automático: guía con AUTOECOM (AL-1).",
      payload: expect.objectContaining({ auto: true, variant: "alexis_autoecom:no_contesta", guide: "AL-1" }),
    })]);
  });

  it("un scope ya resuelto no se vuelve a leer", async () => {
    await system({ scope: { client: fakeAdmin, storeIds: ["s1", "s2"] } });
    expect(h.calls.scope).toBe(0);
  });

  it("candado → en curso, timeout → incierto, rechazo → fallo", async () => {
    h.create = { error: "x", locked: true };
    expect(await system()).toMatchObject({ outcome: "en_curso", locked: true });
    h.create = { error: "x", timedOut: true };
    expect(await system()).toMatchObject({ outcome: "incierto", error: "x" });
    h.create = { error: "x" };
    expect(await system()).toMatchObject({ outcome: "fallo", stage: "creacion" });
    expect(h.events).toEqual([]);
  });

  it("sin transporte deja el hecho como sistema", async () => {
    h.preview = { ok: true, couriers: [] };
    expect(await system()).toEqual({ outcome: "sin_transporte", transport: "AUTOECOM" });
    expect(h.events).toEqual([expect.objectContaining({ kind: "lima_retry_dismissed", actor: null, source: "system" })]);
  });

  it("la simulación cotiza y elige, pero no crea ni escribe", async () => {
    expect(await system({ dry: true })).toEqual({ outcome: "simulada", transport: "AUTOECOM", detail: "AUTOECOM S/ 9 · cobrar S/ 120.00" });
    h.preview = { ok: true, couriers: [] };
    expect(await system({ dry: true })).toEqual({ outcome: "sin_transporte", transport: "AUTOECOM" });
    h.preview = { ok: true, couriers: [{ ...AUTOECOM, selectable: false }] };
    expect(await system({ dry: true })).toMatchObject({ outcome: "no_seleccionable" });
    expect(h.calls.create).toEqual([]);
    expect(h.events).toEqual([]);
  });
});
