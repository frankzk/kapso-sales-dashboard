import { describe, expect, it } from "vitest";
import {
  CONFIRMATION_MAX_DAYS,
  CONFIRMATION_RESULTS,
  confirmationDayCount,
  confirmationDays,
  confirmationResult,
  isConfirmationChannel,
  limaDayKey,
  reachedLastAttempt,
} from "@/lib/order-confirmation";

// El conteo de días es lo que decide cuándo un pedido llega a «Último intento»,
// y después de ahí alguien crea una tarea de anulación a mano. Un día contado de
// más mata un pedido vivo; uno de menos lo deja dando vueltas para siempre.

function attempt(occurred_at: string, kind = "confirmation_contact") {
  return { kind, occurred_at };
}

describe("limaDayKey", () => {
  it("una llamada de las 20:00 de Lima es del día de Lima, no del siguiente en UTC", () => {
    // 20:00 en Lima son las 01:00 UTC del día siguiente. Contando en UTC, ese
    // mismo intento gastaría el cupo de un día que nadie trabajó.
    expect(limaDayKey("2026-07-21T01:00:00.000Z")).toBe("2026-07-20");
  });

  it("la medianoche de Lima abre día nuevo", () => {
    expect(limaDayKey("2026-07-21T05:00:00.000Z")).toBe("2026-07-21");
  });

  it("una fecha inválida no revienta ni inventa un día", () => {
    expect(limaDayKey("mañana")).toBe("");
  });
});

describe("confirmationDays", () => {
  it("cuenta días DISTINTOS con gestión, no días transcurridos", () => {
    // El caso del MOM: 20, 22, 25 y 28 de julio son CUATRO días de siete. Contar
    // desde el primer contacto daría nueve y el pedido moriría sin haber usado
    // sus siete oportunidades.
    const days = confirmationDays([
      attempt("2026-07-20T15:00:00.000Z"),
      attempt("2026-07-22T15:00:00.000Z"),
      attempt("2026-07-25T15:00:00.000Z"),
      attempt("2026-07-28T15:00:00.000Z"),
    ]);
    expect(days).toEqual(["2026-07-20", "2026-07-22", "2026-07-25", "2026-07-28"]);
    expect(days.length).toBe(4);
  });

  it("varios contactos y varios canales del mismo día suman UN día", () => {
    // §6.1: «Llamada normal, llamada WhatsApp y mensaje escrito realizados el
    // mismo día constituyen un día de intento».
    expect(
      confirmationDayCount([
        attempt("2026-07-20T14:00:00.000Z"),
        attempt("2026-07-20T18:00:00.000Z"),
        attempt("2026-07-20T22:00:00.000Z"),
      ]),
    ).toBe(1);
  });

  it("ignora lo que no es un intento de contacto", () => {
    expect(
      confirmationDayCount([
        attempt("2026-07-20T15:00:00.000Z", "comment"),
        attempt("2026-07-21T15:00:00.000Z", "status_override"),
        attempt("2026-07-22T15:00:00.000Z", "confirmation_followup"),
      ]),
    ).toBe(0);
  });

  it("los días salen ordenados aunque los eventos lleguen desordenados", () => {
    expect(
      confirmationDays([
        attempt("2026-07-28T15:00:00.000Z"),
        attempt("2026-07-20T15:00:00.000Z"),
      ]),
    ).toEqual(["2026-07-20", "2026-07-28"]);
  });
});

describe("reachedLastAttempt", () => {
  const seven = Array.from({ length: CONFIRMATION_MAX_DAYS }, (_, i) =>
    attempt(`2026-07-${String(10 + i).padStart(2, "0")}T15:00:00.000Z`),
  );

  it("el séptimo día distinto es el último intento", () => {
    expect(reachedLastAttempt(seven)).toBe(true);
    expect(reachedLastAttempt(seven.slice(0, 6))).toBe(false);
  });

  it("siete llamadas en el mismo día NO agotan la gestión", () => {
    // Insistir siete veces un martes no es haber gestionado siete días; si
    // contara, un pedido se quedaría sin oportunidades en una tarde.
    const sameDay = Array.from({ length: 7 }, (_, i) =>
      attempt(`2026-07-20T1${i}:00:00.000Z`),
    );
    expect(reachedLastAttempt(sameDay)).toBe(false);
  });

  it("una marca explícita también cierra, para lo que no salga del conteo", () => {
    expect(reachedLastAttempt([attempt("2026-07-20T15:00:00.000Z", "last_attempt")])).toBe(true);
  });
});

describe("catálogo de la gestión", () => {
  it("piden fecha los que pactan algo, y solo «confirmado» cierra", () => {
    expect(confirmationResult("volver_a_contactar")?.schedulesFollowup).toBe(true);
    expect(confirmationResult("pendiente_de_abono")?.schedulesFollowup).toBe(true);
    expect(confirmationResult("sin_respuesta")?.schedulesFollowup).toBe(false);
    expect(confirmationResult("se_deja_mensaje")?.schedulesFollowup).toBe(false);
    expect(confirmationResult("confirmado")?.confirms).toBe(true);
    expect(confirmationResult("volver_a_contactar")?.confirms).toBe(false);
  });

  it("«pendiente de abono» pacta fecha pero NO confirma el pedido", () => {
    // En Agencia la confirmación exige el pago validado (§6.1). Si esto
    // confirmara, el pedido saldría a Preparación con la promesa del cliente
    // como única garantía y el rótulo se podría crear sin un sol abonado.
    const abono = confirmationResult("pendiente_de_abono");
    expect(abono?.schedulesFollowup).toBe(true);
    expect(abono?.confirms).toBe(false);
  });

  it("«se deja mensaje» se comporta como «no contestó», pero es otro hecho", () => {
    // Mismo efecto sobre el pedido, código distinto: el intento queda escrito
    // con lo que de verdad pasó. Si compartieran código no habría forma de
    // distinguirlos después, que es justo lo que se quiso registrar.
    const mensaje = confirmationResult("se_deja_mensaje");
    const sinRespuesta = confirmationResult("sin_respuesta");
    expect(mensaje?.schedulesFollowup).toBe(sinRespuesta?.schedulesFollowup);
    expect(mensaje?.confirms).toBe(sinRespuesta?.confirms);
    expect(mensaje?.code).not.toBe(sinRespuesta?.code);
  });

  it("«No contestó» sigue siendo el resultado por defecto", () => {
    // La mesa marca el primero cuando no lo tocan. Si un resultado que pacta
    // fecha se colara al frente, el formulario abriría exigiendo una fecha que
    // nadie pactó.
    expect(CONFIRMATION_RESULTS[0]?.code).toBe("sin_respuesta");
    expect(CONFIRMATION_RESULTS[0]?.schedulesFollowup).toBe(false);
  });

  it("un resultado o un canal inventado no pasa", () => {
    expect(confirmationResult("lo_que_sea")).toBeNull();
    expect(isConfirmationChannel("paloma_mensajera")).toBe(false);
    expect(isConfirmationChannel("whatsapp")).toBe(true);
  });
});
