import { describe, expect, it } from "vitest";
import { confirmedTandersReview, tandersReleaseCutoff, tandersReview, tandersReviewQueueFilter, tandersReviewReason } from "@/lib/gf-tanders-review";

const order = { coverage: "lima", current_courier: "tanders", macro_stage: "en_curso", macro_substage: "en_transito" };
const output = { id: "tanders-1", courier: "tanders", delivery_status: "en_ruta", dispatched_at: "2026-09-28T15:20:17.647Z", status_category: "in_route", reported_status: "PICKED" };
const today = "2026-10-01";

describe("Tanders de días anteriores en Desde la lista", () => {
  it.each(["2026-09-28T15:20:17.647Z", "2026-09-24T14:20:38.034Z"])("ofrece el caso real despachado %s", (dispatched_at) => {
    expect(tandersReview(order, [{ ...output, dispatched_at }], today)).toEqual({ shipmentIds: [output.id], dispatchedAt: dispatched_at });
  });
  it("usa medianoche de Lima: 04:59 UTC es ayer, 05:00 es hoy", () => {
    expect(tandersReview(order, [{ ...output, dispatched_at: "2026-10-01T04:59:59Z" }], today)).not.toBeNull();
    expect(tandersReview(order, [{ ...output, dispatched_at: "2026-10-01T05:00:00Z" }], today)).toBeNull();
  });
  it.each([null, "invalid", "2026-10-02T12:00:00Z"])("no ofrece despacho ausente, inválido o futuro: %s", (dispatched_at) => {
    expect(tandersReview(order, [{ ...output, dispatched_at }], today)).toBeNull();
  });
  it.each([
    { macro_stage: "finalizado", macro_substage: "entregado_cerrado" },
    { macro_stage: "por_cerrar", macro_substage: "anulado" },
    { coverage: "provincia" }, { current_courier: "fenix" },
  ])("respeta el estado del pedido: %j", (patch) => {
    expect(tandersReview({ ...order, ...patch }, [output], today)).toBeNull();
  });
  it.each([{ status_category: "delivered" }, { delivery_status: "entregado" }, { reported_status: "DELIVERED" }])("descarta una entrega incluso con el Master atrasado: %j", (patch) => {
    expect(tandersReview(order, [{ ...output, ...patch }], today)).toBeNull();
  });
  it.each(["propio", "fenix", "por_definir"])("otra salida activa de %s bloquea la revisión", (courier) => {
    expect(tandersReview(order, [output, { ...output, id: "new", courier, delivery_status: "pendiente" }], today)).toBeNull();
  });
  it("una segunda salida de Tanders del mismo día también bloquea", () => {
    expect(tandersReview(order, [output, { ...output, id: "new", dispatched_at: "2026-10-01T12:00:00Z" }], today)).toBeNull();
  });
  it("no bloquea una salida histórica anulada, pero sí otra entregada", () => {
    expect(tandersReview(order, [output, { ...output, id: "old", courier: "fenix", delivery_status: "anulado" }], today)).not.toBeNull();
    expect(tandersReview(order, [output, { ...output, id: "old", delivery_status: "entregado" }], today)).toBeNull();
  });
  it("requiere una opción válida y las mismas salidas que se revisaron", () => {
    const review = tandersReview(order, [output], today)!;
    expect(confirmedTandersReview(review, undefined)).toBe(false);
    expect(confirmedTandersReview(review, { shipmentIds: ["other"], packageLocation: "returned" })).toBe(false);
    expect(confirmedTandersReview(review, { shipmentIds: [output.id], packageLocation: "returned" })).toBe(true);
    expect(confirmedTandersReview(review, { shipmentIds: [output.id], packageLocation: "additional" })).toBe(true);
    expect(confirmedTandersReview(review, { shipmentIds: [], packageLocation: "additional" })).toBe(false);
  });
  it("el motivo distingue recepción declarada y paquete adicional", () => {
    expect(tandersReviewReason("returned")).toContain("confirma que el paquete volvió");
    expect(tandersReviewReason("additional")).toContain("mientras se recupera el anterior");
  });
});

describe("Tanders libera el paquete el siguiente día hábil (solo el domingo no lo es)", () => {
  // 02-10-2026 es viernes, 03 sábado, 04 domingo, 05 lunes.
  const at = (day: string) => `${day}T15:00:00Z`; // 10:00 de Lima
  it("recolectado el viernes: libre el sábado", () => {
    expect(tandersReview(order, [{ ...output, dispatched_at: at("2026-10-02") }], "2026-10-02")).toBeNull();
    expect(tandersReview(order, [{ ...output, dispatched_at: at("2026-10-02") }], "2026-10-03")).not.toBeNull();
  });
  it("recolectado el sábado: el domingo sigue siendo de Tanders, libre el lunes", () => {
    expect(tandersReview(order, [{ ...output, dispatched_at: at("2026-10-03") }], "2026-10-04")).toBeNull();
    expect(tandersReview(order, [{ ...output, dispatched_at: at("2026-10-03") }], "2026-10-05")).not.toBeNull();
  });
  it("el domingo sigue ofreciendo lo que ya estaba libre", () => {
    expect(tandersReview(order, [{ ...output, dispatched_at: at("2026-10-02") }], "2026-10-04")).not.toBeNull();
  });
  it("los feriados se trabajan: no corren el límite", () => {
    // 08-10-2026 (jueves, feriado en Perú) es un día cualquiera.
    expect(tandersReleaseCutoff("2026-10-08")).toBe("2026-10-08");
  });
  it("el límite es el mismo día salvo el domingo, que es el sábado", () => {
    expect(tandersReleaseCutoff("2026-10-05")).toBe("2026-10-05");
    expect(tandersReleaseCutoff("2026-10-04")).toBe("2026-10-03");
    expect(tandersReviewQueueFilter("2026-10-04")).toContain("dispatched_at.lt.2026-10-03T00:00:00-05:00");
    expect(tandersReviewQueueFilter("2026-10-05")).toContain("dispatched_at.lt.2026-10-05T00:00:00-05:00");
  });
});
