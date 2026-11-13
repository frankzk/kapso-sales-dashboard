import "server-only";

// La guía de Aliclik deja «en devolución» la caja de Grupo GF que el
// motorizado todavía tiene «No entregado» (owner, 12-11-2026; 0329, MOM §9.5).
// Lo llaman los dos sitios que guardan una guía de Aliclik nueva: la creación
// (`createAliclikGuideFor`) y el rescate de la huérfana
// (`/api/cron/aliclik-reconcile`). Las reglas viven en la base; aquí solo se
// llama y se lee la respuesta (lib/gf-replaced-output.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import { GF_REPLACE_WITH_ALICLIK_RPC, replacedByGuideFrom, type ReplacedByGuide } from "@/lib/gf-replaced-output";

/**
 * Best-effort: la guía ya existe en Aliclik y un fallo aquí no la deshace. Sin
 * la función (la 0329 todavía sin aplicar) o con un error, no reemplaza nada y
 * lo dice en `error`; el pedido queda como antes y el barrido de la 0329 lo
 * arregla al aplicarla.
 */
export async function replaceOwnBoxWithAliclikGuide(
  admin: SupabaseClient,
  guideShipmentId: string,
  actor: string | null,
): Promise<{ replaced: ReplacedByGuide[]; error?: string }> {
  try {
    const { data, error } = await admin.rpc(GF_REPLACE_WITH_ALICLIK_RPC, {
      p_guide_shipment: guideShipmentId,
      p_actor: actor,
    });
    if (error) return { replaced: [], error: error.message };
    return { replaced: replacedByGuideFrom(data) };
  } catch (error) {
    return { replaced: [], error: error instanceof Error ? error.message : String(error) };
  }
}
