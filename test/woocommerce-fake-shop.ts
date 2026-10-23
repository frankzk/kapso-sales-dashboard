// Un WooCommerce falso, en memoria, para las pruebas de «Generar pedido» y del
// buscador en WooCommerce (test/woocommerce-orders.test.ts y
// test/woocommerce-generate-order.test.ts). Imita lo que importa de la API
// REST v3:
//
//   · `POST /orders`: resuelve cada línea por `sku` (variación o producto
//     simple; un SKU desconocido deja la línea SIN producto, como
//     `WC_REST_Orders_V2_Controller::prepare_line_items`), respeta `subtotal`
//     y `total` si vienen (si no, el precio de catálogo), suma envío y total, y
//     numera `KP2000NN`;
//   · `GET /orders` (lista, con `after`, `_fields`) y `GET /orders/<id>`;
//   · `PUT /orders/<id>` (el estado) y `DELETE /orders/<id>?force=true`;
//   · `POST /orders/batch` (vacío: la prueba de escritura del cambio de
//     plataforma);
//   · `GET /products` (`search`; `sku`, que como en WooCommerce también trae
//     variaciones; `include`) y `GET /products/<id>/variations`.
//
// No es un archivo de pruebas (no termina en .test.ts): lo importan.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FakeProduct {
  id: number;
  name: string;
  sku: string;
  price: string;
  type: "simple" | "variable" | "variation" | "grouped";
  parentId?: number;
  attributes?: { name: string; option: string }[];
  stock?: number | null;
  image?: string;
  status?: string;
}

export interface FakeCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  auth: string | null;
}

type Fail = { status: number; body?: unknown } | "timeout" | "network";

export interface FakeShopOptions {
  products?: FakeProduct[];
  /** Un plugin que cambia el precio de una línea al guardar (por SKU). */
  repriceSku?: Record<string, string>;
  /** Un impuesto que la tienda suma (impuestos mal configurados). */
  tax?: string;
  /** Fallos por llamada: `"POST /orders"`, `"PUT /orders/501"`, `"GET /orders"`… (la primera vez). */
  failOnce?: Record<string, Fail>;
  /** Fallos que se repiten siempre. */
  failAlways?: Record<string, Fail>;
  /** El PUT se aplica pero la respuesta no llega (corte después de guardar). */
  putAppliesThenTimesOut?: boolean;
  /** El POST se crea pero la respuesta no llega. */
  postCreatesThenTimesOut?: boolean;
  /**
   * El primer POST no contesta (se corta) y WordPress lo guarda DESPUÉS, cuando
   * la prueba llama a `commitLate()`: el pedido no aparece en la búsqueda que
   * sigue al corte.
   */
  postCommitsLate?: boolean;
  /** Un plugin que deja el pedido en otro estado al crearlo (`processing`, `por-confirmar`…). */
  createdStatus?: string;
  /** Se llama antes de contestar cada llamada (para mover un reloj falso). */
  onCall?: (call: FakeCall) => void;
  firstId?: number;
  now?: () => Date;
}

function gmt(d: Date): string {
  return d.toISOString().slice(0, 19);
}

