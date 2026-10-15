import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Todas las ventas por origen y la conversión por fuente (MOM §17.4, 0265).
//
// Lo que se fija: que la cabecera sume TODAS las ventas y cuadre por canal y por
// grupo; que cada tienda cuente en su propia ventana y la conversión del bot
// divida numerador y denominador en la MISMA ventana; que el periodo anterior
// solo aparezca si cada tienda lo contaba entero; que la tasa de una fuente sin
// leads maduros diga «Sin datos» y nunca 0 %; y que una función ausente o con
// error se diga, nunca se vuelva ceros.

vi.mock("server-only", () => ({}));
type RpcResult = { data: unknown; error: null | { code?: string; message: string } };
const rpc = vi.hoisted(() => ({
  handler: (() => ({ data: null, error: null })) as (name: string, args: Record<string, unknown>) => RpcResult,
  calls: [] as { name: string; args: Record<string, unknown> }[],
  tables: {} as Record<string, Record<string, unknown>[]>,
}));
vi.mock("@/lib/db", () => {
  const from = (table: string) => {
    let rows = [...(rpc.tables[table] ?? [])];
    const q: any = {
      select: () => q,
      eq: (k: string, v: unknown) => ((rows = rows.filter((r) => r[k] === v)), q),
      in: (k: string, vs: unknown[]) => ((rows = rows.filter((r) => vs.includes(r[k]))), q),
      order: (k: string, o: { ascending: boolean }) => (
        (rows = [...rows].sort((a, b) => (String(a[k]) < String(b[k]) ? -1 : 1) * (o.ascending ? 1 : -1))), q
      ),
      limit: (n: number) => ((rows = rows.slice(0, n)), q),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok),
    };
    return q;
  };
  const client = {
    from,
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpc.calls.push({ name, args });
      return rpc.handler(name, args);
    },
  };
  return { createServerSupabase: async () => client, createAdminSupabase: () => client };
});

import { CLOSING_CHANNELS, parseClosingChannels, summarizeClosingChannels } from "@/lib/closing-channel";
import {
  CONVERSION_DAYS,
  SOURCE_KEYS,
  SOURCE_LABEL,
  parseOriginRows,
  parseSourceConversion,
  salesPeriod,
  sourceNoRateCause,
  sumOrigin,
  summarizeSourceConversion,
  type OriginDayRow,
} from "@/lib/consolidado-origen";
import { planWindows } from "@/lib/sales-coverage";
import { getOriginSales, getSourceConversion } from "@/lib/access";
import { SourceConversion } from "@/components/source-conversion";
import { ClosingChannels } from "@/components/closing-channels";
import type { DailyRollupRow } from "@/lib/types";

const read = (p: string) => readFileSync(p, "utf8");

const venta = (o: Partial<OriginDayRow>): OriginDayRow => ({
  storeId: "A",
  date: "2026-07-01",
  channel: "web",
  orders: 0,
  revenue: 0,
  cancelled: 0,
  ...o,
});

const rollup = (store_id: string, date: string, conversations_count: number): DailyRollupRow =>
  ({ store_id, date, conversations_count, orders_count: 0, revenue: 0 }) as unknown as DailyRollupRow;

describe("parseOriginRows", () => {
  it("lee el jsonb de `ventas_por_origen` y tipa los números", () => {
    expect(
      parseOriginRows({
        version: 1,
        filas: [{ store_id: "A", dia: "2026-07-01", canal: "asesora", pedidos: "3", ingresos: "450.5", cancelados: 1 }],
      }),
    ).toEqual([{ storeId: "A", date: "2026-07-01", channel: "asesora", orders: 3, revenue: 450.5, cancelled: 1 }]);
  });

  it("un canal desconocido suma a «otros»; un día ilegible no entra", () => {
    const rows = parseOriginRows({
      filas: [
        { store_id: "A", dia: "2026-07-01", canal: "nuevo", pedidos: 2, ingresos: 100 },
        { store_id: "A", dia: "julio", canal: "web", pedidos: 9, ingresos: 900 },
      ],
    });
    expect(rows).toEqual([{ storeId: "A", date: "2026-07-01", channel: "otros", orders: 2, revenue: 100, cancelled: 0 }]);
    expect(parseOriginRows(null)).toEqual([]);
    expect(parseOriginRows({ filas: "x" })).toEqual([]);
  });
});

