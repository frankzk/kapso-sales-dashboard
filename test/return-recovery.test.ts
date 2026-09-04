import { describe, expect, it, vi } from "vitest";
import {
  amountLabel,
  buildRecoveryQueue,
  firstName,
  parseRecoveryParams,
  recoveryBodyParams,
  recoveryConfig,
  recoveryOrderName,
  recoverySkipReason,
  RECOVERY_SKIP_NO_ORDER,
  recoveryWithinHours,
  sendRecoveryTemplate,
  wasRefusedInPerson,
  type RecoveryCandidate,
} from "@/lib/return-recovery";

// Un instante FIJO, y no el reloj de la máquina. Las pruebas de envío que no lo
// fijaban pasaron meses en verde y se pusieron rojas solas el 4-sep-2026: la
// guía de la muestra volvió el 5-ago y la ventana es de 30 días, así que al
// cruzarse el plazo el candidato dejó de ser elegible y el envío ni se intentaba.
// Una prueba que depende de qué día se ejecuta no comprueba lo que dice comprobar.
const NOW_ISO = "2026-08-08T15:00:00Z";
const NOW = Date.parse(NOW_ISO);
const OPTS = { nowMs: NOW, maxDays: 30 };

function candidate(over: Partial<RecoveryCandidate> = {}): RecoveryCandidate {
  return {
    id: "s1",
    courier: "aliclik",
    guide_code: "ALI0115026",
    order_name: "#KP123499",
    // Enlazada por defecto: sin pedido la guía no es elegible (ver el bloque
    // "sin pedido enlazado"), y el resto de pruebas mira otras exclusiones.
    order_id: "ord-1",
    // El nombre del pedido ENLAZADO. Es lo único que la plantilla puede
    // mostrarle a la clienta: `order_name` de arriba es una copia y no se usa.
    order: { name: "#KP123499" },
    customer_name: "Jose Pio Padilla",
    customer_phone: "51987654321",
    product: "Nails Repairing — Sérum Tea Tree Ginger para Uñas (30ml)",
    district: "Juliaca",
    province: "San Roman",
    reported_collect_amount: 89,
    returned_at: "2026-08-05T12:00:00Z",
    returned_source: "aliclik_report",
    reported_status: "NO CONTESTA",
    non_delivery_reason: null,
    recovery_state: null,
    recovery_sent_at: null,
    ...over,
  };
}

describe("wasRefusedInPerson", () => {
  it("reconoce el rechazo en los dos idiomas del reporte", () => {
    // El Excel guarda el ESTADO ENTREGA en español…
    expect(wasRefusedInPerson("RECHAZADO", null)).toBe(true);
    // …y la API guarda los enums en inglés unidos por " · ".
    expect(wasRefusedInPerson("REFUSED · RETURNED · CONFIRMED", null)).toBe(true);
  });

  it("no confunde un no-contesta con un rechazo", () => {
    expect(wasRefusedInPerson("NO CONTESTA", null)).toBe(false);
    expect(wasRefusedInPerson("NOT_RESPOND · RETURNED", null)).toBe(false);
    expect(wasRefusedInPerson("CANCELADO", null)).toBe(false);
    expect(wasRefusedInPerson(null, null)).toBe(false);
  });

  it("también mira el motivo que anotó quien gestionó", () => {
    expect(wasRefusedInPerson("CANCELADO", "cliente rechazó el producto en la puerta")).toBe(true);
  });
});

