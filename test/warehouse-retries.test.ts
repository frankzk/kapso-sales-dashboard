// Almacén: «Reintentos por salir» (lib/warehouse-retries.ts; MOM §9.5, entrega
// 1c). La proyección pura desde las filas de Repro Lima: qué día sale, qué
// hacer con la caja (la del acuerdo, recalculada como al guardar, o la de la
// tabla sin acuerdo), las chapas, dónde está la caja, el apartado, el orden,
// las cifras, el rótulo y lo que ya está en «Por armar».

import { describe, expect, it } from "vitest";
import type { ReproRow } from "@/lib/repro-lima-access";
import {
  agreementStateLabel,
  boxLocationLabel,
  normalizeReproChanges,
  BOX_ACTION_LABEL,
  type AgreementBoxAction,
  type AgreementState,
  type BoxLocation,
  type ReproChanges,
} from "@/lib/repro-lima";
import { REPRO_NO_LO_QUIERE_CHIP } from "@/lib/repro-lima-program";
import {
  handoffLine,
  handoffSalida,
  handoffSalidaLine,
  markedAtReception,
  programmedAtReception,
  retryAction,
  retryBucket,
  retryCounts,
  retryDay,
  retryGroup,
  retryLabelsHref,
  sortHandoffs,
  sortRetries,
  warehouseHandoffRow,
  warehouseRetryRows,
  HANDOFF_LINE_CAJA_NUEVA,
  HANDOFF_LINE_DESARMAR,
  HANDOFF_LINE_GF,
  RECEPTION_PROGRAM_WINDOW_MS,
  RETRY_ADDED_LATE,
  RETRY_ADDED_TODAY,
  RETRY_ADDRESS_CHANGED,
  RETRY_ANAQUEL,
  RETRY_ANAQUEL_MOVED,
  RETRY_DEFAULT_CHIP,
  RETRY_DISMANTLE_AT_RECEPTION,
  RETRY_FACTS_CHANGED,
  RETRY_GF_STILL_LIVE,
  RETRY_NIGHT_BEFORE_HOY,
  RETRY_NIGHT_BEFORE_MANANA,
  RETRY_NO_ANAQUEL_DESARMAR,
  RETRY_NO_GF_PROGRAM,
  RETRY_NO_RECEPTION_OTHER,
  RETRY_NO_RECEPTION_OWN,
  RETRY_OTHER_SALIDA_EXISTS,
  RETRY_OVERDUE,
  RETRY_PROGRAM_NOT_AGREED,
  RETRY_TRAY,
  RETRY_TRAY_OLD,
  RETRY_UNCONFIRMED,
  type RetryContext,
  type WarehouseRetryRow,
} from "@/lib/warehouse-retries";

/** Mar 13/10 de Lima. */
const TODAY = "2026-10-13";
const TOMORROW = "2026-10-14";
const YESTERDAY = "2026-10-12";

const OWN_BOX: BoxLocation = { kind: "en_oficina", since: "2026-10-12T15:00:00Z", courier: "propio" };

type Agreement = NonNullable<ReproRow["agreement"]>;

function agreement(extra: Partial<Omit<Agreement, "changes">> & { changes?: Partial<ReproChanges> } = {}): Agreement {
  const { changes, ...rest } = extra;
  return {
    callId: "call-1",
    agreedOn: TOMORROW,
    courier: "propio",
    courierName: "Grupo GF",
    boxAction: "mantener",
    boxLocation: "en_oficina",
    decidedBy: "u-diana",
    decidedByName: "diana",
    decidedAt: "2026-10-12T20:20:00Z",
    materializedAt: null,
    materializedOn: null,
    ...rest,
    changes: normalizeReproChanges(changes ?? {}),
  };
}

function program(day: string, extra: Partial<NonNullable<ReproRow["program"]>> = {}): NonNullable<ReproRow["program"]> {
  return { scheduledFor: day, reason: "Programado por Despacho GF", origin: "grupo_gf", setAt: "2026-10-11T14:00:00Z", ...extra };
}

/**
 * Una fila de Repro Lima como la arma `buildRow`: por defecto, la caja propia
 * de Grupo GF recibida en oficina el lun 12/10, sin caso y sin programa.
 */
function reproRow(over: Partial<ReproRow> = {}): ReproRow {
  const box = over.box ?? OWN_BOX;
  const state: AgreementState = over.state ?? { kind: over.agreement ? "programado" : "sin_acuerdo" };
  const a = over.agreement ?? null;
  return {
    orderId: "o1",
    storeId: "s1",
    storeName: "Tienda",
    orderName: "#KP1",
    customerName: "Ana",
    customerPhone: "987654321",
    district: "Surco",
    orderTotal: 120,
    macroSince: "2026-10-10T20:00:00Z",
    daysInStage: 3,
    outputsUsed: 1,
    lastOutput: { code: "KP1-S01", courier: "propio", courierName: "Grupo GF" },
    failure: null,
    requestedDate: null,
    receivedAt: "2026-10-12T15:00:00Z",
    retryAdmission: false,
    episodeKey: "s:stop-1|o:-",
    episodeAt: "2026-10-10T20:00:00Z",
    caseId: a ? "case-1" : null,
    claim: { view: "libre", by: null, byName: null, until: null },
    callCount: 0,
    noAnswerCount: 0,
    lastCall: null,
    nextCallAt: null,
    plan: null,
    program: null,
    list: a ? "programados" : "por_decidir",
    rank: 3,
    overdue: false,
    chips: [],
    dismantleSuggested: false,
    closed: null,
    reopened: false,
    ownOutput: { id: "sh1", code: "KP1-S01" },
    boxInputs: {
      ownLiveCourier: "propio",
      lastFailedCourier: null,
      otherLiveCourier: null,
      hadPropio: true,
      totalOutputs: 1,
      priorByCourier: { propio: 1, tanders: 0, fenix: 0, urpi: 0, axel: 0 },
      ownReplace: null,
    },
    cutoff: "12:00:00",
    agreedOn: a?.agreedOn ?? null,
    programDay: over.program?.scheduledFor ?? null,
    closedAt: null,
    ...over,
    box,
    state,
    agreement: a,
    boxLabel: over.boxLabel ?? boxLocationLabel(box),
    stateLabel: over.stateLabel ?? agreementStateLabel(state, a ? { agreed_on: a.agreedOn, agreed_courier: a.courier } : null, box, TODAY),
  };
}

const CTX: RetryContext = { today: TODAY, cutoffMinute: 12 * 60, ownShipments: new Map() };

function project(rows: ReproRow[], ctx: Partial<RetryContext> = {}): WarehouseRetryRow[] {
  return warehouseRetryRows(rows, { ...CTX, ...ctx });
}

function one(row: ReproRow, ctx: Partial<RetryContext> = {}): WarehouseRetryRow {
  const out = project([row], ctx);
  expect(out).toHaveLength(1);
  return out[0]!;
}

const texts = (row: WarehouseRetryRow) => row.chips.map((chip) => chip.text);

