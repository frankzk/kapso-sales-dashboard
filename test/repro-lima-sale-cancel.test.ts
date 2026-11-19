// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReproLimaSaleCancel, reproSaleCancelBlocks, type ReproSaleCancelContext } from "@/components/repro-lima-sale-cancel";

const api = vi.hoisted(() => ({ cancelGf: vi.fn() }));
vi.mock("@/app/dashboard/pedidos/gf-courier-actions", () => ({ cancelGfCourierGuide: api.cancelGf }));
vi.mock("@/app/dashboard/pedidos/gf-output-cancel-actions", () => ({ cancelGfOutputBeforeDispatch: vi.fn() }));
vi.mock("@/app/dashboard/pedidos/aliclik-actions", () => ({ cancelAliclikGuide: vi.fn() }));
vi.mock("@/components/order-master-shared", () => ({ FenixCancelButton: () => null, ManualOutputCancelButton: () => null, ShalomCancelButton: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
const confirm = vi.fn();
const refreshed = vi.fn();
const context = (over: Partial<ReproSaleCancelContext> = {}): ReproSaleCancelContext => ({
  mode: "woocommerce", facts: { platform: "woocommerce", generalStatus: "pendiente", financialStatus: "pending", shipments: [], payments: [], companion: { travelsIn: null, carries: [] } },
  guides: [], gfDeliveries: [], filledOutputIds: [], canEdit: true, canCancelGfGuide: true, canCreateShalomGuide: false,
  refresh: async () => {}, ...over,
});
const guide = { id: "g1", courier: "gf_courier", guide_code: "GF-PRUEBA", delivery_status: "pendiente", custody_state: "empresa", reported_status: "PENDING", created_via: "gf_courier_api", returned_at: null };
async function render(ctx: ReproSaleCancelContext | null, reason = "La clienta pidió cancelar su compra") {
  await act(async () => root.render(createElement(ReproLimaSaleCancel, { orderId: "pedido-prueba", orderName: "#KP-PRUEBA", context: ctx, reason, pending: false, onConfirm: confirm, onRefresh: refreshed })));
}
function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  expect(found, text).toBeTruthy();
  return found!;
}
async function click(text: string) { await act(async () => button(text).click()); }
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); vi.clearAllMocks(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("anulación en la misma pestaña de Atender", () => {
  it("exige motivo, revisión y segundo clic, sin anular al elegir el resultado", async () => {
    await render(context(), "");
    expect(button("Revisar anulación").disabled).toBe(true);
    await render(context());
    expect(confirm).not.toHaveBeenCalled();
    await click("Revisar anulación");
    expect(confirm).not.toHaveBeenCalled();
    await click("Sí, anular #KP-PRUEBA en WooCommerce");
    expect(confirm).toHaveBeenCalledOnce();
  });
  it("una guía GF activa impide la venta; pedir anulación no equivale a confirmación", async () => {
    const ctx = context({ guides: [guide] as ReproSaleCancelContext["guides"], facts: { ...context().facts, shipments: [guide] } });
    await render(ctx);
    expect(button("Revisar anulación").disabled).toBe(true);
    await click("Anular guía GF");
    const field = host.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { setter.call(field, "La clienta canceló su pedido"); field.dispatchEvent(new Event("input", { bubbles: true })); field.dispatchEvent(new Event("change", { bubbles: true })); });
    // React/Happydom maneja onChange mediante eventos de formulario en tests.
    expect(host.textContent).toContain("Anula GF-PRUEBA en GF Courier");
    api.cancelGf.mockResolvedValue({ notice: "Anulación pedida a GF: falta su confirmación.", pending: true });
    expect(button("Anular en GF Courier").disabled).toBe(false);
    await click("Anular en GF Courier");
    expect(api.cancelGf).toHaveBeenCalledExactlyOnceWith("pedido-prueba", "La clienta canceló su pedido", "g1");
    const requested = { ...guide, reported_status: "CANCEL_REQUESTED" };
    await render({ ...ctx, guides: [requested] as ReproSaleCancelContext["guides"], facts: { ...ctx.facts, shipments: [requested] } });
    expect(button("Revisar anulación").disabled).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Anulación pedida a GF");
    // Tras confirmar GF y releer: la venta requiere todavía su propio clic.
    await render(context());
    expect(button("Revisar anulación").disabled).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
  it("muestra la espera real de GF y no vuelve a ofrecer anular esa guía", async () => {
    // El protocolo de GF usa CANCEL_REQUESTED, no un estado local inventado.
    const requested = { ...guide, reported_status: "CANCEL_REQUESTED" };
    await render(context({ guides: [requested] as ReproSaleCancelContext["guides"], facts: { ...context().facts, shipments: [requested] } }));
    expect(host.textContent).toContain("La guía sigue activa hasta que GF la confirme");
    expect(host.textContent).not.toContain("Anular guía GF");
  });
  it("un cambio de motivo o de hechos exige revisar otra vez", async () => {
    await render(context()); await click("Revisar anulación");
    await render(context(), "Otro motivo de la clienta");
    expect(host.textContent).not.toContain("Sí, anular #KP-PRUEBA");
    await click("Revisar anulación");
    await render(context({ facts: { ...context().facts, financialStatus: "paid" } }), "Otro motivo de la clienta");
    expect(button("Revisar anulación").disabled).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
  it("sin permiso no ofrece la confirmación comercial", async () => {
    await render(null);
    expect(host.textContent).toContain("Necesitas el permiso");
    expect(host.querySelector("button")).toBeNull();
  });
  it("distingue terminar en Kapta con retorno pendiente de cancelar ya en WooCommerce", async () => {
    const out = { ...guide, custody_state: "retorno", dispatched_at: "2026-11-18T14:00:00Z" };
    const ctx = context({ mode: "woocommerce_return", facts: { ...context().facts, shipments: [out] } });
    expect(reproSaleCancelBlocks(ctx)).toEqual([]);
    await render(ctx); await click("Revisar anulación");
    expect(host.textContent).toContain("WooCommerce y su stock esperan");
    expect(host.textContent).toContain("Sí, anular #KP-PRUEBA en Kapta, con retorno pendiente");
  });
  it("un histórico Shopify conserva su alcance local", async () => {
    await render(context({ mode: "shopify_history", facts: { ...context().facts, platform: "shopify" } }));
    await click("Revisar anulación");
    expect(host.textContent).toContain("El original de Shopify se conserva");
    expect(host.textContent).toContain("Sí, anular #KP-PRUEBA en Kapta");
  });
});
