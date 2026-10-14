import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Canal de cierre de todas las ventas (MOM §17.3, migración 0258).
//
// Lo que se fija: que el resumen cuadre (Σ canales = Σ grupos = total), que la
// asesora nunca traiga «ayudados», que una función ausente vuelva a la vista
// anterior en vez de dar ceros, y que el ORDEN de los canales sea el mismo en la
// función SQL, en el código y en el MOM. Y del lado de la escritura: que las
// tres vías que crean pedidos ya no escriban `kapso` en la copia local ni pisen
// la fila que trajo Shopify.

vi.mock("server-only", () => ({}));
type RpcResult = { data: unknown; error: null | { code?: string; message: string } };
const rpc = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as null | { code?: string; message: string } },
  // Si está, responde por llamada (una por tienda): gana sobre `result`.
  handler: null as null | ((name: string, args: Record<string, unknown>) => RpcResult),
  calls: [] as Record<string, unknown>[],
  // Las tablas que lee el inicio de cada tienda (stores, order_sales, leads), y
  // las que tienen que fallar.
  tables: {} as Record<string, Record<string, unknown>[]>,
  failing: {} as Record<string, string>,
}));
vi.mock("@/lib/db", () => {
  // Lo justo de PostgREST para `select().eq()/in().order().limit().maybeSingle()`
  // y para `await select().in()`.
  const from = (table: string) => {
    let rows = [...(rpc.tables[table] ?? [])];
    const error = rpc.failing[table] ? { code: "PGRST003", message: rpc.failing[table] } : null;
    const q: any = {
      select: () => q,
      eq: (k: string, v: unknown) => ((rows = rows.filter((r) => r[k] === v)), q),
      in: (k: string, vs: unknown[]) => ((rows = rows.filter((r) => vs.includes(r[k]))), q),
      order: (k: string, o: { ascending: boolean }) => (
        (rows = [...rows].sort((a, b) => (String(a[k]) < String(b[k]) ? -1 : 1) * (o.ascending ? 1 : -1))), q
      ),
      limit: (n: number) => ((rows = rows.slice(0, n)), q),
      maybeSingle: async () => (error ? { data: null, error } : { data: rows[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve(error ? { data: null, error } : { data: rows, error: null }).then(ok),
    };
    return q;
  };
  const client = {
    from,
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpc.calls.push(args);
      return rpc.handler ? rpc.handler(name, args) : rpc.result;
    },
  };
  return { createServerSupabase: async () => client, createAdminSupabase: () => client };
});

import {
  CLOSING_CHANNELS,
  CHANNEL_LABEL,
  isMissingFunctionError,
  parseClosingChannels,
  summarizeClosingChannels,
} from "@/lib/closing-channel";
import { comparablePrev, coverageCopy, noCoverageCopy, planWindows, type WindowPlan } from "@/lib/sales-coverage";
import { getClosingChannels } from "@/lib/access";
import { insertOrderIfAbsent, recomputeRollupsForLocalDay } from "@/lib/order-sale";
import { getDraftOrderOrder } from "@/lib/shopify";
import { ClosingChannels } from "@/components/closing-channels";

const read = (p: string) => readFileSync(p, "utf8");

const fila = (o: Record<string, unknown>) => ({
  store_id: "A",
  canal: "web",
  pedidos: 0,
  ingresos: 0,
  cancelados: 0,
  ayudados: 0,
  ingresos_ayudados: 0,
  ...o,
});

describe("parseClosingChannels", () => {
  it("lee el jsonb de la función y tipa los números", () => {
    const rows = parseClosingChannels({
      version: 1,
      filas: [fila({ canal: "asesora", pedidos: "3", ingresos: "450.5", cancelados: 1 })],
    });
    expect(rows).toEqual([
      { storeId: "A", channel: "asesora", orders: 3, revenue: 450.5, cancelled: 1, assisted: 0, assistedRevenue: 0 },
    ]);
  });

  it("un canal desconocido se suma a «otros» en vez de perderse", () => {
    const rows = parseClosingChannels({ filas: [fila({ canal: "nuevo_canal", pedidos: 2, ingresos: 100 })] });
    expect(rows[0]!.channel).toBe("otros");
    expect(summarizeClosingChannels(rows).total.orders).toBe(2);
  });

  it("sin filas o con basura, ninguna fila", () => {
    expect(parseClosingChannels(null)).toEqual([]);
    expect(parseClosingChannels({ filas: "x" })).toEqual([]);
  });
});

describe("summarizeClosingChannels", () => {
  const rows = parseClosingChannels({
    filas: [
      fila({ store_id: "A", canal: "asesora", pedidos: 10, ingresos: 1000, cancelados: 2, ayudados: 4, ingresos_ayudados: 400 }),
      fila({ store_id: "B", canal: "asesora", pedidos: 5, ingresos: 500 }),
      fila({ store_id: "A", canal: "bot_kapso", pedidos: 4, ingresos: 400.1, ayudados: 1, ingresos_ayudados: 100 }),
      fila({ store_id: "A", canal: "bot_externo", pedidos: 1, ingresos: 50 }),
      fila({ store_id: "A", canal: "recompra_auto", pedidos: 1, ingresos: 60 }),
      fila({ store_id: "A", canal: "web", pedidos: 20, ingresos: 2000.2, cancelados: 7, ayudados: 2, ingresos_ayudados: 210 }),
      fila({ store_id: "A", canal: "otros", pedidos: 1, ingresos: 30 }),
    ],
  });
  const s = summarizeClosingChannels(rows);

  it("suma las tiendas por canal", () => {
    expect(s.byChannel.asesora.orders).toBe(15);
    expect(s.byChannel.asesora.revenue).toBe(1500);
  });

  it("la asesora nunca trae «ayudados»: ayudar a su propia venta no es ayudar", () => {
    expect(s.byChannel.asesora.assisted).toBe(0);
    expect(s.byChannel.asesora.assistedRevenue).toBe(0);
  });

  it("Σ canales = Σ grupos = total, con cancelados aparte", () => {
    const sumCh = CLOSING_CHANNELS.reduce((a, c) => a + s.byChannel[c].revenue, 0);
    const sumGr = Object.values(s.byGroup).reduce((a, g) => a + g.revenue, 0);
    expect(Math.round(sumCh * 100) / 100).toBe(s.total.revenue);
    expect(Math.round(sumGr * 100) / 100).toBe(s.total.revenue);
    expect(s.total.orders).toBe(42);
    expect(s.total.cancelled).toBe(9);
    expect(s.total.revenue).toBe(4040.3);
  });

  it("los grupos: asesora / bot o automatización / web / otros", () => {
    expect(s.byGroup.humano.orders).toBe(15);
    expect(s.byGroup.automatizacion.orders).toBe(6); // bot_kapso + bot_externo + recompra_auto
    expect(s.byGroup.web.orders).toBe(20);
    expect(s.byGroup.otros.orders).toBe(1);
    expect(s.byGroup.automatizacion.assisted).toBe(1);
  });

  it("sin filas, todo en cero (no undefined)", () => {
    const z = summarizeClosingChannels([]);
    expect(z.total).toEqual({ orders: 0, revenue: 0, cancelled: 0, assisted: 0, assistedRevenue: 0 });
    expect(Object.keys(z.byChannel)).toEqual([...CLOSING_CHANNELS]);
  });
});

describe("isMissingFunctionError", () => {
  it("reconoce la función ausente por código o por mensaje", () => {
    expect(isMissingFunctionError({ code: "PGRST202", message: "x" })).toBe(true);
    expect(isMissingFunctionError({ code: "42883", message: "x" })).toBe(true);
    expect(
      isMissingFunctionError({ message: "Could not find the function public.canal_de_cierre(p_from, p_store_ids, p_to) in the schema cache" }),
    ).toBe(true);
  });

  it("cualquier otro error NO es «falta la migración»", () => {
    expect(isMissingFunctionError({ code: "57014", message: "canceling statement due to statement timeout" })).toBe(false);
    expect(isMissingFunctionError(null)).toBe(false);
  });
});

describe("planWindows: cada tienda cuenta desde su propio día", () => {
  const julio = { from: "2026-07-01", to: "2026-07-31" };

  it("con dos tiendas, cada una en su ventana: no se recorta a todas al día de la última", () => {
    expect(planWindows("2026-06-01", [{ id: "A", start: "2026-06-25" }, { id: "B", start: "2026-07-04" }], julio)).toEqual({
      windows: [
        { storeId: "A", from: "2026-07-01", to: "2026-07-31", floor: "2026-06-25", cause: "tienda", clipped: false },
        { storeId: "B", from: "2026-07-04", to: "2026-07-31", floor: "2026-07-04", cause: "tienda", clipped: true },
      ],
      later: [],
      excluded: [],
      multiStore: true,
    });
  });

  it("si ORDERS_SYNC_FROM es posterior al inicio de la tienda, manda él y lo dice", () => {
    const p = planWindows("2026-07-08", [{ id: "A", start: "2026-06-25" }], julio);
    expect(p.windows).toEqual([{ storeId: "A", from: "2026-07-08", to: "2026-07-31", floor: "2026-07-08", cause: "sync", clipped: true }]);
    expect(p.multiStore).toBe(false);
  });

  it("una tienda que empieza después del periodo no cuenta en cero: queda aparte, con su día", () => {
    const p = planWindows("2026-06-01", [{ id: "A", start: "2026-06-25" }, { id: "B", start: "2026-07-04" }], { from: "2026-06-01", to: "2026-06-30" });
    expect(p.windows.map((w) => w.storeId)).toEqual(["A"]);
    expect(p.later).toEqual([{ storeId: "B", floor: "2026-07-04", cause: "tienda" }]);
  });

  it("una tienda que todavía no usa Kapta queda fuera y se nombra", () => {
    const p = planWindows("2026-06-01", [{ id: "A", start: "2026-06-25" }, { id: "Z", start: null }], julio);
    expect(p.windows.map((w) => w.storeId)).toEqual(["A"]);
    expect(p.excluded).toEqual(["Z"]);
  });
});

describe("comparablePrev: el cambio contra el anterior solo si las dos ventanas están enteras", () => {
  const plan = (windows: Partial<WindowPlan["windows"][number]>[]): WindowPlan => ({
    windows: windows.map((w) => ({ storeId: "A", from: "x", to: "y", floor: "2026-06-25", cause: "tienda", clipped: false, ...w })),
    later: [],
    excluded: [],
    multiStore: windows.length > 1,
  });

  it("cada tienda entera en los dos periodos: se compara", () => {
    expect(comparablePrev(plan([{ storeId: "A" }, { storeId: "B" }]), plan([{ storeId: "A" }, { storeId: "B" }]))).toBe(true);
  });

  it("el periodo actual recortado: no", () => {
    expect(comparablePrev(plan([{ storeId: "A", clipped: true }]), plan([{ storeId: "A" }]))).toBe(false);
  });

  it("una tienda recortada o ausente en el anterior: no (el anterior saldría con menos ventas de las que hubo)", () => {
    expect(comparablePrev(plan([{ storeId: "A" }, { storeId: "B" }]), plan([{ storeId: "A" }, { storeId: "B", clipped: true }]))).toBe(false);
    expect(comparablePrev(plan([{ storeId: "A" }, { storeId: "B" }]), plan([{ storeId: "A" }]))).toBe(false);
  });

  it("sin ventanas, nada que comparar", () => {
    expect(comparablePrev(plan([]), plan([]))).toBe(false);
  });
});

// Las dos tiendas de producción: la primera venta registrada en Kapta es del
// 25-06-2026 (23:50 de Lima) en una y del 04-07-2026 en la otra.
const TIENDAS = {
  stores: [
    { id: "A", timezone: "America/Lima" },
    { id: "B", timezone: "America/Lima" },
    { id: "C", timezone: "America/Lima" },
    { id: "D", timezone: null },
  ],
  order_sales: [
    { store_id: "A", occurred_at: "2026-07-10T15:00:00.000Z" },
    { store_id: "A", occurred_at: "2026-06-26T04:50:55.000Z" },
    { store_id: "B", occurred_at: "2026-07-04T20:03:26.000Z" },
  ],
  leads: [
    { store_id: "A", created_at: "2026-06-23T02:40:04.000Z" },
    { store_id: "C", created_at: "2026-08-02T03:00:00.000Z" },
  ],
};

describe("getClosingChannels", () => {
  beforeEach(() => {
    rpc.result = { data: null, error: null };
    rpc.handler = null;
    rpc.calls = [];
    rpc.tables = TIENDAS;
    rpc.failing = {};
    vi.unstubAllEnvs();
  });

  it("con la función: el resumen, sin recorte", async () => {
    rpc.result = { data: { version: 1, filas: [fila({ canal: "asesora", pedidos: 2, ingresos: 300 })] }, error: null };
    const r = await getClosingChannels(["A"], { from: "2026-09-14", to: "2026-10-13" });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.summary.byChannel.asesora.revenue).toBe(300);
      expect(r.plan.windows).toEqual([
        { storeId: "A", from: "2026-09-14", to: "2026-10-13", floor: "2026-06-25", cause: "tienda", clipped: false },
      ]);
    }
    expect(rpc.calls).toEqual([{ p_store_ids: ["A"], p_from: "2026-09-14", p_to: "2026-10-13" }]);
  });

  it("antes de la primera venta registrada en Kapta no se cuenta: desde ese día local, y se dice", async () => {
    rpc.result = { data: { version: 1, filas: [] }, error: null };
    const r = await getClosingChannels(["A"], { from: "2026-06-01", to: "2026-06-30" });
    // 2026-06-26T04:50Z es el 25-06 a las 23:50 en Lima.
    expect(rpc.calls).toEqual([{ p_store_ids: ["A"], p_from: "2026-06-25", p_to: "2026-06-30" }]);
    expect(r).toMatchObject({ status: "ok", plan: { windows: [{ from: "2026-06-25", cause: "tienda", clipped: true }], multiStore: false } });
  });

  it("junio entero en la tienda que empezó el 04-07: `sin_cobertura`, nunca un «0 % asesora»", async () => {
    const r = await getClosingChannels(["B"], { from: "2026-06-01", to: "2026-06-30" });
    expect(r).toEqual({
      status: "sin_cobertura",
      plan: { windows: [], later: [{ storeId: "B", floor: "2026-07-04", cause: "tienda" }], excluded: [], multiStore: false },
    });
    expect(rpc.calls).toEqual([]);
  });

  it("con varias tiendas, una llamada por tienda en su propia ventana, y se suman", async () => {
    rpc.handler = (_name, args) => ({
      data: { version: 1, filas: [fila({ store_id: (args.p_store_ids as string[])[0], canal: "asesora", pedidos: 1, ingresos: 100 })] },
      error: null,
    });
    const r = await getClosingChannels(["A", "B"], { from: "2026-07-01", to: "2026-07-31" });
    expect(rpc.calls).toEqual([
      { p_store_ids: ["A"], p_from: "2026-07-01", p_to: "2026-07-31" },
      { p_store_ids: ["B"], p_from: "2026-07-04", p_to: "2026-07-31" },
    ]);
    expect(r).toMatchObject({ status: "ok", summary: { byChannel: { asesora: { orders: 2, revenue: 200 } } }, plan: { multiStore: true } });
  });

  it("una tienda sin ventas registradas empieza en su primer lead", async () => {
    rpc.result = { data: { version: 1, filas: [] }, error: null };
    const c = await getClosingChannels(["C"], { from: "2026-07-01", to: "2026-08-31" });
    expect(c).toMatchObject({ status: "ok", plan: { windows: [{ from: "2026-08-01" }] } }); // 03:00Z = 22:00 del 01-08 en Lima
  });

  it("una tienda que todavía no usa Kapta: sola, `sin_cobertura`; con otras, fuera del conteo y nombrada", async () => {
    const d = await getClosingChannels(["D"], { from: "2026-09-14", to: "2026-10-13" });
    expect(d).toEqual({ status: "sin_cobertura", plan: { windows: [], later: [], excluded: ["D"], multiStore: false } });
    expect(rpc.calls).toEqual([]);

    rpc.result = { data: { version: 1, filas: [] }, error: null };
    const ad = await getClosingChannels(["A", "D"], { from: "2026-09-14", to: "2026-10-13" });
    expect(rpc.calls).toEqual([{ p_store_ids: ["A"], p_from: "2026-09-14", p_to: "2026-10-13" }]);
    expect(ad).toMatchObject({ status: "ok", plan: { excluded: ["D"], multiStore: true } });
  });

  it("si no se puede leer desde cuándo usa Kapta una tienda, es un error: nunca un periodo sin recortar", async () => {
    rpc.failing = { order_sales: "pool timeout" };
    const r = await getClosingChannels(["B"], { from: "2026-06-01", to: "2026-06-30" });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.message).toContain("pool timeout");
    expect(rpc.calls).toEqual([]);

    rpc.failing = { stores: "boom" };
    expect((await getClosingChannels(["A"], { from: "2026-09-14", to: "2026-10-13" })).status).toBe("error");
  });

  it("un periodo entero antes de ORDERS_SYNC_FROM: `sin_cobertura`, sin preguntarle a la función", async () => {
    vi.stubEnv("ORDERS_SYNC_FROM", "2026-08-01");
    const r = await getClosingChannels(["A"], { from: "2026-07-01", to: "2026-07-31" });
    expect(r).toMatchObject({ status: "sin_cobertura", plan: { later: [{ storeId: "A", floor: "2026-08-01", cause: "sync" }] } });
    expect(rpc.calls).toEqual([]);
  });

  it("ORDERS_SYNC_FROM sigue siendo el piso: adelantarlo recorta a cada tienda", async () => {
    vi.stubEnv("ORDERS_SYNC_FROM", "2026-07-08");
    rpc.result = { data: { version: 1, filas: [] }, error: null };
    const r = await getClosingChannels(["A", "B"], { from: "2026-07-01", to: "2026-07-14" });
    expect(rpc.calls.map((c) => c.p_from)).toEqual(["2026-07-08", "2026-07-08"]);
    expect(r).toMatchObject({ status: "ok", plan: { windows: [{ cause: "sync" }, { cause: "sync" }] } });
  });

  it("sin la migración: `sin_migracion`, nunca ceros", async () => {
    rpc.result = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    expect(await getClosingChannels(["A"], { from: "2026-09-14", to: "2026-10-13" })).toEqual({ status: "sin_migracion" });
  });

  it("otro error se dice tal cual", async () => {
    rpc.result = { data: null, error: { code: "57014", message: "statement timeout" } };
    expect(await getClosingChannels(["A"], { from: "2026-09-14", to: "2026-10-13" })).toEqual({
      status: "error",
      message: "statement timeout",
    });
  });

  it("si falla UNA de las tiendas, es un error: nunca un total con una tienda de menos", async () => {
    rpc.handler = (_name, args) =>
      (args.p_store_ids as string[])[0] === "B"
        ? { data: null, error: { code: "57014", message: "statement timeout" } }
        : { data: { version: 1, filas: [fila({ canal: "asesora", pedidos: 1, ingresos: 100 })] }, error: null };
    expect(await getClosingChannels(["A", "B"], { from: "2026-07-01", to: "2026-07-31" })).toEqual({
      status: "error",
      message: "statement timeout",
    });
  });
});

