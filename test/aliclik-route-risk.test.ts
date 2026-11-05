import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NIGHT_ORDER_MIN_DAYS,
  ROUTE_RISK_ROUTES_LABEL,
  aliclikRouteRisk,
  aliclikRouteRiskGate,
  dispatchRecord,
  isFailedDispatch,
  isNightOrder,
  limaClockOf,
  routeRiskReasonText,
} from "@/lib/aliclik-route-risk";
import type { PriorOrderSnapshot } from "@/lib/order-confirmation-brief";

/**
 * MOM §8.6 (owner, 05-11-2026). En Provincia COD, Aliclik se cierra para el
 * pedido —quedan Swayp/Fénix o agencia con adelanto— en los dos únicos grupos
 * que se entregaron la mitad o menos en abr–ago Y en sep–nov:
 *
 *   * despacho fallido y ningún entregado: 35/76 y 41/76;
 *   * madrugada (00:00–05:59, Lima) con 2+ días de gestión: 3/14 y 14/43.
 *
 * Se levanta con motivo escrito; el automático no lo escribe nunca.
 */

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");

const prior = (over: Partial<PriorOrderSnapshot>): PriorOrderSnapshot => ({
  order_id: Math.random().toString(36).slice(2),
  order_name: "#KP1",
  order_created_at: "2026-09-01T15:00:00.000Z",
  general_status: "en_proceso",
  macro_stage: "en_curso",
  order_total: 159,
  ...over,
});

// 03:40 en Lima = 08:40 UTC (Perú es UTC-5 fijo).
const MADRUGADA = "2026-11-04T08:40:00.000Z";
// 06:00 en Lima: ya no es madrugada.
const SEIS_AM = "2026-11-04T11:00:00.000Z";
// 23:59 en Lima del día anterior: tampoco.
const NOCHE = "2026-11-04T04:59:00.000Z";

describe("qué es madrugada: 00:00–05:59 en Lima", () => {
  it("se lee en hora de Lima, no en UTC", () => {
    expect(limaClockOf(MADRUGADA)).toBe("03:40");
    expect(isNightOrder(MADRUGADA)).toBe(true);
    expect(isNightOrder("2026-11-04T05:00:00.000Z")).toBe(true); // 00:00 Lima
    expect(isNightOrder("2026-11-04T10:59:00.000Z")).toBe(true); // 05:59 Lima
  });

  it("las 06:00 y las 23:59 no son madrugada; sin fecha, tampoco", () => {
    expect(isNightOrder(SEIS_AM)).toBe(false);
    expect(isNightOrder(NOCHE)).toBe(false);
    expect(isNightOrder(null)).toBe(false);
    expect(isNightOrder("no es fecha")).toBe(false);
  });
});

describe("qué es un despacho fallido", () => {
  it("devuelto siempre; anulado solo si salió", () => {
    expect(isFailedDispatch(prior({ general_status: "devuelto" }))).toBe(true);
    expect(isFailedDispatch(prior({ general_status: "anulado", dispatched_at: "2026-09-02T12:00:00Z" }))).toBe(true);
    // Nueve de cada diez anulados se caen antes de salir: no costaron flete.
    expect(isFailedDispatch(prior({ general_status: "anulado", dispatched_at: null }))).toBe(false);
    expect(isFailedDispatch(prior({ general_status: "anulado", guide_code: "AUR1" }))).toBe(false);
  });

  it("lo que sigue en curso todavía no es un fallo", () => {
    expect(isFailedDispatch(prior({ general_status: "en_proceso", dispatched_at: "2026-09-02T12:00:00Z" }))).toBe(false);
  });

  it("cuenta fallidos y entregados", () => {
    expect(
      dispatchRecord([
        prior({ general_status: "devuelto" }),
        prior({ general_status: "entregado" }),
        prior({ general_status: "anulado" }),
      ]),
    ).toEqual({ failed: 1, delivered: 1 });
  });
});

describe("cuándo se cierra Aliclik", () => {
  const base = {
    operation: "provincia_cod",
    orderCreatedAt: SEIS_AM,
    confirmationDays: 1,
    priors: [] as PriorOrderSnapshot[],
  };

  it("un cliente nuevo de día: abierto", () => {
    expect(aliclikRouteRisk(base)).toEqual({ closed: false, reasons: [], nightPending: false });
  });

  it("despacho fallido y ningún entregado: cerrado", () => {
    const risk = aliclikRouteRisk({ ...base, priors: [prior({ general_status: "devuelto" })] });
    expect(risk.closed).toBe(true);
    expect(risk.reasons).toEqual([{ kind: "fallido_sin_entregado", failed: 1 }]);
  });

  it("con un entregado, el fallido ya no cierra: ese cliente sí recibe", () => {
    const risk = aliclikRouteRisk({
      ...base,
      priors: [prior({ general_status: "devuelto" }), prior({ general_status: "entregado" })],
    });
    expect(risk.closed).toBe(false);
  });

  it("solo anulados que nunca salieron: abierto (es la escalera del §8, no esto)", () => {
    const risk = aliclikRouteRisk({
      ...base,
      priors: [prior({ general_status: "anulado" }), prior({ general_status: "anulado" })],
    });
    expect(risk.closed).toBe(false);
  });

  it("madrugada + 2 días de gestión: cerrado; con un día, solo el aviso", () => {
    const night = { ...base, orderCreatedAt: MADRUGADA };
    expect(aliclikRouteRisk({ ...night, confirmationDays: 1 })).toEqual({
      closed: false,
      reasons: [],
      nightPending: true,
    });
    const risk = aliclikRouteRisk({ ...night, confirmationDays: NIGHT_ORDER_MIN_DAYS });
    expect(risk.closed).toBe(true);
    expect(risk.reasons).toEqual([{ kind: "madrugada_gestion", time: "03:40", days: 2 }]);
  });

  it("dos días de gestión sin madrugada: abierto (~55 %, cada señal sola no cierra)", () => {
    expect(aliclikRouteRisk({ ...base, confirmationDays: 4 }).closed).toBe(false);
  });

  it("un pedido que ya salió no usa los días de después: la madrugada no lo cierra", () => {
    const risk = aliclikRouteRisk({
      ...base,
      orderCreatedAt: MADRUGADA,
      confirmationDays: 5,
      alreadyDispatched: true,
    });
    expect(risk).toEqual({ closed: false, reasons: [], nightPending: false });
  });

  it("las dos señales a la vez: un cierre con los dos motivos", () => {
    const risk = aliclikRouteRisk({
      ...base,
      orderCreatedAt: MADRUGADA,
      confirmationDays: 3,
      priors: [prior({ general_status: "devuelto" })],
    });
    expect(risk.reasons.map((r) => r.kind)).toEqual(["fallido_sin_entregado", "madrugada_gestion"]);
  });

  it("solo en Provincia COD: Lima y Agencia no se tocan", () => {
    for (const operation of ["lima", "agencia", "desconocida", null]) {
      const risk = aliclikRouteRisk({
        ...base,
        operation,
        orderCreatedAt: MADRUGADA,
        confirmationDays: 3,
        priors: [prior({ general_status: "devuelto" })],
      });
      expect(risk.closed, String(operation)).toBe(false);
      expect(risk.nightPending, String(operation)).toBe(false);
    }
  });
});

