type Stage = "authorize" | "db.lead" | "db.credentials" | "db.history" | "db.outbox" | "db.labels" | "db.cart" | "permissions"
  | "shopify.history" | "kapso.discovery" | "kapso.transcript" | "kapso.older" | "kapso.http" | "shopify.http";
type Timing = { count: number; totalMs: number; maxMs: number; failures: number };

/** Request-local diagnostics. Never receives/logs lead ids, URLs, credentials,
 * request bodies, responses or exception messages. Parallel stage totals may
 * overlap; durationMs is the actual elapsed wall time, not their sum. */
export class LeadReadTiming {
  private stages: Partial<Record<Stage, Timing>> = {};
  private httpStatuses: Partial<Record<"kapso" | "shopify", Record<number, number>>> = {};

  private record(stage: Stage, started: number, failed: boolean) {
    const ms = performance.now() - started;
    const current = this.stages[stage] ?? { count: 0, totalMs: 0, maxMs: 0, failures: 0 };
    current.count++;
    current.totalMs += ms;
    current.maxMs = Math.max(current.maxMs, ms);
    current.failures += Number(failed);
    this.stages[stage] = current;
  }

  async time<T>(stage: Stage, work: () => PromiseLike<T>): Promise<T> {
    const started = performance.now();
    let failed = true;
    try {
      const result = await work();
      failed = false;
      return result;
    } finally {
      this.record(stage, started, failed);
    }
  }

  /** Measures headers/HTTP attempts (including provider retries); the enclosing
   * provider stage also covers body parsing, pagination and retry backoff. */
  fetch(provider: "kapso" | "shopify", implementation: typeof fetch = fetch): typeof fetch {
    return async (input, init) => {
      const started = performance.now();
      let status = 0;
      let failed = true;
      try {
        const response = await implementation(input, init);
        status = response.status;
        failed = !response.ok;
        return response;
      } finally {
        const statuses = this.httpStatuses[provider] ?? {};
        statuses[status] = (statuses[status] ?? 0) + 1;
        this.httpStatuses[provider] = statuses;
        this.record(`${provider}.http`, started, failed);
      }
    };
  }

  snapshot() {
    return {
      stages: Object.fromEntries(Object.entries(this.stages).map(([key, value]) => [key, {
        ...value, totalMs: Math.round(value.totalMs), maxMs: Math.round(value.maxMs),
      }])),
      httpStatuses: this.httpStatuses,
    };
  }
}

export async function measureLeadRead<T>(
  operation: "history" | "chat",
  mode: "history" | "first_paint" | "selected_thread" | "active_poll",
  work: (timing: LeadReadTiming) => Promise<T>,
): Promise<T> {
  const timing = new LeadReadTiming();
  const started = performance.now();
  let completed = false;
  try {
    const result = await work(timing);
    completed = true;
    return result;
  } finally {
    console.info(JSON.stringify({
      event: "leads.read.trace", operation, mode, completed,
      durationMs: Math.round(performance.now() - started),
      ...timing.snapshot(),
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? "local",
    }));
  }
}
