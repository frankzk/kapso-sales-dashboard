import { describe, expect, it, vi } from "vitest";
import { createScanQueue } from "@/lib/scan-queue";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

describe("scan queue under slow responses", () => {
  it("accepts a burst immediately and confirms all scans once, in order", async () => {
    const first = gate();
    const pending = vi.fn();
    const queue = createScanQueue(pending);
    const saved: number[] = [];
    let running = 0;
    let maxRunning = 0;
    for (let code = 0; code < 25; code++) {
      expect(queue.enqueue({ key: `box:office:${code}`, onError: vi.fn(), run: async () => {
        running++; maxRunning = Math.max(maxRunning, running);
        await first.promise;
        saved.push(code);
        running--;
      } })).toBe(true);
    }
    expect(queue.pending).toBe(25);
    expect(saved).toEqual([]);
    expect(pending).toHaveBeenLastCalledWith(25);
    first.resolve();
    await flush();
    expect(saved).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(maxRunning).toBe(1);
    expect(queue.pending).toBe(0);
    expect(pending).toHaveBeenLastCalledWith(0);
  });

  it("suppresses duplicates in flight and waiting but allows a later explicit retry", async () => {
    const first = gate();
    const queue = createScanQueue(vi.fn());
    const run = vi.fn(() => first.promise);
    const job = { key: "box:code", run, onError: vi.fn() };
    expect(queue.enqueue(job)).toBe(true);
    expect(queue.enqueue(job)).toBe(false);
    expect(queue.pending).toBe(1);
    first.resolve(); await flush();
    expect(queue.enqueue(job)).toBe(true);
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reports a failed save and continues with the remaining codes", async () => {
    const queue = createScanQueue(vi.fn());
    const failed = vi.fn();
    const saved = vi.fn();
    const error = new Error("connection lost");
    queue.enqueue({ key: "A", run: async () => { throw error; }, onError: failed });
    queue.enqueue({ key: "B", run: async () => { saved(); }, onError: vi.fn() });
    await flush();
    expect(failed).toHaveBeenCalledWith(error);
    expect(saved).toHaveBeenCalledOnce();
    expect(queue.pending).toBe(0);
  });

  it("each queued scan keeps its own box and mode captured at read time", async () => {
    const first = gate();
    const queue = createScanQueue(vi.fn());
    const saved: string[] = [];
    function capture(box: string, mode: string) {
      return queue.enqueue({ key: `${box}:${mode}:same-code`, onError: vi.fn(), run: async () => {
        await first.promise; saved.push(`${box}:${mode}`);
      } });
    }
    capture("roy", "office"); capture("yhoni", "office"); capture("roy", "pickup");
    first.resolve(); await flush();
    expect(saved).toEqual(["roy:office", "yhoni:office", "roy:pickup"]);
  });
});