describe("la compuerta: se levanta con motivo escrito", () => {
  const closed = aliclikRouteRisk({
    operation: "provincia_cod",
    orderCreatedAt: SEIS_AM,
    confirmationDays: 1,
    priors: [prior({ general_status: "devuelto" })],
  });

  it("sin motivo, o con uno de trámite, no pasa y dice qué ofrecer", () => {
    for (const reason of [null, "", "   ", "ok ok"]) {
      const gate = aliclikRouteRiskGate(closed, reason);
      expect(gate.allowed, String(reason)).toBe(false);
      expect(gate.requiresException).toBe(true);
      expect(gate.message).toContain(ROUTE_RISK_ROUTES_LABEL);
    }
  });

  it("con motivo de verdad pasa, y queda marcado como excepción", () => {
    expect(aliclikRouteRiskGate(closed, "Confirmó por videollamada, recibe hoy")).toEqual({
      allowed: true,
      requiresException: true,
      message: null,
    });
  });

  it("abierto no pide nada", () => {
    const open = aliclikRouteRisk({ operation: "provincia_cod", orderCreatedAt: SEIS_AM, confirmationDays: 1, priors: [] });
    expect(aliclikRouteRiskGate(open, null)).toEqual({ allowed: true, requiresException: false, message: null });
  });

  it("los motivos se leen en cristiano", () => {
    expect(routeRiskReasonText({ kind: "fallido_sin_entregado", failed: 2 })).toContain("2 pedidos que salieron");
    expect(routeRiskReasonText({ kind: "madrugada_gestion", time: "03:40", days: 2 })).toContain("(03:40)");
  });
});

describe("la regla vive donde se decide", () => {
  it("la creación de la guía la aplica después del cierre por la puerta, y audita la excepción", () => {
    const src = read("lib/aliclik-guide.ts");
    const door = src.indexOf("if (doorBan.banned) return blocked(");
    const route = src.indexOf("const routeGate = aliclikRouteRiskGate(routeRisk, input.routeRiskExceptionReason);");
    expect(door).toBeGreaterThan(0);
    expect(route).toBeGreaterThan(door);
    expect(src).toContain("alreadyDispatched: Boolean(ctx.row.dispatched_at),");
    expect(src).toContain("confirmationDays: ctx.row.confirmation_day_count,");
    expect(src).toContain('kind: "aliclik_route_risk_exception",');
  });

  it("la ficha trae la fecha de despacho de los otros pedidos", () => {
    expect(read("lib/orders-master-access.ts")).toContain(
      '"guide_code,current_courier,last_courier,delivered_courier,attempt_count,dispatched_at",',
    );
  });

  it("la asesora lo ve en Registrar intento y en el panel de Aliclik", () => {
    const drawer = read("components/order-drawer.tsx");
    const desk = drawer.indexOf('<h4 className="text-sm font-semibold text-ink-900">Registrar intento</h4>');
    expect(desk).toBeGreaterThan(0);
    expect(drawer.indexOf("{routeRisk?.closed && (", desk)).toBeGreaterThan(desk);
    expect(drawer).toContain("routeRisk={");
    const panel = read("components/aliclik-guide-panel.tsx");
    expect(panel).toContain("routeRiskExceptionReason: routeRiskExceptionReason || null,");
    expect(panel).toContain('"Escribe por qué sale por Aliclik pese al riesgo, arriba."');
  });

  it("la excepción tiene nombre en la línea de tiempo", () => {
    expect(read("components/order-master-shared.tsx")).toContain(
      'aliclik_route_risk_exception: "Aliclik pese al riesgo de no entrega",',
    );
  });

  it("y el MOM lo dice", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("### 8.6 Aliclik cerrado para el pedido por riesgo de no entrega (05-11-2026)");
    expect(mom).toContain("| 35/76 (46 %) | 41/76 (54 %) |");
    expect(mom).toContain("**Se levanta con motivo escrito**");
  });
});
