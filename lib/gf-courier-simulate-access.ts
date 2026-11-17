import "server-only";

// Quién entra a la simulación de GF Courier (MOM §29.17): solo el owner de la organización, y solo con las tiendas de
// su organización que tienen token de GF guardado. El token se descifra aquí, en el servidor, y nunca sale de él.
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { decryptOrNull } from "@/lib/crypto";
import type { GfSimStore } from "@/lib/gf-courier-simulate-server";

export async function loadGfSimulationStores(): Promise<{ admin: ReturnType<typeof createAdminSupabase>; stores: GfSimStore[] } | null> {
  const sb = await createServerSupabase();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const admin = createAdminSupabase();
  const { data: owner, error } = await admin.from("memberships").select("org_id").eq("user_id", user.id).eq("role", "owner");
  if (error) throw new Error(`No se pudo comprobar el permiso: ${error.message}`);
  const orgIds = [...new Set(((owner ?? []) as { org_id: string }[]).map((m) => m.org_id))];
  if (!orgIds.length) return null;
  const { data: rows, error: storeError } = await admin.from("stores").select("id,name,gf_courier_api_token_enc")
    .in("org_id", orgIds).not("gf_courier_api_token_enc", "is", null).order("name");
  if (storeError) throw new Error(`No se pudieron leer las tiendas: ${storeError.message}`);
  const stores: GfSimStore[] = [];
  for (const r of (rows ?? []) as { id: string; name: string; gf_courier_api_token_enc: string | null }[]) {
    const token = decryptOrNull(r.gf_courier_api_token_enc);
    if (token) stores.push({ id: r.id, name: r.name, token });
  }
  return { admin, stores };
}
