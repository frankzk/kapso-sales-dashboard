// SERVER ONLY. Opt-in timing, with fixed labels and no customer/request data.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setSupabaseFetchObserver } from "@/lib/db-fetch";

const SCOPES = ["master.page", "master.detail"] as const;
const PHASES = [
  "access", "counts", "rows", "facets", "agency", "confirmation_due", "confirmation_cycle",
] as const;

export type ServerPerformanceScope = (typeof SCOPES)[number];
export type ServerPerformancePhase = (typeof PHASES)[number];
type Outcome = "ok" | "error";
type PhaseTiming = {
  phase: ServerPerformancePhase | "other";
  offsetMs: number;
  durationMs: number;
  outcome: Outcome;
};
type ScopeState = {
  requestId: string;
  scope: ServerPerformanceScope | "other";
  startedAt: number;
  phases: PhaseTiming[];
  droppedPhases: number;
  dbHttpRequests: number;
  finished: boolean;
};
type PerformanceContext = { state: ScopeState; phase?: PhaseTiming["phase"] };

const context = new AsyncLocalStorage<PerformanceContext>();
const MAX_PHASES = 200;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const enabled = () => process.env.KAPSO_SERVER_PERFORMANCE === "1";
const milliseconds = (duration: number) => Math.round(Math.max(0, duration) * 100) / 100;

function emit(record: Record<string, unknown>) {
  try {
    console.info("[kapso-server-performance]", JSON.stringify(record));
  } catch {
    // Observability must never replace the application's result or error.
  }
}

/** A fresh, ephemeral id per invocation; never reuse an auth/request/customer id. */
export function withServerPerformance<T>(
  scope: ServerPerformanceScope,
  fn: () => Promise<T>,
): Promise<T> {
  if (!enabled()) return fn();
  setSupabaseFetchObserver(observedSupabaseFetch);
  const state: ScopeState = {
    requestId: randomUUID(),
    scope: (SCOPES as readonly string[]).includes(scope) ? scope : "other",
    startedAt: performance.now(),
    phases: [],
    droppedPhases: 0,
    dbHttpRequests: 0,
    finished: false,
  };
  return context.run({ state }, async () => {
    let outcome: Outcome = "ok";
    try {
      return await fn();
    } catch (error) {
      outcome = "error";
      throw error;
    } finally {
      state.finished = true;
      emit({
        kind: "scope",
        requestId: state.requestId,
        scope: state.scope,
        // Wall time, not the sum of possibly overlapping phases or HTTP calls.
        durationMs: milliseconds(performance.now() - state.startedAt),
        outcome,
        phases: state.phases,
        droppedPhases: state.droppedPhases,
        dbHttpRequests: state.dbHttpRequests,
      });
    }
  });
}

/** Fixed application phases preserve attribution through parallel promises. */
export function measureServerOperation<T>(
  phase: ServerPerformancePhase,
  fn: () => Promise<T>,
): Promise<T> {
  if (!enabled()) return fn();
  const parent = context.getStore();
  if (!parent || parent.state.finished) return fn();
  const state = parent.state;
  const safePhase = (PHASES as readonly string[]).includes(phase) ? phase : "other";
  const startedAt = performance.now();
  return context.run({ state, phase: safePhase }, async () => {
    let outcome: Outcome = "ok";
    try {
      return await fn();
    } catch (error) {
      outcome = "error";
      throw error;
    } finally {
      if (!state.finished) {
        if (state.phases.length < MAX_PHASES) {
          state.phases.push({
            phase: safePhase,
            offsetMs: milliseconds(startedAt - state.startedAt),
            durationMs: milliseconds(performance.now() - startedAt),
            outcome,
          });
        } else {
          state.droppedPhases++;
        }
      }
    }
  });
}

function httpOperation(input: RequestInfo | URL, init?: RequestInit): string | null {
  try {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const category = url.pathname.startsWith("/auth/v1/") ? "auth"
      : url.pathname.startsWith("/rest/v1/rpc/") ? "rpc"
      : url.pathname.startsWith("/rest/v1/") ? "rest" : null;
    if (!category) return null;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    // No URL, table/function name, filter, body, header or external request id.
    return `${category}.${METHODS.has(method) ? method.toLowerCase() : "other"}`;
  } catch {
    return null;
  }
}

/**
 * Supabase auth/REST transport time until response headers, NOT PostgreSQL time
 * or body-download time. Never clone/read the response to measure its size.
 * The supplied fetch and its arguments/result/error keep their original shape.
 */
export function instrumentSupabaseFetch(
  fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
): typeof fetch {
  return (input, init) => {
    if (!enabled()) return fetcher(input, init);
    const current = context.getStore();
    if (!current || current.state.finished) return fetcher(input, init);
    const operation = httpOperation(input, init);
    if (!operation) return fetcher(input, init);
    const { state, phase } = current;
    const startedAt = performance.now();
    state.dbHttpRequests++;
    return (async () => {
      let status: number | null = null;
      let contentLengthBytes: number | undefined;
      let outcome: Outcome = "error";
      let headersAt: number | undefined;
      try {
        const response = await fetcher(input, init);
        headersAt = performance.now();
        status = response.status;
        outcome = response.ok ? "ok" : "error";
        const length = response.headers.get("content-length");
        if (length !== null && /^\d+$/.test(length)) {
          const bytes = Number(length);
          if (Number.isSafeInteger(bytes)) contentLengthBytes = bytes;
        }
        return response;
      } finally {
        if (!state.finished) {
          emit({
            kind: "db_http",
            requestId: state.requestId,
            scope: state.scope,
            ...(phase ? { phase } : {}),
            operation,
            status,
            outcome,
            offsetMs: milliseconds(startedAt - state.startedAt),
            durationMs: milliseconds((headersAt ?? performance.now()) - startedAt),
            ...(contentLengthBytes !== undefined ? { contentLengthBytes } : {}),
          });
        }
      }
    })();
  };
}

// Dependency direction matters: Node instrumentation installs itself into the
// transport bridge, while db.ts never imports this module into client graphs.
const observedSupabaseFetch = instrumentSupabaseFetch();
