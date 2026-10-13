"use server";
import { revalidatePath } from "next/cache";
import { hasOrgPermission } from "@/lib/permissions-access";
import { createAdminSupabase } from "@/lib/db";
import { runAutoDispatch } from "@/lib/swayp-auto-server";
import type { AutoSettings } from "@/lib/swayp-auto-policy";

async function authorized(orgId: string) {
  // Activar o pausar el despacho automático cambia la salida de todos los pedidos
  // de la organización: «Administrar tiendas» (MOM §16), no «es owner o admin».
  if (!(await hasOrgPermission(orgId, "stores.manage"))) throw new Error("Tu rol no permite cambiar el automático.");
  if (process.env.VERCEL_ENV!=="production") throw new Error("Disponible solo en producción");
  return createAdminSupabase();
}
export async function toggleAutomatic(form: FormData) {
  const orgId=String(form.get("orgId")),admin=await authorized(orgId);
  const {error}=await admin.from("swayp_auto_settings").update({enabled:form.get("enabled")==="true",updated_at:new Date().toISOString()}).eq("org_id",orgId);
  if(error) throw new Error(error.message);
  revalidatePath("/dashboard/envios/automatico");
}
export async function runAutomatic(form: FormData) {
  const orgId=String(form.get("orgId")),admin=await authorized(orgId);
  const {data,error}=await admin.from("swayp_auto_settings").select("*").eq("org_id",orgId).single();
  if(error) throw new Error(error.message);
  await runAutoDispatch(admin,data as AutoSettings);
  revalidatePath("/dashboard/envios/automatico");
}
export async function togglePilot(form: FormData) {
  const orgId=String(form.get("orgId")),admin=await authorized(orgId);
  const {error}=await admin.from("swayp_auto_settings").update({pilot_enabled:form.get("enabled")==="true",updated_at:new Date().toISOString()}).eq("org_id",orgId);
  if(error) throw new Error(error.message);
  revalidatePath("/dashboard/envios/automatico");
}
