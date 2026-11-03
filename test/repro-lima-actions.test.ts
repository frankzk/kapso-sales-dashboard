// «Repro Lima» (fase 1, entrega 1a; MOM §9.5): las acciones de servidor con la
// base simulada. Lo que la hoja necesita saber de un guardado rechazado (la
// caja cambió, se perdió el caso: C3), el caso reabierto (E29) en «Qué hacer
// con la caja», el programa de otro día que queda cuando falla programar
// (E23), y «Programar ahora», que toma el candado de SU caso y nunca abre otro.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Query = {
  table: string;
  op: "select" | "update";
  columns?: string;
  values?: Record<string, unknown>;
  filters: Array<[string, string, unknown]>;
  or?: string;
};

const state = vi.hoisted(() => ({
  queries: [] as Query[],
  rpcs: [] as Array<{ name: string; params: Record<string, unknown> }>,
  /** Responde cada consulta; por defecto, sin datos. */
  respond: (_q: Query): { data: unknown; error: { message: string } | null } => ({ data: null, error: null }),
  rpc: (_name: string, _params: Record<string, unknown>): { data: unknown; error: { message: string } | null } => ({ data: null, error: null }),
  /** Los hechos del pedido: antes y después de la RPC. */
  facts: [] as unknown[],
  factsCalls: 0,
  materialize: vi.fn(),
  cleared: vi.fn(),
  closeStale: vi.fn(),
  /** Lo que recibió `reproBoxAction` (la acción real, solo se mira). */
  boxInputs: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/agent-names", () => ({
  resolveAgentName: async (id: string) => (id === "ana" ? "Ana" : null),
  resolveAgentNames: async () => ({}),
}));
vi.mock("@/lib/repro-lima-access", () => ({
  requireReproLima: async () => ({ userId: "me", storeIds: new Set(["store"]) }),
  loadReproLima: async () => ({ rows: [] }),
  REPRO_OUTSIDE_STORE: "Ese pedido es de una tienda que no tienes asignada.",
}));
vi.mock("@/lib/grupo-gf-courier-route-access", () => ({
  loadGroupGfCourierRouteCheck: async () => ({ eligible: true, sameDayCutoff: "12:00" }),
}));
vi.mock("@/lib/gf-dispatch-program", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gf-dispatch-program")>()),
  clearGfDispatchPrograms: async (...args: unknown[]) => {
    state.cleared(...args);
    return { cleared: args[1] as unknown[], error: null };
  },
}));
vi.mock("@/lib/repro-lima-program", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/repro-lima-program")>();
  return {
    ...real,
    loadReproFacts: async (_admin: unknown, ids: string[]) => {
      const f = state.facts[Math.min(state.factsCalls, state.facts.length - 1)];
      state.factsCalls += 1;
      return new Map([[ids[0]!, f]]);
    },
    materializeAgreement: (...args: unknown[]) => state.materialize(...args),
    closeStaleReproCases: (...args: unknown[]) => state.closeStale(...args),
  };
});
vi.mock("@/lib/repro-box-action", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/repro-box-action")>();
  return {
    ...real,
    reproBoxAction: (input: Parameters<typeof real.reproBoxAction>[0]) => {
      state.boxInputs.push({ ...input });
      return real.reproBoxAction(input);
    },
  };
});
vi.mock("@/lib/db", () => {
  const from = (table: string) => {
    const q: Query = { table, op: "select", filters: [] };
    const chain: any = {};
    chain.select = (columns?: string) => { if (q.op === "select") q.columns = columns; return chain; };
    chain.update = (values: Record<string, unknown>) => { q.op = "update"; q.values = values; return chain; };
    for (const method of ["eq", "is", "gt", "in", "lte"]) {
      chain[method] = (key: string, value: unknown) => { q.filters.push([method, key, value]); return chain; };
    }
    chain.or = (expr: string) => { q.or = expr; return chain; };
    chain.order = () => chain;
    chain.limit = () => chain;
    const result = () => { state.queries.push(q); return state.respond(q); };
    chain.maybeSingle = async () => result();
    chain.then = (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject);
    return chain;
  };
  return {
    createAdminSupabase: () => ({
      from,
      rpc: async (name: string, params: Record<string, unknown>) => {
        state.rpcs.push({ name, params });
        return state.rpc(name, params);
      },
    }),
  };
});

