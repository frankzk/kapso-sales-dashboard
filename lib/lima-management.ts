/** Una llamada comercial anterior al pedido no es gestión de su entrega. */
export function isDeliveryManagementCall(at: string | null | undefined, createdAt: string | null | undefined): boolean {
  if (!at) return false;
  const callTime = Date.parse(at);
  if (!Number.isFinite(callTime)) return false;
  const createdTime = createdAt ? Date.parse(createdAt) : NaN;
  // Sin fecha de creación comprobable se conserva la llamada, no se presume Nuevo.
  return !Number.isFinite(createdTime) || callTime >= createdTime;
}
