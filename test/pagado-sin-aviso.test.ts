import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  createServerSupabase: vi.fn(),
  createAdminSupabase: vi.fn(),
}));

import {
  AGENCY_DEADLINE_ALERT_MS,
  PAID_UNNOTIFIED_LABEL,
  agencyDeadlineBadge,
  agencyDeadlineSoon,
  paidUnnotifiedCandidate,
  paidUnnotifiedOrderIds,
  withPaidUnnotified,
} from "@/lib/agency-pickup-alert";
import { loadPaidUnnotified } from "@/lib/agency-pickup-alert-access";
import { applyServerFilters, withPaidUnnotifiedFilter } from "@/lib/orders-master-access";
import { emptyFilters, hasActiveFilters, matchesFilters, type MasterFilters } from "@/lib/order-master-filters";
import { buildMasterQuery, parseMasterQuery } from "@/lib/master-query";
import { NO_ORDER_ID } from "@/lib/pending-voucher";
import type { OrderMasterRow } from "@/lib/types";

/**
 * «Pagado sin aviso» y el plazo de la agencia en el Master (MOM §12, owner,
 * 25-10-2026). #KP141593, #KP142910, #KP140003: clientas de Olva que pagaron
 * completo, el aviso de llegada —de cobro— se omitió, y nadie vio en el Master
 * que el paquete llevaba días en la oficina con el plazo corriendo.
 */

const NOW = "2026-10-25T20:00:00Z";
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const C = "33333333-3333-3333-3333-333333333333";

/** Vence a las `hours` horas de NOW (negativo: ya venció). */
const vence = (hours: number) => new Date(Date.parse(NOW) + hours * 3600_000).toISOString();

function row(over: Partial<OrderMasterRow> = {}): OrderMasterRow {
  return {
    order_id: A,
    pickup_state: "disponible_para_recojo",
    agency_expires_at: vence(30),
    payment_state: "pago_completo",
    attempt_count: 0,
    courier_count: 1,
    comment_count: 0,
    ...over,
  } as OrderMasterRow;
}

describe("¿vence pronto?", () => {
  it("con el mismo margen que «Próximos a vencer» del servidor (2 días), incluido lo vencido", () => {
    expect(AGENCY_DEADLINE_ALERT_MS).toBe(2 * 86_400_000);
    expect(agencyDeadlineSoon(row({ agency_expires_at: vence(47) }), NOW)).toBe(true);
    expect(agencyDeadlineSoon(row({ agency_expires_at: vence(-5) }), NOW)).toBe(true);
    expect(agencyDeadlineSoon(row({ agency_expires_at: vence(49) }), NOW)).toBe(false);
  });

  it("solo si sigue en la agencia: recogido o entregado conserva la fecha pero ya no vence", () => {
    expect(agencyDeadlineSoon(row({ pickup_state: "recogido" }), NOW)).toBe(false);
    expect(agencyDeadlineSoon(row({ pickup_state: "entregado" }), NOW)).toBe(false);
    expect(agencyDeadlineSoon(row({ agency_expires_at: null }), NOW)).toBe(false);
  });
});

describe("candidato a «Pagado sin aviso»", () => {
  it("pagado, en la agencia y por vencer", () => {
    expect(paidUnnotifiedCandidate(row(), NOW)).toBe(true);
  });

  it("no si debe algo: a ésa le llega el de cobro y el recordatorio", () => {
    expect(paidUnnotifiedCandidate(row({ payment_state: "adelanto_validado" }), NOW)).toBe(false);
  });

  it("no si el courier ya declaró que la avisó", () => {
    expect(paidUnnotifiedCandidate(row({ pickup_state: "cliente_notificado" }), NOW)).toBe(false);
  });

  it("no si el plazo aún está lejos", () => {
    expect(paidUnnotifiedCandidate(row({ agency_expires_at: vence(24 * 5) }), NOW)).toBe(false);
  });

  it("de los candidatos quedan los que no tienen aviso de llegada enviado", () => {
    expect(paidUnnotifiedOrderIds([{ order_id: A }, { order_id: B }, { order_id: A }], new Set([B]))).toEqual([A]);
  });
});

describe("la chapa de la fila", () => {
  it("pagado sin aviso: crítico, con el plazo", () => {
    const b = agencyDeadlineBadge(row({ paid_unnotified: true, agency_expires_at: vence(2) }), NOW)!;
    expect(b.tone).toBe("crit");
    expect(b.text).toBe(`${PAID_UNNOTIFIED_LABEL} · vence hoy`);
    expect(b.title).toMatch(/DNI/);
  });

  it("vence mañana: atención; vencido: crítico", () => {
    expect(agencyDeadlineBadge(row({ agency_expires_at: vence(20) }), NOW)).toMatchObject({ tone: "warn", text: "Vence mañana" });
    expect(agencyDeadlineBadge(row({ agency_expires_at: vence(-3) }), NOW)).toMatchObject({ tone: "crit", text: "Plazo vencido" });
  });

  it("sin plazo cerca, o ya recogido, no hay chapa", () => {
    expect(agencyDeadlineBadge(row({ agency_expires_at: vence(24 * 5) }), NOW)).toBeNull();
    expect(agencyDeadlineBadge(row({ pickup_state: "recogido", paid_unnotified: true }), NOW)).toBeNull();
  });
});

