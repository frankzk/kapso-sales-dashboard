import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ASSIST_CONTACT_STATUSES,
  ASSIST_FROM_ISO,
  ASSIST_WINDOW_HOURS,
  assistContactsFromIso,
  computeAssists,
  isAssistContact,
  saleAssister,
  type AssistContact,
  type AssistSale,
} from "@/lib/sale-assists";
import { computeAdvisorStats, emptyPorFuente, type AdvisorSale, type TeamTodayRaw } from "@/lib/productivity";
import { buildTeamToday } from "@/lib/leads-team-today";

// Hora de Lima (UTC−5).
const lima = (date: string, time: string) => new Date(`${date}T${time}:00-05:00`).toISOString();

const sale = (over: Partial<AssistSale> = {}): AssistSale => ({
  vendedora: "medaly",
  leadId: "L1",
  occurredAt: lima("2026-11-16", "18:47"),
  net: 238,
  orderName: "#AUR900998",
  orderAt: lima("2026-11-16", "18:47"),
  ...over,
});
const call = (vendedora: string | null, status: string | null, at: string, over: Partial<AssistContact> = {}): AssistContact => ({
  lead_id: "L1",
  vendedora,
  kind: "call",
  new_status: status,
  occurred_at: at,
  ...over,
});

describe("la asistida de una venta (MOM §17.6)", () => {
  it("#AUR900998: Antu habló con la clienta y Medaly generó el pedido → asistida de Antu", () => {
    const contacts = [
      call("antu", "no_responde", lima("2026-11-16", "15:51")),
      call("antu", "contactado_dejo_wsp", lima("2026-11-16", "15:58")),
    ];
    expect(saleAssister(sale(), contacts)).toBe("antu");
  });

  it("no cuenta si la clienta no contestó, ni un mensaje, ni una fila sin firma", () => {
    expect(saleAssister(sale(), [call("antu", "no_responde", lima("2026-11-16", "15:51"))])).toBeNull();
    expect(saleAssister(sale(), [call("antu", "buzon", lima("2026-11-16", "15:51"))])).toBeNull();
    expect(saleAssister(sale(), [call("antu", null, lima("2026-11-16", "15:51"), { kind: "message" })])).toBeNull();
    expect(saleAssister(sale(), [call(null, "contactado_dejo_wsp", lima("2026-11-16", "15:51"))])).toBeNull();
    expect(isAssistContact({ vendedora: "a", kind: "message", new_status: "contactado_dejo_wsp" })).toBe(false);
  });

  it("no cuenta lo de la misma asesora que generó el pedido", () => {
    expect(saleAssister(sale(), [call("medaly", "casi_cierra", lima("2026-11-16", "16:00"))])).toBeNull();
  });

  it(`solo las ${ASSIST_WINDOW_HOURS} h antes de la venta, y nunca después`, () => {
    const s = sale({ occurredAt: lima("2026-11-16", "18:00") });
    expect(saleAssister(s, [call("antu", "casi_cierra", lima("2026-11-13", "18:00"))])).toBe("antu"); // justo 72 h
    expect(saleAssister(s, [call("antu", "casi_cierra", lima("2026-11-13", "17:59"))])).toBeNull();
    expect(saleAssister(s, [call("antu", "casi_cierra", lima("2026-11-16", "18:30"))])).toBeNull();
  });

  it("con varias, es de la primera que habló con ella; una sola por venta", () => {
    const contacts = [
      call("jessica", "volver_a_llamar", lima("2026-11-16", "12:00")),
      call("antu", "contactado_dejo_wsp", lima("2026-11-16", "10:00")),
      call("medaly", "casi_cierra", lima("2026-11-16", "09:00")),
    ];
    expect(saleAssister(sale(), contacts)).toBe("antu");
  });

  it("otro lead no cuenta, y las ventas de antes del 01-11-2026 tampoco", () => {
    expect(saleAssister(sale(), [call("antu", "casi_cierra", lima("2026-11-16", "15:58"), { lead_id: "L2" })])).toBeNull();
    const octubre = sale({ occurredAt: lima("2026-10-31", "20:00") });
    expect(saleAssister(octubre, [call("antu", "casi_cierra", lima("2026-10-31", "15:00"))])).toBeNull();
    expect(saleAssister(sale({ leadId: null }), [call("antu", "casi_cierra", lima("2026-11-16", "15:58"))])).toBeNull();
    expect(ASSIST_FROM_ISO).toBe(lima("2026-11-01", "00:00"));
  });

  it("las conversaciones que cuentan son las de la lista de estados del lead", () => {
    expect([...ASSIST_CONTACT_STATUSES].sort()).toEqual(
      ["casi_cierra", "contactado_dejo_wsp", "otros_productos", "sin_stock", "volver_a_llamar", "yape_por_verificar"],
    );
  });
});

