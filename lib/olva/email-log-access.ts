import "server-only";

// Lee «Cotejar Olva › Correos de Olva» (MOM §12). `olva_email_labels` solo la
// lee el servidor (0223: teléfono y DNI de la destinataria), así que el
// alcance se aplica aquí: los correos que envía la cuenta (el RUC de «ENVIA»)
// de una organización de quien mira, y los que no son de ninguna —sin RUC
// legible o con un RUC que ninguna tienda tiene en Ajustes—, porque ver que
// llegaron es justo lo que hace falta para entender por qué no vincularon.
// Los de un RUC de otra organización no se muestran.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildEmailLog,
  type EmailLabelRow,
  type EmailLog,
  type EmailLogLinkEvent,
  type EmailLogShipment,
} from "@/lib/olva/email-log";

export const EMAIL_LOG_LIMIT = 200;

const LABEL_COLS =
  "id,message_id,file_name,received_at,created_at,subject,registro,olva_tracking,olva_emision,sender_doc," +
  "recipient_name,address,parse_error,linked_shipment_id,suggested_order_name,match_note,label_index,label_count";

function fail(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`correos de Olva: ${what} — ${error.message}`);
}

function batches<T>(items: T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function getOlvaEmailLog(
  admin: SupabaseClient,
  scope: { orgIds: string[]; storeIds: string[] },
): Promise<EmailLog> {
  const { data: storeRows, error: storeError } = await admin
    .from("stores")
    .select("org_id,olva_portal_ruc")
    .not("olva_portal_ruc", "is", null);
  fail("tiendas", storeError);
  const orgByRuc = new Map<string, string>();
  const foreign = new Set<string>();
  for (const s of (storeRows ?? []) as { org_id: string; olva_portal_ruc: string }[]) {
    const ruc = s.olva_portal_ruc.trim();
    if (!/^\d{8,11}$/.test(ruc)) continue;
    if (scope.orgIds.includes(s.org_id)) orgByRuc.set(ruc, s.org_id);
    else foreign.add(ruc);
  }
  for (const ruc of orgByRuc.keys()) foreign.delete(ruc);

  const query = (cols: string) => {
    let q = admin.from("olva_email_labels").select(cols).order("created_at", { ascending: false }).limit(EMAIL_LOG_LIMIT + 1);
    if (foreign.size) q = q.or(`sender_doc.is.null,sender_doc.not.in.(${[...foreign].join(",")})`);
    return q;
  };
  let res = await query(`${LABEL_COLS},outcome`);
  // Sin la 0227 no hay `outcome`: `labelOutcome` lo deduce de la nota.
  if (res.error && /outcome/.test(res.error.message)) res = await query(LABEL_COLS);
  fail("correos", res.error);
  const fetched = (res.data ?? []) as unknown as EmailLabelRow[];
  const truncated = fetched.length > EMAIL_LOG_LIMIT;
  const labels = fetched.slice(0, EMAIL_LOG_LIMIT);

  // Dónde está hoy cada tracking, y la salida que vinculó cada correo.
  type ShipmentRow = EmailLogShipment & { store_id: string };
  const SHIPMENT_COLS = "id,store_id,order_id,order_name,olva_tracking,olva_emision";
  const shipments = new Map<string, ShipmentRow>();
  const trackings = [...new Set(labels.flatMap((l) => (l.olva_tracking ? [l.olva_tracking] : [])))];
  await Promise.all(
    batches(trackings).map(async (batch) => {
      const { data, error } = await admin.from("shipments").select(SHIPMENT_COLS).in("olva_tracking", batch);
      fail("salidas", error);
      for (const s of (data ?? []) as ShipmentRow[]) shipments.set(s.id, s);
    }),
  );
  const missing = [...new Set(labels.flatMap((l) => (l.linked_shipment_id ? [l.linked_shipment_id] : [])))].filter(
    (id) => !shipments.has(id),
  );
  await Promise.all(
    batches(missing).map(async (batch) => {
      const { data, error } = await admin.from("shipments").select(SHIPMENT_COLS).in("id", batch);
      fail("salidas vinculadas", error);
      for (const s of (data ?? []) as ShipmentRow[]) shipments.set(s.id, s);
    }),
  );

  const events: EmailLogLinkEvent[] = [];
  const suggestedOrders: { order_id: string; order_name: string }[] = [];
  const suggested = [...new Set(labels.flatMap((l) => (l.suggested_order_name ? [l.suggested_order_name] : [])))];
  await Promise.all([
    ...batches([...shipments.keys()]).map(async (batch) => {
      const { data, error } = await admin
        .from("order_events")
        .select("shipment_id,occurred_at,actor,payload")
        .eq("kind", "olva_tracking_linked")
        .in("shipment_id", batch);
      fail("eventos", error);
      events.push(...((data ?? []) as EmailLogLinkEvent[]));
    }),
    ...(scope.storeIds.length
      ? batches(suggested).map(async (batch) => {
          const { data, error } = await admin
            .from("order_master")
            .select("order_id,order_name")
            .in("order_name", batch)
            .in("store_id", scope.storeIds);
          fail("pedidos sugeridos", error);
          suggestedOrders.push(...((data ?? []) as { order_id: string; order_name: string }[]));
        })
      : []),
  ]);

  const stores = new Set(scope.storeIds);
  const visibleOrderIds = new Set(
    [...shipments.values()].flatMap((s) => (s.order_id && stores.has(s.store_id) ? [s.order_id] : [])),
  );

  return buildEmailLog({
    labels,
    shipments: [...shipments.values()],
    events,
    suggestedOrders,
    visibleOrderIds,
    orgByRuc,
    truncated,
  });
}