describe("recoverySkipReason", () => {
  it("deja pasar una devolución fresca de provincia sin rechazo", () => {
    expect(recoverySkipReason(candidate(), OPTS)).toBeNull();
  });

  it("aplica la regla del MOM §11: quien la vio y la rechazó queda fuera", () => {
    expect(recoverySkipReason(candidate({ reported_status: "RECHAZADO" }), OPTS)).toBe(
      "la rechazó viendo el producto (MOM §11)",
    );
  });

  it("no recupera lo que nunca volvió", () => {
    expect(recoverySkipReason(candidate({ returned_at: null }), OPTS)).toBe("la guía no volvió");
  });

  it("una devolución sellada a mano SÍ entra a la cola (0118)", () => {
    // El paquete sobre la mesa del almacén es tan real como un CSV. La
    // procedencia no excluye: se muestra, y quien decide decide. Excluirla
    // dejaría fuera justamente los casos que Aliclik no reporta, que son los que
    // obligaron a sellar a mano.
    expect(recoverySkipReason(candidate({ returned_source: "manual" }), OPTS)).toBeNull();
  });

  it("solo recupera contraentrega de provincia", () => {
    // Una devolución de agencia ya se pagó por adelantado: no hay adelanto que
    // proponer, así que el mensaje no tendría sentido.
    expect(recoverySkipReason(candidate({ courier: "shalom" }), OPTS)).toContain(
      "no es contraentrega de provincia",
    );
  });

  it("descarta números que no son WhatsApp peruano válido", () => {
    expect(recoverySkipReason(candidate({ customer_phone: "987654321" }), OPTS)).toBe(
      "sin número de WhatsApp válido",
    );
    expect(recoverySkipReason(candidate({ customer_phone: null }), OPTS)).toBe(
      "sin número de WhatsApp válido",
    );
  });

  it("no manda plantillas con huecos", () => {
    expect(recoverySkipReason(candidate({ customer_name: "  " }), OPTS)).toBe(
      "sin nombre de la clienta",
    );
    expect(recoverySkipReason(candidate({ product: null }), OPTS)).toBe("sin producto en la guía");
  });

  it("no le escribe a una devolución vieja", () => {
    const vieja = candidate({ returned_at: "2026-05-01T12:00:00Z" });
    expect(recoverySkipReason(vieja, OPTS)).toBe("devuelta hace más de 30 días");
  });

  it("respeta lo ya hecho", () => {
    expect(recoverySkipReason(candidate({ recovery_state: "enviado" }), OPTS)).toBe(
      "ya se le escribió",
    );
    expect(recoverySkipReason(candidate({ recovery_state: "descartado" }), OPTS)).toBe(
      "descartada a mano",
    );
  });
});

describe("parámetros de la plantilla", () => {
  it("saluda con el primer nombre, no con el nombre del rótulo", () => {
    expect(firstName("JOSE PIO PADILLA")).toBe("Jose");
    expect(firstName("  luis  ")).toBe("Luis");
    expect(firstName(null)).toBe("");
  });

  it("formatea el monto como el resto del sistema", () => {
    expect(amountLabel(89)).toBe("S/ 89.00");
    expect(amountLabel(null)).toBe("");
    expect(amountLabel(0)).toBe("");
  });

  it("ignora tokens que no existen en vez de romper el envío", () => {
    expect(parseRecoveryParams("nombre, producto , monto")).toEqual([
      "nombre",
      "producto",
      "monto",
    ]);
    expect(parseRecoveryParams("nombre,inventado,monto")).toEqual(["nombre", "monto"]);
    expect(parseRecoveryParams("")).toEqual([]);
  });

  it("resuelve los parámetros en el orden configurado", () => {
    const params = recoveryBodyParams(["nombre", "producto", "monto"], candidate());
    expect(params).toEqual([
      "Jose",
      "Nails Repairing — Sérum Tea Tree Ginger para Uñas (30ml)",
      "S/ 89.00",
    ]);
  });

  it("el orden es el de la config, no uno fijo", () => {
    expect(recoveryBodyParams(["monto", "nombre"], candidate())).toEqual(["S/ 89.00", "Jose"]);
  });

  it("devuelve null si algún parámetro quedaría vacío", () => {
    // Meta rechaza el envío con #132018 y el toque se perdería igual.
    expect(recoveryBodyParams(["nombre", "monto"], candidate({ reported_collect_amount: null })))
      .toBeNull();
    expect(recoveryBodyParams([], candidate())).toBeNull();
  });
});