describe("qué día sale", () => {
  it("el programa de Grupo GF gana al acuerdo", () => {
    const row = one(reproRow({ agreement: agreement({ agreedOn: TOMORROW }), program: program(TODAY) }));
    expect(row).toMatchObject({ day: TODAY, dayFrom: "programa", bucket: "hoy", overdue: false });
  });

  it("si Grupo GF movió el día, manda el suyo y la fila lo dice (el caso no cambia)", () => {
    const state: AgreementState = { kind: "deriva_movido", gfDay: TODAY, reason: "Cliente pidió hoy" };
    const r = reproRow({
      agreement: agreement({ agreedOn: TOMORROW, materializedAt: "2026-10-12T20:20:00Z", materializedOn: TOMORROW }),
      program: program(TODAY, { reason: "Cliente pidió hoy" }),
      state,
    });
    const row = one(r);
    expect(row).toMatchObject({ day: TODAY, dayFrom: "programa", bucket: "hoy" });
    expect(row.chips).toContainEqual({ tone: "info", text: "Grupo GF lo movió al mar 13/10 («Cliente pidió hoy»)" });
    expect(r.agreement!.agreedOn).toBe(TOMORROW);
  });

  it("un acuerdo sin programa sale su día, con «Sin programa en Grupo GF» y su estado", () => {
    const row = one(reproRow({
      agreement: agreement({ agreedOn: TOMORROW }),
      state: { kind: "por_programar" },
    }));
    expect(row).toMatchObject({ day: TOMORROW, dayFrom: "acuerdo", bucket: "manana" });
    expect(row.chips).toContainEqual({ tone: "warn", text: RETRY_NO_GF_PROGRAM });
    expect(row.chips).toContainEqual({ tone: "warn", text: "Sale mié 14/10 con Grupo GF · falta programarlo" });
  });

  it("esperando la caja: el estado va en azul, no es un problema", () => {
    const row = one(reproRow({
      box: { kind: "con_motorizado", riderName: "Roy", since: YESTERDAY },
      agreement: agreement({ agreedOn: TOMORROW }),
      state: { kind: "esperando_caja" },
    }));
    expect(row.chips).toContainEqual({ tone: "info", text: "Sale mié 14/10 con Grupo GF · esperando la caja" });
    expect(row.group).toBe("fuera");
  });

  it("sin programa ni acuerdo no hay fecha: la caja se queda en el estante", () => {
    expect(project([reproRow()])).toEqual([]);
    expect(retryDay(reproRow())).toBeNull();
  });

  it("un acuerdo vencido sin programa vuelve a «Por decidir»: no se lista", () => {
    const r = reproRow({
      agreement: agreement({ agreedOn: YESTERDAY }),
      state: { kind: "acuerdo_vencido" },
      list: "por_decidir",
      overdue: true,
    });
    expect(project([r])).toEqual([]);
  });

  it("un «Desarmar y cerrar» sin programa no sale", () => {
    const r = reproRow({ list: "cerrados", closed: { caseId: "case-0", at: "2026-10-12T16:00:00Z", byName: "diana", note: null } });
    expect(project([r])).toEqual([]);
  });

  describe("un programa que no es el del acuerdo (el acuerdo no se programó)", () => {
    /** Tanders, jue 15/10, «Salida nueva y rearmado»: al guardarlo se quitó el programa; Despacho GF lo programó después. */
    const tanders = (prog: NonNullable<ReproRow["program"]>) => reproRow({
      agreement: agreement({ agreedOn: "2026-10-15", courier: "tanders", courierName: "Tanders", boxAction: "salida_nueva_rearmar" }),
      state: { kind: "otro_courier" },
      program: prog,
    });

    it("manda el día del programa y la fila dice el estado y lo acordado; no «prepárala ya»", () => {
      const row = one(tanders(program(TODAY, { setAt: "2026-10-13T14:00:00Z" })));
      expect(row).toMatchObject({ bucket: "hoy", day: TODAY, dayFrom: "programa", courierName: "Tanders", actionSource: "acuerdo", group: "con_aviso" });
      expect(row.chips).toContainEqual({ tone: "warn", text: "Sale jue 15/10 con Tanders · crea la salida en la Mesa de ruta" });
      expect(row.chips).toContainEqual({ tone: "warn", text: RETRY_PROGRAM_NOT_AGREED("mar 13/10", "jue 15/10", "Tanders") });
      expect(texts(row)).toContain("Grupo GF lo programó para el mar 13/10; acordado jue 15/10 con Tanders");
      expect(row.chips).toContainEqual({ tone: "info", text: RETRY_ADDED_TODAY("09:00") });
      expect(texts(row)).not.toContain(RETRY_NIGHT_BEFORE_HOY);
    });

    it("para mañana, igual (la noche anterior se sigue diciendo)", () => {
      const row = one(tanders(program(TOMORROW)));
      expect(row).toMatchObject({ bucket: "manana", dayLabel: "mié 14/10", group: "con_aviso" });
      expect(row.chips).toContainEqual({ tone: "warn", text: "Sale jue 15/10 con Tanders · crea la salida en la Mesa de ruta" });
      expect(row.chips).toContainEqual({ tone: "warn", text: RETRY_PROGRAM_NOT_AGREED("mié 14/10", "jue 15/10", "Tanders") });
      expect(row.chips).toContainEqual({ tone: "warn", text: RETRY_NIGHT_BEFORE_MANANA });
    });

    it("falta la salida nueva: el estado y el día acordado", () => {
      const row = one(reproRow({
        agreement: agreement({ agreedOn: "2026-10-15", boxAction: "desarmar_rearmar", changes: { producto: true } }),
        state: { kind: "falta_salida" },
        program: program(TODAY),
      }));
      expect(row.group).toBe("con_aviso");
      expect(row.chips).toContainEqual({ tone: "warn", text: "Falta la salida nueva" });
      expect(row.chips).toContainEqual({ tone: "warn", text: RETRY_PROGRAM_NOT_AGREED("mar 13/10", "jue 15/10", "Grupo GF") });
    });

    it("el mismo día y con Grupo GF no difiere: solo el estado que la deja «Con aviso»", () => {
      const row = one(reproRow({ agreement: agreement({ agreedOn: TODAY }), state: { kind: "por_programar" }, program: program(TODAY) }));
      expect(row.group).toBe("con_aviso");
      expect(row.chips).toContainEqual({ tone: "warn", text: "Sale mar 13/10 con Grupo GF · falta programarlo" });
      expect(texts(row).some((text) => text.startsWith("Grupo GF lo programó para el"))).toBe(false);
    });

    it("el programa del acuerdo (con su marca) no se compara: si Grupo GF lo movió, lo dice la deriva", () => {
      const row = one(reproRow({
        agreement: agreement({ agreedOn: TOMORROW, materializedAt: "2026-10-12T20:20:00Z", materializedOn: TOMORROW }),
        program: program(TODAY, { reason: "Cliente pidió hoy" }),
        state: { kind: "deriva_movido", gfDay: TODAY, reason: "Cliente pidió hoy" },
      }));
      expect(texts(row).some((text) => text.startsWith("Grupo GF lo programó para el"))).toBe(false);
      expect(row.chips).toContainEqual({ tone: "info", text: "Grupo GF lo movió al mar 13/10 («Cliente pidió hoy»)" });
    });
  });
});

