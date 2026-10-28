import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { applyServerFilters } from "@/lib/orders-master-access";
import { buildMasterQuery, hasQueryFilters, parseMasterQuery } from "@/lib/master-query";
import { emptyFilters, hasActiveFilters, matchesFilters, paymentStatesForFilter } from "@/lib/order-master-filters";
import type { OrderMasterRow } from "@/lib/types";

const filter = (...states: string[]) => ({ ...emptyFilters(), paymentStates: new Set(states) });
const row = (payment_state: string | null, extra: Partial<OrderMasterRow> = {}): OrderMasterRow => ({
  id: "order", store_id: "kenku", payment_state, comment_count: 0,
  courier_count: 0, attempt_count: 0, ...extra,
}) as OrderMasterRow;
const now = new Date("2026-10-27T16:00:00Z");
const sb = createClient("http://local", "anon");
const query = (...states: string[]) => (applyServerFilters(
  sb.from("order_master").select("id"), filter(...states), now,
) as unknown as { url: URL }).url.searchParams;

describe("Estado de pago del Master", () => {
  it("sin selección mantiene todos los pedidos", () => {
    expect(matchesFilters(row(null), emptyFilters())).toBe(true);
    expect(query().has("payment_state")).toBe(false);
    expect(query().has("or")).toBe(false);
  });

  it("Pago completo incluye el prepago web confirmado y pagos validados", () => {
    const web = row("pago_completo", { financial_status: "paid", payment_gateway: "checkout", total_refunded: 0 });
    expect(matchesFilters(web, filter("pago_completo"))).toBe(true);
    expect(matchesFilters(row("pago_completo"), filter("pago_completo"))).toBe(true);
    expect(query("pago_completo").get("payment_state")).toBe("in.(pago_completo)");
  });

  it("un paid sin pasarela no reemplaza el estado del pago ni lo da por completo", () => {
    expect(matchesFilters(row(null, { financial_status: "paid", payment_gateway: "cod" }), filter("pago_completo"))).toBe(false);
    expect(matchesFilters(row("pago_total_cargado"), filter("pago_completo"))).toBe(false);
    expect(matchesFilters(row("posible_duplicado"), filter("pago_completo"))).toBe(false);
  });

  it.each(["adelanto_cargado", "diferencia_cargada", "pago_total_cargado", "posible_duplicado"])(
    "pendiente de validar incluye %s", (state) => {
      expect(matchesFilters(row(state), filter("pendiente_validacion"))).toBe(true);
      expect(matchesFilters(row(state), filter("pago_parcial"))).toBe(false);
    },
  );

  it("Pago parcial exige el adelanto validado con diferencia pendiente", () => {
    expect(matchesFilters(row("adelanto_validado"), filter("pago_parcial"))).toBe(true);
    expect(matchesFilters(row("pago_completo"), filter("pago_parcial"))).toBe(false);
    expect(query("pago_parcial").get("payment_state")).toBe("in.(adelanto_validado)");
  });

  it.each(["sin_pago", null])("Sin pago registrado incluye %s", (state) => {
    expect(matchesFilters(row(state), filter("sin_pago"))).toBe(true);
    expect(matchesFilters(row(state), filter("pago_completo"))).toBe(false);
  });

  it("el servidor pide explícitamente los NULL para no perder pedidos sin señales", () => {
    expect(query("sin_pago").get("or")).toBe("(payment_state.is.null,payment_state.in.(sin_pago))");
    expect(query("sin_pago", "pago_completo").get("or"))
      .toBe("(payment_state.is.null,payment_state.in.(sin_pago,pago_completo))");
  });

  it("varias opciones suman estados y se combinan con tienda y cobro del courier", () => {
    const f = { ...filter("pago_completo", "pago_parcial"), stores: new Set(["kenku"]), paymentChecks: new Set(["validado"]) };
    expect(matchesFilters(row("pago_completo", { payment_check_state: "validado" }), f)).toBe(true);
    expect(matchesFilters(row("adelanto_validado", { payment_check_state: "validado" }), f)).toBe(true);
    expect(matchesFilters(row("pago_completo", { payment_check_state: "pendiente" }), f)).toBe(false);
    expect(matchesFilters(row("pago_completo", { store_id: "otra", payment_check_state: "validado" }), f)).toBe(false);
    expect(query("pago_completo", "pago_parcial").get("payment_state"))
      .toBe("in.(pago_completo,adelanto_validado)");
  });

  it("la URL conserva las selecciones, paginación y demás filtros", () => {
    const filters = { ...filter("pago_completo", "pendiente_validacion"), couriers: new Set(["propio"]) };
    const encoded = buildMasterQuery({ filters, page: 3, sortKey: "created" });
    expect(encoded.get("ps")).toBe("pago_completo,pendiente_validacion");
    const decoded = parseMasterQuery(encoded);
    expect(decoded.filters.paymentStates).toEqual(filters.paymentStates);
    expect(decoded.filters.couriers).toEqual(filters.couriers);
    expect(decoded.page).toBe(3);
    expect(hasQueryFilters(decoded.filters)).toBe(true);
    expect(hasActiveFilters(filter("pago_completo"))).toBe(true);
    expect(hasQueryFilters(emptyFilters())).toBe(false);
  });

  it("ignora opciones desconocidas sin introducirlas en PostgREST", () => {
    const decoded = parseMasterQuery(new URLSearchParams("ps=__proto__,inventado,pago_completo"));
    expect(decoded.filters.paymentStates).toEqual(new Set(["pago_completo"]));
    expect(paymentStatesForFilter(new Set(["__proto__", "inventado"]))).toEqual([]);
    expect(query("inventado").has("payment_state")).toBe(false);
  });
});
