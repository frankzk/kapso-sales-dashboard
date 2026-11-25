// Owner, 25-11-2026 («sí» al cambio de los avisos de cobranza, plan de carga). Cada consulta del aviso flotante
// (cada 20 s, en cada pestaña) hacía avanzar los avisos de todas las tiendas: unas 150 pasadas por minuto, y sin
// nadie conectado no avanzaban. Ahora los mueve un proceso cada 5 minutos, y la consulta de una pestaña como mucho
// una vez por minuto por servidor y tienda.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const fail = new Set<string>();
vi.mock("@/lib/collection-alerts-access", () => ({
  sweepResolvedAlerts: vi.fn(async (_admin: unknown, storeId: string) => { calls.push(`resueltas:${storeId}`); if (fail.has(storeId)) throw new Error("sin base"); return 1; }),
  sweepUnattributedAlerts: vi.fn(async (_admin: unknown, storeId: string) => { calls.push(`sin_atribuir:${storeId}`); return 2; }),
  reconcileCollectionOffers: vi.fn(async (_admin: unknown, storeId: string) => { calls.push(`escalera:${storeId}`); return 3; }),
}));

import {
  COLLECTION_ADVANCE_MIN_GAP_MS,
  advanceCollectionAlerts,
  advanceDue,
  claimAdvanceTurn,
  resetAdvanceTurns,
  runCollectionAdvanceSweep,
  storesWithOpenAlerts,
} from "@/lib/collection-alerts-advance";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const T0 = 1_800_000_000_000;

/** Una base de mentira que solo sabe decir qué tiendas tienen avisos abiertos. */
function fakeAdmin(storeIds: string[], error: string | null = null) {
  const seen: Array<[string, string]> = [];
  const chain: any = {
    select: () => chain,
    eq: (column: string, value: string) => { seen.push([column, value]); return chain; },
    limit: () => Promise.resolve({ data: storeIds.map((store_id) => ({ store_id })), error: error ? { message: error } : null }),
  };
  return { admin: { from: (table: string) => { seen.push(["tabla", table]); return chain; } } as any, seen };
}

beforeEach(() => {
  calls.length = 0;
  fail.clear();
  resetAdvanceTurns();
});

describe("el turno: cada servidor, como mucho una vez por minuto por tienda", () => {
  it("la regla pura", () => {
    expect(COLLECTION_ADVANCE_MIN_GAP_MS).toBe(60_000);
    expect(advanceDue(undefined, T0)).toBe(true);
    expect(advanceDue(T0, T0 + 20_000)).toBe(false);
    expect(advanceDue(T0, T0 + 59_999)).toBe(false);
    expect(advanceDue(T0, T0 + 60_000)).toBe(true);
    // Un reloj que retrocede no deja la tienda sin avanzar.
    expect(advanceDue(T0, T0 - 1)).toBe(true);
  });

  it("tres consultas seguidas de una pestaña: avanza la primera y las otras solo leen", () => {
    expect(claimAdvanceTurn("kenku", T0)).toBe(true);
    expect(claimAdvanceTurn("kenku", T0 + 20_000)).toBe(false);
    expect(claimAdvanceTurn("kenku", T0 + 40_000)).toBe(false);
    expect(claimAdvanceTurn("kenku", T0 + 60_000)).toBe(true);
    // Cada tienda lleva su turno.
    expect(claimAdvanceTurn("aurela", T0 + 20_000)).toBe(true);
  });
});

describe("avanzar una tienda", () => {
  it("retira lo resuelto ANTES de mover la escalera", async () => {
    const report = await advanceCollectionAlerts({} as any, "kenku", T0);
    expect(calls).toEqual(["resueltas:kenku", "sin_atribuir:kenku", "escalera:kenku"]);
    expect(report).toEqual({ resolved: 1, unattributed: 2, moved: 3 });
  });
});

describe("la pasada del proceso", () => {
  it("mira solo las tiendas con algún aviso abierto, cada una una vez", async () => {
    const { admin, seen } = fakeAdmin(["kenku", "kenku", "aurela"]);
    expect(await storesWithOpenAlerts(admin)).toEqual(["kenku", "aurela"]);
    expect(seen).toEqual([["tabla", "collection_alerts"], ["status", "abierta"]]);
  });

  it("suma lo que hizo, y una tienda que falla no detiene a las demás", async () => {
    fail.add("kenku");
    const { admin } = fakeAdmin(["kenku", "aurela"]);
    const report = await runCollectionAdvanceSweep(admin, T0);
    expect(report).toEqual({ stores: 2, resolved: 1, unattributed: 2, moved: 3, errors: 1 });
    expect(calls).toEqual(["resueltas:kenku", "resueltas:aurela", "sin_atribuir:aurela", "escalera:aurela"]);
  });

  it("sin avisos abiertos no toca nada", async () => {
    const { admin } = fakeAdmin([]);
    expect(await runCollectionAdvanceSweep(admin, T0)).toEqual({ stores: 0, resolved: 0, unattributed: 0, moved: 0, errors: 0 });
    expect(calls).toEqual([]);
  });

  it("lo que acaba de mover el proceso no lo repite enseguida una pestaña en ese servidor", async () => {
    const { admin } = fakeAdmin(["kenku"]);
    await runCollectionAdvanceSweep(admin, T0);
    expect(claimAdvanceTurn("kenku", T0 + 20_000)).toBe(false);
    expect(claimAdvanceTurn("kenku", T0 + 60_000)).toBe(true);
  });

  it("si no puede leer las tiendas, falla en vez de decir que no había nada", async () => {
    const { admin } = fakeAdmin([], "sin base");
    await expect(runCollectionAdvanceSweep(admin, T0)).rejects.toThrow("sin base");
  });
});

