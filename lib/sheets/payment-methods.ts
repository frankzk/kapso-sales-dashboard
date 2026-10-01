// Los métodos de pago del cuaderno de reparto, solos y sin dependencias: la
// pantalla del motorizado los ofrece como opciones y no debe arrastrar al
// teléfono las plantillas de hojas (30-09-2026).

/** Métodos de pago, lista cerrada. Sale del vocabulario de jul-sep 2026. */
export const REPARTO_PAYMENT_METHODS = [
  "Efectivo",
  "Yape Grupo GF",
  "Yape/Plin Frankz",
  "Yape/Plin Gabriela",
  "Izipay",
  "Link de pago",
  "Transferencia",
  "Pagado antes",
  "Sin cobro",
] as const;
