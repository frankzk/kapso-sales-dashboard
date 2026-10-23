import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ORDERS_BULK_QUERY,
  CUSTOMERS_BULK_QUERY,
  bulkOutcome,
  gidNumber,
  groupBulkOrders,
  hasFullOrderAccess,
  mapBulkCustomer,
  mapBulkOrder,
  mergeLineItems,
  splitJsonl,
} from "@/lib/shopify-history-bulk";
import { readImportChunk, type HistoryImportRow, type RowWriter } from "@/lib/shopify-history-import";
import type { HistoryCustomer, HistoryOrder } from "@/lib/shopify-history";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const enc = new TextEncoder();

const ORDER_1 = {
  id: "gid://shopify/Order/3712345678901",
  name: "#1001",
  createdAt: "2021-04-13T15:20:00Z",
  processedAt: "2021-04-13T15:20:00Z",
  cancelledAt: null,
  displayFinancialStatus: "PAID",
  displayFulfillmentStatus: "FULFILLED",
  currencyCode: "PEN",
  subtotalPriceSet: { shopMoney: { amount: "139.0" } },
  totalShippingPriceSet: { shopMoney: { amount: "10.0" } },
  totalTaxSet: { shopMoney: { amount: "0.0" } },
  totalPriceSet: { shopMoney: { amount: "149.0" } },
  totalDiscountsSet: { shopMoney: { amount: "0.0" } },
  totalRefundedSet: { shopMoney: { amount: "0.0" } },
  discountCodes: ["BIENVENIDA"],
  paymentGatewayNames: ["Cash on Delivery (COD)"],
  email: "maria@correo.com",
  phone: null,
  note: "Llamar antes",
  tags: ["contraentrega", "lima"],
  sourceName: "web",
  customer: { id: "gid://shopify/Customer/501", firstName: "María", lastName: "Pérez", email: "maria@correo.com", phone: null },
  billingAddress: { name: "María Pérez", phone: null },
  shippingAddress: { name: "María Pérez", address1: "Av. Larco 123", address2: null, city: "Miraflores", province: "Lima", zip: null, country: "Peru", phone: "+51 987 654 321" },
  customAttributes: [{ key: "DNI", value: "12345678" }],
  fulfillments: [{ createdAt: "2021-04-14T10:00:00Z" }],
  transactions: [
    { kind: "SALE", status: "FAILURE", processedAt: "2021-04-13T15:21:00Z" },
    { kind: "SALE", status: "SUCCESS", processedAt: "2021-04-15T18:00:00Z" },
  ],
};
const item = (n: number, parent: string) => ({
  id: `gid://shopify/LineItem/${n}`,
  name: `Producto ${n}`,
  sku: `SKU-${n}`,
  quantity: 1,
  vendor: "Aurela",
  originalUnitPriceSet: { shopMoney: { amount: "50.00" } },
  totalDiscountSet: { shopMoney: { amount: "0.00" } },
  __parentId: parent,
});
const order = (n: number) => ({ ...ORDER_1, id: `gid://shopify/Order/${n}`, name: `#${n}`, createdAt: `2021-05-${String(n % 28 + 1).padStart(2, "0")}T12:00:00Z` });

describe("el pedido del archivo de Shopify", () => {
  it("queda igual que el del CSV: montos, celular, envío, pago y entrega", () => {
    const o = mapBulkOrder(ORDER_1);
    expect(o.order_name).toBe("#1001");
    expect(o.shopify_order_id).toBe("3712345678901");
    expect(o.created_at).toBe("2021-04-13T15:20:00.000Z");
    expect(o.total).toBe(149);
    expect(o.financial_status).toBe("paid");
    expect(o.fulfillment_status).toBe("fulfilled");
    expect(o.discount_code).toBe("BIENVENIDA");
    expect(o.payment_method).toBe("Cash on Delivery (COD)");
    // Sin teléfono del pedido, el del envío; normalizado como en Kapta.
    expect(o.phone).toBe("+51 987 654 321");
    expect(o.phone_norm).toBe("51987654321");
    expect(o.customer_name).toBe("María Pérez");
    expect(o.shipping_city).toBe("Miraflores");
    expect(o.tags).toBe("contraentrega, lima");
    // Pagado: la primera venta exitosa, no el intento fallido.
    expect(o.paid_at).toBe("2021-04-15T18:00:00.000Z");
    expect(o.fulfilled_at).toBe("2021-04-14T10:00:00.000Z");
    expect(o.raw).toMatchObject({ fuente: "api", DNI: "12345678", customerId: "501" });
  });

  it("el cliente del archivo usa su id de Shopify como clave, igual que el CSV", () => {
    const c = mapBulkCustomer({
      id: "gid://shopify/Customer/7012345678",
      firstName: "Ana",
      lastName: "Ruiz",
      email: "ana@correo.com",
      phone: null,
      numberOfOrders: "7",
      amountSpent: { amount: "1250.50" },
      emailMarketingConsent: { marketingState: "SUBSCRIBED" },
      tags: ["VIP"],
      note: null,
      defaultAddress: { city: "Lima", province: "Lima", country: "Peru", phone: "987000111" },
    })!;
    expect(c.customer_key).toBe("7012345678");
    expect(c.total_orders).toBe(7);
    expect(c.total_spent).toBe(1250.5);
    expect(c.phone_norm).toBe("51987000111");
    expect(c.accepts_marketing).toBe("subscribed");
    expect(mapBulkCustomer({ id: null })).toBeNull();
  });

  it("gid, estado de la operación y unión de productos", () => {
    expect(gidNumber("gid://shopify/Order/123")).toBe("123");
    expect(gidNumber(null)).toBeNull();
    expect(bulkOutcome("COMPLETED")).toBe("listo");
    expect(bulkOutcome("RUNNING")).toBe("esperar");
    expect(bulkOutcome("CREATED")).toBe("esperar");
    expect(bulkOutcome("FAILED")).toBe("fallo");
    expect(bulkOutcome("EXPIRED")).toBe("fallo");
    const a = { id: "1", name: "A", sku: null, quantity: 1, price: null, discount: null, vendor: null };
    const b = { ...a, id: "2", name: "B" };
    expect(mergeLineItems([a], [a, b]).map((x) => x.id)).toEqual(["1", "2"]);
  });
});

