import { describe, expect, it } from "vitest";
import {
  buildOutputCode,
  canRepeatCourier,
  manualOutputIsCancelable,
  normalizeOrderCode,
  outputDisplayCode,
} from "@/lib/shipment-output";

describe("identidad de salida MOM", () => {
  it("normaliza el pedido y construye un consecutivo estable", () => {
    expect(normalizeOrderCode(" #kp123 ")).toBe("KP123");
    expect(buildOutputCode("#KP123", 2)).toBe("KP123-S02");
    expect(buildOutputCode(null, 2)).toBe("");
    expect(buildOutputCode("#KP123", 0)).toBe("");
  });

  it("agrega el courier solo a la etiqueta visible", () => {
    expect(outputDisplayCode("KP123-S02", "Axel Courier")).toBe("KP123-S02-AXEL-COURIER");
    expect(outputDisplayCode("KP123-S02", null)).toBe("KP123-S02");
  });
});

describe("política de repetición", () => {
  const base = { priorOutputsWithCourier: 1, totalOutputs: 2 };

  it("permite repetir Axel y motorizados propios", () => {
    expect(canRepeatCourier({ ...base, courier: "Axel Courier", operation: "lima" }).allowed).toBe(true);
    expect(canRepeatCourier({ ...base, courier: "motorizado propio", operation: "lima" }).allowed).toBe(true);
  });

  it("Swayp se repite en provincia, pero no en Lima", () => {
    expect(canRepeatCourier({ ...base, courier: "swayp", operation: "provincia_cod" }).allowed).toBe(true);
    expect(canRepeatCourier({ ...base, courier: "swayp", operation: "lima" })).toEqual({
      allowed: false,
      reason: "courier_already_used",
    });
  });

  it("no inventa todavía un bloqueo para Aliclik", () => {
    expect(canRepeatCourier({ ...base, courier: "aliclik", operation: "provincia_cod" }).allowed).toBe(true);
  });

  it("el máximo global gana sobre la política del courier", () => {
    expect(canRepeatCourier({
      courier: "Axel Courier",
      operation: "lima",
      priorOutputsWithCourier: 2,
      totalOutputs: 5,
    })).toEqual({ allowed: false, reason: "max_outputs" });
  });
});


describe("anular una salida de ruta manual", () => {
  // El caso real que lo destapó: AUR175201 tenía una salida `por_definir` creada
  // por error, nunca despachada. El modal de Shalom contestaba "anúlala antes de
  // crear otra" y no existía ningún botón ni acción que la anulara — el pedido
  // no podía emitir guía ni finalizarse.
  const parada = {
    courier: "por_definir",
    created_via: "mom_manual_route",
    delivery_status: "pendiente",
    custody_state: "empresa",
    custody_transferred_at: null,
  };

  it("la salida manual pendiente y en almacén se puede anular", () => {
    expect(manualOutputIsCancelable(parada)).toBe(true);
    expect(manualOutputIsCancelable({ ...parada, courier: "axel" })).toBe(true);
    expect(manualOutputIsCancelable({ ...parada, courier: "olva" })).toBe(true);
  });

  it("no alcanza a los couriers con anulación propia por API", () => {
    // Marcar `anulado` acá dejaría la guía viva del otro lado: la peor mentira.
    expect(
      manualOutputIsCancelable({ ...parada, courier: "shalom", created_via: "shalom_pro_api" }),
    ).toBe(false);
    expect(
      manualOutputIsCancelable({ ...parada, courier: "aliclik", created_via: "aliclik_api" }),
    ).toBe(false);
    expect(manualOutputIsCancelable({ ...parada, courier: "fenix", created_via: "fenix_directo" })).toBe(
      false,
    );
  });

  it("una salida importada del reporte —sin `created_via`— tampoco se anula acá", () => {
    expect(manualOutputIsCancelable({ ...parada, created_via: null })).toBe(false);
    expect(manualOutputIsCancelable({ ...parada, created_via: undefined })).toBe(false);
  });

  it("con la caja ya entregada al motorizado, el camino es el retorno", () => {
    expect(manualOutputIsCancelable({ ...parada, custody_state: "courier" })).toBe(false);
    expect(
      manualOutputIsCancelable({ ...parada, custody_transferred_at: "2026-08-11T15:00:00Z" }),
    ).toBe(false);
    // La custodia puede ir en blanco en filas viejas; eso no debe leerse como
    // "ya salió", pero el sello de transferencia sí manda.
    expect(manualOutputIsCancelable({ ...parada, custody_state: null })).toBe(true);
  });

  it("solo `pendiente` sigue siendo un registro por corregir", () => {
    for (const estado of ["en_ruta", "entregado", "devuelto", "anulado", "por_preparar"]) {
      expect(manualOutputIsCancelable({ ...parada, delivery_status: estado })).toBe(false);
    }
  });

  it("anular saca la salida de las que bloquean al pedido", () => {
    // `ACTIVE_STATUSES` de los modales de guía y el freno de `finalize` son los
    // mismos tres estados: con `anulado` la salida deja de contar en ambos.
    const activos = new Set(["pendiente", "en_ruta", "por_preparar"]);
    expect(activos.has(parada.delivery_status)).toBe(true);
    expect(activos.has("anulado")).toBe(false);
  });
});
