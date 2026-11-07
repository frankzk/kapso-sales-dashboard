// Guardar la coordenada de un pedido donde la deja «Corregir ubicación»
// (`order_geo_overrides`) y de donde la lee el recálculo del Master, sin borrar
// lo demás que ese registro tuviera. La usan las puertas que exigen la
// ubicación antes de programar con Aliclik: «Programar envío» y «Sale el» del
// Master (MOM §6.2) y «Confirma fecha» con Aliclik en Repro Lima (§9.5).
import type { createAdminSupabase } from "@/lib/db";

type Admin = ReturnType<typeof createAdminSupabase>;

export async function saveOrderCoordinate(
  admin: Admin,
  input: { orderId: string; storeId: string; userId: string; lat: number; lng: number },
): Promise<string | null> {
  const { data: existing, error: readError } = await admin
    .from("order_geo_overrides")
    .select("region,province,district,address,reference,note")
    .eq("order_id", input.orderId)
    .maybeSingle();
  if (readError) return `No se pudo guardar la ubicación: ${readError.message}`;
  const { error } = await admin.from("order_geo_overrides").upsert(
    {
      ...((existing as Record<string, string | null> | null) ?? {}),
      order_id: input.orderId,
      store_id: input.storeId,
      latitude: input.lat,
      longitude: input.lng,
      updated_by: input.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "order_id" },
  );
  return error ? `No se pudo guardar la ubicación: ${error.message}` : null;
}
