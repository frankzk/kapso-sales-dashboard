// La lectura de «Guías de Swayp que Kapta no tiene» para Envíos (MOM §11.2, 0282).
// Con el cliente de la sesión (RLS): la tabla la ve la organización de la
// cuenta de Swayp, y los pedidos sugeridos solo salen de las tiendas que la
// persona ya puede ver.

import { createServerSupabase } from "@/lib/db";
import { SWAYP_STATES } from "@/lib/swayp-states";

export interface SwaypUnknownGuide {
  guideNumber: string;
  state: number;
  stateLabel: string;
  firstSeenAt: string;
  lastSeenAt: string;
  notices: number;
  customerName: string | null;
  customerPhone: string | null;
  reference: string | null;
  /** El pedido que probablemente es: por el número que nombra la guía o por el celular. */
  suggestion: { orderId: string; orderName: string; by: "pedido" | "celular" } | null;
}

interface Row {
  guide_number: string;
  last_state: number;
  first_seen_at: string;
  last_seen_at: string;
  notices: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  reference: string | null;
}

/** Cuántas se enseñan: las más recientes; una lista más larga ya no se lee. */
const LIMIT = 30;
/** El pedido sugerido por celular: creado hasta 45 días antes del aviso. */
const PHONE_WINDOW_MS = 45 * 86_400_000;

/**
 * Las guías pendientes: sin descartar y que todavía no están en `shipments`
 * (una guía que se registró después deja de salir sola). Null si no se pudo
 * leer (sin la 0282, por ejemplo): Envíos no enseña la tarjeta.
 */
export async function getSwaypUnknownGuides(storeIds: string[]): Promise<SwaypUnknownGuide[] | null> {
  const sb = await createServerSupabase();
  const { data, error } = await sb
    .from("swayp_unknown_guides")
    .select("guide_number,last_state,first_seen_at,last_seen_at,notices,customer_name,customer_phone,reference")
    .is("dismissed_at", null)
    .order("last_seen_at", { ascending: false })
    .limit(LIMIT);
  if (error) return null;
  const rows = (data ?? []) as Row[];
  if (!rows.length) return [];

  const numbers = rows.map((r) => r.guide_number);
  const { data: known } = await sb.from("shipments").select("swayp_guide").in("swayp_guide", numbers);
  const registered = new Set(((known ?? []) as { swayp_guide: string | null }[]).map((s) => s.swayp_guide));
  const open = rows.filter((r) => !registered.has(r.guide_number));
  if (!open.length || !storeIds.length) return open.map((r) => toGuide(r, null));

  const names = [...new Set(open.map((r) => r.reference).filter((ref): ref is string => !!ref && ref.startsWith("#")))];
  const phones = [...new Set(open.map((r) => r.customer_phone).filter((p): p is string => !!p))];
  const [byName, byPhone] = await Promise.all([
    names.length
      ? sb.from("orders").select("id,name").in("store_id", storeIds).in("name", names)
      : Promise.resolve({ data: [] as unknown[] }),
    phones.length
      ? sb
          .from("orders")
          .select("id,name,customer_phone,created_at")
          .in("store_id", storeIds)
          .in("customer_phone", phones)
          .is("cancelled_at", null)
          .order("created_at", { ascending: false })
          .limit(200)
      : Promise.resolve({ data: [] as unknown[] }),
  ]);
  const orderByName = new Map(((byName.data ?? []) as { id: string; name: string }[]).map((o) => [o.name, o]));
  const ordersByPhone = (byPhone.data ?? []) as { id: string; name: string; customer_phone: string; created_at: string }[];

  return open.map((r) => {
    const named = r.reference ? orderByName.get(r.reference) : undefined;
    if (named) return toGuide(r, { orderId: named.id, orderName: named.name, by: "pedido" });
    const seen = Date.parse(r.first_seen_at);
    const phoneOrder = r.customer_phone
      ? ordersByPhone.find((o) => {
          const created = Date.parse(o.created_at);
          return o.customer_phone === r.customer_phone && created <= seen && seen - created <= PHONE_WINDOW_MS;
        })
      : undefined;
    return toGuide(r, phoneOrder ? { orderId: phoneOrder.id, orderName: phoneOrder.name, by: "celular" } : null);
  });
}

function toGuide(r: Row, suggestion: SwaypUnknownGuide["suggestion"]): SwaypUnknownGuide {
  return {
    guideNumber: r.guide_number,
    state: r.last_state,
    stateLabel: SWAYP_STATES[r.last_state] ?? `Estado ${r.last_state}`,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    notices: Number(r.notices ?? 1),
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    reference: r.reference,
    suggestion,
  };
}
