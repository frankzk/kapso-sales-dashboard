// Las políticas escritas por tienda (MOM §42.6, parte 2; 0315): el estado de
// una política en un día de Lima, lo que se acepta del formulario, lo que lee el
// agente en `consultar_politicas` y las acciones de la pantalla (crear, editar,
// retirar). Lo que se fija:
//   - vigente de `valid_from` a `valid_until` incluidos; retirada gana;
//   - el agente lee solo las vigentes de la tienda que pidió, sin quién las
//     escribió; sin la 0315 o con la base caída, `escritas: null` (no «ninguna»);
//   - escribir pide `automations.manage` y que la persona vea la tienda; una
//     retirada no se edita; guardar sin cambios no crea versión;
//   - el registro no lleva el texto de la política.
// Las reglas de la base (versión, historial, retirada final), en
// scripts/sql/store_policies_smoke.sql.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  POLICIES_FOR_AGENT_MAX,
  agentWrittenPolicy,
  isPolicyMigrationMissing,
  parsePolicyInput,
  policiesInForce,
  policyStatus,
  type StorePolicyRow,
} from "@/lib/store-policies";

// ---------------------------------------------------------------------------
// Base falsa (la misma forma que en test/agent-connector.test.ts)
// ---------------------------------------------------------------------------

type Op = [method: string, ...args: unknown[]];
interface Query {
  table: string;
  ops: Op[];
}
interface Reply {
  data?: unknown;
  error?: unknown;
}

function fakeDb(reply: (q: Query) => Reply = () => ({ data: [] })) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, ops: [] };
      queries.push(q);
      const result = (single: boolean) => {
        const r = reply(q);
        const data = single && Array.isArray(r.data) ? (r.data[0] ?? null) : (r.data ?? (single ? null : []));
        return { data, error: r.error ?? null };
      };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "or", "order", "limit", "not", "gte", "lte", "is", "insert", "update"]) {
        b[m] = (...args: unknown[]) => {
          q.ops.push([m, ...args]);
          return b;
        };
      }
      b.maybeSingle = () => Promise.resolve(result(true));
      b.single = () => Promise.resolve(result(true));
      b.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(result(false)).then(ok, ko);
      return b;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
    auth: { getUser: async () => ({ data: { user: h.user } }) },
  };
  return { client: client as unknown as SupabaseClient, queries };
}

const op = (q: Query | undefined, method: string) => q?.ops.find(([m]) => m === method);
const has = (q: Query | undefined, method: string, ...args: unknown[]) =>
  !!q?.ops.some(([m, ...a]) => m === method && JSON.stringify(a.slice(0, args.length)) === JSON.stringify(args));