import { claimReproCase, programReproAgreement, registerReproCall } from "@/app/dashboard/pedidos/repro-lima/actions";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const OP_ID = "33333333-3333-4333-8333-333333333333";

/** Hoy en Lima: martes 13/10, 08:00. */
const NOW = new Date("2026-10-13T13:00:00Z");

function caseRow(over: Record<string, unknown> = {}) {
  return {
    id: CASE_ID,
    store_id: "store",
    order_id: ORDER_ID,
    episode_key: "s:stop-1",
    episode_at: "2026-10-12T20:00:00Z",
    opened_at: "2026-10-13T12:00:00Z",
    opened_by: "me",
    claimed_by: "me",
    claimed_until: "2026-10-13T13:08:00Z",
    call_count: 0,
    no_answer_count: 0,
    last_call_at: null,
    last_outcome: null,
    next_call_at: null,
    agreement_call_id: null,
    agreed_on: null,
    agreed_courier: null,
    changes: {},
    box_action: null,
    box_location: null,
    decided_by: null,
    decided_at: null,
    materialized_at: null,
    materialized_on: null,
    closed_at: null,
    closed_by: null,
    close_reason: null,
    close_note: null,
    ...over,
  };
}

function facts(over: Record<string, unknown> = {}) {
  return {
    orderId: ORDER_ID,
    storeId: "store",
    order: { order_id: ORDER_ID, store_id: "store", order_name: "#KP1", region: "Lima", province: "Lima", district: "Surco" },
    inStage: true,
    cancelled: false,
    outputs: [{ id: "s01", courier: "propio" }],
    failedStops: [],
    lastStop: null,
    failedOutput: null,
    episode: { key: "s:stop-1", at: "2026-10-12T20:00:00Z" },
    ownLive: { id: "s01", courier: "propio" },
    ownBox: null,
    ownInOtherRequest: false,
    receivedAt: "2026-10-13T12:30:00Z",
    box: { kind: "en_oficina", since: "2026-10-13T12:30:00Z", courier: "propio" },
    retryAdmission: false,
    otherLiveCourier: null,
    hadPropio: true,
    ownReplace: null,
    program: null,
    programRemovedAt: null,
    provider: { id: "gf", org_id: "org", status: "active", same_day_cutoff: "12:00" },
    request: null,
    cases: [],
    open: null,
    latestClosed: null,
    reopened: false,
    ...over,
  };
}

/** La consulta del caso por id (`caseInScope`). */
const isCaseRead = (q: Query) => q.table === "lima_repro_cases" && q.op === "select" && q.columns !== "closed_at,claimed_by" && q.filters.some(([m, k]) => m === "eq" && k === "id");

function confirmInput(over: Record<string, unknown> = {}) {
  return {
    caseId: CASE_ID,
    operationId: OP_ID,
    outcome: "confirma" as const,
    channel: "llamada" as const,
    agreedOn: "2026-10-15",
    courier: "propio" as const,
    changes: {},
    expectedBoxAction: "mantener" as const,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  state.queries = [];
  state.rpcs = [];
  state.facts = [facts()];
  state.factsCalls = 0;
  state.materialize.mockReset();
  state.cleared.mockReset();
  state.closeStale.mockReset();
  state.boxInputs = [];
  state.respond = (q) => (isCaseRead(q) ? { data: caseRow(), error: null } : { data: null, error: null });
  state.rpc = () => ({ data: { call_id: "call-1", duplicate: false }, error: null });
});

