import { describe, expect, it } from "vitest";
import { confirmedTandersReview, courierReview, nextBusinessDay, swaypUndispatchedQueueFilter, swaypUndispatchedReview, tandersExpectedDeliveryDay, tandersReleaseCutoff, tandersReview, tandersReviewQueueFilter, tandersReviewReason } from "@/lib/gf-tanders-review";

const order = { coverage: "lima", current_courier: "tanders", macro_stage: "en_curso", macro_substage: "en_transito" };
const output = { id: "tanders-1", courier: "tanders", delivery_status: "en_ruta", dispatched_at: "2026-09-28T15:20:17.647Z", status_category: "in_route", reported_status: "PICKED" };
const today = "2026-10-01";

describe("Tanders de días anteriores en Desde la lista", () => {
  it.each(["2026-09-28T15:20:17.647Z", "2026-09-24T14:20:38.034Z"])("ofrece el caso real despachado %s", (dispatched_at) => {
    expect(tandersReview(order, [{ ...output, dispatched_at }], today)).toEqual({ courier: "tanders", shipmentIds: [output.id], dispatchedAt: dispatched_at });
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

describe("Tanders que nunca recolectó: libre al día hábil siguiente del que debía repartir (03-10-2026)", () => {
  // 01-10 jueves, 02 viernes, 03 sábado, 04 domingo, 05 lunes, 06 martes.
  const waiting = { coverage: "lima", current_courier: "tanders", macro_stage: "por_despachar", macro_substage: "listo_para_asignar" };
  const pending = (createdAt: string) => ({
    id: "tanders-p", courier: "tanders", delivery_status: "pendiente", dispatched_at: null,
    status_category: "pending", reported_status: "PENDING", tanders_created_at: createdAt,
  });
  // 16:36 de Lima del jueves 01-10, como #KP136944.
  const thursday = "2026-10-01T21:36:40.318Z";

  it("el día hábil siguiente salta el domingo", () => {
    expect(nextBusinessDay("2026-10-01")).toBe("2026-10-02");
    expect(nextBusinessDay("2026-10-03")).toBe("2026-10-05");
    expect(tandersExpectedDeliveryDay(thursday)).toBe("2026-10-02");
  });

  it("creada el jueves: Tanders debía repartirla el viernes; si sigue Pendiente, libre el sábado", () => {
    expect(tandersReview(waiting, [pending(thursday)], "2026-10-02")).toBeNull();
    const review = tandersReview(waiting, [pending(thursday)], "2026-10-03");
    expect(review).toEqual({ courier: "tanders", shipmentIds: ["tanders-p"], dispatchedAt: thursday, uncollected: true });
  });

  it("creada el viernes: debía repartirla el sábado; libre el lunes, no el domingo", () => {
    const friday = "2026-10-02T20:00:00Z";
    expect(tandersReview(waiting, [pending(friday)], "2026-10-04")).toBeNull();
    expect(tandersReview(waiting, [pending(friday)], "2026-10-05")).not.toBeNull();
  });

  it("creada el sábado: debía repartirla el lunes; libre el martes", () => {
    const saturday = "2026-10-03T15:00:00Z";
    expect(tandersReview(waiting, [pending(saturday)], "2026-10-05")).toBeNull();
    expect(tandersReview(waiting, [pending(saturday)], "2026-10-06")).not.toBeNull();
  });

  it("sin fecha de creación de la guía no se libera", () => {
    expect(tandersReview(waiting, [pending(null as unknown as string)], "2026-10-10")).toBeNull();
  });

  it("si Tanders ya la recolectó, manda la regla del despacho, no la de la creación", () => {
    const collected = { ...pending(thursday), delivery_status: "en_ruta", dispatched_at: "2026-10-05T15:00:00Z" };
    expect(tandersReview(waiting, [collected], "2026-10-05")).toBeNull();
  });

  it("otra salida viva de otro courier sigue bloqueando", () => {
    expect(tandersReview(waiting, [pending(thursday), { id: "gf", courier: "propio", delivery_status: "pendiente", dispatched_at: null }], "2026-10-03")).toBeNull();
  });

  it("el motivo dice que la guía nunca se recolectó", () => {
    expect(tandersReviewReason("returned", true)).toContain("nunca se recolectó");
    expect(tandersReviewReason("returned")).toContain("despacho anterior");
  });
});

describe("Swayp que su bodega no despachó: libre al día hábil siguiente de su reparto (03-10-2026)", () => {
  // #KP138099: Lurín, guía directa 50000142751, reparto del viernes 02-10 (00:36 de Lima).
  const order = { coverage: "lima", current_courier: "fenix", macro_stage: "en_curso", macro_substage: "en_reparto" };
  const guide = {
    id: "swayp-1", courier: "fenix", delivery_status: "en_ruta", dispatched_at: "2026-10-02T05:36:54Z",
    status_category: "in_route", reported_status: "Swayp · Bodega no despacho mercancía (20)", swayp_state: 6,
  };

  it("el caso real: el viernes es de Swayp, el sábado ya se ofrece", () => {
    expect(swaypUndispatchedReview(order, [guide], "2026-10-02")).toBeNull();
    expect(swaypUndispatchedReview(order, [guide], "2026-10-03")).toEqual({
      courier: "swayp", shipmentIds: ["swayp-1"], dispatchedAt: guide.dispatched_at, uncollected: true,
    });
  });

  it("reparto del sábado: el domingo sigue siendo de Swayp, libre el lunes", () => {
    const saturday = { ...guide, dispatched_at: "2026-10-03T15:00:00Z" };
    expect(swaypUndispatchedReview(order, [saturday], "2026-10-04")).toBeNull();
    expect(swaypUndispatchedReview(order, [saturday], "2026-10-05")).not.toBeNull();
  });

  it("también en tránsito, y el texto sin número de novedad", () => {
    expect(swaypUndispatchedReview({ ...order, macro_substage: "en_transito" }, [guide], "2026-10-03")).not.toBeNull();
    expect(swaypUndispatchedReview(order, [{ ...guide, reported_status: "Swayp · Bodega no despachó mercancía" }], "2026-10-03")).not.toBeNull();
  });

  it.each([
    ["otra novedad: el mensajero sí tiene el paquete", { reported_status: "Swayp · Destinatario no contesta (7)" }],
    ["Swayp lo reprogramó", { reported_status: "Swayp · Reprogramado (6)", swayp_state: 5 }],
    ["la novedad se resolvió y volvió a Reparto", { swayp_state: 5 }],
    ["Swayp marcó Devolución: eso ya es recuperación", { swayp_state: 8 }],
    ["sin fecha de reparto", { dispatched_at: null }],
    ["entregada", { delivery_status: "entregado", status_category: "delivered" }],
  ])("no se ofrece si %s", (_, patch) => {
    expect(swaypUndispatchedReview(order, [{ ...guide, ...patch }], "2026-10-03")).toBeNull();
  });

  it.each([
    { coverage: "provincia_cod" }, { current_courier: "tanders" },
    { macro_substage: "por_reprogramar_lima" }, { macro_stage: "por_cerrar", macro_substage: "devolucion_fisica_pendiente" },
  ])("respeta el estado del pedido: %j", (patch) => {
    expect(swaypUndispatchedReview({ ...order, ...patch }, [guide], "2026-10-03")).toBeNull();
  });

  it("otra salida viva de otro courier sigue bloqueando", () => {
    expect(swaypUndispatchedReview(order, [guide, { id: "gf", courier: "propio", delivery_status: "pendiente", dispatched_at: null }], "2026-10-03")).toBeNull();
  });

  it("courierReview elige la regla que aplica", () => {
    expect(courierReview(order, [guide], "2026-10-03")?.courier).toBe("swayp");
    const tanders = { coverage: "lima", current_courier: "tanders", macro_stage: "en_curso", macro_substage: "en_transito" };
    const picked = { id: "t", courier: "tanders", delivery_status: "en_ruta", dispatched_at: "2026-10-02T15:00:00Z", status_category: "in_route", reported_status: "PICKED" };
    expect(courierReview(tanders, [picked], "2026-10-03")?.courier).toBe("tanders");
  });

  it("la cola trae los candidatos con el mismo límite del domingo", () => {
    expect(swaypUndispatchedQueueFilter("2026-10-03")).toBe(
      "and(macro_stage.eq.en_curso,macro_substage.in.(en_transito,en_reparto),current_courier.eq.fenix,dispatched_at.lt.2026-10-03T00:00:00-05:00)",
    );
    expect(swaypUndispatchedQueueFilter("2026-10-04")).toContain("dispatched_at.lt.2026-10-03T00:00:00-05:00");
  });

  it("el motivo nombra la novedad de Swayp", () => {
    expect(tandersReviewReason("returned", true, "swayp")).toContain("bodega no despachó");
    expect(tandersReviewReason("returned", true, "swayp")).toContain("está en el almacén");
    expect(tandersReviewReason("additional", true, "swayp")).toContain("salida adicional");
  });
});
