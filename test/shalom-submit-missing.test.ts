import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildShalomOrderPayload,
  msUntilSessionStale,
  sessionIsFresh,
  sessionStaleAt,
  sessionTimerDelay,
  shalomDraftWarnings,
  shalomNotePaymentLine,
  shalomPayloadErrors,
  shalomSoftBlockers,
  shalomSubmitMissing,
  MAX_TIMER_MS,
  MIN_OVERRIDE_REASON,
  SUBMIT_BLOCKED_REASON,
  type ShalomSubmitState,
} from "@/lib/shalom/draft";
import { sessionIsFresh as sessionIsFreshFromClient } from "@/lib/shalom/client";

/**
 * «Este pedido ya tiene adelanto de pago y me sale esta nota y no me deja
 * registrar» (#KP202968, 06-11-2026).
 *
 * Adelanto de S/ 30 por Yape validado, DNI 46413109 y agencia 28 «JAEN CO»
 * apuntados en «DNI y agencia Shalom». El modal enseñaba tres avisos ámbar
 * —«el pedido no trae el documento» con el DNI ya puesto, «todavía no tiene el
 * pago completo validado» y la nota de COD Core «pedir el pago por adelantado»—
 * y el botón «Crear guía» gris sin decir por qué. Ninguno de los tres frenaba.
 */

const read = (p: string) => readFileSync(p, "utf8");

/** Todo listo para crear: cada prueba rompe una sola condición. */
const ready: ShalomSubmitState = {
  loaded: true,
  blockers: [],
  softBlockers: [],
  overrideReason: "",
  sessionReady: true,
  sessionExpired: false,
  originTerminalId: 476,
  destinyTerminalId: 28,
  productId: 1096,
  quantity: 1,
  documentType: "DNI",
  document: "46413109",
  name: "Natalia",
  lastName: "vilchez",
  phone: "51994921760",
  pickupCodeError: null,
  pending: false,
  created: false,
};