describe("sumOrigin", () => {
  const t = sumOrigin([
    venta({ channel: "asesora", orders: 10, revenue: 1000.1, cancelled: 2 }),
    venta({ channel: "bot_kapso", orders: 4, revenue: 400 }),
    venta({ channel: "recompra_auto", orders: 1, revenue: 60 }),
    venta({ channel: "web", orders: 20, revenue: 2000.2, cancelled: 7, date: "2026-07-02" }),
    venta({ channel: "otros", orders: 1, revenue: 30, storeId: "B" }),
  ]);

  it("Σ canales = Σ grupos = total, con los cancelados aparte", () => {
    const sumCh = CLOSING_CHANNELS.reduce((a, c) => a + t.byChannel[c].revenue, 0);
    const sumGr = Object.values(t.byGroup).reduce((a, g) => a + g.revenue, 0);
    expect(Math.round(sumCh * 100) / 100).toBe(t.revenue);
    expect(Math.round(sumGr * 100) / 100).toBe(t.revenue);
    expect(t).toMatchObject({ orders: 36, revenue: 3490.3, cancelled: 9 });
    expect(t.byGroup.automatizacion.orders).toBe(5);
    expect(t.aov).toBe(Math.round((3490.3 / 36) * 100) / 100);
  });

  it("sin filas, ceros (no NaN)", () => {
    expect(sumOrigin([])).toMatchObject({ orders: 0, revenue: 0, aov: 0 });
  });
});