describe("un guardado rechazado le dice a la hoja qué pasó (C3)", () => {
  it("Atender toma un pendiente elegible con contexto propio y el mismo candado", async () => {
    state.facts = [facts({ inStage: false, attentionEligible: true, episode: { key: `attention:${ORDER_ID}`, at: null } })];
    state.rpc = () => ({ data: { case_id: CASE_ID, claimed: true, until: "2026-10-13T13:10:00Z" }, error: null });
    expect(await claimReproCase(ORDER_ID)).toMatchObject({ caseId: CASE_ID });
    expect(state.rpcs[0]?.params.p_episode).toBe(`attention:${ORDER_ID}`);
  });
  it.each([{ inStage: false, attentionEligible: false }, { inStage: false, attentionEligible: true, cancelled: true }, { storeId: "otra" }])("no toma un pendiente fuera de alcance: %j", async (extra) => {
    state.facts = [facts(extra)];
    expect(await claimReproCase(ORDER_ID)).toHaveProperty("error");
    expect(state.rpcs).toEqual([]);
  });
  it("registra la llamada del primer despacho sin cambiarlo a entrega fallida", async () => {
    const c = caseRow({ episode_key: `attention:${ORDER_ID}` });
    state.respond = (q) => isCaseRead(q) ? { data: c, error: null } : { data: null, error: null };
    state.facts = [facts({ inStage: false, attentionEligible: true, episode: { key: c.episode_key, at: null } })];
    const result = await registerReproCall(confirmInput({ outcome: "no_contesta", courier: null, agreedOn: null }));
    expect(result.error).toBeUndefined();
    expect(state.rpcs[0]?.name).toBe("lima_repro_record");
    expect(state.rpcs[0]?.params.p_episode).toBe(c.episode_key);
    expect(state.materialize).not.toHaveBeenCalled();
  });
  it("guarda la fecha acordada del primer despacho y conserva la creación de guía en su flujo", async () => {
    const c = caseRow({ episode_key: `attention:${ORDER_ID}` });
    const f = facts({ inStage: false, attentionEligible: true, episode: { key: c.episode_key, at: null }, outputs: [], ownLive: null, box: { kind: "desconocida" }, hadPropio: false });
    state.respond = (q) => isCaseRead(q) ? { data: c, error: null } : { data: null, error: null };
    state.facts = [f, { ...f, cases: [{ ...c, agreement_call_id: "call-1", agreed_on: "2026-10-14", agreed_courier: "propio", box_action: "salida_nueva_rearmar" }] }];
    const result = await registerReproCall(confirmInput({ agreedOn: "2026-10-14", expectedBoxAction: "salida_nueva_rearmar" }));
    expect(result.error).toBeUndefined();
    expect(state.rpcs[0]?.params).toMatchObject({ p_episode: c.episode_key, p_agreed_on: "2026-10-14", p_outcome: "confirma", p_box_action: "salida_nueva_rearmar" });
    expect(state.materialize).not.toHaveBeenCalled();
  });
  it("sin el candado: «Ya no tienes este caso» con claimLost, y no llega a la RPC", async () => {
    state.respond = (q) => (isCaseRead(q) ? { data: caseRow({ claimed_by: "ana" }), error: null } : { data: null, error: null });
    const result = await registerReproCall(confirmInput());
    expect(result).toEqual({ error: "Ya no tienes este caso: vuelve a tomarlo.", claimLost: true });
    expect(state.rpcs).toEqual([]);
  });

  it("el candado se perdió entre la lectura y la RPC: también claimLost", async () => {
    state.rpc = () => ({ data: null, error: { message: "Ya no tienes este caso: vuelve a tomarlo." } });
    const result = await registerReproCall(confirmInput());
    expect(result).toEqual({ error: "Ya no tienes este caso: vuelve a tomarlo.", claimLost: true });
  });

  it("otro error de la RPC no dice que se perdió el caso", async () => {
    state.rpc = () => ({ data: null, error: { message: "La nueva fecha no puede pasar de 60 días." } });
    const result = await registerReproCall(confirmInput());
    expect(result).toEqual({ error: "La nueva fecha no puede pasar de 60 días." });
  });

  it("la caja cambió mientras decidías: boxChanged, sin RPC", async () => {
    // La hoja vio la caja con el motorizado y marcó «No esperar la caja»;
    // Grupo GF ya la recibió: en oficina es «Mantener».
    const result = await registerReproCall(confirmInput({ changes: { no_esperar_caja: true }, expectedBoxAction: "caja_nueva_stock" }));
    expect(result).toEqual({
      error: "La caja cambió mientras decidías: revisa «Qué hacer con la caja» y vuelve a guardar.",
      boxChanged: true,
    });
    expect(state.rpcs).toEqual([]);
  });

  it("un problema de caja que la hoja no vio (cinco salidas) también es un cambio", async () => {
    state.facts = [facts({ ownLive: null, outputs: [1, 2, 3, 4, 5].map((n) => ({ id: `s0${n}`, courier: "propio" })) })];
    const result = await registerReproCall(confirmInput({ expectedBoxAction: "salida_nueva_rearmar" }));
    expect(result.boxChanged).toBe(true);
    expect(result.error).toContain("Ya usó las 5 salidas");
    expect(state.rpcs).toEqual([]);
  });

  it("«El pedido cambió mientras lo abrías»: boxChanged, sin cerrar el caso", async () => {
    state.facts = [facts({ episode: { key: "s:stop-0", at: "2026-10-10T20:00:00Z" } })];
    const result = await registerReproCall(confirmInput());
    expect(result).toEqual({ error: "El pedido cambió mientras lo abrías: vuelve a intentarlo.", boxChanged: true });
    expect(state.closeStale).not.toHaveBeenCalled();
  });

  it("un intento nuevo cierra el caso y no pide recargar la caja", async () => {
    state.facts = [facts({ episode: { key: "s:stop-2", at: "2026-10-13T12:00:00Z" } })];
    const result = await registerReproCall(confirmInput());
    expect(result).toEqual({ error: "El pedido tuvo otro intento de entrega: vuelve a abrirlo." });
    expect(state.closeStale).toHaveBeenCalledWith(expect.anything(), [CASE_ID], "nuevo_intento");
  });
});

