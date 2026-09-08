import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hayConfirmacionExpresaDeAgencia,
  hayPagoQueCompromete,
  notaDeConfirmacionExpresa,
  type BorradorDeAgencia,
} from "@/lib/confirmacion-agencia";
import { SHALOM_MINIMUM_ADVANCE, type PaymentSnapshot } from "@/lib/pickup-key";

/**
 * Cuando los hechos ya confirmaron el pedido y solo faltaba el clic.
 *
 * EL CASO. #AUR176259 pasó diecisiete horas en «Por confirmar · Sin llamar ·
 * Día 0 de 7» con el DNI de la clienta apuntado, la sucursal de Shalom elegida
 * y un Yape de S/ 30 validado. El Master decía «Sin llamar» sobre un pedido en
 * el que la asesora ya había hablado con ella, le había pedido el documento y
 * le había cobrado.
 *
 * POR QUÉ LAS TRES BASTAN, medido sobre los 702 pedidos que llegaron a tenerlas:
 *
 *   entregado    427   60,8 %
 *   en proceso   198   28,2 %
 *   pendiente     74   10,5 %
 *   anulado        2    0,3 %   ← donde confirmar habría sido un error
 *   devuelto       1    0,1 %
 *
 * Tres de 702. El clic que faltaba costaba hasta 69 horas de espera sobre
 * pedidos ya pagados, y dejaba al 36 % de los pedidos de agencia llegando a
 * Preparación sin ninguna gestión registrada.
 */

const borrador = (over: Partial<BorradorDeAgencia> = {}): BorradorDeAgencia => ({
  document: "46033247",
  destiny_terminal_id: 516,
  ...over,
});

const TOTAL = 149;
const pago = (over: Partial<PaymentSnapshot> = {}): PaymentSnapshot => ({
  kind: "adelanto",
  validation_status: "validado",
  order_id: "o1",
  amount: SHALOM_MINIMUM_ADVANCE,
  ...over,
});
const pagoValidado = pago();
const confirma = (b: BorradorDeAgencia | null | undefined, p: readonly PaymentSnapshot[]) =>
  hayConfirmacionExpresaDeAgencia(b, p, TOTAL);

describe("las tres piezas confirman", () => {
  it("documento, agencia y adelanto validado: confirmado", () => {
    expect(confirma(borrador(), [pagoValidado])).toBe(true);
  });

  it("un pago total también compromete", () => {
    expect(
      confirma(borrador(), [pago({ kind: "total", amount: TOTAL })]),
    ).toBe(true);
  });
});

describe("y falta una sola para que no", () => {
  it("sin documento no: puede estar a medio llenar", () => {
    expect(confirma(borrador({ document: null }), [pagoValidado])).toBe(false);
    expect(confirma(borrador({ document: "   " }), [pagoValidado])).toBe(false);
  });

  it("sin sucursal no: no hay a dónde mandar el paquete", () => {
    // El nombre legible sin id no sirve: el id es lo que Shalom entiende.
    expect(
      confirma(borrador({ destiny_terminal_id: null }), [pagoValidado]),
    ).toBe(false);
  });

  it("SIN PAGO no, y es la pieza que carga el peso", () => {
    // El borrador se guarda en cuanto se teclean documento y sucursal, así que
    // sin el dinero la asesora puede estar todavía negociando. Confirmar aquí
    // permitiría imprimir un rótulo para quien no ha dicho que sí.
    expect(confirma(borrador(), [])).toBe(false);
  });

  it("un pago cargado pero SIN validar tampoco confirma", () => {
    // Validar es el acto humano deliberado; la imagen subida es solo una imagen.
    for (const estado of ["pendiente", "revision_admin", "rechazado"]) {
      expect(
        confirma(borrador(), [pago({ validation_status: estado })]),
      ).toBe(false);
    }
  });

  it("sin borrador no hay nada que mirar", () => {
    expect(confirma(null, [pagoValidado])).toBe(false);
    expect(confirma(undefined, [pagoValidado])).toBe(false);
  });
});