describe("salesPeriod", () => {
  // A cuenta el periodo entero; B empezó a usar Kapta el 04-07.
  const plan = planWindows("2026-06-01", [{ id: "A", start: "2026-06-25" }, { id: "B", start: "2026-07-04" }], {
    from: "2026-07-01",
    to: "2026-07-05",
  });
  const rows = [
    venta({ storeId: "A", date: "2026-07-01", channel: "bot_kapso", orders: 2, revenue: 200 }),
    venta({ storeId: "A", date: "2026-07-01", channel: "asesora", orders: 3, revenue: 600 }),
    venta({ storeId: "B", date: "2026-07-04", channel: "web", orders: 5, revenue: 500 }),
    venta({ storeId: "B", date: "2026-07-05", channel: "bot_kapso", orders: 1, revenue: 90 }),
  ];
  const rollups = [
    rollup("A", "2026-07-01", 20),
    rollup("A", "2026-07-02", 10),
    rollup("B", "2026-07-02", 50), // antes de la ventana de B: no cuenta
    rollup("B", "2026-07-05", 10),
    rollup("Z", "2026-07-01", 99), // una tienda que no cuenta
  ];
  const p = salesPeriod({ rows, prevRows: null, plan }, rollups, [], { from: "2026-06-26", to: "2026-06-30" });

  it("la cabecera suma todas las ventas de las tiendas que cuentan", () => {
    expect(p.totals).toMatchObject({ orders: 11, revenue: 1390 });
    expect(p.totals.byGroup.humano.revenue).toBe(600);
  });

  it("la conversión del bot divide en la MISMA ventana: las conversaciones de B antes del 04-07 no cuentan", () => {
    expect(p.bot).toEqual({ orders: 3, conversations: 40, rate: 3 / 40, prev: null });
  });

  it("los días van desde la primera ventana hasta el final, con los vacíos en cero", () => {
    expect(p.days.map((d) => d.date)).toEqual(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05"]);
    expect(p.days[2]).toMatchObject({ orders: 0, revenue: 0, conversations: 0, botRate: null });
    expect(p.days[0]).toMatchObject({ orders: 5, revenue: 800, botOrders: 2, conversations: 20, botRate: 0.1 });
    expect(p.days[1]).toMatchObject({ conversations: 10, botRate: 0 }); // el 02-07 de B no cuenta
  });

  it("por tienda, de más a menos ingresos, con su conversión del bot", () => {
    expect(p.stores.map((s) => [s.storeId, s.revenue, s.botRate])).toEqual([
      ["A", 800, 2 / 30],
      ["B", 590, 1 / 10],
    ]);
  });

  it("sin periodo anterior comparable, ni ventas ni conversión anteriores", () => {
    expect(p.prev).toBeNull();
    expect(p.bot.prev).toBeNull();
  });

  it("con el anterior: sus ventas y su conversión, en el rango anterior y las mismas tiendas", () => {
    const planA = planWindows("2026-06-01", [{ id: "A", start: "2026-06-01" }], { from: "2026-07-01", to: "2026-07-05" });
    const q = salesPeriod(
      { rows: [venta({ channel: "bot_kapso", orders: 1, revenue: 100 })], prevRows: [venta({ date: "2026-06-28", channel: "bot_kapso", orders: 2, revenue: 150 })], plan: planA },
      [rollup("A", "2026-07-01", 10)],
      [rollup("A", "2026-06-28", 40), rollup("A", "2026-06-20", 99), rollup("Z", "2026-06-28", 99)],
      { from: "2026-06-26", to: "2026-06-30" },
    );
    expect(q.prev).toMatchObject({ orders: 2, revenue: 150 });
    expect(q.bot.prev).toEqual({ orders: 2, conversations: 40, rate: 0.05 });
  });
});

describe("conversión por fuente", () => {
  const parsed = parseSourceConversion({
    version: 1,
    fuentes: [
      { store_id: "A", fuente: "meta_ad", nacidos: 10, por_madurar: 2, ya_clientas: 1, prospectos: 7, convertidos: 2 },
      { store_id: "B", fuente: "meta_ad", nacidos: 5, por_madurar: 0, ya_clientas: 0, prospectos: 5, convertidos: 1 },
      { store_id: "A", fuente: "cod_cart", nacidos: 3, por_madurar: 3, ya_clientas: 0, prospectos: 0, convertidos: 0 },
      { store_id: "A", fuente: "manual", nacidos: 4, por_madurar: 0, ya_clientas: 0, prospectos: 4, convertidos: 4 },
    ],
    cierres: [
      { store_id: "A", fuente: "meta_ad", canal: "asesora", convertidos: 2 },
      { store_id: "B", fuente: "meta_ad", canal: "bot_kapso", convertidos: 1 },
    ],
    asesoras: [
      { store_id: "A", leads_trabajados: 40, ventas: 10, canceladas: 2 },
      { store_id: "B", leads_trabajados: 10, ventas: 5, canceladas: 0 },
    ],
  });
  const s = summarizeSourceConversion(parsed);
  const by = Object.fromEntries(s.sources.map((x) => [x.key, x]));

  it("una fuente que no conoce el código (la venta telefónica) no tiene tasa", () => {
    expect(parsed.sources.find((r) => r.born === 4)?.source).toBe("sin_tasa");
    expect(s.noRate.born).toBe(4);
    expect(s.total.converted).toBe(3); // los 4 «convertidos» sin tasa no entran
  });

  it("suma numeradores y denominadores de las tiendas, nunca promedia porcentajes", () => {
    expect(by.meta_ad).toMatchObject({ born: 15, prospects: 12, converted: 3, rate: 3 / 12 });
    expect(by.meta_ad!.closedBy).toEqual({ humano: 2, automatizacion: 1, web: 0, otros: 0 });
  });

  it("sin leads maduros la tasa es null («Sin datos»), nunca 0 %", () => {
    expect(by.cod_cart).toMatchObject({ prospects: 0, maturing: 3, rate: null });
    expect(by.organico!.rate).toBeNull();
  });

  it("el cierre de las asesoras: ventas ÷ leads trabajados de todas las tiendas", () => {
    expect(s.advisors).toEqual({ worked: 50, sales: 15, cancelledSales: 2, rate: 0.3 });
  });

  it("todas las fuentes con tasa, en su orden, con su nombre", () => {
    expect(s.sources.map((x) => x.key)).toEqual([...SOURCE_KEYS]);
    for (const k of SOURCE_KEYS) expect(SOURCE_LABEL[k].title).toBeTruthy();
  });

  it("la ventana de 7 días es la misma en el código y en la función", () => {
    const sql = read("db/migrations/0265_ventas_por_origen.sql");
    expect(CONVERSION_DAYS).toBe(7);
    expect(sql).toContain("<= now() - interval '7 days' as maduro");
    expect(sql.match(/< {1,2}m\.nace \+ interval '7 days'/g)).toHaveLength(2);
  });

  it("el panel dice «Sin datos» donde no hay tasa y cuenta aparte lo que no la tiene", () => {
    const html = renderToStaticMarkup(createElement(SourceConversion, { summary: s }));
    expect(html).toContain("Anuncios de Meta");
    expect(html).toContain("Carritos COD abandonados");
    expect(html).toContain("Sin datos");
    expect(html).not.toMatch(/>0\s*%</);
    // Sin fuente es «Orgánico» (con tasa): aparte solo van la venta telefónica y lo que no se reconoce.
    expect(html).toContain("4 leads más llegaron por venta telefónica o con una fuente que el tablero no reconoce");
    expect(html).toContain("15 ventas de 50 leads trabajados");
    // Una fuente sin leads en el periodo no ocupa fila.
    expect(html).not.toContain("Web de Facebook");
  });
});

describe("sin tasa, se dice por qué (nunca «ningún lead cumplió 7 días» si sí los cumplieron)", () => {
  const con = (fuentes: Record<string, unknown>[]) =>
    summarizeSourceConversion(parseSourceConversion({ fuentes: fuentes.map((f) => ({ store_id: "A", ...f })), cierres: [], asesoras: [] }));

  it("los leads con 7 días ya eran clientas", () => {
    const s = con([{ fuente: "meta_ad", nacidos: 5, por_madurar: 0, ya_clientas: 5, prospectos: 0, convertidos: 0 }]);
    expect(sourceNoRateCause(s)).toBe("ya_clientas");
    const html = renderToStaticMarkup(createElement(SourceConversion, { summary: s }));
    expect(html).toContain("los leads con 7 días ya eran clientas");
    expect(html).not.toContain("ningún lead cumplió");
  });

  it("todavía maduran", () => {
    expect(sourceNoRateCause(con([{ fuente: "cod_cart", nacidos: 3, por_madurar: 3, ya_clientas: 0, prospectos: 0, convertidos: 0 }]))).toBe("maduran");
  });

  it("solo leads sin tasa (venta telefónica)", () => {
    const s = con([{ fuente: "manual", nacidos: 4, por_madurar: 0, ya_clientas: 0, prospectos: 4, convertidos: 4 }]);
    expect(sourceNoRateCause(s)).toBe("sin_tasa");
    expect(renderToStaticMarkup(createElement(SourceConversion, { summary: s }))).toContain("solo llegaron leads sin tasa");
  });

  it("ninguno, o con tasa: lo que corresponde", () => {
    expect(sourceNoRateCause(con([]))).toBe("sin_leads");
    expect(sourceNoRateCause(con([{ fuente: "meta_ad", nacidos: 2, por_madurar: 0, ya_clientas: 0, prospectos: 2, convertidos: 0 }]))).toBeNull();
  });
});

describe("Canal de cierre contra el periodo anterior", () => {
  const summary = summarizeClosingChannels(
    parseClosingChannels({
      filas: [
        { store_id: "A", canal: "asesora", pedidos: 10, ingresos: 1200, cancelados: 0, ayudados: 0, ingresos_ayudados: 0 },
        { store_id: "A", canal: "web", pedidos: 5, ingresos: 500, cancelados: 0, ayudados: 0, ingresos_ayudados: 0 },
      ],
    }),
  );
  const prev = sumOrigin([
    venta({ channel: "asesora", orders: 8, revenue: 1000 }),
    venta({ channel: "bot_kapso", orders: 3, revenue: 300 }),
  ]);

  it("sin anterior, sin columna de cambio", () => {
    expect(renderToStaticMarkup(createElement(ClosingChannels, { summary, currency: "PEN" }))).not.toContain("contra el anterior");
  });

  it("con el anterior: el cambio por canal, y el canal que vendía antes y ya no también sale", () => {
    const html = renderToStaticMarkup(createElement(ClosingChannels, { summary, currency: "PEN", prev }));
    expect(html).toContain("Ingresos contra el anterior");
    expect(html).toMatch(/\+20(\.0)?\s*%/); // asesora: 1.000 → 1.200
    expect(html).toContain("Bot de Kapso"); // vendió antes, ahora no
    expect(html).toContain("antes");
  });
});

// Las tiendas de producción: A empezó el 25-06-2026, B el 04-07-2026.
const TIENDAS = {
  stores: [
    { id: "A", timezone: "America/Lima" },
    { id: "B", timezone: "America/Lima" },
  ],
  order_sales: [
    { store_id: "A", occurred_at: "2026-06-26T04:50:55.000Z" },
    { store_id: "B", occurred_at: "2026-07-04T20:03:26.000Z" },
  ],
  leads: [],
};

describe("getOriginSales", () => {
  beforeEach(() => {
    rpc.calls = [];
    rpc.tables = TIENDAS;
    vi.unstubAllEnvs();
    rpc.handler = (_name, args) => ({
      data: {
        version: 1,
        filas: [
          { store_id: (args.p_store_ids as string[])[0], dia: args.p_from, canal: "web", pedidos: 1, ingresos: 10 },
          { store_id: (args.p_store_ids as string[])[0], dia: args.p_to, canal: "asesora", pedidos: 2, ingresos: 40 },
        ],
      },
      error: null,
    });
  });

  it("comparable: UNA llamada por tienda cubre los dos periodos, y se parten por fecha", async () => {
    const r = await getOriginSales(["A"], { from: "2026-09-14", to: "2026-10-13" });
    expect(rpc.calls).toEqual([
      { name: "ventas_por_origen", args: { p_store_ids: ["A"], p_from: "2026-08-15", p_to: "2026-10-13" } },
    ]);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.rows.map((x) => x.date)).toEqual(["2026-10-13"]);
      expect(r.prevRows?.map((x) => x.date)).toEqual(["2026-08-15"]);
    }
  });

  it("si el periodo o el anterior no está entero, no hay anterior (null, no ceros)", async () => {
    const r = await getOriginSales(["A"], { from: "2026-06-20", to: "2026-06-30" });
    expect(rpc.calls[0]!.args).toMatchObject({ p_from: "2026-06-25" });
    expect(r).toMatchObject({ status: "ok", prevRows: null });

    rpc.calls = [];
    // Julio: A está entera, pero B empezó el 04-07 → no se compara ninguna.
    const ab = await getOriginSales(["A", "B"], { from: "2026-07-01", to: "2026-07-31" });
    expect(rpc.calls.map((c) => [c.args.p_store_ids, c.args.p_from])).toEqual([
      [["A"], "2026-07-01"],
      [["B"], "2026-07-04"],
    ]);
    expect(ab).toMatchObject({ status: "ok", prevRows: null });
  });

  it("ninguna tienda cuenta: `sin_cobertura`, sin preguntarle a la función", async () => {
    const r = await getOriginSales(["B"], { from: "2026-06-01", to: "2026-06-30" });
    expect(r).toMatchObject({ status: "sin_cobertura", plan: { later: [{ storeId: "B" }] } });
    expect(rpc.calls).toEqual([]);
  });

  it("sin la migración, `sin_migracion`; otro error se dice tal cual", async () => {
    rpc.handler = () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    expect(await getOriginSales(["A"], { from: "2026-09-14", to: "2026-10-13" })).toEqual({ status: "sin_migracion" });
    rpc.handler = () => ({ data: null, error: { code: "57014", message: "statement timeout" } });
    expect(await getOriginSales(["A"], { from: "2026-09-14", to: "2026-10-13" })).toEqual({ status: "error", message: "statement timeout" });
  });
});

