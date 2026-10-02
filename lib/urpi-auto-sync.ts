import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseUrpiProgramming, urpiAutoMonths } from "./urpi-programming";
import { readUrpiGoogleWorkbook, urpiGoogleConfigured } from "./urpi-google-sheets";
import { saveUrpiProgramming, type UrpiSource } from "./urpi-programming-db";

export const URPI_AUTO_BATCH = 12;
export function urpiAutoEnabled(): boolean {
  return process.env.URPI_AUTO_SYNC_ENABLED !== "false" && urpiGoogleConfigured();
}

export async function syncUrpiAutomatically(admin: SupabaseClient) {
  const report = { scanned: 0, changed: 0, unchanged: 0, failed: 0, busy: 0, deferred: 0, skipped: false };
  if (!urpiAutoEnabled()) return { ...report, skipped: true };
  const now = new Date();
  const cutoff = new Date(+now - 10 * 60_000).toISOString();
  // Cooldown also prevents duplicate scheduler deliveries from rereading a source.
  const due = `last_auto_attempt_at.is.null,last_auto_attempt_at.lt.${cutoff}`;
  const { data, error } = await admin.from("urpi_programming_sources").select("*")
    .in("month", urpiAutoMonths(now)).or(due)
    .order("last_auto_attempt_at", { ascending: true, nullsFirst: true }).order("id").limit(URPI_AUTO_BATCH);
  if (error) throw new Error("No se pudo consultar la cola de Urpi.");
  const candidates = (data ?? []) as UrpiSource[];
  // One Google read for a shared Kenku/Aurela workbook; preserve its original
  // start time so a later manual import always wins over this cached content.
  const books = new Map<string, { startedAt: string; result: Promise<Awaited<ReturnType<typeof readUrpiGoogleWorkbook>>> }>();
  for (const candidate of candidates) {
    if (Date.now() - +now >= 180_000) { report.deferred = candidates.length - report.scanned; break; }
    report.scanned++;
    const token = randomUUID();
    const attempt = new Date().toISOString();
    const { data: claimed, error: claimError } = await admin.from("urpi_programming_sources")
      .update({ auto_sync_token: token, auto_sync_until: new Date(Date.now() + 6 * 60_000).toISOString(), last_auto_attempt_at: attempt })
      .eq("id", candidate.id).or(due)
      .or(`auto_sync_until.is.null,auto_sync_until.lt.${attempt}`)
      .select("*").maybeSingle();
    if (claimError) { report.failed++; continue; }
    if (!claimed) { report.busy++; continue; }
    const source = claimed as UrpiSource;
    let failure: string | null = null;
    let changed = false;
    try {
      const key = `${source.spreadsheet_id}:${source.month}`;
      let book = books.get(key);
      if (!book) {
        book = { startedAt: attempt, result: readUrpiGoogleWorkbook(source.spreadsheet_id, source.month) };
        books.set(key, book);
      }
      const workbook = await book.result;
      const parsed = parseUrpiProgramming(workbook.tabs, source.month, source.order_prefix);
      const saved = await saveUrpiProgramming(admin, source, parsed, { actor: null, startedAt: book.startedAt, origin: "google", filename: null });
      changed = saved.changed;
    } catch {
      // Never persist raw provider errors or secrets. Manual refresh provides
      // the actionable validation error through the existing guarded action.
      failure = "La lectura automática falló. Se conserva la última versión. Usa Actualizar desde Google para revisar el motivo; se reintentará en el siguiente ciclo.";
    }
    const { data: finished, error: finishError } = await admin.from("urpi_programming_sources")
      .update({ auto_sync_token: null, auto_sync_until: null, last_auto_error: failure, ...(!failure ? { last_auto_success_at: new Date().toISOString() } : {}) })
      .eq("id", source.id).eq("auto_sync_token", token).select("id").maybeSingle();
    if (failure || finishError || !finished) report.failed++;
    else if (changed) report.changed++;
    else report.unchanged++;
  }
  return report;
}