describe("cuánto tiene que ser el pago: lo dice quien ya lo sabía", () => {
  it("un adelanto POR DEBAJO del mínimo no confirma", () => {
    // #KP129361 lo delató cuando el mínimo era S/ 30: adelanto de S/ 20 validado
    // sobre un pedido de S/ 149. La primera versión de esta regla lo daba por
    // confirmado, porque preguntaba «¿hay un adelanto validado?» en vez de usar
    // la definición que ya existía. Habría escrito `confirmed` sobre un pedido
    // que `agencyPaymentReady` seguía frenando, dejándolo confirmado y quieto a
    // la vez. Hoy el mínimo es S/ 20 y ese pedido SÍ confirma; la prueba se
    // ancla a la constante para seguir vigilando el caso general.
    expect(confirma(borrador(), [pago({ amount: SHALOM_MINIMUM_ADVANCE - 5 })])).toBe(false);
  });

  it("justo el mínimo sí", () => {
    expect(confirma(borrador(), [pago({ amount: SHALOM_MINIMUM_ADVANCE })])).toBe(true);
  });

  it("y la regla NO reimplementa el mínimo: lo pregunta", () => {
    // Copiar el número acá lo dejaría libre de separarse del de `pickup-key`,
    // que es de donde cuelgan el panel de cobro, la clave de recojo y el paso a
    // Preparación. Es la misma forma del bug que este archivo vino a arreglar.
    const source = readFileSync(
      resolve(process.cwd(), "lib/confirmacion-agencia.ts"),
      "utf8",
    );
    expect(source).toContain("paymentProgress(pagos, totalDelPedido).advanceValidated");
    expect(source).not.toMatch(/\b(20|30)\b\s*[;)]/);
  });
});

describe("qué pagos comprometen", () => {
  it("`diferencia` NO confirma: llega cuando el pedido ya iba en marcha", () => {
    // Un saldo posterior no dice nada nuevo sobre la confirmación: si hay
    // diferencia que cobrar es porque el pedido ya se había confirmado antes.
    expect(hayPagoQueCompromete([pago({ kind: "diferencia" })], TOTAL)).toBe(false);
  });

  it("pero convive: con un adelanto validado al lado, sí", () => {
    expect(
      hayPagoQueCompromete([pago({ kind: "diferencia" }), pagoValidado], TOTAL),
    ).toBe(true);
  });
});

describe("la línea de tiempo dice POR QUÉ", () => {
  it("la nota nombra la evidencia, no solo el resultado", () => {
    // Un pedido que salta a Preparación sin que nadie lo marcara tiene que
    // poder explicarse solo tres meses después.
    const nota = notaDeConfirmacionExpresa("MADRE DE DIOS / TAMBOPATA / AV 15 DE AGOSTO");
    expect(nota).toContain("documento");
    expect(nota).toContain("pago validado");
    expect(nota).toContain("AV 15 DE AGOSTO");
  });

  it("y aguanta que no haya nombre de agencia", () => {
    expect(notaDeConfirmacionExpresa(null)).not.toContain("()");
  });
});

describe("las piezas en el código", () => {
  const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");

  it("las DOS puertas preguntan lo mismo", () => {
    // El pago suele llegar último, pero no siempre: a veces lo validado está y
    // lo que falta es el DNI. Si solo una puerta preguntara, la confirmación
    // dependería del orden en que se hicieron las cosas.
    expect(read("app/dashboard/pedidos/payment-actions.ts")).toContain(
      "registrarConfirmacionExpresaDeAgencia(",
    );
    expect(read("app/dashboard/pedidos/shalom-actions.ts")).toContain(
      "registrarConfirmacionExpresaDeAgencia(",
    );
  });

  it("se escribe un EVENTO, no se deduce al vuelo", () => {
    // La confirmación se pregunta en dos sitios —la macroetapa y el estado
    // operativo legado— y los dos leen `order_events`. Deducirlo en uno solo
    // los haría divergir en silencio, que es el bug que `hasConfirmationSignal`
    // documenta como ya ocurrido.
    const source = read("lib/confirmacion-agencia-access.ts");
    expect(source).toContain('kind: "confirmed"');
    expect(source).toContain('.from("order_events")');
  });

  it("no se le atribuye a nadie la palabra que no dijo", () => {
    // `automatico` y no `manual`: nadie pulsó «Confirmó el pedido».
    expect(read("lib/confirmacion-agencia-access.ts")).toContain('source: "automatico"');
  });

  it("es idempotente contra las MISMAS señales que ya confirman", () => {
    // Si la lista de acá se separara de `CONFIRMATION_SIGNAL_KINDS`, un pedido
    // con rótulo recibiría un segundo `confirmed` cada vez que se toque un pago.
    const source = read("lib/confirmacion-agencia-access.ts");
    expect(source).toContain('.in("kind", ["confirmed", "guide_registered", "label_generated"])');
    const kinds = read("lib/order-confirmation.ts");
    const bloque = kinds.slice(
      kinds.indexOf("export const CONFIRMATION_SIGNAL_KINDS"),
      kinds.indexOf("] as const;", kinds.indexOf("export const CONFIRMATION_SIGNAL_KINDS")),
    );
    for (const k of ["confirmed", "guide_registered", "label_generated"]) {
      expect(bloque).toContain(`"${k}"`);
    }
  });

  it("el MOM lo dice, que es donde manda", () => {
    // CLAUDE.md: una implementación que cambia una regla de negocio actualiza la
    // especificación en el mismo commit.
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("Confirmación expresa de agencia");
    expect(mom).toContain("el dinero es lo que convierte la conversación en compromiso");
  });
});
