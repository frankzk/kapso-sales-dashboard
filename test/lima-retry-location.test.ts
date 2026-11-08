// La ubicación del reintento Aliclik de Lima (MOM §9.5): una sola regla para
// la pasada automática y para «Aprobar» de Repro Lima (owner, 08-11-2026:
// «mismo candado»). `locateRetryOrder` y `retryGeocodeKeyForStore`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  key: "k" as string | null,
  latest: null as unknown,
  geo: (() => ({ kind: "ok", lat: -12.1, lng: -77.0 })) as (order: Row) => unknown,
  geocoded: [] as Row[],
  googlePins: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: { googleGeocodingApiKey: () => h.key } }));
vi.mock("@/lib/geocode-google-server", () => ({
  geocodeOrderAddress: async (_admin: unknown, order: Row, opts: Row) => {
    h.geocoded.push({ ...order, key: opts.key });
    return h.geo(order);
  },
  latestGeocodeLimaRun: async () => h.latest,
  googlePinnedOrderIds: async (_admin: unknown, rows: Row[]) => new Set(rows.filter((r) => h.googlePins.includes(String(r.order_id))).map((r) => r.order_id)),
}));

import { locateRetryOrder, retryGeocodeKeyForStore } from "@/lib/lima-retry-location";
import { retryApproveNoLocation } from "@/lib/lima-retry-auto";

const MEETS_B = { at: "2026-11-05T15:00:00Z", summary: { ranAt: "2026-11-05T15:00:00Z", sampled: 120, passed: 60, rooftop: 40, rooftopWithin300Pct: 95, rejections: {} } };
const FAILS_B = { at: "2026-11-05T15:00:00Z", summary: { ranAt: "2026-11-05T15:00:00Z", sampled: 120, passed: 60, rooftop: 40, rooftopWithin300Pct: 70, rejections: {} } };

function admin(tables: Record<string, Row[]>) {
  return {
    from: (table: string) => {
      const filters: Array<(r: Row) => boolean> = [];
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
        maybeSingle: async () => ({ data: (tables[table] ?? []).find((r) => filters.every((f) => f(r))) ?? null, error: null }),
      };
      return q;
    },
  } as never;
}

const noPin = { order_id: "o1", store_id: "s1", coverage: "lima", latitude: null, longitude: null, address: "Av. Arequipa 123", district: "Lince", province: "Lima", region: "Lima" };

beforeEach(() => {
  h.key = "k";
  h.latest = MEETS_B;
  h.geo = () => ({ kind: "ok", lat: -12.1, lng: -77.0 });
  h.geocoded = [];
  h.googlePins = [];
});

describe("la clave de Google para «Aprobar»", () => {
  const db = (enabled: boolean | null) => admin({
    stores: [{ id: "s1", org_id: "org" }],
    lima_retry_auto_settings: enabled == null ? [] : [{ org_id: "org", daily_cap: 5, geocode_enabled: enabled }],
  });
  it("solo con el interruptor encendido, la clave y la medición de Lima cumpliendo B", async () => {
    expect(await retryGeocodeKeyForStore(db(true), "s1")).toBe("k");
    expect(await retryGeocodeKeyForStore(db(false), "s1")).toBeNull();
    // Sin fila (producción el 08-11-2026): apagado.
    expect(await retryGeocodeKeyForStore(db(null), "s1")).toBeNull();
    h.latest = FAILS_B;
    expect(await retryGeocodeKeyForStore(db(true), "s1")).toBeNull();
    h.latest = null; // Lima nunca medida
    expect(await retryGeocodeKeyForStore(db(true), "s1")).toBeNull();
    h.latest = MEETS_B;
    h.key = null;
    expect(await retryGeocodeKeyForStore(db(true), "s1")).toBeNull();
  });
});