describe("leer el archivo JSONL", () => {
  it("corta en líneas completas con su byte de inicio y devuelve el resto", () => {
    const text = `{"id":"a"}\n{"id":"ñ"}\n{"id":"c`;
    const { lines, rest, bad } = splitJsonl(enc.encode(text), 100);
    expect(lines.map((l) => l.value.id)).toEqual(["a", "ñ"]);
    expect(lines[0]!.start).toBe(100);
    expect(lines[1]!.start).toBe(100 + enc.encode(`{"id":"a"}\n`).length);
    expect(new TextDecoder().decode(rest)).toBe(`{"id":"c`);
    expect(bad).toBe(0);
    expect(splitJsonl(enc.encode("no es json\n"), 0).bad).toBe(1);
  });

  it("junta los productos con su pedido; los de un pedido de otra tanda quedan aparte", () => {
    const lines = [ORDER_1, item(1, ORDER_1.id), item(2, ORDER_1.id), item(9, "gid://shopify/Order/999")].map((value, i) => ({
      start: i,
      end: i + 1,
      value,
    }));
    const { orders, orphans } = groupBulkOrders(lines);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.line_items.map((li) => li.id)).toEqual(["1", "2"]);
    expect(orders[0]!.line_items[0]).toMatchObject({ name: "Producto 1", sku: "SKU-1", quantity: 1, price: 50 });
    expect([...orphans.keys()]).toEqual(["999"]);
  });
});

/** Un Supabase de mentira: la fila de la traída vive en memoria. */
function fakeAdmin(row: HistoryImportRow) {
  const state = { row: { ...row } };
  const builder = () => {
    let patch: Record<string, unknown> | null = null;
    const b: any = {
      update(p: Record<string, unknown>) {
        patch = p;
        return b;
      },
      eq: () => b,
      or: () => b,
      select: () => b,
      async maybeSingle() {
        if (patch) state.row = { ...state.row, ...(patch as Partial<HistoryImportRow>) };
        return { data: { ...state.row }, error: null };
      },
    };
    return b;
  };
  return { admin: { from: () => builder() } as any, state };
}

/** Un archivo servido por partes, con Range como el de Shopify. */
function fakeFile(text: string, chunkSize = 37): typeof fetch {
  const bytes = enc.encode(text);
  return (async (_url: string, init?: { headers?: Record<string, string> }) => {
    const range = init?.headers?.Range;
    const from = range ? Number(range.match(/bytes=(\d+)-/)![1]) : 0;
    if (from >= bytes.length && from > 0) return new Response(null, { status: 416 });
    const body = bytes.subarray(from);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < body.length; i += chunkSize) controller.enqueue(body.slice(i, i + chunkSize));
        controller.close();
      },
    });
    return new Response(stream, { status: range ? 206 : 200 });
  }) as unknown as typeof fetch;
}

