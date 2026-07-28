import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerSupabaseMock } = vi.hoisted(() => ({
  createServerSupabaseMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  createServerSupabase: createServerSupabaseMock,
}));

import {
  getLeadQueueSnapshot,
  getStoreLeads,
  handoffFreshCutoffIso,
  HANDOFF_FRESH_HOURS,
} from "@/lib/leads-access";

describe("handoffFreshCutoffIso (frescura de la cola Atender ahora)", () => {
  it("devuelve now − HANDOFF_FRESH_HOURS en ISO (borde compartido vista/cron)", () => {
    const now = Date.parse("2026-07-22T12:00:00.000Z");
    expect(handoffFreshCutoffIso(now)).toBe("2026-07-21T12:00:00.000Z");
    expect(handoffFreshCutoffIso(now)).toBe(new Date(now - HANDOFF_FRESH_HOURS * 3_600_000).toISOString());
    expect(HANDOFF_FRESH_HOURS).toBe(24);
  });
});

describe("getStoreLeads pagination", () => {
  beforeEach(() => {
    createServerSupabaseMock.mockReset();
  });

  /** Supabase de mentira que sirve `source` por rangos. `withCount` decide si la
   *  primera página devuelve el total (lo que permite pedir el resto a la vez). */
  function mockPagedLeads(source: { id: string }[], withCount: boolean) {
    const ranges: Array<[number, number]> = [];
    const started: number[] = [];
    let resolveGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });

    createServerSupabaseMock.mockResolvedValue({
      from: () => {
        const query: Record<string, unknown> = {};
        let wantsCount = false;
        query.select = vi.fn((_select: string, opts?: { count?: string }) => {
          wantsCount = opts?.count === "exact";
          return query;
        });
        for (const method of ["eq", "in", "neq", "order"]) {
          query[method] = vi.fn(() => query);
        }
        query.range = vi.fn(async (from: number, to: number) => {
          ranges.push([from, to]);
          started.push(from);
          // Las páginas que NO son la primera esperan a una compuerta común: si
          // el código las pidiera en serie, la segunda nunca llegaría a empezar
          // y la prueba se colgaría. Que todas lleguen prueba el paralelismo.
          if (from > 0) await gate;
          return {
            data: source.slice(from, to + 1),
            error: null,
            ...(wantsCount && withCount ? { count: source.length } : {}),
          };
        });
        return query;
      },
    });

    return { ranges, started, openGate: () => resolveGate?.() };
  }

  it("pide las páginas que faltan A LA VEZ cuando el servidor da el total", async () => {
    const source = Array.from({ length: 2545 }, (_, index) => ({ id: `lead-${index}` }));
    const { ranges, started, openGate } = mockPagedLeads(source, true);

    const pending = getStoreLeads("kenku-peru", "por_llamar", null);
    // Deja correr el microtask de la primera página y suelta a las siguientes.
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    openGate();
    const rows = await pending;

    expect(rows).toHaveLength(2545);
    expect(rows.at(-1)).toEqual({ id: "lead-2544" });
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
    // Las dos páginas restantes arrancaron antes de que ninguna terminara.
    expect(started.slice(1)).toEqual([1000, 2000]);
  });

  it("drains every PostgREST page for the complete call queue (servidor sin total)", async () => {
    const source = Array.from({ length: 1167 }, (_, index) => ({ id: `lead-${index}` }));
    const { ranges, openGate } = mockPagedLeads(source, false);
    openGate(); // sin total no hay paralelo que valga: se drena en serie

    const rows = await getStoreLeads("kenku-peru", "por_llamar", null);

    expect(rows).toHaveLength(1167);
    expect(rows.at(-1)).toEqual({ id: "lead-1166" });
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it("no pide una segunda página cuando la primera ya no está llena", async () => {
    const source = Array.from({ length: 42 }, (_, index) => ({ id: `lead-${index}` }));
    const { ranges, openGate } = mockPagedLeads(source, true);
    openGate();

    const rows = await getStoreLeads("kenku-peru", "por_llamar", null);

    expect(rows).toHaveLength(42);
    expect(ranges).toEqual([[0, 999]]);
  });
});

describe("getLeadQueueSnapshot", () => {
  beforeEach(() => {
    createServerSupabaseMock.mockReset();
  });

  it("saca los siete conteos y la firma de una sola llamada", async () => {
    const rpc = vi.fn(() => ({
      maybeSingle: async () => ({
        data: {
          por_llamar: 1295,
          handoff: 1,
          yape: 3,
          seguimientos: 12,
          ganados: 240,
          perdidos: 88,
          sin_llamar: 1250,
          total: 2545,
          last_change: "2026-07-27T16:34:00.000Z",
        },
        error: null,
      }),
    }));
    createServerSupabaseMock.mockResolvedValue({ rpc, from: () => ({}) });

    const snapshot = await getLeadQueueSnapshot("kenku-peru");

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(snapshot.counts).toEqual({
      por_llamar: 1295,
      handoff: 1,
      yape: 3,
      seguimientos: 12,
      ganados: 240,
      perdidos: 88,
      sin_llamar: 1250,
    });
    expect(snapshot.signature).toBe("2545:2026-07-27T16:34:00.000Z");
  });

  it("la firma cambia cuando se toca un lead, y NO cuando no pasa nada", async () => {
    const snapshotWith = async (total: number, lastChange: string) => {
      createServerSupabaseMock.mockResolvedValue({
        rpc: () => ({
          maybeSingle: async () => ({
            data: {
              por_llamar: 1,
              handoff: 0,
              yape: 0,
              seguimientos: 0,
              ganados: 0,
              perdidos: 0,
              sin_llamar: 1,
              total,
              last_change: lastChange,
            },
            error: null,
          }),
        }),
        from: () => ({}),
      });
      return (await getLeadQueueSnapshot("kenku-peru")).signature;
    };

    const base = await snapshotWith(10, "2026-07-27T16:00:00.000Z");
    expect(await snapshotWith(10, "2026-07-27T16:00:00.000Z")).toBe(base); // nada nuevo → no se recarga
    expect(await snapshotWith(10, "2026-07-27T16:05:00.000Z")).not.toBe(base); // un lead editado
    expect(await snapshotWith(11, "2026-07-27T16:00:00.000Z")).not.toBe(base); // un lead nuevo
  });

  it("si falta la migración 0059, cae a los siete conteos en vez de dejar las pestañas en cero", async () => {
    const counts = [1295, 1, 3, 12, 240, 88, 1250];
    let call = 0;
    createServerSupabaseMock.mockResolvedValue({
      rpc: () => ({
        maybeSingle: async () => ({
          data: null,
          error: { message: 'function public.lead_queue_counts does not exist' },
        }),
      }),
      from: () => {
        const query: Record<string, unknown> = {};
        for (const method of ["select", "eq", "in", "neq", "gte", "lte", "not"]) {
          query[method] = vi.fn(() => query);
        }
        // El `await` de la consulta: cada una devuelve su conteo, en orden.
        query.then = (resolve: (value: { count: number }) => unknown) =>
          Promise.resolve({ count: counts[call++] ?? 0 }).then(resolve);
        return query;
      },
    });

    const snapshot = await getLeadQueueSnapshot("kenku-peru");

    expect(snapshot.counts.por_llamar).toBe(1295);
    expect(snapshot.counts.sin_llamar).toBe(1250);
    expect(snapshot.signature.startsWith("legacy:")).toBe(true);
  });
});