describe("con qué coordenada se cotiza", () => {
  it("el pin del pedido tal cual; sin pin, el edificio en Google; sin clave, «apagado»", async () => {
    expect((await locateRetryOrder(admin({}), { ...noPin, latitude: -12.1, longitude: -77.0 }, "k")).located).toEqual({ coordinate: null });
    expect(h.geocoded).toEqual([]);
    const found = await locateRetryOrder(admin({}), noPin, "k");
    expect(found).toEqual({ located: { coordinate: { value: "-12.1, -77", source: "google" } }, lookedUp: true, quotaHit: false });
    expect(h.geocoded[0]).toMatchObject({ order_id: "o1", address: "Av. Arequipa 123", key: "k" });
    expect((await locateRetryOrder(admin({}), noPin, null)).located).toEqual({ miss: "apagado" });
  });
  it("el pin que puso Google pasa por el mismo candado", async () => {
    h.googlePins = ["o1"];
    const pinned = { ...noPin, latitude: -12.1, longitude: -77.0, geo_source: "courier" };
    expect((await locateRetryOrder(admin({}), pinned, null)).located).toEqual({ miss: "apagado" });
    expect((await locateRetryOrder(admin({}), pinned, "k")).located).toMatchObject({ coordinate: { source: "google" } });
  });
  it("sin edificio, sin calle o sin cupo dice por qué; con el cupo agotado no se pregunta", async () => {
    h.geo = () => ({ kind: "rejected" });
    expect((await locateRetryOrder(admin({}), noPin, "k")).located).toEqual({ miss: "sin_edificio" });
    h.geo = () => ({ kind: "unavailable", reason: "sin_direccion" });
    expect((await locateRetryOrder(admin({}), noPin, "k")).located).toEqual({ miss: "sin_direccion" });
    h.geo = () => ({ kind: "unavailable", reason: "sin_cupo" });
    expect(await locateRetryOrder(admin({}), noPin, "k")).toEqual({ located: { miss: "sin_cupo" }, lookedUp: true, quotaHit: true });
    h.geocoded = [];
    expect((await locateRetryOrder(admin({}), noPin, "k", { quotaHit: true })).located).toEqual({ miss: "sin_cupo" });
    expect(h.geocoded).toEqual([]);
    // Fuera de Lima no se busca.
    expect((await locateRetryOrder(admin({}), { ...noPin, coverage: "provincia_cod" }, "k")).located).toEqual({ miss: "apagado" });
  });
});

describe("«Aprobar» de Repro Lima", () => {
  it("dice por qué no hay coordenada, en corto y con qué hacer", () => {
    expect(retryApproveNoLocation("apagado")).toBe("Sin coordenada: la ubicación por dirección (Google) está apagada o Lima no está medida (Automatizaciones). Para crearla, pega el enlace de Google Maps de la clienta en la ficha del pedido («Corregir ubicación»).");
    expect(retryApproveNoLocation("sin_edificio")).toContain("Google no dio el edificio");
    expect(retryApproveNoLocation("sin_cupo")).toContain("Vuelve a aprobar mañana");
  });
  it("busca la ubicación con la regla de la pasada antes de cotizar, y pasa el punto de Google al núcleo", () => {
    const manual = readFileSync(resolve(process.cwd(), "app/dashboard/pedidos/repro-lima/retry-actions.ts"), "utf8");
    const approve = manual.slice(manual.indexOf("export async function approveAliclikRetry"));
    const order = [
      "if (!chain.ready)",
      "const where = await locateRetryOrder(admin, row, await retryGeocodeKeyForStore(admin, row.store_id));",
      'if ("miss" in where.located) return { error: retryApproveNoLocation(where.located.miss) };',
      "actor: { userId: who.userId }, ...(coordinate ? { coordinate } : {}),",
    ].map((t) => approve.indexOf(t));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    // La pasada usa la misma función.
    const server = readFileSync(resolve(process.cwd(), "lib/lima-retry-auto-server.ts"), "utf8");
    expect(server).toContain("await locateRetryOrder(admin, c.row, geocodeKey, { quotaHit: report.geocode.quotaHit })");
  });
});
