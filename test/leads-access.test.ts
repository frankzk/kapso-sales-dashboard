vi.mock("@/lib/lead-routing-access", () => import("./helpers/lead-routing-disabled"));
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  getStoreLeadsRead,
  handoffFreshCutoffIso,
  HANDOFF_FRESH_HOURS,
  sortPorLlamar,
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
        for (const method of ["eq", "in", "neq", "order", "not", "lte"]) {
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
    const source = Array.from({ length: 2545 }, (_, index) => ({ id: `lead-${String(index).padStart(4, "0")}` }));
    const { ranges, started, openGate } = mockPagedLeads(source, true);

    const pending = getStoreLeads(["kenku-peru"], "seguimientos", null);
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
    const source = Array.from({ length: 1167 }, (_, index) => ({ id: `lead-${String(index).padStart(4, "0")}` }));
    const { ranges, openGate } = mockPagedLeads(source, false);
    openGate(); // sin total no hay paralelo que valga: se drena en serie

    const rows = await getStoreLeads(["kenku-peru"], "seguimientos", null);

    expect(rows).toHaveLength(1167);
    expect(rows.at(-1)).toEqual({ id: "lead-1166" });
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it("no pide una segunda página cuando la primera ya no está llena", async () => {
    const source = Array.from({ length: 42 }, (_, index) => ({ id: `lead-${String(index).padStart(4, "0")}` }));
    const { ranges, openGate } = mockPagedLeads(source, true);
    openGate();

    const rows = await getStoreLeads(["kenku-peru"], "seguimientos", null);

    expect(rows).toHaveLength(42);
    expect(ranges).toEqual([[0, 999]]);
  });
});

