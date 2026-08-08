// El barrido de estados de Tanders.
//
// Hasta ahora la única lectura de `GET /orders/{id}` vivía dentro del barrido de
// COBROS, que descarta todo lo que no esté `DELIVERED` y solo mira guías de los
// últimos ocho días. El resultado: las 55 guías Tanders creadas conservaban el
// `PENDING` del momento de creación, ninguna avanzaba sola, y 25 llevaban más de
// una semana ocupando la cola de armado de Almacén sin que nadie supiera qué
// decía Tanders de ellas.
//
// Esto lee el estado de TODAS las guías vivas —sin tope de antigüedad, que es
// justo lo que las dejaba varadas— y escribe lo que Tanders dice. Lo que no
// sabemos traducir no toca el estado: se guarda en `reported_status` y se
// devuelve en el reporte, porque su vocabulario no está documentado y la única
// forma honesta de aprenderlo es verlo.
//
// SERVER-ONLY: descifra la contraseña de la tienda.

import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/crypto";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { categoryOf, reconcileDeliveryStatus } from "@/lib/shipments";
import { TandersClient } from "@/lib/tanders/client";
import { mapTandersStatus, reconcileTandersCustodyState } from "@/lib/tanders/status";

/** Tope por pasada. Cada guía es una llamada a su API, no al modelo: barato. */
export const MAX_PER_RUN = 200;

interface Candidate {
  id: string;
  store_id: string;
  guide_code: string;
  tanders_order_id: string | null;
  order_id: string | null;
  order_name: string | null;
  delivery_status: string;
  custody_state: string | null;
  dispatched_at: string | null;
  custody_transferred_at: string | null;
}

export interface TandersStatusReport {
  scanned: number;
  /** Guías cuyo estado cambió algo. */
  aplicados: number;
  /** Leídas y sin novedad. */
  sinCambio: number;
  /** Estados que Tanders devolvió y todavía no sabemos traducir. */
  desconocidos: Record<string, number>;
  errores: number;
  /** Guías sin credenciales de tienda o sin id interno: no se pueden consultar. */
  omitidas: number;
  cambios: { guia: string; pedido: string | null; de: string; a: string; estadoTanders: string }[];
}

export async function sweepTandersStatus(
  admin: SupabaseClient,
  opts: { dry?: boolean } = {},
): Promise<TandersStatusReport> {
  const dry = opts.dry === true;

  // Vivas: lo terminal (entregado, anulado, transferido) ya no se relee.
  // Sin tope de antigüedad a propósito — una guía olvidada es exactamente la que
  // hay que ir a mirar. Las nunca leídas van primero.
  const { data, error } = await admin
    .from("shipments")
    .select(
      "id,store_id,guide_code,tanders_order_id,order_id,order_name,delivery_status," +
        "custody_state,dispatched_at,custody_transferred_at",
    )
    .eq("courier", "tanders")
    .in("delivery_status", ["pendiente", "en_ruta"])
    .not("tanders_order_id", "is", null)
    .order("last_report_at", { ascending: true, nullsFirst: true })
    .limit(MAX_PER_RUN);
  if (error) throw new Error(error.message);

  const candidates = ((data ?? []) as unknown) as Candidate[];
  const report: TandersStatusReport = {
    scanned: candidates.length,
    aplicados: 0,
    sinCambio: 0,
    desconocidos: {},
    errores: 0,
    omitidas: 0,
    cambios: [],
  };

  // Una sesión por tienda: el cliente cachea su token entre guías.
  const clients = new Map<string, TandersClient | null>();

  for (const row of candidates) {
    try {
      if (!clients.has(row.store_id)) {
        const { data: store } = await admin
          .from("stores")
          .select("tanders_email,tanders_password_enc")
          .eq("id", row.store_id)
          .maybeSingle();
        const st = store as { tanders_email: string | null; tanders_password_enc: string | null } | null;
        clients.set(
          row.store_id,
          st?.tanders_email && st.tanders_password_enc
            ? new TandersClient({ email: st.tanders_email, password: decrypt(st.tanders_password_enc) })
            : null,
        );
      }
      const client = clients.get(row.store_id);
      if (!client || !row.tanders_order_id) {
        report.omitidas += 1;
        continue;
      }

      const order = await client.getOrder(row.tanders_order_id);
      const rawStatus = typeof order?.status === "string" ? order.status : "";
      const mapped = mapTandersStatus(rawStatus);
      const nowIso = new Date().toISOString();

      // Un estado que no supimos traducir NO toca la guía: se deja constancia
      // del valor crudo para poder ampliar el mapeo con evidencia.
      if (!mapped.known) {
        report.desconocidos[mapped.code || "(vacío)"] =
          (report.desconocidos[mapped.code || "(vacío)"] ?? 0) + 1;
        if (!dry) {
          await admin
            .from("shipments")
            .update({ reported_status: rawStatus || null, last_report_at: nowIso })
            .eq("id", row.id);
        }
        continue;
      }

      const nextStatus = mapped.deliveryStatus
        ? reconcileDeliveryStatus(row.delivery_status, mapped.deliveryStatus)
        : row.delivery_status;
      const nextCustody = reconcileTandersCustodyState(row.custody_state, mapped.custodyState);

      const patch: Record<string, unknown> = {
        reported_status: rawStatus || null,
        last_report_at: nowIso,
        api_report_at: nowIso,
      };
      let changed = false;
      if (nextStatus !== row.delivery_status) {
        patch.delivery_status = nextStatus;
        patch.status_category = categoryOf(nextStatus);
        if (nextStatus === "en_ruta" && !row.dispatched_at) patch.dispatched_at = nowIso;
        changed = true;
      }
      if (nextCustody && nextCustody !== row.custody_state) {
        patch.custody_state = nextCustody;
        if (nextCustody === "courier" && !row.custody_transferred_at) {
          patch.custody_transferred_at = nowIso;
        }
        changed = true;
      }

      if (changed) {
        report.aplicados += 1;
        report.cambios.push({
          guia: row.guide_code,
          pedido: row.order_name,
          de: row.delivery_status,
          a: String(patch.delivery_status ?? row.delivery_status),
          estadoTanders: mapped.code,
        });
      } else {
        report.sinCambio += 1;
      }

      if (dry) continue;
      const { error: upErr } = await admin.from("shipments").update(patch).eq("id", row.id);
      if (upErr) throw new Error(upErr.message);
      // El Master se recalcula desde las guías; sin esto el cambio no llega a
      // /dashboard/pedidos ni saca la caja de la cola de armado.
      if (changed && row.order_id) await recomputeOrderMasterSafe(admin, [row.order_id]);
    } catch {
      // Una guía que falla no puede tumbar el barrido de las demás.
      report.errores += 1;
    }
  }

  return report;
}
