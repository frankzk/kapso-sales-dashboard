import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Canal de cierre de todas las ventas (MOM §17.3, migración 0257).
//
// Lo que se fija: que el resumen cuadre (Σ canales = Σ grupos = total), que la
// asesora nunca traiga «ayudados», que una función ausente vuelva a la vista
// anterior en vez de dar ceros, y que el ORDEN de los canales sea el mismo en la
// función SQL, en el código y en el MOM. Y del lado de la escritura: que las
// tres vías que crean pedidos ya no escriban `kapso` en la copia local ni pisen
// la fila que trajo Shopify.

vi.mock("server-only", () => ({}));
const rpc = vi.hoisted(() => ({ result: { data: null as unknown, error: null as null | { code?: string; message: string } } }));
vi.mock("@/lib/db", () => {
  const client = { rpc: async () => rpc.result };
  return { createServerSupabase: async () => client, createAdminSupabase: () => client };
});

import {
  CLOSING_CHANNELS,
  CHANNEL_LABEL,
  isMissingFunctionError,
  parseClosingChannels,
  summarizeClosingChannels,
} from "@/lib/closing-channel";
import { getClosingChannels } from "@/lib/access";
import { insertOrderIfAbsent, recomputeRollupsForLocalDay } from "@/lib/order-sale";
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

describe("getClosingChannels", () => {
  beforeEach(() => {
    rpc.result = { data: null, error: null };
  });

  it("con la función: el resumen", async () => {
    rpc.result = { data: { version: 1, filas: [fila({ canal: "asesora", pedidos: 2, ingresos: 300 })] }, error: null };
    const r = await getClosingChannels(["A"], { from: "2026-09-14", to: "2026-10-13" });
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.summary.byChannel.asesora.revenue).toBe(300);
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

describe("las tres vías que crean pedidos ya no inventan `kapso`", () => {
  it("generateOrder: inserta si falta, sin `kapso`, y recalcula el día local", () => {
    const src = read("app/dashboard/leads/actions.ts");
    const gen = src.slice(src.indexOf("export async function generateOrder"));
    expect(gen).toContain("insertOrderIfAbsent(admin, {");
    expect(gen).not.toMatch(/tags:\s*reuseExistingDraft\s*\?\s*\[\s*"kapso"/);
    expect(gen).not.toContain('nowIso.slice(0, 10)');
    expect(gen).toContain("recomputeRollupsForLocalDay(admin, ctx.storeId, nowIso)");
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
  it("la función 0257 evalúa los canales en el orden de CLOSING_CHANNELS", () => {
    const sql = read("db/migrations/0257_canal_de_cierre.sql");
    const body = sql.slice(sql.indexOf("as $$"));
    const order = [...body.matchAll(/then '([a-z_]+)'|else '([a-z_]+)'/g)].map((m) => m[1] ?? m[2]);
    expect(order).toEqual([...CLOSING_CHANNELS]);
  });

  it("la tabla del MOM §17.3 lista los canales en ese mismo orden", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    const sec = mom.slice(mom.indexOf("### 17.3 Canal de cierre"), mom.indexOf("## 18. Implementación incremental"));
    const titles = [...sec.matchAll(/^\| (\d) \| ([^|]+?) \|/gm)].map((m) => m[2]!.trim());
    expect(titles).toEqual(CLOSING_CHANNELS.map((c) => CHANNEL_LABEL[c].title));
  });

  it("la función es de lectura, con la sesión de quien mira y sin anon", () => {
    const sql = read("db/migrations/0257_canal_de_cierre.sql");
    expect(sql).toMatch(/security invoker/);
    expect(sql).toMatch(/revoke all on function public\.canal_de_cierre\(uuid\[\], date, date\) from public, anon;/);
    expect(sql).not.toMatch(/^\s*(insert|update|delete|drop|truncate)\b/im);
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
    expect(dash).toContain("Falta aplicar la migración 0257");
  });
});