// Owner, 25-11-2026: «es clave el tiempo de carga del sistema». Medido ese día: la lista de «Por llamar» tardaba
// de 2,9 a 9,8 s (el 90 % de la carga de Leads) porque sus 13 páginas iban una detrás de otra. Ahora la cola se
// lee en 16 tramos de ids, de a 8 a la vez. Las filas y el orden son los mismos.
describe("getStoreLeads «Por llamar»: por clave y en tramos de ids a la vez", () => {
  beforeEach(() => {
    createServerSupabaseMock.mockReset();
  });

  type Request = { from: string | null; before: string | null; after: string | null; limit: number; count: boolean; select: string };
  const cut = (digit: string) => `${digit}0000000-0000-0000-0000-000000000000`;
  /** Un id con forma de uuid que empieza con `digit`; `n` lo ordena dentro de su tramo. */
  const uuid = (digit: string, n: number) => `${digit}${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;

  /**
   * Sirve `source` como la base: `gte`/`lt` son los cortes del tramo, `gt` la clave, `limit` el tamaño.
   * Sin rangos ni total. `fail` decide qué lectura devuelve error.
   */
  function mockKeysetLeads(source: { id: string }[], fail: (request: Request) => boolean = () => false) {
    const sorted = [...source].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const requests: Request[] = [];
    let inFlight = 0;
    let peak = 0;
    createServerSupabaseMock.mockResolvedValue({
      from: () => {
        const query: Record<string, unknown> = {};
        const request: Request = { from: null, before: null, after: null, limit: 0, count: false, select: "" };
        query.select = vi.fn((select: string, opts?: { count?: string }) => {
          request.select = select;
          request.count = opts?.count === "exact";
          return query;
        });
        for (const method of ["eq", "in", "neq", "order"]) query[method] = vi.fn(() => query);
        const bound = (key: "from" | "before" | "after") => vi.fn((column: string, value: string) => {
          expect(column).toBe("id");
          request[key] = value;
          return query;
        });
        query.gte = bound("from");
        query.lt = bound("before");
        query.gt = bound("after");
        query.limit = vi.fn(async (n: number) => {
          request.limit = n;
          requests.push(request);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight -= 1;
          if (fail(request)) return { data: null, error: { message: "caído" } };
          const rows = sorted.filter((l) =>
            (request.from === null || l.id >= request.from)
            && (request.before === null || l.id < request.before)
            && (request.after === null || l.id > request.after));
          return { data: rows.slice(0, n), error: null };
        });
        query.range = vi.fn(() => {
          throw new Error("«Por llamar» no pagina por rangos");
        });
        return query;
      },
    });
    return { requests, sorted, peak: () => peak };
  }
  const DIGITS = [..."0123456789abcdef"];

  it("16 tramos, uno por primer dígito del id: el primero sin piso y el último sin techo", async () => {
    const source = DIGITS.flatMap((digit) => Array.from({ length: 40 }, (_, n) => ({ id: uuid(digit, n) })));
    const { requests, sorted } = mockKeysetLeads(source);

    const rows = await getStoreLeads(["kenku-peru"], "por_llamar", null);

    expect(rows.map((l) => l.id)).toEqual(sorted.map((l) => l.id));
    // Una lectura por tramo y nada se cuenta.
    expect(requests).toHaveLength(16);
    expect(requests.every((r) => r.limit === 1000 && !r.count && r.after === null)).toBe(true);
    const bounds = requests.map((r) => [r.from, r.before]).sort((a, b) => String(a[0] ?? "").localeCompare(String(b[0] ?? "")));
    expect(bounds[0]).toEqual([null, cut("1")]);
    expect(bounds[15]).toEqual([cut("f"), null]);
    // Cada tramo empieza donde termina el anterior: ni huecos ni filas repetidas.
    for (let i = 1; i < 16; i += 1) expect(bounds[i]![0]).toBe(bounds[i - 1]![1]);
  });

  it("los tramos van de a ocho a la vez", async () => {
    const source = DIGITS.flatMap((digit) => Array.from({ length: 5 }, (_, n) => ({ id: uuid(digit, n) })));
    const { peak } = mockKeysetLeads(source);
    await getStoreLeads(["kenku-peru"], "por_llamar", null);
    expect(peak()).toBe(8);
  });

  it("un tramo con más de mil sigue por clave dentro de sus cortes", async () => {
    // 2.545 leads en el tramo del «7»; los demás, vacíos.
    const source = Array.from({ length: 2545 }, (_, n) => ({ id: uuid("7", n) }));
    const { requests, sorted } = mockKeysetLeads(source);

    const rows = await getStoreLeads(["kenku-peru"], "por_llamar", null);

    expect(rows.map((l) => l.id)).toEqual(sorted.map((l) => l.id));
    expect(requests.filter((r) => r.from === cut("7") || r.after !== null)).toEqual([
      expect.objectContaining({ from: cut("7"), before: cut("8"), after: null, limit: 1000, count: false }),
      expect.objectContaining({ from: null, before: cut("8"), after: uuid("7", 999), limit: 1000, count: false }),
      expect.objectContaining({ from: null, before: cut("8"), after: uuid("7", 1999), limit: 1000, count: false }),
    ]);
    // 15 tramos de una lectura y uno de tres.
    expect(requests).toHaveLength(18);
  });

  it("un id que no parece uuid no se queda fuera: cae en el primer tramo o en el último", async () => {
    const source = [{ id: "lead-0001" }, { id: "zzz" }, { id: "00" }, { id: "-" }, { id: uuid("3", 1) }];
    const { sorted } = mockKeysetLeads(source);
    const rows = await getStoreLeads(["kenku-peru"], "por_llamar", null);
    expect(rows.map((l) => l.id)).toEqual(sorted.map((l) => l.id));
  });

  it("la cola vacía: una lectura por tramo y lista vacía", async () => {
    const { requests } = mockKeysetLeads([]);
    expect(await getStoreLeads(["kenku-peru"], "por_llamar", null)).toEqual([]);
    expect(requests).toHaveLength(16);
  });

  it("un tramo que falla corta la lista ahí: lo anterior se conserva y lo de después no se pega", async () => {
    const source = DIGITS.flatMap((digit) => Array.from({ length: 3 }, (_, n) => ({ id: uuid(digit, n) })));
    // Falla el tramo del «5».
    const { sorted } = mockKeysetLeads(source, (r) => r.from === cut("5"));
    const rows = await getStoreLeads(["kenku-peru"], "por_llamar", null);
    expect(rows.map((l) => l.id)).toEqual(sorted.filter((l) => l.id < cut("5")).map((l) => l.id));
  });

  it("un tramo que falla en su segunda página conserva la primera y corta ahí", async () => {
    const source = [
      ...Array.from({ length: 4 }, (_, n) => ({ id: uuid("1", n) })),
      ...Array.from({ length: 1200 }, (_, n) => ({ id: uuid("2", n) })),
      ...Array.from({ length: 4 }, (_, n) => ({ id: uuid("9", n) })),
    ];
    const { sorted } = mockKeysetLeads(source, (r) => r.after !== null);
    const rows = await getStoreLeads(["kenku-peru"], "por_llamar", null);
    expect(rows.map((l) => l.id)).toEqual(sorted.filter((l) => l.id <= uuid("2", 999)).map((l) => l.id));
  });

  it("si falla la primera lectura se reintenta todo con las columnas antiguas", async () => {
    const source = DIGITS.flatMap((digit) => Array.from({ length: 2 }, (_, n) => ({ id: uuid(digit, n) })));
    // La base sin la migración: cualquier lectura que pida `cart_count_48h` falla.
    const { requests, sorted } = mockKeysetLeads(source, (r) => r.select.split(",").includes("cart_count_48h"));
    const rows = await getStoreLeads(["kenku-peru"], "por_llamar", null);
    expect(rows.map((l) => l.id)).toEqual(sorted.map((l) => l.id));
    const legacy = requests.filter((r) => !r.select.split(",").includes("cart_count_48h"));
    expect(legacy).toHaveLength(16);
    // Si también fallan las antiguas, la cola sale vacía, como antes.
    mockKeysetLeads(source, () => true);
    expect(await getStoreLeads(["kenku-peru"], "por_llamar", null)).toEqual([]);
  });

  it("con más del tope, la cola son los 20.000 ids más bajos, como antes", async () => {
    // 1.600 por tramo: 25.600 leads.
    const source = DIGITS.flatMap((digit) => Array.from({ length: 1600 }, (_, n) => ({ id: uuid(digit, n) })));
    const { sorted } = mockKeysetLeads(source);
    const rows = await getStoreLeads(["kenku-peru"], "por_llamar", null);
    expect(rows).toHaveLength(20_000);
    expect(rows.map((l) => l.id)).toEqual(sorted.slice(0, 20_000).map((l) => l.id));
  });

  // 27-11-2026: al llegar al tope faltan leads cualesquiera (los ids son al azar), y nadie lo sabía.
  it("la lectura dice si llegó al tope, para que la pantalla lo avise", async () => {
    const full = DIGITS.flatMap((digit) => Array.from({ length: 1600 }, (_, n) => ({ id: uuid(digit, n) })));
    mockKeysetLeads(full);
    const capped = await getStoreLeadsRead(["kenku-peru"], "por_llamar", null);
    expect(capped.capped).toBe(true);
    expect(capped.rows).toHaveLength(20_000);
    const small = DIGITS.flatMap((digit) => Array.from({ length: 40 }, (_, n) => ({ id: uuid(digit, n) })));
    mockKeysetLeads(small);
    const read = await getStoreLeadsRead(["kenku-peru"], "por_llamar", null);
    expect(read).toMatchObject({ capped: false });
    expect(read.rows).toHaveLength(640);
    // `getStoreLeads` sigue devolviendo solo las filas.
    mockKeysetLeads(small);
    expect(await getStoreLeads(["kenku-peru"], "por_llamar", null)).toHaveLength(640);
    expect(await getStoreLeadsRead([], "por_llamar", null)).toEqual({ rows: [], capped: false });
  });
});

describe("«Por llamar» en tramos: lo que no puede cambiar sin querer", () => {
  const src = readFileSync(join(process.cwd(), "lib/leads-access.ts"), "utf8");

  it("ocho tramos a la vez, y la cola sin tope empieza a leerse antes de saber el reparto", () => {
    expect(src).toContain("export const LEAD_DRAIN_CONCURRENCY = 8;");
    expect(src).toContain("const early = limit === null ? drainAll() : null;");
    // El reparto se espera siempre antes de devolver algo: si falla, falla la función.
    expect(src.indexOf("const routing = await routingRead;")).toBeGreaterThan(src.indexOf("const early = limit === null ? drainAll() : null;"));
    expect(src).toContain("const { rows: all, capped } = await (early ?? drainAll());");
    expect(src).toContain("let visible = filterRoutedLeads(all, routing);");
  });

  it("el tope se avisa en la pantalla y en la línea de carga", () => {
    expect(src).toContain("const LEADS_PAGE_CAP = 20_000;");
    expect(src).toContain("return { rows: rows.slice(0, LEADS_PAGE_CAP), firstReadFailed, capped: rows.length >= LEADS_PAGE_CAP };");
    expect(src).toContain("return { rows, capped: rows.length >= LEADS_PAGE_CAP };");
    const page = readFileSync(join(process.cwd(), "app/dashboard/leads/page.tsx"), "utf8");
    expect(page).toContain("queueCapped={queueCapped}");
    const board = readFileSync(join(process.cwd(), "components/leads.tsx"), "utf8");
    // El texto dice el mismo número que el tope.
    expect(board).toContain("Esta vista pasó de 20.000 leads: algunos no aparecen en la lista ni en los conteos.");
    expect(board).toContain("{queueCapped && (");
  });

  it("el MOM dice cómo se lee la cola y que nada cambia para la asesora", () => {
    const mom = readFileSync(join(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8").replace(/\s+/g, " ");
    for (const text of [
      "**La cola de «Por llamar» se lee en tramos a la vez (25-11-2026, owner: «es clave el tiempo de carga del sistema»).**",
      "Ahora la cola se lee en 16 tramos, de a 8 a la vez",
      "No cambia qué leads salen, en qué orden, ni el reparto",
    ]) expect(mom).toContain(text);
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

    const snapshot = await getLeadQueueSnapshot(["kenku-peru"]);

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
      return (await getLeadQueueSnapshot(["kenku-peru"])).signature;
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
        for (const method of ["select", "eq", "in", "neq", "gte", "lte", "not", "is", "or"]) {
          query[method] = vi.fn(() => query);
        }
        // El `await` de la consulta: cada una devuelve su conteo, en orden.
        query.then = (resolve: (value: { count: number }) => unknown) =>
          Promise.resolve({ count: counts[call++] ?? 0 }).then(resolve);
        return query;
      },
    });

    const snapshot = await getLeadQueueSnapshot(["kenku-peru"]);

    expect(snapshot.counts.por_llamar).toBe(1295);
    expect(snapshot.counts.sin_llamar).toBe(1250);
    expect(snapshot.signature.startsWith("legacy:")).toBe(true);
  });
});

describe("sortPorLlamar", () => {
  it("ordena como lo hacía la base: atención primero, interacción más reciente, id", () => {
    const rows = [
      { id: "b", needs_attention: false, last_interaction_at: "2026-10-01T10:00:00Z" },
      { id: "a", needs_attention: false, last_interaction_at: "2026-10-01T10:00:00Z" },
      { id: "c", needs_attention: true, last_interaction_at: "2026-09-01T10:00:00Z" },
      { id: "d", needs_attention: false, last_interaction_at: "2026-10-02T10:00:00Z" },
      { id: "e", needs_attention: false, last_interaction_at: null },
    ];
    // DESC deja los nulos primero, como Postgres.
    expect(sortPorLlamar(rows).map((r) => r.id)).toEqual(["c", "e", "d", "a", "b"]);
  });

  it("la base ya no ordena las filas anchas de «Por llamar»: solo pagina por id", () => {
    const src = readFileSync(join(process.cwd(), "lib/leads-access.ts"), "utf8");
    const porLlamar = src.slice(src.indexOf('case "por_llamar":'), src.indexOf('case "handoff":'));
    expect(porLlamar).toContain('.order("id", { ascending: true })');
    expect(porLlamar).not.toContain('.order("needs_attention"');
    expect(porLlamar).not.toContain('.order("last_interaction_at"');
  });
});
