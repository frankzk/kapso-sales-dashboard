// Comprobantes electrónicos por RUC — la ruta del barrido
// (app/api/cron/invoices/route.ts, MOM §35).
//
// El barrido en sí se prueba en test/invoicing-server.test.ts. Aquí se fija la
// puerta: quién puede llamarlo, que fuera de producción no emita (un preview no
// manda boletas a SUNAT), que ?dry=1 sirva en cualquier lado, que el cron se
// vea rojo si algo falló, y la línea de log sin datos de clientas. También que
// vercel.json lo corra cada 10 minutos sin caer en el minuto de otro barrido,
// que sin la 0257 o la 0260 aplicadas todo el camino responda 200 sin lanzar
// (pero que otra tabla que falta lo ponga rojo), que una lista de candidatos
// llena se vea en la línea de log, y que un RUC en «Manual» (owner, 15-10-2026)
// se barra como simulación y se vea así en la línea de log.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvoiceSweepReport } from "@/lib/invoicing/server";

const mocks = vi.hoisted(() => ({
  admin: { soy: "admin" } as unknown,
  report: null as unknown,
  throws: null as Error | null,
  /** Corre el barrido de verdad (con la base que diga `admin`). */
  real: false,
}));

vi.mock("@/lib/db", () => ({ createAdminSupabase: vi.fn(() => mocks.admin) }));
vi.mock("@/lib/invoicing/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/invoicing/server")>();
  return {
    ...actual,
    runInvoiceSweep: vi.fn(async (...args: Parameters<typeof actual.runInvoiceSweep>) => {
      if (mocks.real) return actual.runInvoiceSweep(...args);
      if (mocks.throws) throw mocks.throws;
      return mocks.report;
    }),
  };
});

import { GET, POST, dynamic, maxDuration, runtime } from "@/app/api/cron/invoices/route";
import { runInvoiceSweep } from "@/lib/invoicing/server";

const STORE = "6f1c2a3b-9d8e-4f00-a1b2-c3d4e5f60718";

function report(over: Partial<InvoiceSweepReport> = {}): InvoiceSweepReport {
  return {
    dry: false,
    at: "2026-10-14T20:00:00.000Z",
    orgs: [
      {
        orgId: "org-gf",
        stores: 2,
        candidates: 3,
        lleno: {},
        cached: 0,
        reasons: { pago_sin_cuenta: 1 },
        issuers: [
          {
            issuerId: "iss-gf",
            ruc: "20556792829",
            mode: "real",
            simuladas: 0,
            emitidas: 2,
            en_duda: 0,
            errores: 0,
            conciliadas: 0,
            would_claim: 0,
            pendientes: 0,
            reasons: {},
            stopped: null,
          },
        ],
      },
    ],
    errors: [],
    ...over,
  };
}

const req = (q = "", auth: string | null = "Bearer cron") =>
  new NextRequest(`https://kapta.test/api/cron/invoices${q}`, { headers: auth ? { authorization: auth } : {} });

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron");
  vi.stubEnv("VERCEL_ENV", "production");
  mocks.admin = { soy: "admin" };
  mocks.report = report();
  mocks.throws = null;
  mocks.real = false;
  vi.mocked(runInvoiceSweep).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("/api/cron/invoices", () => {
  it("corre en Node, sin caché y con 60 s, por GET y por POST", () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
    expect(maxDuration).toBe(60);
    expect(POST).toBe(GET);
  });

  it("sin el secreto del cron: 401 y no barre", async () => {
    expect((await GET(req("", null))).status).toBe(401);
    expect((await GET(req("", "Bearer otro"))).status).toBe(401);
    expect(runInvoiceSweep).not.toHaveBeenCalled();
  });

  it("acepta el secreto interno por cabecera", async () => {
    const res = await GET(
      new NextRequest("https://kapta.test/api/cron/invoices", { headers: { "x-internal-secret": "cron" } }),
    );
    expect(res.status).toBe(200);
  });

  it("fuera de producción no emite (sin ?dry=1): ni siquiera llama al barrido", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "not_production" });
    expect(runInvoiceSweep).not.toHaveBeenCalled();
  });

  it("?dry=1 corre fuera de producción, en modo prueba", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    mocks.report = report({ dry: true });
    const res = await GET(req("?dry=1"));
    expect(res.status).toBe(200);
    expect(runInvoiceSweep).toHaveBeenCalledWith(mocks.admin, { dry: true });
    expect(await res.json()).toMatchObject({ ok: true, dry: true });
  });

  it("en producción barre de verdad", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(runInvoiceSweep).toHaveBeenCalledWith(mocks.admin, { dry: false });
    expect(await res.json()).toMatchObject({ ok: true, dry: false, orgs: [{ orgId: "org-gf" }], errors: [] });
  });

  it("?storeId: solo un uuid, y llega al barrido", async () => {
    expect((await GET(req(`?storeId=${STORE}`))).status).toBe(200);
    expect(runInvoiceSweep).toHaveBeenLastCalledWith(mocks.admin, { dry: false, storeId: STORE });

    vi.mocked(runInvoiceSweep).mockClear();
    for (const bad of ["abc", "1%20or%201%3D1", `${STORE}x`, ""]) {
      const res = await GET(req(`?storeId=${bad}`));
      expect(res.status, bad).toBe(400);
    }
    expect(runInvoiceSweep).not.toHaveBeenCalled();
  });

  it("si el reporte trae errores, responde 502: el cron se ve rojo", async () => {
    mocks.report = report({ errors: ["RUC 20556792829 apagado: Token rechazado (401)."] });
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, errors: ["RUC 20556792829 apagado: Token rechazado (401)."] });
  });

  it("si el barrido lanza, responde 500 sin celulares en el mensaje", async () => {
    mocks.throws = new Error("se cayó leyendo 987654321");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await GET(req());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false });
    expect(body.error).not.toContain("987654321");
    expect(JSON.stringify(log.mock.calls)).not.toContain("987654321");
  });

  it("deja UNA línea de log con el reporte (Vercel no guarda la respuesta del cron)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await GET(req());
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    expect(line.startsWith("[invoices] ")).toBe(true);
    expect(JSON.parse(line.slice("[invoices] ".length))).toEqual(mocks.report);
  });
});

