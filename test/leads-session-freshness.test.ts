// Owner, 18-11-2026: a las 08:50 la pestaña de Leads mandó ~10 lecturas a la vez
// con la sesión vencida y cada una la renovó en el servidor (10 renovaciones,
// `AuthRefreshDiscardedError`, una lectura sin usuario). Ahora la pestaña la
// renueva una sola vez antes de leer, y eso nunca deja nada cargando.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
vi.mock("@/lib/supabase-browser", () => ({ createBrowserSupabase: () => ({ auth: { getSession } }) }));

const { ensureFreshSession, readLeadData, SESSION_FRESHNESS_TIMEOUT_MS } = await import("@/lib/leads-read-client");

describe("la sesión se renueva una vez antes de las lecturas", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    getSession.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("10 lecturas que salen juntas esperan UNA renovación", async () => {
    let release!: () => void;
    getSession.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ data: { session: null } }); }));
    const reads = Array.from({ length: 10 }, () => readLeadData("listYapeAlerts", []));
    await Promise.resolve();
    await Promise.resolve();
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    release();
    await Promise.all(reads);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(10);
  });

  it("la siguiente tanda vuelve a mirar la sesión", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    await ensureFreshSession();
    await ensureFreshSession();
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it("si la renovación falla, la lectura sale igual", async () => {
    getSession.mockRejectedValue(new Error("sin red"));
    await expect(readLeadData("listYapeAlerts", [])).resolves.toEqual({ ok: true });
  });

  it("si la renovación se cuelga, la lectura sale a los 3 s", async () => {
    vi.useFakeTimers();
    getSession.mockImplementation(() => new Promise(() => {}));
    const read = readLeadData("listYapeAlerts", []);
    await vi.advanceTimersByTimeAsync(SESSION_FRESHNESS_TIMEOUT_MS - 1);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(read).resolves.toEqual({ ok: true });
    expect(SESSION_FRESHNESS_TIMEOUT_MS).toBe(3_000);
  });

  it("una lectura cancelada mientras espera la sesión no sale", async () => {
    let release!: () => void;
    getSession.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ data: { session: null } }); }));
    const abort = new AbortController();
    const read = readLeadData("searchLeads", [["store"], "99"], abort.signal);
    await Promise.resolve();
    await Promise.resolve();
    abort.abort();
    release();
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("en el servidor no espera nada: la lectura sale en el mismo instante", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    expect(ensureFreshSession()).toBeNull();
    void readLeadData("listYapeAlerts", []);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getSession).not.toHaveBeenCalled();
  });
});
