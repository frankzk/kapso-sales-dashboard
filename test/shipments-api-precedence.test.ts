import { describe, expect, it } from "vitest";
import {
  API_OWNERSHIP_DAYS,
  apiOwnsDeliveryStatus,
  reconcileDeliveryStatus,
  reconcileReportedDeliveryStatus,
} from "@/lib/shipments";

// La API manda sobre el Excel mientras su lectura siga fresca.
//
// El caso que motivó la regla: la API dice que la guía sigue viva (`en_ruta`) y
// un Excel exportado días antes dice `anulado`. Con la sola precedencia
// monotónica ganaba el Excel —`anulado` es rango 3 y `en_ruta` rango 2—, así que
// un archivo viejo CERRABA una guía que la API acababa de ver en la calle. Y un
// terminal no se reabre.

const NOW = new Date("2026-08-07T12:00:00.000Z");
const hace = (dias: number) =>
  new Date(NOW.getTime() - dias * 86_400_000).toISOString();

describe("apiOwnsDeliveryStatus", () => {
  it("sin lectura de API no hay propiedad", () => {
    expect(apiOwnsDeliveryStatus(null, NOW)).toBe(false);
    expect(apiOwnsDeliveryStatus(undefined, NOW)).toBe(false);
  });

  it("una lectura reciente da propiedad", () => {
    expect(apiOwnsDeliveryStatus(hace(0), NOW)).toBe(true);
    expect(apiOwnsDeliveryStatus(hace(API_OWNERSHIP_DAYS - 1), NOW)).toBe(true);
  });

  it("la propiedad caduca: una lectura vieja ya no manda", () => {
    expect(apiOwnsDeliveryStatus(hace(API_OWNERSHIP_DAYS + 1), NOW)).toBe(false);
  });

  it("una fecha ilegible no otorga propiedad", () => {
    expect(apiOwnsDeliveryStatus("no es una fecha", NOW)).toBe(false);
  });
});

describe("reconcileReportedDeliveryStatus — qué puede escribir el Excel", () => {
  it("sin lectura de API rige la precedencia de siempre", () => {
    expect(reconcileReportedDeliveryStatus("pendiente", "en_ruta", null, NOW)).toBe("en_ruta");
    expect(reconcileReportedDeliveryStatus("en_ruta", "anulado", null, NOW)).toBe("anulado");
  });

  it("EL CASO: un Excel viejo no cierra una guía que la API ve viva", () => {
    expect(reconcileReportedDeliveryStatus("en_ruta", "anulado", hace(0), NOW)).toBe("en_ruta");
  });

  it("con la API fresca, el Excel tampoco la da por entregada", () => {
    expect(reconcileReportedDeliveryStatus("en_ruta", "entregado", hace(1), NOW)).toBe("en_ruta");
  });

  it("cuando la lectura de API envejece, el Excel vuelve a ser autoridad", () => {
    expect(
      reconcileReportedDeliveryStatus("en_ruta", "anulado", hace(API_OWNERSHIP_DAYS + 1), NOW),
    ).toBe("anulado");
  });

  it("una guía que no existe se crea con lo que diga el reporte", () => {
    expect(reconcileReportedDeliveryStatus(null, "pendiente", hace(0), NOW)).toBe("pendiente");
  });

  it("sigue sin retroceder: un reporte viejo no reabre un terminal", () => {
    expect(reconcileReportedDeliveryStatus("entregado", "pendiente", null, NOW)).toBe("entregado");
    expect(reconcileReportedDeliveryStatus("entregado", "pendiente", hace(0), NOW)).toBe("entregado");
  });

  it("no cambia lo que ya hacía reconcileDeliveryStatus cuando no hay API", () => {
    for (const [existing, incoming] of [
      ["pendiente", "entregado"],
      ["en_ruta", "pendiente"],
      ["anulado", "entregado"],
      ["transferido", "anulado"],
    ] as const) {
      expect(reconcileReportedDeliveryStatus(existing, incoming, null, NOW)).toBe(
        reconcileDeliveryStatus(existing, incoming),
      );
    }
  });
});