describe("hoy y mañana", () => {
  it("un día pasado va a «Hoy», vencido", () => {
    expect(retryBucket(YESTERDAY, TODAY)).toEqual({ bucket: "hoy", overdue: true });
    const row = one(reproRow({ program: program(YESTERDAY) }));
    expect(row).toMatchObject({ bucket: "hoy", overdue: true, dayLabel: "lun 12/10" });
    expect(row.chips[0]).toEqual({ tone: "crit", text: RETRY_OVERDUE("lun 12/10") });
  });

  it("hoy va a «Hoy», mañana a «Mañana» y pasado mañana no se lista", () => {
    expect(retryBucket(TODAY, TODAY)).toEqual({ bucket: "hoy", overdue: false });
    expect(retryBucket(TOMORROW, TODAY)).toEqual({ bucket: "manana", overdue: false });
    expect(retryBucket("2026-10-15", TODAY)).toBeNull();
    expect(project([reproRow({ program: program("2026-10-15") })])).toEqual([]);
  });

  it("el sábado, «Mañana» es el domingo (día del calendario, como Despacho)", () => {
    expect(retryBucket("2026-10-18", "2026-10-17")).toEqual({ bucket: "manana", overdue: false });
    expect(retryBucket("2026-10-19", "2026-10-17")).toBeNull();
  });
});

describe("la acción guardada en el acuerdo", () => {
  it("si con los hechos de ahora sale la misma, dice su línea", () => {
    const row = one(reproRow({ agreement: agreement({ boxAction: "mantener", changes: { telefono: true } }) }));
    expect(row).toMatchObject({
      action: "mantener",
      actionSource: "acuerdo",
      actionLine: "Mantener la caja: misma salida, QR y rótulo. El teléfono nuevo se anota en la ficha y se le pasa al motorizado (§9.5, paso 4).",
      changesText: "teléfono",
      decidedLine: "Decidió diana 12/10 15:20",
      courierName: "Grupo GF",
      group: "anaquel",
    });
    expect(texts(row)).not.toContain(RETRY_FACTS_CHANGED);
  });

  it("si ahora sale otra, conserva la guardada y avisa que los hechos cambiaron", () => {
    // Se guardó «Mantener» con la salida propia viva; ya no hay salida propia.
    const r = reproRow({ agreement: agreement({ boxAction: "mantener" }) });
    r.boxInputs = { ...r.boxInputs, ownLiveCourier: null };
    const row = one(r);
    expect(row).toMatchObject({ action: "mantener", actionSource: "acuerdo", actionLine: BOX_ACTION_LABEL.mantener, group: "con_aviso" });
    expect(row.chips).toContainEqual({ tone: "crit", text: RETRY_FACTS_CHANGED });
  });

  it("un problema de la tabla con los hechos de ahora también es «los hechos cambiaron»", () => {
    const r = reproRow({ agreement: agreement({ boxAction: "salida_nueva_rearmar" }) });
    r.boxInputs = { ...r.boxInputs, ownLiveCourier: null, totalOutputs: 5 };
    const row = one(r);
    expect(row).toMatchObject({ action: "salida_nueva_rearmar", actionLine: BOX_ACTION_LABEL.salida_nueva_rearmar, group: "con_aviso" });
    expect(row.chips).toContainEqual({ tone: "crit", text: RETRY_FACTS_CHANGED });
  });

  it("la salida del otro courier acordado ya existe: no es deriva, es la laguna 1 de 1a", () => {
    const r = reproRow({
      agreement: agreement({ courier: "tanders", courierName: "Tanders", boxAction: "salida_nueva_rearmar", agreedOn: TODAY }),
      state: { kind: "otro_courier" },
    });
    r.boxInputs = { ...r.boxInputs, otherLiveCourier: "tanders" };
    const row = one(r);
    expect(row).toMatchObject({
      action: "salida_nueva_rearmar",
      actionSource: "acuerdo",
      actionLine: RETRY_OTHER_SALIDA_EXISTS("Tanders"),
      courierName: "Tanders",
      dayFrom: "acuerdo",
      group: "con_aviso",
    });
    expect(row.chips).toContainEqual({ tone: "warn", text: RETRY_GF_STILL_LIVE });
    expect(texts(row)).not.toContain(RETRY_FACTS_CHANGED);
  });

  it("otra guía viva de un courier distinto del acordado sí es «los hechos cambiaron»", () => {
    const r = reproRow({
      agreement: agreement({ courier: "fenix", courierName: "Swayp", boxAction: "salida_nueva_rearmar" }),
      state: { kind: "otro_courier" },
    });
    r.boxInputs = { ...r.boxInputs, otherLiveCourier: "tanders" };
    const row = one(r);
    expect(row.chips).toContainEqual({ tone: "crit", text: RETRY_FACTS_CHANGED });
    expect(texts(row)).not.toContain(RETRY_GF_STILL_LIVE);
  });
});