describe("recoveryWithinHours", () => {
  it("no escribe de madrugada en hora de Lima", () => {
    // 08:00Z = 03:00 en Lima.
    expect(recoveryWithinHours("2026-08-08T08:00:00Z", "America/Lima", 8, 21)).toBe(false);
    // 15:00Z = 10:00 en Lima.
    expect(recoveryWithinHours("2026-08-08T15:00:00Z", "America/Lima", 8, 21)).toBe(true);
    // 02:00Z = 21:00 del día anterior en Lima — el borde superior no entra.
    expect(recoveryWithinHours("2026-08-09T02:00:00Z", "America/Lima", 8, 21)).toBe(false);
  });
});

describe("buildRecoveryQueue", () => {
  it("pone lo elegible primero y lo más reciente arriba", () => {
    const rows = [
      candidate({ id: "vieja", returned_at: "2026-08-01T12:00:00Z" }),
      candidate({ id: "rechazada", reported_status: "RECHAZADO" }),
      candidate({ id: "fresca", returned_at: "2026-08-07T12:00:00Z" }),
    ];
    const queue = buildRecoveryQueue(rows, OPTS);
    expect(queue.map((r) => r.id)).toEqual(["fresca", "vieja", "rechazada"]);
    expect(queue[2]!.skip).toBe("la rechazó viendo el producto (MOM §11)");
  });
});

describe("sin pedido enlazado", () => {
  it("no se le escribe: la plantilla nombra el pedido y no habría cuál", () => {
    // El token `pedido` caía al código de guía cuando faltaba el nombre, así que
    // a la clienta le llegaba "por tu pedido AUR5X…", que ella no ha visto nunca.
    expect(recoverySkipReason(candidate({ order_id: null, order: null }), OPTS)).toBe(
      RECOVERY_SKIP_NO_ORDER,
    );
  });

  it("mira el ENLACE, no el texto: un nombre inventado no basta", () => {
    // Durante meses el importador escribía nombres con el prefijo de otra tienda
    // (ver 0115). Ese texto pasaría un filtro sobre `order_name`; el enlace no.
    // Medido el 2026-08-21: en 18 guías la copia DIFIERE del pedido enlazado.
    expect(
      recoverySkipReason(
        candidate({ order_id: null, order: null, order_name: "#KP115389" }),
        OPTS,
      ),
    ).toBe(RECOVERY_SKIP_NO_ORDER);
  });

  it("EL CASO REAL: enlace puesto y la copia vacía — antes se enviaba mal", () => {
    // 602 guías así el 2026-08-21, 134 devueltas y dentro de la ventana. El
    // filtro miraba `order_id` y las daba por buenas; el token miraba
    // `order_name`, lo encontraba vacío y mandaba el código del courier.
    // La pantalla, mientras tanto, escribía «sin pedido» al lado del botón.
    const c = candidate({ order_name: null, order: { name: "#KP126289" } });
    expect(recoverySkipReason(c, OPTS)).toBeNull();
    expect(recoveryOrderName(c)).toBe("#KP126289");
  });

  it("enlace puesto pero el pedido sin nombre: tampoco se escribe", () => {
    // No pasa hoy (0 de 7 099 guías enlazadas), pero si pasara no hay nada que
    // enseñarle a la clienta y el silencio es la respuesta correcta.
    expect(
      recoverySkipReason(candidate({ order: { name: null } }), OPTS),
    ).toBe(RECOVERY_SKIP_NO_ORDER);
  });

  it("la copia NUNCA gana sobre el enlace", () => {
    // El caso de las 18: la guía dice un pedido y el enlace dice otro. Manda el
    // enlace, porque la copia pudo escribirla el importador a ojo.
    //
    // La firma de `recoveryOrderName` ni siquiera recibe `order_name`, así que
    // esto no depende de que nadie se acuerde: el compilador lo impide.
    expect(
      recoveryOrderName(candidate({ order_name: "#KP115389", order: { name: "#AUR174734" } })),
    ).toBe("#AUR174734");
  });

  it("va la última: una exclusión que no se puede resolver tiene prioridad", () => {
    // Sin pedido Y rechazada en la puerta → manda el MOM §11, porque enlazar el
    // pedido no la volvería elegible y ofrecer el botón sería mentir.
    const r = recoverySkipReason(
      candidate({ order_id: null, reported_status: "RECHAZADO" }),
      OPTS,
    );
    expect(r).toBe("la rechazó viendo el producto (MOM §11)");
  });

  it("con pedido enlazado y todo lo demás en orden, es elegible", () => {
    expect(recoverySkipReason(candidate(), OPTS)).toBeNull();
  });
});

