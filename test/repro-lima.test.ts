// «Repro Lima» (fase 1, entrega 1a; decisiones del owner del 12-10-2026).
// Las reglas puras de lib/repro-lima.ts: episodio, caja, fechas, plan,
// estado del acuerdo, listas, orden, chapas y notas del historial.

import { describe, expect, it } from "vitest";
import {
  agreementDateProblem,
  agreementState,
  agreementStateLabel,
  boxLocation,
  boxLocationLabel,
  claimView,
  compareEpisodeStops,
  cutoffNotice,
  dismantleSuggested,
  failureLine,
  faltaSalidaWhy,
  firstAllowedDay,
  isAgreementBoxAction,
  isOwnBox,
  lastRouteDay,
  limaDateTimeFromInput,
  limaDateTimeInputValue,
  limaDateTimeIso,
  materializationPlan,
  nextCallProblem,
  nextRoundAt,
  noEsperarCajaAplica,
  normalizeReproChanges,
  porDecidirRank,
  programOrigin,
  reproCallTimeLabel,
  reproCourierDisabledReason,
  reproCourierName,
  reproEpisode,
  reproEpisodeKey,
  reproEventKind,
  reproEventNote,
  REPRO_EVENT_KINDS,
  reproList,
  reproProgramReason,
  REPRO_COURIER_CHOICES,
  sortRepro,
  type AgreementState,
  type BoxLocation,
  type ReproAgreementFacts,
  type ReproOpenCaseFacts,
  type ReproSortable,
} from "@/lib/repro-lima";
import { limaClock, nextDay, scheduledDay } from "@/lib/grupo-gf-courier";
import { SWAYP_SUNDAY_ERROR } from "@/lib/swayp-dispatch-days";

/** Un instante de Lima (UTC-5). */
const lima = (day: string, time: string) => new Date(`${day}T${time}:00-05:00`);

// Lunes 12-10-2026. Jueves 15/10, sábado 17/10, domingo 18/10.
const LUNES = "2026-10-12";
const MARTES = "2026-10-13";
const MIERCOLES = "2026-10-14";
const JUEVES = "2026-10-15";
const SABADO = "2026-10-17";
const DOMINGO = "2026-10-18";

describe("el reloj de Lima se movió a lib/grupo-gf-courier.ts sin cambios", () => {
  it("limaClock, nextDay y scheduledDay", () => {
    expect(limaClock(lima(LUNES, "11:59"))).toEqual({ day: LUNES, minute: 11 * 60 + 59 });
    expect(nextDay(LUNES)).toBe(MARTES);
    expect(scheduledDay("12:00", lima(LUNES, "12:00"))).toBe(LUNES);
    expect(scheduledDay("12:00", lima(LUNES, "12:01"))).toBe(MARTES);
  });
});

describe("reproEpisodeKey", () => {
  const stop = (id: string, reported_at: string) => ({ id, reported_at, status: "no_entregado" });
  const tanders = (id: string, output_number: number, extra: Record<string, unknown> = {}) => ({
    id,
    output_number,
    courier: "tanders",
    delivery_status: "en_ruta",
    reported_status: "RETURNING",
    ...extra,
  });

  it("la misma parada (reintento del mismo día) es el mismo episodio", () => {
    const a = reproEpisodeKey({ orderId: "o1", outputs: [], failedStops: [stop("s1", "2026-10-10T20:00:00Z")] });
    const b = reproEpisodeKey({ orderId: "o1", outputs: [], failedStops: [stop("s1", "2026-10-10T23:00:00Z")] });
    expect(a).toBe("s:s1|o:-");
    expect(b).toBe(a);
  });

  it("una parada nueva abre otro episodio: manda la más reciente", () => {
    const key = reproEpisodeKey({
      orderId: "o1",
      outputs: [],
      failedStops: [stop("s1", "2026-10-10T20:00:00Z"), stop("s2", "2026-10-12T19:00:00Z")],
    });
    expect(key).toBe("s:s2|o:-");
  });

  it("solo cuentan las paradas «No entregado»", () => {
    const key = reproEpisodeKey({
      orderId: "o1",
      outputs: [],
      failedStops: [stop("s1", "2026-10-10T20:00:00Z"), { id: "s9", reported_at: "2026-10-12T19:00:00Z", status: "entregado" }],
    });
    expect(key).toBe("s:s1|o:-");
  });

  it("la salida de Tanders que no entregó entra en la llave (la de consecutivo más alto)", () => {
    const key = reproEpisodeKey({
      orderId: "o1",
      outputs: [
        tanders("t1", 1),
        tanders("t2", 2),
        { id: "g3", output_number: 3, courier: "propio", delivery_status: "pendiente" },
      ],
      failedStops: [],
    });
    expect(key).toBe("s:-|o:t2");
  });

  it("sin parada ni salida fallida: el pedido", () => {
    expect(reproEpisodeKey({ orderId: "o1", outputs: [{ id: "g1", courier: "propio", delivery_status: "pendiente" }], failedStops: [] })).toBe("order:o1");
    expect(reproEpisode({ orderId: "o1", outputs: [], failedStops: [] })).toEqual({ key: "order:o1", at: null });
  });

  it("corregir la parada de un día anterior no la vuelve el fallo más reciente (F0)", () => {
    // S1 es del lunes y se corrigió el miércoles (Liquidaciones 2 reescribe
    // `reported_at`); S2 es del martes. Manda el día de la ruta.
    const s1 = { id: "s1", reported_at: "2026-10-14T23:00:00Z", status: "no_entregado", routeDate: LUNES };
    const s2 = { id: "s2", reported_at: "2026-10-13T20:00:00Z", status: "no_entregado", routeDate: MARTES };
    const ep = reproEpisode({ orderId: "o1", outputs: [], failedStops: [s1, s2] });
    expect(ep.key).toBe("s:s2|o:-");
    expect(ep.at).toBe("2026-10-13T20:00:00.000Z");
    expect([s1, s2].sort(compareEpisodeStops).map((s) => s.id)).toEqual(["s2", "s1"]);
    // El mismo día de ruta sin `created_at`: manda `reported_at`, y después el id.
    const s3 = { id: "s3", reported_at: "2026-10-13T21:00:00Z", status: "no_entregado", routeDate: MARTES };
    expect(reproEpisodeKey({ orderId: "o1", outputs: [], failedStops: [s2, s3] })).toBe("s:s3|o:-");
  });

  it("dos rutas el mismo día: manda la parada que nació después, aunque corrijan la otra (F0)", () => {
    // Roy falló S01 a las 10:00 (parada r1, nacida a las 08:00); «Sacar con
    // salida nueva» mandó la S02 con Johnny (parada j1, nacida a las 12:30),
    // que falló a las 17:00. Al día siguiente corrigen la nota de r1.
    const r1 = { id: "r1", reported_at: "2026-10-14T15:00:00Z", status: "no_entregado", routeDate: MARTES, created_at: "2026-10-13T13:00:00Z" };
    const j1 = { id: "j1", reported_at: "2026-10-13T22:00:00Z", status: "no_entregado", routeDate: MARTES, created_at: "2026-10-13T17:30:00Z" };
    expect(reproEpisodeKey({ orderId: "o1", outputs: [], failedStops: [r1, j1] })).toBe("s:j1|o:-");
    expect([r1, j1].sort(compareEpisodeStops).map((s) => s.id)).toEqual(["j1", "r1"]);
    // El día de la ruta sigue mandando sobre el nacimiento.
    const lunes = { ...j1, id: "l1", routeDate: LUNES, created_at: "2026-10-14T00:00:00Z" };
    expect([lunes, r1].sort(compareEpisodeStops).map((s) => s.id)).toEqual(["r1", "l1"]);
  });

  it("el momento del episodio es el fallo más reciente (E1)", () => {
    const ep = reproEpisode({
      orderId: "o1",
      outputs: [tanders("t1", 1, { returned_at: "2026-10-11T15:00:00Z" })],
      failedStops: [stop("s1", "2026-10-10T20:00:00Z")],
    });
    expect(ep.key).toBe("s:s1|o:t1");
    expect(ep.at).toBe("2026-10-11T15:00:00.000Z");
  });
});

