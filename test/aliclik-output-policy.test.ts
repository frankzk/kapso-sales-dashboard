import { describe, expect, it } from "vitest";
import { aliclikOutputPolicy, type AliclikExistingOutput } from "@/lib/aliclik-output-policy";

// KP200077: Alexis conserva la primera caja y todavía no reportó un resultado.
const alexis: AliclikExistingOutput = Object.freeze({
  id: "gf-output", courier: "propio",
  guide_code: "MOM-KP200077-PROPIO-EBFFA4E4", output_code: "KP200077-S01",
  delivery_status: "pendiente", created_via: "grupo_gf_courier",
  custody_state: "courier", custody_transferred_at: "2026-10-26T17:35:29.019Z",
});
const decide = (outputs: AliclikExistingOutput[], motivo: string | null = null,
  operation: "lima" | "provincia_cod" | "agencia" | "desconocida" = "lima", manual = true) =>
  aliclikOutputPolicy({ outputs, operation, motivo, manual });

describe("Aliclik proactivo en Lima", () => {
  it("con Alexis sin reporte pide motivo, y con motivo permite otra salida independiente", () => {
    const without = decide([alexis]);
    expect(without.ok).toBe(false);
    if (!without.ok) {
      expect(without.pideMotivo).toBe(true);
      expect(without.error).toContain("Grupo GF Courier");
      expect(without.error).toContain("KP200077-S01");
      expect(without.error).toContain("sin esperar su reporte");
    }
    const allowed = decide([alexis], " Preparar Aliclik mientras Alexis sigue sin reporte. ");
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.motivo).toBe("Preparar Aliclik mientras Alexis sigue sin reporte.");
      expect(allowed.estorban).toEqual([alexis]);
    }
    expect(alexis.custody_state).toBe("courier");
    expect(alexis.delivery_status).toBe("pendiente");
    expect(alexis.custody_transferred_at).toBe("2026-10-26T17:35:29.019Z");
  });

  it("un motivo vacío no permite emitir", () => {
    expect(decide([alexis], "   ").ok).toBe(false);
  });

  it("también permite preparar con otro courier en ruta, conservando todas las salidas en la evidencia", () => {
    const second = { ...alexis, id: "other", courier: "axel", delivery_status: "en_ruta" };
    const result = decide([alexis, second], "La clienta pidió otra fecha.");
    expect(result.ok).toBe(true);
    expect(result.estorban).toHaveLength(2);
  });

  it.each(["provincia_cod", "agencia", "desconocida"] as const)(
    "fuera de Lima conserva el bloqueo aunque se mande un motivo: %s", (operation) => {
      const result = decide([alexis], "Quiero otra", operation);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.pideMotivo).toBe(false);
    },
  );

  it("el automático no puede justificar otra salida en nombre de una persona", () => {
    expect(decide([alexis], "motivo enviado", "lima", false).ok).toBe(false);
    expect(decide([], null, "lima", false).ok).toBe(true);
  });

  it("una Aliclik que ya está activa no admite otra aunque haya motivo", () => {
    const result = decide([{ ...alexis, courier: "aliclik" }], "duplicar");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.pideMotivo).toBe(false);
  });

  it("si Alexis reporta entrega, el motivo no permite emitir la siguiente", () => {
    const result = decide([{ ...alexis, delivery_status: "entregado" }], "preparar");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("entregada");
  });

  it("cuenta las cinco salidas aunque ya estén cerradas", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ ...alexis, id: String(i), delivery_status: "anulado" }));
    const result = decide(five, "otra");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("máximo de 5");
  });

  it("una por definir se rellena y no consume una sexta salida", () => {
    const placeholder = { ...alexis, id: "placeholder", courier: "por_definir", created_via: "mom_manual_route",
      custody_state: "empresa", custody_transferred_at: null };
    const closed = Array.from({ length: 3 }, (_, i) => ({ ...alexis, id: `closed-${i}`, delivery_status: "anulado" }));
    expect(decide([alexis, ...closed, placeholder], "Preparar para mañana").ok).toBe(true);
    expect(decide([alexis, ...closed, { ...placeholder, custody_state: "courier" }], "otra").ok).toBe(false);
  });

  it("conserva la excepción de Swayp en devolución, también en provincia", () => {
    const swayp = { ...alexis, courier: "fenix", swayp_state: 8, delivery_status: "en_ruta" };
    expect(decide([swayp], null, "provincia_cod").ok).toBe(true);
    expect(decide([{ ...swayp, swayp_state: 6 }], null, "provincia_cod").ok).toBe(false);
  });
});