/** Las tablas de la 0257. */
const TABLAS_0257 = new Set(["invoice_issuers", "order_invoices", "invoice_order_checks"]);

type Result = { data: unknown; error: unknown };

/** Una consulta encadenable que ignora los filtros y contesta `result`. */
function chainOf(result: Result): Record<string, unknown> {
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
        }
        if (prop === "maybeSingle" || prop === "single") {
          return async () => ({ ...result, data: Array.isArray(result.data) ? (result.data[0] ?? null) : result.data });
        }
        return () => chain;
      },
    },
  );
  return chain;
}

/** Lo que contesta la base cuando algo no existe, con su nombre (como Postgres y PostgREST). */
function noExiste(code: "42P01" | "PGRST205", name: string): Result {
  const message =
    code === "42P01" ? `relation "public.${name}" does not exist` : `Could not find the table 'public.${name}' in the schema cache`;
  return { data: null, error: { code, message } };
}

/**
 * Una base de mentira: cada tabla y cada función contesta lo que diga `tables`
 * y `rpcs` (si no dice nada, vacío). Anota qué se pidió.
 */
function fakeAdmin(tables: Record<string, Result>, rpcs: Record<string, Result> = {}) {
  const calls: string[] = [];
  const rpcArgs: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    rpcArgs,
    admin: {
      from: (table: string) => {
        calls.push(table);
        return chainOf(tables[table] ?? { data: [], error: null });
      },
      rpc: async (fn: string, args: Record<string, unknown> = {}) => {
        calls.push(`rpc:${fn}`);
        rpcArgs.push({ fn, args });
        return rpcs[fn] ?? { data: [], error: null };
      },
    },
  };
}

/**
 * Una base sin la 0257: cada tabla y cada función de comprobantes contesta que
 * no existe, con el código de Postgres o el de PostgREST y su nombre en el
 * mensaje. Lo demás (la tienda de ?storeId) existe como siempre.
 */
