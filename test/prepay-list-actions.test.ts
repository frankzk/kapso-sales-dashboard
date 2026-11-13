// «Lista de pago adelantado» (MOM §41.3 y §40): las acciones que la cambian.
//   - «Agregar» y «Quitar» a mano: celular peruano, motivo de 8 caracteres o
//     más, `prepay_list.manage` EN ESA organización y solo en producción. La
//     baja queda en la fila (quién, cuándo, por qué) y no se reabre.
//   - La regla automática en Automatizaciones: `automations.manage`, solo
//     producción, una fila en «Últimos cambios»; «Simular ahora» no agrega a
//     nadie.
//   - El permiso nuevo: dueño y admin por su rol; desde el 13-11-2026 también
//     se da uno por uno en Equipo (solo el dueño).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  perms: new Set<string>(),
  db: null as unknown as import("./woocommerce-fake-db").FakeDb,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => ({ id: "owner-1" }) }));
vi.mock("@/lib/permissions-access", () => ({ hasOrgPermission: async (_org: string, perm: string) => h.perms.has(perm) }));
vi.mock("@/lib/env", () => ({ env: { googleGeocodingApiKey: () => null } }));
vi.mock("@/lib/lima-retry-auto-server", () => ({ runLimaRetryAuto: async () => ({}) }));
vi.mock("@/lib/geocode-google-server", () => ({ latestGeocodeLimaRun: async () => null, runGeocodeLimaMeasure: async () => ({ ok: false, error: "x" }) }));
vi.mock("@/lib/db", () => ({ createAdminSupabase: () => h.db.client() }));

import { FakeDb } from "./woocommerce-fake-db";
import { addToPrepayList, removeFromPrepayList } from "@/app/dashboard/clientes/lista-negra/actions";
import { setPrepayAutoMode, simulatePrepayNow } from "@/app/dashboard/automatizaciones/actions";
import { GRANTED_ONE_BY_ONE, PERMISSIONS, PERMISSION_AREAS, PERMISSION_LABEL, permissionsFor } from "@/lib/permissions";
import { PREPAY_MODE_EVENT, automationEventLabel, automationValueLabel } from "@/lib/automations-catalog";

const ORG = "22222222-2222-4222-8222-222222222222";
const STORE = "11111111-1111-4111-8111-111111111111";
const previousEnv = process.env.VERCEL_ENV;

beforeEach(() => {
  process.env.VERCEL_ENV = "production";
  h.perms = new Set(["prepay_list.manage", "automations.manage"]);
  h.db = new FakeDb({ stores: [{ id: STORE, org_id: ORG }], prepay_list_entries: [], prepay_list_settings: [], automation_switch_events: [] });
});
afterEach(() => {
  process.env.VERCEL_ENV = previousEnv;
});

describe("agregar y quitar a mano", () => {
  it("agrega con el celular canónico, el motivo, quién y cuándo", async () => {
    const res = await addToPrepayList(ORG, "987 654 321", "Rechazó dos veces y lo pidió el owner");
    expect(res.error).toBeUndefined();
    expect(res.notice).toContain("987 654 321");
    expect(h.db.rows("prepay_list_entries")).toEqual([
      expect.objectContaining({ org_id: ORG, phone: "51987654321", source: "manual", reason: "Rechazó dos veces y lo pidió el owner", added_by: "owner-1" }),
    ]);
  });

  it("no agrega dos veces el mismo celular, ni sin motivo, ni un número que no es móvil", async () => {
    h.db.rows("prepay_list_entries").push({ id: "e1", org_id: ORG, phone: "51987654321", source: "auto", removed_at: null });
    expect((await addToPrepayList(ORG, "51987654321", "Otra vez, por si acaso")).error).toBe("Ese celular ya está en la lista.");
    expect((await addToPrepayList(ORG, "911111111", "corto")).error).toMatch(/al menos 8/);
    expect((await addToPrepayList(ORG, "014445566", "Un fijo de Lima")).error).toMatch(/celular peruano/);
    expect(h.db.rows("prepay_list_entries")).toHaveLength(1);
  });

  it("quita con motivo y la fila queda como historia", async () => {
    h.db.rows("prepay_list_entries").push({ id: "33333333-3333-4333-8333-333333333333", org_id: ORG, phone: "51987654321", source: "auto", removed_at: null });
    const res = await removeFromPrepayList(ORG, "33333333-3333-4333-8333-333333333333", "Era otra persona con el mismo número");
    expect(res.error).toBeUndefined();
    expect(res.notice).toBe("987 654 321 sacada de la Lista negra a mano. Si está en la automática, sigue ahí.");
    expect(h.db.rows("prepay_list_entries")[0]).toMatchObject({
      removed_by: "owner-1",
      removed_reason: "Era otra persona con el mismo número",
      removed_known_order_ids: [],
    });
    expect(h.db.rows("prepay_list_entries")[0]!.removed_at).toBeTruthy();
    // Una segunda baja no encuentra nada vivo.
    expect((await removeFromPrepayList(ORG, "33333333-3333-4333-8333-333333333333", "Otra baja más")).error).toBe("Ese cliente ya no estaba en la lista.");
    expect((await removeFromPrepayList(ORG, "33333333-3333-4333-8333-333333333333", "corto")).error).toMatch(/al menos 8/);
  });

  it("al quitar guarda los pedidos que YA disparaban el alta (la misma regla), para que la baja se respete", async () => {
    h.db.rows("prepay_list_entries").push({ id: "33333333-3333-4333-8333-333333333333", org_id: ORG, phone: "51987654321", source: "manual", removed_at: null });
    // Fechas relativas a hoy: la baja lee la misma ventana de seis meses que la regla.
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    h.db.rows("order_master").push(
      { order_id: "o1", store_id: STORE, order_name: "#KP1", customer_phone: "987654321", order_created_at: daysAgo(30) },
      { order_id: "o2", store_id: STORE, order_name: "#KP2", customer_phone: "51911111111", order_created_at: daysAgo(30) },
    );
    h.db.rows("shipments").push(
      { id: "g1", store_id: STORE, order_id: "o1", courier: "aliclik", reported_status: "REFUSED", created_at: daysAgo(29) },
      { id: "g2", store_id: STORE, order_id: "o2", courier: "aliclik", reported_status: "REFUSED", created_at: daysAgo(29) },
    );
    const res = await removeFromPrepayList(ORG, "33333333-3333-4333-8333-333333333333", "Pagó todo y fue un error");
    expect(res.error).toBeUndefined();
    // Solo los de ESTE celular.
    expect(h.db.rows("prepay_list_entries")[0]!.removed_known_order_ids).toEqual(["o1"]);
  });

  it("si no se pueden leer sus pedidos, no se quita (la baja no se podría respetar)", async () => {
    h.db.rows("prepay_list_entries").push({ id: "33333333-3333-4333-8333-333333333333", org_id: ORG, phone: "51987654321", source: "manual", removed_at: null });
    h.db.failOn = (table) => (table === "shipments" ? { message: "timeout" } : null);
    expect((await removeFromPrepayList(ORG, "33333333-3333-4333-8333-333333333333", "Pagó todo y fue un error")).error).toMatch(/No se pudieron leer los pedidos/);
    expect(h.db.rows("prepay_list_entries")[0]!.removed_at).toBeNull();
  });

  it("sin `prepay_list.manage`, fuera de producción o con otra organización: nada", async () => {
    h.perms = new Set(["automations.manage"]);
    expect((await addToPrepayList(ORG, "987654321", "Rechazó en la puerta")).error).toMatch(/no permite/);
    h.perms = new Set(["prepay_list.manage"]);
    process.env.VERCEL_ENV = "preview";
    expect((await addToPrepayList(ORG, "987654321", "Rechazó en la puerta")).error).toBe("Disponible solo en producción.");
    process.env.VERCEL_ENV = "production";
    expect((await addToPrepayList("no-es-uuid", "987654321", "Rechazó en la puerta")).error).toBe("Organización inválida.");
    expect(h.db.rows("prepay_list_entries")).toHaveLength(0);
  });
});

