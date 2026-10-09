// Entrega estimada de Aliclik según los días del pedido (09-10-2026). Medido
// por guía, la caída es real pero no tan brusca como parecía midiendo el
// pedido por su despacho: en Kenku, 61 % el mismo día, 55 % al siguiente, 40 %
// a los dos días y 27 % desde el tercero.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAliclikOutlook,
  orderAgeDays,
  outlookAdvice,
  outlookFact,
  outlookLevel,
  outlookSource,
  outlookTitle,
  type AliclikAgeRateRow,
} from "@/lib/aliclik-outlook";

const state = vi.hoisted(() => ({ rpcCalls: 0, rows: [] as unknown[] }));
vi.mock("@/lib/access", () => ({ getCurrentUser: async () => ({ id: "ana" }) }));

import { AliclikOutlookBanner, AliclikOutlookLadder } from "@/components/aliclik-outlook";
import { loadAliclikOutlook } from "@/lib/aliclik-outlook-access";

const W = { window_from: "2026-07-31", window_to: "2026-09-25" };
// Las cifras reales de Kenku y Aurela al 09-10-2026.
const KENKU: AliclikAgeRateRow[] = [
  { store_id: "kenku", age_bucket: 0, settled: 2705, delivered: 1658, ...W },
  { store_id: "kenku", age_bucket: 1, settled: 689, delivered: 376, ...W },
  { store_id: "kenku", age_bucket: 2, settled: 113, delivered: 45, ...W },
  { store_id: "kenku", age_bucket: 3, settled: 292, delivered: 80, ...W },
];
const AURELA: AliclikAgeRateRow[] = [
  { store_id: "aurela", age_bucket: 0, settled: 423, delivered: 296, ...W },
  { store_id: "aurela", age_bucket: 1, settled: 154, delivered: 106, ...W },
  { store_id: "aurela", age_bucket: 2, settled: 24, delivered: 12, ...W },
  { store_id: "aurela", age_bucket: 3, settled: 48, delivered: 20, ...W },
];

describe("los días del pedido se cuentan como en la tabla: calendario de Lima", () => {
  it("un pedido de las 23:30 ya es «de ayer» a la mañana siguiente", () => {
    expect(orderAgeDays("2026-10-09T04:30:00Z", new Date("2026-10-09T13:00:00Z"))).toBe(1);
  });
  it("uno de las 00:10 sigue siendo de hoy a las 23:50", () => {
    expect(orderAgeDays("2026-10-09T05:10:00Z", new Date("2026-10-10T04:50:00Z"))).toBe(0);
  });
  it("una fecha rota no inventa días", () => {
    expect(orderAgeDays("no", new Date())).toBeNull();
  });
});

describe("la cifra sale de las guías de la tienda", () => {
  it("pedido de 5 días en Kenku: 27 %, muy baja, sin «mañana» porque ya está en el último tramo", () => {
    const o = buildAliclikOutlook(KENKU, "kenku", 5)!;
    expect(o.bucket).toBe(3);
    expect(Math.round(o.rate * 100)).toBe(27);
    expect(o.level).toBe("muy_baja");
    expect(o.tomorrowRate).toBeNull();
    expect(o.pooled).toBe(false);
    expect(outlookTitle(o)).toBe("Pedido de 5 días · Aliclik entrega ~27 %");
    expect(outlookFact(o)).toBe("De cada 10 guías de pedidos de 3 días o más, Aliclik entregó 3.");
    expect(outlookAdvice(o)).toBe("Créala solo si el cliente contesta hoy y vuelve a confirmar, o con adelanto.");
    expect(outlookSource(o, "Kenku Peru")).toBe("292 primeras guías de Kenku Peru, 31 jul – 25 set");
  });

  it("pedido de hoy: normal, y dice cuánto baja si espera a mañana", () => {
    const o = buildAliclikOutlook(KENKU, "kenku", 0)!;
    expect(o.level).toBe("normal");
    expect(outlookAdvice(o)).toBe("Que salga hoy: mañana bajaría a 55 %.");
  });

  it("pedido de 2 días: baja, pide confirmar antes de crear la guía", () => {
    const o = buildAliclikOutlook(KENKU, "kenku", 2)!;
    expect(Math.round(o.rate * 100)).toBe(40);
    expect(o.level).toBe("baja");
    expect(outlookAdvice(o)).toMatch(/^Antes de crear la guía, confirma/);
  });

  it("sin muestra en la tienda (Aurela a los 2 días: 24 guías), usa todas las tiendas y lo dice", () => {
    const o = buildAliclikOutlook([...KENKU, ...AURELA], "aurela", 2)!;
    expect(o.pooled).toBe(true);
    expect(o.settled).toBe(24 + 113);
    expect(o.rate).toBeCloseTo((12 + 45) / (24 + 113));
    expect(outlookSource(o, "Aurela")).toContain("de todas tus tiendas");
    // Los tramos con muestra propia siguen siendo de Aurela.
    expect(o.steps[0]!.settled).toBe(423);
  });

  it("sin muestra ni juntando tiendas, no se inventa un número", () => {
    const few = AURELA.map((r) => ({ ...r, settled: 10, delivered: 5 }));
    expect(buildAliclikOutlook(few, "aurela", 3)).toBeNull();
    expect(buildAliclikOutlook([], "aurela", 0)).toBeNull();
  });

  it("los cortes: 50 % o más es normal; bajo 35 %, muy baja", () => {
    expect(outlookLevel(0.5)).toBe("normal");
    expect(outlookLevel(0.4999)).toBe("baja");
    expect(outlookLevel(0.35)).toBe("baja");
    expect(outlookLevel(0.3499)).toBe("muy_baja");
  });
});