describe("sin acuerdo de Repro Lima: la acción por defecto (decisión 1)", () => {
  it("con la salida propia viva, «Mantener», marcada «Por defecto»", () => {
    const row = one(reproRow({
      program: program(TODAY),
      list: "programados",
      chips: [{ key: "programado_gf_sin_acuerdo", text: "Programado en Grupo GF · sin acuerdo" }],
    }));
    expect(row).toMatchObject({
      action: "mantener",
      actionSource: "por_defecto",
      actionLine: "Mantener la caja: misma salida, QR y rótulo.",
      programReason: "Programado por Despacho GF",
      courierName: "Grupo GF",
      group: "anaquel",
    });
    expect(row.chips).toContainEqual({ tone: "neutral", text: RETRY_DEFAULT_CHIP });
    expect(row.chips).toContainEqual({ tone: "info", text: "Programado en Grupo GF · sin acuerdo" });
    expect(texts(row)).not.toContain(RETRY_UNCONFIRMED);
  });

  it("un reintento de otro courier: «Salida nueva y rearmado»", () => {
    const r = reproRow({
      program: program(YESTERDAY),
      list: "programados",
      retryAdmission: true,
      box: { kind: "volviendo_courier", courier: "tanders" },
      ownOutput: null,
      receivedAt: null,
    });
    r.boxInputs = { ...r.boxInputs, ownLiveCourier: null, lastFailedCourier: "tanders", hadPropio: false, priorByCourier: { propio: 0, tanders: 1, fenix: 0, urpi: 0, axel: 0 } };
    const row = one(r);
    expect(row).toMatchObject({ action: "salida_nueva_rearmar", actionSource: "por_defecto", nightBefore: true, group: "fuera", whereLine: null, inOffice: false });
    expect(row.actionLine).toBe("Salida nueva de Grupo GF: el rótulo nuevo va encima del anterior, tapando su QR (§9.3).");
    expect(row.boxLabel).toBe("Vuelve con Tanders");
  });

  it("con un problema no hay chapa de acción: la línea es el problema", () => {
    const r = reproRow({ program: program(TODAY), list: "programados" });
    r.boxInputs = { ...r.boxInputs, otherLiveCourier: "aliclik" };
    const row = one(r);
    expect(row).toMatchObject({ action: null, actionSource: null, group: "con_aviso", nightBefore: false });
    expect(row.actionLine).toMatch(/sigue viva: la trabaja ese courier/);
    expect(texts(row)).not.toContain(RETRY_DEFAULT_CHIP);
  });

  it("la fecha del motorizado o de un acuerdo anterior no va al anaquel hasta que Repro Lima la confirme", () => {
    const rider = one(reproRow({
      program: program(TODAY, { reason: "Reprogramado por el cliente (reporte de la parada de Roy)", origin: "motorizado" }),
      chips: [{ key: "fecha_motorizado", text: "Fecha del motorizado sin confirmar: mar 13/10" }],
    }));
    expect(rider.chips).toContainEqual({ tone: "warn", text: "Fecha del motorizado sin confirmar: mar 13/10" });
    expect(rider.chips).toContainEqual({ tone: "warn", text: RETRY_UNCONFIRMED });
    expect(rider).toMatchObject({ action: "mantener", actionSource: "por_defecto", group: "con_aviso" });
    expect(rider.programReason).toBe("Reprogramado por el cliente (reporte de la parada de Roy)");

    const earlier = one(reproRow({
      program: program(TODAY, { reason: "Repro Lima: confirmado con el cliente (diana, 10/10)", origin: "repro_lima" }),
      chips: [{ key: "programado_acuerdo_anterior", text: "Programado por un acuerdo anterior" }],
    }));
    expect(earlier.chips).toContainEqual({ tone: "warn", text: "Programado por un acuerdo anterior" });
    expect(earlier.chips).toContainEqual({ tone: "warn", text: RETRY_UNCONFIRMED });
    expect(earlier.group).toBe("con_aviso");
  });

  it("con la caja del motorizado, la fecha sin confirmar sigue en «Todavía fuera»", () => {
    const row = one(reproRow({
      box: { kind: "con_motorizado", riderName: "Roy", since: YESTERDAY },
      receivedAt: null,
      program: program(YESTERDAY, { reason: "Reprogramado por el cliente (reporte de la parada de Roy)", origin: "motorizado" }),
    }));
    expect(row).toMatchObject({ group: "fuera", action: "mantener", boxLabel: "Con Roy desde lun 12/10", whereLine: null });
    expect(row.chips).toContainEqual({ tone: "warn", text: RETRY_UNCONFIRMED });
  });

  describe("un acuerdo vencido con programa no manda: cuenta como sin acuerdo vigente", () => {
    /** «Mantener» con Grupo GF, al recibir; nunca se programó y la caja llegó tarde. */
    const expired = (agreedOn: string, prog: NonNullable<ReproRow["program"]>, over: Partial<ReproRow> = {}) => reproRow({
      agreement: agreement({ agreedOn, boxAction: "mantener", decidedAt: "2026-10-11T20:20:00Z" }),
      state: { kind: "acuerdo_vencido" },
      list: "por_decidir",
      overdue: true,
      chips: [{ key: "acuerdo_vencido", text: `Acuerdo vencido: era para el ${agreedOn === YESTERDAY ? "lun 12/10" : "mar 13/10"}` }],
      program: prog,
      receivedAt: "2026-10-13T14:00:00Z",
      box: { kind: "en_oficina", since: "2026-10-13T14:00:00Z", courier: "propio" },
      ...over,
    });
    const RIDER = { reason: "Reprogramado por el cliente (reporte de la parada de Roy)", origin: "motorizado" as const, setAt: "2026-10-11T22:00:00Z" };

    it("la fecha del motorizado: por defecto, «No va al anaquel…» y el acuerdo vencido, «Con aviso»", () => {
      const row = one(expired(YESTERDAY, program(YESTERDAY, RIDER)));
      expect(row).toMatchObject({
        bucket: "hoy",
        overdue: true,
        action: "mantener",
        actionSource: "por_defecto",
        decidedLine: null,
        changesText: null,
        programReason: RIDER.reason,
        group: "con_aviso",
      });
      expect(row.chips).toContainEqual({ tone: "neutral", text: RETRY_DEFAULT_CHIP });
      expect(row.chips).toContainEqual({ tone: "warn", text: RETRY_UNCONFIRMED });
      expect(row.chips).toContainEqual({ tone: "warn", text: "El acuerdo era para el lun 12/10 y ya pasó: confírmalo de nuevo" });
      // No es un programa que difiera de un acuerdo vigente.
      expect(texts(row).some((text) => text.startsWith("Grupo GF lo programó para el"))).toBe(false);
      // Igual que la misma fila sin caso, más el aviso del vencido.
      const bare = one(expired(YESTERDAY, program(YESTERDAY, RIDER), { agreement: null, state: { kind: "sin_acuerdo" }, chips: [] }));
      expect(bare).toMatchObject({ action: row.action, actionSource: row.actionSource, group: row.group });
    });

    it("el mismo día, llegada después del corte (E25): igual, con «ya no alcanza»", () => {
      const row = one(expired(TODAY, program(TODAY, RIDER)));
      expect(row).toMatchObject({ bucket: "hoy", overdue: false, actionSource: "por_defecto", group: "con_aviso" });
      expect(row.chips).toContainEqual({ tone: "warn", text: RETRY_UNCONFIRMED });
      expect(row.chips).toContainEqual({ tone: "warn", text: "El acuerdo era para hoy (mar 13/10) y ya no alcanza: confírmalo de nuevo" });
    });

    it("la fecha de un acuerdo anterior: también sin confirmar", () => {
      const row = one(expired(YESTERDAY, program(YESTERDAY, { reason: "Repro Lima: confirmado con el cliente (diana, 09/10)", origin: "repro_lima" })));
      expect(row).toMatchObject({ actionSource: "por_defecto", group: "con_aviso" });
      expect(row.chips).toContainEqual({ tone: "warn", text: RETRY_UNCONFIRMED });
    });

    it("con el programa de Grupo GF: por defecto, sin «No va al anaquel…», y el aviso del vencido", () => {
      const row = one(expired(YESTERDAY, program(YESTERDAY)));
      expect(row).toMatchObject({ actionSource: "por_defecto", group: "anaquel" });
      expect(texts(row)).not.toContain(RETRY_UNCONFIRMED);
      expect(row.chips).toContainEqual({ tone: "warn", text: "El acuerdo era para el lun 12/10 y ya pasó: confírmalo de nuevo" });
    });

    it("lo programado por el acuerdo que no salió sigue siendo suyo (`programado_vencido`)", () => {
      const row = one(reproRow({
        agreement: agreement({ agreedOn: YESTERDAY, materializedAt: "2026-10-11T20:20:05Z", materializedOn: YESTERDAY }),
        state: { kind: "programado_vencido" },
        list: "por_decidir",
        program: program(YESTERDAY, { reason: "Repro Lima: diana acordó con el cliente (11/10)", origin: "repro_lima" }),
      }));
      expect(row).toMatchObject({ action: "mantener", actionSource: "acuerdo", group: "anaquel" });
      expect(row.chips).toContainEqual({ tone: "info", text: "Programado para el lun 12/10 y no salió" });
      expect(texts(row)).not.toContain(RETRY_UNCONFIRMED);
    });
  });

  it("otras chapas de la lista (la llamada, la fecha pedida) no pasan", () => {
    const row = one(reproRow({
      program: program(TODAY),
      list: "programados",
      chips: [{ key: "toca_llamar", text: "Toca llamar · 15:00" }, { key: "pidio", text: "Pidió mar 13/10 · sin confirmar" }],
    }));
    expect(texts(row)).not.toContain("Toca llamar · 15:00");
    expect(texts(row)).not.toContain("Pidió mar 13/10 · sin confirmar");
  });
});

