import { normalizePhone, peruMobileProblem } from "@/lib/phone";

export interface PhoneSaleCustomer { storeId: string; phone: string; name: string | null }
export type PhoneSaleRequest = PhoneSaleCustomer & { requestId: number };

/** Solo identifica al cliente. Productos, pagos y pedido anterior nunca se copian. */
export function phoneSaleCustomer(row: { store_id: string; customer_phone?: string | null; customer_name?: string | null }): PhoneSaleCustomer | null {
  const phone=normalizePhone(row.customer_phone ?? "");
  return phone && !peruMobileProblem(phone) ? { storeId:row.store_id,phone,name:row.customer_name ?? null } : null;
}