describe("boxLocation", () => {
  const office = { custody_state: "empresa", custody_transferred_at: null };

  it("con el motorizado, desde el día de su caja", () => {
    const box = boxLocation({
      ownLive: office,
      box: { riderName: "Roy", routeDate: "2026-10-10", undeliveredReason: "rechazado" },
      lastFailed: null,
      receivedAt: null,
    });
    expect(box).toEqual({ kind: "con_motorizado", riderName: "Roy", since: "2026-10-10" });
    expect(boxLocationLabel(box)).toBe("Con Roy desde sáb 10/10");
  });

  it("en una caja sin «No entregado» de esa caja: con el motorizado, sin reporte (E11)", () => {
    const box = boxLocation({ ownLive: office, box: { riderName: "Roy", routeDate: "2026-10-10", undeliveredReason: null }, lastFailed: null, receivedAt: null });
    expect(box).toEqual({ kind: "con_motorizado", riderName: "Roy", since: "2026-10-10", sinReporte: true });
    expect(boxLocationLabel(box)).toBe("Con Roy desde sáb 10/10 · sin reporte de esa caja");
  });

  it("en oficina solo si `ownRetryDecision` dice «tomar» (E11)", () => {
    const box = boxLocation({ ownLive: office, box: null, lastFailed: null, receivedAt: "2026-10-12T14:00:00Z" });
    expect(box).toEqual({ kind: "en_oficina", since: "2026-10-12T14:00:00Z", courier: "propio" });
    expect(boxLocationLabel(box)).toBe("En oficina desde lun 12/10");
    expect(isOwnBox(box)).toBe(true);
  });

  it("custodia de la empresa pero con traspaso (ruta manual antigua): no consta", () => {
    const box = boxLocation({ ownLive: { custody_state: "empresa", custody_transferred_at: "2026-09-01T00:00:00Z" }, box: null, lastFailed: null, receivedAt: null });
    expect(box).toEqual({ kind: "desconocida", own: true, block: "fuera_de_oficina" });
    expect(boxLocationLabel(box)).toBe("No consta dónde está la caja");
  });

  it("la salida en otra solicitud de Grupo GF: no consta", () => {
    const box = boxLocation({ ownLive: office, box: null, inOtherRequest: true, lastFailed: null, receivedAt: null });
    expect(box).toEqual({ kind: "desconocida", own: true, block: "salida_en_otra_solicitud" });
  });

  it("la de otro courier: vuelve, o ya volvió (en oficina)", () => {
    const back = boxLocation({ ownLive: null, box: null, lastFailed: { courier: "tanders", returned: false }, receivedAt: null });
    expect(back).toEqual({ kind: "volviendo_courier", courier: "tanders" });
    expect(boxLocationLabel(back)).toBe("Vuelve con Tanders");
    const returned = boxLocation({ ownLive: null, box: null, lastFailed: { courier: "swayp", returned: true, returnedAt: "2026-10-11T16:00:00Z" }, receivedAt: null });
    expect(returned).toEqual({ kind: "en_oficina", since: "2026-10-11T16:00:00Z", courier: "swayp" });
    expect(isOwnBox(returned)).toBe(false);
  });

  it("sin nada: no consta", () => {
    expect(boxLocation({ ownLive: null, box: null, lastFailed: null, receivedAt: null })).toEqual({ kind: "desconocida" });
  });
});

describe("noEsperarCajaAplica (§9.3, fila 2; E29)", () => {
  it("con el motorizado o volviendo con su courier; en oficina, no", () => {
    expect(noEsperarCajaAplica({ kind: "con_motorizado", riderName: "Roy", since: "2026-10-10" })).toBe(true);
    expect(noEsperarCajaAplica({ kind: "volviendo_courier", courier: "tanders" })).toBe(true);
    expect(noEsperarCajaAplica({ kind: "en_oficina", since: null, courier: "propio" })).toBe(false);
    expect(noEsperarCajaAplica({ kind: "en_oficina", since: null, courier: "propio" }, true)).toBe(false);
  });

  it("la caja que no consta solo en un caso reabierto después de «Desarmar y cerrar»", () => {
    const lost: BoxLocation = { kind: "desconocida", own: true, block: "fuera_de_oficina" };
    expect(noEsperarCajaAplica(lost)).toBe(false);
    expect(noEsperarCajaAplica({ kind: "desconocida" })).toBe(false);
    expect(noEsperarCajaAplica({ kind: "desconocida", own: true }, true)).toBe(true);
    expect(noEsperarCajaAplica(lost, true)).toBe(true);
  });
});

describe("firstAllowedDay", () => {
  it("Grupo GF: hoy hasta el corte, después mañana", () => {
    expect(firstAllowedDay("propio", "12:00", lima(LUNES, "12:00"))).toBe(LUNES);
    expect(firstAllowedDay("propio", "12:00", lima(LUNES, "12:01"))).toBe(MARTES);
  });

  it("una acción de la noche anterior: desde mañana (E14)", () => {
    expect(firstAllowedDay("propio", "12:00", lima(LUNES, "09:00"), "reimprimir_misma_salida")).toBe(MARTES);
    expect(firstAllowedDay("propio", "12:00", lima(LUNES, "09:00"), "desarmar_rearmar")).toBe(MARTES);
    expect(firstAllowedDay("tanders", "12:00", lima(LUNES, "09:00"), "salida_nueva_rearmar")).toBe(MARTES);
    expect(firstAllowedDay("propio", "12:00", lima(LUNES, "09:00"), "mantener")).toBe(LUNES);
    expect(firstAllowedDay("propio", "12:00", lima(LUNES, "09:00"), "caja_nueva_stock")).toBe(LUNES);
  });

  it("Swayp: desde mañana y nunca domingo (E15)", () => {
    expect(firstAllowedDay("fenix", "12:00", lima(LUNES, "09:00"))).toBe(MARTES);
    expect(firstAllowedDay("fenix", "12:00", lima(SABADO, "09:00"))).toBe("2026-10-19");
  });

  it("Tanders y Axel: hoy", () => {
    expect(firstAllowedDay("tanders", "12:00", lima(LUNES, "17:00"))).toBe(LUNES);
    expect(firstAllowedDay("axel", "12:00", lima(LUNES, "17:00"), "caja_nueva_stock")).toBe(LUNES);
  });
});