describe("«Repro Lima: no lo quiere» y Grupo GF lo programó igual", () => {
  it("se desarma y no va al anaquel: avisa a Despacho GF", () => {
    const row = one(reproRow({
      list: "cerrados",
      closed: { caseId: "case-0", at: "2026-10-12T16:00:00Z", byName: "diana", note: null },
      program: program(TODAY),
      receivedAt: "2026-10-12T15:00:00Z",
    }));
    expect(row).toMatchObject({
      action: "desarmar_cerrar",
      actionSource: "cerrado",
      actionLine: "Almacén la desarma cuando esté en oficina (cuaderno «DESARMAR»). No anula la venta.",
      group: "con_aviso",
      nightBefore: false,
      label: null,
    });
    expect(row.chips).toContainEqual({ tone: "crit", text: REPRO_NO_LO_QUIERE_CHIP });
    expect(row.chips).toContainEqual({ tone: "crit", text: RETRY_NO_ANAQUEL_DESARMAR });
    expect(row.whereLine).not.toBe(RETRY_ANAQUEL("mar 13/10"));
  });
});

describe("lo que se prepara la noche anterior", () => {
  const actions: AgreementBoxAction[] = ["mantener", "reimprimir_misma_salida", "salida_nueva_rearmar", "desarmar_rearmar", "caja_nueva_stock"];

  it("en «Mañana», exactamente reimprimir, salida nueva y desarmar y rearmar", () => {
    const flagged = actions.filter((boxAction) => {
      const row = one(reproRow({ agreement: agreement({ boxAction, agreedOn: TOMORROW }), program: program(TOMORROW) }));
      expect(row.nightBefore).toBe(texts(row).includes(RETRY_NIGHT_BEFORE_MANANA));
      return row.nightBefore;
    });
    expect(flagged).toEqual(["reimprimir_misma_salida", "salida_nueva_rearmar", "desarmar_rearmar"]);
    const closed = one(reproRow({ list: "cerrados", program: program(TOMORROW) }));
    expect(closed.nightBefore).toBe(false);
  });

  it("en «Hoy», solo si se agregó hoy: prepárala ya", () => {
    // El programa es el del acuerdo: Repro Lima lo programó (su marca).
    const own = { boxAction: "desarmar_rearmar" as const, changes: { producto: true }, agreedOn: TODAY, materializedAt: "2026-10-13T14:30:00Z", materializedOn: TODAY };
    const early = one(reproRow({ agreement: agreement(own), program: program(TODAY) }));
    expect(texts(early)).not.toContain(RETRY_NIGHT_BEFORE_HOY);
    const late = one(reproRow({ agreement: agreement(own), program: program(TODAY, { setAt: "2026-10-13T14:30:00Z" }) }));
    expect(late.chips).toContainEqual({ tone: "warn", text: RETRY_NIGHT_BEFORE_HOY });
  });

  it("el programa de otro (el acuerdo no se programó) no la prepara ya", () => {
    // «Desarmar y rearmar» sin su salida nueva; Grupo GF lo programó hoy igual.
    const row = one(reproRow({
      agreement: agreement({ boxAction: "desarmar_rearmar", changes: { producto: true }, agreedOn: TODAY }),
      program: program(TODAY, { setAt: "2026-10-13T14:30:00Z" }),
      state: { kind: "falta_salida" },
    }));
    expect(row.nightBefore).toBe(true);
    expect(texts(row)).not.toContain(RETRY_NIGHT_BEFORE_HOY);
    expect(row.chips).toContainEqual({ tone: "warn", text: "Falta la salida nueva" });
    expect(row.group).toBe("con_aviso");
  });
});

describe("«Agregado hoy»", () => {
  it("antes del corte, en azul", () => {
    const row = one(reproRow({ program: program(TODAY, { setAt: "2026-10-13T16:30:00Z" }) }));
    expect(row.chips).toContainEqual({ tone: "info", text: RETRY_ADDED_TODAY("11:30") });
  });

  it("después del corte del proveedor de la fila, en ámbar (sale igual hoy)", () => {
    const late = one(reproRow({ program: program(TODAY, { setAt: "2026-10-13T17:40:00Z" }) }));
    expect(late.chips).toContainEqual({ tone: "warn", text: RETRY_ADDED_LATE("12:40") });
    expect(texts(late)).not.toContain(RETRY_ADDED_TODAY("12:40"));
    // El corte sale de la fila (su proveedor), no del de la cabecera.
    const laterCutoff = one(reproRow({ cutoff: "13:00:00", program: program(TODAY, { setAt: "2026-10-13T17:40:00Z" }) }));
    expect(laterCutoff.chips).toContainEqual({ tone: "info", text: RETRY_ADDED_TODAY("12:40") });
  });

  it("para mañana no hay «después del corte»; ayer no es hoy", () => {
    const tomorrow = one(reproRow({ program: program(TOMORROW, { setAt: "2026-10-13T22:00:00Z" }) }));
    expect(tomorrow.chips).toContainEqual({ tone: "info", text: RETRY_ADDED_TODAY("17:00") });
    const old = one(reproRow({ program: program(TODAY, { setAt: "2026-10-12T22:00:00Z" }) }));
    expect(texts(old).some((text) => text.startsWith("Agregado hoy"))).toBe(false);
  });

  it("también cuenta el acuerdo decidido hoy", () => {
    const row = one(reproRow({ agreement: agreement({ agreedOn: TOMORROW, decidedAt: "2026-10-13T15:05:00Z" }), state: { kind: "por_programar" } }));
    expect(row.chips).toContainEqual({ tone: "info", text: RETRY_ADDED_TODAY("10:05") });
  });
});

describe("la recepción en oficina", () => {
  it("la caja propia sin recepción registrada: búscala en el estante", () => {
    const row = one(reproRow({ program: program(TODAY), receivedAt: null, box: { kind: "en_oficina", since: null, courier: "propio" } }));
    expect(row.chips).toContainEqual({ tone: "warn", text: RETRY_NO_RECEPTION_OWN });
    expect(row).toMatchObject({ group: "con_aviso", whereLine: RETRY_TRAY_OLD, inOffice: true });
  });

  it("la de otro courier que la da por devuelta sin escaneo en Devoluciones", () => {
    const r = reproRow({
      program: program(TODAY),
      receivedAt: null,
      retryAdmission: true,
      box: { kind: "en_oficina", since: "2026-10-12T15:00:00Z", courier: "tanders" },
      ownOutput: null,
    });
    r.boxInputs = { ...r.boxInputs, ownLiveCourier: null, lastFailedCourier: "tanders" };
    const row = one(r);
    expect(row.chips).toContainEqual({ tone: "warn", text: RETRY_NO_RECEPTION_OTHER("Tanders") });
    expect(texts(row)).not.toContain(RETRY_NO_RECEPTION_OWN);
    expect(row.group).toBe("con_aviso");
  });

  it("recibida: no avisa", () => {
    const row = one(reproRow({ program: program(TODAY) }));
    expect(texts(row)).not.toContain(RETRY_NO_RECEPTION_OWN);
  });
});