// ── Escritura: la copia local ya no inventa etiquetas ni pisa a Shopify ──────

type Row = Record<string, unknown>;
function fakeOrders(existing: Row[] = []) {
  const rows = [...existing];
  const calls: { op: string; row?: Row; opts?: Row }[] = [];
  const from = (table: string) => {
    expect(table).toBe("orders");
    const filters: [string, unknown][] = [];
    let upserted: Row | null = null;
    const q: any = {
      upsert: (row: Row, opts: Row) => {
        calls.push({ op: "upsert", row, opts });
        const dup = rows.find((r) => r.store_id === row.store_id && r.shopify_order_id === row.shopify_order_id);
        if (!dup) {
          upserted = { id: `nuevo-${rows.length}`, ...row };
          rows.push(upserted);
        } else if (!opts?.ignoreDuplicates) {
          Object.assign(dup, row);
          upserted = dup;
        }
        return q;
      },
      select: () => q,
      eq: (k: string, v: unknown) => {
        filters.push([k, v]);
        return q;
      },
      maybeSingle: async () => {
        if (calls.at(-1)?.op === "upsert" && !filters.length) return { data: upserted ? { id: upserted.id } : null, error: null };
        const hit = rows.find((r) => filters.every(([k, v]) => r[k] === v));
        return { data: hit ? { id: hit.id } : null, error: null };
      },
    };
    return q;
  };
  return { client: { from } as any, rows, calls };
}