describe("«No esperar la caja» en el caso reabierto (E29, C2)", () => {
  const e29 = { box: { kind: "desconocida", own: true }, receivedAt: "2026-10-13T12:30:00Z" };

  it("reabierto: con la caja que no consta, sale caja nueva desde stock (misma salida)", async () => {
    state.facts = [facts({ ...e29, reopened: true }), facts({ ...e29, reopened: true, cases: [] })];
    const result = await registerReproCall(confirmInput({ changes: { no_esperar_caja: true }, expectedBoxAction: "caja_nueva_stock" }));
    expect(result.error).toBeUndefined();
    expect(result.callId).toBe("call-1");
    const record = state.rpcs.find((r) => r.name === "lima_repro_record")!;
    expect(record.params.p_box_action).toBe("caja_nueva_stock");
    expect(record.params.p_box_location).toBe("desconocida");
  });

  it("sin reabrir, la misma caja no admite «No esperar la caja»: el servidor ve otra acción", async () => {
    state.facts = [facts({ ...e29, reopened: false })];
    const result = await registerReproCall(confirmInput({ changes: { no_esperar_caja: true }, expectedBoxAction: "caja_nueva_stock" }));
    expect(result.boxChanged).toBe(true);
    expect(state.rpcs).toEqual([]);
  });
});

describe("si programar falla, no queda el programa de otro día (E23)", () => {
  const agreed = caseRow({
    agreement_call_id: "call-1",
    agreed_on: "2026-10-15",
    agreed_courier: "propio",
    box_action: "mantener",
    decided_by: "me",
    decided_at: NOW.toISOString(),
  });
  const program = (day: string) => ({ order_id: ORDER_ID, store_id: "store", scheduled_for: day, reason: "Programado por Grupo GF", set_at: "2026-10-12T15:00:00Z" });
  const setFacts = (day: string) => {
    state.facts = [facts({ program: program(day) }), facts({ program: program(day), cases: [agreed] })];
  };

  it("la escritura falla y el programa era de HOY: se quita y se dice", async () => {
    setFacts("2026-10-13");
    state.materialize.mockResolvedValue({ status: "error", message: "No se pudo programar en Grupo GF." });
    const result = await registerReproCall(confirmInput());
    expect(state.cleared).toHaveBeenCalledTimes(1);
    expect(state.cleared.mock.calls[0]![1]).toEqual([program("2026-10-13")]);
    expect(state.cleared.mock.calls[0]![2]).toBe("me");
    expect(state.cleared.mock.calls[0]![3]).toBe("Repro Lima: el acuerdo con el cliente es otro.");
    expect(result.callId).toBe("call-1");
    expect(result.notice).toBe("Acuerdo guardado. Se quitó la fecha que tenía en Grupo GF.");
    expect(result.error).toBe("Acuerdo guardado, pero no se pudo programar: No se pudo programar en Grupo GF. Se quitó la fecha que tenía en Grupo GF. Usa «Programar ahora».");
  });

  it("otra persona lo marcó antes (omitido) con el programa viejo: también se quita", async () => {
    setFacts("2026-10-13");
    state.materialize.mockResolvedValue({ status: "omitido" });
    const result = await registerReproCall(confirmInput());
    expect(state.cleared).toHaveBeenCalledTimes(1);
    expect(result.error).toContain("Se quitó la fecha que tenía en Grupo GF.");
  });

  it("el programa ya era del día acordado: no se toca", async () => {
    setFacts("2026-10-15");
    state.materialize.mockResolvedValue({ status: "error", message: "No se pudo programar en Grupo GF." });
    const result = await registerReproCall(confirmInput());
    expect(state.cleared).not.toHaveBeenCalled();
    expect(result.error).toBe("Acuerdo guardado, pero no se pudo programar: No se pudo programar en Grupo GF. Usa «Programar ahora».");
  });

  it("el caso se cerró (otro intento): su acuerdo ya no manda y no se toca", async () => {
    setFacts("2026-10-13");
    state.materialize.mockResolvedValue({ status: "cerrado", reason: "nuevo_intento", message: "El pedido tuvo otro intento de entrega: vuelve a abrirlo." });
    await registerReproCall(confirmInput());
    expect(state.cleared).not.toHaveBeenCalled();
  });
});

