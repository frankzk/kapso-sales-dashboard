"use server";

import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { requireUrpiStore } from "@/lib/urpi-programming-access";
import { spreadsheetIdFromUrl, validMonth, parseUrpiProgramming } from "@/lib/urpi-programming";
import { readUrpiGoogleWorkbook } from "@/lib/urpi-google-sheets";
import { saveUrpiProgramming, type UrpiSource } from "@/lib/urpi-programming-db";

export interface UrpiActionResult { ok: boolean; message: string; sourceId?: string }

export async function registerUrpiSource(input: { storeId: string; month: string; url: string; prefix: string }): Promise<UrpiActionResult> {
  try {
    const { user, store } = await requireUrpiStore(input.storeId, true);
    if (!validMonth(input.month)) throw new Error("Selecciona un mes válido.");
    const spreadsheetId = spreadsheetIdFromUrl(input.url);
    const prefix = input.prefix.trim().toUpperCase();
    if (!/^[A-Z]{1,12}$/.test(prefix)) throw new Error("Indica el prefijo de pedidos, por ejemplo KP o AUR.");
    const admin = createAdminSupabase();
    const { data: existing, error: readError } = await admin.from("urpi_programming_sources").select("id,order_prefix")
      .eq("store_id", store.id).eq("spreadsheet_id", spreadsheetId).eq("month", input.month).maybeSingle();
    if (readError) throw new Error("No se pudo consultar el registro de archivos.");
    if (existing) {
      if (existing.order_prefix !== prefix) throw new Error("Este archivo ya está registrado con otro prefijo. Revisa la tienda seleccionada.");
      return { ok: true, message: "El archivo ya estaba registrado.", sourceId: String(existing.id) };
    }
    const { data, error } = await admin.from("urpi_programming_sources").insert({
      store_id: store.id, spreadsheet_id: spreadsheetId, month: input.month, order_prefix: prefix,
      name: `${store.name} · ${input.month}`, created_by: user.id,
    }).select("id").single();
    if (error || !data) throw new Error("No se pudo registrar el archivo mensual. Actualiza la página y vuelve a intentar.");
    revalidatePath("/dashboard/urpi");
    return { ok: true, message: "Archivo registrado. Ahora puedes leer Google Sheets o cargar el Excel.", sourceId: String(data.id) };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "No se pudo registrar el archivo." }; }
}

export async function syncUrpiSource(sourceId: string): Promise<UrpiActionResult> {
  const startedAt = new Date().toISOString();
  try {
    const sb = await createServerSupabase();
    const { data, error } = await sb.from("urpi_programming_sources").select("*").eq("id", sourceId).maybeSingle();
    if (error || !data) throw new Error("El archivo no existe o no tienes acceso.");
    const source = data as UrpiSource;
    const { user } = await requireUrpiStore(source.store_id);
    const workbook = await readUrpiGoogleWorkbook(source.spreadsheet_id, source.month);
    const parsed = parseUrpiProgramming(workbook.tabs, source.month, source.order_prefix);
    const result = await saveUrpiProgramming(createAdminSupabase(), source, parsed, { actor: user.id, startedAt, origin: "google", filename: null });
    revalidatePath("/dashboard/urpi");
    return { ok: true, message: `${result.changed ? "Programación actualizada" : "Sin cambios"}: ${result.rows} registros, ${result.linked} vinculados a Kapta.` };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "No se pudo leer Google Sheets." }; }
}
