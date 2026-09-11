import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  API_OWNERSHIP_DAYS,
  apiOwnsDeliveryStatus,
  reconcileDeliveryStatus,
  reconcileReportedDeliveryStatus,
  reopensForFailedAttempt,
  statusAfterFailedAttempt,
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

describe("reopensForFailedAttempt — un NO CONTESTA devuelve la guía a la cola", () => {
  const base = {
    existingStatus: "en_ruta",
    attemptFailed: true,
    attemptDate: "2026-08-13",
    scheduledFor: "2026-08-13T00:00:00+00",
  };

  it("EL CASO: el courier salió el día agendado y no la encontró", () => {
    // Chimbote: agendada para el 13-ago, intento del 13-ago fallido. Sin esto se
    // quedaba En ruta, nadie la volvía a llamar y se devolvía a Lima con flete.
    expect(reopensForFailedAttempt(base)).toBe(true);
  });

  it("un intento POSTERIOR al día agendado también la reabre", () => {
    expect(reopensForFailedAttempt({ ...base, attemptDate: "2026-08-14" })).toBe(true);
  });

  it("un reporte rezagado NO deshace una reprogramación que aún no le toca", () => {
    // Intento viejo (13-ago) contra una reprogramación nueva para el 20-ago.
    expect(
      reopensForFailedAttempt({ ...base, attemptDate: "2026-08-13", scheduledFor: "2026-08-20T00:00:00+00" }),
    ).toBe(false);
  });

  it("sin fecha del intento falla del lado seguro (no reabre)", () => {
    expect(reopensForFailedAttempt({ ...base, attemptDate: null })).toBe(false);
  });

  it("sin fecha agendada sí reabre: no hay nada que proteger", () => {
    expect(reopensForFailedAttempt({ ...base, scheduledFor: null, attemptDate: null })).toBe(true);
  });

  it("solo aplica a guías En ruta", () => {
    for (const st of ["pendiente", "entregado", "anulado", "transferido", null]) {
      expect(reopensForFailedAttempt({ ...base, existingStatus: st })).toBe(false);
    }
  });

  it("una entrega normal no reabre nada", () => {
    expect(reopensForFailedAttempt({ ...base, attemptFailed: false })).toBe(false);
  });
});

describe("statusAfterFailedAttempt — el mismo NO CONTESTA no saca la guía de la cola", () => {
  // EL CASO (11-09-2026): el barrido de la API relee cada guía cada 20 minutos,
  // dos veces (las dos tiendas listan los mismos pedidos). El mismo snapshot
  // NOT_RESPOND reabría la guía en una lectura y la avanzaba en la siguiente:
  // 90 guías rebotando pendiente ↔ en_ruta, 430 eventos por hora de madrugada.
  const snapshot = {
    attemptFailed: true,
    attemptDate: "2026-09-11",
    scheduledFor: null,
  };

  it("primera lectura: la reabre (en_ruta → pendiente)", () => {
    expect(statusAfterFailedAttempt({ ...snapshot, existingStatus: "en_ruta", incoming: "en_ruta" })).toBe("pendiente");
  });

  it("segunda lectura del MISMO snapshot: se queda en la cola, no rebota", () => {
    expect(statusAfterFailedAttempt({ ...snapshot, existingStatus: "pendiente", incoming: "en_ruta" })).toBe("pendiente");
  });

  it("es un punto fijo: aplicarla dos veces da lo mismo que una", () => {
    const once = statusAfterFailedAttempt({ ...snapshot, existingStatus: "en_ruta", incoming: "en_ruta" });
    const twice = statusAfterFailedAttempt({ ...snapshot, existingStatus: once, incoming: "en_ruta" });
    expect(twice).toBe(once);
  });

  it("un estado que NO es un intento fallido avanza como siempre", () => {
    // RESCHEDULED / PICKED: el courier movió el paquete; la guía sale de la cola.
    expect(
      statusAfterFailedAttempt({ ...snapshot, attemptFailed: false, existingStatus: "pendiente", incoming: "en_ruta" }),
    ).toBe("en_ruta");
    expect(
      statusAfterFailedAttempt({ ...snapshot, attemptFailed: true, existingStatus: "pendiente", incoming: "entregado" }),
    ).toBe("entregado");
  });

  it("la reprogramación sigue protegida: un intento viejo no reabre lo agendado para después", () => {
    expect(
      statusAfterFailedAttempt({
        attemptFailed: true,
        attemptDate: "2026-09-11",
        scheduledFor: "2026-09-15T00:00:00+00",
        existingStatus: "en_ruta",
        incoming: "en_ruta",
      }),
    ).toBe("en_ruta");
  });

  it("y un terminal no se toca", () => {
    for (const st of ["entregado", "anulado", "transferido"]) {
      expect(statusAfterFailedAttempt({ ...snapshot, existingStatus: st, incoming: st })).toBe(st);
    }
  });

  it("las TRES vías que escriben estado la usan, y ninguna decide el reabrir por su cuenta", () => {
    for (const file of ["lib/aliclik-track.ts", "lib/aliclik-ingest.ts", "lib/report-ingest.ts"]) {
      const src = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(src, file).toContain("statusAfterFailedAttempt({");
      expect(src, file).not.toContain("reopensForFailedAttempt({");
    }
  });
});
