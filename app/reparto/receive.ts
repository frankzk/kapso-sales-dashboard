"use server";
import { getCurrentUser } from "@/lib/access";
import { createAdminSupabase } from "@/lib/db";
import { normalizeDispatchScan } from "@/lib/dispatch";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { revalidatePath } from "next/cache";

const PATHS = ["/reparto", "/dashboard/courier/rutas", "/dashboard/courier", "/dashboard/courier/reparto"];

export async function receiveMyGfPackage(manifestId: string, rawCode: string): Promise<{ error?: string; notice?: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: "Inicia sesión para recibir tu carga." };
  const code = normalizeDispatchScan(rawCode).slice(0, 200);
  if (!code) return { error: "Escanea el QR del paquete." };
  const admin = createAdminSupabase();
  // RPC checks the active rider's user_id, locks the load and finalizes atomically.
  const { data, error } = await admin.rpc("gf_rider_receive", { p_manifest_id: manifestId, p_code: code, p_actor: user.id });
  if (error) return { error: error.message };
  await recomputeOrderMasterSafe(admin, (data ?? []) as string[]);
  for (const path of PATHS) revalidatePath(path);
  return { notice: data?.length ? "Carga recibida. Ya está en tu reparto." : "Paquete recibido." };
}

/** Motivos cortos de «no lo recojo». Cerrados para poder contarlos por motorizado. */
export const DECLINE_REASONS = [
  { code: "no_esta", label: "No está en la caja" },
  { code: "danado", label: "Está dañado" },
  { code: "no_cabe", label: "No cabe en la moto" },
  { code: "otro", label: "Otro" },
] as const;

/**
 * «No lo recojo» (0174, MOM §29.13): el motorizado rechaza un paquete de su
 * caja con motivo. El RPC lo retira de la carga con rastro, avisa al pedido,
 * devuelve la solicitud a «por asignar» y, si todo lo demás ya fue recibido,
 * pasa la custodia con los aceptados.
 */
export async function declineMyGfPackage(manifestId: string, shipmentId: string, reasonCode: string, note: string): Promise<{ error?: string; notice?: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: "Inicia sesión para recibir tu carga." };
  const reason = DECLINE_REASONS.find((r) => r.code === reasonCode);
  if (!reason) return { error: "Elige por qué no lo recoges." };
  const detail = note.trim();
  if (reason.code === "otro" && detail.length < 3) return { error: "Con «Otro», di en una línea qué pasó." };
  const text = detail ? `${reason.label}: ${detail}` : reason.label;
  const admin = createAdminSupabase();
  const { data, error } = await admin.rpc("gf_rider_decline", { p_manifest_id: manifestId, p_shipment_id: shipmentId, p_reason: text, p_actor: user.id });
  if (error) return { error: error.message };
  await recomputeOrderMasterSafe(admin, (data ?? []) as string[]);
  for (const path of PATHS) revalidatePath(path);
  return { notice: data?.length ? "Anotado. Tu caja quedó recibida con lo demás y ya está en tu reparto." : "Anotado: el supervisor lo verá y lo asignará a otro." };
}