function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function timeoutError(): Error {
  const e = new Error("The operation was aborted due to timeout");
  e.name = "TimeoutError";
  return e;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

function pick(obj: Record<string, any>, fields: string | null): Record<string, any> {
  if (!fields) return obj;
  const out: Record<string, any> = {};
  for (const f of fields.split(",")) if (f in obj) out[f] = obj[f];
  return out;
}

export function fakeWooShop(opts: FakeShopOptions = {}) {
  const products = opts.products ?? [];
  const orders = new Map<number, any>();
  const calls: FakeCall[] = [];
  let nextId = opts.firstId ?? 501;
  const failedOnce = new Set<string>();
  const now = opts.now ?? (() => new Date());
  const late: any[] = [];
  let lateUsed = false;

  const bySku = (sku: string) => products.find((p) => p.sku === sku && p.type !== "variable" && p.type !== "grouped") ?? products.find((p) => p.sku === sku) ?? null;

  function priceOrder(o: any) {
    let subtotal = 0;
    let total = 0;
    for (const li of o.line_items) {
      subtotal += Number(li.subtotal);
      total += Number(li.total);
    }
    const shipping = (o.shipping_lines ?? []).reduce((s: number, l: any) => s + Number(l.total ?? 0), 0);
    const tax = Number(opts.tax ?? 0);
    o.discount_total = money(subtotal - total);
    o.shipping_total = money(shipping);
    o.total_tax = money(tax);
    o.total = money(total + shipping + tax);
  }

  function createOrder(body: any): any {
    const id = nextId++;
    const at = gmt(now());
    const lineItems = (body.line_items ?? []).map((li: any, i: number) => {
      const p = li.sku ? bySku(String(li.sku)) : null;
      const qty = Number(li.quantity ?? 1);
      const catalog = p ? Number(p.price) * qty : 0;
      let subtotal = li.subtotal != null ? li.subtotal : money(catalog);
      let total = li.total != null ? li.total : subtotal;
      if (p && opts.repriceSku?.[p.sku] != null) {
        subtotal = money(Number(opts.repriceSku[p.sku]) * qty);
        total = subtotal;
      }
      const parent = p?.type === "variation" ? products.find((x) => x.id === p.parentId) : null;
      return {
        id: 9000 + i,
        name: p ? (parent ? `${parent.name} - ${(p.attributes ?? []).map((a) => a.option).join(", ")}` : p.name) : "",
        parent_name: parent ? parent.name : null,
        product_id: p ? (parent ? parent.id : p.id) : 0,
        variation_id: p && parent ? p.id : 0,
        quantity: qty,
        subtotal: money(Number(subtotal)),
        subtotal_tax: "0.00",
        total: money(Number(total)),
        total_tax: "0.00",
        sku: p ? p.sku : null,
        price: qty ? Number(total) / qty : 0,
        meta_data: parent ? (p!.attributes ?? []).map((a, k) => ({ id: k + 1, key: a.name, value: a.option, display_value: a.option })) : [],
      };
    });
    const o: any = {
      id,
      number: `KP${200000 + id}`,
      status: opts.createdStatus ?? body.status ?? "pending",
      currency: "PEN",
      created_via: "rest-api",
      date_created_gmt: at,
      date_modified_gmt: at,
      prices_include_tax: false,
      customer_id: 0,
      customer_note: body.customer_note ?? "",
      billing: { ...(body.billing ?? {}), email: "" },
      shipping: { ...(body.shipping ?? {}) },
      payment_method: body.payment_method ?? "",
      payment_method_title: body.payment_method_title ?? "",
      date_paid_gmt: null,
      meta_data: (body.meta_data ?? []).map((m: any, k: number) => ({ id: 100 + k, key: m.key, value: m.value })),
      line_items: lineItems,
      shipping_lines: (body.shipping_lines ?? []).map((l: any, k: number) => ({ id: 7000 + k, ...l, total: money(Number(l.total ?? 0)) })),
      fee_lines: [],
      coupon_lines: [],
      refunds: [],
    };
    priceOrder(o);
    orders.set(id, o);
    return o;
  }

  function failFor(key: string): Fail | null {
    if (opts.failAlways?.[key]) return opts.failAlways[key]!;
    if (opts.failOnce?.[key] && !failedOnce.has(key)) {
      failedOnce.add(key);
      return opts.failOnce[key]!;
    }
    return null;
  }

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^.*\/wp-json\/wc\/v3/, "");
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call = { method, path, query: url.searchParams, body, auth: headers.get("authorization") };
    calls.push(call);
    opts.onCall?.(call);

    const key = `${method} ${path}`;
    const fail = failFor(key);
    if (fail === "timeout") throw timeoutError();
    if (fail === "network") throw new TypeError("fetch failed");
    if (fail) return json(fail.body ?? { code: "error", message: "falló" }, fail.status);

    if (method === "POST" && path === "/orders/batch") {
      // Sin create/update/delete no hace nada: WooCommerce contesta una lista vacía.
      return json([]);
    }
    if (method === "POST" && path === "/orders") {
      if (opts.postCommitsLate && !lateUsed) {
        lateUsed = true;
        late.push(body);
        throw timeoutError();
      }
      const o = createOrder(body);
      if (opts.postCreatesThenTimesOut) throw timeoutError();
      return json(o, 201);
    }
    const one = path.match(/^\/orders\/(\d+)$/);
    if (one) {
      const id = Number(one[1]);
      const o = orders.get(id);
      if (method === "DELETE") {
        if (!o) return json({ code: "woocommerce_rest_shop_order_invalid_id", message: "ID inválido." }, 404);
        orders.delete(id);
        return json(o);
      }
      if (!o) return json({ code: "woocommerce_rest_shop_order_invalid_id", message: "ID inválido." }, 404);
      if (method === "PUT") {
        if (body?.status) o.status = body.status;
        if (body?.status === "processing") o.date_paid_gmt = gmt(now());
        o.date_modified_gmt = gmt(new Date(now().getTime() + 1000));
        if (opts.putAppliesThenTimesOut) throw timeoutError();
        return json(o);
      }
      return json(o);
    }
    if (method === "GET" && path === "/orders") {
      const after = url.searchParams.get("after");
      const list = [...orders.values()]
        .filter((o) => !after || o.date_created_gmt > after)
        .sort((a, b) => b.id - a.id)
        .map((o) => pick(o, url.searchParams.get("_fields")));
      return json(list, 200, { "x-wp-total": String(list.length), "x-wp-totalpages": "1" });
    }
    if (method === "GET" && path === "/products") {
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      const sku = url.searchParams.get("sku");
      const include = url.searchParams.get("include");
      const status = url.searchParams.get("status");
      const ids = include ? include.split(",").map(Number) : null;
      const list = products
        // Con `sku`, WooCommerce busca también entre las variaciones (post_type
        // producto y variación); sin él, solo productos.
        .filter((p) => (sku ? true : p.type !== "variation"))
        .filter((p) => !status || (p.status ?? "publish") === status)
        .filter((p) => (ids ? ids.includes(p.id) : sku ? p.sku === sku : !search || p.name.toLowerCase().includes(search)))
        .map((p) => {
          const parent = p.type === "variation" ? products.find((x) => x.id === p.parentId) : null;
          return pick(
            {
              id: p.id,
              name: parent ? `${parent.name} - ${(p.attributes ?? []).map((a) => a.option).join(", ")}` : p.name,
              type: p.type,
              status: p.status ?? "publish",
              sku: p.sku,
              price: p.price,
              stock_quantity: p.stock ?? null,
              images: p.image ? [{ src: p.image }] : [],
              parent_id: p.parentId ?? 0,
              attributes: p.type === "variation" ? (p.attributes ?? []).map((a) => ({ id: 0, name: a.name, option: a.option })) : [],
            },
            url.searchParams.get("_fields"),
          );
        });
      return json(list);
    }
    const vars = path.match(/^\/products\/(\d+)\/variations$/);
    if (method === "GET" && vars) {
      const parent = products.find((p) => p.id === Number(vars[1]));
      const list = products
        .filter((p) => p.type === "variation" && p.parentId === Number(vars[1]))
        .map((p) => ({
          id: p.id,
          // WooCommerce muestra el SKU del padre en una variación sin SKU propio.
          sku: p.sku || parent?.sku || "",
          price: p.price,
          stock_quantity: p.stock ?? null,
          status: p.status ?? "publish",
          attributes: p.attributes ?? [],
        }));
      return json(list);
    }
    return json({ code: "rest_no_route", message: "No route" }, 404);
  };

  /** Guarda ahora los POST que se cortaron (`postCommitsLate`): los pedidos aparecen recién aquí. */
  const commitLate = () => late.splice(0).map((b) => createOrder(b));

  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, orders, commitLate };
}

/** El catálogo de prueba: un simple, un regalo y un variable con dos tallas (una sin SKU propio). */
export const CATALOG: FakeProduct[] = [
  { id: 10, name: "EggMixer", sku: "EGG-1", price: "89.00", type: "simple", stock: 7, image: "https://kenku.pe/wp-content/uploads/egg.jpg" },
  { id: 11, name: "Papel Freidora", sku: "PAPEL-1", price: "79.00", type: "simple" },
  { id: 20, name: "Polo &amp; Short", sku: "POLO", price: "", type: "variable", image: "https://kenku.pe/wp-content/uploads/polo.jpg" },
  { id: 21, name: "", sku: "POLO-M", price: "59.90", type: "variation", parentId: 20, attributes: [{ name: "Talla", option: "M" }], stock: 3 },
  { id: 22, name: "", sku: "", price: "59.90", type: "variation", parentId: 20, attributes: [{ name: "Talla", option: "L" }] },
  { id: 30, name: "Pack regalo", sku: "PACK", price: "10.00", type: "grouped" },
];