describe("recoveryConfig", () => {
  const base = {
    return_recovery_enabled: true,
    return_recovery_template_name: "recuperacion_pedido_retornado",
    return_recovery_template_language: "es",
    return_recovery_params: "nombre,producto,monto",
    kapso_api_key: "k",
    whatsapp_phone_number_id: "123",
  } as any;

  it("resuelve la config cuando la tienda está completa", () => {
    expect(recoveryConfig(base)).toMatchObject({
      templateName: "recuperacion_pedido_retornado",
      language: "es",
      tokens: ["nombre", "producto", "monto"],
    });
  });

  it("no envía si falta cualquier pieza", () => {
    expect(recoveryConfig({ ...base, return_recovery_enabled: false })).toBeNull();
    expect(recoveryConfig({ ...base, return_recovery_template_name: null })).toBeNull();
    expect(recoveryConfig({ ...base, kapso_api_key: null })).toBeNull();
    expect(recoveryConfig({ ...base, whatsapp_phone_number_id: null })).toBeNull();
    // Sin ningún token válido no hay cuerpo que armar.
    expect(recoveryConfig({ ...base, return_recovery_params: "inventado" })).toBeNull();
  });

  // ── Número propio (0114) ──────────────────────────────────────────────────
  // Solo este envío puede salir de otra línea. El drip y los carritos siguen
  // usando el de la clienta, y esta columna no los toca.

  it("sin número propio sale del número de la tienda", () => {
    expect(recoveryConfig(base)).toMatchObject({ phoneNumberId: "123" });
  });

  it("con número propio sale de ESE, no del de la tienda", () => {
    expect(
      recoveryConfig({ ...base, return_recovery_phone_number_id: "630" }),
    ).toMatchObject({ phoneNumberId: "630" });
  });

  it("vaciarlo devuelve el envío al número de la tienda: es la marcha atrás", () => {
    expect(
      recoveryConfig({ ...base, return_recovery_phone_number_id: "" }),
    ).toMatchObject({ phoneNumberId: "123" });
    // Solo espacios cuenta como vacío; si no, un descuido dejaría la config
    // apuntando a un número inexistente y Meta respondería 132001.
    expect(
      recoveryConfig({ ...base, return_recovery_phone_number_id: "   " }),
    ).toMatchObject({ phoneNumberId: "123" });
  });

  it("el número propio basta por sí solo, sin número de tienda", () => {
    expect(
      recoveryConfig({
        ...base,
        whatsapp_phone_number_id: null,
        return_recovery_phone_number_id: "630",
      }),
    ).toMatchObject({ phoneNumberId: "630" });
  });
});

// ── El envío ────────────────────────────────────────────────────────────────

/** Supabase de mentira: registra los inserts y los updates para poder afirmar
 *  sobre ellos sin base de datos. */
