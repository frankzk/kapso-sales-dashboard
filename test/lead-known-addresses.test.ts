// MOM §37.9 (owner, 07-11-2026): «Datos de entrega conocidos» en la ficha del
// lead. Con el celular, la ficha muestra a dónde ya se le mandó a la clienta
// (pedidos de Kapta y el historial de Shopify, anulados incluidos y marcados) y
// «Usar en el pedido» llena el formulario sin guardar nada. Datos inventados:
// nada aquí viene de producción ni toca una base de verdad.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerSupabaseMock } = vi.hoisted(() => ({ createServerSupabaseMock: vi.fn() }));
vi.mock("@/lib/db", () => ({ createServerSupabase: createServerSupabaseMock }));

import {
  applyOrderFormPrefill,
  customerPhoneVariants,
  knownAddressCopyText,
  knownAddressPlace,
  knownAddressSourceLine,
  limaDayShort,
  orderFormPrefill,
  pickKnownAddresses,
  type HistoryAddressRow,
  type KaptaAddressRow,
  type KnownAddress,
} from "@/lib/lead-known-addresses";
import { getCustomerKnownAddresses } from "@/lib/leads-access";

const read = (path: string) => readFileSync(resolve(__dirname, "..", path), "utf8");

const LEAD = "51900000001";

const kapta = (order_id: string, order_name: string, at: string, extra: Partial<KaptaAddressRow> = {}): KaptaAddressRow => ({
  order_id,
  order_name,
  order_created_at: at,
  general_status: "pendiente",
  customer_name: "Clienta Prueba",
  address: "Av. Los Pinos 123",
  reference: "Frente al parque",
  district: "Miraflores",
  province: "Lima",
  region: "Lima",
  ...extra,
});

const hist = (order_name: string, at: string, extra: Partial<HistoryAddressRow> = {}): HistoryAddressRow => ({
  order_name,
  created_at: at,
  cancelled_at: null,
  customer_name: "Clienta Prueba",
  shipping_name: "Clienta Prueba",
  shipping_address1: "Jr. Las Flores 456",
  shipping_address2: "Puerta verde",
  shipping_city: "Sullana",
  shipping_province: "Piura",
  shipping_phone: LEAD,
  ...extra,
});

describe("customerPhoneVariants: el celular en todas sus formas", () => {
  it("normalizado, nacional y con los prefijos de Shopify", () => {
    expect(customerPhoneVariants("51900000001")).toEqual(["51900000001", "900000001", "051900000001", "0051900000001"]);
    expect(customerPhoneVariants("+51 900 000 001")).toContain("900000001");
    expect(customerPhoneVariants("900000001")).toContain("51900000001");
  });

  it("sin celular, ninguna (no se consulta)", () => {
    expect(customerPhoneVariants(null)).toEqual([]);
    expect(customerPhoneVariants("  ")).toEqual([]);
  });
});

