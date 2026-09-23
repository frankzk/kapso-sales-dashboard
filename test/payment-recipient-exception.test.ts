import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  motivoDelDesencuentro,
  yapeRecipientReadingFromVision,
  type CollectionAccount,
} from "@/lib/yape-recipient";

/**
 * «Si no, se va a quedar ahí de por vida.»
 *
 * #KP126085, cargado el 03-08-2026 y todavía en la bandeja siete semanas
 * después. El lector leyó el destinatario como «Cerdo Gf S.a.c.» —por «Grupo Gf
 * S.a.c.»— y eso basta para `mismatch`, que cierra el botón de validar tanto en
 * la pantalla como en el servidor. Pero el CELULAR receptor lo leyó bien: ···309
 * es la cuenta de la empresa.
 *
 * No había salida. La única acción disponible era «Rechazar», que habría sido
 * falsa: el dinero llegó.
 */

const CUENTAS: CollectionAccount[] = [
  { name: "Grupo GF S.A.C.", phoneLastDigits: "309" },
  { name: "Gabriela Reaño Vera", phoneLastDigits: "147" },
  {
    name: "Frankz Alberto Paolo Kastner Cam",
    aliases: ["Kastner Cam Frankz Alberto Paolo"],
    phoneLastDigits: "481",
  },
];

const vision = (recipient_name: string | null, recipient_phone_last_digits: string | null) => ({
  extracted: { recipient_name, recipient_phone_last_digits },
});

describe("el aviso dice QUÉ señal falló, no «una de las dos»", () => {
  /** El caso real: una palabra mal leída, el celular correcto. */
  it("cuando el celular sí es nuestro, lo dice y manda a mirar el nombre", () => {
    const reading = yapeRecipientReadingFromVision(vision("Cerdo Gf S.a.c.", "309"), CUENTAS);
    expect(reading.status).toBe("mismatch");

    const motivo = motivoDelDesencuentro(reading, CUENTAS)!;
    expect(motivo).toContain("···309");
    expect(motivo).toContain("SÍ es el de Grupo GF S.A.C.");
    expect(motivo).toContain("Cerdo Gf S.a.c.");
    // Y da las dos lecturas posibles, que es lo que decide quien mira.
    expect(motivo).toContain("lectura mala");
    expect(motivo).toContain("no es nuestro");
  });

  /**
   * LA OTRA MITAD, Y POR QUÉ NO SE PUEDE AFLOJAR LA REGLA POR CELULAR.
   * #AUR177034 tiene el celular ···309 —el nuestro— y de nombre «Rosa campos
   * Mendoza». Validar por celular habría dejado pasar ese sin que nadie lo
   * mirara. El aviso es el mismo y eso es correcto: los dos necesitan ojos.
   */
  it("el mismo aviso sale con un nombre ajeno y nuestro celular", () => {
    const reading = yapeRecipientReadingFromVision(vision("Rosa campos Mendoza", "309"), CUENTAS);
    expect(reading.status).toBe("mismatch");
    expect(motivoDelDesencuentro(reading, CUENTAS)).toContain("···309");
  });

  /** #KP110299: el nombre encaja, el celular no. Esa señal es tajante. */
  it("cuando el celular no es de ninguna cuenta, lo dice sin matices", () => {
    const reading = yapeRecipientReadingFromVision(vision("Grupo Gf S.a.c.", "109"), CUENTAS);
    expect(reading.status).toBe("mismatch");
    const motivo = motivoDelDesencuentro(reading, CUENTAS)!;
    expect(motivo).toContain("···109");
    expect(motivo).toContain("tajante");
    expect(motivo).toContain("rechaza");
  });

  it("no inventa un motivo cuando no hay nada que desmentir", () => {
    for (const [nombre, cel] of [
      ["Grupo Gf S.a.c.", "309"],
      ["Grupo Gf S", "309"],
      [null, null],
    ] as const) {
      const reading = yapeRecipientReadingFromVision(vision(nombre, cel), CUENTAS);
      expect(motivoDelDesencuentro(reading, CUENTAS), `${nombre} / ${cel}`).toBeNull();
    }
  });
});

describe("la excepción vive dentro de validatePayment, no en una acción aparte", () => {
  const src = readFileSync(
    resolve(process.cwd(), "app/dashboard/pedidos/payment-actions.ts"),
    "utf8",
  );
  const validate = (() => {
    const start = src.indexOf("export async function validatePayment(");
    expect(start, "no se encontró validatePayment").toBeGreaterThan(0);
    const end = src.indexOf("\nexport async function ", start + 1);
    return src.slice(start, end === -1 ? undefined : end);
  })();

  /**
   * POR QUÉ NO SE REUTILIZÓ `overridePaymentValidation`, que ya sabía escribir
   * `validation_status = 'validado'`: por ese camino el pago quedaba sin
   * `validated_by`, sin `validated_at`, sin asiento de liquidación y sin la
   * confirmación de agencia — y saltándose las dos barreras que protegen el
   * dinero. Un pago «validado» así es peor que el atasco.
   */
  it("la excepción NO se salta el nº de operación ni los cuatro ojos", () => {
    const excepcion = validate.indexOf("const recipientException =");
    const operacion = validate.indexOf("if (!payment.operation_number) {");
    const cuatroOjos = validate.indexOf("typedTheOperationNumber(");
    expect(operacion).toBeGreaterThan(-1);
    expect(cuatroOjos).toBeGreaterThan(-1);
    // Las dos barreras se evalúan ANTES, así que ninguna excepción las alcanza.
    expect(excepcion).toBeGreaterThan(operacion);
    expect(excepcion).toBeGreaterThan(cuatroOjos);
  });

  it("y por tanto hace todo lo que hace una validación normal", () => {
    for (const parte of [
      "validated_by: ctx.userId",
      "validated_at:",
      "ajustarLiquidacionDelCobro(",
      "registrarConfirmacionExpresaDeAgencia(",
      "recomputeOrderMasterSafe(",
    ]) {
      expect(validate, parte).toContain(parte);
    }
  });

  it("exige permiso de administrador para levantarla", () => {
    expect(validate).toContain('perms.can("shalom.override_payment_validation")');
  });

  it("y deja su propio evento, listable, con la lectura que se saltó", () => {
    expect(validate).toContain('kind: "payment_recipient_exception"');
    expect(validate).toContain("reason: recipientException");
    expect(validate).toContain("nombre_leido: recipient.name");
    expect(validate).toContain("celular_leido: recipient.phoneLastDigits");
  });

  it("sin motivo escrito, el bloqueo sigue cerrado", () => {
    expect(validate).toContain("if (!recipientException) {");
  });
});

describe("la bandeja ofrece la salida", () => {
  const board = readFileSync(resolve(process.cwd(), "components/payment-review-board.tsx"), "utf8");
  const access = readFileSync(resolve(process.cwd(), "lib/payment-review-access.ts"), "utf8");

  it("el permiso se decide en el servidor y viaja con el tablero", () => {
    expect(access).toContain("canOverrideRecipient");
    expect(access).toContain('can("shalom.override_payment_validation")');
  });

  it("el botón solo se dibuja para quien puede, y exige motivo", () => {
    expect(board).toContain("canOverrideRecipient");
    expect(board).toContain("recipientExceptionReason: recipientReason");
    expect(board).toContain("disabled={pending || !recipientReason.trim()}");
  });

  it("y quien no puede se entera de que existe la salida", () => {
    expect(board).toContain("un administrador puede validarlo");
  });
});
