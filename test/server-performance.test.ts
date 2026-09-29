import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { supabaseFetch } from "@/lib/db-fetch";
import {
  instrumentSupabaseFetch,
  measureServerOperation,
  withServerPerformance,
  type ServerPerformancePhase,
  type ServerPerformanceScope,
} from "@/lib/server-performance";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("optional server performance", () => {
  const records: Record<string, any>[] = [];

  beforeEach(() => {
    records.length = 0;
    vi.stubEnv("KAPSO_SERVER_PERFORMANCE", "1");
    vi.spyOn(console, "info").mockImplementation((_prefix, payload) => {
      records.push(JSON.parse(payload));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("passes through the original promise when disabled, and ignores requests outside a scope", async () => {
    const response = new Response("ok");
    const promise = Promise.resolve(response);
    const baseFetch = vi.fn<typeof fetch>().mockReturnValue(promise);
    const wrapped = instrumentSupabaseFetch(baseFetch);
    // A disabled wrapper must not even inspect the request for telemetry.
    const input = { get url() { throw new Error("must not inspect"); } } as unknown as Request;
    const init = { method: "POST" };
    vi.stubEnv("KAPSO_SERVER_PERFORMANCE", "0");
    expect(wrapped(input, init)).toBe(promise);
    expect(withServerPerformance("master.page", () => promise)).toBe(promise);
    expect(measureServerOperation("rows", () => promise)).toBe(promise);
    expect(baseFetch.mock.calls[0]?.[0]).toBe(input);
    expect(baseFetch.mock.calls[0]?.[1]).toBe(init);
    vi.stubEnv("KAPSO_SERVER_PERFORMANCE", "1");
    expect(wrapped("https://project.supabase.co/rest/v1/orders")).toBe(promise);
    expect(measureServerOperation("rows", () => promise)).toBe(promise);
    await promise;
    expect(records).toEqual([]);
  });

  it("records fixed auth/REST operations without URLs, parameters, bodies, credentials or ids", async () => {
    const response = new Response("customer-private-response", {
      headers: { "content-length": "25", "x-request-id": "private-provider-request" },
    });
    const baseFetch = vi.fn<typeof fetch>().mockResolvedValue(response);
    const wrapped = instrumentSupabaseFetch(baseFetch);
    const request = new Request("https://private-project.supabase.co/auth/v1/user/private-customer", {
      method: "POST",
      headers: { authorization: "Bearer private-token" },
      body: "private-customer-email@example.com",
    });
    const returned = await withServerPerformance("master.page", () => measureServerOperation("rows", async () => {
      await wrapped("https://private-project.supabase.co/rest/v1/private-table?phone=private-phone");
      return wrapped(request);
    }));
    expect(returned).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(baseFetch).toHaveBeenLastCalledWith(request, undefined);
    const http = records.filter(record => record.kind === "db_http");
    expect(http.map(record => record.operation)).toEqual(["rest.get", "auth.post"]);
    expect(http[0]).toMatchObject({ phase: "rows", status: 200, contentLengthBytes: 25 });
    expect(records.at(-1)).toMatchObject({ kind: "scope", dbHttpRequests: 2, outcome: "ok" });
    expect(JSON.stringify(records)).not.toContain("private");
    expect(records[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("preserves HTTP errors and thrown errors while omitting error messages", async () => {
    const failure = new Error("private token and private URL");
    const response = new Response("private error body", { status: 403 });
    const baseFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response)
      .mockRejectedValueOnce(failure);
    const wrapped = instrumentSupabaseFetch(baseFetch);
    await expect(withServerPerformance("master.page", () => measureServerOperation("access", async () => {
      expect(await wrapped("https://x.supabase.co/rest/v1/rpc/private-function", { method: "POST" })).toBe(response);
      return wrapped("https://x.supabase.co/auth/v1/user");
    }))).rejects.toBe(failure);
    expect(records[0]).toMatchObject({ operation: "rpc.post", status: 403, outcome: "error" });
    expect(records[1]).toMatchObject({ operation: "auth.get", status: null, outcome: "error" });
    expect(records.at(-1)).toMatchObject({
      kind: "scope", outcome: "error", phases: [expect.objectContaining({ phase: "access", outcome: "error" })],
    });
    expect(JSON.stringify(records)).not.toContain("private");
  });

  it("measures parallel phases by wall time instead of adding overlapping durations", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const rows = deferred<void>();
    const counts = deferred<void>();
    const wrapped = instrumentSupabaseFetch(vi.fn<typeof fetch>().mockResolvedValue(new Response("ok")));
    const run = withServerPerformance("master.page", () => Promise.all([
      measureServerOperation("rows", async () => { await rows.promise; await wrapped("https://x/rest/v1/orders"); }),
      measureServerOperation("counts", async () => { await counts.promise; await wrapped("https://x/rest/v1/rpc/counts"); }),
    ]));
    now = 40;
    rows.resolve();
    await new Promise(setImmediate);
    now = 60;
    counts.resolve();
    await run;
    const summary = records.at(-1)!;
    expect(summary.durationMs).toBe(60);
    expect(summary.phases).toEqual([
      { phase: "rows", offsetMs: 0, durationMs: 40, outcome: "ok" },
      { phase: "counts", offsetMs: 0, durationMs: 60, outcome: "ok" },
    ]);
    expect(records.filter(record => record.kind === "db_http").map(record => record.phase)).toEqual(["rows", "counts"]);
  });

  it("isolates concurrent requests and restores the outer context after a nested scope", async () => {
    const gate = deferred<void>();
    const wrapped = instrumentSupabaseFetch(vi.fn<typeof fetch>().mockResolvedValue(new Response("ok")));
    const first = withServerPerformance("master.page", () => measureServerOperation("rows", async () => {
      await gate.promise;
      await withServerPerformance("master.detail", () => wrapped("https://x/auth/v1/user"));
      await wrapped("https://x/rest/v1/orders");
    }));
    await withServerPerformance("master.page", () => measureServerOperation("counts", () => wrapped("https://x/rest/v1/rpc/counts")));
    gate.resolve();
    await first;
    const summaries = records.filter(record => record.kind === "scope");
    expect(new Set(summaries.map(record => record.requestId)).size).toBe(3);
    for (const summary of summaries) {
      const http = records.filter(record => record.kind === "db_http" && record.requestId === summary.requestId);
      expect(http).toHaveLength(1);
      expect(http[0]?.scope).toBe(summary.scope);
      expect(http[0]?.phase).toBe(summary.phases[0]?.phase);
    }
    expect(summaries.at(-1)?.phases[0]?.phase).toBe("rows");
  });

  it("rejects dynamic labels and records only valid optional Content-Length values", async () => {
    const baseFetch = vi.fn<typeof fetch>();
    for (const length of [undefined, "bad-private-length", "-3", "9007199254740992", "0"]) {
      baseFetch.mockResolvedValueOnce(new Response(null, {
        headers: length === undefined ? {} : { "content-length": length },
      }));
    }
    const wrapped = instrumentSupabaseFetch(baseFetch);
    await withServerPerformance("private-scope" as ServerPerformanceScope, () => measureServerOperation("private-id" as ServerPerformancePhase, async () => {
      for (let i = 0; i < 5; i++) await wrapped("https://x/rest/v1/orders");
    }));
    expect(records.slice(0, 4).every(record => !Object.hasOwn(record, "contentLengthBytes"))).toBe(true);
    expect(records[4]?.contentLengthBytes).toBe(0);
    expect(records.at(-1)).toMatchObject({ scope: "other", phases: [expect.objectContaining({ phase: "other" })] });
    expect(JSON.stringify(records)).not.toContain("private");
  });

  it("ignores non-auth/REST fetches and limits retained phase records", async () => {
    const wrapped = instrumentSupabaseFetch(vi.fn<typeof fetch>().mockResolvedValue(new Response("ok")));
    await withServerPerformance("master.page", async () => {
      await wrapped("https://x/storage/v1/private-bucket/private-object");
      for (let i = 0; i < 205; i++) await measureServerOperation("rows", async () => i);
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ dbHttpRequests: 0, droppedPhases: 5 });
    expect(records[0]?.phases).toHaveLength(200);
  });

  it("does not let a failing logger change the application result", async () => {
    vi.mocked(console.info).mockImplementation(() => { throw new Error("logger unavailable"); });
    const wrapped = instrumentSupabaseFetch(vi.fn<typeof fetch>().mockResolvedValue(new Response("ok")));
    await expect(withServerPerformance("master.page", () => wrapped("https://x/rest/v1/orders"))).resolves.toBeInstanceOf(Response);
  });

  it("instruments the existing dependency-free transport only inside an enabled server scope", async () => {
    const response = new Response("ok");
    const promise = Promise.resolve(response);
    const baseFetch = vi.fn<typeof fetch>().mockReturnValue(promise);
    vi.stubGlobal("fetch", baseFetch);
    // Models the reference already held by the Supabase admin singleton.
    const existingClientFetch = supabaseFetch;
    vi.stubEnv("KAPSO_SERVER_PERFORMANCE", "0");
    expect(existingClientFetch("https://x/rest/v1/orders")).toBe(promise);
    expect(records).toHaveLength(0);
    vi.stubEnv("KAPSO_SERVER_PERFORMANCE", "1");
    await withServerPerformance("master.page", () => measureServerOperation("rows", () => existingClientFetch("https://x/rest/v1/orders")));
    expect(records.filter(record => record.kind === "db_http")).toEqual([
      expect.objectContaining({ operation: "rest.get", phase: "rows", status: 200 }),
    ]);
    const logged = records.length;
    expect(existingClientFetch("https://x/rest/v1/orders")).toBe(promise);
    expect(records).toHaveLength(logged);
    expect(baseFetch).toHaveBeenCalledTimes(3);
  });
});