describe("agreementDateProblem", () => {
  const base = { today: LUNES, cutoff: "12:00:00", courier: "propio" as const };
  const at = (hh: number, mm: number) => hh * 60 + mm;

  it("corte «12:00:00»: 11:59 y 12:00 valen hoy; 12:01 no", () => {
    expect(agreementDateProblem({ ...base, day: LUNES, nowMinute: at(11, 59) })).toBeNull();
    expect(agreementDateProblem({ ...base, day: LUNES, nowMinute: at(12, 0) })).toBeNull();
    expect(agreementDateProblem({ ...base, day: LUNES, nowMinute: at(12, 1) })).toBe(
      "Pasó el corte de las 12:00: elige mañana. Para hoy, lo aprueba Despacho GF desde «Programar».",
    );
    expect(agreementDateProblem({ ...base, day: MARTES, nowMinute: at(12, 1) })).toBeNull();
  });

  it("corte «11:30»: manda el del proveedor", () => {
    expect(agreementDateProblem({ ...base, cutoff: "11:30", day: LUNES, nowMinute: at(11, 30) })).toBeNull();
    expect(agreementDateProblem({ ...base, cutoff: "11:30", day: LUNES, nowMinute: at(11, 31) })).toBe(
      "Pasó el corte de las 11:30: elige mañana. Para hoy, lo aprueba Despacho GF desde «Programar».",
    );
  });

  it("el corte es solo de Grupo GF", () => {
    expect(agreementDateProblem({ ...base, courier: "tanders", day: LUNES, nowMinute: at(16, 0) })).toBeNull();
  });

  it("Swayp: nunca hoy y nunca domingo", () => {
    expect(agreementDateProblem({ ...base, courier: "fenix", day: LUNES, nowMinute: at(9, 0) })).toBe(
      "Swayp arma su ruta el día anterior: elige desde mañana.",
    );
    expect(agreementDateProblem({ ...base, courier: "fenix", day: DOMINGO, nowMinute: at(9, 0) })).toBe(SWAYP_SUNDAY_ERROR);
    expect(agreementDateProblem({ ...base, courier: "fenix", day: SABADO, nowMinute: at(9, 0) })).toBeNull();
  });

  it("una acción de la noche anterior no vale para hoy (E14)", () => {
    expect(agreementDateProblem({ ...base, day: LUNES, nowMinute: at(9, 0), boxAction: "reimprimir_misma_salida" })).toBe(
      "«Reimprimir el rótulo de la misma salida» se prepara la noche anterior: elige desde mañana.",
    );
    expect(agreementDateProblem({ ...base, day: MARTES, nowMinute: at(9, 0), boxAction: "desarmar_rearmar" })).toBeNull();
    expect(agreementDateProblem({ ...base, day: LUNES, nowMinute: at(9, 0), boxAction: "mantener" })).toBeNull();
  });

  it("pasada o a más de 60 días: la regla de siempre", () => {
    expect(agreementDateProblem({ ...base, day: "2026-10-11", nowMinute: at(9, 0) })).toBe("La nueva fecha no puede ser anterior a hoy.");
    expect(agreementDateProblem({ ...base, day: "2026-12-11", nowMinute: at(9, 0) })).toBeNull();
    expect(agreementDateProblem({ ...base, day: "2026-12-12", nowMinute: at(9, 0) })).toBe("La nueva fecha no puede pasar de 60 días.");
    expect(agreementDateProblem({ ...base, day: "15/10", nowMinute: at(9, 0) })).toBe("Elige una fecha válida.");
  });
});

describe("cutoffNotice", () => {
  it("antes y después del corte", () => {
    expect(cutoffNotice("12:00", lima(LUNES, "11:00"))).toEqual({ passed: false, text: "Lo que confirmes hasta las 12:00 sale hoy" });
    expect(cutoffNotice("12:00", lima(LUNES, "12:30"))).toEqual({ passed: true, text: "Pasó el corte: lo confirmado sale mañana" });
  });
});

describe("próxima llamada", () => {
  it("nextRoundAt: a las 10:00 propone hoy 15:00; a las 16:00, mañana 08:30", () => {
    expect(nextRoundAt(lima(LUNES, "10:00"))).toBe(`${LUNES}T15:00:00-05:00`);
    expect(nextRoundAt(lima(LUNES, "16:00"))).toBe(`${MARTES}T08:30:00-05:00`);
  });

  it("nextRoundAt exige cinco minutos de margen (E19)", () => {
    expect(nextRoundAt(lima(LUNES, "14:50"))).toBe(`${LUNES}T15:00:00-05:00`);
    expect(nextRoundAt(lima(LUNES, "14:55"))).toBe(`${LUNES}T15:00:00-05:00`);
    expect(nextRoundAt(lima(LUNES, "14:56"))).toBe(`${MARTES}T08:30:00-05:00`);
    expect(nextCallProblem(nextRoundAt(lima(LUNES, "14:56")), lima(LUNES, "14:56"))).toBeNull();
  });

  it("nextCallProblem", () => {
    const now = lima(LUNES, "10:00");
    expect(nextCallProblem(null, now)).toBe("Elige el día y la hora de la llamada.");
    expect(nextCallProblem("mañana", now)).toBe("Elige el día y la hora de la llamada.");
    // Un datetime-local suelto se leería en la zona del servidor: no vale.
    expect(nextCallProblem("2026-10-12T15:00", now)).toBe("Elige el día y la hora de la llamada.");
    expect(nextCallProblem(limaDateTimeIso(LUNES, "09:59"), now)).toBe("Elige una hora que todavía no pasó.");
    expect(nextCallProblem(limaDateTimeIso(LUNES, "10:00"), now)).toBe("Elige una hora que todavía no pasó.");
    expect(nextCallProblem(limaDateTimeIso(LUNES, "10:01"), now)).toBeNull();
    expect(nextCallProblem("2026-10-12T20:00:00.000Z", now)).toBeNull();
    expect(nextCallProblem(limaDateTimeIso("2026-12-11", "10:00"), now)).toBeNull();
    expect(nextCallProblem(limaDateTimeIso("2026-12-11", "10:01"), now)).toBe("La próxima llamada no puede pasar de 60 días.");
  });

  it("datetime-local solo pasa por limaDateTimeIso", () => {
    expect(limaDateTimeIso(LUNES, "15:00")).toBe("2026-10-12T15:00:00-05:00");
    expect(limaDateTimeFromInput("2026-10-13T08:30")).toBe("2026-10-13T08:30:00-05:00");
    expect(limaDateTimeFromInput("")).toBeNull();
    expect(limaDateTimeInputValue("2026-10-13T13:30:00Z")).toBe("2026-10-13T08:30");
  });

  it("reproCallTimeLabel", () => {
    const now = lima(LUNES, "10:00");
    expect(reproCallTimeLabel(limaDateTimeIso(LUNES, "15:00"), now)).toBe("hoy 15:00");
    expect(reproCallTimeLabel(limaDateTimeIso(MARTES, "08:30"), now)).toBe("mañana 08:30");
    expect(reproCallTimeLabel(limaDateTimeIso(JUEVES, "16:20"), now)).toBe("jue 15/10 16:20");
  });
});