describe("getSourceConversion", () => {
  beforeEach(() => {
    rpc.calls = [];
    rpc.tables = TIENDAS;
    vi.unstubAllEnvs();
  });

  it("una llamada por tienda en su ventana, y se suman", async () => {
    rpc.handler = (_name, args) => ({
      data: {
        version: 1,
        fuentes: [{ store_id: (args.p_store_ids as string[])[0], fuente: "meta_ad", nacidos: 4, por_madurar: 0, ya_clientas: 0, prospectos: 4, convertidos: 1 }],
        cierres: [],
        asesoras: [],
      },
      error: null,
    });
    const r = await getSourceConversion(["A", "B"], { from: "2026-07-01", to: "2026-07-31" });
    expect(rpc.calls.map((c) => [c.name, c.args.p_store_ids, c.args.p_from])).toEqual([
      ["conversion_por_fuente", ["A"], "2026-07-01"],
      ["conversion_por_fuente", ["B"], "2026-07-04"],
    ]);
    expect(r).toMatchObject({ status: "ok", summary: { total: { prospects: 8, converted: 2, rate: 0.25 } } });
  });

  it("sin la migración, `sin_migracion`", async () => {
    rpc.handler = () => ({ data: null, error: { code: "42883", message: "function does not exist" } });
    expect(await getSourceConversion(["A"], { from: "2026-09-14", to: "2026-10-13" })).toEqual({ status: "sin_migracion" });
  });
});

