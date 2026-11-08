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
  chatby: { status: "sin_conversacion" } as Record<string, unknown>,
  chatbyCalls: [] as Row[],
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

vi.mock("@/lib/chatby-api", () => ({
  fetchChatbyConversation: async (input: Row) => {
    h.chatbyCalls.push(input);
    return h.chatby;
  },
}));

import { locateRetryOrder, retryGeocodeKeyForStore } from "@/lib/lima-retry-location";
import { retryApproveNoLocation } from "@/lib/lima-retry-auto";

const MEETS_B = { at: "2026-11-05T15:00:00Z", summary: { ranAt: "2026-11-05T15:00:00Z", sampled: 120, passed: 60, rooftop: 40, rooftopWithin300Pct: 95, rejections: {} } };
const FAILS_B = { at: "2026-11-05T15:00:00Z", summary: { ranAt: "2026-11-05T15:00:00Z", sampled: 120, passed: 60, rooftop: 40, rooftopWithin300Pct: 70, rejections: {} } };

function admin(tables: Record<string, Row[]>) {
  return {
    from: (table: string) => {
      const filters: Array<(r: Row) => boolean> = [];
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
        neq: (k: string, v: unknown) => { filters.push((r) => r[k] !== v); return q; },
        gt: (k: string, v: string) => { filters.push((r) => String(r[k]) > v); return q; },
        lte: (k: string, v: string) => { filters.push((r) => String(r[k]) <= v); return q; },
        limit: () => q,
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve),
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
  h.chatby = { status: "sin_conversacion" };
  h.chatbyCalls = [];
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

describe("la ubicación que la clienta ya mandó por WhatsApp (08-11-2026)", () => {
  const withPhone = { ...noPin, customer_phone: "987654321", order_created_at: "2026-11-01T15:00:00Z" };
  const chatbyRead = { apiKey: "ck" };
  const pinAt = (at: string, lat = -12.08, lng = -77.04) => ({
    status: "ok", userNs: "u1", name: "Ana", inboxUrl: "x",
    messages: [
      { kind: "bot", location: null, at: "2026-11-01T15:01:00Z" },
      { kind: "cliente", location: { lat, lng }, at },
    ],
  });
  it("antes de Google: su último pin de esta compra, sin mandarle nada", async () => {
    h.chatby = pinAt("2026-11-01T16:00:00Z");
    const found = await locateRetryOrder(admin({}), withPhone, "k", { chatby: chatbyRead });
    expect(found).toEqual({ located: { coordinate: { value: "-12.08, -77.04", source: "chatby" } }, lookedUp: false, quotaHit: false });
    expect(h.chatbyCalls).toEqual([{ phone: "987654321", apiKey: "ck", fetchImpl: undefined }]);
    expect(h.geocoded).toEqual([]);
  });
  it("el pin del pedido manda; sin clave de Chatby no se lee", async () => {
    h.chatby = pinAt("2026-11-01T16:00:00Z");
    expect((await locateRetryOrder(admin({}), { ...withPhone, latitude: -12.1, longitude: -77.0 }, "k", { chatby: chatbyRead })).located).toEqual({ coordinate: null });
    await locateRetryOrder(admin({}), withPhone, "k");
    expect(h.chatbyCalls).toEqual([]);
  });
  it("un pin de antes de esta compra (más de 3 días antes) no vale: sigue Google", async () => {
    h.chatby = pinAt("2026-10-20T16:00:00Z");
    expect((await locateRetryOrder(admin({}), withPhone, "k", { chatby: chatbyRead })).located).toMatchObject({ coordinate: { source: "google" } });
  });
  it("si el mismo celular tiene otro pedido creado entre este y el pin, el pin puede ser del otro: no se usa", async () => {
    h.chatby = pinAt("2026-11-05T16:00:00Z");
    const db = admin({ order_master: [{ order_id: "o2", customer_phone: "987654321", order_created_at: "2026-11-04T10:00:00Z" }] });
    expect((await locateRetryOrder(db, withPhone, "k", { chatby: chatbyRead })).located).toMatchObject({ coordinate: { source: "google" } });
    // Salvo que Kapta le haya pedido la ubicación para ESTE pedido antes del pin (0324).
    const asked = admin({
      order_master: [{ order_id: "o2", customer_phone: "987654321", order_created_at: "2026-11-04T10:00:00Z" }],
      order_events: [{ order_id: "o1", kind: "chatby_message", occurred_at: "2026-11-05T15:00:00Z", payload: { auto: true, purpose: "reintento_lima_ubicacion" } }],
    });
    expect((await locateRetryOrder(asked, withPhone, "k", { chatby: chatbyRead })).located).toMatchObject({ coordinate: { source: "chatby" } });
    // Un mensaje de otra cosa, o pedido después del pin, no cuenta.
    const other = admin({
      order_master: [{ order_id: "o2", customer_phone: "987654321", order_created_at: "2026-11-04T10:00:00Z" }],
      order_events: [
        { order_id: "o1", kind: "chatby_message", occurred_at: "2026-11-05T15:00:00Z", payload: { auto: true, purpose: "pedir_ubicacion" } },
        { order_id: "o1", kind: "chatby_message", occurred_at: "2026-11-05T17:00:00Z", payload: { auto: true, purpose: "reintento_lima_ubicacion" } },
      ],
    });
    expect((await locateRetryOrder(other, withPhone, "k", { chatby: chatbyRead })).located).toMatchObject({ coordinate: { source: "google" } });
    // Un pedido de mucho después del pin no lo hace dudoso.
    const later = admin({ order_master: [{ order_id: "o3", customer_phone: "987654321", order_created_at: "2026-11-20T10:00:00Z" }] });
    expect((await locateRetryOrder(later, withPhone, "k", { chatby: chatbyRead })).located).toMatchObject({ coordinate: { source: "chatby" } });
  });
  it("sin conversación o con Chatby fallando, sigue Google o dice por qué", async () => {
    h.chatby = { status: "error", message: "x", inboxUrl: null };
    expect((await locateRetryOrder(admin({}), withPhone, null, { chatby: chatbyRead })).located).toEqual({ miss: "apagado" });
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
      "const where = await locateRetryOrder(admin, row, await retryGeocodeKeyForStore(admin, row.store_id), {",
      "chatby: chatbyApiKey ? { apiKey: chatbyApiKey } : null,",
      'if ("miss" in where.located) return { error: retryApproveNoLocation(where.located.miss) };',
      "actor: { userId: who.userId }, ...(coordinate ? { coordinate } : {}),",
    ].map((t) => approve.indexOf(t));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    // La pasada usa la misma función.
    const server = readFileSync(resolve(process.cwd(), "lib/lima-retry-auto-server.ts"), "utf8");
    expect(server).toContain("await locateRetryOrder(admin, c.row, geocodeKey, { quotaHit: report.geocode.quotaHit, chatby: chatbyRead })");
  });
});