describe("programOrigin", () => {
  it("motorizado (#908), Repro Lima o Grupo GF", () => {
    expect(programOrigin("Reprogramado por el cliente (reporte de la parada de Roy)")).toBe("motorizado");
    expect(programOrigin("Reprogramado por el cliente (reporte de la parada)")).toBe("motorizado");
    expect(programOrigin("Repro Lima: confirmado con el cliente (Diana, 12/10)")).toBe("repro_lima");
    expect(programOrigin("Confirmado con cliente: jueves, GF")).toBe("grupo_gf");
    expect(programOrigin(null)).toBe("grupo_gf");
  });

  it("el motivo de Repro Lima empieza con su prefijo y cabe en 200", () => {
    const reason = reproProgramReason("Diana", LUNES);
    expect(reason).toBe("Repro Lima: confirmado con el cliente (Diana, 12/10)");
    expect(programOrigin(reason)).toBe("repro_lima");
    expect(reproProgramReason("x".repeat(500), LUNES).length).toBeLessThanOrEqual(200);
  });
});

describe("materializationPlan", () => {
  const rider: BoxLocation = { kind: "con_motorizado", riderName: "Roy", since: "2026-10-10" };
  const ownOffice: BoxLocation = { kind: "en_oficina", since: null, courier: "propio" };
  const tandersOffice: BoxLocation = { kind: "en_oficina", since: null, courier: "tanders" };
  const tandersBack: BoxLocation = { kind: "volviendo_courier", courier: "tanders" };
  const unknown: BoxLocation = { kind: "desconocida" };
  const plan = (courier: "propio" | "tanders", boxAction: Parameters<typeof materializationPlan>[0]["boxAction"], box: BoxLocation, retryAdmission = false) =>
    materializationPlan({ courier, boxAction, box, retryAdmission });

  it("otro courier no se programa: va por la Mesa de ruta", () => {
    expect(plan("tanders", "salida_nueva_rearmar", ownOffice)).toEqual({ no: "otro_courier" });
  });

  it("caja nueva desde stock: ahora, aunque la caja siga con el motorizado («Sacar con salida nueva»)", () => {
    expect(plan("propio", "caja_nueva_stock", rider)).toBe("ahora");
    expect(plan("propio", "caja_nueva_stock", rider, true)).toBe("ahora");
  });

  it("caja nueva desde stock: solo si alguien puede sacar la salida (F12)", () => {
    // La de Tanders que vuelve: Grupo GF crea la salida al tomarlo solo si es reintento.
    expect(plan("propio", "caja_nueva_stock", tandersBack, true)).toBe("ahora");
    expect(plan("propio", "caja_nueva_stock", tandersBack, false)).toEqual({ no: "falta_salida" });
    expect(plan("propio", "caja_nueva_stock", { kind: "desconocida" }, true)).toBe("ahora");
    expect(plan("propio", "caja_nueva_stock", { kind: "desconocida" }, false)).toEqual({ no: "falta_salida" });
    // La propia en oficina (recibida o sacada con salida nueva): Grupo GF la toma.
    expect(plan("propio", "caja_nueva_stock", ownOffice)).toBe("ahora");
    // E29: estaba en oficina y el caso se reabrió: Grupo GF la toma con su S01.
    expect(plan("propio", "caja_nueva_stock", { kind: "desconocida", own: true })).toBe("ahora");
    // La propia fuera de la oficina o en otra solicitud: nadie crea la salida prometida.
    for (const block of ["fuera_de_oficina", "salida_en_otra_solicitud"] as const) {
      expect(plan("propio", "caja_nueva_stock", { kind: "desconocida", own: true, block }, true)).toEqual({ no: "falta_salida" });
    }
    expect(plan("tanders", "caja_nueva_stock", rider)).toEqual({ no: "otro_courier" });
  });

  it("la de Tanders que todavía vuelve: cuando llegue (E10)", () => {
    expect(plan("propio", "salida_nueva_rearmar", tandersBack, true)).toEqual({ no: "falta_recibir_devolucion" });
    expect(plan("propio", "mantener", tandersBack)).toEqual({ no: "falta_recibir_devolucion" });
    expect(plan("propio", "salida_nueva_rearmar", tandersOffice, true)).toBe("ahora");
  });

  it("desarmar y rearmar: ahora con la caja de otro courier y reintento (E13); si no, falta la salida", () => {
    expect(plan("propio", "desarmar_rearmar", tandersOffice, true)).toBe("ahora");
    expect(plan("propio", "desarmar_rearmar", tandersOffice, false)).toEqual({ no: "falta_salida" });
    expect(plan("propio", "desarmar_rearmar", ownOffice, true)).toEqual({ no: "falta_salida" });
    expect(plan("propio", "desarmar_rearmar", rider, true)).toEqual({ no: "falta_salida" });
  });

  it("salida nueva: ahora si Grupo GF la crea al tomarlo; si no, falta", () => {
    expect(plan("propio", "salida_nueva_rearmar", unknown, true)).toBe("ahora");
    expect(plan("propio", "salida_nueva_rearmar", ownOffice, false)).toEqual({ no: "falta_salida" });
  });

  it("mantener y reimprimir: al recibir, ahora o falta ubicarla", () => {
    for (const action of ["mantener", "reimprimir_misma_salida"] as const) {
      expect(plan("propio", action, rider)).toBe("al_recibir");
      expect(plan("propio", action, ownOffice)).toBe("ahora");
      expect(plan("propio", action, unknown)).toEqual({ no: "falta_ubicar" });
    }
  });

  it("«Desarmar y cerrar» nunca es un acuerdo", () => {
    expect(isAgreementBoxAction("mantener")).toBe(true);
    expect(isAgreementBoxAction("desarmar_cerrar")).toBe(false);
    expect(isAgreementBoxAction("otra")).toBe(false);
  });
});

