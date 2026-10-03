import { describe, expect, it } from "vitest";
import {
  readShalomTracking,
  shalomDaysAtAgency,
  shalomExitIsReturn,
  shalomGuideWrite,
  shalomNeedsTracking,
  shalomTrackingChanged,
  SHALOM_RETURN_MIN_DAYS,
  type ShalomExitFacts,
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

// «Entregado» que no fue un recojo (MOM §12, 03-10-2026). #KP128064 llegó a la
// agencia de Salas el 17/08, la clienta pagó solo el adelanto, nunca se le dio
// la clave, y el 22/09 Shalom sacó la caja para devolverla con «cambio de
// destino». Su guía original quedó con fecha en `entregado`.
describe("el «entregado» de Shalom que es un retorno", () => {
  const llegada = "2026-08-17 04:48:09";
  const salida = (fecha: string) =>
    readShalomTracking({
      registrado: f("2026-08-15 08:00:43"),
      origen: f("2026-08-15 08:00:43"),
      transito: f("2026-08-15 11:20:53"),
      destino: f(llegada),
      entregado: f(fecha),
    });
  const KP128064 = salida("2026-09-22 10:25:24");
  const sinClaveNiCobro: ShalomExitFacts = { hasKey: true, keyGiven: false, collected: false };

  it("el rastreo guarda cuándo llegó a la agencia de destino", () => {
    expect(KP128064.arrivedAt).toBe(llegada);
    expect(readShalomTracking({ transito: f("2026-04-15 14:08:21") }).arrivedAt).toBeNull();
  });

  it("cuenta los días enteros en la agencia, sin inventar con fechas que faltan o al revés", () => {
    expect(shalomDaysAtAgency(KP128064)).toBe(36);
    expect(shalomDaysAtAgency({ arrivedAt: null, at: "2026-09-22 10:25:24" })).toBeNull();
    expect(shalomDaysAtAgency({ arrivedAt: "2026-09-22 10:25:24", at: "2026-09-21 10:25:24" })).toBeNull();
    // Con zona o sin ella, las dos fechas se leen igual.
    expect(shalomDaysAtAgency({ arrivedAt: "2026-08-17T04:48:09-05:00", at: "2026-09-22T10:25:24-05:00" })).toBe(36);
  });

  it("#KP128064: clave registrada que nadie dio, sin cobro y 36 días en la agencia → retorno", () => {
    expect(shalomExitIsReturn(KP128064, sinClaveNiCobro)).toBe(true);
  });

  it("si la clave se reveló o se envió, la clienta pudo recogerlo: se respeta el recojo", () => {
    expect(shalomExitIsReturn(KP128064, { ...sinClaveNiCobro, keyGiven: true })).toBe(false);
  });

  it("si está cobrado, a la clienta se le libera la clave: se respeta el recojo", () => {
    expect(shalomExitIsReturn(KP128064, { ...sinClaveNiCobro, collected: true })).toBe(false);
  });

  it("sin clave registrada no hay nada que pruebe que no pudo recogerlo", () => {
    expect(shalomExitIsReturn(KP128064, { ...sinClaveNiCobro, hasKey: false })).toBe(false);
  });

  it("un recojo a los pocos días se respeta aunque falte el saldo: lo mira una persona", () => {
    // Como #KP125426, que salió de la agencia a los 3 días sin pago registrado
    // ni clave revelada: la alerta de cobro sigue encendida para revisarlo.
    expect(shalomExitIsReturn(salida("2026-08-20 11:18:00"), sinClaveNiCobro)).toBe(false);
  });

  it("el umbral es de días enteros en la agencia", () => {
    expect(SHALOM_RETURN_MIN_DAYS).toBe(8);
    expect(shalomExitIsReturn(salida("2026-08-25 04:48:08"), sinClaveNiCobro)).toBe(false); // 7 días y 23:59
    expect(shalomExitIsReturn(salida("2026-08-25 04:48:09"), sinClaveNiCobro)).toBe(true); // 8 días
  });

  it("sin fecha de llegada no se adivina un retorno", () => {
    const sinLlegada = readShalomTracking({ transito: f("2026-08-15 11:20:53"), entregado: f("2026-09-22 10:25:24") });
    expect(shalomExitIsReturn(sinLlegada, sinClaveNiCobro)).toBe(false);
  });

  it("solo se mira un «entregado»", () => {
    const enAgencia = readShalomTracking({ destino: f(llegada) });
    expect(shalomExitIsReturn(enAgencia, sinClaveNiCobro)).toBe(false);
    // Aunque el hito vivo llegue días después de la llegada.
    const enReparto = readShalomTracking({ destino: f(llegada), reparto: f("2026-08-27 09:00:00") });
    expect(shalomDaysAtAgency(enReparto)).toBe(10);
    expect(shalomExitIsReturn(enReparto, sinClaveNiCobro)).toBe(false);
  });
});

describe("shalomGuideWrite", () => {
  const recojo = readShalomTracking({ destino: f("2026-08-17 04:48:09"), entregado: f("2026-08-19 11:00:00") });
  const retorno = readShalomTracking({ destino: f("2026-08-17 04:48:09"), entregado: f("2026-09-22 10:25:24") });

  it("un recojo se escribe como siempre", () => {
    expect(shalomGuideWrite(recojo, false)).toEqual({
      patch: { delivery_status: "entregado", status_category: "delivered", pickup_state: "recogido" },
      event: { new_status: "entregado", new_operational: "recogido", note: "Shalom: recogido.", payload: {} },
    });
    const transito = readShalomTracking({ transito: f("2026-04-15 14:08:21"), demora: f("2026-04-15 20:00:00") });
    expect(shalomGuideWrite(transito, false)).toMatchObject({
      patch: { delivery_status: "en_ruta", status_category: "pending", pickup_state: "en_transito" },
      event: { note: "Shalom: en_transito (con demora declarada)." },
    });
  });

  it("un retorno anula la guía, la pone de vuelta y fecha el cierre en la salida de la agencia", () => {
    const write = shalomGuideWrite(retorno, true);
    expect(write.patch).toEqual({
      delivery_status: "anulado",
      status_category: "closed",
      pickup_state: "retorno_iniciado",
      custody_state: "retorno",
      closed_at: "2026-09-22 10:25:24",
    });
    expect(write.event).toMatchObject({
      new_status: "anulado",
      new_operational: "retorno_iniciado",
      payload: { shalom_dice: "entregado", dias_en_agencia: 36, regla: "retorno_sin_clave" },
    });
    expect(write.event.note).toContain("36 días");
    expect(write.event.note).toContain("no un recojo");
  });

  it("la guía anulada sale del rastreo: nadie la vuelve a dar por recogida", () => {
    expect(shalomNeedsTracking(shalomGuideWrite(retorno, true).patch.delivery_status)).toBe(false);
  });

  it("escribir el retorno sobre una guía en la agencia cuenta como cambio", () => {
    const { patch } = shalomGuideWrite(retorno, true);
    expect(
      shalomTrackingChanged(
        { delivery_status: "pendiente", pickup_state: "disponible_para_recojo" },
        { deliveryStatus: patch.delivery_status, pickupState: patch.pickup_state },
      ),
    ).toBe(true);
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