describe("shalomSubmitMissing: por qué «Crear guía» está gris", () => {
  it("con todo listo no falta nada y el botón se puede pulsar", () => {
    expect(shalomSubmitMissing(ready)).toEqual([]);
  });

  it("#KP202968 sin conectar: la única razón es la sesión, no el adelanto", () => {
    const missing = shalomSubmitMissing({ ...ready, sessionReady: false });
    expect(missing).toEqual(["Falta conectar con Shalom (pulsa «Conectar con Shalom»)."]);
    expect(missing.join(" ")).not.toMatch(/adelanto|pago/i);
  });

  it("la sesión vencida se dice distinto: hay que volver a conectar", () => {
    expect(shalomSubmitMissing({ ...ready, sessionReady: false, sessionExpired: true })).toEqual([
      "La sesión de Shalom venció: vuelve a conectar (pulsa «Conectar con Shalom»).",
    ]);
  });

  it("una razón por cada condición que falla, en el orden de la pantalla", () => {
    const missing = shalomSubmitMissing({
      ...ready,
      softBlockers: ["El adelanto mínimo todavía no está validado."],
      sessionReady: false,
      destinyTerminalId: null,
      document: "",
      name: " ",
      lastName: "",
      phone: "",
      productId: null,
      quantity: 0,
      pickupCodeError: "Shalom no acepta claves consecutivas (1234, 2345…).",
    });
    expect(missing).toEqual([
      // El recuadro rojo del freno blando está arriba del todo.
      `Falta el motivo para crearla sin el adelanto validado (al menos ${MIN_OVERRIDE_REASON} caracteres, en el recuadro rojo de arriba).`,
      "Falta conectar con Shalom (pulsa «Conectar con Shalom»).",
      "Falta elegir la agencia de destino.",
      "Falta el documento del destinatario.",
      "Falta el nombre del destinatario.",
      "Falta el primer apellido del destinatario (Shalom lo exige para DNI y CE).",
      "Falta el teléfono del destinatario.",
      "Falta elegir el tipo de paquete.",
      "La cantidad de bultos no es válida.",
      "La clave de recojo no es válida: Shalom no acepta claves consecutivas (1234, 2345…).",
    ]);
  });

  it("el documento mal escrito dice qué tiene de malo, como debajo del campo", () => {
    expect(shalomSubmitMissing({ ...ready, document: "4641310" })).toEqual(["El DNI son 8 dígitos."]);
    expect(
      shalomSubmitMissing({
        ...ready,
        documentType: "RUC",
        document: "20123456789",
        name: "",
        lastName: "",
      }),
    ).toEqual(["Falta la razón social del destinatario."]);
  });

  it("la clave de recojo inválida (solo la ve quien puede verla)", () => {
    expect(
      shalomSubmitMissing({ ...ready, pickupCodeError: "Shalom no acepta claves consecutivas (1234, 2345…)." }),
    ).toEqual(["La clave de recojo no es válida: Shalom no acepta claves consecutivas (1234, 2345…)."]);
  });

  // Lo que el servidor rechaza al pulsar (`buildShalomOrderPayload`) también
  // apaga el botón: antes la lista quedaba vacía y el error salía después.
  it("un solo nombre («Natalia»): falta el primer apellido, como exige el servidor", () => {
    const state = { ...ready, name: "Natalia", lastName: "" };
    expect(shalomSubmitMissing(state)).toEqual([
      "Falta el primer apellido del destinatario (Shalom lo exige para DNI y CE).",
    ]);
  });

  it("un teléfono que no es celular de 9 dígitos se dice con lo escrito", () => {
    expect(shalomSubmitMissing({ ...ready, phone: "981 53" })).toEqual([
      "El teléfono no es un celular peruano de 9 dígitos (981 53).",
    ]);
    expect(shalomSubmitMissing({ ...ready, phone: "014445566" })).toEqual([
      "El teléfono no es un celular peruano de 9 dígitos (014445566).",
    ]);
  });

  it("bultos inválidos y origen igual al destino", () => {
    expect(shalomSubmitMissing({ ...ready, quantity: 1.5 })).toEqual(["La cantidad de bultos no es válida."]);
    expect(shalomSubmitMissing({ ...ready, destinyTerminalId: 476 })).toEqual([
      "El origen y el destino son la misma agencia.",
    ]);
  });

  it("la lista y el servidor no pueden separarse: son la misma función", () => {
    const form = {
      originTerminalId: 476,
      destinyTerminalId: 28,
      productId: 1096,
      quantity: 1,
      documentType: "DNI" as const,
      document: "46413109",
      name: "Natalia",
      lastName: "",
      phone: "981 53",
    };
    const built = buildShalomOrderPayload({ ...form, pickupCode: "2415" });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(shalomSubmitMissing({ ...ready, ...form })).toEqual(built.errors);
    expect(shalomPayloadErrors(form)).toEqual(built.errors);
  });

  it("con un bloqueo duro, una sola razón: lo demás no sirve de nada", () => {
    const b = "El pedido ya tiene una guía activa: 123 (shalom, pendiente). Anúlala antes de crear otra.";
    // Ni «conecta», ni «elige la agencia»: con la guía activa no cambian nada,
    // y con la configuración faltante el botón de conectar está apagado.
    expect(
      shalomSubmitMissing({ ...ready, blockers: [b], sessionReady: false, destinyTerminalId: null, phone: "" }),
    ).toEqual([SUBMIT_BLOCKED_REASON]);
    expect(SUBMIT_BLOCKED_REASON).toBe("No se puede crear por API: mira el aviso rojo de arriba.");
  });

  it("el freno blando pide el motivo hasta que tenga el mínimo", () => {
    const soft = { ...ready, softBlockers: ["El adelanto mínimo todavía no está validado."] };
    expect(shalomSubmitMissing(soft)).toHaveLength(1);
    expect(shalomSubmitMissing(soft)[0]).toContain(`al menos ${MIN_OVERRIDE_REASON} caracteres`);
    expect(shalomSubmitMissing(soft)[0]).toContain("en el recuadro rojo de arriba");
    expect(shalomSubmitMissing({ ...soft, overrideReason: "x".repeat(MIN_OVERRIDE_REASON) })).toEqual([]);
  });

  it("creando o ya creada tampoco se pulsa (y el modal no lo lista)", () => {
    expect(shalomSubmitMissing({ ...ready, pending: true })).toHaveLength(1);
    expect(shalomSubmitMissing({ ...ready, created: true })).toHaveLength(1);
    expect(shalomSubmitMissing({ ...ready, loaded: false })).toHaveLength(1);
  });
});

