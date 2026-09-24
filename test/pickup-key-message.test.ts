import { describe, expect, it } from "vitest";
import {
  KEY_MASK,
  KEY_SEND_WINDOW_HOURS,
  keySendWindowOpen,
  pickupKeyMessage,
} from "@/lib/pickup-key-message";
import { validationReleasesPickupKey, type PickupKeyContext } from "@/lib/pickup-key";

const FACTS = {
  customerName: "JUSTINA ROSA CARBAJAL ANYAIPOMA",
  orderName: "#KP134730",
  agencyName: "Huancayo",
  guideCode: "96212898",
};

describe("el mensaje con el que sale la clave", () => {
  it("lleva la clave, la agencia y el DNI, sin fechas ni amenazas", () => {
    const texto = pickupKeyMessage(FACTS, "ABC123");
    expect(texto).toContain("*ABC123*");
    expect(texto).toContain("Huancayo");
    expect(texto).toContain("DNI");
    expect(texto).toContain("96212898");
    // La misma decisión que el aviso de llegada: nada de plazos ni avisos de
    // devolución. El plazo de la agencia ya se lo recuerda Shalom.
    expect(texto).not.toMatch(/vence|plazo|devol|último día/i);
  });

  it("saluda por el primer nombre, no por el nombre completo a gritos", () => {
    expect(pickupKeyMessage(FACTS, "X")).toContain("¡Listo, Justina!");
  });

  it("sin nombre no se saluda a nadie, y sin agencia no se inventa una", () => {
    const texto = pickupKeyMessage(
      { customerName: null, orderName: null, agencyName: null, guideCode: null },
      "X",
    );
    expect(texto).toContain("✅ ¡Listo!");
    expect(texto).toContain("la agencia Shalom donde llegó tu pedido");
  });

  it("la vista previa es el MISMO texto con la clave tapada", () => {
    // Es la razón de que la plantilla esté en un solo sitio: la pantalla enseña
    // lo que se va a mandar, no una imitación que se queda vieja.
    const real = pickupKeyMessage(FACTS, "ABC123");
    const previa = pickupKeyMessage(FACTS, KEY_MASK);
    expect(previa).toBe(real.replace("ABC123", KEY_MASK));
    expect(previa).not.toContain("ABC123");
  });
});

describe("la ventana de 24 h de WhatsApp", () => {
  const ahora = "2026-09-21T12:00:00Z";
  const haceHoras = (h: number) => new Date(Date.parse(ahora) - h * 3600_000).toISOString();

  it("abierta mientras la clienta escribió dentro de la ventana", () => {
    expect(keySendWindowOpen(haceHoras(1), ahora)).toBe(true);
    expect(keySendWindowOpen(haceHoras(KEY_SEND_WINDOW_HOURS - 0.5), ahora)).toBe(true);
  });

  it("cerrada pasadas las horas: fuera de ahí haría falta una plantilla", () => {
    expect(keySendWindowOpen(haceHoras(KEY_SEND_WINDOW_HOURS + 0.5), ahora)).toBe(false);
  });

  it("sin constancia de que escribiera, NO se asume abierta", () => {
    // Equivocarse aquí es un envío rechazado que el equipo da por bueno: la
    // clienta se queda esperando una clave que nunca salió.
    expect(keySendWindowOpen(null, ahora)).toBe(false);
    expect(keySendWindowOpen("no es una fecha", ahora)).toBe(false);
  });
});

describe("qué comprobante hace que la clave pueda salir sola", () => {
  const base: PickupKeyContext = {
    orderId: "ord-1",
    generalStatus: "en_proceso",
    pickupState: "disponible_para_recojo",
    orderTotal: 149,
    hasKey: true,
    payments: [
      { id: "adel", kind: "adelanto", validation_status: "validado", order_id: "ord-1", amount: 30 },
      {
        id: "dif",
        kind: "diferencia",
        validation_status: "pendiente_revision",
        order_id: "ord-1",
        amount: 119,
      },
    ],
  };

  it("el que termina de cubrir el pedido, sí", () => {
    expect(validationReleasesPickupKey(base, "dif")).toBe(true);
  });

  it("un adelanto ya validado no libera nada: no es «se validó un pago»", () => {
    expect(validationReleasesPickupKey(base, "adel")).toBe(false);
  });

  it("el listón es lo VALIDADO, no lo cargado", () => {
    // `canRevealPickupKey` abre la clave con los comprobantes cargados, y está
    // bien: ahí hay una persona mirando antes de dictarla. Para que salga sola
    // no basta — si no, un comprobante recién llegado por WhatsApp mandaría la
    // clave sin que nadie hubiera mirado la imagen.
    const sinValidar: PickupKeyContext = {
      ...base,
      payments: base.payments.map((p) => ({ ...p, validation_status: "pendiente_revision" })),
    };
    expect(validationReleasesPickupKey(sinValidar, "dif")).toBe(false);
  });

  it("con el paquete todavía en camino, TAMBIÉN libera: pagado entero no espera", () => {
    // #KP135533: la clienta pagó el saldo con el paquete en tránsito, se validó
    // y la clave no salió porque llegaba al día siguiente. Al validar, además,
    // la clienta acaba de escribir: es cuando la ventana de 24 h está abierta.
    expect(validationReleasesPickupKey({ ...base, pickupState: "en_transito" }, "dif")).toBe(true);
  });

  it("sin clave registrada no hay nada que enviar", () => {
    expect(validationReleasesPickupKey({ ...base, hasKey: false }, "dif")).toBe(false);
  });

  it("si el dinero todavía no alcanza, no libera", () => {
    expect(validationReleasesPickupKey({ ...base, orderTotal: 300 }, "dif")).toBe(false);
  });

  it("si la clave YA estaba liberada, este pago no libera nada", () => {
    // Si no, validar un comprobante de más mandaría la clave por segunda vez
    // sin que nada haya cambiado.
    const yaLiberada: PickupKeyContext = {
      ...base,
      payments: [
        { id: "total", kind: "total", validation_status: "validado", order_id: "ord-1", amount: 149 },
        { id: "extra", kind: "diferencia", validation_status: "pendiente_revision", order_id: "ord-1", amount: 10 },
      ],
    };
    expect(validationReleasesPickupKey(yaLiberada, "extra")).toBe(false);
  });

  it("un comprobante que no es de este pedido no decide nada", () => {
    expect(validationReleasesPickupKey(base, "otro-pago")).toBe(false);
  });
});

describe("el mensaje cuando el paquete todavía va en camino", () => {
  const facts = {
    customerName: "Alvina Rodríguez",
    orderName: "#KP135533",
    agencyName: "Motupe",
    guideCode: "96687586",
  };

  it("da la clave pero no la manda a una agencia donde el paquete aún no está", () => {
    const texto = pickupKeyMessage({ ...facts, atAgency: false }, "1234");
    expect(texto).toContain("*1234*");
    expect(texto).toContain("va en camino a la agencia Shalom de Motupe");
    expect(texto).toContain("Cuando llegue");
    expect(texto).not.toContain("Preséntala con tu DNI en la agencia");
  });

  it("si ya llegó, dice que vaya", () => {
    expect(pickupKeyMessage({ ...facts, atAgency: true }, "1234")).toContain(
      "Preséntala con tu DNI en la agencia Shalom de Motupe para recoger tu pedido.",
    );
  });

  it("sin saber dónde está, se asume que llegó: es lo que ya decía", () => {
    expect(pickupKeyMessage(facts, "1234")).toContain("para recoger tu pedido.");
  });
});