describe("pickKnownAddresses: Kapta + historial, sin repetir", () => {
  it("una clienta solo con un anulado del historial: su dirección sale, marcada", () => {
    const [a, ...rest] = pickKnownAddresses({
      kapta: [],
      history: [hist("#KP1001", "2025-06-14T10:00:00-05:00", { cancelled_at: "2025-06-15T10:00:00-05:00" })],
      leadPhone: LEAD,
    });
    expect(rest).toEqual([]);
    expect(a).toMatchObject({
      source: "shopify_historial",
      recipient: "Clienta Prueba",
      address: "Jr. Las Flores 456",
      reference: "Puerta verde",
      district: "Sullana",
      province: null,
      region: "Piura",
      contactPhone: null,
      orderName: "#KP1001",
      cancelled: true,
      delivered: false,
      orders: 1,
    });
    expect(knownAddressSourceLine(a!)).toBe("del pedido #KP1001 · 14 jun 2025 · anulado · historial de Shopify");
  });

  it("junta las dos fuentes, la más reciente primero, hasta 3", () => {
    const list = pickKnownAddresses({
      kapta: [
        kapta("o1", "#KP3", "2026-10-01T10:00:00Z", { address: "Calle Uno 1" }),
        kapta("o2", "#KP2", "2026-08-01T10:00:00Z", { address: "Calle Dos 2" }),
      ],
      history: [
        hist("#KP1", "2025-01-01T10:00:00Z", { shipping_address1: "Calle Tres 3" }),
        hist("#KP0", "2024-01-01T10:00:00Z", { shipping_address1: "Calle Cuatro 4" }),
        hist("#KP9", "2026-09-01T10:00:00Z", { shipping_address1: "Calle Cinco 5" }),
      ],
    });
    expect(list.map((a) => [a.orderName, a.source])).toEqual([
      ["#KP3", "kapta"],
      ["#KP9", "shopify_historial"],
      ["#KP2", "kapta"],
    ]);
  });

  it("la misma dirección escrita distinto cuenta una vez y se dice en cuántos pedidos", () => {
    const list = pickKnownAddresses({
      kapta: [kapta("o1", "#KP5", "2026-10-01T10:00:00Z", { address: "AV LOS PINOS 123", district: "MIRAFLORES" })],
      history: [hist("#KP4", "2025-01-01T10:00:00Z", { shipping_address1: "Av. Los Pinos 123", shipping_city: "Miraflores" })],
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ orderName: "#KP5", source: "kapta", orders: 2 });
  });

  it("de varios pedidos a la misma dirección se muestra el último no anulado, y si Kapta entregó ahí", () => {
    const [a] = pickKnownAddresses({
      kapta: [
        kapta("o3", "#KP30", "2026-10-03T10:00:00Z", { general_status: "anulado" }),
        kapta("o2", "#KP20", "2026-09-03T10:00:00Z"),
        kapta("o1", "#KP10", "2026-08-03T10:00:00Z", { general_status: "entregado" }),
      ],
      history: [],
    });
    expect(a).toMatchObject({ orderName: "#KP20", cancelled: false, delivered: true, orders: 3 });
  });

  it("manda Kapta: un número que ya está en `order_master` no se toma del historial", () => {
    const list = pickKnownAddresses({
      kapta: [kapta("o1", "#KP7", "2026-10-01T10:00:00Z", { address: null })],
      history: [hist("#KP7", "2026-10-01T10:00:00Z")],
    });
    expect(list).toEqual([]);
  });

  it("el pedido propio del lead no es «de antes», ni su copia en el historial", () => {
    const list = pickKnownAddresses({
      kapta: [kapta("own", "#KP8", "2026-11-01T10:00:00Z")],
      history: [hist("#KP8", "2026-11-01T10:00:00Z")],
      excludeOrderId: "own",
    });
    expect(list).toEqual([]);
  });

  it("una dirección sin calle, o sin distrito ni región, no sirve", () => {
    const list = pickKnownAddresses({
      kapta: [kapta("o1", "#KP1", "2026-10-01T10:00:00Z", { district: null, region: null })],
      history: [hist("#KP2", "2026-09-01T10:00:00Z", { shipping_address1: "  " })],
    });
    expect(list).toEqual([]);
  });

  it("el celular de contacto se muestra solo si es otro que el del lead", () => {
    const [same] = pickKnownAddresses({ kapta: [], history: [hist("#KP1", "2025-01-01T10:00:00Z", { shipping_phone: "900 000 001" })], leadPhone: LEAD });
    const [other] = pickKnownAddresses({ kapta: [], history: [hist("#KP1", "2025-01-01T10:00:00Z", { shipping_phone: "900000002" })], leadPhone: LEAD });
    expect(same!.contactPhone).toBeNull();
    expect(other!.contactPhone).toBe("900000002");
  });

  it("sin el nombre del envío, quien compró", () => {
    const [a] = pickKnownAddresses({ kapta: [], history: [hist("#KP1", "2025-01-01T10:00:00Z", { shipping_name: null, customer_name: "Otra Persona" })] });
    expect(a!.recipient).toBe("Otra Persona");
  });
});

