import "server-only";
// Lectura de la bandeja «Pago de diferencia» (MOM §44). Las reglas viven en
// lib/pago-diferencia.ts; aquí solo se lee la base, para las tiendas que la
// persona ya tiene (`getAccessibleStores`), con el cliente de servicio.

import type { SupabaseClient } from "@supabase/supabase-js";
import { chunk } from "@/lib/access";
import { readAllPages } from "@/lib/postgrest-pages";
import { resolveAgentNames } from "@/lib/agent-names";
import {
  PAGO_DIFERENCIA_GESTION_KINDS,
  buildPagoDiferenciaRows,
  pagoDiferenciaGroup,
  type PagoDiferenciaEventInput,
  type PagoDiferenciaOrderInput,
  type PagoDiferenciaPaymentInput,
  type PagoDiferenciaRow,
} from "@/lib/pago-diferencia";

const ID_BATCH = 150;

export async function loadPagoDiferencia(
  admin: SupabaseClient,
  storeIds: readonly string[],
  now: Date = new Date(),
): Promise<PagoDiferenciaRow[]> {
  if (!storeIds.length) return [];
  const { rows: rawOrders, error } = await readAllPages<PagoDiferenciaOrderInput>((from, to) =>
    admin
      .from("order_master")
      .select(
        "order_id,macro_substage,macro_operation,payment_state,store_id,order_name,customer_name,customer_phone,order_total,current_courier,guide_code,agency_branch,agency_arrived_at,agency_expires_at,macro_since,province,district",
      )
      .in("store_id", [...storeIds])
      // Los grupos (lib/pago-diferencia.ts, `pagoDiferenciaGroup`, que
      // vuelve a decidir fila por fila).
      .in("macro_substage", ["pendiente_pago_diferencia", "recogido_sin_pago_completo", "en_transito", "en_destino", "devolucion_fisica_pendiente"])
      .order("order_id")
      .range(from, to),
  );
  if (error) throw new Error(`No se pudieron leer los pedidos: ${error.message}`);
  // Lima y contra entrega en tránsito no son de la bandeja: fuera antes de
  // leer sus pagos y su gestión.
  const orders = rawOrders.filter((o) => pagoDiferenciaGroup(o) !== null);
  if (!orders.length) return [];

  const payments: PagoDiferenciaPaymentInput[] = [];
  const events: PagoDiferenciaEventInput[] = [];
  for (const ids of chunk(orders.map((o) => o.order_id), ID_BATCH)) {
    const [pay, ev] = await Promise.all([
      readAllPages<PagoDiferenciaPaymentInput>((from, to) =>
        admin.from("order_payments").select("order_id,kind,amount,validation_status").in("order_id", ids).order("id").range(from, to),
      ),
      readAllPages<PagoDiferenciaEventInput>((from, to) =>
        admin
          .from("order_events")
          .select("order_id,kind,occurred_at,actor,note,comment_type,payload")
          .in("order_id", ids)
          .in("kind", [...PAGO_DIFERENCIA_GESTION_KINDS])
          .not("actor", "is", null)
          .order("id")
          .range(from, to),
      ),
    ]);
    if (pay.error) throw new Error(`No se pudieron leer los pagos: ${pay.error.message}`);
    if (ev.error) throw new Error(`No se pudo leer la gestión: ${ev.error.message}`);
    payments.push(...pay.rows);
    events.push(...ev.rows);
  }

  const actorIds = [...new Set(events.map((e) => e.actor).filter((a): a is string => Boolean(a)))];
  // El nombre corto de siempre (la parte local del correo: «gero»), como Leads
  // y Envíos (lib/agent-names.ts).
  const names = new Map(Object.entries(actorIds.length ? await resolveAgentNames(actorIds, admin) : {}));
  return buildPagoDiferenciaRows({ orders, payments, events, names, now });
}
