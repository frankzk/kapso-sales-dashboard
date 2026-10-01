import { afterEach, describe, expect, it, vi } from "vitest";
import { LeadReadTiming, measureLeadRead } from "@/lib/leads-read-timing";

afterEach(() => vi.restoreAllMocks());

describe("private request-local lead read timings", () => {
  it("preserves the result and records elapsed wall time separately from concurrent stages", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    let time = 0;
    vi.spyOn(performance, "now").mockImplementation(() => time);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const result = measureLeadRead("chat", "history", async (timing) => {
      const a = timing.time("kapso.transcript", () => gate);
      const b = timing.time("kapso.older", () => gate);
      time = 100;
      release();
      await Promise.all([a, b]);
      return "private response";
    });
    expect(await result).toBe("private response");
    const metric = JSON.parse(log.mock.calls[0]![0]);
    expect(metric.durationMs).toBe(100);
    expect(metric.stages["kapso.transcript"].totalMs).toBe(100);
    expect(metric.stages["kapso.older"].totalMs).toBe(100);
    expect(JSON.stringify(metric)).not.toContain("private response");
  });

  it("records HTTP failures/retries without logging URLs, headers, bodies or reading responses", async () => {
    const timing = new LeadReadTiming();
    const response = new Response("private response", { status: 429 });
    const implementation = vi.fn().mockResolvedValueOnce(response).mockRejectedValueOnce(new Error("private network failure"));
    const fetch = timing.fetch("kapso", implementation);
    expect(await fetch("https://private.test/phone", { headers: { secret: "credential" }, body: "private body" })).toBe(response);
    expect(response.bodyUsed).toBe(false);
    await expect(fetch("https://private.test/phone")).rejects.toThrow("private network failure");
    const data = timing.snapshot();
    expect(data.httpStatuses.kapso).toEqual({ 429: 1, 0: 1 });
    expect(data.stages["kapso.http"]).toMatchObject({ count: 2, failures: 2 });
    expect(JSON.stringify(data)).not.toMatch(/private|credential/);
  });

  it("keeps parallel requests isolated and reports exceptions without their contents", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    await Promise.all([
      measureLeadRead("history", "history", (t) => t.time("db.history", async () => 1)),
      measureLeadRead("chat", "first_paint", (t) => t.time("kapso.transcript", async () => 2)),
    ]);
    const metrics = log.mock.calls.map(([value]) => JSON.parse(value));
    expect(metrics.find(m => m.operation === "history").stages).not.toHaveProperty("kapso.transcript");
    expect(metrics.find(m => m.operation === "chat").stages).not.toHaveProperty("db.history");
    await expect(measureLeadRead("history", "history", t => t.time("permissions", async () => { throw new Error("customer secret"); }))).rejects.toThrow("customer secret");
    const failure = JSON.parse(log.mock.calls.at(-1)![0]);
    expect(failure.completed).toBe(false);
    expect(failure.stages.permissions.failures).toBe(1);
    expect(JSON.stringify(failure)).not.toContain("customer secret");
  });
});
