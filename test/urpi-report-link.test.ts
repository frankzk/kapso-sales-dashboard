import { describe, expect, it } from "vitest";
import { resolveUrpiLinks, urpiStoreFromHint, type UrpiCandidateOrder, type UrpiLink } from "@/lib/urpi-report-link";
import { buildUrpiShipments, type UrpiOrderFacts, type UrpiStoredRow } from "@/lib/urpi-report-view";
import type { UrpiReportRow } from "@/lib/urpi-report";

const stores = [{ id: "kenku", name: "Kenku Peru" }, { id: "aurela", name: "Aurela" }];
const row = (urpiRow: number, over: Partial<UrpiReportRow> = {}): UrpiReportRow => ({
  urpiRow, previousRow: null, reportDate: "2026-10-03", resultWritten: "Reprogramado", resultCode: "reprogramado", reason: "No contesta",
  detail: null, evidence: [], paymentMethod: null, amountCollected: null, serviceFee: null, posFee: null, finalDelivered: false,
  finalCancelled: false, recipient: "Cliente", phone: "900000001", address: null, product: null, storeHint: null, seller: null,
  whatsappStatus: null, closingLocation: null, ...over,
});
const order = (orderId: string, createdAt: string, over: Partial<UrpiCandidateOrder> = {}): UrpiCandidateOrder => ({ orderId, storeId: "kenku", phone: "900000001", createdAt, ...over });

describe("vínculo por teléfono de un reporte de Urpi", () => {
  it("un solo pedido del teléfono en los 45 días previos → vinculado", () => {
    const links = resolveUrpiLinks([row(1)], [order("o1", "2026-09-20T15:00:00Z"), order("old", "2026-07-01T15:00:00Z"), order("later", "2026-10-04T15:00:00Z")], new Map(), stores);
    expect(links.get(1)).toEqual({ orderId: "o1", storeId: "kenku", linkStatus: "vinculado", linkMethod: "telefono", candidates: [] });
  });
  it("el día del envío cuenta hasta la medianoche de Lima", () => {
    const links = resolveUrpiLinks([row(1)], [order("o1", "2026-10-04T04:59:00Z")], new Map(), stores);
    expect(links.get(1)!.orderId).toBe("o1");
    expect(resolveUrpiLinks([row(1)], [order("o1", "2026-10-04T05:00:00Z")], new Map(), stores).get(1)!.linkStatus).toBe("sin_pedido");
  });
  it("varios pedidos → a revisión con los candidatos; nunca elige uno", () => {
    const link = resolveUrpiLinks([row(1)], [order("o1", "2026-09-20T15:00:00Z"), order("o2", "2026-09-28T15:00:00Z", { storeId: "aurela" })], new Map(), stores).get(1)!;
    expect(link).toEqual({ orderId: null, storeId: null, linkStatus: "varios", linkMethod: "telefono", candidates: ["o1", "o2"] });
  });
  it("la tienda escrita por Urpi desempata solo si deja algún pedido", () => {
    const orders = [order("o1", "2026-09-20T15:00:00Z"), order("o2", "2026-09-28T15:00:00Z", { storeId: "aurela" })];
    expect(resolveUrpiLinks([row(1, { storeHint: "AURELA" })], orders, new Map(), stores).get(1)!.orderId).toBe("o2");
    expect(resolveUrpiLinks([row(1, { storeHint: "OTRA" })], orders, new Map(), stores).get(1)!.linkStatus).toBe("varios");
    expect(urpiStoreFromHint("KENKU", stores)).toBe("kenku");
  });
  it("sin teléfono válido o sin pedido no inventa vínculo", () => {
    expect(resolveUrpiLinks([row(1, { phone: null })], [], new Map(), stores).get(1)!.linkStatus).toBe("sin_telefono");
    expect(resolveUrpiLinks([row(1)], [], new Map(), stores).get(1)!.linkStatus).toBe("sin_pedido");
  });
  it("los reintentos siguen a su cadena, aunque la ventana del reintento vea otro pedido", () => {
    const rows = [row(1, { reportDate: "2026-09-01" }), row(2, { previousRow: 1, reportDate: "2026-10-20" })];
    const links = resolveUrpiLinks(rows, [order("o1", "2026-08-25T15:00:00Z"), order("o2", "2026-10-10T15:00:00Z")], new Map(), stores);
    expect(links.get(1)).toMatchObject({ orderId: "o1", linkMethod: "telefono" });
    expect(links.get(2)).toMatchObject({ orderId: "o1", linkMethod: "cadena" });
  });
  it("un vínculo manual manda sobre el teléfono y lo heredan los reintentos nuevos", () => {
    const manual: UrpiLink = { orderId: "o9", storeId: "aurela", linkStatus: "vinculado", linkMethod: "manual", candidates: [] };
    const links = resolveUrpiLinks([row(1), row(2, { previousRow: 1 })], [order("o1", "2026-09-20T15:00:00Z")], new Map([[1, manual]]), stores);
    expect(links.get(1)).toEqual(manual);
    expect(links.get(2)).toMatchObject({ orderId: "o9", storeId: "aurela", linkMethod: "cadena" });
  });
  it("la cadena puede apuntar a una fila de una carga anterior", () => {
    const before: UrpiLink = { orderId: "o1", storeId: "kenku", linkStatus: "vinculado", linkMethod: "telefono", candidates: [] };
    expect(resolveUrpiLinks([row(5, { previousRow: 4 })], [], new Map([[4, before]]), stores).get(5)).toMatchObject({ orderId: "o1", linkMethod: "cadena" });
  });
  it("una cadena circular no se cuelga", () => {
    const links = resolveUrpiLinks([row(1, { previousRow: 2 }), row(2, { previousRow: 1 })], [order("o1", "2026-09-20T15:00:00Z")], new Map(), stores);
    expect(links.get(1)!.orderId).toBe("o1");
    expect(links.get(2)!.orderId).toBe("o1");
  });
});