describe("caja nueva desde stock sin quien saque la salida (F12)", () => {
  it("con la caja de Tanders volviendo y sin reintento: «Falta la salida nueva» y se quita todo programa", async () => {
    const tanders = {
      box: { kind: "volviendo_courier", courier: "tanders" },
      ownLive: null,
      failedOutput: { id: "s01", courier: "tanders" },
      outputs: [{ id: "s01", courier: "tanders" }],
      hadPropio: false,
      retryAdmission: false,
      program: { order_id: ORDER_ID, store_id: "store", scheduled_for: "2026-10-15", reason: "Programado por Grupo GF", set_at: "2026-10-12T15:00:00Z" },
    };
    const agreed = caseRow({
      agreement_call_id: "call-1",
      agreed_on: "2026-10-15",
      agreed_courier: "propio",
      box_action: "caja_nueva_stock",
      decided_by: "me",
      decided_at: NOW.toISOString(),
    });
    state.facts = [facts(tanders), facts({ ...tanders, cases: [agreed] })];
    const result = await registerReproCall(confirmInput({ changes: { no_esperar_caja: true }, expectedBoxAction: "caja_nueva_stock" }));
    expect(state.materialize).not.toHaveBeenCalled();
    expect(state.cleared).toHaveBeenCalledTimes(1);
    expect(result.notice).toBe("Acuerdo guardado. Falta la salida nueva: Kapta todavía no la crea para una caja nueva desde stock. Anótalo en la ficha y avisa a Despacho GF. Se quitó la fecha que tenía en Grupo GF.");
    // «Qué hacer con la caja» se calcula con el reintento de los hechos: no promete
    // que Grupo GF crea la salida al tomarlo.
    expect(state.boxInputs[0]).toHaveProperty("retryAdmission", false);
  });

  it("con reintento, la acción de la caja lo sabe: Grupo GF crea la salida al tomarlo", async () => {
    const tanders = {
      box: { kind: "volviendo_courier", courier: "tanders" },
      ownLive: null,
      failedOutput: { id: "s01", courier: "tanders" },
      outputs: [{ id: "s01", courier: "tanders" }],
      hadPropio: false,
      retryAdmission: true,
    };
    state.facts = [facts(tanders)];
    await registerReproCall(confirmInput({ changes: { no_esperar_caja: true }, expectedBoxAction: "caja_nueva_stock" }));
    expect(state.boxInputs[0]).toHaveProperty("retryAdmission", true);
    expect(state.rpcs.find((r) => r.name === "lima_repro_record")?.params.p_box_action).toBe("caja_nueva_stock");
  });
});

describe("«Atender» y el «Desarmar y cerrar» que llega tarde (E29, C4)", () => {
  it("manda p_reopen y traduce needs_reopen a «Volver a atender»", async () => {
    // Los hechos leídos no tenían el cierre: lo ve la RPC dentro de su candado.
    state.rpc = () => ({ data: { claimed: false, needs_reopen: true }, error: null });
    const result = await claimReproCase(ORDER_ID);
    expect(result).toEqual({ error: "Este pedido se cerró con «Desarmar y cerrar». «Volver a atender» lo reabre.", needsReopen: true });
    expect(state.rpcs[0]!.name).toBe("lima_repro_claim");
    expect(state.rpcs[0]!.params.p_reopen).toBe(false);
  });

  it("con el segundo clic, p_reopen va en true", async () => {
    state.rpc = () => ({ data: { case_id: CASE_ID, claimed: true, until: "2026-10-13T13:10:00Z" }, error: null });
    const result = await claimReproCase(ORDER_ID, { reopen: true });
    expect(result).toEqual({ caseId: CASE_ID, until: "2026-10-13T13:10:00Z" });
    expect(state.rpcs[0]!.params.p_reopen).toBe(true);
  });
});