function fakeAdmin() {
  const inserts: { table: string; row: any }[] = [];
  const updates: { table: string; patch: any }[] = [];
  return {
    inserts,
    updates,
    from(table: string) {
      return {
        insert(row: any) {
          inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
        update(patch: any) {
          updates.push({ table, patch });
          const chain: any = {
            eq: () => chain,
            is: () => Promise.resolve({ error: null }),
          };
          return chain;
        },
      };
    },
  } as any;
}

const CFG = {
  templateName: "recuperacion_pedido_retornado",
  language: "es",
  tokens: ["nombre", "producto", "monto"] as const,
  phoneNumberId: "123",
  apiKey: "k",
} as any;

describe("sendRecoveryTemplate", () => {
  it("envía con los parámetros resueltos y marca la guía", async () => {
    const admin = fakeAdmin();
    const send = vi.fn().mockResolvedValue({ ok: true, id: "wamid.1" });
    const res = await sendRecoveryTemplate(admin, "store", candidate(), CFG, {
      maxDays: 30,
      nowIso: NOW_ISO,
      sendTemplate: send,
      sentBy: "user-1",
    });

    expect(res.ok).toBe(true);
    expect(send).toHaveBeenCalledWith(
      { apiKey: "k" },
      expect.objectContaining({
        to: "51987654321",
        templateName: "recuperacion_pedido_retornado",
        language: "es",
        bodyParams: ["Jose", expect.stringContaining("Nails Repairing"), "S/ 89.00"],
      }),
    );
    expect(admin.updates).toEqual([
      {
        table: "shipments",
        patch: { recovery_state: "enviado", recovery_sent_at: "2026-08-08T15:00:00Z" },
      },
    ]);
    expect(admin.inserts[0]).toMatchObject({
      table: "return_recovery_sends",
      row: { ok: true, sent_by: "user-1", template_name: "recuperacion_pedido_retornado" },
    });
  });

  it("un rechazo de Meta deja la guía en la cola y guarda el motivo", async () => {
    const admin = fakeAdmin();
    const send = vi.fn().mockResolvedValue({ ok: false, error: "template paused", code: 132015 });
    const res = await sendRecoveryTemplate(admin, "store", candidate(), CFG, {
      nowIso: NOW_ISO,
      maxDays: 30,
      sendTemplate: send,
    });

    expect(res.ok).toBe(false);
    // Lo importante: NO se marcó como enviada, así que vuelve a salir.
    expect(admin.updates).toEqual([]);
    expect(admin.inserts[0]!.row).toMatchObject({ ok: false, error: "template paused" });
  });

  it("no envía dos veces a la misma guía aunque el botón venga de una pantalla vieja", async () => {
    const admin = fakeAdmin();
    const send = vi.fn();
    const res = await sendRecoveryTemplate(
      admin,
      "store",
      candidate({ recovery_state: "enviado" }),
      CFG,
      { nowIso: NOW_ISO, maxDays: 30, sendTemplate: send },
    );

    expect(res).toEqual({ ok: false, error: "ya se le escribió" });
    expect(send).not.toHaveBeenCalled();
    expect(admin.inserts).toEqual([]);
  });

  it("no le escribe a quien rechazó el producto, venga de donde venga la orden", async () => {
    const admin = fakeAdmin();
    const send = vi.fn();
    const res = await sendRecoveryTemplate(
      admin,
      "store",
      candidate({ reported_status: "RECHAZADO" }),
      CFG,
      { nowIso: NOW_ISO, maxDays: 30, sendTemplate: send },
    );

    expect(res.ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("un fallo de red no queda sin rastro", async () => {
    const admin = fakeAdmin();
    const send = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const res = await sendRecoveryTemplate(admin, "store", candidate(), CFG, {
      nowIso: NOW_ISO,
      maxDays: 30,
      sendTemplate: send,
    });

    expect(res.ok).toBe(false);
    expect(admin.inserts[0]!.row).toMatchObject({ ok: false, error: "socket hang up" });
    expect(admin.updates).toEqual([]);
  });
});