const h = vi.hoisted(() => ({
  user: { id: "00000000-0000-4000-8000-0000000000c1" } as { id: string } | null,
  allowed: true,
  admin: null as unknown as { client: unknown; queries: { table: string; ops: unknown[][] }[] },
  server: null as unknown as { client: unknown; queries: { table: string; ops: unknown[][] }[] },
  revalidated: [] as string[],
}));
vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => h.admin.client,
  createServerSupabase: async () => h.server.client,
}));
vi.mock("@/lib/permissions-access", () => ({
  hasOrgPermission: async (_org: string, key: string) => h.allowed && key === "automations.manage",
  orgsWithPermission: async () => [],
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => h.revalidated.push(p) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));

const ORG = "00000000-0000-4000-8000-0000000000aa";
const KENKU = "00000000-0000-4000-8000-000000000001";
const AURELA = "00000000-0000-4000-8000-000000000002";
const USER = "00000000-0000-4000-8000-0000000000c1";

const policy = (over: Partial<StorePolicyRow> = {}): StorePolicyRow => ({
  id: "p1",
  store_id: KENKU,
  title: "Cambios",
  body: "Cambios dentro de 7 días.",
  valid_from: "2026-11-01",
  valid_until: null,
  source: null,
  version: 1,
  updated_at: "2026-11-01T15:00:00Z",
  retired_at: null,
  ...over,
});

// ---------------------------------------------------------------------------
// Reglas puras
// ---------------------------------------------------------------------------

describe("policyStatus", () => {
  it("vale de su primer día a su último, los dos incluidos", () => {
    const p = { valid_from: "2026-11-08", valid_until: "2026-11-30", retired_at: null };
    expect(policyStatus(p, "2026-11-07")).toBe("programada");
    expect(policyStatus(p, "2026-11-08")).toBe("vigente");
    expect(policyStatus(p, "2026-11-30")).toBe("vigente");
    expect(policyStatus(p, "2026-12-01")).toBe("vencida");
    expect(policyStatus({ ...p, valid_until: null }, "2030-01-01")).toBe("vigente");
  });
  it("retirada gana a todo", () => {
    expect(policyStatus({ valid_from: "2026-11-01", valid_until: null, retired_at: "2026-11-05T10:00:00Z" }, "2026-11-08")).toBe("retirada");
  });
});

describe("policiesInForce y agentWrittenPolicy", () => {
  it("solo las vigentes, por título, hasta el tope", () => {
    const rows = [
      policy({ id: "b", title: "Garantía" }),
      policy({ id: "a", title: "Cambios" }),
      policy({ id: "x", title: "Futura", valid_from: "2026-12-01" }),
      policy({ id: "y", title: "Vieja", valid_until: "2026-11-02" }),
      policy({ id: "z", title: "Retirada", retired_at: "2026-11-03T00:00:00Z" }),
    ];
    expect(policiesInForce(rows, "2026-11-08").map((p) => p.id)).toEqual(["a", "b"]);
    const many = Array.from({ length: 30 }, (_, i) => policy({ id: `p${i}`, title: `P${String(i).padStart(2, "0")}` }));
    expect(policiesInForce(many, "2026-11-08")).toHaveLength(POLICIES_FOR_AGENT_MAX);
  });
  it("el agente recibe el texto y la vigencia, no quién la escribió", () => {
    const out = agentWrittenPolicy(policy({ source: "Web", version: 3 }));
    expect(out).toEqual({ titulo: "Cambios", texto: "Cambios dentro de 7 días.", vigente_desde: "2026-11-01", vigente_hasta: null, fuente: "Web", version: 3, actualizada: "2026-11-01T15:00:00Z" });
    expect(JSON.stringify(out)).not.toMatch(/updated_by|created_by|editor/);
  });
});

describe("parsePolicyInput", () => {
  const base = { title: "  Cambios   y devoluciones ", body: "Primera línea.  \r\n\r\n\r\n  Segunda   línea.", validFrom: "2026-11-08", validUntil: "", source: "  " };
  it("limpia los espacios, conserva los párrafos y deja en null lo opcional vacío", () => {
    expect(parsePolicyInput(base)).toEqual({
      ok: true,
      value: { title: "Cambios y devoluciones", body: "Primera línea.\n\nSegunda línea.", validFrom: "2026-11-08", validUntil: null, source: null },
    });
  });
  it("rechaza con un mensaje lo que la base también rechazaría", () => {
    expect(parsePolicyInput({ ...base, title: "x" })).toMatchObject({ ok: false });
    expect(parsePolicyInput({ ...base, body: " " })).toEqual({ ok: false, error: "Escribe el texto de la política." });
    expect(parsePolicyInput({ ...base, body: "x".repeat(4001) })).toMatchObject({ ok: false, error: expect.stringContaining("4000") });
    expect(parsePolicyInput({ ...base, validFrom: "2026-02-30" })).toEqual({ ok: false, error: "Indica desde qué día vale." });
    expect(parsePolicyInput({ ...base, validUntil: "2026-11-07" })).toEqual({ ok: false, error: "La fecha «hasta» no puede ser antes de la fecha «desde»." });
    expect(parsePolicyInput({ ...base, source: "x".repeat(201) })).toMatchObject({ ok: false });
    expect(parsePolicyInput({ ...base, title: null })).toMatchObject({ ok: false });
  });
  it("el mismo día de inicio y fin vale", () => {
    expect(parsePolicyInput({ ...base, validUntil: "2026-11-08" })).toMatchObject({ ok: true, value: { validUntil: "2026-11-08" } });
  });
  it("reconoce la migración que falta solo en sus tablas", () => {
    expect(isPolicyMigrationMissing({ code: "PGRST205", message: "Could not find the table 'public.store_policies'" })).toBe(true);
    expect(isPolicyMigrationMissing({ code: "42P01", message: 'relation "agent_tokens" does not exist' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lo que lee el agente
// ---------------------------------------------------------------------------

describe("consultar_politicas con las escritas", () => {
  const ctx = { tokenId: "t", orgId: ORG, userId: USER, label: "Grok", scopes: new Set(["politicas.leer"] as const), stores: [{ id: KENKU, name: "Kenku Peru" }, { id: AURELA, name: "Aurela" }] };

  async function run(reply: (q: Query) => Reply, now = new Date("2026-11-09T02:00:00Z")) {
    const { handleMcpMessage } = await import("@/lib/mcp-server");
    const db = fakeDb(reply);
    const out = (await handleMcpMessage(ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "consultar_politicas", arguments: { tienda: "aurela" } } }, {
      admin: db.client,
      now,
      clock: () => 0,
      kapsoKey: async () => null,
      transcript: async () => [],
      conversationByPhone: async () => null,
      rateLimited: async () => false,
      record: async () => {},
    })) as { result: { isError: boolean; structuredContent: Record<string, unknown> } };
    return { out: out.result, queries: db.queries };
  }

  it("lee las vigentes del día de Lima, solo de la tienda que pidió", async () => {
    const { out, queries } = await run((q) =>
      q.table === "store_policies"
        ? { data: [policy({ id: "a", store_id: AURELA, title: "Garantía" }), policy({ id: "x", store_id: AURELA, title: "Futura", valid_from: "2026-12-01" })] }
        : { data: [] },
    );
    const q = queries.find((x) => x.table === "store_policies");
    expect(has(q, "eq", "store_id", AURELA)).toBe(true);
    expect(has(q, "is", "retired_at", null)).toBe(true);
    expect(has(q, "lte", "valid_from", "2026-11-08")).toBe(true);
    expect(op(q, "or")?.[1]).toBe("valid_until.is.null,valid_until.gte.2026-11-08");
    expect(out.isError).toBe(false);
    expect(out.structuredContent).toMatchObject({ tienda: "Aurela", dia: "2026-11-08", escritas: [{ titulo: "Garantía" }], calculadas: { adelanto_minimo: { monto: 20 } } });
    // La futura no pasa aunque la base la devolviera.
    expect((out.structuredContent.escritas as unknown[]).length).toBe(1);
    expect(out.structuredContent).not.toHaveProperty("nota");
  });

  it("sin políticas escritas lo dice, y no es lo mismo que no poder leerlas", async () => {
    const none = await run(() => ({ data: [] }));
    expect(none.out.structuredContent).toMatchObject({ escritas: [], nota: expect.stringContaining("no inventes") });
    const missing = await run((q) => (q.table === "store_policies" ? { error: { code: "PGRST205", message: "store_policies" } } : { data: [] }));
    expect(missing.out.isError).toBe(false);
    expect(missing.out.structuredContent).toMatchObject({ escritas: null, nota: expect.stringContaining("No se pudieron leer"), calculadas: { adelanto_minimo: { monto: 20 } } });
  });
});

// ---------------------------------------------------------------------------
// Las acciones de la pantalla
// ---------------------------------------------------------------------------

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const NEW = { org_id: ORG, store_id: KENKU, title: "Cambios", body: "Dentro de 7 días.", valid_from: "2026-11-08", valid_until: "", source: "" };

describe("saveStorePolicy y retireStorePolicy", () => {
  let current: Record<string, unknown> | null;
  let visible: string[];
  beforeEach(() => {
    h.allowed = true;
    h.user = { id: USER };
    h.revalidated = [];
    visible = [KENKU];
    current = { id: "p1", store_id: KENKU, title: "Cambios", body: "Dentro de 7 días.", valid_from: "2026-11-08", valid_until: null, source: null, retired_at: null };
    h.server = fakeDb((q) => {
      const id = q.ops.find(([m, c]) => m === "eq" && c === "id")?.[2] as string;
      return { data: q.table === "stores" && visible.includes(id) ? [{ id }] : [] };
    }) as unknown as typeof h.server;
    h.admin = fakeDb((q) => {
      if (q.table !== "store_policies") return { data: [] };
      if (op(q, "insert")) return { data: [{ id: "new-1" }] };
      if (op(q, "update")) return { data: current && !current.retired_at ? [{ id: "p1", version: 2 }] : [] };
      return { data: current ? [current] : [] };
    }) as unknown as typeof h.admin;
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("sin automations.manage no escribe nada", async () => {
    const { saveStorePolicy } = await import("@/app/dashboard/automatizaciones/conector/actions");
    h.allowed = false;
    expect(await saveStorePolicy({}, form(NEW))).toEqual({ error: "Sin permiso." });
    expect(h.admin.queries).toHaveLength(0);
  });

  it("crea en una tienda que la persona ve, con su autor, y el registro no lleva el texto", async () => {
    const { saveStorePolicy } = await import("@/app/dashboard/automatizaciones/conector/actions");
    const out = await saveStorePolicy({}, form({ ...NEW, body: "Dentro de 7 días, con boleta." }));
    expect(out).toMatchObject({ savedId: "new-1" });
    const insert = op(h.admin.queries.find((q) => op(q as Query, "insert")) as Query, "insert")![1];
    expect(insert).toEqual({ org_id: ORG, store_id: KENKU, title: "Cambios", body: "Dentro de 7 días, con boleta.", valid_from: "2026-11-08", valid_until: null, source: null, created_by: USER, updated_by: USER });
    expect(h.revalidated).toEqual(["/dashboard/automatizaciones/conector"]);
    const logged = String(vi.mocked(console.info).mock.calls[0]![0]);
    expect(logged).toContain('"step":"created"');
    expect(logged).not.toContain("boleta");
  });

  it("una tienda que no ve, o un formulario inválido: no escribe", async () => {
    const { saveStorePolicy } = await import("@/app/dashboard/automatizaciones/conector/actions");
    expect(await saveStorePolicy({}, form({ ...NEW, store_id: AURELA }))).toEqual({ error: "Elige una tienda que veas, de esta organización." });
    expect(await saveStorePolicy({}, form({ ...NEW, valid_until: "2026-11-01" }))).toMatchObject({ error: expect.stringContaining("«hasta»") });
    expect(h.admin.queries.some((q) => op(q as Query, "insert"))).toBe(false);
  });

  it("editar: la tienda sale de la política, no del formulario; sin cambios no crea versión", async () => {
    const { saveStorePolicy } = await import("@/app/dashboard/automatizaciones/conector/actions");
    // Mismo contenido: nada que guardar.
    expect(await saveStorePolicy({}, form({ ...NEW, store_id: AURELA, policy_id: "p1" }))).toMatchObject({ notice: expect.stringContaining("Sin cambios"), savedId: "p1" });
    expect(h.admin.queries.some((q) => op(q as Query, "update"))).toBe(false);
    // Con cambios: versión nueva, con quien la editó.
    const out = await saveStorePolicy({}, form({ ...NEW, store_id: AURELA, policy_id: "p1", body: "Dentro de 15 días." }));
    expect(out).toMatchObject({ savedId: "p1", notice: expect.stringContaining("versión 2") });
    const update = h.admin.queries.find((q) => op(q as Query, "update")) as Query;
    expect(op(update, "update")![1]).toMatchObject({ body: "Dentro de 15 días.", updated_by: USER });
    expect(op(update, "update")![1]).not.toHaveProperty("store_id");
    expect(has(update, "is", "retired_at", null)).toBe(true);
  });

  it("una retirada no se edita ni se vuelve a retirar", async () => {
    const { saveStorePolicy, retireStorePolicy } = await import("@/app/dashboard/automatizaciones/conector/actions");
    current = { ...current!, retired_at: "2026-11-08T10:00:00Z" };
    expect(await saveStorePolicy({}, form({ ...NEW, policy_id: "p1", body: "Otra cosa." }))).toEqual({ error: "Esa política ya está retirada o no existe." });
    expect(await retireStorePolicy({}, form({ org_id: ORG, policy_id: "p1" }))).toEqual({ error: "Esa política ya estaba retirada." });
  });

  it("retirar: con fecha y autor, solo si la persona ve la tienda", async () => {
    const { retireStorePolicy } = await import("@/app/dashboard/automatizaciones/conector/actions");
    expect(await retireStorePolicy({}, form({ org_id: ORG, policy_id: "p1" }))).toEqual({ notice: "Política retirada: el agente ya no la lee." });
    const update = h.admin.queries.find((q) => op(q as Query, "update")) as Query;
    expect(op(update, "update")![1]).toMatchObject({ retired_by: USER, retired_at: expect.any(String) });
    visible = [];
    expect(await retireStorePolicy({}, form({ org_id: ORG, policy_id: "p1" }))).toEqual({ error: "Esa política no existe o es de una tienda que ya no ves." });
  });

  it("sin la 0315: lo dice", async () => {
    const { saveStorePolicy } = await import("@/app/dashboard/automatizaciones/conector/actions");
    h.admin = fakeDb(() => ({ error: { code: "PGRST205", message: "Could not find the table 'public.store_policies'" } })) as unknown as typeof h.admin;
    expect(await saveStorePolicy({}, form(NEW))).toEqual({ error: "Falta aplicar la migración 0315 (políticas escritas) en la base." });
  });
});
