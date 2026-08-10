// Lectura de las dos saludes de Aliclik. La decisión es pura y vive en
// lib/aliclik-health.ts; aquí solo está el acceso a datos.
//
// UN SOLO SITIO A PROPÓSITO. Esto lo consultan el drawer del Master y el de
// leads. Estaba duplicado —con un comentario que decía «espeja» al otro—, y al
// añadir la salud de creación las dos copias habrían empezado a divergir: una
// pintando el foco nuevo y la otra el verde de siempre, en la misma pantalla y
// para la misma API.

import type { createServerSupabase } from "@/lib/db";
import {
  resolveAliclikHealth,
  resolveAliclikCreateHealth,
  CREATE_WINDOW_MS,
  type AliclikHealthState,
} from "@/lib/aliclik-health";

const UNKNOWN: AliclikHealthState = { quote: "sin_monitoreo", create: "sin_datos" };

/** Techo de intentos que se traen. La racha reciente se decide con los primeros;
 * pedir más solo cargaría historia que no cambia el resultado. */
const ATTEMPT_LIMIT = 20;

interface AttemptRow {
  status: string;
  error: string | null;
  created_at: string;
}

/**
 * Las dos saludes de Aliclik para la org a la que pertenece esta tienda.
 *
 * COTIZAR sale de la sonda del cron. CREAR se deduce de los intentos reales,
 * porque crear un pedido es una escritura irreversible y no se puede sondear sin
 * crear una guía de verdad.
 *
 * Ámbito ORG, no tienda: una org es un token Aliclik, así que una degradación la
 * viven todas sus tiendas por igual — el mismo criterio que aplica la sonda.
 */
export async function loadAliclikHealthState(
  sb: Awaited<ReturnType<typeof createServerSupabase>>,
  storeId: string | null,
): Promise<AliclikHealthState> {
  if (!storeId) return UNKNOWN;

  const { data: store } = await sb
    .from("stores")
    .select("org_id")
    .eq("id", storeId)
    .maybeSingle();
  const orgId = (store as { org_id?: string } | null)?.org_id;
  if (!orgId) return UNKNOWN;

  const { data: siblings } = await sb.from("stores").select("id").eq("org_id", orgId);
  const storeIds = ((siblings ?? []) as { id: string }[]).map((s) => s.id);
  const since = new Date(Date.now() - CREATE_WINDOW_MS).toISOString();

  const [probe, attempts] = await Promise.all([
    sb
      .from("aliclik_health_checks")
      .select("status,checked_at")
      .eq("org_id", orgId)
      .order("checked_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    storeIds.length
      ? sb
          .from("aliclik_order_requests")
          .select("status,error,created_at")
          .in("store_id", storeIds)
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(ATTEMPT_LIMIT)
      : Promise.resolve({ data: [] as AttemptRow[] }),
  ]);

  const latest = probe.data as { status: string; checked_at: string } | null;
  const rows = (attempts.data ?? []) as AttemptRow[];
  const now = Date.now();

  return {
    quote: resolveAliclikHealth(
      latest ? { status: latest.status, checkedAt: latest.checked_at } : null,
      now,
    ),
    create: resolveAliclikCreateHealth(
      rows.map((r) => ({ status: r.status, error: r.error, createdAt: r.created_at })),
      now,
    ),
  };
}
