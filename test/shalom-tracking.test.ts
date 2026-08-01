import { describe, expect, it } from "vitest";
import {
  readShalomTracking,
  shalomNeedsTracking,
  shalomTrackingChanged,
} from "@/lib/shalom/tracking";

// Shalom devuelve los siete hitos SIEMPRE, con fecha los que ocurrieron y `null`
// los que no. La trampa está en que un envío entregado sigue trayendo
// `registrado` con fecha: leerlos como banderas sueltas daría el estado más
// atrasado en vez del actual. Por eso gana el más avanzado, y por eso estos
// tests mandan hitos ACUMULADOS y no uno solo.

const f = (fecha: string) => ({ fecha });

describe("readShalomTracking", () => {
  it("una guía recién creada se queda pendiente de envío", () => {
    expect(readShalomTracking({ registrado: f("2026-04-15 09:12:30") })).toMatchObject({
      deliveryStatus: "pendiente",
      pickupState: "pendiente_de_envio",
      at: "2026-04-15 09:12:30",
    });
  });

  it("sin ningún hito no inventa nada", () => {
    expect(readShalomTracking(null)).toMatchObject({
      deliveryStatus: "pendiente",
      pickupState: "pendiente_de_envio",
      at: null,
    });
    expect(readShalomTracking({})).toMatchObject({ pickupState: "pendiente_de_envio" });
  });

  it("recibido en la agencia de origen", () => {
    expect(
      readShalomTracking({ registrado: f("2026-04-15 09:00:00"), origen: f("2026-04-15 09:12:30") }),
    ).toMatchObject({ deliveryStatus: "pendiente", pickupState: "registrado_en_agencia" });
  });

  it("en tránsito pasa a en_ruta", () => {
    expect(
      readShalomTracking({
        registrado: f("2026-04-15 09:00:00"),
        origen: f("2026-04-15 09:12:30"),
        transito: { fecha: "2026-04-15 14:08:21", completo: true, carguero: "966345" },
      }),
    ).toMatchObject({ deliveryStatus: "en_ruta", pickupState: "en_transito" });
  });

  // Llegar a la agencia de destino NO es entregar: el paquete espera al cliente,
  // así que la guía sigue viva. Es el mismo criterio del adaptador de reportes.
  it("en la agencia de destino queda disponible para recojo, y sigue pendiente", () => {
    expect(
      readShalomTracking({
        registrado: f("2026-04-15 09:00:00"),
        origen: f("2026-04-15 09:12:30"),
        transito: f("2026-04-15 14:08:21"),
        destino: f("2026-04-16 01:01:03"),
      }),
    ).toMatchObject({
      deliveryStatus: "pendiente",
      pickupState: "disponible_para_recojo",
      at: "2026-04-16 01:01:03",
    });
  });

  it("entregado gana a todos los hitos anteriores", () => {
    expect(
      readShalomTracking({
        registrado: f("2026-04-15 09:00:00"),
        origen: f("2026-04-15 09:12:30"),
        transito: f("2026-04-15 14:08:21"),
        destino: f("2026-04-16 01:01:03"),
        entregado: f("2026-04-16 11:40:45"),
      }),
    ).toMatchObject({
      deliveryStatus: "entregado",
      pickupState: "recogido",
      at: "2026-04-16 11:40:45",
    });
  });

  // `reparto` solo puede ocurrir después de `destino`, así que tiene que ganarle
  // aunque venga después en el objeto.
  it("reparto a domicilio gana a destino", () => {
    expect(
      readShalomTracking({
        destino: f("2026-04-16 01:01:03"),
        reparto: f("2026-04-16 08:00:00"),
      }),
    ).toMatchObject({ deliveryStatus: "en_ruta", pickupState: "en_reparto" });
  });

  it("la demora se marca sin pisar el estado del viaje", () => {
    const snap = readShalomTracking({
      transito: f("2026-04-15 14:08:21"),
      demora: f("2026-04-15 20:00:00"),
    });
    expect(snap.delayed).toBe(true);
    expect(snap.pickupState).toBe("en_transito");
  });

  it("un hito sin fecha cuenta como no ocurrido", () => {
    expect(
      readShalomTracking({ registrado: f("2026-04-15 09:00:00"), entregado: { fecha: "" } }),
    ).toMatchObject({ deliveryStatus: "pendiente", pickupState: "pendiente_de_envio" });
    expect(readShalomTracking({ entregado: null, destino: null })).toMatchObject({
      pickupState: "pendiente_de_envio",
    });
  });
});

describe("shalomTrackingChanged", () => {
  // El cron pasa cada media hora sobre las mismas guías y casi nunca hay
  // novedad. Sin esta comparación cada pasada tocaría cada fila, ensuciaría el
  // `updated_at` que el Master usa para ordenar por movimiento, y llenaría la
  // línea de tiempo de eventos idénticos.
  const next = readShalomTracking({ transito: f("2026-04-15 14:08:21") });

  it("no escribe cuando el estado es el mismo", () => {
    expect(
      shalomTrackingChanged({ delivery_status: "en_ruta", pickup_state: "en_transito" }, next),
    ).toBe(false);
  });

  it("escribe cuando cambia el estado operativo aunque el general siga igual", () => {
    expect(
      shalomTrackingChanged({ delivery_status: "en_ruta", pickup_state: "en_reparto" }, next),
    ).toBe(true);
  });

  it("trata el pickup_state nulo como distinto de uno con valor", () => {
    expect(shalomTrackingChanged({ delivery_status: "en_ruta", pickup_state: null }, next)).toBe(true);
  });
});

describe("shalomNeedsTracking", () => {
  it("deja de preguntar por lo que ya no se mueve", () => {
    expect(shalomNeedsTracking("entregado")).toBe(false);
    expect(shalomNeedsTracking("anulado")).toBe(false);
    expect(shalomNeedsTracking("transferido")).toBe(false);
  });

  it("sigue preguntando por lo vivo", () => {
    expect(shalomNeedsTracking("pendiente")).toBe(true);
    expect(shalomNeedsTracking("en_ruta")).toBe(true);
  });
});

