import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { requireUrpiStore } from "./urpi-programming-access";
import { parseUrpiProgramming, type UrpiTab } from "./urpi-programming";
import { saveUrpiProgramming, type UrpiSource } from "./urpi-programming-db";

export interface UrpiBook {
  actor: string;
  targets: { source: UrpiSource; label: string }[];
  skipped: string[];
}

export interface UrpiBookResult { ok: boolean; saved: number; message: string }

/** Un libro mixto se registra como una fuente por tienda (mismo Sheet y mes).
 * Importar una de ellas importa todas las que el usuario puede editar; la
 * pedida exige permiso, las demás sin permiso se informan y no se tocan. */
export async function openUrpiBook(sourceId: string): Promise<UrpiBook> {
  const sb = await createServerSupabase();
  const { data, error } = await sb.from("urpi_programming_sources").select("*").eq("id", sourceId).maybeSingle();
  if (error || !data) throw new Error("El archivo no existe o no tienes acceso.");
  const source = data as UrpiSource;
  const { user, store } = await requireUrpiStore(source.store_id);
  // RLS limita las hermanas a las tiendas que el usuario ya puede leer.
  const { data: siblings, error: siblingsError } = await sb.from("urpi_programming_sources").select("*")
    .eq("spreadsheet_id", source.spreadsheet_id).eq("month", source.month).neq("id", source.id);
  if (siblingsError) throw new Error("No se pudo consultar las tiendas del archivo.");
  const book: UrpiBook = { actor: user.id, targets: [{ source, label: `${store.name} (${source.order_prefix})` }], skipped: [] };
  for (const sibling of (siblings ?? []) as UrpiSource[]) {
    try {
      const { store: other } = await requireUrpiStore(sibling.store_id);
      book.targets.push({ source: sibling, label: `${other.name} (${sibling.order_prefix})` });
    } catch { book.skipped.push(sibling.name); }
  }
  return book;
}

/** El libro se lee una vez; cada tienda se separa por su prefijo y guarda su
 * propia versión. El fallo de una tienda no impide guardar la otra. */
export async function importUrpiBook(book: UrpiBook, tabs: readonly UrpiTab[], options: {
  startedAt: string; origin: "google" | "excel"; filename: string | null;
}): Promise<UrpiBookResult> {
  const admin = createAdminSupabase();
  const lines: string[] = [];
  let saved = 0;
  for (const { source, label } of book.targets) {
    let line: string;
    try {
      const parsed = parseUrpiProgramming(tabs, source.month, source.order_prefix);
      const result = await saveUrpiProgramming(admin, source, parsed, { actor: book.actor, ...options });
      line = `${result.changed ? (options.origin === "excel" ? "Programación importada" : "Programación actualizada") : "Sin cambios"}: ${result.rows} registros, ${result.linked} vinculados a Kapta.`;
      saved++;
    } catch (error) { line = error instanceof Error ? error.message : "No se pudo guardar la programación."; }
    lines.push(book.targets.length > 1 || book.skipped.length ? `${label}: ${line}` : line);
  }
  for (const name of book.skipped) lines.push(`${name}: sin permiso para importar; no se modificó.`);
  return { ok: saved === book.targets.length, saved, message: lines.join("\n") };
}
