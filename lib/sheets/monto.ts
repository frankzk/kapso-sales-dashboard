// ¿Cuadra lo cobrado con lo que había que cobrar? Solo y sin dependencias: lo
// usan la pantalla del motorizado y el servidor, y el teléfono no debe cargar el
// resto del cuaderno (30-09-2026).

/** Diferencia mínima para considerar que un monto no cuadra (S/). */
export const MONTO_TOLERANCE = 0.5;

export function montoDiffers(aCobrar: number | null, kaptaTotal: number | null): boolean {
  if (aCobrar === null || kaptaTotal === null) return false;
  return Math.abs(aCobrar - kaptaTotal) > MONTO_TOLERANCE;
}

/**
 * Lo que había que cobrar en la puerta: el saldo (total menos lo ya pagado y
 * validado), y el total solo si el saldo no se pudo leer. Un pedido pagado por
 * adelantado se entrega «Sin cobro» y eso cuadra (10-10-2026: #KP139362, S/
 * 268.20 pagados antes, pedía explicar por qué no se cobraron S/ 268.20).
 */
export function amountDue(total: number | null, remaining: number | null | undefined): number | null {
  return remaining ?? total;
}
