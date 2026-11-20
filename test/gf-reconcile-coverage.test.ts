// gf-reconcile relee TODAS las guías GF vivas, aunque sean más de las que caben en una pasada (MOM §29.17). El 20-11-2026
// había justo 300 vivas y la pasada leía `.limit(300)`: una guía de más no se releía nunca. Aquí corre la ruta de verdad
// contra una tabla `shipments` en memoria y un reloj falso (cada lectura de GF tarda 1 s). Datos FICTICIOS.
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GF_LIVE_PAGE, GF_READ_BUDGET_MS, stalestFirst, type LiveGfGuide } from "@/lib/gf-reconcile-live";

const READ_MS = 1_000;
const PER_RUN = Math.ceil(GF_READ_BUDGET_MS / READ_MS);
const CRON_EVERY_MS = 20 * 60_000;

type Row = LiveGfGuide & { courier: string; delivery_status: string };
const db = vi.hoisted(() => ({
  shipments: [] as Row[],
  notes: new Map<string, string | null>(),
  noToken: new Set<string>(),
  shipmentQueries: 0,
  reads: [] as { guide: string; elapsed: number }[],
  runStartedAt: 0,
}));

const admin = {
  from(table: string) {
    const f = { eq: [] as [string, unknown][], in: [] as [string, unknown[]][], gt: [] as [string, string][], order: null as string | null, limit: Infinity };
    const run = () => {
      if (table === "gf_order_requests") return { data: [], error: null };
      if (table === "orders") {
        const ids = (f.in[0]?.[1] ?? []) as string[];
        return { data: ids.filter((id) => db.notes.has(id)).map((id) => ({ id, shopify_note: db.notes.get(id) })), error: null };
      }
      if (table !== "shipments") throw new Error(`tabla inesperada: ${table}`);
      db.shipmentQueries++;
      let rows = db.shipments.filter((r) => {
        const rec = r as unknown as Record<string, unknown>;
        return f.eq.every(([c, v]) => rec[c] === v) && f.in.every(([c, v]) => v.includes(rec[c])) && f.gt.every(([c, v]) => String(rec[c]) > v);
      });
      if (f.order) { const k = f.order as keyof Row; rows = [...rows].sort((a, b) => (String(a[k]) < String(b[k]) ? -1 : 1)); }
      return { data: rows.slice(0, f.limit).map(({ id, store_id, guide_code, order_id, api_report_at }) => ({ id, store_id, guide_code, order_id, api_report_at })), error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q, lt: () => q,
      eq: (c: string, v: unknown) => (f.eq.push([c, v]), q),
      in: (c: string, v: unknown[]) => (f.in.push([c, v]), q),
      gt: (c: string, v: string) => (f.gt.push([c, v]), q),
      order: (c: string) => ((f.order = c), q),
      limit: (n: number) => ((f.limit = n), q),
      then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve().then(run).then(ok, ko),
    };
    return q;
  },
};

vi.mock("@/lib/db", () => ({ createAdminSupabase: () => admin }));
vi.mock("@/lib/gf-courier-guide", () => ({
  loadGfStore: vi.fn(async (_admin: unknown, storeId: string) => ({ enabled: true, token: db.noToken.has(storeId) ? null : "tok", webhookSecret: null })),
  createGfGuideFor: vi.fn(),
  syncGfNoteFor: vi.fn(async () => "sent"),
}));
vi.mock("@/lib/gf-courier", () => ({
  gfCourier: {
    findByExternalId: vi.fn(),
    getOrder: vi.fn(async (_opts: unknown, guide: string) => {
      db.reads.push({ guide, elapsed: Date.now() - db.runStartedAt });
      vi.setSystemTime(Date.now() + READ_MS);
      return { ok: true, data: { tracking_id: guide, status: { code: "CREATED", sub_status: null, final: false }, observations: null } };
    }),
  },
}));
// Como la de verdad, cada lectura sella `api_report_at` de su salida.
vi.mock("@/lib/gf-courier-track", () => ({
  GF_COURIER: "gf_courier",
  applyGfSnapshot: vi.fn(async (order: { tracking_id: string }) => {
    const row = db.shipments.find((r) => r.guide_code === order.tracking_id)!;
    row.api_report_at = new Date().toISOString();
    return { ok: true, outcome: "unchanged", shipmentId: row.id, orderId: row.order_id };
  }),
}));

const { GET, maxDuration } = await import("@/app/api/cron/gf-reconcile/route");
const { syncGfNoteFor } = await import("@/lib/gf-courier-guide");

type Report = { live: number; refreshed: number; remaining: number; skipped: number; notes: number; errors: string[] };
async function cronRun(): Promise<Report> {
  db.reads = [];
  db.runStartedAt = Date.now();
  const res = await GET(new NextRequest("https://kapta.test/api/cron/gf-reconcile", { headers: { authorization: "Bearer cron" } }));
  expect(res.status).toBe(200);
  vi.setSystemTime(db.runStartedAt + CRON_EVERY_MS);
  return (await res.json()) as Report;
}

const pad = (n: number) => String(n).padStart(12, "0");
const guide = (n: number, over: Partial<Row> = {}): Row => ({
  id: `10000000-0000-4000-8000-${pad(n)}`, store_id: "store-kenku", guide_code: `KENKU-KP${900000 + n}`,
  order_id: `20000000-0000-4000-8000-${pad(n)}`, api_report_at: null, courier: "gf_courier",
  delivery_status: n % 3 ? "pendiente" : "en_ruta", ...over,
});
const NOW = new Date("2026-11-20T18:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("CRON_SECRET", "cron");
  db.shipments = []; db.notes = new Map(); db.noToken = new Set(); db.shipmentQueries = 0;
  vi.mocked(syncGfNoteFor).mockClear();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("gf-reconcile: todas las guías vivas, la leída hace más tiempo primero", () => {
  it("con 450 vivas lee primero las que la pasada vieja nunca alcanzaba; en dos pasadas las relee todas", async () => {
    // Las 300 que leía `.limit(300)` (leídas hace 20 min) y 150 más que nunca se releían (ids más altos, sin lectura).
    const readEarlier = new Date(NOW.getTime() - CRON_EVERY_MS).toISOString();
    db.shipments = [
      ...Array.from({ length: 300 }, (_, i) => guide(i, { api_report_at: readEarlier })),
      ...Array.from({ length: 150 }, (_, i) => guide(300 + i)),
      guide(999, { delivery_status: "entregado" }), // no está viva: no se lee
    ];
    const neverRead = db.shipments.slice(300, 450).map((r) => r.guide_code);

    const first = await cronRun();
    expect(first).toMatchObject({ live: 450, refreshed: PER_RUN, remaining: 450 - PER_RUN, skipped: 0, errors: [] });
    expect(db.reads.slice(0, 150).map((r) => r.guide)).toEqual(neverRead);
    expect(Math.max(...db.reads.map((r) => r.elapsed))).toBeLessThan(GF_READ_BUDGET_MS);
    const readFirst = new Set(db.reads.map((r) => r.guide));

    const second = await cronRun();
    expect(second).toMatchObject({ live: 450, refreshed: PER_RUN, remaining: 450 - PER_RUN });
    // Las que faltaron en la primera van primero en la segunda.
    const missed = db.shipments.filter((r) => r.delivery_status !== "entregado" && !readFirst.has(r.guide_code!)).map((r) => r.guide_code!);
    expect(missed).toHaveLength(450 - PER_RUN);
    expect(db.reads.slice(0, missed.length).map((r) => r.guide).sort()).toEqual([...missed].sort());
    const covered = new Set([...readFirst, ...db.reads.map((r) => r.guide)]);
    expect(covered.size).toBe(450);
    expect(db.shipments.find((r) => r.guide_code === "KENKU-KP900999")!.api_report_at).toBeNull();
  });

  it("pagina más allá de las 1000 filas de PostgREST y, pasada a pasada, ninguna guía se queda sin releer", async () => {
    const total = GF_LIVE_PAGE + 250;
    db.shipments = Array.from({ length: total }, (_, i) => guide(i));
    const seen = new Set<string>();
    let runs = 0;
    while (seen.size < total) {
      const report = await cronRun();
      runs++;
      expect(report.live).toBe(total);
      expect(report.refreshed + report.remaining + report.skipped).toBe(total);
      for (const r of db.reads) seen.add(r.guide);
      expect(runs).toBeLessThanOrEqual(Math.ceil(total / PER_RUN));
    }
    expect(runs).toBe(Math.ceil(total / PER_RUN));
    expect(db.shipmentQueries).toBe(2 * runs); // dos páginas por pasada
  });

  it("sin guía o sin token de la tienda no se lee: cuenta como skipped, no como remaining", async () => {
    db.noToken.add("store-sin-token");
    db.shipments = [
      ...Array.from({ length: 10 }, (_, i) => guide(i)),
      ...Array.from({ length: 4 }, (_, i) => guide(10 + i, { store_id: "store-sin-token" })),
      guide(20, { guide_code: null }),
    ];
    expect(await cronRun()).toMatchObject({ live: 15, refreshed: 10, remaining: 0, skipped: 5 });
    expect(db.reads).toHaveLength(10);
  });

  it("las notas siguen con su tope por pasada", async () => {
    db.shipments = Array.from({ length: 450 }, (_, i) => guide(i));
    for (const r of db.shipments) db.notes.set(r.order_id!, "CNF - ALEXIS");
    const report = await cronRun();
    expect(report.refreshed).toBeGreaterThan(120);
    expect(report.notes).toBe(120);
    expect(syncGfNoteFor).toHaveBeenCalledTimes(120);
  });

  it("el presupuesto deja margen para la lectura más lenta dentro de maxDuration", () => {
    // 20 s de timeout de GF al leer + 20 s al mandar la nota + la base.
    expect(GF_READ_BUDGET_MS + 2 * 20_000 + 10_000).toBeLessThanOrEqual(maxDuration * 1000);
  });

  it("stalestFirst: sin lectura primero, luego la más vieja; a igual sello, por id", () => {
    const g = (id: string, at: string | null): LiveGfGuide => ({ id, store_id: "s", guide_code: id, order_id: null, api_report_at: at });
    const order = stalestFirst([g("c", "2026-11-20T10:00:00Z"), g("b", null), g("d", "2026-11-19T10:00:00Z"), g("a", null), g("e", "no es fecha")]);
    expect(order.map((x) => x.id)).toEqual(["a", "b", "e", "d", "c"]);
  });
});
