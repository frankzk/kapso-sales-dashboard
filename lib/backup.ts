// Daily logical backup of the dashboard-NATIVE tables to a private Supabase
// Storage bucket. These three tables hold operational data that lives nowhere
// else — the gestión/call history and lead dispositions the team produces by
// hand — so they can't be re-synced from Shopify/Kapso if a bad migration, an
// accidental DROP, or a runaway script wipes them. Orders/shipments are omitted
// on purpose: those re-ingest from their source systems.
//
// This is a lightweight complement to Supabase's own daily backups (and to PITR
// if it's ever enabled), NOT a replacement: it snapshots to Storage in the SAME
// project, so it covers table-level data loss, not "the whole project is gone".
//
// Restore is manual (download the CSV from the Storage bucket and COPY it back);
// the format is plain CSV so it opens in a spreadsheet too.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Private bucket the CSV snapshots land in. Created lazily (service-role). */
export const BACKUP_BUCKET = "db-backups";

/** Tables snapshotted, in order. Native, irreplaceable operational data only —
 *  extend here (e.g. quick_replies, winback_sends) if more needs covering. */
export const BACKUP_TABLES = ["leads", "lead_calls", "shipment_calls"] as const;

/** How many dated (daily) snapshots to keep before the oldest are pruned. */
export const BACKUP_RETENTION = 14;

/** Rows read per page + a hard per-table safety cap so one huge log table can't
 *  OOM the serverless function. A hit cap is reported (never silently dropped). */
const PAGE_SIZE = 1000;
const MAX_ROWS_PER_TABLE = 100_000;

export interface TableBackupResult {
  table: string;
  rows: number;
  bytes: number;
  truncated: boolean; // hit MAX_ROWS_PER_TABLE — snapshot is incomplete
  error?: string;
}

export interface StorageBackupReport {
  folder: string;
  tables: TableBackupResult[];
  pruned: string[];
  totalRows: number;
  ok: boolean; // every table snapshotted without error and without truncation
}

/**
 * Serialize DB rows to CSV. Pure. Header is the union of keys (first-seen order);
 * nulls become empty cells, objects/arrays are JSON-encoded (jsonb columns), and
 * any value containing a comma/quote/newline is quoted with doubled quotes.
 * Empty input → empty string.
 */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [keys.join(",")];
  for (const r of rows) lines.push(keys.map((k) => cell(r[k])).join(","));
  return lines.join("\n");
}

/** UTC date folder ("YYYY-MM-DD") a snapshot is written under. Pure. */
export function backupFolderName(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Which snapshot folders to prune, keeping the `retention` newest. Pure: sorts
 * the dated names descending (ISO dates sort lexically) and returns the rest.
 */
export function foldersToPrune(names: string[], retention: number = BACKUP_RETENTION): string[] {
  const sorted = [...new Set(names)].sort().reverse();
  return sorted.slice(Math.max(retention, 0));
}

/** Read every row of a table via keyset-stable pagination (ordered by `id` so
 *  page boundaries don't shift under concurrent writes). Caps at
 *  MAX_ROWS_PER_TABLE and flags truncation. */
async function fetchAllRows(
  admin: SupabaseClient,
  table: string,
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  const rows: Record<string, unknown>[] = [];
  let from = 0;
  let truncated = false;
  for (;;) {
    const { data, error } = await admin
      .from(table)
      .select("*")
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as Record<string, unknown>[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    if (rows.length >= MAX_ROWS_PER_TABLE) {
      truncated = true;
      break;
    }
    from += PAGE_SIZE;
  }
  return { rows: rows.slice(0, MAX_ROWS_PER_TABLE), truncated };
}

/** Best-effort delete of one snapshot folder's files (Storage has no recursive
 *  delete — list then remove). Swallows errors so pruning never fails a backup. */
async function removeFolder(admin: SupabaseClient, bucket: string, folder: string): Promise<void> {
  try {
    const { data } = await admin.storage.from(bucket).list(folder, { limit: 1000 });
    const paths = (data ?? []).map((f) => `${folder}/${f.name}`);
    if (paths.length) await admin.storage.from(bucket).remove(paths);
  } catch {
    /* ignore — retention is best-effort */
  }
}

/**
 * Snapshot each BACKUP_TABLE to CSV under a dated folder in the private
 * BACKUP_BUCKET, then prune old snapshots. Never throws: a per-table failure is
 * captured in that table's result and flips `ok` to false. `now` is injectable.
 */
export async function runStorageBackup(
  admin: SupabaseClient,
  opts: { now?: Date; tables?: readonly string[]; bucket?: string; retention?: number } = {},
): Promise<StorageBackupReport> {
  const bucket = opts.bucket ?? BACKUP_BUCKET;
  const tables = opts.tables ?? BACKUP_TABLES;
  const retention = opts.retention ?? BACKUP_RETENTION;
  const folder = backupFolderName(opts.now);

  // Ensure the private bucket exists (error if it already does ⇒ fine).
  await admin.storage.createBucket(bucket, { public: false }).catch(() => {});

  const results: TableBackupResult[] = [];
  for (const table of tables) {
    try {
      const { rows, truncated } = await fetchAllRows(admin, table);
      const csv = toCsv(rows);
      const body = new Blob([csv], { type: "text/csv" });
      const { error } = await admin.storage
        .from(bucket)
        .upload(`${folder}/${table}.csv`, body, { contentType: "text/csv", upsert: true });
      if (error) throw new Error(error.message);
      results.push({ table, rows: rows.length, bytes: csv.length, truncated });
    } catch (e) {
      results.push({
        table,
        rows: 0,
        bytes: 0,
        truncated: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Prune older snapshots (best-effort).
  const pruned: string[] = [];
  try {
    const { data } = await admin.storage.from(bucket).list("", { limit: 1000 });
    const folders = (data ?? [])
      .map((f) => f.name)
      .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n) && n !== folder);
    for (const old of foldersToPrune([...folders, folder], retention)) {
      await removeFolder(admin, bucket, old);
      pruned.push(old);
    }
  } catch {
    /* ignore — retention is best-effort */
  }

  const totalRows = results.reduce((s, r) => s + r.rows, 0);
  const ok = results.every((r) => !r.error && !r.truncated);
  return { folder, tables: results, pruned, totalRows, ok };
}

/** Human-readable Telegram summary of a backup run (HTML parse mode). */
export function formatBackupSummary(report: StorageBackupReport): string {
  const head = report.ok ? "🗄️ <b>Backup diario</b>" : "⚠️ <b>Backup diario (con avisos)</b>";
  const lines = report.tables.map((t) => {
    if (t.error) return `• ${t.table}: ❌ ${t.error}`;
    const warn = t.truncated ? ` ⚠️ truncado en ${t.rows.toLocaleString("es-PE")}` : "";
    return `• ${t.table}: ${t.rows.toLocaleString("es-PE")} filas${warn}`;
  });
  return [
    head,
    report.folder,
    ...lines,
    `Guardado en Storage (<code>${BACKUP_BUCKET}</code>).`,
  ].join("\n");
}
