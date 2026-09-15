import { createAdminSupabase } from "@/lib/db";
import { collectionBalance, type CollectionBalance } from "@/lib/route-collection";
import type { PaymentGateway } from "@/lib/payment-gateway";

/** Internal only. Call exclusively AFTER checking visibility of the route/stops. */
export async function loadRouteCollectionBalances(visibleOrderIds: string[]): Promise<Map<string, CollectionBalance>> {
  const result = new Map<string, CollectionBalance>();
  const admin = createAdminSupabase();
  for (let i = 0; i < visibleOrderIds.length; i += 100) {
    const ids = visibleOrderIds.slice(i, i + 100);
    const [orders, payments] = await Promise.all([
      admin.from("orders").select("id,total_amount,financial_status,total_refunded,payment_gateway").in("id", ids),
      admin.from("order_payments").select("order_id,kind,amount,validation_status").in("order_id", ids),
    ]);
    // Unknown is not zero or the full order. UI disables submission until refreshed.
    if (orders.error || payments.error) continue;
    for (const order of orders.data ?? []) result.set(order.id, collectionBalance(order.total_amount, {
      financialStatus: order.financial_status, totalRefunded: order.total_refunded,
      paymentGateway: order.payment_gateway as PaymentGateway | null,
    }, (payments.data ?? []).filter((p) => p.order_id === order.id)));
  }
  return result;
}