describe("agreementState", () => {
  const rider: BoxLocation = { kind: "con_motorizado", riderName: "Roy", since: "2026-10-10" };
  const office: BoxLocation = { kind: "en_oficina", since: null, courier: "propio" };
  const agreed = (extra: Partial<ReproAgreementFacts> = {}): ReproAgreementFacts => ({
    agreed_on: JUEVES,
    agreed_courier: "propio",
    box_action: "mantener",
    materialized_at: null,
    materialized_on: null,
    ...extra,
  });
  const done = (extra: Partial<ReproAgreementFacts> = {}) => agreed({ materialized_at: "2026-10-12T15:00:00Z", materialized_on: JUEVES, ...extra });
  const program = (scheduled_for: string, reason = "Repro Lima: confirmado con el cliente (Diana, 12/10)") => ({ scheduled_for, reason });

  it("sin acuerdo", () => {
    expect(agreementState({ c: null, program: null, box: office, plan: null, today: LUNES })).toEqual({ kind: "sin_acuerdo" });
    expect(agreementState({ c: agreed({ agreed_on: null }), program: null, box: office, plan: null, today: LUNES })).toEqual({ kind: "sin_acuerdo" });
  });

  it("vencido antes que cualquier otro estado sin materializar (E8)", () => {
    expect(agreementState({ c: agreed({ agreed_on: "2026-10-10" }), program: null, box: office, plan: { no: "otro_courier" }, today: LUNES }))
      .toEqual({ kind: "acuerdo_vencido" });
    expect(agreementState({ c: agreed({ agreed_on: "2026-10-10" }), program: null, box: rider, plan: "al_recibir", today: LUNES }))
      .toEqual({ kind: "acuerdo_vencido" });
  });

  it("lo que impide programar, según el plan", () => {
    for (const no of ["otro_courier", "falta_salida", "falta_ubicar", "falta_recibir_devolucion"] as const) {
      expect(agreementState({ c: agreed(), program: null, box: office, plan: { no }, today: LUNES })).toEqual({ kind: no });
    }
  });

  it("sin materializar: esperando la caja o por programar", () => {
    expect(agreementState({ c: agreed(), program: null, box: rider, plan: "al_recibir", today: LUNES })).toEqual({ kind: "esperando_caja" });
    expect(agreementState({ c: agreed(), program: null, box: office, plan: "ahora", today: LUNES })).toEqual({ kind: "por_programar" });
  });

  it("materializado sin programa: Grupo GF lo quitó, o falló la escritura (E9)", () => {
    expect(agreementState({ c: done(), program: null, box: office, plan: "ahora", today: LUNES, programRemovedAt: "2026-10-12T16:00:00Z" }))
      .toEqual({ kind: "deriva_quitado" });
    // Un evento anterior a la materialización no es una deriva.
    expect(agreementState({ c: done(), program: null, box: office, plan: "ahora", today: LUNES, programRemovedAt: "2026-10-12T14:00:00Z" }))
      .toEqual({ kind: "por_programar" });
    expect(agreementState({ c: done(), program: null, box: office, plan: "ahora", today: LUNES })).toEqual({ kind: "por_programar" });
    expect(agreementState({ c: done({ agreed_on: "2026-10-10", materialized_on: "2026-10-10" }), program: null, box: office, plan: "ahora", today: LUNES }))
      .toEqual({ kind: "acuerdo_vencido" });
  });

  it("materializado y quitado por Grupo GF: cuando su día pasa, vence (F15, §9.5 regla 4)", () => {
    const removed = "2026-10-12T16:00:00Z";
    expect(agreementState({ c: done({ agreed_on: "2026-10-10", materialized_on: "2026-10-10", materialized_at: "2026-10-09T15:00:00Z" }), program: null, box: office, plan: "ahora", today: LUNES, programRemovedAt: removed }))
      .toEqual({ kind: "acuerdo_vencido" });
    // Mientras su día no pasa, sigue siendo una deriva.
    expect(agreementState({ c: done({ agreed_on: LUNES, materialized_on: LUNES }), program: null, box: office, plan: "ahora", today: LUNES, programRemovedAt: removed }))
      .toEqual({ kind: "deriva_quitado" });
  });

  describe("un acuerdo con Grupo GF para hoy que ya no alcanza (E25, F5/F13)", () => {
    const hoy = (extra: Partial<ReproAgreementFacts> = {}) => agreed({ agreed_on: LUNES, ...extra });
    const at = (hh: number, mm: number) => hh * 60 + mm;
    const state = (c: ReproAgreementFacts, plan: Parameters<typeof agreementState>[0]["plan"], nowMinute: number | null, box: BoxLocation = office) =>
      agreementState({ c, program: null, box, plan, today: LUNES, nowMinute, cutoff: "12:00:00" });

    it("por programar antes del corte; vencido después (la caja llegó tarde)", () => {
      expect(state(hoy(), "ahora", at(11, 59))).toEqual({ kind: "por_programar" });
      expect(state(hoy(), "ahora", at(12, 0))).toEqual({ kind: "por_programar" });
      expect(state(hoy(), "ahora", at(14, 0))).toEqual({ kind: "acuerdo_vencido" });
    });

    it("lo que «Programar ahora» rechazaría: una acción de la noche anterior ya no sale hoy", () => {
      expect(state(hoy({ box_action: "salida_nueva_rearmar" }), "ahora", at(9, 0))).toEqual({ kind: "acuerdo_vencido" });
      expect(state(hoy({ box_action: "reimprimir_misma_salida" }), { no: "falta_ubicar" }, at(9, 0), { kind: "desconocida" }))
        .toEqual({ kind: "acuerdo_vencido" });
      expect(state(hoy({ box_action: "caja_nueva_stock" }), "ahora", at(9, 0))).toEqual({ kind: "por_programar" });
    });

    it("esperando la caja: solo el corte (recibida antes, «Recibir en oficina» la programa)", () => {
      expect(state(hoy({ box_action: "reimprimir_misma_salida" }), "al_recibir", at(9, 0), rider)).toEqual({ kind: "esperando_caja" });
      expect(state(hoy(), "al_recibir", at(12, 1), rider)).toEqual({ kind: "acuerdo_vencido" });
    });

    it("lo que ningún botón programa no vence en su día: falta la salida nueva; otro courier no tiene corte", () => {
      expect(state(hoy(), { no: "falta_salida" }, at(13, 0))).toEqual({ kind: "falta_salida" });
      expect(state(hoy({ agreed_courier: "tanders" }), { no: "otro_courier" }, at(17, 0))).toEqual({ kind: "otro_courier" });
    });

    it("un rearmado acordado ayer para hoy sigue con «Falta la salida nueva» todo el día (no vence a las 00:01)", () => {
      const rearmar = hoy({ box_action: "desarmar_rearmar" });
      expect(state(rearmar, { no: "falta_salida" }, at(0, 1))).toEqual({ kind: "falta_salida" });
      expect(state(rearmar, { no: "falta_salida" }, at(13, 0))).toEqual({ kind: "falta_salida" });
      expect(state(hoy({ box_action: "salida_nueva_rearmar" }), { no: "falta_salida" }, at(0, 1))).toEqual({ kind: "falta_salida" });
    });

    it("materializado sin programa ni evento (falló la escritura): vence igual; sin el minuto, no se mira", () => {
      expect(agreementState({ c: done({ agreed_on: LUNES, materialized_on: LUNES }), program: null, box: office, plan: "ahora", today: LUNES, nowMinute: at(14, 0), cutoff: "12:00" }))
        .toEqual({ kind: "acuerdo_vencido" });
      expect(state(hoy(), "ahora", null)).toEqual({ kind: "por_programar" });
      // Un día que todavía no llega no vence.
      expect(agreementState({ c: agreed(), program: null, box: office, plan: "ahora", today: LUNES, nowMinute: at(14, 0), cutoff: "12:00" }))
        .toEqual({ kind: "por_programar" });
    });

    it("la chapa dice que ya no alcanza hoy", () => {
      const a = { agreed_on: LUNES, agreed_courier: "propio" };
      expect(agreementStateLabel({ kind: "acuerdo_vencido" }, a, office, LUNES)).toBe("El acuerdo era para hoy (lun 12/10) y ya no alcanza: confírmalo de nuevo");
      expect(agreementStateLabel({ kind: "acuerdo_vencido" }, { agreed_on: "2026-10-10", agreed_courier: "propio" }, office, LUNES))
        .toBe("El acuerdo era para el sáb 10/10 y ya pasó: confírmalo de nuevo");
    });
  });

  it("«Ya la encontré: programar» (E12): materializado, manda el programa y no el plan", () => {
    expect(agreementState({ c: done(), program: program(JUEVES), box: { kind: "desconocida" }, plan: { no: "falta_ubicar" }, today: LUNES }))
      .toEqual({ kind: "programado" });
  });

  it("materializado: movido, falta sacar, vencido o programado", () => {
    expect(agreementState({ c: done(), program: program("2026-10-16", "Capacidad del día"), box: office, plan: "ahora", today: LUNES }))
      .toEqual({ kind: "deriva_movido", gfDay: "2026-10-16", reason: "Capacidad del día" });
    expect(agreementState({ c: done({ box_action: "caja_nueva_stock" }), program: program(JUEVES), box: rider, plan: "ahora", today: LUNES }))
      .toEqual({ kind: "falta_sacar" });
    expect(agreementState({ c: done({ agreed_on: "2026-10-10", materialized_on: "2026-10-10" }), program: program("2026-10-10"), box: office, plan: "ahora", today: LUNES }))
      .toEqual({ kind: "programado_vencido" });
    expect(agreementState({ c: done(), program: program(JUEVES), box: office, plan: "ahora", today: LUNES })).toEqual({ kind: "programado" });
  });

  it("las chapas del estado", () => {
    const a = { agreed_on: JUEVES, agreed_courier: "propio" };
    expect(agreementStateLabel({ kind: "esperando_caja" }, a)).toBe("Sale jue 15/10 con Grupo GF · esperando la caja");
    expect(agreementStateLabel({ kind: "deriva_quitado" }, a)).toBe("Grupo GF no tiene la fecha (acordado jue 15/10)");
    expect(agreementStateLabel({ kind: "deriva_movido", gfDay: "2026-10-16", reason: "Capacidad" }, a)).toBe("Grupo GF lo movió al vie 16/10 («Capacidad»)");
    expect(agreementStateLabel({ kind: "falta_sacar" }, a)).toBe("Falta: Sacar con salida nueva");
    expect(agreementStateLabel({ kind: "falta_salida" }, a)).toBe("Falta la salida nueva");
    // Por qué falta: con «Caja nueva desde stock» no es «la caja en oficina» (F12).
    expect(faltaSalidaWhy("caja_nueva_stock")).toBe("para una caja nueva desde stock");
    expect(faltaSalidaWhy("desarmar_rearmar")).toBe("con la caja en oficina");
    expect(faltaSalidaWhy(null)).toBe("con la caja en oficina");
    expect(agreementStateLabel({ kind: "otro_courier" }, { agreed_on: JUEVES, agreed_courier: "tanders" })).toBe("Sale jue 15/10 con Tanders · crea la salida en la Mesa de ruta");
    expect(agreementStateLabel({ kind: "falta_recibir_devolucion" }, a, { kind: "volviendo_courier", courier: "tanders" }))
      .toBe("Vuelve con Tanders: se programa cuando llegue (Devoluciones)");
  });
});

