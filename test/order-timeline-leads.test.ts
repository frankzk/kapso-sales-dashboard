import { describe, it, expect } from "vitest";
import { leadCallsToTimeline, type LeadCallTimelineRow } from "@/lib/orders-master-access";

/**
 * La cronología de Leads dentro del drawer del Master.
 *
 * El pedido nace en Leads —una asesora llama, convence y pulsa «Generar
 * pedido»— y el Master lo recogía sin nada de eso: para saber quién lo cerró y
 * qué había prometido, había que ir a Leads y buscar al cliente a mano.
 *
 * Lo que se prueba es lo que falla EN SILENCIO: acá nada lanza, se ETIQUETA
 * mal, y una etiqueta equivocada se lee como si fuera cierta.
 */

const call = (over: Partial<LeadCallTimelineRow> = {}): LeadCallTimelineRow => ({
  id: "c1",
  lead_id: "l1",
  vendedora: "u1",
  kind: "sale",
  new_status: "pedido_generado",
  note: "Venta nueva · pedido generado en Shopify · PEN 149.00 · contraentrega",
  occurred_at: "2026-08-12T17:12:00.000Z",
  ...over,
});

const names = new Map([["u1", "mildretvalecillos1407@gmail.com"]]);

describe("leadCallsToTimeline", () => {
  it("responde las dos preguntas: quién lo generó y qué nota dejó", () => {
    // Es literalmente el pedido de la captura que motivó esto.
    const [t] = leadCallsToTimeline([call()], names);
    expect(t!.actorName).toBe("mildretvalecillos1407@gmail.com");
    expect(t!.note).toContain("PEN 149.00");
    expect(t!.kind).toBe("lead_sale");
  });

  it("NO deja el estado del lead en `newStatus`", () => {
    // Es la trampa. El drawer pinta `newStatus` con `generalLabel`, que solo
    // conoce los estados del MASTER (pendiente, entregado, anulado…). Un
    // `pedido_generado` por ahí saldría como código crudo o, peor, con la
    // etiqueta de otro estado que se llame parecido — y se leería como cierto.
    const [t] = leadCallsToTimeline([call()], names);
    expect(t!.newStatus).toBeNull();
    expect(t!.statusLabel).toBe("Pedido generado");
  });

  it("traduce el estado con la tabla de LEADS", () => {
    const [t] = leadCallsToTimeline([call({ new_status: "no_responde" })], names);
    expect(t!.statusLabel).toBe("No responde (NR)");
  });

  it("prefija el tipo para no chocar con los del Master", () => {
    // `note`, `call` y `system` existen en las dos tablas con otro significado.
    // Sin prefijo, una nota de la asesora se leería como un comentario del
    // Master y una gestión de Repro Provincia como una llamada de Leads.
    const kinds = leadCallsToTimeline(
      [call({ id: "a", kind: "note" }), call({ id: "b", kind: "call" }), call({ id: "c", kind: "system" })],
      names,
    ).map((t) => t.kind);
    expect(kinds).toEqual(["lead_note", "lead_call", "lead_system"]);
  });

  it("prefija el id para que React no colapse dos entradas", () => {
    // Un id de `lead_calls` puede coincidir con uno de `order_events`: son dos
    // tablas con uuid propio. Con la misma clave, una de las dos desaparece.
    expect(leadCallsToTimeline([call({ id: "mismo-uuid" })], names)[0]!.id).toBe("lead:mismo-uuid");
  });

  it("marca el origen como Leads, para que se distinga de las otras dos fuentes", () => {
    const [t] = leadCallsToTimeline([call()], names);
    expect(t!.origin).toBe("leads");
    expect(t!.source).toBe("leads");
  });

  it("una gestión automática, sin asesora, no inventa un autor", () => {
    // El drip y los cambios del cron escriben con `vendedora` nula. Poner ahí
    // cualquier nombre atribuiría a una persona un trabajo que hizo el sistema.
    const [t] = leadCallsToTimeline([call({ vendedora: null })], names);
    expect(t!.actorName).toBeNull();
  });

  it("una asesora que ya no está en el mapa de nombres no rompe la fila", () => {
    const [t] = leadCallsToTimeline([call({ vendedora: "borrada" })], names);
    expect(t!.actorName).toBeNull();
    expect(t!.note).toBeTruthy();
  });

  it("sin gestiones devuelve la lista vacía", () => {
    expect(leadCallsToTimeline([], names)).toEqual([]);
  });

  it("no arrastra courier ni guía: eso es del Master, no de Leads", () => {
    // Heredar el courier del pedido haría creer que la asesora lo asignó.
    const [t] = leadCallsToTimeline([call()], names);
    expect(t!.courier).toBeNull();
    expect(t!.guideCode).toBeNull();
    expect(t!.confirmation).toBeNull();
  });
});
