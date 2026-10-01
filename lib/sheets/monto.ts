// ¿Cuadra lo cobrado con el total del pedido? Solo y sin dependencias: lo usan
// la pantalla del motorizado y el servidor, y el teléfono no debe cargar el
// resto del cuaderno (30-09-2026).

/** Diferencia mínima para considerar que un monto no cuadra (S/). */
export const MONTO_TOLERANCE = 0.5;

export function montoDiffers(aCobrar: number | null, kaptaTotal: number | null): boolean {
  if (aCobrar === null || kaptaTotal === null) return false;
  return Math.abs(aCobrar - kaptaTotal) > MONTO_TOLERANCE;
}
