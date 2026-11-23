// Con una salida activa de otro courier no se crea la guía de GF (owner, 23-11-2026, #KP207468). Datos FICTICIOS.
import { describe, expect, it } from "vitest";
import { liveOtherCourierOutputs, otherCourierBlocksGf, otherCourierLabel } from "@/lib/gf-other-courier";

describe("guía GF con otro courier en curso", () => {
  it("una guía de Aliclik en ruta impide crear la de GF y la nombra", () => {
    const why = otherCourierBlocksGf([
      { courier: "gf_courier", guide_code: "KENKU-KP000001", delivery_status: "anulado" },
      { courier: "aliclik", guide_code: "AUR5XFICTICIO", delivery_status: "en_ruta" },
    ]);
    expect(why).toBe("Aliclik ya tiene una salida activa en este pedido (guía AUR5XFICTICIO): no se crea la guía de GF Courier. Anúlala o ciérrala primero.");
  });

  it("Swayp (Fénix), Tanders y los manuales también cuentan; pendiente y por preparar también", () => {
    expect(otherCourierLabel("Fénix")).toBe("Swayp (antes Fénix)");
    expect(otherCourierLabel("tanders")).toBe("Tanders");
    expect(otherCourierLabel("Axel")).toBe("Axel Courier");
    expect(otherCourierBlocksGf([{ courier: "swayp", delivery_status: "pendiente" }])).toContain("Swayp (antes Fénix) ya tiene");
    expect(otherCourierBlocksGf([{ courier: "urpi", delivery_status: "por_preparar" }])).toContain("Urpi ya tiene");
  });

  it("no cuenta la que su courier ya reportó como no entregada ni la que sigue en ruta sin reporte desde ayer", () => {
    expect(otherCourierBlocksGf([{ courier: "aliclik", delivery_status: "en_ruta", reported_status: "NOT_RESPOND · PICKED" }], "2026-11-23")).toBeNull();
    expect(otherCourierBlocksGf([{ courier: "aliclik", delivery_status: "en_ruta", reported_status: "PENDING_DELIVERY · PICKED", last_courier_change_at: "2026-11-22T15:00:00Z" }], "2026-11-23")).toBeNull();
    expect(otherCourierBlocksGf([{ courier: "aliclik", delivery_status: "en_ruta", reported_status: "RESCHEDULED · PICKED", last_courier_change_at: "2026-11-22T15:00:00Z" }], "2026-11-23")).toContain("Aliclik ya tiene");
  });

  it("no cuentan: entregada, anulada, devuelta, Grupo GF (propio), por definir ni otra de GF", () => {
    expect(otherCourierBlocksGf([
      { courier: "aliclik", delivery_status: "entregado" },
      { courier: "aliclik", delivery_status: "anulado" },
      { courier: "aliclik", delivery_status: "en_ruta", returned_at: "2026-11-21T10:00:00Z" },
      { courier: "swayp", delivery_status: "en_ruta", custody_state: "devuelto" },
      { courier: "propio", delivery_status: "pendiente" },
      { courier: "por_definir", delivery_status: "pendiente" },
      { courier: "gf_courier", delivery_status: "pendiente" },
    ])).toBeNull();
    expect(liveOtherCourierOutputs([{ courier: null, delivery_status: "pendiente" }])).toEqual([]);
  });
});