describe("la dirección cambió después de armar", () => {
  const changed = new Map([["sh1", { addressUpdatedAt: "2026-10-12T21:00:00Z", readyAt: "2026-10-09T15:00:00Z" }]]);

  it("se dice, en ámbar; la acción no cambia", () => {
    const row = one(reproRow({ program: program(TODAY) }), { ownShipments: changed });
    expect(row.chips).toContainEqual({ tone: "warn", text: RETRY_ADDRESS_CHANGED("12/10") });
    expect(row).toMatchObject({ action: "mantener", group: "con_aviso" });
  });

  it("con «Reimprimir» no se dice: el rótulo se reimprime", () => {
    const row = one(reproRow({ agreement: agreement({ boxAction: "reimprimir_misma_salida", changes: { direccion: true } }) }), { ownShipments: changed });
    expect(texts(row).some((text) => text.startsWith("La dirección cambió"))).toBe(false);
  });

  it("antes de armar, o sin armado, no", () => {
    const before = new Map([["sh1", { addressUpdatedAt: "2026-10-08T21:00:00Z", readyAt: "2026-10-09T15:00:00Z" }]]);
    const unarmed = new Map([["sh1", { addressUpdatedAt: "2026-10-12T21:00:00Z", readyAt: null }]]);
    for (const ownShipments of [before, unarmed]) {
      const row = one(reproRow({ program: program(TODAY) }), { ownShipments });
      expect(texts(row).some((text) => text.startsWith("La dirección cambió"))).toBe(false);
    }
  });
});

describe("dónde está la caja en oficina", () => {
  it("recibida después de programarla: en el anaquel de su día", () => {
    const row = one(reproRow({ program: program(TODAY, { setAt: "2026-10-11T14:00:00Z" }), receivedAt: "2026-10-12T15:00:00Z" }));
    expect(row.whereLine).toBe(RETRY_ANAQUEL("mar 13/10"));
  });

  it("recibida antes de programarla: en la bandeja del día en que se recibió", () => {
    const row = one(reproRow({ program: program(TODAY, { setAt: "2026-10-12T20:00:00Z" }), receivedAt: "2026-10-12T15:00:00Z" }));
    expect(row.whereLine).toBe(RETRY_TRAY("lun 12/10"));
  });

  it("recibida hace más de 7 días: la bandeja «sin fecha / más de 7 días»", () => {
    const row = one(reproRow({
      program: program(TODAY, { setAt: "2026-10-12T20:00:00Z" }),
      receivedAt: "2026-10-03T15:00:00Z",
      box: { kind: "en_oficina", since: "2026-10-03T15:00:00Z", courier: "propio" },
    }));
    expect(row.whereLine).toBe(RETRY_TRAY_OLD);
    expect(row.boxLabel).toBe("En oficina desde sáb 03/10");
  });

  it("fuera de la oficina no hay línea", () => {
    const row = one(reproRow({ program: program(TODAY), box: { kind: "volviendo_courier", courier: "fenix" } }));
    expect(row.whereLine).toBeNull();
  });

  describe("la recepción misma escribió el programa (gancho de «Recibir en oficina»)", () => {
    const RECEIVED = "2026-10-12T15:00:00.000Z";
    const REPRO_REASON = "Repro Lima: diana acordó con el cliente (12/10)";
    /** El acuerdo «Mantener» que esperaba la caja, programado al recibirla. */
    const received = (setAt: string, extra: Partial<NonNullable<ReproRow["program"]>> = {}, over: Partial<ReproRow> = {}) =>
      reproRow({
        agreement: agreement({ agreedOn: TODAY, materializedAt: setAt, materializedOn: TODAY }),
        program: program(TODAY, { reason: REPRO_REASON, origin: "repro_lima", setAt, ...extra }),
        receivedAt: RECEIVED,
        box: { kind: "en_oficina", since: RECEIVED, courier: "propio" },
        ...over,
      });

    it("milisegundos o segundos después de la recepción: en el anaquel de su día", () => {
      for (const setAt of ["2026-10-12T15:00:00.180Z", "2026-10-12T15:00:04.000Z", "2026-10-12T15:01:30.000Z"]) {
        const row = one(received(setAt));
        expect(row.whereLine, setAt).toBe(RETRY_ANAQUEL("mar 13/10"));
        expect(row.actionSource, setAt).toBe("acuerdo");
      }
    });

    it("hasta 2 minutos justos; después, en la bandeja del día en que se recibió", () => {
      expect(programmedAtReception({ origin: "repro_lima", setAt: "2026-10-12T15:02:00.000Z" }, RECEIVED)).toBe(true);
      expect(programmedAtReception({ origin: "repro_lima", setAt: "2026-10-12T15:02:00.001Z" }, RECEIVED)).toBe(false);
      expect(RECEPTION_PROGRAM_WINDOW_MS).toBe(120_000);
      expect(one(received("2026-10-12T15:02:01.000Z")).whereLine).toBe(RETRY_TRAY("lun 12/10"));
    });

    it("una confirmación posterior (horas después) no la manda al anaquel: marca y programa son de esa hora", () => {
      const row = one(received("2026-10-12T19:30:00.000Z"));
      expect(row.whereLine).toBe(RETRY_TRAY("lun 12/10"));
      expect(markedAtReception({ materializedAt: "2026-10-12T19:30:00.000Z" }, RECEIVED)).toBe(false);
    });

    it("si Grupo GF reescribe después el programa de la recepción, sigue en el anaquel: lo dice la marca del acuerdo", () => {
      const MARK = "2026-10-12T15:00:00.100Z";
      // «Programar» de Despacho GF el mismo día: el programa es suyo y de después; la marca es la de la recepción.
      const sameDay = one(received("2026-10-12T19:30:00.000Z", { reason: "Programado por Despacho GF", origin: "grupo_gf" }, {
        agreement: agreement({ agreedOn: TODAY, materializedAt: MARK, materializedOn: TODAY }),
      }));
      expect(sameDay.whereLine).toBe(RETRY_ANAQUEL("mar 13/10"));
      // Lo movió a otro día (`deriva_movido`): la caja está en el anaquel del día marcado y se pasa al del programa.
      const moved = one(reproRow({
        agreement: agreement({ agreedOn: TOMORROW, materializedAt: MARK, materializedOn: TOMORROW }),
        program: program(TODAY, { reason: "Cliente pidió hoy", origin: "grupo_gf", setAt: "2026-10-13T13:00:00.000Z" }),
        state: { kind: "deriva_movido", gfDay: TODAY, reason: "Cliente pidió hoy" },
        receivedAt: RECEIVED,
        box: { kind: "en_oficina", since: RECEIVED, courier: "propio" },
      }));
      expect(moved).toMatchObject({ bucket: "hoy", group: "anaquel", whereLine: RETRY_ANAQUEL_MOVED("mié 14/10", "mar 13/10") });
      expect(moved.whereLine).toBe("Debería estar en el anaquel del mié 14/10: pásala al del mar 13/10");
      expect(moved.chips).toContainEqual({ tone: "info", text: "Grupo GF lo movió al mar 13/10 («Cliente pidió hoy»)" });
      // Grupo GF quitó la fecha: sale el día acordado, y la caja sigue en ese anaquel.
      const removed = one(reproRow({
        agreement: agreement({ agreedOn: TODAY, materializedAt: MARK, materializedOn: TODAY }),
        program: null,
        state: { kind: "deriva_quitado" },
        receivedAt: RECEIVED,
        box: { kind: "en_oficina", since: RECEIVED, courier: "propio" },
      }));
      expect(removed).toMatchObject({ dayFrom: "acuerdo", whereLine: RETRY_ANAQUEL("mar 13/10") });
    });

    it("la marca del acuerdo cuenta hasta 2 minutos después de la recepción, no antes", () => {
      expect(markedAtReception({ materializedAt: RECEIVED }, RECEIVED)).toBe(true);
      expect(markedAtReception({ materializedAt: "2026-10-12T15:02:00.000Z" }, RECEIVED)).toBe(true);
      expect(markedAtReception({ materializedAt: "2026-10-12T15:02:00.001Z" }, RECEIVED)).toBe(false);
      expect(markedAtReception({ materializedAt: "2026-10-12T14:59:59.000Z" }, RECEIVED)).toBe(false);
      expect(markedAtReception({ materializedAt: null }, RECEIVED)).toBe(false);
      expect(markedAtReception({ materializedAt: "2026-10-12T15:00:01.000Z" }, null)).toBe(false);
      expect(markedAtReception(null, RECEIVED)).toBe(false);
    });

    it("solo el programa de Repro Lima tiene la ventana: el de Despacho GF segundos después va a la bandeja", () => {
      expect(programmedAtReception({ origin: "grupo_gf", setAt: "2026-10-12T15:00:05.000Z" }, RECEIVED)).toBe(false);
      expect(programmedAtReception({ origin: "motorizado", setAt: "2026-10-12T15:00:05.000Z" }, RECEIVED)).toBe(false);
      // Sin acuerdo que la recepción haya marcado.
      const row = one(received("2026-10-12T15:00:05.000Z", { reason: "Programado por Despacho GF", origin: "grupo_gf" }, { agreement: null }));
      expect(row.whereLine).toBe(RETRY_TRAY("lun 12/10"));
    });

    it("el programa que ya existía al recibirla sigue mandándola al anaquel, sea de quien sea", () => {
      expect(programmedAtReception({ origin: "grupo_gf", setAt: RECEIVED }, RECEIVED)).toBe(true);
      expect(programmedAtReception({ origin: "repro_lima", setAt: "2026-10-12T14:59:59.000Z" }, RECEIVED)).toBe(true);
    });

    it("sin recepción, sin programa o sin fecha del programa, no", () => {
      expect(programmedAtReception({ origin: "repro_lima", setAt: "2026-10-12T15:00:01.000Z" }, null)).toBe(false);
      expect(programmedAtReception(null, RECEIVED)).toBe(false);
      expect(programmedAtReception({ origin: "repro_lima", setAt: null }, RECEIVED)).toBe(false);
    });

    it("lo que se desarma nunca va al anaquel, aunque la recepción escribiera el programa", () => {
      // Cerrado después de recibirla: la caja ya estaba en su bandeja.
      const row = one(received("2026-10-12T15:00:00.500Z", {}, {
        agreement: null,
        list: "cerrados",
        closed: { caseId: "case-0", at: "2026-10-12T16:00:00Z", byName: "diana", note: null },
      }));
      expect(row.action).toBe("desarmar_cerrar");
      expect(row.whereLine).toBe(RETRY_TRAY("lun 12/10"));
    });

    it("recibida después del «Desarmar y cerrar»: la recepción pidió desarmarla, no va al estante", () => {
      const closed = (at: string | null) => one(received("2026-10-13T14:00:00.000Z", { reason: "Programado por Despacho GF", origin: "grupo_gf" }, {
        agreement: null,
        list: "cerrados",
        closed: { caseId: "case-0", at, byName: "diana", note: null },
      }));
      const after = closed("2026-10-12T14:00:00Z");
      expect(after).toMatchObject({ action: "desarmar_cerrar", group: "con_aviso", whereLine: RETRY_DISMANTLE_AT_RECEPTION });
      expect(after.whereLine).toBe("Al recibirla se pidió desarmarla (cuaderno «DESARMAR»): no va al estante.");
      // Sin la hora del cierre, la bandeja de siempre.
      expect(closed(null).whereLine).toBe(RETRY_TRAY("lun 12/10"));
    });
  });
});