describe("reproList", () => {
  const now = lima(LUNES, "10:00");
  const EP = "s:s2|o:-";
  const open = (extra: Partial<ReproOpenCaseFacts> = {}): ReproOpenCaseFacts => ({
    episode_key: EP,
    next_call_at: null,
    agreed_on: null,
    agreed_courier: null,
    box_action: null,
    materialized_at: null,
    materialized_on: null,
    ...extra,
  });
  const none: AgreementState = { kind: "sin_acuerdo" };
  const list = (args: Partial<Parameters<typeof reproList>[0]>) =>
    reproList({ open: null, latestClosed: null, episodeKey: EP, state: none, program: null, now, ...args });

  it("1. «Desarmar y cerrar» del mismo episodio, sin caso abierto: Cerrados", () => {
    expect(list({ latestClosed: { episode_key: EP, close_reason: "desarmar_cerrar", closed_at: "2026-10-11T20:00:00Z" } }).list).toBe("cerrados");
  });

  it("un nuevo intento (otro episodio) vuelve a «Por decidir»", () => {
    expect(list({ latestClosed: { episode_key: "s:s1|o:-", close_reason: "desarmar_cerrar", closed_at: "2026-10-11T20:00:00Z" } }).list).toBe("por_decidir");
    expect(list({ latestClosed: { episode_key: EP, close_reason: "fuera_de_etapa", closed_at: "2026-10-11T20:00:00Z" } }).list).toBe("por_decidir");
  });

  it("2. acuerdo vigente: Programados, aunque haya próxima llamada", () => {
    const r = list({
      open: open({ agreed_on: JUEVES, agreed_courier: "propio", next_call_at: limaDateTimeIso(LUNES, "15:00") }),
      state: { kind: "esperando_caja" },
    });
    expect(r).toEqual({ list: "programados", overdue: false, chips: [{ key: "toca_llamar", text: "Toca llamar · 15:00" }] });
    expect(list({ open: open({ agreed_on: JUEVES, agreed_courier: "tanders" }), state: { kind: "otro_courier" } }).list).toBe("programados");
  });

  it("3. próxima llamada futura: Llamar después, con el acuerdo anterior si quedó uno", () => {
    expect(list({ open: open({ next_call_at: limaDateTimeIso(MARTES, "08:30") }) }).list).toBe("llamar_despues");
    const r = list({
      open: open({ agreed_on: "2026-10-10", agreed_courier: "propio", next_call_at: limaDateTimeIso(MARTES, "08:30") }),
      state: { kind: "acuerdo_vencido" },
    });
    expect(r.list).toBe("llamar_despues");
    expect(r.chips).toContainEqual({ key: "acuerdo_anterior", text: "Acuerdo anterior: sáb 10/10 con Grupo GF" });
  });

  it("4. acuerdo vencido: Por decidir, vencido", () => {
    const r = list({ open: open({ agreed_on: "2026-10-10", agreed_courier: "propio" }), state: { kind: "acuerdo_vencido" } });
    expect(r.list).toBe("por_decidir");
    expect(r.overdue).toBe(true);
    expect(r.chips).toContainEqual({ key: "acuerdo_vencido", text: "Acuerdo vencido: era para el sáb 10/10" });
    // Materializado y su programa ya pasó.
    const p = list({
      open: open({ agreed_on: "2026-10-10", agreed_courier: "propio", materialized_at: "2026-10-09T15:00:00Z", materialized_on: "2026-10-10" }),
      state: { kind: "programado_vencido" },
      program: { scheduled_for: "2026-10-10", reason: "Repro Lima: confirmado con el cliente (Diana, 09/10)" },
    });
    expect(p).toMatchObject({ list: "por_decidir", overdue: true });
    // Movido por Grupo GF a un día que ya pasó: también vencido.
    const m = list({
      open: open({ agreed_on: JUEVES, agreed_courier: "propio", materialized_at: "2026-10-09T15:00:00Z", materialized_on: JUEVES }),
      state: { kind: "deriva_movido", gfDay: "2026-10-10", reason: "x" },
      program: { scheduled_for: "2026-10-10", reason: "x" },
    });
    expect(m).toMatchObject({ list: "por_decidir", overdue: true });
    // Su día todavía no llega: la chapa no dice que el acuerdo venció (F18).
    expect(m.chips).toContainEqual({ key: "acuerdo_vencido", text: "Grupo GF lo programó para el sáb 10/10 y no salió; acordado jue 15/10" });
    expect(m.chips.map((c) => c.text)).not.toContain("Acuerdo vencido: era para el jue 15/10");
  });

  it("4. un acuerdo para hoy que ya no alcanza: Por decidir, vencido, y lo dice (E25)", () => {
    const r = list({ open: open({ agreed_on: LUNES, agreed_courier: "propio" }), state: { kind: "acuerdo_vencido" } });
    expect(r).toMatchObject({ list: "por_decidir", overdue: true });
    expect(r.chips).toContainEqual({ key: "acuerdo_vencido", text: "Acuerdo vencido: era para hoy y ya no alcanza" });
  });

  it("5. programa de Grupo GF sin acuerdo: Programados", () => {
    const r = list({ program: { scheduled_for: JUEVES, reason: "Confirmado con cliente: jueves" } });
    expect(r.list).toBe("programados");
    expect(r.chips).toContainEqual({ key: "programado_gf_sin_acuerdo", text: "Programado en Grupo GF · sin acuerdo" });
  });

  it("5. el programa del motorizado (#908) va a «Por decidir» sin darlo por bueno (D9)", () => {
    const r = list({ program: { scheduled_for: MIERCOLES, reason: "Reprogramado por el cliente (reporte de la parada de Roy)" } });
    expect(r.list).toBe("por_decidir");
    expect(r.chips).toContainEqual({ key: "fecha_motorizado", text: "Fecha del motorizado sin confirmar: mié 14/10" });
  });

  it("5. un programa de Repro Lima sin acuerdo vivo (caso de otro episodio) va a «Por decidir»", () => {
    const r = list({
      open: open({ episode_key: "s:s1|o:-", agreed_on: JUEVES, agreed_courier: "propio", materialized_at: "2026-10-11T15:00:00Z", materialized_on: JUEVES }),
      state: { kind: "programado" },
      program: { scheduled_for: JUEVES, reason: "Repro Lima: confirmado con el cliente (Diana, 11/10)" },
    });
    expect(r.list).toBe("por_decidir");
    expect(r.chips).toContainEqual({ key: "programado_acuerdo_anterior", text: "Programado por un acuerdo anterior" });
  });

  it("6. una llamada que ya toca: Por decidir, vencida", () => {
    const r = list({ open: open({ next_call_at: limaDateTimeIso(LUNES, "08:30") }) });
    expect(r).toEqual({ list: "por_decidir", overdue: true, chips: [{ key: "toca_llamar", text: "Toca llamar · 08:30" }] });
    const old = list({ open: open({ next_call_at: limaDateTimeIso("2026-10-10", "15:00") }) });
    expect(old.chips).toContainEqual({ key: "toca_llamar", text: "Toca llamar · sáb 10/10 15:00" });
  });

  it("6. lo demás: Por decidir, con la fecha que pidió el cliente", () => {
    expect(list({ requestedDate: MIERCOLES })).toEqual({
      list: "por_decidir",
      overdue: false,
      chips: [{ key: "pidio", text: "Pidió mié 14/10 · sin confirmar" }],
    });
    expect(list({ requestedDate: "2026-10-10" }).chips).toEqual([{ key: "pidio", text: "Pidió sáb 10/10 · ya pasó" }]);
    // Con acuerdo vivo la fecha pedida ya no se enseña.
    expect(list({ open: open({ agreed_on: JUEVES, agreed_courier: "propio" }), state: { kind: "esperando_caja" }, requestedDate: MIERCOLES }).chips).toEqual([]);
  });
});

