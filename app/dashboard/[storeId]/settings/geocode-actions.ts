"use server";

// Ajustes → «Coordenada por dirección (piloto)» (docs/kapta/geocodificacion-propuesta.md):
// el botón que mide el geocodificador de Google contra los pedidos cuyo pin ya
// puso una persona. Con «Administrar tiendas» (`stores.manage`: owner/admin, o
// el rol Administración), como las demás conexiones de la tienda: cada pasada
// gasta consultas de la cuenta de Google del owner.
//
// No escribe nada en la base y devuelve solo números agregados
// (lib/geocode-google-server.ts). Sin GOOGLE_GEOCODING_API_KEY no llama a nada.

import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { hasOrgPermission } from "@/lib/permissions-access";
import { runGeocodePilot } from "@/lib/geocode-google-server";
import { GEOCODE_KEY_MISSING, type GeocodePilotReport } from "@/lib/geocode-google";

export interface GeocodePilotState {
  error?: string;
  report?: GeocodePilotReport;
}

/** «Medir con los pedidos que ya tienen ubicación». */
export async function runGeocodePilotAction(_prev: GeocodePilotState, formData: FormData): Promise<GeocodePilotState> {
  const storeId = String(formData.get("store_id") ?? "");
  if (!storeId) return { error: "Sin permiso." };
  const admin = createAdminSupabase();
  const { data: store } = await admin.from("stores").select("id, org_id").eq("id", storeId).maybeSingle();
  if (!store) return { error: "Sin permiso." };
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  if (!(await hasOrgPermission((store as { org_id: string }).org_id, "stores.manage"))) return { error: "Sin permiso." };

  const key = env.googleGeocodingApiKey();
  if (!key) return { error: GEOCODE_KEY_MISSING };

  try {
    const run = await runGeocodePilot(admin, storeId, { key });
    return run.ok ? { report: run.report } : { error: run.error };
  } catch (e) {
    // El mensaje es de la base (lectura del Master o de `orders`), sin datos de clientes.
    return { error: `No se pudo medir: ${e instanceof Error ? e.message : String(e)}` };
  }
}
