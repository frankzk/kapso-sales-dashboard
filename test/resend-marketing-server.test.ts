// Correo · Resend (MOM §46, 0355): preparar el tema y los segmentos de cada
// tienda sin duplicarlos, y subir un tramo, con la base y Resend falsos.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  settings: null as null | Record<string, unknown>,
  imports: [] as Record<string, unknown>[],
  exportRows: [] as unknown[],
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/crypto", () => ({ decrypt: (v: string) => v.replace(/^enc:/, ""), encrypt: (v: string) => `enc:${v}` }));
vi.mock("@/lib/permissions-access", () => ({ hasOrgPermission: async () => true, orgsWithPermission: async () => [] }));
vi.mock("@/lib/agent-names", () => ({ resolveAgentNames: async () => ({}) }));

function fakeAdmin() {
  return {
    from(table: string) {
      return {
        select() {
          const chain = {
            eq: () => chain,
            maybeSingle: async () => ({ data: table === "resend_settings" ? h.settings : null, error: null }),
          };
          return chain;
        },
        update(patch: Record<string, unknown>) {
          return {
            eq: async () => {
              if (table === "resend_settings" && h.settings) h.settings = { ...h.settings, ...patch };
              return { error: null };
            },
          };
        },
        insert: async (row: Record<string, unknown>) => {
          if (table === "resend_imports") h.imports.push(row);
          return { error: null };
        },
      };
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ fn, args });
      return { data: h.exportRows, error: null };
    },
  };
}

vi.mock("@/lib/db", () => ({ createAdminSupabase: () => fakeAdmin(), createServerSupabase: async () => fakeAdmin() }));

import { ensureResendSetup, importResendBucket } from "@/lib/resend-marketing-server";

type Route = (url: string, init: RequestInit) => { status: number; body?: unknown };

function fakeResend(state: { topics: { id: string; name: string }[]; segments: { id: string; name: string }[] }) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  let n = 0;
  const route: Route = (url, init) => {
    const method = init.method ?? "GET";
    const path = url.replace("https://api.resend.com", "").split("?")[0];
    if (method === "GET" && path === "/topics") return { status: 200, body: { object: "list", data: state.topics, has_more: false } };
    if (method === "GET" && path === "/segments") return { status: 200, body: { object: "list", data: state.segments, has_more: false } };
    if (method === "POST" && path === "/topics") {
      const body = JSON.parse(String(init.body));
      const t = { id: `top${++n}`, name: body.name };
      state.topics.push(t);
      return { status: 201, body: { id: t.id } };
    }
    if (method === "POST" && path === "/segments") {
      const body = JSON.parse(String(init.body));
      const s = { id: `seg${++n}`, name: body.name };
      state.segments.push(s);
      return { status: 201, body: { id: s.id, object: "segment", name: s.name } };
    }
    if (method === "POST" && path === "/contacts/imports") return { status: 202, body: { object: "contact_import", id: "imp_1" } };
    return { status: 404, body: { message: "no" } };
  };
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? "GET", url, body: init.body });
    const r = route(url, init);
    return new Response(JSON.stringify(r.body ?? null), { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls, state };
}

const KENKU = { id: "store-kenku", name: "Kenku Peru" };

beforeEach(() => {
  h.settings = { org_id: "org1", api_key_enc: "enc:re_secret_key_123456", key_hint: "re_…3456", topics: {}, segments: {} };
  h.imports = [];
  h.exportRows = [];
  h.rpcCalls = [];
});