function sinMigracion(code: "42P01" | "PGRST205") {
  const tables: Record<string, Result> = { stores: { data: [{ id: STORE, org_id: "org-gf" }], error: null } };
  for (const t of TABLAS_0257) tables[t] = noExiste(code, t);
  const rpcs: Record<string, Result> = {};
  for (const fn of ["invoice_candidates", "invoice_claim"]) {
    rpcs[fn] = {
      data: null,
      error:
        code === "42P01"
          ? { code: "42883", message: `function public.${fn}() does not exist` }
          : { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` },
    };
  }
  return fakeAdmin(tables, rpcs);
}

/** Una base CON la 0257: un RUC de GRUPO GF en real y una tienda activa. */
function conLa0257(over: { tables?: Record<string, Result>; rpcs?: Record<string, Result> } = {}) {
  return fakeAdmin(
    {
      stores: { data: [{ id: STORE, org_id: "org-gf" }], error: null },
      invoice_issuers: {
        data: [
          {
            id: "iss-gf",
            org_id: "org-gf",
            ruc: "20556792829",
            legal_name: "GRUPO GF S.A.C.",
            mode: "real",
            emit_from: "2026-10-14T05:00:00.000Z",
            daily_limit: 40,
            checked_ruc: "20556792829",
          },
        ],
        error: null,
      },
      ...over.tables,
    },
    over.rpcs,
  );
}

describe("/api/cron/invoices sin la 0257 o la 0260 aplicadas", () => {
  it.each(["42P01", "PGRST205"] as const)("%s: 200, `sin_migracion`, sin errores y una sola línea de log", async (code) => {
    for (const q of ["", "?dry=1", `?storeId=${STORE}`]) {
      const db = sinMigracion(code);
      mocks.admin = db.admin;
      mocks.real = true;
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await GET(req(q));
      expect(res.status, q).toBe(200);
      const body = await res.json();
      expect(body, q).toMatchObject({ ok: true, skipped: "sin_migracion", errors: [] });
      expect(log).toHaveBeenCalledTimes(1);
      expect(err).not.toHaveBeenCalled();
      // Se detiene en la primera tabla de comprobantes: ni candidatos ni turno.
      expect(db.calls.filter((c) => c.startsWith("rpc:"))).toEqual([]);
      log.mockRestore();
      err.mockRestore();
    }
  });

  it.each(["42883", "PGRST202"] as const)(
    "con la 0257 y sin la 0260 (%s), con un RUC en simulación: 200, `sin_migracion`, y ni simula ni pide el turno",
    async (code) => {
      // Como producción el 15-10-2026: la 0257 aplicada, un RUC en simulación,
      // y sin `invoice_candidates`, que la trae la 0260.
      const message =
        code === "42883"
          ? "function public.invoice_candidates(uuid, text, timestamp with time zone, integer, text[], uuid) does not exist"
          : "Could not find the function public.invoice_candidates(p_blocked, p_limit, p_mode, p_org, p_since, p_store) in the schema cache";
      for (const q of ["", "?dry=1"]) {
        const db = conLa0257({
          tables: {
            invoice_issuers: {
              data: [
                {
                  id: "iss-gf",
                  org_id: "org-gf",
                  ruc: "20556792829",
                  legal_name: "GRUPO GF S.A.C.",
                  mode: "simulacion",
                  emit_from: "2026-10-14T05:00:00.000Z",
                  daily_limit: 40,
                  checked_ruc: null,
                },
              ],
              error: null,
            },
          },
          rpcs: { invoice_candidates: { data: null, error: { code, message } } },
        });
        mocks.admin = db.admin;
        mocks.real = true;
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        const res = await GET(req(q));
        expect(res.status, q).toBe(200);
        expect(await res.json(), q).toMatchObject({ ok: true, skipped: "sin_migracion", errors: [] });
        expect(log, q).toHaveBeenCalledTimes(1);
        expect(err, q).not.toHaveBeenCalled();
        // Pidió la lista y, sin ella, no siguió: sin turno no hay boleta, ni simulada.
        expect(db.calls.filter((c) => c.startsWith("rpc:")), q).toEqual(["rpc:invoice_candidates"]);
        log.mockRestore();
        err.mockRestore();
      }
    },
  );

  it.each(["42P01", "PGRST205"] as const)(
    "%s de una tabla que NO es de la 0257: no es `sin_migracion`, el cron se ve rojo",
    async (code) => {
      // La 0257 está; lo que falta es `orders`, de mucho antes.
      const db = conLa0257({
        tables: { orders: noExiste(code, "orders") },
        rpcs: { invoice_candidates: { data: [{ order_id: "ord-1" }], error: null } },
      });
      mocks.admin = db.admin;
      mocks.real = true;
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const res = await GET(req());
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.skipped).toBeUndefined();
      expect(body.errors.join(" ")).toMatch(/orders/);
      expect(log).toHaveBeenCalledTimes(1);
      expect(db.calls).not.toContain("rpc:invoice_claim");
    },
  );

  it("si invoice_candidates dice que falta order_master, el cron se ve rojo", async () => {
    const db = conLa0257({
      rpcs: { invoice_candidates: { data: null, error: { code: "42P01", message: 'relation "order_master" does not exist' } } },
    });
    mocks.admin = db.admin;
    mocks.real = true;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, errors: [expect.stringMatching(/order_master/)] });
  });

  it("si algo del camino lanza «falta una migración» igual responde 200", async () => {
    const { InvoiceMigrationMissingError } = await import("@/lib/invoicing/server");
    mocks.throws = new InvoiceMigrationMissingError("invoice_issuers");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, dry: false, skipped: "sin_migracion" });
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("/api/cron/invoices: una lista de candidatos llena", () => {
  it("se ve en la línea de log (`lleno`), sin poner el cron rojo", async () => {
    const { INVOICE_SWEEP_MAX_CANDIDATES } = await import("@/lib/invoicing/server");
    // Pedidos que la base devuelve pero que ya no existen al leerlos: nada se
    // emite, y la lista vino con exactamente el límite.
    const lista = Array.from({ length: INVOICE_SWEEP_MAX_CANDIDATES }, (_, i) => ({ order_id: `ord-${i}` }));
    const db = conLa0257({ rpcs: { invoice_candidates: { data: lista, error: null } } });
    mocks.admin = db.admin;
    mocks.real = true;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    expect(line).toContain('"lleno":{"real":true}');
    const logged = JSON.parse(line.slice("[invoices] ".length)) as InvoiceSweepReport;
    expect(logged.orgs[0]).toMatchObject({ orgId: "org-gf", candidates: INVOICE_SWEEP_MAX_CANDIDATES, lleno: { real: true } });
    expect(logged.errors).toEqual([]);
    expect(db.calls).not.toContain("rpc:invoice_claim");
  });

  it("una lista de uno menos no está llena", async () => {
    const { INVOICE_SWEEP_MAX_CANDIDATES } = await import("@/lib/invoicing/server");
    const lista = Array.from({ length: INVOICE_SWEEP_MAX_CANDIDATES - 1 }, (_, i) => ({ order_id: `ord-${i}` }));
    mocks.admin = conLa0257({ rpcs: { invoice_candidates: { data: lista, error: null } } }).admin;
    mocks.real = true;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await GET(req());
    expect(String(log.mock.calls[0]![0])).toContain('"lleno":{}');
  });
});

describe("vercel.json: el barrido de comprobantes", () => {
  const crons = (
    JSON.parse(readFileSync(resolve(__dirname, "../vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] }
  ).crons;

  it("corre cada 10 minutos, en los minutos 6, 16, 26, 36, 46 y 56", () => {
    expect(crons).toContainEqual({ path: "/api/cron/invoices", schedule: "6,16,26,36,46,56 * * * *" });
  });

  it("no cae en el minuto de ningún barrido que corre cada hora o más seguido", () => {
    // Un minuto compartido con el sync (cada 5) o con el recálculo del Master
    // pelea por la misma base y mezcla los logs.
    // Cada parte del minuto: `*`, `*/n`, `a-b`, `a-b/n` o un número.
    const minutesOf = (schedule: string): number[] => {
      const [minute, hour] = schedule.split(" ");
      if (hour !== "*" && !hour!.startsWith("*/")) return [];
      const out: number[] = [];
      for (const part of minute!.split(",")) {
        const [range, stepText] = part.split("/");
        const step = stepText === undefined ? 1 : Number(stepText);
        const [from, to] =
          range === "*" ? [0, 59] : range!.includes("-") ? range!.split("-").map(Number) : [Number(range), stepText ? 59 : Number(range)];
        expect(Number.isInteger(step) && step > 0 && Number.isInteger(from) && Number.isInteger(to), `${schedule}`).toBe(true);
        for (let m = from!; m <= to!; m += step) out.push(m);
      }
      return out;
    };
    expect(minutesOf("1-59/2 * * * *")).toHaveLength(30);
    expect(minutesOf("*/5 * * * *")).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(minutesOf("4,14 * * * *")).toEqual([4, 14]);
    const mine = new Set(minutesOf("6,16,26,36,46,56 * * * *"));
    for (const c of crons.filter((x) => x.path !== "/api/cron/invoices")) {
      for (const m of minutesOf(c.schedule)) expect(mine.has(m), `${c.path} en el minuto ${m}`).toBe(false);
    }
  });
});

describe("/api/cron/invoices: un RUC en «Manual»", () => {
  it("se barre (no es `sin_ruc_encendido`): pide la lista de simulación, y la línea de log dice `manual`", async () => {
    const db = conLa0257({
      tables: {
        invoice_issuers: {
          data: [
            {
              id: "iss-gf",
              org_id: "org-gf",
              ruc: "20556792829",
              legal_name: "GRUPO GF S.A.C.",
              mode: "manual",
              emit_from: "2026-10-14T05:00:00.000Z",
              daily_limit: 40,
              checked_ruc: "20556792829",
            },
          ],
          error: null,
        },
      },
      // Un pedido que ya no existe al leerlo: nada llega a Shopify ni a SimpleFact.
      rpcs: { invoice_candidates: { data: [{ order_id: "ord-1" }], error: null } },
    });
    mocks.admin = db.admin;
    mocks.real = true;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBeUndefined();
    expect(body.orgs[0].issuers[0]).toMatchObject({ issuerId: "iss-gf", mode: "manual", simuladas: 0, emitidas: 0 });
    // La única lista que pide es la de simulación: el barrido no emite por un RUC en «Manual».
    expect(db.rpcArgs.filter((r) => r.fn === "invoice_candidates").map((r) => r.args.p_mode)).toEqual(["simulacion"]);
    expect(db.calls).not.toContain("rpc:invoice_claim");
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain('"mode":"manual"');
  });
});