describe("cómo se lee y se copia", () => {
  const base = pickKnownAddresses({ kapta: [kapta("o1", "#KP1", "2026-10-01T15:00:00Z")], history: [] })[0]!;

  it("la fecha en hora de Lima, sin punto", () => {
    expect(limaDayShort("2026-11-01T03:00:00Z")).toBe("31 oct 2026");
    expect(limaDayShort(null)).toBeNull();
    expect(limaDayShort("no es fecha")).toBeNull();
  });

  it("distrito · provincia · región sin repetir", () => {
    expect(knownAddressPlace(base)).toBe("Miraflores · Lima");
    expect(knownAddressPlace({ district: "Lima", province: "Lima", region: "LIMA" })).toBe("Lima");
    expect(knownAddressPlace({ district: null, province: null, region: null })).toBeNull();
  });

  it("la línea de origen de un pedido de Kapta no dice «historial»", () => {
    expect(knownAddressSourceLine(base)).toBe("del pedido #KP1 · 1 oct 2026");
  });

  it("«Copiar dirección» copia calle, referencia y lugar", () => {
    expect(knownAddressCopyText(base)).toBe("Av. Los Pinos 123, Frente al parque, Miraflores · Lima");
  });
});

describe("«Usar en el pedido»: lo que llena el formulario", () => {
  const fromHistory: KnownAddress = pickKnownAddresses({ kapta: [], history: [hist("#KP1", "2025-06-14T10:00:00-05:00")] })[0]!;

  it("solo campos que el formulario tiene; la región va a «Provincia / Región»", () => {
    expect(orderFormPrefill(fromHistory)).toEqual({
      name: "Clienta Prueba",
      address1: "Jr. Las Flores 456",
      referencia: "Puerta verde",
      district: "Sullana",
      province: "Piura",
      sourceLine: "del pedido #KP1 · 14 jun 2025 · historial de Shopify",
    });
    expect(orderFormPrefill(fromHistory)).not.toHaveProperty("phone");
  });

  it("sobre lo cargado: la dirección entera, el nombre solo si se sabe", () => {
    const loaded = { name: "Nombre del lead", address1: "Calle del carrito 9", referencia: "Ref del carrito", district: "Surco", province: "Lima" };
    expect(applyOrderFormPrefill(loaded, null)).toBe(loaded);
    const noRef = orderFormPrefill({ ...fromHistory, recipient: null, reference: null });
    expect(applyOrderFormPrefill(loaded, noRef)).toEqual({
      name: "Nombre del lead",
      address1: "Jr. Las Flores 456",
      // La referencia del carrito era de OTRA dirección: no se mezcla.
      referencia: "",
      district: "Sullana",
      province: "Piura",
    });
  });
});

