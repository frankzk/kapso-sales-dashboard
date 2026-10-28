import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isHistoricalShopifyOrder, LEGACY_SALE_CANCELLED, legacySaleCancelBlocks, legacySaleCancelledAt, validateLegacySaleCancelReason } from "@/lib/legacy-sale-cancel";
import { resolveOrderState, type GuideSnapshot, type OrderSnapshot } from "@/lib/order-status";
import { resolveMacroStage, type MacroGuideSnapshot, type MacroOrderSnapshot } from "@/lib/order-macro-stage";
import { WooCancelZone } from "@/components/woo-cancel-zone";
import { masterDoorVerdict } from "@/lib/master-door";

const before = "2026-10-01T12:00:00Z";
const at = "2026-10-28T16:00:00Z";
const after = "2026-10-29T12:00:00Z";
const cancel = { kind: LEGACY_SALE_CANCELLED, occurred_at: at, source: "kapta", new_status: "anulado", courier: null, new_operational: "anulado" };
const order = { created_at: before, cancelled_at: null, financial_status: "pending", shipping_mode: "cod", region: "Lima", province: "Lima", district: "Miraflores", coverage: "lima", order_created_at: before };
const output = Object.freeze({ id: "s1", courier: "propio", guide_code: "MOM-1", delivery_status: "pendiente", attempts: 0,
  assigned_at: before, dispatched_at: before, custody_transferred_at: before, custody_state: "courier",
  returned_at: null, closed_at: null, updated_at: before, created_at: before });
const facts = { platform: "shopify", generalStatus: "en_proceso", financialStatus: "pending", shipments: [output], payments: [], companion: null };
const state = (events = [cancel]) => resolveOrderState({ order: order as OrderSnapshot, guides: [output as GuideSnapshot], events, override: null });
const macro = (guides: readonly Record<string, unknown>[] = [output], events: Record<string, unknown>[] = [cancel]) => resolveMacroStage({
  order: order as unknown as MacroOrderSnapshot, guides: guides as unknown as MacroGuideSnapshot[],
  events: events as unknown as typeof cancel[], legacy: { general: "en_proceso", operational: "en_ruta", since: before }, paymentState: null,
});