describe("shalomDraftWarnings: los avisos ámbar, solo lo que hay que hacer", () => {
  const base = {
    paymentState: "adelanto_validado",
    prefilledDocument: null,
    prefilledTerminalName: null,
    blocked: false,
  };

  it("«el pedido no trae el documento» solo si nadie lo apuntó", () => {
    expect(shalomDraftWarnings(base).join(" ")).toContain("Shalom exige el documento");
    const kp = shalomDraftWarnings({
      ...base,
      prefilledDocument: "46413109",
      prefilledTerminalName: "CAJAMARCA / JAEN / JAEN / JAEN CO",
    });
    expect(kp).toEqual([
      "El documento y la agencia venían apuntados en «DNI y agencia Shalom» (46413109 · CAJAMARCA / JAEN / JAEN / JAEN CO). Verifícalos antes de crear.",
    ]);
  });

  it("con el adelanto validado no hay aviso de pago: nada que hacer, y en ámbar se leía como freno", () => {
    for (const paymentState of ["adelanto_validado", "diferencia_cargada", "pago_completo", "sin_pago", null]) {
      expect(shalomDraftWarnings({ ...base, paymentState }).join(" ")).not.toMatch(
        /pago completo|Puedes crear|comprobante/,
      );
    }
  });

  it("con un comprobante sin validar dice las dos salidas, sin «se puede crear igual»", () => {
    for (const paymentState of ["adelanto_cargado", "pago_total_cargado", "posible_duplicado"]) {
      const w = shalomDraftWarnings({ ...base, paymentState });
      expect(w).toContain(
        "Hay un comprobante cargado sin validar: valídalo en Cobro o escribe el motivo en el recuadro rojo para crearla igual. La clave de recojo espera al pago completo.",
      );
      expect(w.join(" ")).not.toContain("se puede crear igual");
      // Y el recuadro rojo de verdad está: el freno blando sigue vivo.
      expect(shalomSoftBlockers(paymentState)).toHaveLength(1);
    }
  });

  it("con un bloqueo duro no hay avisos al lado del rojo", () => {
    expect(shalomDraftWarnings({ ...base, blocked: true })).toEqual([]);
    expect(shalomDraftWarnings({ ...base, paymentState: "adelanto_cargado", blocked: true })).toEqual([]);
  });
});

describe("shalomNotePaymentLine: la nota que ya se cumplió", () => {
  it("#KP202968: adelanto validado de S/ 30", () => {
    expect(shalomNotePaymentLine("adelanto_validado", 30, false)).toBe(
      "El adelanto ya está validado (S/ 30): si la nota pide cobrar por adelantado, eso ya se cumplió. La clave de recojo se entrega cuando el pago completo esté validado.",
    );
  });

  it("sin importe conocido sale igual, sin cifra", () => {
    expect(shalomNotePaymentLine("diferencia_cargada", null, false)).toBe(
      "El adelanto ya está validado: si la nota pide cobrar por adelantado, eso ya se cumplió. La clave de recojo se entrega cuando el pago completo esté validado.",
    );
    expect(shalomNotePaymentLine("adelanto_validado", 0, false)).not.toContain("(");
  });

  it("pagado completo, con céntimos", () => {
    expect(shalomNotePaymentLine("pago_completo", 89.1, false)).toBe(
      "El pago completo ya está validado (S/ 89.10): si la nota pide cobrar por adelantado, eso ya se cumplió.",
    );
  });

  it("sin el adelanto validado no hay línea: la nota sigue pendiente", () => {
    for (const s of ["sin_pago", "adelanto_cargado", "pago_total_cargado", "posible_duplicado", null]) {
      expect(shalomNotePaymentLine(s, 30, false)).toBeNull();
    }
  });

  it("con un bloqueo duro (lista de pago adelantado, guía activa) no promete nada", () => {
    expect(shalomNotePaymentLine("adelanto_validado", 30, true)).toBeNull();
    expect(shalomNotePaymentLine("pago_completo", 120, true)).toBeNull();
  });
});

