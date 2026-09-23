"use server";
import { getCurrentUser } from "@/lib/access";
import { createAdminSupabase } from "@/lib/db";
import { normalizeDispatchScan } from "@/lib/dispatch";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { revalidatePath } from "next/cache";
import { DECLINE_REASONS } from "@/lib/rider-decline-reasons";

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

/**
 * «No lo recojo» (0182, MOM §29.13): el motorizado rechaza un paquete de su
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

/**
 * «Lo llevo» (0185, modo `confirmar`): el motorizado confirma un paquete de su
 * caja ya en custodia al sacarlo del almacén. Por ítem (botón de la parada) o
 * por código escaneado (gesto único, «Confirmar todos»); si vienen ambos, el
 * código tiene que ser del mismo paquete. Idempotente.
 */
export async function confirmMyGfPickup(input: { itemId?: string | null; code?: string | null }): Promise<{ error?: string; notice?: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: "Inicia sesión para confirmar tu carga." };
  const admin = createAdminSupabase();
  let itemId = input.itemId ?? null;
  const code = normalizeDispatchScan(input.code ?? "").slice(0, 200);
  if (!itemId && !code) return { error: "Escanea el QR del paquete." };
  if (code) {
    const { data: rider } = await admin.from("riders").select("id").eq("user_id", user.id).eq("active", true).maybeSingle();
    if (!rider) return { error: "Tu usuario no tiene ficha de motorizado." };
    const { data: loads } = await admin.from("dispatch_manifests").select("id").eq("rider_id", rider.id).eq("courier", "propio").eq("state", "in_custody")
      .gte("route_date", new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10));
    const manifestIds = (loads ?? []).map((l) => l.id as string);
    if (!manifestIds.length) return { error: "No tienes una caja en tu poder." };
    const { data: rows } = await admin
      .from("dispatch_manifest_items")
      .select("id,shipments!inner(qr_token,output_code,guide_code,order_name)")
      .in("manifest_id", manifestIds)
      .is("removed_at", null);
    const wanted = code.toLowerCase().replace(/^#/, "");
    const matches = ((rows ?? []) as unknown as Array<{ id: string; shipments: { qr_token: string | null; output_code: string | null; guide_code: string | null; order_name: string | null } | null }>)
      .filter((row) => {
        const sh = row.shipments;
        if (!sh) return false;
        return [sh.qr_token, sh.output_code, sh.guide_code, sh.order_name?.replace(/^#/, "")]
          .some((v) => typeof v === "string" && v.toLowerCase() === wanted);
      });
    if (matches.length !== 1) return { error: matches.length ? "Ese código coincide con más de un paquete; usa el botón de la parada." : "Ese paquete no está en tu caja." };
    if (itemId && matches[0]!.id !== itemId) return { error: "Ese QR es de otro paquete de tu caja." };
    itemId = matches[0]!.id;
  }
  const { data, error } = await admin.rpc("gf_rider_confirm_pickup", { p_item_id: itemId, p_actor: user.id });
  if (error) return { error: error.message };
  if (data) await recomputeOrderMasterSafe(admin, [data as string]);
  for (const path of PATHS) revalidatePath(path);
  return { notice: "Lo llevas. Ya está confirmado en tu ruta." };
}
