// «Salida activa», una sola definición para todos los couriers (owner, 23-11-2026, #KP207468). Datos FICTICIOS.
import { describe, expect, it } from "vitest";
import { salidaActiva, salidasQueEstorban } from "@/lib/shipment-output";

const today = "2026-11-23";
const at = (day: string, hour = "15:00:00") => `${day}T${hour}Z`; // 10:00 en Lima
const aliclik = (reported: string, extra: Record<string, unknown> = {}) =>
  ({ courier: "aliclik", guide_code: "AUR5XFICTICIO", delivery_status: "en_ruta", reported_status: reported, ...extra });

describe("salida activa", () => {
  it("en preparación, pendiente o en ruta hoy: activa", () => {
    expect(salidaActiva({ courier: "aliclik", delivery_status: "pendiente" }, today)).toBe(true);
    expect(salidaActiva({ courier: "aliclik", delivery_status: "por_preparar" }, today)).toBe(true);
    expect(salidaActiva(aliclik("PENDING_DELIVERY · PICKED · CONFIRMED", { last_courier_change_at: at(today) }), today)).toBe(true);
  });

  it("anulada, entregada o devuelta: no activa", () => {
    expect(salidaActiva({ courier: "aliclik", delivery_status: "anulado" }, today)).toBe(false);
    expect(salidaActiva({ courier: "aliclik", delivery_status: "entregado" }, today)).toBe(false);
    expect(salidaActiva({ courier: "swayp", delivery_status: "en_ruta", custody_state: "devuelto" }, today)).toBe(false);
    expect(salidaActiva({ courier: "tanders", delivery_status: "en_ruta", returned_at: at("2026-11-21") }, today)).toBe(false);
  });

  it("el courier reportó que no la entregó (no contesta, rechazo, cancelado): no activa, salvo reprogramada", () => {
    expect(salidaActiva(aliclik("NOT_RESPOND · PICKED · CONFIRMED", { last_courier_change_at: at(today) }), today)).toBe(false);
    expect(salidaActiva(aliclik("REFUSED · PICKED"), today)).toBe(false);
    expect(salidaActiva({ courier: "aliclik", delivery_status: "pendiente", reported_status: "NOT_RESPOND · IN_AGENCY" }, today)).toBe(false);
    // Envíos la reprogramó para mañana: sigue activa.
    expect(salidaActiva(aliclik("NOT_RESPOND · PICKED", { next_followup_at: "2026-11-24" }), today)).toBe(true);
    // Aliclik la reprogramó: sigue activa aunque su último reporte sea de ayer.
    expect(salidaActiva(aliclik("RESCHEDULED · PICKED · CONFIRMED", { last_courier_change_at: at("2026-11-22") }), today)).toBe(true);
    expect(salidaActiva({ courier: "swayp", delivery_status: "en_ruta", swayp_state: 8 }, today)).toBe(false);
    expect(salidaActiva({ courier: "tanders", delivery_status: "en_ruta", reported_status: "RETURNING" }, today)).toBe(false);
  });

  it("GF Courier: visita fallida no activa; reprogramada sí", () => {
    expect(salidaActiva({ courier: "gf_courier", delivery_status: "en_ruta", reported_status: "INCIDENT" }, today)).toBe(false);
    expect(salidaActiva({ courier: "gf_courier", delivery_status: "en_ruta", reported_status: "REFUSED" }, today)).toBe(false);
    expect(salidaActiva({ courier: "gf_courier", delivery_status: "en_ruta", reported_status: "INCIDENT:RESCHEDULE_REQUESTED" }, today)).toBe(true);
    expect(salidaActiva({ courier: "gf_courier", delivery_status: "en_ruta", reported_status: "OUT_FOR_DELIVERY", last_courier_change_at: at(today) }, today)).toBe(true);
  });

  it("en ruta sin reporte: deja de ser activa al día siguiente de su ruta", () => {
    // Salió ayer y nadie reportó nada: hoy ya no es activa.
    expect(salidaActiva(aliclik("PENDING_DELIVERY · PICKED", { last_courier_change_at: at("2026-11-22") }), today)).toBe(false);
    expect(salidaActiva({ courier: "axel", delivery_status: "en_ruta", custody_transferred_at: at("2026-11-22") }, today)).toBe(false);
    // Volvió a salir hoy (#KP207468: Aliclik la recogió de nuevo el 23-11): activa.
    expect(salidaActiva(aliclik("PENDING_DELIVERY · PICKED", { dispatched_at: at("2026-11-19"), last_courier_change_at: at(today) }), today)).toBe(true);
    // Sin fechas leídas: cuenta como activa (lado seguro).
    expect(salidaActiva(aliclik("PENDING_DELIVERY · PICKED"), today)).toBe(true);
    // Courier con API y sin leer su último reporte: la fecha de salida sola no la vence (pudo recogerla otra vez hoy).
    expect(salidaActiva(aliclik("PENDING_DELIVERY · PICKED", { dispatched_at: at("2026-11-19") }), today)).toBe(true);
    // Leído y sin ningún reporte suyo (null): vale la fecha de salida.
    expect(salidaActiva(aliclik("PENDING_DELIVERY · PICKED", { dispatched_at: at("2026-11-22"), last_courier_change_at: null }), today)).toBe(false);
    // Agencia (Shalom, Olva) viaja varios días: no aplica.
    expect(salidaActiva({ courier: "shalom", delivery_status: "en_ruta", dispatched_at: at("2026-11-18") }, today)).toBe(true);
  });

  it("salidasQueEstorban usa la misma definición", () => {
    const outputs = [aliclik("NOT_RESPOND · PICKED"), { courier: "axel", delivery_status: "en_ruta", custody_transferred_at: at(today) }];
    expect(salidasQueEstorban(outputs, today).map((o) => o.courier)).toEqual(["axel"]);
  });
});
