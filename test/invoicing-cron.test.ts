// Comprobantes electrónicos por RUC — la ruta del barrido
// (app/api/cron/invoices/route.ts, MOM §35).
//
// El barrido en sí se prueba en test/invoicing-server.test.ts. Aquí se fija la
// puerta: quién puede llamarlo, que fuera de producción no emita (un preview no
// manda boletas a SUNAT), que ?dry=1 sirva en cualquier lado, que el cron se
// vea rojo si algo falló, y la línea de log sin datos de clientas. También que
// vercel.json lo corra cada 10 minutos sin caer en el minuto de otro barrido.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvoiceSweepReport } from "@/lib/invoicing/server";

const mocks = vi.hoisted(() => ({
  admin: { soy: "admin" },
  report: null as unknown,
  throws: null as Error | null,
}));

vi.mock("@/lib/db", () => ({ createAdminSupabase: vi.fn(() => mocks.admin) }));
vi.mock("@/lib/invoicing/server", () => ({
  runInvoiceSweep: vi.fn(async () => {
    if (mocks.throws) throw mocks.throws;
    return mocks.report;
  }),
}));

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
  mocks.report = report();
  mocks.throws = null;
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
    const minutesOf = (schedule: string): number[] => {
      const [minute, hour] = schedule.split(" ");
      if (hour !== "*" && !hour!.startsWith("*/")) return [];
      if (minute === "*") return Array.from({ length: 60 }, (_, i) => i);
      if (minute!.startsWith("*/")) {
        const step = Number(minute!.slice(2));
        return Array.from({ length: 60 / step }, (_, i) => i * step);
      }
      return minute!.split(",").map(Number);
    };
    const mine = new Set(minutesOf("6,16,26,36,46,56 * * * *"));
    for (const c of crons.filter((x) => x.path !== "/api/cron/invoices")) {
      for (const m of minutesOf(c.schedule)) expect(mine.has(m), `${c.path} en el minuto ${m}`).toBe(false);
    }
  });
});