describe("la migración 0265", () => {
  const sql = read("db/migrations/0265_ventas_por_origen.sql");

  it("las tres funciones son de lectura, con la sesión de quien mira y sin anon", () => {
    for (const fn of ["canal_de_cierre", "ventas_por_origen", "conversion_por_fuente"]) {
      const body = sql.slice(sql.indexOf(`create or replace function public.${fn}(`));
      expect(body.slice(0, 400)).toMatch(/security invoker/);
      expect(sql).toContain(`revoke all on function public.${fn}(uuid[], date, date) from public, anon;`);
      expect(sql).toContain(`grant execute on function public.${fn}(uuid[], date, date) to authenticated, service_role;`);
    }
    expect(sql).not.toMatch(/^\s*(insert|update|delete|drop|truncate)\b/im);
  });

  it("la vista del canal mira con la sesión de quien la lee y solo se puede leer", () => {
    expect(sql).toContain("create or replace view public.pedidos_canal with (security_invoker = true) as");
    expect(sql).toContain("revoke all on public.pedidos_canal from public, anon, authenticated;");
    expect(sql).toContain("grant select on public.pedidos_canal to authenticated, service_role;");
  });

  // Bajo RLS, Postgres no lleva al índice un rango con coalesce/timezone (no
  // son leakproof): se leían todos los pedidos y todos los leads de la tienda.
  it("las tiendas van materializadas, para que bajo RLS el rango llegue al índice", () => {
    expect(sql.match(/with tiendas as materialized \(/g)).toHaveLength(3);
  });

  it("el nacimiento del lead va en dos rangos de columnas simples, con sus índices", () => {
    const nacidos = sql.slice(sql.indexOf("nacidos as materialized ("), sql.indexOf("marcados as materialized ("));
    expect(nacidos).not.toMatch(/coalesce\(l\.first_seen_at/);
    expect(nacidos).toContain("and l.first_seen_at >= t.t_from");
    expect(nacidos).toContain("and l.first_seen_at is null");
    expect(nacidos).toContain("and l.created_at >= t.t_from");
    expect(sql).toContain("create index if not exists leads_store_first_seen_idx\n  on public.leads (store_id, first_seen_at);");
    expect(sql).toMatch(/create index if not exists leads_store_created_sin_first_seen_idx\s+on public\.leads \(store_id, created_at\)\s+where first_seen_at is null;/);
  });

  it("el canal se calcula solo para el pedido que convierte, no para todos los pedidos", () => {
    const cierres = sql.slice(sql.indexOf("  cierres as ("), sql.indexOf("  trabajados as ("));
    expect(cierres).not.toContain("pedidos_canal");
    expect(cierres).toContain("where c.pedido_id is not null");
  });

  it("orgánico es sin fuente o `whatsapp-bot`; lo demás sin regla, sin tasa", () => {
    expect(sql).toContain("when b.source is null or b.source = 'whatsapp-bot' then 'organico'");
    expect(sql).toContain("else 'sin_tasa'");
  });

  it("una fila creada desde su propio pedido no nace en la cohorte", () => {
    const nacidos = sql.slice(sql.indexOf("nacidos as materialized ("), sql.indexOf("marcados as materialized ("));
    expect(nacidos).toMatch(/where not exists \(select 1 from public\.orders o\s+where o\.id = l\.order_id\s+and o\.store_id = l\.store_id\s+and o\.created_at <= l\.created_at\)/);
  });
});

describe("el tablero cuenta todas las ventas y lo dice", () => {
  const dash = read("components/executive-dashboard.tsx");
  const paginas = [read("app/dashboard/page.tsx"), read("app/dashboard/[storeId]/page.tsx")];

  it("las dos páginas las piden y se las pasan; el tipo las exige", () => {
    for (const p of paginas) {
      expect(p).toContain("getOriginSales(");
      expect(p).toContain("getSourceConversion(");
      expect(p).toContain("origin={origin}");
      expect(p).toContain("sourceConversion={sourceConversion}");
    }
    expect(dash).toMatch(/\n\s+origin: OriginSalesResult;/);
    expect(dash).toMatch(/\n\s+sourceConversion: SourceConversionResult;/);
  });

  it("la cabecera lee todas las ventas; sin la 0265, la vista anterior con su aviso", () => {
    expect(dash).toContain("value={money(head.revenue, currency)}");
    expect(dash).not.toContain("value={money(totals.revenue, currency)}");
    expect(dash).toContain("Falta aplicar la migración 0265");
    expect(dash).toContain('title="Estas cifras solo ven los pedidos del bot"');
    expect(dash).toContain('const of = period ? "" : " del bot";');
  });

  it("la conversión es «del bot», y el cambio solo si el anterior está entero", () => {
    expect(dash).toContain('label="Conversión del bot"');
    expect(dash).toContain('title: "Conversión del bot"');
    expect(dash).toContain('"sin comparar: el anterior no tiene todas las ventas"');
  });

  // Cada módulo, por su id: un conteo global dejaba pasar los que no lo decían.
  const bloque = (id: string) => {
    const i = dash.indexOf(`id: "${id}"`);
    expect(i, id).toBeGreaterThan(-1);
    const j = dash.indexOf('id: "', i + 5);
    return dash.slice(i, j === -1 ? undefined : j);
  };

  it("los módulos que leen los pedidos del bot lo dicen, cada uno en su panel", () => {
    for (const id of ["productos", "fuente", "embudo", "salud-embudo", "negocio", "integridad", "horas"]) {
      expect(bloque(id), id).toContain("Pedidos del bot");
    }
  });

  it("y donde la celda enseña pedidos o ingresos del bot, también en su línea", () => {
    expect(bloque("productos")).toContain("el más vendido por el bot");
    expect(bloque("fuente")).toContain("de las ventas del bot vienen de");
    expect(bloque("embudo")).toContain('" por el bot"');
    expect(bloque("whatsapp")).toContain("vende más por el bot");
    // Sus pedidos son leads que compraron por cualquier vía; solo los ingresos son del bot.
    expect(bloque("whatsapp")).toContain("meta: `Ingresos del bot${SEP}${periodMeta}`");
    expect(bloque("whatsapp")).toContain("Los pedidos son los leads que compraron por cualquier vía");
    expect(bloque("carritos")).toContain('label="Ingresos recuperados del bot"');
  });

  it("«Por tienda» sin ventas no nombra a una tienda como dueña de los ingresos", () => {
    const tiendas = bloque("tiendas");
    expect(tiendas).toContain("sold && topStore && head.revenue ?");
    // En la vista anterior dice «Sin ventas del bot en el periodo»: solo ve el bot.
    expect(tiendas).toContain("`Sin ventas${of} en el periodo`");
    expect(tiendas).toContain("`de los ingresos${of} son de ${topStore.name}${subOf(originCopy)}`");
  });

  it("«Conversión por fuente» está en «Origen y cierre», junto a «Canal de cierre»", () => {
    expect(dash).toContain('cells: [canal, conversionFuente, fuente, anuncios, tendencia]');
  });
});
