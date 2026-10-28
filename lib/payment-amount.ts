/** Un comprobante sin importe no prueba S/ 0 ni un pago por el total del pedido. */
export function hasPositivePaymentAmount(value: unknown): boolean {
  if(typeof value!=="number" && typeof value!=="string")return false;
  if(typeof value==="string" && !value.trim())return false;
  const amount=Number(value);
  return Number.isFinite(amount) && amount>0;
}
export const MISSING_PAYMENT_AMOUNT = "Este comprobante no tiene un monto válido mayor que S/ 0.00. Pide la constancia donde se vea el importe y complétalo antes de validar; no uses el total del pedido por suposición.";
