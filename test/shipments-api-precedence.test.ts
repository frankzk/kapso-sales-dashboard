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

  it("EL CASO REAL: si el reporte es POSTERIOR a la lectura de API, manda el reporte", () => {
    // Guía de Cusco: la API la leyó el 12-ago y dejó de mirarla; el Excel del
    // 15-ago la trae ENTREGADA. Antes quedaba congelada en "En ruta" hasta que
    // caducara la ventana de 7 días.
    expect(
      reconcileReportedDeliveryStatus("en_ruta", "entregado", hace(3), NOW, {
        reportAt: new Date(NOW.getTime() - 1 * 3600_000).toISOString(),
      }),
    ).toBe("entregado");
  });

  it("un reporte ANTERIOR a la lectura de API sigue sin poder tocar el estado", () => {
    expect(
      reconcileReportedDeliveryStatus("en_ruta", "entregado", hace(1), NOW, {
        reportAt: new Date(NOW.getTime() - 5 * 86_400_000).toISOString(),
      }),
    ).toBe("en_ruta");
  });

  it("sin fecha de reporte se comporta como antes (la API manda)", () => {
    expect(
      reconcileReportedDeliveryStatus("en_ruta", "entregado", hace(1), NOW, { reportAt: null }),
    ).toBe("en_ruta");
  });

  it("ganar por recencia no rompe la monotonía: no reabre un terminal", () => {
    expect(
      reconcileReportedDeliveryStatus("entregado", "pendiente", hace(3), NOW, {
        reportAt: new Date(NOW.getTime() - 1 * 3600_000).toISOString(),
      }),
    ).toBe("entregado");
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
