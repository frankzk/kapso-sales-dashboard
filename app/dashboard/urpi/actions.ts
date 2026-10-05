"use server";

import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { requireUrpiStore } from "@/lib/urpi-programming-access";
import { spreadsheetIdFromUrl, validMonth, parseUrpiProgramming, urpiPrefixesSeparable, urpiStorePrefix } from "@/lib/urpi-programming";
import { readUrpiGoogleWorkbook } from "@/lib/urpi-google-sheets";
import { saveUrpiProgramming, type UrpiSource } from "@/lib/urpi-programming-db";

export interface UrpiActionResult { ok: boolean; message: string; sourceId?: string }

/** Un libro de Urpi mezcla tiendas: se registra una fuente por tienda con el
 * prefijo de `stores.order_prefix`, nunca uno escrito a mano. */
export async function registerUrpiSource(input: { storeIds: string[]; month: string; url: string }): Promise<UrpiActionResult> {
  try {
    const storeIds = [...new Set(input.storeIds)];
    if (!storeIds.length || storeIds.length > 10) throw new Error("Selecciona la tienda del archivo.");
    if (!validMonth(input.month)) throw new Error("Selecciona un mes válido.");
    const spreadsheetId = spreadsheetIdFromUrl(input.url);
    const access = await Promise.all(storeIds.map((id) => requireUrpiStore(id, true)));
    const admin = createAdminSupabase();
    const { data: prefixRows, error: prefixError } = await admin.from("stores").select("id,order_prefix").in("id", storeIds);
    if (prefixError) throw new Error("No se pudo leer el prefijo de pedidos de la tienda.");
    const targets = access.map(({ store }) => {
      const prefix = urpiStorePrefix(prefixRows?.find((row) => row.id === store.id)?.order_prefix);
      if (!prefix) throw new Error(`${store.name} no tiene prefijo de pedidos configurado. Revísalo en Ajustes de la tienda.`);
      return { store, prefix };
    });
    if (!urpiPrefixesSeparable(targets.map((target) => target.prefix))) throw new Error("Los prefijos de las tiendas se solapan; no se pueden separar sus pedidos en un mismo archivo.");
    const { data: existing, error: readError } = await admin.from("urpi_programming_sources").select("id,store_id,order_prefix")
      .in("store_id", storeIds).eq("spreadsheet_id", spreadsheetId).eq("month", input.month);
    if (readError) throw new Error("No se pudo consultar el registro de archivos.");
    const registered = new Map((existing ?? []).map((row) => [String(row.store_id), row]));
    const changed = targets.find((target) => registered.has(target.store.id) && registered.get(target.store.id)!.order_prefix !== target.prefix);
    if (changed) throw new Error(`Este archivo ya está registrado para ${changed.store.name} con otro prefijo. Revisa el prefijo en Ajustes de la tienda.`);
    const missing = targets.filter((target) => !registered.has(target.store.id));
    const label = targets.map((target) => `${target.store.name} (${target.prefix})`).join(" y ");
    if (missing.length) {
      const { data, error } = await admin.from("urpi_programming_sources").insert(missing.map(({ store, prefix }) => ({
        store_id: store.id, spreadsheet_id: spreadsheetId, month: input.month, order_prefix: prefix,
        name: `${store.name} · ${input.month}`, created_by: access[0]!.user.id,
      }))).select("id,store_id,order_prefix");
      if (error || data?.length !== missing.length) throw new Error("No se pudo registrar el archivo mensual. Actualiza la página y vuelve a intentar.");
      for (const row of data) registered.set(String(row.store_id), row);
      revalidatePath("/dashboard/urpi");
    }
    const sourceId = String(registered.get(targets[0]!.store.id)!.id);
    if (!missing.length) return { ok: true, message: `El archivo ya estaba registrado para ${label}.`, sourceId };
    return { ok: true, message: `Archivo registrado para ${label}. Ahora puedes leer Google Sheets o cargar el Excel.`, sourceId };
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