/** Un Supabase de mentira que respeta los filtros que usa la lectura. */
function fakeSb(tables: { master: any[]; notices: any[]; failNotices?: boolean }) {
  const calls: { table: string; filters: [string, string, unknown][] }[] = [];
  return {
    calls,
    from(table: string) {
      const filters: [string, string, unknown][] = [];
      calls.push({ table, filters });
      const chain: any = {
        select: () => chain,
        in: (c: string, v: unknown) => (filters.push(["in", c, v]), chain),
        eq: (c: string, v: unknown) => (filters.push(["eq", c, v]), chain),
        not: () => chain,
        lte: () => chain,
        limit: () => chain,
        then(res: any, rej: any) {
          if (table === "shalom_transit_notifications" && tables.failNotices) {
            return Promise.resolve({ data: null, error: { code: "x", message: "caída" } }).then(res, rej);
          }
          let data = table === "order_master" ? tables.master : tables.notices;
          for (const [op, c, v] of filters) {
            data = data.filter((r: any) => (op === "in" ? (v as unknown[]).includes(r[c]) : r[c] === v));
          }
          return Promise.resolve({ data, error: null }).then(res, rej);
        },
      };
      return chain;
    },
  } as any;
}

describe("la lectura: dos consultas por carga, ninguna por fila", () => {
  const master = [
    { store_id: "s", order_id: A, pickup_state: "disponible_para_recojo", agency_expires_at: vence(10), payment_state: "pago_completo" },
    { store_id: "s", order_id: B, pickup_state: "pendiente_de_recojo", agency_expires_at: vence(-10), payment_state: "pago_completo" },
    { store_id: "s", order_id: C, pickup_state: "disponible_para_recojo", agency_expires_at: vence(10), payment_state: "pago_completo" },
  ];

  it("quita a quien ya tiene un aviso de llegada (o un recordatorio) enviado", async () => {
    const sb = fakeSb({
      master,
      notices: [
        { order_id: B, kind: "disponible", status: "sent" },
        // Un aviso omitido o fallido no es un aviso: C sigue sin saber.
        { order_id: C, kind: "disponible", status: "skipped" },
        // El de tránsito dice que va en camino, no que llegó.
        { order_id: A, kind: "transito", status: "sent" },
      ],
    });
    const ids = await loadPaidUnnotified(sb, ["s"], new Date(NOW));
    expect([...ids!].sort()).toEqual([A, C]);
    expect(sb.calls.map((c: any) => c.table)).toEqual(["order_master", "shalom_transit_notifications"]);
  });

  it("si la cola no se puede leer, null: no se afirma que nadie espera", async () => {
    expect(await loadPaidUnnotified(fakeSb({ master, notices: [], failNotices: true }), ["s"], new Date(NOW))).toBeNull();
  });

  it("sin candidatos no consulta la cola", async () => {
    const sb = fakeSb({ master: [], notices: [] });
    expect((await loadPaidUnnotified(sb, ["s"], new Date(NOW)))!.size).toBe(0);
    expect(sb.calls).toHaveLength(1);
  });
});

describe("el filtro «Pagado sin aviso»", () => {
  it("viaja por la URL como pa=1 y cuenta como filtro activo", () => {
    expect(parseMasterQuery(new URLSearchParams("pa=1")).filters.paidUnnotified).toBe(true);
    const f: MasterFilters = { ...emptyFilters(), paidUnnotified: true };
    expect(hasActiveFilters(f)).toBe(true);
    expect(buildMasterQuery({ filters: { ...f, paidUnnotifiedOrderIds: [A] }, sortKey: "created", page: 1 }).toString()).toBe("pa=1");
  });

  const sb = createClient("http://local", "anon");
  const url = (f: MasterFilters) =>
    (applyServerFilters(sb.from("order_master").select("id"), f, new Date(NOW)) as unknown as { url: URL }).url;

  it("en la base trae los pedidos resueltos; sin ninguno o sin lectura, ninguno (nunca todos)", () => {
    expect(url(withPaidUnnotifiedFilter({ ...emptyFilters(), paidUnnotified: true }, new Set([A, B]))).searchParams.get("order_id")).toBe(
      `in.(${A},${B})`,
    );
    expect(url(withPaidUnnotifiedFilter({ ...emptyFilters(), paidUnnotified: true }, null)).searchParams.get("order_id")).toBe(
      `in.(${NO_ORDER_ID})`,
    );
    expect(withPaidUnnotifiedFilter(emptyFilters(), new Set([A]))).toEqual(emptyFilters());
  });

  it("matchesFilters dice lo mismo sobre la fila decorada", () => {
    const [con, sin] = withPaidUnnotified([row({ order_id: A }), row({ order_id: B })], new Set([A]));
    const f: MasterFilters = { ...emptyFilters(), paidUnnotified: true };
    expect(matchesFilters(con as OrderMasterRow, f, NOW)).toBe(true);
    expect(matchesFilters(sin as OrderMasterRow, f, NOW)).toBe(false);
    // Sin lectura, las filas quedan como estaban.
    expect(withPaidUnnotified([row()], null)[0]).not.toHaveProperty("paid_unnotified");
  });

  it("la página lo lee una vez por carga, a la par, y la píldora y la chapa existen", () => {
    const page = readFileSync(join(process.cwd(), "app/dashboard/pedidos/page.tsx"), "utf8");
    expect(page).toContain("getPaidUnnotifiedIds(storeIds)");
    expect(page).toContain("paidUnnotifiedCount=");
    const board = readFileSync(join(process.cwd(), "components/orders-master.tsx"), "utf8");
    expect(board).toContain("label={PAID_UNNOTIFIED_LABEL}");
    expect(board).toContain("agencyDeadlineBadge(r, nowIso)");
    const exp = readFileSync(join(process.cwd(), "app/api/export/pedidos/route.ts"), "utf8");
    expect(exp).toContain("withPaidUnnotifiedFilter");
  });
});
