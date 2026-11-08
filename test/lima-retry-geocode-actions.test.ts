// El interruptor «Usar la ubicación por dirección (Google) si el pedido no
// tiene» de los reintentos de Lima y el botón «Medir la ubicación por
// dirección en Lima» (MOM §9.5 entrega 3 y §40; 0308, owner 05-11-2026).
// Encender exige la clave y que la última medición de Lima cumpla B con el
// edificio; apagar se puede siempre. Cada cambio queda en «Últimos cambios».

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  allowed: true,
  key: "k",
  latest: null as null | Row,
  settings: null as null | Row,
  upserts: [] as Row[],
  events: [] as Row[],
  measured: [] as Row[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => ({ id: "owner-1" }) }));
vi.mock("@/lib/permissions-access", () => ({ hasOrgPermission: async (_org: string, perm: string) => h.allowed && perm === "automations.manage" }));
vi.mock("@/lib/env", () => ({ env: { googleGeocodingApiKey: () => h.key } }));
vi.mock("@/lib/lima-retry-auto-server", () => ({ runLimaRetryAuto: async () => ({}) }));
vi.mock("@/lib/geocode-google-server", () => ({
  latestGeocodeLimaRun: async () => h.latest,
  runGeocodeLimaMeasure: async (_admin: unknown, opts: Row) => {
    h.measured.push(opts);
    return { ok: true, summary: { sampled: 1 }, saveError: null };
  },
}));
vi.mock("@/lib/db", () => ({
  createAdminSupabase: () => ({
    from: (table: string) => {
      const q: Row = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => ({ data: table === "lima_retry_auto_settings" ? h.settings : null, error: null });
      q.upsert = async (row: Row) => {
        h.upserts.push({ table, row });
        return { error: null };
      };
      q.insert = async (row: Row) => {
        if (table === "automation_switch_events") h.events.push(row);
        return { error: null };
      };
      q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: "s1" }, { id: "s2" }], error: null }).then(res);
      return q;
    },
  }),
}));

import { measureLimaGeocodeNow, setRetryGeocode } from "@/app/dashboard/automatizaciones/actions";

const ORG = "11111111-1111-4111-8111-111111111111";
const MEETS_B = { at: "2026-11-05T15:00:00Z", summary: { ranAt: "x", sampled: 150, passed: 70, rooftop: 40, rooftopWithin300Pct: 92.5 } };

const previousEnv = process.env.VERCEL_ENV;
beforeEach(() => {
  process.env.VERCEL_ENV = "production";
  h.allowed = true;
  h.key = "k";
  h.latest = null;
  h.settings = { org_id: ORG, daily_cap: 10, geocode_enabled: false };
  h.upserts = [];
  h.events = [];
  h.measured = [];
});
afterEach(() => {
  process.env.VERCEL_ENV = previousEnv;
});

describe("setRetryGeocode", () => {
  it("sin medición de Lima no se enciende, y lo dice", async () => {
    expect(await setRetryGeocode(ORG, true)).toEqual({ error: expect.stringContaining("Todavía no hay una medición de Lima") });
    expect(h.upserts).toEqual([]);
  });

  it("con pocos puntos ROOFTOP o por debajo del 90 %, tampoco", async () => {
    h.latest = { ...MEETS_B, summary: { ...MEETS_B.summary, rooftop: 12 } };
    expect((await setRetryGeocode(ORG, true)).error).toContain("hacen falta al menos 15");
    // La primera medición de Lima (08-11-2026, 17 con el edificio, 100 % a 300 m) ya deja encender.
    h.latest = { ...MEETS_B, summary: { ...MEETS_B.summary, rooftop: 17, rooftopWithin300Pct: 100 } };
    expect((await setRetryGeocode(ORG, true)).error).toBeUndefined();
    h.upserts = [];
    h.latest = { ...MEETS_B, summary: { ...MEETS_B.summary, rooftopWithin300Pct: 84.5 } };
    expect((await setRetryGeocode(ORG, true)).error).toContain("hace falta el 90 %");
    expect(h.upserts).toEqual([]);
  });

  it("sin la clave de Google no se enciende", async () => {
    h.key = "";
    h.latest = MEETS_B;
    expect((await setRetryGeocode(ORG, true)).error).toContain("GOOGLE_GEOCODING_API_KEY");
  });

  it("con la medición que cumple B se enciende y queda en «Últimos cambios»", async () => {
    h.latest = MEETS_B;
    expect(await setRetryGeocode(ORG, true)).toEqual({ notice: "Ubicación por dirección (Google) en los reintentos: encendida." });
    expect(h.upserts).toEqual([{ table: "lima_retry_auto_settings", row: expect.objectContaining({ org_id: ORG, geocode_enabled: true, updated_by: "owner-1" }) }]);
    expect(h.events).toEqual([{ org_id: ORG, store_id: null, automation: "lima_retry_geocode", previous: "apagado", next: "encendido", actor: "owner-1" }]);
  });

  it("apagar se puede siempre, aunque no haya medición", async () => {
    h.settings = { org_id: ORG, daily_cap: 10, geocode_enabled: true };
    expect(await setRetryGeocode(ORG, false)).toEqual({ notice: "Ubicación por dirección (Google) en los reintentos: apagada." });
    expect(h.upserts[0]!.row).toMatchObject({ geocode_enabled: false });
  });

  it("sin automations.manage o fuera de producción, nada", async () => {
    h.latest = MEETS_B;
    h.allowed = false;
    expect((await setRetryGeocode(ORG, true)).error).toContain("Tu acceso no permite");
    h.allowed = true;
    process.env.VERCEL_ENV = "preview";
    expect(await setRetryGeocode(ORG, true)).toEqual({ error: "Disponible solo en producción." });
    expect(h.upserts).toEqual([]);
  });
});

describe("measureLimaGeocodeNow", () => {
  it("mide con las tiendas activas de la organización, y sin clave no llama a nada", async () => {
    expect(await measureLimaGeocodeNow(ORG)).toEqual({ summary: { sampled: 1 }, notice: undefined });
    expect(h.measured).toEqual([expect.objectContaining({ orgId: ORG, storeIds: ["s1", "s2"], key: "k", actor: "owner-1" })]);
    h.key = "";
    expect((await measureLimaGeocodeNow(ORG)).error).toContain("GOOGLE_GEOCODING_API_KEY");
    expect(h.measured).toHaveLength(1);
  });
});