describe("«Programar ahora» toma el candado de SU caso y nunca abre otro (F7)", () => {
  const agreed = (over: Record<string, unknown> = {}) => caseRow({
    claimed_by: null,
    claimed_until: null,
    agreement_call_id: "call-1",
    agreed_on: "2026-10-15",
    agreed_courier: "propio",
    box_action: "mantener",
    decided_by: "me",
    decided_at: "2026-10-13T12:50:00Z",
    ...over,
  });
  const isClaim = (q: Query) => q.table === "lima_repro_cases" && q.op === "update" && q.values?.claimed_by === "me";
  /** Quién lo tiene, si la escritura condicional no tomó nada. */
  const isHolder = (q: Query) => q.table === "lima_repro_cases" && q.op === "select" && q.columns === "closed_at,claimed_by";

  function respondWith(claim: unknown, holder: unknown) {
    state.respond = (q) => {
      if (isClaim(q)) return { data: claim, error: null };
      if (isHolder(q)) return { data: holder, error: null };
      if (isCaseRead(q)) return { data: agreed(), error: null };
      return { data: null, error: null };
    };
  }

  it("el caso se cerró mientras tanto («Ya no lo quiere»): no abre otro, dice que está cerrado", async () => {
    respondWith(null, { closed_at: "2026-10-13T12:59:00Z", claimed_by: null });
    const result = await programReproAgreement({ caseId: CASE_ID });
    expect(result).toEqual({ error: "El caso ya está cerrado." });
    expect(state.rpcs).toEqual([]);
    expect(state.materialize).not.toHaveBeenCalled();
  });

  it("otra persona lo tiene: lo dice con su nombre", async () => {
    respondWith(null, { closed_at: null, claimed_by: "ana" });
    const result = await programReproAgreement({ caseId: CASE_ID });
    expect(result).toEqual({ error: "Ana está atendiendo este pedido." });
    expect(state.materialize).not.toHaveBeenCalled();
  });

  it("el candado es una escritura condicional sobre el caso abierto, libre, vencido o propio", async () => {
    respondWith({ id: CASE_ID }, null);
    state.materialize.mockResolvedValue({ status: "programado", day: "2026-10-15", wrote: true });
    const result = await programReproAgreement({ caseId: CASE_ID });
    expect(result.notice).toContain("Programado: sale el jue 15/10 con Grupo GF.");
    expect(state.rpcs).toEqual([]);
    const claim = state.queries.find(isClaim)!;
    expect(claim.filters).toEqual(expect.arrayContaining([["eq", "id", CASE_ID], ["is", "closed_at", null]]));
    expect(claim.or).toBe(`claimed_by.is.null,claimed_by.eq.me,claimed_until.lte.${NOW.toISOString()}`);
    expect(claim.values).toEqual({ claimed_by: "me", claimed_until: "2026-10-13T13:10:00.000Z" });
    // No era suyo: lo suelta después, solo si sigue siendo suyo.
    const release = state.queries.find((q) => q.op === "update" && q.values?.claimed_by === null)!;
    expect(release.filters).toEqual([["eq", "id", CASE_ID], ["eq", "claimed_by", "me"]]);
    expect(state.queries.some(isHolder)).toBe(false);
  });

  it("si ya era suyo, no lo suelta", async () => {
    state.respond = (q) => {
      if (isClaim(q)) return { data: { id: CASE_ID }, error: null };
      if (isCaseRead(q)) return { data: agreed({ claimed_by: "me", claimed_until: "2026-10-13T13:05:00Z" }), error: null };
      return { data: null, error: null };
    };
    state.materialize.mockResolvedValue({ status: "programado", day: "2026-10-15", wrote: true });
    await programReproAgreement({ caseId: CASE_ID });
    expect(state.queries.some((q) => q.op === "update" && q.values?.claimed_by === null)).toBe(false);
  });
});