describe("getCustomerKnownAddresses: solo lee, por índice, en la tienda del lead", () => {
  type Call = { table: string; filters: [string, string, unknown][]; limit: number | null };
  let calls: Call[];

  function mockDb(results: Record<string, { data: unknown[] | null; error?: unknown }>) {
    calls = [];
    createServerSupabaseMock.mockResolvedValue({
      from: (table: string) => {
        const call: Call = { table, filters: [], limit: null };
        calls.push(call);
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.eq = (c: string, v: unknown) => (call.filters.push(["eq", c, v]), q);
        q.in = (c: string, v: unknown) => (call.filters.push(["in", c, v]), q);
        q.order = () => q;
        q.limit = (n: number) => ((call.limit = n), q);
        q.then = (res: (v: unknown) => void) => res({ data: results[table]?.data ?? [], error: results[table]?.error ?? null });
        return q;
      },
    });
  }

  beforeEach(() => createServerSupabaseMock.mockReset());

  it("las dos fuentes, por celular en todas sus formas y con límite", async () => {
    mockDb({
      order_master: { data: [kapta("o1", "#KP2", "2026-10-01T10:00:00Z")] },
      shopify_history_orders: { data: [hist("#KP1", "2025-01-01T10:00:00Z", { cancelled_at: "2025-01-02T10:00:00Z" })] },
    });
    const list = await getCustomerKnownAddresses("store-1", LEAD, "own");
    expect(list!.map((a) => a.orderName)).toEqual(["#KP2", "#KP1"]);
    const phones = customerPhoneVariants(LEAD);
    expect(calls.map((c) => [c.table, c.filters, c.limit])).toEqual([
      ["order_master", [["eq", "store_id", "store-1"], ["in", "customer_phone", phones]], 25],
      ["shopify_history_orders", [["eq", "store_id", "store-1"], ["in", "phone_norm", phones]], 25],
    ]);
  });

  it("sin el historial (o sin permiso) quedan las de Kapta", async () => {
    mockDb({
      order_master: { data: [kapta("o1", "#KP2", "2026-10-01T10:00:00Z")] },
      shopify_history_orders: { data: null, error: { code: "42P01" } },
    });
    expect((await getCustomerKnownAddresses("store-1", LEAD))!.map((a) => a.orderName)).toEqual(["#KP2"]);
  });

  it("si Kapta falla, null: la ficha sale sin la tarjeta", async () => {
    mockDb({ order_master: { data: null, error: { code: "XX000" } } });
    expect(await getCustomerKnownAddresses("store-1", LEAD)).toBeNull();
  });

  it("sin celular no consulta", async () => {
    mockDb({});
    expect(await getCustomerKnownAddresses("store-1", null)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("nunca escribe", () => {
    const src = read("lib/leads-access.ts");
    const fn = src.slice(src.indexOf("export async function getCustomerKnownAddresses"), src.indexOf("/** Valores neutros"));
    expect(fn).toContain('from("order_master")');
    expect(fn).toContain('from("shopify_history_orders")');
    expect(fn).not.toMatch(/\.(insert|upsert|update|delete|rpc)\(/);
    expect(fn).not.toContain("createAdminSupabase");
  });
});

describe("la ficha y su cableado", () => {
  const drawer = read("components/leads-drawer.tsx");
  const actions = read("app/dashboard/leads/actions.ts");

  it("se carga en la misma tanda que el historial y los carritos, y si falla no rompe", () => {
    const batch = actions.slice(actions.indexOf("const [customerHistory, carts, knownAddresses] = await Promise.all(["));
    expect(batch.slice(0, 900)).toContain("getCustomerKnownAddresses(ctx.storeId, lead.phone, lead.order_id)).catch(() => null)");
  });

  it("la tarjeta, el botón y el prellenado atado al lead", () => {
    expect(drawer).toContain('aria-label="Datos de entrega conocidos"');
    expect(drawer).toContain("Usar en el pedido");
    expect(drawer).toContain("initialAddress={orderPrefill}");
    expect(drawer).toContain("prefillFor?.leadId === lead.id");
    expect(drawer).toContain("Confírmala con la clienta antes de generar.");
  });

  it("la regla pura no arrastra nada del servidor al cajón", () => {
    for (const path of ["lib/lead-known-addresses.ts", "lib/customer-carts.ts", "lib/last-known-destination.ts", "lib/phone.ts"]) {
      const src = read(path);
      expect(src, path).not.toMatch(/from "@\/lib\/(db|supabase-admin|leads-access)"|server-only|"use server"|node:/);
    }
    // El cajón solo importa tipos de leads-access (se borran al compilar).
    expect(drawer).toContain('import type { CustomerHistory } from "@/lib/leads-access";');
    expect(drawer).not.toMatch(/import \{[^}]*\} from "@\/lib\/leads-access"/);
  });

  it("el MOM documenta la regla", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("### 37.9 Datos de entrega conocidos en Leads (owner, 07-11-2026)");
    expect(mom).toContain("«Usar en el pedido»");
    expect(mom).toContain("`lib/lead-known-addresses.ts`");
  });
});