describe("ensureResendSetup", () => {
  it("con los tres tramos pedidos, crea el tema y los tres segmentos, y guarda los ids", async () => {
    const r = fakeResend({ topics: [], segments: [] });
    const res = await ensureResendSetup(fakeAdmin() as never, "org1", "re_secret_key_123456", [KENKU], ["6m", "12m", "todos"], r.impl);
    expect(res.ok).toBe(true);
    expect(r.state.topics.map((t) => t.name)).toEqual(["Kenku Peru"]);
    expect(r.state.segments.map((s) => s.name)).toEqual([
      "Kenku Peru · pidieron en 6 meses",
      "Kenku Peru · pidieron en 12 meses",
      "Kenku Peru · todos los suscritos",
    ]);
    expect(Object.keys((h.settings!.segments as Record<string, string>) ?? {})).toEqual([
      "store-kenku:6m",
      "store-kenku:12m",
      "store-kenku:todos",
    ]);
    expect((h.settings!.topics as Record<string, string>)["store-kenku"]).toBe(r.state.topics[0]!.id);
  });

  it("la segunda vez no crea nada: usa los ids guardados o los del mismo nombre", async () => {
    const r = fakeResend({ topics: [], segments: [] });
    await ensureResendSetup(fakeAdmin() as never, "org1", "k", [KENKU], ["6m", "12m", "todos"], r.impl);
    const posts = () => r.calls.filter((c) => c.method === "POST").length;
    const before = posts();
    const again = await ensureResendSetup(fakeAdmin() as never, "org1", "k", [KENKU], ["6m", "12m", "todos"], r.impl);
    expect(posts()).toBe(before);
    expect(again.ok && again.value.created).toBe(0);

    // Sin ids guardados (otra organización, o se borraron en Kapta): los encuentra por nombre.
    h.settings = { ...h.settings!, topics: {}, segments: {} };
    const byName = await ensureResendSetup(fakeAdmin() as never, "org1", "k", [KENKU], ["6m", "12m", "todos"], r.impl);
    expect(posts()).toBe(before);
    expect(byName.ok && byName.value.created).toBe(0);
  });

  it("si un segmento se borró en Resend, lo vuelve a crear", async () => {
    const r = fakeResend({ topics: [], segments: [] });
    await ensureResendSetup(fakeAdmin() as never, "org1", "k", [KENKU], ["6m", "12m", "todos"], r.impl);
    r.state.segments.splice(0, 1);
    const res = await ensureResendSetup(fakeAdmin() as never, "org1", "k", [KENKU], ["6m", "12m", "todos"], r.impl);
    expect(res.ok && res.value.created).toBe(1);
    expect(r.state.segments.map((s) => s.name)).toContain("Kenku Peru · pidieron en 6 meses");
  });

  it("sin tramos pedidos solo crea el tema: ningún segmento", async () => {
    const r = fakeResend({ topics: [], segments: [] });
    const res = await ensureResendSetup(fakeAdmin() as never, "org1", "k", [KENKU], [], r.impl);
    expect(res.ok && res.value.created).toBe(1);
    expect(r.state.segments).toHaveLength(0);
    expect(r.calls.some((c) => c.url.includes("/segments"))).toBe(false);
  });

  it("con el tope de segmentos del plan, guarda lo que alcanzó a crear y explica el tope", async () => {
    const r = fakeResend({ topics: [], segments: [{ id: "otro1", name: "General" }, { id: "otro2", name: "Otra" }] });
    const base = r.impl;
    let segmentPosts = 0;
    const impl = (async (url: string, init: RequestInit) => {
      if ((init.method ?? "GET") === "POST" && url.endsWith("/segments") && ++segmentPosts > 1) {
        return new Response(JSON.stringify({ name: "validation_error", message: "Your plan includes 3 segments. Upgrade to add more." }), { status: 422 });
      }
      return base(url, init);
    }) as unknown as typeof fetch;
    const res = await ensureResendSetup(fakeAdmin() as never, "org1", "k", [KENKU], ["6m", "12m"], impl);
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/permite solo 3 segmentos/) });
    // El tema y el segmento de 6 meses sí se crearon: quedan guardados.
    expect((h.settings!.topics as Record<string, string>)["store-kenku"]).toBeTruthy();
    expect(Object.keys(h.settings!.segments as Record<string, string>)).toEqual(["store-kenku:6m"]);
  });

  it("con una clave de solo envío, para y lo explica", async () => {
    const impl = (async () => new Response(JSON.stringify({ name: "restricted_api_key", message: "x" }), { status: 401 })) as unknown as typeof fetch;
    const res = await ensureResendSetup(fakeAdmin() as never, "org1", "k", [KENKU], ["6m", "12m", "todos"], impl);
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/solo de envío/) });
  });
});