describe("insertOrderIfAbsent", () => {
  it("si el pedido no está, lo inserta y devuelve su id", async () => {
    const f = fakeOrders();
    const r = await insertOrderIfAbsent(f.client, { store_id: "A", shopify_order_id: "123", tags: ["venta_manual"] });
    expect(r).toEqual({ id: "nuevo-0", error: null });
    expect(f.calls[0]!.opts).toMatchObject({ onConflict: "store_id,shopify_order_id", ignoreDuplicates: true });
  });

  it("si el webhook ya lo trajo, NO lo pisa y devuelve el id existente", async () => {
    const shopifyRow = { id: "real", store_id: "A", shopify_order_id: "123", tags: ["easysell_cod_form"], created_at: "2026-10-13T20:00:00Z" };
    const f = fakeOrders([shopifyRow]);
    const r = await insertOrderIfAbsent(f.client, { store_id: "A", shopify_order_id: "123", tags: [], created_at: "2026-10-13T20:05:00Z" });
    expect(r).toEqual({ id: "real", error: null });
    expect(f.rows[0]).toEqual(shopifyRow);
  });
});

describe("recomputeRollupsForLocalDay", () => {
  it("recalcula el día de Lima, no el UTC (venta a las 21:00 de Lima)", async () => {
    const rpcCalls: Row[] = [];
    const admin: any = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { timezone: "America/Lima" }, error: null }) }) }) }),
      rpc: async (_name: string, args: Row) => {
        rpcCalls.push(args);
        return { data: null, error: null };
      },
    };
    await recomputeRollupsForLocalDay(admin, "A", "2026-10-14T02:00:00.000Z");
    expect(rpcCalls).toEqual([{ p_store_id: "A", p_from: "2026-10-13", p_to: "2026-10-13" }]);
  });
});

