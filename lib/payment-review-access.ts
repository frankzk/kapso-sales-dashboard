import "server-only";

import { cache } from "react";
import { getAccessibleStores } from "@/lib/access";
import { createServerSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import {
  limaDayBounds,
  PAYMENT_OBSERVED_STATUSES,
  PAYMENT_PENDING_STATUSES,
  type PaymentReviewLane,
} from "@/lib/payment-review";

const LANE_LIMIT = 80;

type RawPayment = {
  id: string;
  store_id: string;
  order_id: string;
  kind: string;
  amount: number | string | null;
  operation_number: string | null;
  paid_at: string | null;
  file_path: string | null;
  validation_status: string;
  registered_at: string;
  validated_at: string | null;
  notes: string | null;
  vision: unknown;
};

type RawOrder = {
  order_id: string;
  store_id: string;
  order_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  order_total: number | string | null;
  payment_state: string | null;
};

export interface PaymentReviewItem {
  id: string;
  storeId: string;
  storeName: string;
  orderId: string;
  orderName: string;
  customerName: string | null;
  customerPhone: string | null;
  orderTotal: number | null;
  paymentState: string | null;
  kind: string;
  amount: number | null;
  operationNumber: string | null;
  paidAt: string | null;
  hasVoucher: boolean;
  validationStatus: string;
  registeredAt: string;
  validatedAt: string | null;
  notes: string | null;
  vision: unknown;
  registeredTotal: number;
  validatedTotal: number;
}

export interface PaymentReviewBoardData {
  date: string;
  counts: Record<PaymentReviewLane, number>;
  lanes: Record<PaymentReviewLane, PaymentReviewItem[]>;
  truncated: Record<PaymentReviewLane, boolean>;
}

const paymentValidationStores = cache(async function paymentValidationStores() {
  const stores = await getAccessibleStores();
  const orgIds = [...new Set(stores.map((store) => store.org_id).filter(Boolean))] as string[];
  const permissions = await Promise.all(
    orgIds.map(async (orgId) => [orgId, await hasOrgPermission(orgId, "payments.validate")] as const),
  );
  const allowed = new Set(permissions.filter(([, canValidate]) => canValidate).map(([orgId]) => orgId));
  return stores.filter((store) => store.org_id && allowed.has(store.org_id));
});

export async function canValidatePaymentsAnywhere(): Promise<boolean> {
  return (await paymentValidationStores()).length > 0;
}

function numberOrNull(value: number | string | null): number | null {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function getPaymentReviewBoard(): Promise<PaymentReviewBoardData | null> {
  const stores = await paymentValidationStores();
  if (!stores.length) return null;
  const storeIds = stores.map((store) => store.id);
  const storeNames = new Map(stores.map((store) => [store.id, store.name]));
  const sb = await createServerSupabase();
  const day = limaDayBounds();
  const columns =
    "id,store_id,order_id,kind,amount,operation_number,paid_at,file_path," +
    "validation_status,registered_at,validated_at,notes,vision";

  const [pendingRes, observedRes, validatedRes, pendingCountRes, observedCountRes, validatedCountRes] =
    await Promise.all([
      sb
        .from("order_payments")
        .select(columns)
        .in("store_id", storeIds)
        .in("validation_status", [...PAYMENT_PENDING_STATUSES])
        .order("registered_at", { ascending: true })
        .limit(LANE_LIMIT),
      sb
        .from("order_payments")
        .select(columns)
        .in("store_id", storeIds)
        .in("validation_status", [...PAYMENT_OBSERVED_STATUSES])
        .order("registered_at", { ascending: true })
        .limit(LANE_LIMIT),
      sb
        .from("order_payments")
        .select(columns)
        .in("store_id", storeIds)
        .eq("validation_status", "validado")
        .gte("validated_at", day.startIso)
        .lt("validated_at", day.endIso)
        .order("validated_at", { ascending: false })
        .limit(LANE_LIMIT),
      sb
        .from("order_payments")
        .select("id", { count: "exact", head: true })
        .in("store_id", storeIds)
        .in("validation_status", [...PAYMENT_PENDING_STATUSES]),
      sb
        .from("order_payments")
        .select("id", { count: "exact", head: true })
        .in("store_id", storeIds)
        .in("validation_status", [...PAYMENT_OBSERVED_STATUSES]),
      sb
        .from("order_payments")
        .select("id", { count: "exact", head: true })
        .in("store_id", storeIds)
        .eq("validation_status", "validado")
        .gte("validated_at", day.startIso)
        .lt("validated_at", day.endIso),
    ]);

  const errors = [pendingRes.error, observedRes.error, validatedRes.error].filter(Boolean);
  if (errors.length) throw new Error(errors.map((error) => error!.message).join("; "));

  const laneRows: Record<PaymentReviewLane, RawPayment[]> = {
    pending: (pendingRes.data ?? []) as unknown as RawPayment[],
    observed: (observedRes.data ?? []) as unknown as RawPayment[],
    validated: (validatedRes.data ?? []) as unknown as RawPayment[],
  };
  const allRows = [...laneRows.pending, ...laneRows.observed, ...laneRows.validated];
  const orderIds = [...new Set(allRows.map((row) => row.order_id))];
  const [ordersRes, totalsRes] = orderIds.length
    ? await Promise.all([
        sb
          .from("order_master")
          .select(
            "order_id,store_id,order_name,customer_name,customer_phone,order_total,payment_state",
          )
          .in("order_id", orderIds),
        sb
          .from("order_payments")
          .select("order_id,amount,validation_status")
          .in("order_id", orderIds)
          .neq("validation_status", "rechazado"),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  if (ordersRes.error) throw new Error(ordersRes.error.message);
  if (totalsRes.error) throw new Error(totalsRes.error.message);

  const orders = new Map(
    ((ordersRes.data ?? []) as unknown as RawOrder[]).map((order) => [order.order_id, order]),
  );
  const totals = new Map<string, { registered: number; validated: number }>();
  for (const row of
    (totalsRes.data ?? []) as { order_id: string; amount: number | string | null; validation_status: string }[]) {
    const current = totals.get(row.order_id) ?? { registered: 0, validated: 0 };
    const amount = numberOrNull(row.amount) ?? 0;
    current.registered += amount;
    if (row.validation_status === "validado") current.validated += amount;
    totals.set(row.order_id, current);
  }

  function toItem(row: RawPayment): PaymentReviewItem {
    const order = orders.get(row.order_id);
    const progress = totals.get(row.order_id) ?? { registered: 0, validated: 0 };
    return {
      id: row.id,
      storeId: row.store_id,
      storeName: storeNames.get(row.store_id) ?? "Tienda",
      orderId: row.order_id,
      orderName: order?.order_name ?? "Pedido sin código",
      customerName: order?.customer_name ?? null,
      customerPhone: order?.customer_phone ?? null,
      orderTotal: numberOrNull(order?.order_total ?? null),
      paymentState: order?.payment_state ?? null,
      kind: row.kind,
      amount: numberOrNull(row.amount),
      operationNumber: row.operation_number,
      paidAt: row.paid_at,
      hasVoucher: Boolean(row.file_path),
      validationStatus: row.validation_status,
      registeredAt: row.registered_at,
      validatedAt: row.validated_at,
      notes: row.notes,
      vision: row.vision,
      registeredTotal: progress.registered,
      validatedTotal: progress.validated,
    };
  }

  const counts = {
    pending: pendingCountRes.count ?? laneRows.pending.length,
    observed: observedCountRes.count ?? laneRows.observed.length,
    validated: validatedCountRes.count ?? laneRows.validated.length,
  };
  return {
    date: day.date,
    counts,
    lanes: {
      pending: laneRows.pending.map(toItem),
      observed: laneRows.observed.map(toItem),
      validated: laneRows.validated.map(toItem),
    },
    truncated: {
      pending: counts.pending > laneRows.pending.length,
      observed: counts.observed > laneRows.observed.length,
      validated: counts.validated > laneRows.validated.length,
    },
  };
}
