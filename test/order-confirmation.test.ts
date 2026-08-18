import { describe, expect, it } from "vitest";
import {
  CONFIRMATION_MAX_DAYS,
  CONFIRMATION_RESULTS,
  confirmationAttemptDetail,
  confirmationDayCount,
  confirmationDays,
  confirmationDueBucket,
  confirmationReminderDueAt,
  confirmationResult,
  confirmationResultLabel,
  hasConfirmationSignal,
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

describe("recordatorios de confirmación", () => {
  it("suma dos horas dentro de la jornada", () => {
    expect(confirmationReminderDueAt("2026-08-18T15:00:00.000Z")).toBe(
      "2026-08-18T17:00:00.000Z",
    );
  });

  it("continúa al día siguiente cuando cruza las 22:00 de Lima", () => {
    // 21:30 Lima: usa 30 minutos hoy y los otros 90 desde las 08:00.
    expect(confirmationReminderDueAt("2026-08-19T02:30:00.000Z")).toBe(
      "2026-08-19T14:30:00.000Z",
    );
  });

  it("un intento fuera de horario empieza a contar a las 08:00", () => {
    expect(confirmationReminderDueAt("2026-08-18T11:00:00.000Z")).toBe(
      "2026-08-18T15:00:00.000Z",
    );
  });

  it("separa vencidos, hoy y próximos por fecha de Lima", () => {
    const now = "2026-08-18T18:00:00.000Z";
    expect(confirmationDueBucket("2026-08-17", now)).toBe("vencido");
    expect(confirmationDueBucket("2026-08-18", now)).toBe("hoy");
    expect(confirmationDueBucket("2026-08-19", now)).toBe("proximo");
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

describe("lo que la línea de tiempo muestra del intento", () => {
  it("saca canal y resultado del payload", () => {
    expect(
      confirmationAttemptDetail({ channel: "mensaje", result: "se_deja_mensaje" }),
    ).toEqual({ channel: "mensaje", result: "se_deja_mensaje" });
  });

  it("un evento que no es un intento no aporta nada", () => {
    // El payload de otros eventos lleva sus propias claves. Devolver un objeto
    // vacío pintaría un «·» suelto en cada entrada de la línea de tiempo.
    expect(confirmationAttemptDetail(undefined)).toBeNull();
    expect(confirmationAttemptDetail(null)).toBeNull();
    expect(confirmationAttemptDetail({})).toBeNull();
    expect(confirmationAttemptDetail({ next_contact_on: "2026-08-10" })).toBeNull();
  });

  it("un payload a medias sigue sirviendo para lo que sí trae", () => {
    expect(confirmationAttemptDetail({ result: "confirmado" })).toEqual({
      channel: null,
      result: "confirmado",
    });
    expect(confirmationAttemptDetail({ channel: "llamada" })).toEqual({
      channel: "llamada",
      result: null,
    });
  });

  it("ignora lo que no sea texto", () => {
    expect(confirmationAttemptDetail({ channel: 7, result: null })).toBeNull();
  });

  it("nombra el resultado, y si el código ya no está en el catálogo lo muestra igual", () => {
    // Los hechos no se reescriben (§2.6): un intento guardado con un resultado
    // que después se retire tiene que seguir siendo legible en el historial.
    expect(confirmationResultLabel("pendiente_de_abono")).toBe("Pendiente de abono");
    expect(confirmationResultLabel("resultado_retirado")).toBe("resultado_retirado");
    expect(confirmationResultLabel(null)).toBeNull();
  });
});

// La confirmación tenía CUATRO implementaciones y ya habían divergido. Estas
// pruebas fijan la única definición y la frontera que la mantiene honesta: la
// evidencia se responde aquí, la política de Lima se aplica en su llamador.
describe("hasConfirmationSignal", () => {
  it("una guía existente confirma: es el acto logístico dando la llamada por hecha", () => {
    expect(hasConfirmationSignal({ hasGuide: true, events: [] })).toBe(true);
  });

  it("la palabra del asesor confirma", () => {
    expect(
      hasConfirmationSignal({ hasGuide: false, events: [{ kind: "confirmed" }] }),
    ).toBe(true);
  });

  it("registrar la guía o el rótulo confirma aunque no exista todavía la fila de guía", () => {
    // Es justo la divergencia que tenía `order-status`: miraba solo `confirmed`
    // y el pago, así que estos dos eventos lo dejaban en «sin confirmar».
    for (const kind of ["guide_registered", "label_generated"]) {
      expect(hasConfirmationSignal({ hasGuide: false, events: [{ kind }] })).toBe(true);
    }
  });

  it("un pedido pagado en Shopify no espera llamada", () => {
    expect(
      hasConfirmationSignal({ hasGuide: false, events: [], financialStatus: "PAID" }),
    ).toBe(true);
  });

  it("sin ninguna señal, no hay confirmación", () => {
    expect(
      hasConfirmationSignal({
        hasGuide: false,
        events: [{ kind: "confirmation_contact" }],
        financialStatus: "pending",
      }),
    ).toBe(false);
  });

  it("no sabe nada de Lima: la exención es política de macroetapa, no evidencia", () => {
    // Si la exención viviera aquí, el estado operativo legado daría por
    // confirmados a los pedidos de Lima que nadie llamó.
    expect(hasConfirmationSignal({ hasGuide: false, events: [] })).toBe(false);
  });
});