describe("rango y orden", () => {
  it("lastRouteDay: ayer, o el sábado si hoy es lunes", () => {
    expect(lastRouteDay(LUNES)).toBe("2026-10-10");
    expect(lastRouteDay(MARTES)).toBe(LUNES);
  });

  it("porDecidirRank", () => {
    // El lunes, el fallo del sábado es del último día de reparto.
    expect(porDecidirRank({ macroSince: "2026-10-10T20:00:00Z", today: LUNES, overdue: true })).toBe(0);
    expect(porDecidirRank({ macroSince: "2026-09-01T20:00:00Z", failedOn: "2026-10-10", today: LUNES, overdue: false })).toBe(0);
    expect(porDecidirRank({ macroSince: "2026-10-12T20:00:00Z", today: MARTES, overdue: false })).toBe(0);
    expect(porDecidirRank({ macroSince: "2026-10-09T20:00:00Z", today: LUNES, overdue: true })).toBe(1);
    expect(porDecidirRank({ macroSince: "2026-10-01T20:00:00Z", today: LUNES, overdue: false })).toBe(2);
    expect(porDecidirRank({ macroSince: "2026-10-04T20:00:00Z", today: LUNES, overdue: false })).toBe(2);
    expect(porDecidirRank({ macroSince: "2026-10-05T20:00:00Z", today: LUNES, overdue: false })).toBe(3);
    expect(porDecidirRank({ macroSince: "2026-10-09T20:00:00Z", today: LUNES, overdue: false })).toBe(3);
  });

  it("sortRepro", () => {
    const row = (name: string, extra: Partial<ReproSortable>): ReproSortable => ({
      list: "por_decidir",
      rank: 3,
      macroSince: null,
      nextCallAt: null,
      state: { kind: "sin_acuerdo" },
      agreedOn: null,
      closedAt: null,
      orderName: name,
      ...extra,
    });
    const rows = [
      row("D3-nuevo", { rank: 3, macroSince: "2026-10-08T00:00:00Z" }),
      row("D3-viejo", { rank: 3, macroSince: "2026-10-06T00:00:00Z" }),
      row("D1-nuevo", { rank: 1, macroSince: "2026-10-09T00:00:00Z" }),
      row("D1-viejo", { rank: 1, macroSince: "2026-10-01T00:00:00Z" }),
      row("D0", { rank: 0, macroSince: "2026-10-10T00:00:00Z" }),
      row("L-tarde", { list: "llamar_despues", nextCallAt: "2026-10-13T20:00:00Z" }),
      row("L-temprano", { list: "llamar_despues", nextCallAt: "2026-10-12T20:00:00Z" }),
      row("P-ok-15", { list: "programados", state: { kind: "programado" }, agreedOn: JUEVES }),
      row("P-ok-14", { list: "programados", state: { kind: "esperando_caja" }, agreedOn: MIERCOLES }),
      row("P-deriva", { list: "programados", state: { kind: "deriva_movido" }, agreedOn: "2026-10-20" }),
      row("P-otro", { list: "programados", state: { kind: "otro_courier" }, agreedOn: "2026-10-19" }),
      row("C-viejo", { list: "cerrados", closedAt: "2026-10-01T00:00:00Z" }),
      row("C-nuevo", { list: "cerrados", closedAt: "2026-10-11T00:00:00Z" }),
    ];
    expect(sortRepro(rows).map((r) => r.orderName)).toEqual([
      "D0",
      "D1-viejo",
      "D1-nuevo",
      "D3-nuevo",
      "D3-viejo",
      "L-temprano",
      "L-tarde",
      "P-otro",
      "P-deriva",
      "P-ok-14",
      "P-ok-15",
      "C-nuevo",
      "C-viejo",
    ]);
  });
});

describe("dismantleSuggested (decisión 10: sugerido, nunca automático)", () => {
  const received = "2026-10-02T15:00:00Z";
  it("3 sin respuesta y 10 días: sí", () => {
    expect(dismantleSuggested({ receivedAt: received, noAnswerCount: 3, today: LUNES })).toBe(true);
  });
  it("2 sin respuesta y 10 días: no", () => {
    expect(dismantleSuggested({ receivedAt: received, noAnswerCount: 2, today: LUNES })).toBe(false);
  });
  it("3 sin respuesta y 9 días: no", () => {
    expect(dismantleSuggested({ receivedAt: "2026-10-03T15:00:00Z", noAnswerCount: 3, today: LUNES })).toBe(false);
  });
  it("sin recepción: no", () => {
    expect(dismantleSuggested({ receivedAt: null, noAnswerCount: 5, today: LUNES })).toBe(false);
  });
});