describe("la pantalla", () => {
  it("la escalera marca el tramo del pedido con su cifra y su palabra, también para el lector de pantalla", () => {
    const html = renderToStaticMarkup(
      createElement(AliclikOutlookLadder, { outlook: buildAliclikOutlook(KENKU, "kenku", 5)!, storeName: "Kenku Peru" }),
    );
    expect(html).toContain('aria-label="Entrega de Aliclik según los días del pedido"');
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toContain("(este pedido)");
    expect(html).toContain("Muy baja");
    expect(html).toContain("Pedido de 5 días");
    for (const step of ["Hoy", "1 d", "2 d", "3+ d"]) expect(html).toContain(step);
  });

  it("en «Crear guía» solo avisa si la entrega es baja: un pedido de hoy no dice nada", () => {
    expect(renderToStaticMarkup(createElement(AliclikOutlookBanner, { outlook: buildAliclikOutlook(KENKU, "kenku", 0)! }))).toBe("");
    expect(renderToStaticMarkup(createElement(AliclikOutlookBanner, { outlook: null }))).toBe("");
    const html = renderToStaticMarkup(createElement(AliclikOutlookBanner, { outlook: buildAliclikOutlook(KENKU, "kenku", 2)! }));
    expect(html).toContain("Pedido de 2 días · Aliclik entrega");
    expect(html).toContain("De cada 10 guías de pedidos de dos días, Aliclik entregó 4.");
  });

  it("la tarjeta de Aliclik de la mesa de ruta lleva la escalera solo si se puede tomar", () => {
    const desk = readFileSync(resolve(process.cwd(), "components/order-route-desk.tsx"), "utf8");
    expect(desk).toContain('route.action === "aliclik" && aliclikOutlook && enabled && !route.blockingOutput');
    const panel = readFileSync(resolve(process.cwd(), "components/aliclik-guide-panel.tsx"), "utf8");
    expect(panel).toContain("<AliclikOutlookBanner outlook={outlook} storeName={storeName} />");
  });
});

describe("la carga", () => {
  const sb = {
    rpc: async (name: string) => {
      expect(name).toBe("aliclik_delivery_by_order_age");
      state.rpcCalls += 1;
      return { data: state.rows, error: null };
    },
  } as never;
  const row = { store_id: "kenku", order_created_at: "2026-10-04T15:00:00Z" };

  beforeEach(() => {
    state.rpcCalls = 0;
    state.rows = KENKU;
  });

  it("solo antes de la primera guía: con una salida de courier ya no aplica (las cifras son de primeras guías)", async () => {
    expect(await loadAliclikOutlook(sb, row, [{ courier: "shalom" }], new Date("2026-10-09T15:00:00Z"))).toBeNull();
    expect(state.rpcCalls).toBe(0);
    // La salida «por definir» todavía no es una guía.
    const o = await loadAliclikOutlook(sb, row, [{ courier: "por_definir" }], new Date("2026-10-09T15:00:00Z"));
    expect(o?.ageDays).toBe(5);
  });

  it("las tasas se guardan media hora por usuario: abrir diez fichas no hace diez consultas", async () => {
    const t0 = new Date("2026-10-09T16:00:00Z");
    await loadAliclikOutlook(sb, row, [], t0);
    await loadAliclikOutlook(sb, row, [], new Date(t0.getTime() + 10 * 60_000));
    const before = state.rpcCalls;
    await loadAliclikOutlook(sb, row, [], new Date(t0.getTime() + 31 * 60_000));
    expect(state.rpcCalls).toBe(before + 1);
  });
});

describe("la función de la base (0236)", () => {
  const sql = readFileSync(resolve(process.cwd(), "db/migrations/0236_aliclik_delivery_by_order_age.sql"), "utf8");
  it("cuenta la primera guía de la API que salió y ya tiene resultado, con RLS", () => {
    expect(sql).toContain("security invoker");
    expect(sql).toContain("s.created_via = 'aliclik_api'");
    expect(sql).toContain("s.status_category in ('delivered', 'closed', 'transferred')");
    expect(sql).toMatch(/not exists \(\s*select 1 from shipments p\s*where p\.order_id = s\.order_id and p\.id <> s\.id and p\.created_at < s\.created_at/);
    expect(sql).toContain("grant execute on function public.aliclik_delivery_by_order_age() to authenticated");
  });
});