describe("apartados y orden", () => {
  it("lo rojo manda aunque la caja esté fuera; lo ámbar no", () => {
    const facts = { state: "sin_acuerdo" as const, unconfirmed: false, defaultProblem: false, noReception: false, addressDrift: false, otherSalidaExists: false };
    const rider: BoxLocation = { kind: "con_motorizado", riderName: "Roy", since: YESTERDAY };
    expect(retryGroup({ ...facts, box: rider, critical: true })).toBe("con_aviso");
    expect(retryGroup({ ...facts, box: rider, critical: false, unconfirmed: true })).toBe("fuera");
    expect(retryGroup({ ...facts, box: { kind: "volviendo_courier", courier: "tanders" }, critical: false })).toBe("fuera");
    expect(retryGroup({ ...facts, box: OWN_BOX, critical: false, unconfirmed: true })).toBe("con_aviso");
    expect(retryGroup({ ...facts, box: OWN_BOX, critical: false, state: "falta_salida" })).toBe("con_aviso");
    expect(retryGroup({ ...facts, box: OWN_BOX, critical: false, state: "programado" })).toBe("anaquel");
  });

  it("no consta dónde está la caja: rojo", () => {
    const row = one(reproRow({ program: program(TODAY), box: { kind: "desconocida" }, ownOutput: null }));
    expect(row.chips).toContainEqual({ tone: "crit", text: "No consta dónde está la caja" });
    expect(row.group).toBe("con_aviso");
  });

  it("«Con aviso» (rojo, después ámbar), «Al anaquel», «Todavía fuera»; dentro, lo vencido más antiguo, la bandeja y el pedido", () => {
    const rows = project([
      reproRow({ orderId: "fuera", orderName: "#F", program: program(TODAY), box: { kind: "volviendo_courier", courier: "tanders" } }),
      reproRow({ orderId: "anaquel-b", orderName: "#B", program: program(TODAY), receivedAt: "2026-10-12T15:00:00Z" }),
      reproRow({ orderId: "anaquel-a", orderName: "#A", program: program(TODAY), receivedAt: "2026-10-12T15:00:00Z" }),
      reproRow({ orderId: "anaquel-old-tray", orderName: "#0", program: program(TODAY), receivedAt: "2026-10-11T15:00:00Z" }),
      reproRow({ orderId: "anaquel-no-tray", orderName: "#00", program: program(TODAY), receivedAt: "2026-10-01T15:00:00Z" }),
      reproRow({ orderId: "vencido-1", orderName: "#Z", program: program(YESTERDAY) }),
      reproRow({ orderId: "vencido-2", orderName: "#Y", program: program("2026-10-10") }),
      reproRow({ orderId: "ambar", orderName: "#W", program: program(TODAY), receivedAt: null }),
      reproRow({ orderId: "rojo", orderName: "#X", program: program(TODAY), box: { kind: "desconocida" } }),
    ]);
    expect(rows.map((row) => row.orderId)).toEqual([
      "rojo",
      "ambar",
      "vencido-2",
      "vencido-1",
      "anaquel-old-tray",
      "anaquel-a",
      "anaquel-b",
      "anaquel-no-tray",
      "fuera",
    ]);
  });

  it("el vencido no cuenta como rojo para ordenar", () => {
    const sorted = sortRetries([
      { group: "con_aviso" as const, overdue: true, day: YESTERDAY, dayLabel: "lun 12/10", orderName: "#1", chips: [{ tone: "crit" as const, text: RETRY_OVERDUE("lun 12/10") }, { tone: "warn" as const, text: RETRY_UNCONFIRMED }] },
      { group: "con_aviso" as const, overdue: false, day: TODAY, dayLabel: "mar 13/10", orderName: "#2", chips: [{ tone: "crit" as const, text: RETRY_FACTS_CHANGED }] },
    ]);
    expect(sorted.map((row) => row.orderName)).toEqual(["#2", "#1"]);
  });
});