describe("getDraftOrderOrder: el pedido real de un borrador ya completado", () => {
  const fakeFetch = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  const base = { domain: "x.myshopify.com", token: "t", gid: "gid://shopify/DraftOrder/7" };

  it("devuelve el gid y el nombre del pedido", async () => {
    const r = await getDraftOrderOrder({
      ...base,
      fetchImpl: fakeFetch({ data: { draftOrder: { id: base.gid, order: { id: "gid://shopify/Order/99", name: "#KP1" } } } }),
    });
    expect(r).toEqual({ orderGid: "gid://shopify/Order/99", orderName: "#KP1" });
  });

  it("un borrador sin pedido (o que no existe) da null, no un pedido inventado", async () => {
    expect(await getDraftOrderOrder({ ...base, fetchImpl: fakeFetch({ data: { draftOrder: { id: base.gid, order: null } } }) })).toBeNull();
    expect(await getDraftOrderOrder({ ...base, fetchImpl: fakeFetch({ data: { draftOrder: null } }) })).toBeNull();
  });
});

describe("las tres vías que crean pedidos ya no inventan `kapso`", () => {
  it("generateOrder: inserta si falta, sin `kapso`, y recalcula el día local", () => {
    const src = read("app/dashboard/leads/actions.ts");
    const gen = src.slice(src.indexOf("export async function generateOrder"));
    expect(gen).toContain("insertOrderIfAbsent(admin, {");
    expect(gen).not.toMatch(/tags:\s*reuseExistingDraft\s*\?\s*\[\s*"kapso"/);
    expect(gen).not.toContain('nowIso.slice(0, 10)');
    expect(gen).toContain("recomputeRollupsForLocalDay(admin, ctx.storeId, nowIso)");
  });

  it("generateOrder: si Shopify dice «ya completado», busca el pedido REAL del borrador", () => {
    const src = read("app/dashboard/leads/actions.ts");
    const gen = src.slice(src.indexOf("export async function generateOrder"));
    const rama = gen.slice(gen.indexOf("/already.*complet"), gen.indexOf("write_draft_orders|access denied"));
    expect(rama).toContain("getDraftOrderOrder({ ...sclient, gid: draftGid })");
    expect(rama).not.toMatch(/orderGid:\s*null,\s*orderName:\s*null/);
  });

  it("recoverCart (sin uso hoy) tampoco pisa la fila de Shopify ni escribe `kapso`", () => {
    const src = read("app/dashboard/leads/actions.ts");
    const rec = src.slice(src.indexOf("export async function recoverCart"), src.indexOf("const WINDOW_MS"));
    expect(rec).toContain("insertOrderIfAbsent(admin, {");
    expect(rec).toContain("getDraftOrderOrder(");
    expect(rec).not.toContain('"kapso"');
    expect(rec).not.toContain(".upsert(");
  });

  it("carrito recuperado sin asesora y recompra automática: sin etiquetas locales", () => {
    const ingest = read("lib/leads-ingest.ts");
    const trials = read("lib/auto-order-trials.ts");
    expect(ingest).not.toMatch(/order\.tags\s*=\s*\[\.\.\.new Set\(\[\.\.\.order\.tags,\s*"kapso"/);
    expect(trials).not.toMatch(/order\.tags\s*=\s*\[\.\.\.new Set\(\[\.\.\.order\.tags,\s*"kapso"/);
    expect(ingest).toContain("insertOrderIfAbsent(admin,");
    expect(trials).toContain("insertOrderIfAbsent(admin,");
  });
});

describe("el orden de los canales es uno solo: SQL, código y MOM", () => {
  it("la función 0258 evalúa los canales en el orden de CLOSING_CHANNELS", () => {
    const sql = read("db/migrations/0258_canal_de_cierre.sql");
    const body = sql.slice(sql.indexOf("as $$"));
    const order = [...body.matchAll(/then '([a-z_]+)'|else '([a-z_]+)'/g)].map((m) => m[1] ?? m[2]);
    expect(order).toEqual([...CLOSING_CHANNELS]);
  });

  it("la vista `pedidos_canal` de la 0259, que hoy usa la función, también", () => {
    const sql = read("db/migrations/0259_ventas_por_origen.sql");
    const view = sql.slice(sql.indexOf("create or replace view public.pedidos_canal"), sql.indexOf("revoke all on public.pedidos_canal"));
    const order = [...view.matchAll(/then '([a-z_]+)'|else '([a-z_]+)'/g)].map((m) => m[1] ?? m[2]);
    expect(order).toEqual([...CLOSING_CHANNELS]);
  });

  it("la tabla del MOM §17.3 lista los canales en ese mismo orden", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    const sec = mom.slice(mom.indexOf("### 17.3 Canal de cierre"), mom.indexOf("### 17.4 Ventas del periodo por origen"));
    const titles = [...sec.matchAll(/^\| (\d) \| ([^|]+?) \|/gm)].map((m) => m[2]!.trim());
    expect(titles).toEqual(CLOSING_CHANNELS.map((c) => CHANNEL_LABEL[c].title));
  });

  it("la función es de lectura, con la sesión de quien mira y sin anon", () => {
    const sql = read("db/migrations/0258_canal_de_cierre.sql");
    expect(sql).toMatch(/security invoker/);
    expect(sql).toMatch(/revoke all on function public\.canal_de_cierre\(uuid\[\], date, date\) from public, anon;/);
    expect(sql).not.toMatch(/^\s*(insert|update|delete|drop|truncate)\b/im);
  });
});

describe("los textos de la cobertura dicen qué fijó el día", () => {
  const name = (id: string) => ({ A: "Tienda Uno", B: "Tienda Dos", Z: "Tienda Nueva" })[id] ?? "?";
  const day = (iso: string) => `día ${iso}`;
  const win = (o: Partial<WindowPlan["windows"][number]>) => ({
    storeId: "A",
    from: "2026-07-01",
    to: "2026-07-31",
    floor: "2026-06-25",
    cause: "tienda" as const,
    clipped: false,
    ...o,
  });
  const plan = (o: Partial<WindowPlan>): WindowPlan => ({ windows: [], later: [], excluded: [], multiStore: false, ...o });

  it("sin recorte ni tiendas fuera, nada que decir", () => {
    expect(coverageCopy(plan({ windows: [win({})] }), name, day)).toEqual({ title: null, body: null, sub: [] });
    expect(coverageCopy(plan({ windows: [win({}), win({ storeId: "B" })], multiStore: true }), name, day)).toEqual({ title: null, body: null, sub: [] });
  });

  it("una tienda: el día en que empezó a usar Kapta, y por qué recorta", () => {
    const c = coverageCopy(plan({ windows: [win({ storeId: "B", from: "2026-07-04", floor: "2026-07-04", clipped: true })] }), name, day);
    expect(c.title).toBe("Cuenta desde el día 2026-07-04");
    expect(c.sub).toEqual(["desde el día 2026-07-04"]);
    expect(c.body).toContain("Ese día Tienda Dos empezó a usar Kapta");
    expect(c.body).toContain("«Web» u «Otros»");
  });

  it("si lo fijó ORDERS_SYNC_FROM, no culpa a las asesoras", () => {
    const c = coverageCopy(plan({ windows: [win({ from: "2026-07-08", floor: "2026-07-08", cause: "sync", clipped: true })] }), name, day);
    expect(c.body).toContain("Kapta no tiene los pedidos que no son del bot");
    expect(c.body).not.toContain("asesora");
  });

  it("varias tiendas: cada una dice desde cuándo cuenta, y la que no usa Kapta se nombra", () => {
    const c = coverageCopy(
      plan({
        windows: [win({}), win({ storeId: "B", from: "2026-07-04", floor: "2026-07-04", clipped: true })],
        excluded: ["Z"],
        multiStore: true,
      }),
      name,
      day,
    );
    expect(c.title).toBe("No todas las tiendas cuentan el periodo entero");
    expect(c.body).toContain("Tienda Dos cuenta desde el día 2026-07-04, el día en que empezó a usar Kapta.");
    expect(c.body).toContain("Tienda Nueva todavía no usa Kapta (sin ventas registradas ni leads): sus pedidos no entran en este total.");
    expect(c.body).toContain("La página de cada tienda dice desde cuándo cuenta.");
    expect(c.body).not.toContain("Tienda Uno");
    expect(c.sub).toEqual(["Tienda Dos desde el día 2026-07-04", "sin Tienda Nueva"]);
  });

  it("una tienda que empieza después del periodo no entra, y se dice por qué", () => {
    const c = coverageCopy(
      plan({ windows: [win({})], later: [{ storeId: "B", floor: "2026-08-04", cause: "tienda" }], multiStore: true }),
      name,
      day,
    );
    expect(c.body).toContain("Tienda Dos no entra: empezó a usar Kapta el día 2026-08-04, después de este periodo.");
    expect(c.sub).toEqual(["sin Tienda Dos"]);
  });

  it("sin cobertura: el aviso de la vista anterior según la causa", () => {
    expect(noCoverageCopy(plan({ excluded: ["A"] }), name, day).note).toMatch(/^Esta tienda todavía no usa Kapta/);
    const t = noCoverageCopy(plan({ later: [{ storeId: "B", floor: "2026-07-04", cause: "tienda" }] }), name, day);
    expect(t.note).toContain("el día en que Tienda Dos empezó a usar Kapta");
    expect(t.note).toContain("Esto es la vista anterior: solo los pedidos del bot de Kapso.");
    expect(t.sub).toBe("Periodo anterior a que Kapta tuviera todas las ventas");
    expect(noCoverageCopy(plan({ later: [{ storeId: "A", floor: "2026-08-01", cause: "sync" }] }), name, day).note).not.toContain("asesora");
    const todas = noCoverageCopy(plan({ excluded: ["A", "Z"], multiStore: true }), name, day);
    expect(todas.note).toMatch(/^Ninguna de estas tiendas tiene todas sus ventas en este periodo/);
    expect(todas.sub).toBe("Las tiendas todavía no usan Kapta");
  });
});

describe("el panel", () => {
  const summary = summarizeClosingChannels(
    parseClosingChannels({
      filas: [
        fila({ canal: "asesora", pedidos: 2651, ingresos: 481451, cancelados: 243 }),
        fila({ canal: "bot_kapso", pedidos: 593, ingresos: 103880, cancelados: 140, ayudados: 57, ingresos_ayudados: 9474 }),
        fila({ canal: "web", pedidos: 3012, ingresos: 527865, cancelados: 1105, ayudados: 66, ingresos_ayudados: 13220 }),
      ],
    }),
  );
  const html = renderToStaticMarkup(createElement(ClosingChannels, { summary, currency: "PEN" }));

  it("muestra los cuatro grupos y solo los canales con ventas", () => {
    for (const g of ["Asesora", "Bot o automatización", "La clienta sola en la web", "Otros"]) expect(html).toContain(g);
    expect(html).toContain("Bot de Kapso");
    expect(html).toContain("Web, la clienta sola");
    expect(html).not.toContain("Bot de carritos externo");
    expect(html).not.toContain("Recompra automática");
  });

  it("dice que es TODA la tienda, con los cancelados aparte", () => {
    expect(html).toContain("Todas las ventas de la tienda");
    expect(html).toContain("1,488 cancelados aparte"); // es-PE: coma de miles, como el resto de la app
  });

  it("la asesora no tiene columna de «ayudados»; el bot sí, con su porcentaje", () => {
    expect(html).toMatch(/57<span[^>]*> \(10\s*%\)/);
  });

  it("sin la migración, la tarjeta vuelve a la vista anterior y lo dice", () => {
    const dash = read("components/executive-dashboard.tsx");
    expect(dash).toContain('closing?.status === "sin_migracion"');
    expect(dash).toContain("Falta aplicar la migración 0258");
  });

  it("antes de la cobertura, también la vista anterior con su aviso; recortado, lo dice", () => {
    const dash = read("components/executive-dashboard.tsx");
    expect(dash).toContain('closing?.status === "sin_cobertura" ? noCoverageCopy(closing.plan, storeName, fullDay)');
    expect(dash).toContain('closing?.status === "ok" ? coverageCopy(closing.plan, storeName, fullDay)');
    expect(dash).toContain("<Banner tone=\"info\" role=\"status\" title={closingCopy.title}>");
  });

  it("sin ventas en lo contado, la cobertura se sigue diciendo (no «Sin ventas en el periodo» a secas)", () => {
    const dash = read("components/executive-dashboard.tsx");
    expect(dash).toContain("`Sin ventas en lo contado${coverageSub}`");
    expect(dash).toContain("closingSold || closingCopy?.title");
  });

  it("la vista de respaldo no muestra el porcentaje de solo-bot como cifra de cabecera", () => {
    const dash = read("components/executive-dashboard.tsx");
    const respaldo = dash.slice(dash.indexOf("    : {\n        id: \"canal\""), dash.indexOf("const roas = deliveredRoas("));
    expect(respaldo).toContain('figure: !legacyCanalNote && channelTotal ? pct(channels.asesora.revenue / channelTotal, 0) : "—"');
    expect(respaldo).toContain('tone: !legacyCanalNote && channelTotal ? undefined : "muted"');
  });

  it("el cierre por etiquetas del panel de «Fuente» ya no se llama «Canal de cierre»", () => {
    const attr = read("components/sales-attribution.tsx");
    expect(attr).toContain("Cierre de los pedidos del bot, por etiquetas");
    expect(attr).not.toMatch(/>\s*Canal de cierre\s*</);
  });
});
