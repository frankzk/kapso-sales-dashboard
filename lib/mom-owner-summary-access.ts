import { createServerSupabase } from "@/lib/db";
import {
  buildMomOwnerSummary,
  momOwnerPeriods,
  type MomOwnerEventFact,
  type MomOwnerManifestFact,
  type MomOwnerOrderFact,
  type MomOwnerPaymentFact,
  type MomOwnerShipmentFact,
  type MomOwnerSummary,
} from "@/lib/mom-owner-summary";
import { CONFIRMATION_SIGNAL_KINDS } from "@/lib/order-confirmation";

const PAGE_SIZE = 1_000;

type PageResult<T> = {
  data: T[] | null;
  error: { message: string } | null;
};

async function readPages<T>(
  table: string,
  load: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await load(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function limaTodayKey(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

interface RawOrder {
  order_id: string;
  order_created_at: string | null;
  coverage: string | null;
  order_total: number | string | null;
  macro_stage: string | null;
  macro_substage: string | null;
  macro_reasons: string[] | null;
  payment_state: string | null;
  delivered_at: string | null;
  delivered_courier: string | null;
  last_movement_at: string | null;
}

const ORDER_COLUMNS =
  "order_id,order_created_at,coverage,order_total,macro_stage,macro_substage," +
  "macro_reasons,payment_state,delivered_at,delivered_courier,last_movement_at";

function orderFact(row: RawOrder): MomOwnerOrderFact {
  return {
    orderId: row.order_id,
    createdAt: row.order_created_at,
    coverage: row.coverage,
    orderTotal: asNumber(row.order_total),
    stage: row.macro_stage,
    substage: row.macro_substage,
    reasons: row.macro_reasons ?? [],
    paymentState: row.payment_state,
    deliveredAt: row.delivered_at,
    deliveredCourier: row.delivered_courier,
    lastMovementAt: row.last_movement_at,
  };
}

async function readOrdersByIds(orderIds: string[]): Promise<RawOrder[]> {
  const sb = await createServerSupabase();
  const rows: RawOrder[] = [];
  for (let start = 0; start < orderIds.length; start += 200) {
    const { data, error } = await sb
      .from("order_master")
      .select(ORDER_COLUMNS)
      .in("order_id", orderIds.slice(start, start + 200));
    if (error) throw new Error(`order_master: ${error.message}`);
    rows.push(...((data ?? []) as unknown as RawOrder[]));
  }
  return rows;
}

export async function getMomOwnerSummary(
  storeIds: string[],
  orgIds: string[],
  now = new Date(),
): Promise<MomOwnerSummary> {
  const today = limaTodayKey(now);
  const periods = momOwnerPeriods(today);
  const earliest = periods.find((period) => period.key === "previous_month")!.startIso;
  const currentEnd = periods.find((period) => period.key === "month")!.endIso;
  const staleCutoff = new Date(`${today}T05:00:00.000Z`);
  staleCutoff.setUTCDate(staleCutoff.getUTCDate() - 60);
  const staleIso = staleCutoff.toISOString();
  const sb = await createServerSupabase();

  const [
    cohortRows,
    closingRows,
    staleMovedRows,
    staleUnmovedRows,
    shipmentCreatedRows,
    shipmentDispatchedRows,
    eventRows,
    paymentRows,
    manifestRows,
  ] =
    await Promise.all([
      readPages<RawOrder>("order_master", (from, to) =>
        sb
          .from("order_master")
          .select(ORDER_COLUMNS)
          .in("store_id", storeIds)
          .gte("order_created_at", earliest)
          .lt("order_created_at", currentEnd)
          .order("order_created_at", { ascending: true })
          .range(from, to) as unknown as PromiseLike<PageResult<RawOrder>>,
      ),
      readPages<RawOrder>("order_master", (from, to) =>
        sb
          .from("order_master")
          .select(ORDER_COLUMNS)
          .in("store_id", storeIds)
          .eq("macro_stage", "por_cerrar")
          .order("last_movement_at", { ascending: true, nullsFirst: true })
          .range(from, to) as unknown as PromiseLike<PageResult<RawOrder>>,
      ),
      readPages<RawOrder>("order_master", (from, to) =>
        sb
          .from("order_master")
          .select(ORDER_COLUMNS)
          .in("store_id", storeIds)
          .neq("macro_stage", "finalizado")
          .lt("last_movement_at", staleIso)
          .order("last_movement_at", { ascending: true })
          .range(from, to) as unknown as PromiseLike<PageResult<RawOrder>>,
      ),
      readPages<RawOrder>("order_master", (from, to) =>
        sb
          .from("order_master")
          .select(ORDER_COLUMNS)
          .in("store_id", storeIds)
          .neq("macro_stage", "finalizado")
          .is("last_movement_at", null)
          .lt("order_created_at", staleIso)
          .order("order_created_at", { ascending: true })
          .range(from, to) as unknown as PromiseLike<PageResult<RawOrder>>,
      ),
      readPages<{
        id: string;
        order_id: string | null;
        courier: string | null;
        dispatched_at: string | null;
        delivery_status: string | null;
      }>("shipments", (from, to) =>
        sb
          .from("shipments")
          .select("id,order_id,courier,dispatched_at,delivery_status")
          .in("store_id", storeIds)
          .gte("created_at", earliest)
          .lt("created_at", currentEnd)
          .order("created_at", { ascending: true })
          .range(from, to) as unknown as PromiseLike<PageResult<{
            id: string;
            order_id: string | null;
            courier: string | null;
            dispatched_at: string | null;
            delivery_status: string | null;
          }>>,
      ),
      readPages<{
        id: string;
        order_id: string | null;
        courier: string | null;
        dispatched_at: string | null;
        delivery_status: string | null;
      }>("shipments", (from, to) =>
        sb
          .from("shipments")
          .select("id,order_id,courier,dispatched_at,delivery_status")
          .in("store_id", storeIds)
          .gte("dispatched_at", earliest)
          .lt("dispatched_at", currentEnd)
          .order("dispatched_at", { ascending: true })
          .range(from, to) as unknown as PromiseLike<PageResult<{
            id: string;
            order_id: string | null;
            courier: string | null;
            dispatched_at: string | null;
            delivery_status: string | null;
          }>>,
      ),
      readPages<{ order_id: string; kind: string; occurred_at: string }>("order_events", (from, to) =>
        sb
          .from("order_events")
          .select("order_id,kind,occurred_at")
          .in("store_id", storeIds)
          .in("kind", [...CONFIRMATION_SIGNAL_KINDS])
          .gte("occurred_at", earliest)
          .lt("occurred_at", currentEnd)
          .order("occurred_at", { ascending: true })
          .range(from, to) as unknown as PromiseLike<
          PageResult<{ order_id: string; kind: string; occurred_at: string }>
        >,
      ),
      readPages<{
        order_id: string;
        amount: number | string | null;
        paid_at: string | null;
      }>("order_payments", (from, to) =>
        sb
          .from("order_payments")
          .select("order_id,amount,paid_at")
          .in("store_id", storeIds)
          .eq("validation_status", "validado")
          .order("registered_at", { ascending: true })
          .range(from, to) as unknown as PromiseLike<
          PageResult<{ order_id: string; amount: number | string | null; paid_at: string | null }>
        >,
      ),
      orgIds.length
        ? readPages<{ id: string; state: string }>("dispatch_manifests", (from, to) =>
            sb
              .from("dispatch_manifests")
              .select("id,state")
              .in("org_id", orgIds)
              .in("state", ["office_check", "pickup_check"])
              .order("created_at", { ascending: true })
              .range(from, to) as unknown as PromiseLike<PageResult<{ id: string; state: string }>>,
          )
        : Promise.resolve([]),
    ]);

  const shipmentMap = new Map(
    [...shipmentCreatedRows, ...shipmentDispatchedRows].map((shipment) => [shipment.id, shipment]),
  );
  const shipmentRows = [...shipmentMap.values()];
  const rawOrders = new Map<string, RawOrder>();
  for (const row of [...cohortRows, ...closingRows, ...staleMovedRows, ...staleUnmovedRows]) {
    rawOrders.set(row.order_id, row);
  }

  const missingOrderIds = unique(
    shipmentRows
      .map((shipment) => shipment.order_id)
      .filter((orderId): orderId is string => Boolean(orderId && !rawOrders.has(orderId))),
  );
  for (const row of await readOrdersByIds(missingOrderIds)) rawOrders.set(row.order_id, row);

  const shipments: MomOwnerShipmentFact[] = shipmentRows.map((row) => ({
    id: row.id,
    orderId: row.order_id,
    courier: row.courier,
    dispatchedAt: row.dispatched_at,
    deliveryStatus: row.delivery_status,
  }));
  const events: MomOwnerEventFact[] = eventRows.map((row) => ({
    orderId: row.order_id,
    kind: row.kind,
    occurredAt: row.occurred_at,
  }));
  const payments: MomOwnerPaymentFact[] = paymentRows
    .map((row) => ({
      orderId: row.order_id,
      amount: asNumber(row.amount) ?? 0,
      paidAt: row.paid_at,
    }))
    .filter((row) => row.amount > 0);
  const manifests: MomOwnerManifestFact[] = manifestRows.map((row) => ({
    id: row.id,
    state: row.state,
  }));

  return buildMomOwnerSummary({
    today,
    nowIso: now.toISOString(),
    orders: [...rawOrders.values()].map(orderFact),
    shipments,
    payments,
    events,
    manifests,
  });
}
