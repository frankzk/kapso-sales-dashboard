"use server";
import { getCurrentUser } from "@/lib/access";
import { createAdminSupabase } from "@/lib/db";
import { normalizeDispatchScan } from "@/lib/dispatch";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { revalidatePath } from "next/cache";

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
  for (const path of ["/reparto", "/dashboard/courier/rutas", "/dashboard/courier", "/dashboard/rutas"]) revalidatePath(path);
  return { notice: data?.length ? "Carga recibida. Ya está en tu reparto." : "Paquete recibido." };
}