describe("la regla automática de la lista a mano, retirada (owner, 09-11-2026)", () => {
  it("no se puede encender: solo apagar; nada se escribe", async () => {
    for (const mode of ["simulacion", "activo"]) {
      expect((await setPrepayAutoMode(ORG, mode)).error).toMatch(/retirada/);
    }
    expect(h.db.rows("prepay_list_settings")).toHaveLength(0);
    expect((await setPrepayAutoMode(ORG, "apagado")).notice).toBe("Ya estaba así.");
    expect((await setPrepayAutoMode(ORG, "encendido")).error).toBe("Esa posición no existe.");
  });

  it("apagarla pide `automations.manage` (no basta `prepay_list.manage`) y producción", async () => {
    h.perms = new Set(["prepay_list.manage"]);
    expect((await setPrepayAutoMode(ORG, "apagado")).error).toMatch(/no permite/);
    h.perms = new Set(["automations.manage"]);
    process.env.VERCEL_ENV = "preview";
    expect((await setPrepayAutoMode(ORG, "apagado")).error).toBe("Disponible solo en producción.");
    expect(h.db.rows("prepay_list_settings")).toHaveLength(0);
  });

  it("«Simular ahora» no agrega a nadie y guarda el resumen", async () => {
    const res = await simulatePrepayNow(ORG);
    expect(res.error).toBeUndefined();
    expect(res.summary).toMatchObject({ mode: "simulacion", wouldAdd: 0 });
    expect(h.db.rows("prepay_list_entries")).toHaveLength(0);
    expect(h.db.rows("prepay_list_settings")[0]!.last_simulation).toMatchObject({ mode: "simulacion" });
  });

  it("el historial lo nombra en palabras", () => {
    expect(automationEventLabel(PREPAY_MODE_EVENT)).toBe("Lista negra · regla automática de la lista a mano (retirada)");
    expect(automationValueLabel(PREPAY_MODE_EVENT, "activo")).toBe("Activo");
    expect(automationValueLabel(PREPAY_MODE_EVENT, "simulacion")).toBe("Simulación");
  });
});

describe("el permiso «Gestionar la Lista negra»", () => {
  it("existe, en Pedidos, y viene con dueño y admin; la vendedora no; se da uno por uno (13-11-2026)", () => {
    expect(PERMISSIONS).toContain("prepay_list.manage");
    expect(PERMISSION_LABEL["prepay_list.manage"]).toBe("Gestionar la Lista negra");
    expect(PERMISSION_AREAS.find((a) => a.key === "pedidos")!.permissions).toContain("prepay_list.manage");
    expect(permissionsFor(["owner"]).has("prepay_list.manage")).toBe(true);
    expect(permissionsFor(["admin"]).has("prepay_list.manage")).toBe(true);
    expect(permissionsFor(["vendedora"]).has("prepay_list.manage")).toBe(false);
    expect(permissionsFor(["viewer"]).has("prepay_list.manage")).toBe(false);
    expect(GRANTED_ONE_BY_ONE.some((g) => (g.permission as string) === "prepay_list.manage")).toBe(true);
  });
});
