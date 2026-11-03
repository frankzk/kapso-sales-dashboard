// ¿El QR escaneado es el de una salida ANULADA? Decirlo, y qué hacer.
//
// AUR178551-S01 la anuló una compañera el 24-10-2026 a las 10:28 de Lima
// (`route_output_cancelled`, «Anular salida» de la ficha: la caja nunca salió
// de la empresa). Más tarde alguien escaneó su rótulo impreso en Despacho del
// día para meterla en la caja de un motorizado y el escaneo respondió «La caja
// existente ya no está disponible para asignarla.»: cierto, pero no decía que
// esa salida estaba anulada, ni quién ni cuándo, ni que el rótulo pegado en la
// caja ya no sirve. Con eso a la vista el paso es inmediato: crear una salida
// nueva desde la ficha e imprimir su rótulo.
//
// Solo cambia EL MENSAJE de un escaneo que ya falló (`scanAssignToRider`): no
// reactiva nada ni toca las reglas de tomar y asignar. Si el pedido tiene otra
// salida viva, ese es el rótulo que sirve y el motivo del fallo es el de
// siempre; se dice detrás. Un pedido anulado se sigue diciendo antes que esto
// (lib/scan-cancelled.ts): no sale, con salida o sin ella.

import type { SupabaseClient } from "@supabase/supabase-js";
import { limaWhen } from "@/lib/gf-delivery";
import { isActiveOutput, type OutputForDecision } from "@/lib/labels/resolve-output";
import { ROUTE_OUTPUT_CANCELLED } from "@/lib/shipment-output";

/** Qué hacer con un rótulo anulado cuando el pedido no tiene otra salida viva. */
export const ANNULLED_OUTPUT_NEXT_STEP =
  "Crea una salida nueva desde la ficha del pedido (Operar → Crear salida) e imprime su rótulo; este rótulo ya no sirve.";

/**
 * Los hechos que anulan una salida y dejan su `shipment_id`: «Anular salida»
 * de la ruta manual (`route_output_cancelled`) y «Anular guía» de Swayp
 * (`guide_cancelled`). El más reciente es el que cuenta.
 */
export const OUTPUT_ANNUL_EVENT_KINDS = [ROUTE_OUTPUT_CANCELLED, "guide_cancelled"] as const;

export interface AnnulledOutputFacts {
  /** `AUR178551-S01`; sin código, «Esta salida». */
  outputCode: string | null;
  /** Cuándo se anuló (el evento); null si no consta. */
  annulledAt: string | null;
  /** Quién la anuló, como se nombra en Kapta; null si el evento no tiene actor. */
  actorName: string | null;
  /** Otra salida viva del pedido: su rótulo es el que sirve. */
  liveOutputCode?: string | null;
  /** El motivo del fallo tal como lo dio el escaneo: solo se dice si queda otra salida viva. */
  reason?: string | null;
}

/**
 * El aviso para quien escanea. Pura.
 *
 * «AUR178551-S01 está ANULADA (la anuló rosa.perez el 24/10 a las 10:28). Crea una
 * salida nueva desde la ficha del pedido (Operar → Crear salida) e imprime su
 * rótulo; este rótulo ya no sirve.»
 */
export function annulledOutputScanMessage(facts: AnnulledOutputFacts): string {
  const code = facts.outputCode?.trim() || "Esta salida";
  // `limaWhen` da «24/10 10:28» (o solo el día): se lee mejor con «a las».
  const [day, time] = (limaWhen(facts.annulledAt) ?? "").split(" ");
  const at = day ? ` el ${day}${time ? ` a las ${time}` : ""}` : "";
  const actor = facts.actorName?.trim();
  const detail = actor ? `la anuló ${actor}${at}` : at ? `se anuló${at}` : "";
  const head = `${code} está ANULADA${detail ? ` (${detail})` : ""}`;
  const live = facts.liveOutputCode?.trim();
  if (live) {
    const reason = facts.reason?.trim();
    return `${head}: este rótulo ya no sirve; el pedido sigue con ${live}.${reason ? ` ${reason}` : ""}`;
  }
  return `${head}. ${ANNULLED_OUTPUT_NEXT_STEP}`;
}

/** Lo que se lee de cada salida del pedido. */
type OutputRow = OutputForDecision & { guide_code?: string | null };

const OUTPUT_COLUMNS =
  "id,output_code,guide_code,delivery_status,custody_state,created_at,output_number,courier,reported_status,swayp_state,dispatched_at,returned_at";

/**
 * Quien anuló, con el nombre corto de Kapta: la parte local del correo, la
 * misma regla que lib/agent-names.ts (Leads, Envíos, Repro Lima). No se
 * importa de ahí porque ese módulo es `server-only` y el escaneo de Grupo GF
 * se prueba cargando sus acciones. Nunca lanza.
 */
async function actorShortName(admin: SupabaseClient, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  try {
    const { data } = await admin.auth.admin.getUserById(userId);
    const email = data?.user?.email ?? null;
    return email ? email.split("@")[0]! : null;
  } catch {
    return null;
  }
}

/**
 * Si la salida escaneada está anulada, el aviso con su código, cuándo, quién
 * y qué hacer; si no, null y el escaneo dice lo de siempre. Solo se llama
 * cuando el escaneo ya falló: el camino normal no paga estas lecturas. Un
 * fallo de lectura no cambia nada (null).
 */
export async function annulledOutputScanNotice(
  admin: SupabaseClient,
  scanned: { id: string; order_id: string | null } | null | undefined,
  reason: string,
): Promise<string | null> {
  if (!scanned?.id || !scanned.order_id) return null;
  try {
    const { data } = await admin.from("shipments").select(OUTPUT_COLUMNS).eq("order_id", scanned.order_id);
    const outputs = (Array.isArray(data) ? data : []) as OutputRow[];
    const output = outputs.find((row) => row.id === scanned.id);
    if (!output || output.delivery_status !== "anulado") return null;
    // Otra salida que sigue viva en Lima (la misma regla que el rótulo):
    // la de consecutivo más alto, que es la caja que se arma.
    const live = outputs
      .filter((row) => row.id !== output.id && isActiveOutput(row, { lima: true }))
      .sort((a, b) => (b.output_number ?? 0) - (a.output_number ?? 0))[0];
    const { data: event } = await admin
      .from("order_events")
      .select("actor,occurred_at")
      .eq("shipment_id", output.id)
      .in("kind", [...OUTPUT_ANNUL_EVENT_KINDS])
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const annul = event as { actor?: string | null; occurred_at?: string | null } | null;
    return annulledOutputScanMessage({
      outputCode: output.output_code ?? output.guide_code ?? null,
      annulledAt: annul?.occurred_at ?? null,
      actorName: await actorShortName(admin, annul?.actor),
      liveOutputCode: live ? live.output_code ?? live.guide_code ?? "otra salida" : null,
      reason,
    });
  } catch {
    return null;
  }
}