describe("venta histórica de Shopify terminada en Kapta", () => {
  it("solo admite pedidos Shopify anteriores a la migración de su tienda", () => {
    const input = { orderPlatform: "shopify", orderCreatedAt: before, storePlatform: "woocommerce", switchedAt: at };
    expect(isHistoricalShopifyOrder(input)).toBe(true);
    expect(isHistoricalShopifyOrder({ ...input, orderPlatform: "woocommerce" })).toBe(false);
    expect(isHistoricalShopifyOrder({ ...input, storePlatform: "shopify" })).toBe(false);
    expect(isHistoricalShopifyOrder({ ...input, switchedAt: null })).toBe(false);
    expect(isHistoricalShopifyOrder({ ...input, orderCreatedAt: after })).toBe(false);
  });
  it("exige código y motivo escritos, también para «no se logró entregar»", () => {
    expect(validateLegacySaleCancelReason("entrega_no_lograda", "No se volverá a enviar")).toMatchObject({ ok: true });
    expect(validateLegacySaleCancelReason("otro", " ").ok).toBe(false);
    expect(validateLegacySaleCancelReason("inventado", "No se volverá a enviar").ok).toBe(false);
    expect(validateLegacySaleCancelReason("otro", "x".repeat(501)).ok).toBe(false);
  });
  it("permite terminar la venta con una caja en calle o ya devuelta, sin alterar la caja", () => {
    expect(legacySaleCancelBlocks(facts)).toEqual([]);
    expect(legacySaleCancelBlocks({ ...facts, generalStatus: "devuelto" })).toEqual([]);
    expect(state()).toMatchObject({ general: "anulado", source: "kapta", dispatchedAt: before });
    expect(output.custody_state).toBe("courier");
    expect(output.returned_at).toBeNull();
    expect(order.cancelled_at).toBeNull();
  });
  it("no acepta una entrega registrada ni pagos sin resolver por este permiso", () => {
    expect(legacySaleCancelBlocks({ ...facts, generalStatus: "entregado" })).not.toEqual([]);
    expect(legacySaleCancelBlocks({ ...facts, shipments: [{ ...output, delivery_status: "entregado" }] })).not.toEqual([]);
    expect(legacySaleCancelBlocks({ ...facts, financialStatus: "paid" })).not.toEqual([]);
    expect(legacySaleCancelBlocks({ ...facts, payments: [{ validation_status: "pendiente" }] })).not.toEqual([]);
    expect(legacySaleCancelBlocks({ ...facts, companion: { travelsIn: "otro", carries: [] } })).not.toEqual([]);
  });
  it("ni un reporte de entrega, confirmación, guía nueva o cierre de ruta reactiva la venta", () => {
    for (const event of [
      { ...cancel, kind: "delivered", occurred_at: after, new_status: "entregado", source: "courier" },
      { ...cancel, kind: "confirmed", occurred_at: after },
      { ...cancel, kind: "guide_registered", occurred_at: after },
      { ...cancel, kind: "status_override", occurred_at: after, source: "ruta", new_status: "entregado" },
      { ...cancel, kind: "status_override", occurred_at: after, source: "liquidacion", new_status: "entregado" },
    ]) expect(state([cancel, event]).general).toBe("anulado");
  });
  it("solo una corrección manual posterior permite reactivar la venta", () => {
    const corrected = { ...cancel, kind: "status_override", source: "manual", new_status: "en_proceso", occurred_at: after };
    expect(legacySaleCancelledAt([cancel, corrected])).toBeNull();
    expect(legacySaleCancelledAt([cancel, { ...corrected, occurred_at: before }])).toBe(at);
    expect(legacySaleCancelledAt([cancel, { ...corrected, new_status: "devuelto" }])).toBe(at);
    expect(legacySaleCancelledAt([{ ...cancel, occurred_at: after }, corrected])).toBe(after);
  });
  it("la puerta de Rutas y Liquidaciones no escribe entregado sobre la anulación local", () => {
    expect(masterDoorVerdict({ target: "entregado" }, { cancelledAt: at, cancelledInKapta: true }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("anulada en Kapta") });
  });
  it("la venta anulada sigue Por cerrar con retorno y liquidación pendientes", () => {
    const result = macro();
    expect(result.stage).toBe("por_cerrar");
    expect(result.reasons).toContain("devolucion_fisica_pendiente");
    expect(result.reasons).toContain("pendiente_liquidacion");
    expect(result.reasons).not.toContain("recuperacion_vencida");
  });
  it("una caja preparada sin despacho sigue pendiente de anularse por su propio flujo", () => {
    expect(macro([{ ...output, dispatched_at: null, custody_transferred_at: null, custody_state: "empresa" } as unknown as typeof output]))
      .toMatchObject({ stage: "por_cerrar", reasons: ["salida_adicional_activa"] });
    expect(macro([])).toMatchObject({ stage: "finalizado", substage: "anulado_cerrado" });
  });
  it("recibir e inventariar la caja no liquida el flete", () => {
    const returned = { ...output, delivery_status: "anulado", custody_state: "devuelto", returned_at: after };
    const events = [cancel, { kind: "inventory_reconciled", occurred_at: after, shipment_id: "s1" }];
    expect(macro([returned], events).reasons).toContain("pendiente_liquidacion");
    expect(macro([returned], [...events, { kind: "liquidation_closed", occurred_at: after }]).stage).toBe("finalizado");
  });
  it("Agencia conserva su cierre por inventario, sin inventar una liquidación de reparto", () => {
    const returned = { ...output, courier: "shalom", delivery_status: "anulado", custody_state: "devuelto", returned_at: after };
    const result = resolveMacroStage({
      order: { ...order, coverage: "agencia" } as unknown as MacroOrderSnapshot,
      guides: [returned] as unknown as MacroGuideSnapshot[],
      events: [cancel, { kind: "inventory_reconciled", occurred_at: after, shipment_id: "s1" }],
      legacy: { general: "anulado", operational: "anulado", since: at }, paymentState: null,
    });
    expect(result.reasons).not.toContain("pendiente_liquidacion");
    expect(result.stage).toBe("finalizado");
  });
  it("la ficha explica que termina la venta sin prometer devolución ni tocar Shopify", () => {
    const html = renderToStaticMarkup(createElement(WooCancelZone, {
      mode: "shopify_history", orderName: "#AUR177555", facts, pending: false, onCancel: async () => true,
    }));
    expect(html).toContain("Anular venta de pedido histórico");
    expect(html).toContain("Las guías no se cancelan solas");
    expect(html).toContain("El original de Shopify");
    expect(html).toContain("Anular pedido…");
    expect(html).not.toContain("Todavía no se puede anular");
  });
});