describe("la sesión de 2 h con el modal abierto", () => {
  const HOUR = 3_600_000;
  const serverNow = Date.parse("2026-11-06T19:20:00Z");
  // La de #KP202968 al revisar: vence a las 20:38 (UTC).
  const expiresAt = "2026-11-06T20:38:27Z";

  it("msUntilSessionStale usa el mismo margen que sessionIsFresh", () => {
    const now = Date.parse("2026-11-06T18:00:00Z");
    expect(msUntilSessionStale("2026-11-06T20:00:00Z", 120_000, now)).toBe(2 * HOUR - 120_000);
    expect(msUntilSessionStale("2026-11-06T18:01:00Z", 120_000, now)).toBe(0);
    expect(msUntilSessionStale(null, 120_000, now)).toBe(0);
    expect(msUntilSessionStale("no es una fecha", 120_000, now)).toBe(0);
  });

  /** Lo que hace el modal: el servidor mide, el navegador cuenta desde que llega. */
  function modalDelay(clientSkewMs: number): number {
    const msLeft = msUntilSessionStale(expiresAt, 120_000, serverNow);
    const clientNow = serverNow + clientSkewMs;
    const staleAt = sessionStaleAt(msLeft, clientNow);
    expect(staleAt).not.toBeNull();
    return sessionTimerDelay(staleAt as number, clientNow);
  }

  it("un reloj adelantado (o atrasado) no mueve el vencimiento", () => {
    const real = msUntilSessionStale(expiresAt, 120_000, serverNow);
    expect(real).toBeGreaterThan(HOUR);
    for (const skew of [0, 10 * 60_000, 3 * HOUR, -45 * 60_000, 26 * HOUR]) {
      expect(modalDelay(skew)).toBe(real);
    }
    // Lo de antes —comparar la hora del servidor con el reloj del equipo—
    // daba la sesión por muerta con el reloj 3 h adelantado.
    expect(msUntilSessionStale(expiresAt, 120_000, serverNow + 3 * HOUR)).toBe(0);
  });

  it("reconectar con la caché vuelve a darla por viva aunque el reloj esté mal", () => {
    // `connectShalomSession` devuelve `msLeft` del servidor: con el reloj del
    // equipo 3 h adelantado, la misma hora de la caché ya no se lee vencida.
    const msLeft = msUntilSessionStale(expiresAt, 120_000, serverNow);
    const clientNow = serverNow + 3 * HOUR;
    const staleAt = sessionStaleAt(msLeft, clientNow) as number;
    expect(sessionTimerDelay(staleAt, clientNow)).toBeGreaterThan(0);
    // Y vence cuando de verdad toca, contado en el reloj del equipo.
    expect(sessionTimerDelay(staleAt, clientNow + msLeft)).toBe(0);
  });

  it("sin sesión (o ya vencida en el servidor) no hay instante", () => {
    expect(sessionStaleAt(null, serverNow)).toBeNull();
    expect(sessionStaleAt(0, serverNow)).toBeNull();
    expect(sessionStaleAt(Number.NaN, serverNow)).toBeNull();
  });

  it("el temporizador nunca pasa de lo que acepta setTimeout", () => {
    expect(MAX_TIMER_MS).toBe(2 ** 31 - 1);
    expect(sessionTimerDelay(serverNow + 40 * 24 * HOUR, serverNow)).toBe(MAX_TIMER_MS);
    expect(sessionTimerDelay(serverNow - 1, serverNow)).toBe(0);
  });

  it("sessionIsFresh es uno solo: client.ts re-exporta el de draft.ts", () => {
    expect(sessionIsFreshFromClient).toBe(sessionIsFresh);
    expect(read("lib/shalom/client.ts")).toContain('export { sessionIsFresh } from "./draft";');
  });
});

