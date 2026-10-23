import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCsvRows } from "@/lib/csv-parse";
import {
  batches,
  dateRange,
  decodeExport,
  detectDelimiter,
  detectKind,
  money,
  uniqueOrderNames,
  parseShopifyExport,
  shopifyDate,
} from "@/lib/shopify-history";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

// Las cabeceras de la exportación de pedidos de Shopify, en su orden, recortadas
// a las que se leen (el archivo real trae ~79; las demás van a `raw`).
const ORDER_HEADERS = [
  "Name", "Email", "Financial Status", "Paid at", "Fulfillment Status", "Fulfilled at", "Currency",
  "Subtotal", "Shipping", "Taxes", "Total", "Discount Code", "Discount Amount", "Created at",
  "Lineitem quantity", "Lineitem name", "Lineitem price", "Lineitem sku", "Lineitem discount",
  "Billing Name", "Shipping Name", "Shipping Address1", "Shipping City", "Shipping Province Name",
  "Shipping Phone", "Notes", "Cancelled at", "Payment Method", "Refunded Amount", "Vendor", "Id",
  "Tags", "Source", "Phone",
];

function ordersCsv(rows: Record<string, string>[], delimiter = ","): string {
  const quote = (v: string) => (/[",\n;\t]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [ORDER_HEADERS, ...rows.map((r) => ORDER_HEADERS.map((h) => r[h] ?? ""))]
    .map((cells) => cells.map(quote).join(delimiter))
    .join("\n");
}

const FIRST_ROW = {
  Name: "#AUR1001",
  Email: "maria@correo.com",
  "Financial Status": "pending",
  "Fulfillment Status": "fulfilled",
  "Fulfilled at": "2021-03-02 10:00:00 -0500",
  Currency: "PEN",
  Subtotal: "139.00",
  Shipping: "10.00",
  Taxes: "0.00",
  Total: "149.00",
  "Created at": "2021-03-01 21:55:31 -0500",
  "Lineitem quantity": "2",
  "Lineitem name": "Hair Donuts - Negro",
  "Lineitem price": "59.50",
  "Lineitem sku": "HD-NEG",
  "Billing Name": "María Pérez",
  "Shipping Name": "María Pérez",
  "Shipping Address1": "Av. Larco 123, dpto 4",
  "Shipping City": "Miraflores",
  "Shipping Province Name": "Lima",
  "Shipping Phone": "'+51987654321",
  Notes: "Llamar antes\nde llegar",
  "Payment Method": "Cash on Delivery (COD)",
  Vendor: "Aurela",
  Id: "'3712345678901",
  Tags: "contraentrega, lima",
  Source: "web",
  Phone: "'+51 987 654 321",
};

describe("parseShopifyExport: pedidos", () => {
  it("junta las filas de productos en un pedido, con los datos de la primera fila", () => {
    const csv = ordersCsv([
      FIRST_ROW,
      { Name: "#AUR1001", "Lineitem quantity": "1", "Lineitem name": "Cepillo alisador", "Lineitem price": "20", "Lineitem sku": "CEP-1" },
      { ...FIRST_ROW, Name: "#AUR1002", "Created at": "2022-07-10 08:00:00 -0500", Phone: "", "Shipping Phone": "999 888 777", "Cancelled at": "2022-07-11 09:00:00 -0500" },
    ]);
    const parsed = parseShopifyExport(csv);
    expect(parsed.kind).toBe("pedidos");
    expect(parsed.rowsRead).toBe(3);
    expect(parsed.orders).toHaveLength(2);

    const [first, second] = parsed.orders;
    expect(first!.order_name).toBe("#AUR1001");
    expect(first!.shopify_order_id).toBe("3712345678901");
    expect(first!.created_at).toBe("2021-03-02T02:55:31.000Z");
    expect(first!.total).toBe(149);
    expect(first!.customer_name).toBe("María Pérez");
    expect(first!.shipping_address1).toBe("Av. Larco 123, dpto 4");
    expect(first!.notes).toBe("Llamar antes\nde llegar");
    // El apóstrofo que Shopify pone para Excel se quita; el celular queda normalizado.
    expect(first!.phone).toBe("+51 987 654 321");
    expect(first!.phone_norm).toBe("51987654321");
    expect(first!.shipping_phone).toBe("+51987654321");
    expect(first!.line_items).toEqual([
      { name: "Hair Donuts - Negro", sku: "HD-NEG", quantity: 2, price: 59.5, discount: null, vendor: "Aurela" },
      { name: "Cepillo alisador", sku: "CEP-1", quantity: 1, price: 20, discount: null, vendor: null },
    ]);
    // `raw` guarda la primera fila tal como venía, sin celdas vacías.
    expect(first!.raw["Payment Method"]).toBe("Cash on Delivery (COD)");
    expect(first!.raw["Lineitem discount"]).toBeUndefined();

    // Sin «Phone», el celular sale del de envío.
    expect(second!.phone_norm).toBe("51999888777");
    expect(second!.cancelled_at).toBe("2022-07-11T14:00:00.000Z");
  });

  it("acepta el archivo separado por punto y coma o por tabulación", () => {
    for (const delimiter of [";", "\t"]) {
      const parsed = parseShopifyExport(ordersCsv([FIRST_ROW], delimiter));
      expect(parsed.kind).toBe("pedidos");
      expect(parsed.orders[0]!.order_name).toBe("#AUR1001");
      expect(parsed.orders[0]!.shipping_address1).toBe("Av. Larco 123, dpto 4");
    }
  });

  it("salta las filas en blanco y las que no traen número de pedido", () => {
    const parsed = parseShopifyExport(`${ordersCsv([FIRST_ROW])}\n\n${ORDER_HEADERS.map(() => "").join(",")}\n`);
    expect(parsed.orders).toHaveLength(1);
  });
});

describe("parseShopifyExport: clientes", () => {
  const HEADERS = [
    "Customer ID", "First Name", "Last Name", "Email", "Accepts Email Marketing", "Default Address Address1",
    "Default Address City", "Default Address Province Code", "Default Address Phone", "Phone",
    "Total Spent", "Total Orders", "Note", "Tags",
  ];
  const csv = (rows: string[][]) => [HEADERS, ...rows].map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");

  it("un cliente por fila; la clave es el id, si no el correo, si no el celular", () => {
    const parsed = parseShopifyExport(
      csv([
        ["'5012345678", "Ana", "Ruiz", "ANA@correo.com", "yes", "Jr. Unión 5", "Lima", "LIM", "", "'+51987000111", "1,250.00", "7", "VIP", "frecuente"],
        ["", "Luz", "Soto", "luz@correo.com", "no", "", "Arequipa", "ARE", "", "", "99.90", "1", "", ""],
        ["", "Rosa", "", "", "no", "", "", "", "'987000222", "", "0.00", "0", "", ""],
        ["", "", "", "", "", "", "", "", "", "", "", "", "", ""],
        ["", "Sin", "Datos", "", "no", "", "", "", "", "", "0.00", "0", "", ""],
      ]),
    );
    expect(parsed.kind).toBe("clientes");
    expect(parsed.rowsRead).toBe(4);
    expect(parsed.customers.map((c) => c.customer_key)).toEqual(["5012345678", "luz@correo.com", "51987000222"]);
    const ana = parsed.customers[0]!;
    expect(ana.phone_norm).toBe("51987000111");
    expect(ana.total_spent).toBe(1250);
    expect(ana.total_orders).toBe(7);
    expect(ana.province).toBe("LIM");
    expect(ana.note).toBe("VIP");
  });
});

describe("piezas del lector", () => {
  it("reconoce el tipo de exportación por sus cabeceras", () => {
    expect(detectKind(["Name", "Email", "Lineitem name", "Lineitem quantity"])).toBe("pedidos");
    expect(detectKind(["Customer ID", "Email", "Total Spent", "Total Orders"])).toBe("clientes");
    expect(detectKind(["First Name", "Email", "Total Spent"])).toBe("clientes");
    expect(detectKind(["Handle", "Title", "Variant SKU"])).toBe("productos");
    expect(detectKind(["Fecha", "Monto"])).toBe("otro");
    // Sin importar mayúsculas ni espacios de más.
    expect(detectKind([" name ", "LINEITEM  NAME"])).toBe("pedidos");
  });

  it("detecta el separador de la primera línea", () => {
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
    expect(detectDelimiter("solo")).toBe(",");
  });

  it("parseCsvRows respeta el separador pedido", () => {
    expect(parseCsvRows('a;"b;c"\n1;2', ";")).toEqual([["a", "b;c"], ["1", "2"]]);
    expect(parseCsvRows("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("lee UTF-8 con o sin BOM y el UTF-16 del «CSV para Excel»", () => {
    const text = "Name,Email\n#1,ñandú@correo.com";
    expect(decodeExport(new TextEncoder().encode(text))).toBe(text);
    expect(decodeExport(new TextEncoder().encode(`﻿${text}`))).toBe(text);
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16[0] = 0xff;
    utf16[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      utf16[2 + i * 2] = text.charCodeAt(i) & 0xff;
      utf16[3 + i * 2] = text.charCodeAt(i) >> 8;
    }
    expect(decodeExport(utf16)).toBe(text);
  });

  it("montos de Shopify", () => {
    expect(money("1,234.50")).toBe(1234.5);
    expect(money("S/ 99")).toBe(99);
    expect(money("-10.005")).toBe(-10.01);
    expect(money("")).toBeNull();
    expect(money(undefined)).toBeNull();
    expect(money("abc")).toBeNull();
  });

  it("fechas de Shopify a ISO, con su zona", () => {
    expect(shopifyDate("2021-12-31 21:55:31 -0500")).toBe("2022-01-01T02:55:31.000Z");
    expect(shopifyDate("2023-05-01 08:00 -0500")).toBe("2023-05-01T13:00:00.000Z");
    expect(shopifyDate("2023-05-01T08:00:00-05:00")).toBe("2023-05-01T13:00:00.000Z");
    expect(shopifyDate("")).toBeNull();
    expect(shopifyDate("no es fecha")).toBeNull();
  });

  it("rango de fechas y tandas", () => {
    const parsed = parseShopifyExport(
      ordersCsv([
        { ...FIRST_ROW, Name: "#3", "Created at": "2023-01-05 10:00:00 -0500" },
        { ...FIRST_ROW, Name: "#1", "Created at": "2021-02-01 10:00:00 -0500" },
        { ...FIRST_ROW, Name: "#2", "Created at": "" },
      ]),
    );
    expect(dateRange(parsed.orders)).toEqual({ first: "2021-02-01T15:00:00.000Z", last: "2023-01-05T15:00:00.000Z" });
    expect(dateRange([])).toEqual({ first: null, last: null });
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batches([], 2)).toEqual([]);
  });
});

describe("el historial es un archivo, no pedidos del Master (MOM §37)", () => {
  const migration = read("db/migrations/0273_shopify_history.sql");
  const actions = read("app/dashboard/stores/historial/actions.ts");

  it("las tablas tienen RLS por tienda y solo lectura para el panel", () => {
    for (const table of ["shopify_history_files", "shopify_history_orders", "shopify_history_customers"]) {
      expect(migration).toContain(`alter table ${table} enable row level security`);
      expect(migration).toMatch(new RegExp(`create policy ${table}_select on ${table} for select to authenticated`));
    }
    expect(migration).not.toMatch(/for (insert|update|delete|all) to authenticated/);
    expect(migration).not.toMatch(/grant (insert|update|delete)/);
    expect(migration).toContain("primary key (store_id, order_name)");
    expect(migration).toContain("primary key (store_id, customer_key)");
  });

  it("la subida pide «Descargar la base de pedidos», no duplica y no toca orders", () => {
    expect(actions.startsWith('"use server";')).toBe(true);
    expect(actions).toContain('can("data.export")');
    expect(actions).toContain('onConflict: "store_id,order_name"');
    expect(actions).toContain('onConflict: "store_id,customer_key"');
    expect(actions).not.toMatch(/from\("orders"\)|from\("order_master"\)|from\("order_events"\)/);
  });

  it("la prueba de acceso por API solo lee de Shopify y no guarda nada (§37.5)", () => {
    const from = actions.indexOf("export async function probeShopifyHistoryAccess");
    const to = actions.indexOf("\nexport ", from + 1);
    const probe = actions.slice(from, to === -1 ? undefined : to);
    expect(probe).toContain("await guard()");
    expect(probe).toContain('ordersCount(query: "created_at:<2022-01-01")');
    expect(probe).not.toMatch(/mutation|\.insert\(|\.upsert\(|\.update\(|\.delete\(/);
  });
});

describe("números de pedido repetidos en Shopify (§37.3)", () => {
  const row = (name: string, id: string | null, extra = "") => ({ order_name: name, shopify_order_id: id, extra });

  it("dos pedidos distintos con el mismo número se guardan los dos", () => {
    const out = uniqueOrderNames([row("#1234", "111"), row("#1234", "555")], new Map());
    expect(out.map((r) => r.order_name)).toEqual(["#1234", "#1234 · 555"]);
  });

  it("el mismo pedido repetido queda una vez, con lo último", () => {
    const out = uniqueOrderNames([row("#1234", "111", "viejo"), row("#1234", "111", "nuevo")], new Map());
    expect(out).toEqual([row("#1234", "111", "nuevo")]);
  });

  it("frente a lo ya guardado: otro id se aparta, el mismo id lo reemplaza", () => {
    const existing = new Map<string, string | null>([["#1234", "111"], ["#77", null]]);
    const out = uniqueOrderNames([row("#1234", "555"), row("#1234", "111"), row("#77", "9")], existing);
    expect(out.map((r) => r.order_name)).toEqual(["#1234 · 555", "#1234", "#77"]);
    // Volver a traer el apartado no lo duplica.
    const again = uniqueOrderNames([row("#1234", "555")], new Map([["#1234", "111"], ["#1234 · 555", "555"]]));
    expect(again.map((r) => r.order_name)).toEqual(["#1234 · 555"]);
  });
});
