import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { timelineFact, type TimelineFactInput } from "@/lib/order-timeline-fact";

const e = (kind: string, extra: Partial<TimelineFactInput> = {}): TimelineFactInput => ({
  kind,
  newStatus: null,
  origin: "master",
  ...extra,
});

describe("timelineFact: los hitos de la Actividad (13-10-2026)", () => {
  it("la Actividad de #KP140633 se lee por sus hechos", () => {
    // Automático (Leads) → Pedido generado: el nacimiento del pedido.
    expect(timelineFact(e("lead_system", { origin: "leads", leadStatus: "pedido_generado" }))).toEqual({
      icon: "pedido",
      stage: "por_confirmar",
    });
    // Intento de confirmación · No contestó: consulta, con su teléfono.
    expect(timelineFact(e("confirmation_contact"))).toEqual({ icon: "llamada", stage: null });
    // Reprogramación de Repro Provincia (Guía Swayp directa creada).
    expect(timelineFact(e("reroute", { origin: "gestion", newStatus: "en_ruta" }))).toEqual({
      icon: "reprogramado",
      stage: "en_curso",
    });
    // Salió por Swayp desde Por confirmar: despacho.
    expect(timelineFact(e("swayp_desde_por_confirmar"))).toEqual({ icon: "despacho", stage: "por_despachar" });
    // El barrido de Swayp informa Entregado: es LA entrega, aunque el tipo sea courier_status.
    expect(timelineFact(e("courier_status", { newStatus: "entregado" }))).toEqual({
      icon: "entregado",
      stage: "finalizado",
    });
  });

  it("el estado nuevo manda sobre el tipo", () => {
    expect(timelineFact(e("status_override", { newStatus: "entregado" })).icon).toBe("entregado");
    expect(timelineFact(e("call", { origin: "gestion", newStatus: "entregado" })).stage).toBe("finalizado");
    expect(timelineFact(e("status_override", { newStatus: "devuelto" }))).toEqual({ icon: "devuelto", stage: "por_cerrar" });
    // El pedido anulado a mano es hito; la guía que el courier anula es corrección.
    expect(timelineFact(e("status_override", { newStatus: "anulado" }))).toEqual({ icon: "anulado", stage: "por_cerrar" });
    expect(timelineFact(e("courier_status", { newStatus: "anulado" }))).toEqual({ icon: "anulado", stage: null });
    // Un barrido que dice «en ruta» es seguimiento de rutina, no un hito.
    expect(timelineFact(e("courier_status", { newStatus: "en_ruta" }))).toEqual({ icon: "despacho", stage: null });
    expect(timelineFact(e("status_override", { newStatus: "pendiente" }))).toEqual({ icon: "estado", stage: null });
  });

  it("un pago lleva su propio estado, no el del pedido", () => {
    expect(timelineFact(e("payment", { newStatus: "validado" }))).toEqual({ icon: "pago", stage: "por_confirmar" });
    expect(timelineFact(e("payment", { newStatus: "rechazado" })).stage).toBe("por_confirmar");
    expect(timelineFact(e("payment", { newStatus: "pendiente_revision" }))).toEqual({ icon: "pago", stage: null });
    expect(timelineFact(e("payment"))).toEqual({ icon: "pago", stage: null });
  });

  it("cada parte del recorrido toma el matiz de su macroetapa (MOM §25)", () => {
    expect(timelineFact(e("confirmed")).stage).toBe("por_confirmar");
    expect(timelineFact(e("lead_sale", { origin: "leads" })).icon).toBe("pedido");
    expect(timelineFact(e("guide_created")).stage).toBe("preparacion");
    expect(timelineFact(e("route_output_created")).stage).toBe("preparacion");
    expect(timelineFact(e("custody_transferred")).stage).toBe("por_despachar");
    expect(timelineFact(e("attempt_failed"))).toEqual({ icon: "fallo", stage: "en_curso" });
    expect(timelineFact(e("delivered")).stage).toBe("finalizado");
    expect(timelineFact(e("liquidation_closed"))).toEqual({ icon: "pago", stage: "finalizado" });
    expect(timelineFact(e("return_received"))).toEqual({ icon: "devuelto", stage: "por_cerrar" });
    expect(timelineFact(e("cancelled_shopify"))).toEqual({ icon: "anulado", stage: "por_cerrar" });
  });

  it("lo de rutina lleva icono pero va en gris", () => {
    for (const kind of ["comment", "key_view", "key_shared", "whatsapp_template", "package_ready", "stop_reported", "coverage_changed"]) {
      const f = timelineFact(e(kind));
      expect(f.icon, kind).not.toBeNull();
      expect(f.stage, kind).toBeNull();
    }
    const lead = timelineFact(e("lead_call", { origin: "leads", leadStatus: "no_responde" }));
    expect(lead).toEqual({ icon: "llamada", stage: null });
    expect(timelineFact(e("lead_system", { origin: "leads", leadStatus: "no_responde" }))).toEqual({
      icon: "automatico",
      stage: null,
    });
  });

  it("un tipo desconocido no revienta: punto gris", () => {
    expect(timelineFact(e("algo_nuevo"))).toEqual({ icon: null, stage: null });
  });
});

describe("la ficha pinta el marcador y las etiquetas", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

  it("la Actividad usa el marcador en lugar del punto por expresión regular", () => {
    const drawer = read("components/order-drawer.tsx");
    expect(drawer).toContain("<TimelineMarker entry={t} />");
    expect(drawer).not.toContain("/payment|liquidation|entregado/");
  });

  it("los hitos usan los pares de macroetapa y Leads pasa el estado crudo", () => {
    const shared = read("components/order-master-shared.tsx");
    expect(shared).toMatch(/fact\.stage \? MACRO_STAGE_TONE\[fact\.stage\] : "bg-wash text-ink-500"/);
    const access = read("lib/orders-master-access.ts");
    expect(access).toContain("leadStatus: c.new_status,");
  });

  it("los tipos que salían con el código crudo tienen etiqueta", () => {
    const shared = read("components/order-master-shared.tsx");
    for (const kind of [
      "whatsapp_template",
      "key_view",
      "key_shared",
      "payment",
      "payment_recipient_exception",
      "aliclik_risk_exception",
      "additional_output_reason",
      "recovery_discarded",
      "confirmation_cancellation_task_created",
      "courier_report",
      "lead_message",
    ]) {
      expect(shared, kind).toMatch(new RegExp(`\\n  ${kind}: "`));
    }
  });
});