describe("el modal y el servidor usan las mismas reglas", () => {
  const modal = read("components/shalom-guide-modal.tsx");
  const action = read("app/dashboard/pedidos/shalom-actions.ts");

  it("el botón se habilita con shalomSubmitMissing y las razones se ven encima, en `warn`", () => {
    expect(modal).toContain("const missing = shalomSubmitMissing({");
    expect(modal).toContain("const canSubmit = missing.length === 0;");
    expect(modal).toContain("const showMissing = !pending && !created && missing.length > 0;");
    expect(modal).toContain("Para poder crear la guía:");
    expect(modal).toContain('aria-describedby={showMissing ? "shalom-submit-missing" : undefined}');
    const box = modal.slice(modal.indexOf('id="shalom-submit-missing"'), modal.indexOf("Para poder crear la guía:"));
    expect(box).toContain("bg-amber-50");
    // La lista vieja de condiciones sueltas ya no existe.
    expect(modal).not.toMatch(/!softHeld &&\s*sessionReady &&/);
  });

  it("la sesión: duración del servidor, sin chequeo con el reloj del equipo al pulsar", () => {
    expect(modal).toContain("staleAtFrom(d.sessionMsLeft, Date.now())");
    expect(modal).toContain("staleAtFrom(res.msLeft, Date.now())");
    expect(modal).toContain("sessionTimerDelay(sessionStaleAt, Date.now())");
    expect(modal).not.toContain("sessionIsFresh(");
    expect(modal).not.toContain("msUntilSessionStale");
    expect(modal).toContain("if (res.sessionExpired) setSessionExpired(true);");
    expect(modal).toContain("La sesión de Shalom venció: vuelve a conectar.");
    expect(action).toContain("sessionMsLeft: sessionReady ? msUntilSessionStale(store?.shalom_session_expires_at) : null");
    expect(action).toContain("msLeft: msUntilSessionStale(res.expiresAt)");
  });

  it("al reconectar se borra el error rojo que venía de la sesión", () => {
    const connect = modal.slice(modal.indexOf("const connect = useCallback"), modal.indexOf("}, [storeId]);"));
    expect(connect).toContain("if (errorFromSession.current) {");
    expect(connect).toContain("setError(null);");
    expect(modal).toContain("errorFromSession.current = Boolean(res.sessionExpired);");
  });

  it("los avisos salen de shalomDraftWarnings y la nota lleva su línea en verde", () => {
    expect(action).toContain("...shalomDraftWarnings({");
    // El aviso del documento ya no se empuja suelto en el servidor.
    expect(action).not.toContain("Shalom exige el documento del destinatario");
    expect(action).toContain("shalomNotePaymentLine(row.payment_state, validated, blocked)");
    expect(modal).toContain("draft.notePaymentLine &&");
    const note = modal.slice(modal.indexOf("{draft.shopifyNote && ("), modal.indexOf("{/* 3. Destinatario */}"));
    expect(note).toContain("bg-emerald-50");
    expect(note).not.toContain("amber");
  });

  it("el MOM lo cuenta", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("#### Por qué «Crear guía» no se deja pulsar (decidido el 06-11-2026)");
    expect(mom).toContain("`shalomSubmitMissing`");
    expect(mom).toContain("`clearRejectedSession`");
    expect(mom).toContain("`sessionMsLeft`");
  });
});