describe("las asistidas de cada asesora", () => {
  it("suma ventas y monto, con sus pedidos en orden", () => {
    const sales = [
      sale(),
      sale({ leadId: "L2", net: 100, orderName: "#KP1", orderAt: lima("2026-11-15", "10:00"), occurredAt: lima("2026-11-15", "10:00") }),
      sale({ leadId: "L3", net: 50, orderName: "#KP2" }),
    ];
    const contacts = [
      call("antu", "contactado_dejo_wsp", lima("2026-11-16", "15:58")),
      call("antu", "casi_cierra", lima("2026-11-14", "12:00"), { lead_id: "L2" }),
      call("reyna", "otros_productos", lima("2026-11-16", "11:00"), { lead_id: "L3" }),
      call("reyna", "no_responde", lima("2026-11-16", "11:00"), { lead_id: "L1" }),
    ];
    const out = computeAssists(sales, contacts);
    expect(out.get("antu")).toEqual({
      asistidas: 2,
      ingresos: 338,
      detalle: [
        { name: "#KP1", at: lima("2026-11-15", "10:00") },
        { name: "#AUR900998", at: lima("2026-11-16", "18:47") },
      ],
    });
    expect(out.get("reyna")?.asistidas).toBe(1);
    expect(out.has("medaly")).toBe(false);
  });

  it("las llamadas se leen desde 72 h antes del rango, nunca antes del 01-11 menos 72 h", () => {
    expect(assistContactsFromIso(lima("2026-11-16", "00:00"))).toBe(lima("2026-11-13", "00:00"));
    expect(assistContactsFromIso(lima("2026-10-01", "00:00"))).toBe(lima("2026-10-29", "00:00"));
  });
});

describe("Productividad", () => {
  const advSale = (vendedora: string, leadId: string): AdvisorSale => ({
    vendedora,
    orderId: `o-${leadId}`,
    leadId,
    occurredAt: lima("2026-11-16", "18:47"),
    storeId: "aur",
    net: 238,
    orderName: "#AUR900998",
    orderAt: lima("2026-11-16", "18:47"),
    source: "web",
  });

  it("la venta sigue siendo de quien la generó; la asistida no suma a cerrados ni ingresos", () => {
    const sales = [advSale("medaly", "L1")];
    const assists = computeAssists(sales.map((s) => ({ ...s, leadId: s.leadId ?? null })), [
      call("antu", "contactado_dejo_wsp", lima("2026-11-16", "15:58")),
    ]);
    const rows = computeAdvisorStats({ calls: [], sales, leadStore: new Map(), emailById: new Map(), assists });
    const medaly = rows.find((r) => r.userId === "medaly")!;
    const antu = rows.find((r) => r.userId === "antu")!;
    expect(medaly).toMatchObject({ cerrados: 1, ingresos: 238, asistidas: 0 });
    expect(antu).toMatchObject({ cerrados: 0, ingresos: 0, asistidas: 1, asistidasIngresos: 238, porFuente: emptyPorFuente() });
    expect(antu.asistidasDetalle).toEqual([{ name: "#AUR900998", at: lima("2026-11-16", "18:47") }]);
  });

  it("sin asistidas, todas en cero", () => {
    const rows = computeAdvisorStats({ calls: [], sales: [advSale("medaly", "L1")], leadStore: new Map(), emailById: new Map() });
    expect(rows[0]).toMatchObject({ asistidas: 0, asistidasIngresos: 0, asistidasDetalle: [] });
  });

  it("el tablero y el periodo anterior leen las asistidas de las ventas ya filtradas por fuente", () => {
    const src = readFileSync("lib/productivity.ts", "utf8");
    expect(src.match(/await loadSaleAssists\(sb, scopedSales, endIso\)/g)).toHaveLength(2);
    expect(src).toContain('.in("new_status", [...ASSIST_CONTACT_STATUSES])');
    const table = readFileSync("components/productivity-table.tsx", "utf8");
    expect(table).toContain("<AssistLine r={r} />");
    expect(table).not.toContain("asesora del último toque");
  });
});

describe("Tablero de hoy de Leads", () => {
  const raw = (stats: TeamTodayRaw["stats"]): TeamTodayRaw => ({
    stats,
    activity: {},
    sales: { hoy: [], ayer: [], semana: [] },
    days: { hoy: "2026-11-16", ayer: "2026-11-15", semana: "2026-11-09", isoDow: 1 },
  });

  it("cada persona lleva sus asistidas de hoy, y quien solo asistió también sale", () => {
    const assists = computeAssists([sale()], [call("antu", "contactado_dejo_wsp", lima("2026-11-16", "15:58"))]);
    const stats = computeAdvisorStats({
      calls: [],
      sales: [
        {
          vendedora: "medaly",
          orderId: "o1",
          leadId: "L1",
          occurredAt: lima("2026-11-16", "18:47"),
          storeId: "aur",
          net: 238,
          orderName: "#AUR900998",
          orderAt: lima("2026-11-16", "18:47"),
          source: "web",
        },
      ],
      leadStore: new Map(),
      emailById: new Map([["medaly", "medaly@kapta.pe"], ["antu", "antu@kapta.pe"]]),
      assists,
    });
    const team = buildTeamToday({
      raw: raw(stats),
      nowIso: lima("2026-11-16", "19:00"),
      tz: "America/Lima",
      schedules: new Map(),
      viewerId: null,
      horasDeTodas: true,
    });
    const all = [...team.rows, ...team.quiet];
    const antu = all.find((r) => r.userId === "antu")!;
    expect(antu).toMatchObject({ pedidos: 0, asistidas: 1, asistidasDetalle: [{ code: "#AUR900998", fecha: "16/11/26" }] });
    expect(all.find((r) => r.userId === "medaly")).toMatchObject({ pedidos: 1, asistidas: 0 });
    // Las asistidas no suman a los pedidos del equipo.
    expect(team.totals.pedidos).toBe(1);
  });

  it("la tarjeta muestra «N asistidas» en la segunda línea de la persona", () => {
    const card = readFileSync("components/leads-insights.tsx", "utf8");
    expect(card).toContain("<Asistidas row={row} />");
    expect(card).toContain('!keepLine && "@3xl:hidden"');
    const src = readFileSync("lib/productivity.ts", "utf8");
    expect(src).toContain("const assists = await loadSaleAssists(sb, scopedSales, today.endIso);");
  });
});