describe("failureLine (§11.7)", () => {
  it("la parada con motivo y nota; el rechazo se marca", () => {
    expect(failureLine({ kind: "parada", riderName: "Roy", routeDate: "2026-10-10", outcomeReason: "rechazado", note: "no tenía efectivo" })).toEqual({
      text: "No entregado por Roy el sáb 10/10 · Rechazó el pedido · «no tenía efectivo»",
      rejected: true,
    });
  });

  it("sin motivo se escribe la ausencia", () => {
    expect(failureLine({ kind: "parada", riderName: "Roy", routeDate: "2026-10-10", outcomeReason: null, note: null })).toEqual({
      text: "No entregado por Roy el sáb 10/10 · sin motivo del motorizado · no consta si lo rechazó en la puerta",
      rejected: false,
    });
  });

  it("otro courier: su motivo con `.texto`, nunca «[object Object]» (E20)", () => {
    const line = failureLine({ kind: "courier", courier: "aliclik", reportedStatus: "REFUSED · RETURNED" });
    expect(line).toEqual({ text: "No entregado por Aliclik · lo rechazó en la puerta · devuelto al almacén", rejected: true });
    const aliclik = failureLine({ kind: "courier", courier: "aliclik", reportedStatus: null, failedOn: "2026-10-10" });
    expect(aliclik.text).toBe("No entregado por Aliclik el sáb 10/10 · sin motivo del courier · no consta si la rechazó en la puerta");
    expect(aliclik.text).not.toContain("[object Object]");
  });

  it("Tanders y Swayp: el día que se conoce es el de la salida, y se dice así (F17)", () => {
    const swayp = failureLine({ kind: "courier", courier: "fenix", reportedStatus: null, dispatchedOn: "2026-10-12T14:00:00Z" });
    expect(swayp.text).toBe("Salió el lun 12/10 con Swayp · sin motivo del courier · no consta si la rechazó en la puerta");
    expect(swayp.text).not.toContain("No entregado por Swayp el");
  });
});

describe("claimView", () => {
  const now = lima(LUNES, "10:00");
  it("libre, mío u otro", () => {
    expect(claimView(null, null, "me", now)).toBe("libre");
    expect(claimView("otro", limaDateTimeIso(LUNES, "09:59"), "me", now)).toBe("libre");
    expect(claimView("me", limaDateTimeIso(LUNES, "10:05"), "me", now)).toBe("mio");
    expect(claimView("diana", limaDateTimeIso(LUNES, "10:05"), "me", now)).toBe("otro");
  });
});

describe("reproEventNote", () => {
  const now = lima(LUNES, "10:00");
  it("confirma", () => {
    expect(reproEventNote({
      outcome: "confirma",
      channel: "llamada",
      agreedOn: JUEVES,
      courier: "propio",
      boxAction: "mantener",
      changes: { direccion: true },
      now,
    })).toBe("Repro Lima · Confirma (llamada): sale el jue 15/10 con Grupo GF. Caja: Mantener. Cambios: dirección.");
    expect(reproEventNote({ outcome: "confirma", channel: "whatsapp", agreedOn: JUEVES, courier: "fenix", boxAction: "salida_nueva_rearmar", changes: {}, now }))
      .toBe("Repro Lima · Confirma (WhatsApp): sale el jue 15/10 con Swayp. Caja: Salida nueva y rearmado. Sin cambios.");
  });

  it("no contesta", () => {
    expect(reproEventNote({ outcome: "no_contesta", channel: "llamada", attempt: 2, nextCallAt: limaDateTimeIso(LUNES, "15:00"), now }))
      .toBe("Repro Lima · No contesta (intento 2). Próxima: hoy 15:00.");
    expect(reproEventNote({ outcome: "no_contesta", channel: "whatsapp", attempt: 1, now })).toBe("Repro Lima · No contesta (WhatsApp, intento 1).");
  });

  it("llamar después", () => {
    expect(reproEventNote({ outcome: "llamar_despues", channel: "llamada", nextCallAt: limaDateTimeIso("2026-10-19", "15:00"), now }))
      .toBe("Repro Lima · Llamar el lun 19/10 15:00.");
    expect(reproEventNote({ outcome: "llamar_despues", channel: "llamada", nextCallAt: limaDateTimeIso(MARTES, "08:30"), note: "sale de viaje", now }))
      .toBe("Repro Lima · Llamar mañana 08:30. Nota: «sale de viaje».");
  });

  it("no quiere y «Desarmar y cerrar» sin llamada", () => {
    expect(reproEventNote({ outcome: "no_quiere", channel: "llamada", note: "ya lo compró en tienda", now }))
      .toBe("Repro Lima · No quiere: «ya lo compró en tienda». Desarmar y cerrar; no anula la venta.");
    expect(reproEventNote({ outcome: "no_quiere", channel: "sin_contacto", note: "10 días sin respuesta", now }))
      .toBe("Repro Lima · Desarmar y cerrar sin llamada: «10 días sin respuesta». No anula la venta.");
  });
});

describe("kinds del historial", () => {
  it("uno por resultado, nunca los del cupo de confirmación", () => {
    expect(reproEventKind("confirma")).toBe("lima_repro_agreed");
    expect(reproEventKind("no_quiere")).toBe("lima_repro_closed");
    expect(reproEventKind("no_contesta")).toBe("lima_repro_call");
    expect(reproEventKind("llamar_despues")).toBe("lima_repro_call");
    for (const kind of Object.values(REPRO_EVENT_KINDS)) expect(["call", "confirmation_contact", "contact_attempt"]).not.toContain(kind);
  });
});

describe("couriers y cambios", () => {
  it("Urpi no se ofrece en 1a (E16)", () => {
    expect(REPRO_COURIER_CHOICES).toEqual(["propio", "tanders", "fenix", "axel"]);
    expect(reproCourierDisabledReason("urpi")).toBe("Urpi solo lleva primeros despachos (§9.1); un reprogramado no pasa a Urpi en esta fase.");
    expect(reproCourierDisabledReason("propio")).toBeNull();
  });

  it("los nombres con la comparación canónica (swayp = fenix, motorizado propio = propio)", () => {
    expect(reproCourierName("swayp")).toBe("Swayp");
    expect(reproCourierName("Motorizado propio")).toBe("Grupo GF");
    expect(reproCourierName("axel courier")).toBe("Axel");
    expect(reproCourierName("shalom")).toBe("Shalom");
    expect(reproCourierName(null)).toBe("otro courier");
  });

  it("normalizeReproChanges solo deja las seis claves en booleano", () => {
    expect(normalizeReproChanges({ direccion: true, telefono: "sí", extra: true })).toEqual({
      direccion: true,
      telefono: false,
      monto: false,
      producto: false,
      caja_danada: false,
      no_esperar_caja: false,
    });
    expect(normalizeReproChanges(null).producto).toBe(false);
  });
});
