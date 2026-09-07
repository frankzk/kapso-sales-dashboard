// Confirmación EXPRESA de agencia: cuando los hechos ya dijeron que sí.
//
// EL CASO. #AUR176259 se quedó en «Por confirmar · Sin llamar · Día 0 de 7»
// diecisiete horas con el DNI de la clienta apuntado, la sucursal de Shalom
// elegida (Tambopata · Av 15 de Agosto) y un Yape de S/ 30 validado. El Master
// decía «Sin llamar» sobre un pedido en el que la asesora ya había hablado con
// ella, le había pedido el documento y le había cobrado.
//
// POR QUÉ LAS TRES JUNTAS BASTAN. Ninguna de las tres se consigue sin la clienta
// al teléfono, y la del pago no se consigue sin que además mande dinero. El
// propio código ya lo decía en `shalom-actions.ts`: «quien cobró tenía a la
// clienta al teléfono y el DNI a mano». Validar el comprobante es, encima, un
// acto humano deliberado de alguien con permiso de `payments.validate`, sobre
// una imagen que se coteja contra la cuenta de cobro. Eso no es una pista: es
// una declaración, y estaba pidiéndose otra vez en forma de clic.
//
// MEDIDO ANTES DE ESCRIBIRLO, sobre los 702 pedidos que llegaron a tener las
// tres cosas:
//
//   entregado    427   60,8 %
//   en proceso   198   28,2 %
//   pendiente     74   10,5 %
//   anulado        2    0,3 %   ← donde confirmar habría sido un error
//   devuelto       1    0,1 %
//
// Tres de 702. La regla acierta el 99,6 % de las veces, y el precio de los
// diecisiete puntos de espera lo pagaban los 699.
//
// LAS TRES SON NECESARIAS, y el pago es la que carga el peso. Con DNI y agencia
// pero sin pago, la asesora puede estar todavía negociando: el borrador se
// guarda en cuanto se teclean los datos. El dinero es lo que convierte la
// conversación en compromiso.
//
// QUÉ CUENTA COMO PAGO: lo dice `paymentProgress().advanceValidated`, que ya
// existía. NO se reimplementa aquí, y la primera versión de este archivo sí lo
// hizo —«cualquier adelanto validado»— hasta que #KP129361 lo delató: un
// adelanto de S/ 20 validado sobre un pedido de S/ 149. Esa versión lo habría
// confirmado mientras `payment_state` seguía diciendo `adelanto_cargado` y
// `agencyPaymentReady` seguía frenándolo, dejando el pedido con un `confirmed`
// escrito y sin moverse. El mínimo es `SHALOM_MINIMUM_ADVANCE` = S/ 30 y vive en
// un solo sitio, que es lo que impide que estas dos respuestas se separen.
//
// LO QUE ESTA REGLA NO HACE. No mira la cobertura. #AUR176259 está clasificado
// `provincia_cod` —Aliclik tiene COD cerca de Puerto Maldonado— y aun así se va
// por Shalom. La evidencia de que el envío es a agencia es el borrador con su
// terminal elegida, no la etiqueta que le puso el clasificador.

import { paymentProgress, type PaymentSnapshot } from "@/lib/pickup-key";

/** Lo apuntado en el borrador de Shalom al registrar el cobro. */
export interface BorradorDeAgencia {
  document: string | null;
  destiny_terminal_id: number | null;
}

/**
 * ¿Hay un pago que comprometa a la clienta?
 *
 * Delega en `paymentProgress`, la definición única: exige `adelanto`/`total`
 * VALIDADO por al menos `SHALOM_MINIMUM_ADVANCE`. Una `diferencia` no entra en
 * esa cuenta, y es correcto: es un saldo posterior sobre un pedido que ya iba
 * en marcha, así que llega cuando la confirmación ya ocurrió.
 */
export function hayPagoQueCompromete(
  pagos: readonly PaymentSnapshot[],
  totalDelPedido: number | null,
): boolean {
  return paymentProgress(pagos, totalDelPedido).advanceValidated;
}

/**
 * ¿Los hechos ya confirman este pedido de agencia?
 *
 * Las tres a la vez, sin excepción: documento, sucursal y pago validado. Que
 * falte una devuelve `false` y el pedido sigue esperando la palabra de la
 * asesora, que es exactamente lo que debe pasar mientras la clienta no se haya
 * comprometido del todo.
 */
export function hayConfirmacionExpresaDeAgencia(
  borrador: BorradorDeAgencia | null | undefined,
  pagos: readonly PaymentSnapshot[],
  totalDelPedido: number | null,
): boolean {
  if (!borrador) return false;
  if (!(borrador.document ?? "").trim()) return false;
  // El id de terminal es el que Shalom entiende; el nombre es para leerlo. Si
  // solo estuviera el nombre, no habría a dónde mandar el paquete.
  if (!borrador.destiny_terminal_id) return false;
  return hayPagoQueCompromete(pagos, totalDelPedido);
}

/**
 * Lo que se escribe en la línea de tiempo. Se nombra la evidencia y no solo el
 * resultado: quien lea el pedido dentro de tres meses tiene que poder saber por
 * qué se dio por confirmado sin que nadie lo marcara.
 */
export function notaDeConfirmacionExpresa(nombreDeAgencia: string | null): string {
  const agencia = (nombreDeAgencia ?? "").trim();
  return (
    "Confirmado por los hechos: documento, agencia elegida" +
    (agencia ? ` (${agencia})` : "") +
    " y pago validado."
  );
}