const stored = (urpi_row: number, over: Partial<UrpiStoredRow> = {}): UrpiStoredRow => ({
  urpi_row, previous_row: null, report_date: "2026-10-03", result_code: "reprogramado", data: row(urpi_row),
  order_id: "o1", store_id: "kenku", link_status: "vinculado", link_method: "telefono", candidate_order_ids: [], ...over,
});
const fact = (order_id: string, over: Partial<UrpiOrderFacts> = {}): UrpiOrderFacts => ({
  order_id, store_id: "kenku", order_name: `#KP${order_id}`, customer_name: "Cliente", general_status: "en_proceso", macro_stage: "en_curso", order_total: 89, cancelled_at: null, ...over,
});

describe("envíos de Urpi y lo que Kapta ya sabe", () => {
  it("el último intento decide: entregado que Kapta no sabe → por aplicar, con la diferencia de cobro", () => {
    const rows = [stored(1, { report_date: "2026-10-01" }), stored(2, { previous_row: 1, result_code: "entregado", data: row(2, { amountCollected: 99, resultCode: "entregado" }) })];
    const [shipment] = buildUrpiShipments(rows, new Map([["o1", fact("o1")]]));
    expect(shipment).toMatchObject({ bucket: "por_aplicar", amountGap: 10 });
    expect(shipment!.attempts.map((a) => a.urpi_row)).toEqual([1, 2]);
  });
  it("entregado por Urpi pero anulado en Shopify o devuelto → observación; ya entregado → al día", () => {
    const delivered = [stored(1, { result_code: "entregado" })];
    expect(buildUrpiShipments(delivered, new Map([["o1", fact("o1", { general_status: "anulado", cancelled_at: "2026-10-02T00:00:00Z" })]]))[0]!.bucket).toBe("observacion");
    expect(buildUrpiShipments(delivered, new Map([["o1", fact("o1", { cancelled_at: "2026-10-02T00:00:00Z" })]]))[0]!.bucket).toBe("observacion");
    expect(buildUrpiShipments(delivered, new Map([["o1", fact("o1", { general_status: "devuelto" })]]))[0]!.bucket).toBe("observacion");
    expect(buildUrpiShipments(delivered, new Map([["o1", fact("o1", { general_status: "entregado" })]]))[0]!.bucket).toBe("al_dia");
  });
  it("cancelado o reprogramado con el pedido abierto van a sus listas; reprogramado trae la nueva fecha", () => {
    expect(buildUrpiShipments([stored(1, { result_code: "cancelado" })], new Map([["o1", fact("o1")]]))[0]!.bucket).toBe("cancelado");
    const [repro] = buildUrpiShipments([stored(1)], new Map([["o1", fact("o1")]]));
    expect(repro).toMatchObject({ bucket: "reprogramado", nextDate: "2026-10-05" });
    expect(buildUrpiShipments([stored(1, { result_code: "cancelado" })], new Map([["o1", fact("o1", { general_status: "anulado" })]]))[0]!.bucket).toBe("al_dia");
  });
  it("sin pedido único → por vincular, agrupado por cadena y con los candidatos", () => {
    const rows = [
      stored(1, { order_id: null, store_id: null, link_status: "varios", candidate_order_ids: ["o1", "o2"] }),
      stored(2, { previous_row: 1, order_id: null, store_id: null, link_status: "varios", candidate_order_ids: ["o1", "o2"], result_code: "cancelado" }),
    ];
    const shipments = buildUrpiShipments(rows, new Map([["o1", fact("o1")], ["o2", fact("o2")]]));
    expect(shipments).toHaveLength(1);
    expect(shipments[0]).toMatchObject({ key: "cadena:1", bucket: "por_vincular_otro" });
    expect(shipments[0]!.candidates.map((c) => c.order_id)).toEqual(["o1", "o2"]);
  });
  it("por vincular se parte: lo que Urpi ya entregó va aparte", () => {
    const row = stored(1, { order_id: null, store_id: null, link_status: "sin_pedido", result_code: "entregado" });
    expect(buildUrpiShipments([row], new Map())[0]!.bucket).toBe("por_vincular_entregado");
  });
  it("anulado solo en Kapta (Shopify vivo) no es observación: se puede marcar", () => {
    const [shipment] = buildUrpiShipments([stored(1, { result_code: "entregado" })], new Map([["o1", fact("o1", { general_status: "anulado" })]]));
    expect(shipment).toMatchObject({ bucket: "por_aplicar", annulledOnlyInKapta: true });
  });
  it("una observación cerrada con motivo sale de la lista; un intento posterior la reabre", () => {
    const closed = fact("o1", { general_status: "anulado", cancelled_at: "2026-10-02T00:00:00Z", observation_resolved: { urpiRow: 1, note: "Anulado por error", at: "2026-10-05T00:00:00Z" } });
    expect(buildUrpiShipments([stored(1, { result_code: "entregado" })], new Map([["o1", closed]]))[0]!.bucket).toBe("al_dia");
    const later = [stored(1, { result_code: "reprogramado" }), stored(2, { result_code: "entregado" })];
    expect(buildUrpiShipments(later, new Map([["o1", closed]]))[0]!.bucket).toBe("observacion");
  });
  it("un estado que Kapta no reconoce queda aparte", () => {
    expect(buildUrpiShipments([stored(1, { result_code: "otro" })], new Map([["o1", fact("o1")]]))[0]!.bucket).toBe("no_reconocido");
  });
});