describe("dónde se usa", () => {
  const actions = read("app/dashboard/cobranza/actions.ts");
  const route = read("app/api/cron/collection-alerts/route.ts");

  it("la consulta de la pestaña ya no hace avanzar en cada llamada", () => {
    const list = actions.slice(actions.indexOf("export async function listMyCollectionAlerts("), actions.indexOf("async function authorize("));
    expect(list).toContain("if (!claimAdvanceTurn(s.id, nowMs)) continue;");
    expect(list).toContain("await advanceCollectionAlerts(admin, s.id, nowMs);");
    expect(list.indexOf("if (!claimAdvanceTurn(s.id, nowMs)) continue;")).toBeLessThan(list.indexOf("await advanceCollectionAlerts(admin, s.id, nowMs);"));
    for (const direct of ["sweepResolvedAlerts(", "sweepUnattributedAlerts(", "reconcileCollectionOffers("]) expect(actions).not.toContain(direct);
    // Lo que decide quién la ve sigue igual.
    expect(list).toContain("alertVisibleTo(");
  });

  it("el proceso: con el secreto de los crons, solo en producción y sin datos en el registro", () => {
    expect(route).toContain('if (!internalAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });');
    expect(route).toContain('if (process.env.VERCEL_ENV !== "production") return NextResponse.json({ skipped: "not_production" });');
    expect(route.indexOf("internalAuthorized(req)")).toBeLessThan(route.indexOf("runCollectionAdvanceSweep("));
    expect(route).toContain("console.log(`[collection-alerts] ${JSON.stringify(line)}`);");
    expect(route).not.toMatch(/phone|amount|order_id|customer/);
  });

  it("corre cada 5 minutos, en minutos que no pisan los reservados por otros procesos", () => {
    const crons = (JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] }).crons;
    expect(crons.filter((c) => c.path === "/api/cron/collection-alerts")).toEqual([{ path: "/api/cron/collection-alerts", schedule: "2-57/5 * * * *" }]);
    const mine = Array.from({ length: 12 }, (_, k) => 5 * k + 2);
    // El barrido de boletas (6, 16, …), las grabaciones de Anura (1, 11, …), el :23 de las apps de Shopify,
    // el :34 de los webhooks de WooCommerce y el :48 de las fotos de producto.
    for (const reserved of [6, 16, 26, 36, 46, 56, 1, 11, 21, 31, 41, 51, 23, 34, 48]) expect(mine).not.toContain(reserved);
  });

  it("el aviso flotante sigue preguntando cada 20 s con la pestaña visible", () => {
    const popup = read("components/collection-alerts.tsx");
    expect(popup).toContain("const POLL_MS = 20_000;");
    expect(popup).toContain('if (document.visibilityState !== "visible") return;');
  });
});

describe("MOM §12 y DEPLOY", () => {
  it("el MOM dice quién hace avanzar la escalera y lo que cambia", () => {
    const mom = flat(read("docs/mom/master-pedidos-v1.md"));
    expect(mom).toContain("- **Quién hace avanzar la escalera (25-11-2026, decisión del owner).**");
    expect(mom).toContain("**Un proceso la hace avanzar cada 5 minutos** (`/api/cron/collection-alerts`, minutos 2, 7, …, 57)");
    expect(mom).toContain("**Con Kapta abierto, cada servidor la hace avanzar como mucho una vez por minuto por tienda** (`claimAdvanceTurn`)");
    expect(mom).toContain("Un aviso que llega de noche sube la escalera esa noche");
    expect(mom).toContain("si el proceso dejara de correr, la escalera seguiría avanzando mientras alguien tenga Kapta abierto");
  });

  it("DEPLOY trae el cron nuevo y qué mirar", () => {
    const deploy = read("DEPLOY.md");
    const start = deploy.indexOf("### 25-11-2026 · Los avisos de cobranza avanzan con un proceso y las pestañas casi solo leen (sin migración, MOM §12)");
    expect(start).toBeGreaterThan(-1);
    const entry = flat(deploy.slice(start, deploy.indexOf("\n### ", start + 10)));
    expect(entry).toContain("**Cron nuevo** en `vercel.json`: `/api/cron/collection-alerts`, cada 5 minutos (`2-57/5 * * * *`)");
    expect(entry).toContain("`[collection-alerts] {");
  });
});
