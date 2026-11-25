import type { createAdminSupabase } from "@/lib/db";
import { allCourierRows, COURIER_ROWS_WIDE_BATCH, courierRowsByIds } from "@/lib/courier-flow";
import type { LimaPendingOrder } from "@/lib/repro-lima-pending";
import { isDeliveryManagementCall } from "@/lib/lima-management";

type Admin = ReturnType<typeof createAdminSupabase>;
type Query = ReturnType<ReturnType<Admin["from"]>["select"]>;
type Management = NonNullable<LimaPendingOrder["management"]>;
type Event = { order_id: string; kind: string; occurred_at: string; payload?: { from?: string; to?: string; channel?: string; result?: string } | null };
type Contact = { order_id: string; occurred_at: string; outcome?: string | null };
const PHONE = new Set(["llamada", "telefono", "voz", "call", "voice"]);

/** Historia del pedido, no del teléfono: evita heredar llamadas de otra compra. */
export async function loadLimaManagement(admin: Admin, orderIds: string[], createdAtByOrder: ReadonlyMap<string, string | null>): Promise<Map<string, Management>> {
  const out = new Map(orderIds.map((id) => [id, { hasCall: false, lastCallAt: null, lastCallResult: null, movedToLimaAt: null } as Management]));
  const record = (id: string, at: string | null | undefined, result?: string | null) => {
    const fact = out.get(id);
    if (!fact || !at || !isDeliveryManagementCall(at, createdAtByOrder.get(id))) return;
    fact.hasCall = true;
    if (!fact.lastCallAt || Date.parse(at) > Date.parse(fact.lastCallAt)) { fact.lastCallAt = at; fact.lastCallResult = result ?? null; }
  };
  // Se pagina también dentro de cada lote: más de mil gestiones nunca se cortan.
  // Por eso el lote puede ser ancho (400 ids, 25-11-2026): con 1.157 pedidos eran
  // 12 lotes por tabla en ocho tablas, unas 100 consultas solo para saber si ya
  // se llamó a cada clienta.
  const read = async <T,>(table: string, columns: string, field: string, ids: string[], filter: (q: Query) => Query = (q) => q): Promise<T[]> => {
    const result = await courierRowsByIds<T>(ids, (chunk) => allCourierRows<T>((from, to) => filter(admin.from(table).select(columns).in(field, chunk) as unknown as Query).order("id").range(from, to) as unknown as PromiseLike<{ data: T[] | null; error: { message: string } | null }>).then((data) => ({ data, error: null })), COURIER_ROWS_WIDE_BATCH);
    return result.data;
  };
  const [events, repro, voice, anura, leads, guides] = await Promise.all([
    read<Event>("order_events", "order_id,kind,occurred_at,payload", "order_id", orderIds, (q) => q.in("kind", ["confirmation_contact", "contact_attempt", "call", "coverage_changed"])),
    read<Contact>("lima_repro_calls", "order_id,occurred_at,outcome", "order_id", orderIds, (q) => q.eq("channel", "llamada")),
    read<{ order_id: string; dialed_at: string | null; started_at: string | null; outcome: string | null }>("voice_calls", "order_id,dialed_at,started_at,outcome", "order_id", orderIds, (q) => q.eq("mode", "real")),
    read<{ order_id: string; requested_at: string; started_at: string | null; status: string }>("anura_calls", "order_id,requested_at,started_at,status", "order_id", orderIds, (q) => q.eq("mode", "pedido")),
    read<{ id: string; order_id: string }>("leads", "id,order_id", "order_id", orderIds),
    read<{ id: string; order_id: string }>("shipments", "id,order_id", "order_id", orderIds),
  ]);
  for (const event of events) {
    if (event.kind === "coverage_changed") {
      const fact = out.get(event.order_id);
      if (fact && event.payload?.to === "lima" && ["provincia_cod", "agencia"].includes(event.payload.from ?? "") && (!fact.movedToLimaAt || event.occurred_at > fact.movedToLimaAt)) fact.movedToLimaAt = event.occurred_at;
    } else if ((event.kind === "call" && !event.payload?.channel) || PHONE.has(event.payload?.channel ?? "")) record(event.order_id, event.occurred_at, event.payload?.result);
  }
  for (const call of repro) record(call.order_id, call.occurred_at, call.outcome);
  for (const call of voice) record(call.order_id, call.dialed_at ?? call.started_at, call.outcome);
  for (const call of anura) if (call.started_at || !["solicitada", "fallida"].includes(call.status)) record(call.order_id, call.started_at ?? call.requested_at, call.status);
  const [leadCalls, shipmentCalls] = await Promise.all([
    read<{ lead_id: string; occurred_at: string; new_status: string | null }>("lead_calls", "lead_id,occurred_at,new_status", "lead_id", leads.map((l) => l.id), (q) => q.eq("kind", "call")),
    read<{ shipment_id: string; occurred_at: string; new_status: string | null }>("shipment_calls", "shipment_id,occurred_at,new_status", "shipment_id", guides.map((g) => g.id), (q) => q.eq("kind", "call")),
  ]);
  const byLead = new Map(leads.map((l) => [l.id, l.order_id]));
  const byGuide = new Map(guides.map((g) => [g.id, g.order_id]));
  for (const call of leadCalls) record(byLead.get(call.lead_id) ?? "", call.occurred_at, call.new_status);
  for (const call of shipmentCalls) record(byGuide.get(call.shipment_id) ?? "", call.occurred_at, call.new_status);
  return out;
}