describe("las cifras", () => {
  it("cuentan solo las filas de la etapa: hoy en oficina y fuera, mañana de la noche anterior", () => {
    const rows = project([
      reproRow({ orderId: "a", program: program(TODAY) }),
      reproRow({ orderId: "b", program: program(YESTERDAY), box: { kind: "con_motorizado", riderName: "Roy", since: YESTERDAY } }),
      reproRow({ orderId: "c", agreement: agreement({ boxAction: "reimprimir_misma_salida", changes: { direccion: true } }), program: program(TOMORROW) }),
      reproRow({ orderId: "d", program: program(TOMORROW) }),
    ]);
    expect(retryCounts(rows)).toEqual({ hoy: 2, manana: 2, hoyEnOficina: 1, hoyFuera: 1, mananaNoche: 1 });
  });
});

describe("«Imprimir rótulo» de la misma salida", () => {
  it("con «Reimprimir» confirmada", () => {
    const row = one(reproRow({ agreement: agreement({ boxAction: "reimprimir_misma_salida", changes: { monto: true } }) }));
    expect(row.label).toEqual({ shipmentId: "sh1", code: "KP1-S01" });
  });

  it("con la caja nueva desde stock que sale con la misma salida (E29)", () => {
    const r = reproRow({
      agreement: agreement({ boxAction: "caja_nueva_stock", changes: { no_esperar_caja: true } }),
      box: { kind: "desconocida", own: true },
      reopened: true,
    });
    const row = one(r);
    expect(row.actionLine).toMatch(/^Caja nueva desde stock con la misma salida de Grupo GF/);
    expect(row.label).toEqual({ shipmentId: "sh1", code: "KP1-S01" });
  });

  it("no con «Mantener», ni con una caja nueva con salida nueva, ni si los hechos cambiaron", () => {
    expect(one(reproRow({ agreement: agreement({ boxAction: "mantener" }) })).label).toBeNull();
    const rider = reproRow({
      agreement: agreement({ boxAction: "caja_nueva_stock", changes: { no_esperar_caja: true } }),
      box: { kind: "con_motorizado", riderName: "Roy", since: YESTERDAY },
    });
    expect(one(rider).label).toBeNull();
    const drift = reproRow({ agreement: agreement({ boxAction: "reimprimir_misma_salida", changes: { monto: true } }) });
    drift.boxInputs = { ...drift.boxInputs, ownLiveCourier: null };
    expect(one(drift).label).toBeNull();
  });

  it("el enlace es el de rótulos por salida, con tope", () => {
    expect(retryLabelsHref(["a", "b", "a"])).toBe("/api/pedidos/rotulos?ids=a,b");
    const many = Array.from({ length: 250 }, (_, i) => `id${i}`);
    expect(retryLabelsHref(many).split(",")).toHaveLength(200);
  });
});

describe("retryAction directo", () => {
  it("sin programa ni acuerdo no dice nada", () => {
    expect(retryAction(reproRow())).toMatchObject({ action: null, actionLine: null, chips: [] });
  });
});

describe("ya en «Por armar»", () => {
  it("lo que se hace con la caja del estante, en las cuatro variantes", () => {
    expect(handoffLine("salida_nueva_rearmar", "propio")).toBe(HANDOFF_LINE_GF);
    expect(handoffLine("salida_nueva_rearmar", "tanders")).toBe("Rearma la caja del estante con la etiqueta de Tanders y retira la vieja.");
    expect(handoffLine("desarmar_rearmar", "propio")).toBe(HANDOFF_LINE_DESARMAR);
    expect(handoffLine("caja_nueva_stock", "propio")).toBe(HANDOFF_LINE_CAJA_NUEVA);
  });

  const shipment = (extra: Record<string, unknown>) => ({
    id: "sh", order_id: "o1", courier: "propio", output_code: "KP1-S01", output_number: 1, preparation_state: "listo_despacho",
    ready_at: null, created_at: "2026-10-05T15:00:00Z", delivery_status: "no_entregado", ...extra,
  });

  it("la salida nueva es la más alta nacida después de decidir y no entregada; si no hay, no se adivina", () => {
    const shipments = [
      shipment({ id: "s1" }),
      shipment({ id: "s2", output_code: "KP1-S02", output_number: 2, preparation_state: "rotulo_generado", created_at: "2026-10-13T14:00:00Z" }),
      shipment({ id: "s3", output_code: "KP1-S03", output_number: 3, created_at: "2026-10-13T14:30:00Z", delivery_status: "entregado" }),
    ];
    expect(handoffSalida(shipments, "2026-10-12T20:00:00Z")).toEqual({ code: "KP1-S02", armed: false, readyAt: null });
    expect(handoffSalida([shipment({ id: "s1" })], "2026-10-12T20:00:00Z")).toBeNull();
    expect(handoffSalidaLine({ code: "KP1-S02", armed: false, readyAt: null })).toBe("Falta armarla · KP1-S02");
    expect(handoffSalidaLine({ code: "KP1-S02", armed: true, readyAt: "2026-10-13T15:12:00Z" })).toBe("Armada 10:12 · KP1-S02");
    expect(handoffSalidaLine(null)).toBeNull();
  });

  it("su día: el del programa si lo hay, si no el acordado; lo de después de mañana no se lista", () => {
    const base = {
      caseRow: { order_id: "o1", agreed_on: TOMORROW, agreed_courier: "propio", box_action: "salida_nueva_rearmar", decided_at: "2026-10-12T20:00:00Z" },
      order: { order_name: "#KP1", customer_name: "Ana", district: "Surco" },
      storeName: "Tienda",
      programDay: null as string | null,
      shipments: [],
      today: TODAY,
    };
    expect(warehouseHandoffRow(base)).toMatchObject({
      bucket: "manana", day: TOMORROW, action: "salida_nueva_rearmar", courierName: "Grupo GF", line: HANDOFF_LINE_GF, salida: null,
    });
    expect(warehouseHandoffRow({ ...base, programDay: YESTERDAY })).toMatchObject({ bucket: "hoy", overdue: true, dayLabel: "lun 12/10" });
    expect(warehouseHandoffRow({ ...base, programDay: "2026-10-16" })).toBeNull();
    expect(warehouseHandoffRow({ ...base, caseRow: { ...base.caseRow, box_action: "mantener" } })).toBeNull();
    const sorted = sortHandoffs([
      { day: TOMORROW, orderName: "#A" },
      { day: YESTERDAY, orderName: "#C" },
      { day: TOMORROW, orderName: "#0" },
    ]);
    expect(sorted.map((row) => row.orderName)).toEqual(["#C", "#0", "#A"]);
  });
});