describe("la traída por tandas (§37.5)", () => {
  const ROW: HistoryImportRow = {
    id: "imp-1",
    store_id: "store-1",
    kind: "pedidos",
    bulk_operation_id: "gid://shopify/BulkOperation/1",
    status: "importando",
    url: "https://storage.example/bulk.jsonl",
    file_size: null,
    object_count: null,
    bytes_done: 0,
    records: 0,
    first_at: null,
    last_at: null,
    error: null,
    lease_until: null,
    created_at: "2026-10-23T18:00:00Z",
    finished_at: null,
  };

  it("corta antes de un pedido nuevo, sigue desde ahí y no parte ningún pedido", async () => {
    const objects: object[] = [];
    for (let n = 1; n <= 7; n++) {
      objects.push(order(n));
      for (let k = 0; k < n % 3 + 1; k++) objects.push(item(n * 10 + k, `gid://shopify/Order/${n}`));
    }
    const text = objects.map((o) => JSON.stringify(o)).join("\n"); // sin salto final
    const { admin, state } = fakeAdmin(ROW);
    const saved = new Map<string, HistoryOrder>();
    const write: RowWriter = {
      async orders(rows) {
        for (const r of rows) {
          expect(saved.has(r.order_name)).toBe(false);
          saved.set(r.order_name, r);
        }
        return rows.length;
      },
      async customers(rows: HistoryCustomer[]) {
        return rows.length;
      },
      async orphans(o) {
        throw new Error(`no debería haber productos sueltos: ${[...o.keys()].join(",")}`);
      },
    };
    // Un reloj que avanza 1 ms por consulta: con 6 ms de margen, la primera tanda corta a mitad.
    let tick = 0;
    const now = () => tick++;
    const first = await readImportChunk(admin, ROW, write, { budgetMs: 6, fetchImpl: fakeFile(text), now });
    expect(first.status).toBe("importando");
    expect(first.bytes_done).toBeGreaterThan(0);
    expect(first.bytes_done).toBeLessThan(enc.encode(text).length);
    // El corte cae justo al inicio de un pedido.
    expect(text.slice(new TextDecoder().decode(enc.encode(text).subarray(0, first.bytes_done)).length)).toMatch(/^\{"id":"gid:\/\/shopify\/Order\//);

    let row = { ...state.row };
    for (let i = 0; i < 10 && row.status !== "listo"; i++) {
      row = await readImportChunk(admin, row, write, { budgetMs: 6, fetchImpl: fakeFile(text), now: () => tick++ });
    }
    expect(row.status).toBe("listo");
    expect(row.records).toBe(7);
    expect(saved.size).toBe(7);
    for (let n = 1; n <= 7; n++) expect(saved.get(`#${n}`)!.line_items).toHaveLength(n % 3 + 1);
    expect(row.first_at).toBe("2021-05-02T12:00:00.000Z");
    expect(row.last_at).toBe("2021-05-08T12:00:00.000Z");
  });

  it("un archivo vencido se dice así", async () => {
    const { admin } = fakeAdmin(ROW);
    const gone = (async () => new Response("expired", { status: 403 })) as unknown as typeof fetch;
    const noop: RowWriter = { orders: async () => 0, customers: async () => 0, orphans: async () => undefined };
    await expect(readImportChunk(admin, ROW, noop, { fetchImpl: gone })).rejects.toThrow(/venció/);
  });
});

describe("la traída solo lee de Shopify y solo escribe en el historial (§37.1)", () => {
  const lib = read("lib/shopify-history-import.ts");
  const actions = read("app/dashboard/stores/historial/actions.ts");

  it("las consultas de Shopify solo piden datos", () => {
    expect(ORDERS_BULK_QUERY).not.toMatch(/mutation/);
    expect(CUSTOMERS_BULK_QUERY).not.toMatch(/mutation/);
    // La única mutación es la que pide el archivo.
    expect(lib.match(/mutation/g)).toHaveLength(1);
    expect(lib).toContain("bulkOperationRunQuery");
  });

  it("no toca orders, el Master ni sus eventos", () => {
    for (const src of [lib, actions]) {
      expect(src).not.toMatch(/from\("orders"\)|from\("order_master"\)|from\("order_events"\)/);
    }
    expect(actions).toContain('from("shopify_history_orders").upsert(unique, { onConflict: "store_id,order_name" })');
  });

  it("la migración 0276 deja una sola traída en curso por tienda y tipo, con RLS", () => {
    const sql = read("db/migrations/0276_shopify_history_imports.sql");
    expect(sql).toContain("alter table shopify_history_imports enable row level security");
    expect(sql).toMatch(/create unique index if not exists shopify_history_imports_active_uidx[\s\S]*where status in \('preparando', 'importando'\)/);
    expect(sql).not.toMatch(/for (insert|update|delete|all) to authenticated/);
  });
});

describe("¿el token ve todos los pedidos? (§37.5)", () => {
  const now = new Date("2026-10-23T22:00:00Z");

  it("con read_all_orders, sí, aunque la tienda no tenga nada antes de 2022 (Kenku abrió en 2023)", () => {
    expect(hasFullOrderAccess({ scopes: ["read_all_orders", "read_orders"], oldestCreatedAt: "2023-04-14T15:00:00Z", now })).toBe(true);
  });

  it("sin el permiso, sí solo si alcanza un pedido de antes de la ventana de 60 días", () => {
    expect(hasFullOrderAccess({ scopes: ["read_orders"], oldestCreatedAt: "2023-04-14T15:00:00Z", now })).toBe(true);
    expect(hasFullOrderAccess({ scopes: ["read_orders"], oldestCreatedAt: "2026-08-25T00:00:00Z", now })).toBe(false);
    expect(hasFullOrderAccess({ scopes: ["read_orders"], oldestCreatedAt: null, now })).toBe(false);
  });
});