describe("importResendBucket", () => {
  it("sube el tramo al segmento de la tienda y deja constancia", async () => {
    h.exportRows = [
      { email: "ana@gmail.com", first_name: "Ana", last_name: null, last_order_at: "2026-10-01T00:00:00Z", orders: 2 },
      { email: "beto@gmial.com", first_name: "Beto", last_name: null, last_order_at: "2026-10-02T00:00:00Z", orders: 1 },
    ];
    const r = fakeResend({ topics: [], segments: [] });
    const res = await importResendBucket({ orgId: "org1", store: KENKU, bucket: "6m", userId: "u1", day: "2026-11-25" }, r.impl);
    expect(res).toEqual({ ok: true, value: { rows: 1, excluded: 1 } });
    // Solo el segmento del tramo que se sube.
    expect(r.state.segments.map((s) => s.name)).toEqual(["Kenku Peru · pidieron en 6 meses"]);
    expect(h.rpcCalls[0]).toEqual({ fn: "resend_marketing_export", args: { p_store: "store-kenku", p_months: 6, p_exclude_domains: [] } });
    const imp = r.calls.find((c) => c.url.endsWith("/contacts/imports"))!;
    const form = imp.body as FormData;
    const seg6 = r.state.segments.find((s) => s.name === "Kenku Peru · pidieron en 6 meses")!;
    expect(JSON.parse(String(form.get("segments")))).toEqual([{ id: seg6.id }]);
    expect(await (form.get("file") as File).text()).toBe("email,first_name,last_name\nana@gmail.com,Ana,\n");
    expect(h.imports).toEqual([
      expect.objectContaining({ store_id: "store-kenku", bucket: "6m", resend_import_id: "imp_1", rows: 1, excluded: 1, status: "procesando" }),
    ]);
  });

  it("sin clave guardada no llama a Resend", async () => {
    h.settings = { ...h.settings!, api_key_enc: null };
    const r = fakeResend({ topics: [], segments: [] });
    const res = await importResendBucket({ orgId: "org1", store: KENKU, bucket: "todos", userId: "u1", day: "2026-11-25" }, r.impl);
    expect(res).toEqual({ ok: false, error: "Primero guarda la clave de Resend." });
    expect(r.calls).toHaveLength(0);
  });

  it("el tramo de 9 meses pide 9 meses y va a su propio segmento", async () => {
    h.exportRows = [{ email: "ana@gmail.com", first_name: "Ana", last_name: null, last_order_at: "2026-04-01T00:00:00Z", orders: 1 }];
    const r = fakeResend({ topics: [], segments: [] });
    const res = await importResendBucket({ orgId: "org1", store: KENKU, bucket: "9m", userId: "u1", day: "2026-11-27" }, r.impl);
    expect(res.ok).toBe(true);
    expect(h.rpcCalls[0]!.args.p_months).toBe(9);
    expect(r.state.segments.map((s) => s.name)).toEqual(["Kenku Peru · pidieron en 9 meses"]);
    expect(h.imports[0]).toEqual(expect.objectContaining({ bucket: "9m" }));
  });

  it("un tramo vacío no se sube", async () => {
    h.exportRows = [];
    const r = fakeResend({ topics: [], segments: [] });
    const res = await importResendBucket({ orgId: "org1", store: KENKU, bucket: "12m", userId: "u1", day: "2026-11-25" }, r.impl);
    expect(res.ok).toBe(false);
    expect(r.calls.some((c) => c.url.endsWith("/contacts/imports"))).toBe(false);
    expect(h.imports).toHaveLength(0);
  });
});
