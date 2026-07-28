import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoreMetaAdAccount } from "@/lib/meta-marketing";

const GRAPH_BASE = "https://graph.facebook.com/v21.0";
const META_INSIGHTS_SOURCE = "meta_insights";
const PAGE_LIMIT = 100;
const UPSERT_CHUNK = 500;

export interface MetaDailyInsight {
  account_id: string;
  account_name: string | null;
  currency: string | null;
  date: string;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  ad_id: string;
  ad_name: string | null;
  spend: number;
  impressions: number;
  reach: number;
  frequency: number | null;
  clicks: number;
  inline_link_clicks: number;
  ctr: number | null;
  cpm: number | null;
  cpc: number | null;
  actions: unknown[];
  cost_per_action_type: unknown[];
}

export interface MetaInsightsFetchResult {
  ok: boolean;
  rows: MetaDailyInsight[];
  error: string | null;
}

export interface MetaInsightsSyncReport {
  storeId: string;
  from: string;
  to: string;
  accounts: number;
  accountsOk: number;
  rows: number;
  ads: number;
  errors: string[];
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableFinite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Converts a Meta Insights API row into the stable database shape. */
export function normalizeMetaDailyInsight(raw: Record<string, unknown>): MetaDailyInsight | null {
  const adId = text(raw.ad_id);
  const accountId = text(raw.account_id)?.replace(/^act_/, "") ?? null;
  const date = text(raw.date_start);
  if (!adId || !accountId || !date) return null;
  return {
    account_id: accountId,
    account_name: text(raw.account_name),
    currency: text(raw.account_currency),
    date,
    campaign_id: text(raw.campaign_id),
    campaign_name: text(raw.campaign_name),
    adset_id: text(raw.adset_id),
    adset_name: text(raw.adset_name),
    ad_id: adId,
    ad_name: text(raw.ad_name),
    spend: finite(raw.spend),
    impressions: Math.trunc(finite(raw.impressions)),
    reach: Math.trunc(finite(raw.reach)),
    frequency: nullableFinite(raw.frequency),
    clicks: Math.trunc(finite(raw.clicks)),
    inline_link_clicks: Math.trunc(finite(raw.inline_link_clicks)),
    ctr: nullableFinite(raw.ctr),
    cpm: nullableFinite(raw.cpm),
    cpc: nullableFinite(raw.cpc),
    actions: Array.isArray(raw.actions) ? raw.actions : [],
    cost_per_action_type: Array.isArray(raw.cost_per_action_type) ? raw.cost_per_action_type : [],
  };
}

/**
 * Fetches daily ad-level Insights for one account, following Meta pagination.
 * It never throws: one inaccessible account must not prevent the other accounts
 * (or stores) from being synchronized.
 */
export async function fetchMetaDailyInsights(
  token: string,
  accountId: string,
  range: { from: string; to: string },
  opts?: { fetchImpl?: typeof fetch; baseUrl?: string; timeoutMs?: number },
): Promise<MetaInsightsFetchResult> {
  if (!token.trim()) return { ok: false, rows: [], error: "Falta el access token de Meta." };
  const act = accountId.startsWith("act_") ? accountId : `act_${accountId}`;
  const base = (opts?.baseUrl ?? GRAPH_BASE).replace(/\/$/, "");
  const fields = [
    "account_id",
    "account_name",
    "account_currency",
    "campaign_id",
    "campaign_name",
    "adset_id",
    "adset_name",
    "ad_id",
    "ad_name",
    "date_start",
    "date_stop",
    "spend",
    "impressions",
    "reach",
    "frequency",
    "clicks",
    "inline_link_clicks",
    "ctr",
    "cpm",
    "cpc",
    "actions",
    "cost_per_action_type",
  ].join(",");
  const first = new URL(`${base}/${act}/insights`);
  first.searchParams.set("fields", fields);
  first.searchParams.set("level", "ad");
  first.searchParams.set("time_increment", "1");
  first.searchParams.set("time_range", JSON.stringify({ since: range.from, until: range.to }));
  first.searchParams.set("limit", "500");
  first.searchParams.set("access_token", token.trim());

  const rows: MetaDailyInsight[] = [];
  const doFetch = opts?.fetchImpl ?? fetch;
  let next: string | null = first.toString();
  for (let page = 0; next && page < PAGE_LIMIT; page++) {
    const ctrl = new AbortController();
    // Los reportes de 90 días de cuentas con muchos anuncios suelen tardar
    // más de 20 s en Meta. 45 s mantiene una cota segura dentro de la función
    // de 300 s, sin cortar cuentas válidas a mitad del backfill.
    const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 45_000);
    try {
      const response = await doFetch(next, { headers: { Accept: "application/json" }, signal: ctrl.signal });
      const json = await response.json().catch(() => null) as {
        data?: Record<string, unknown>[];
        paging?: { next?: string };
        error?: { message?: string; type?: string };
      } | null;
      if (!response.ok || json?.error) {
        return {
          ok: false,
          rows,
          error: json?.error?.message ?? json?.error?.type ?? `Meta respondió HTTP ${response.status}.`,
        };
      }
      for (const raw of json?.data ?? []) {
        const normalized = normalizeMetaDailyInsight(raw);
        if (normalized) rows.push(normalized);
      }
      next = typeof json?.paging?.next === "string" ? json.paging.next : null;
    } catch (error) {
      return {
        ok: false,
        rows,
        error:
          error instanceof Error && error.name === "AbortError"
            ? "La consulta de Insights agotó el tiempo."
            : error instanceof Error
              ? error.message
              : "Error de red consultando Meta.",
      };
    } finally {
      clearTimeout(timer);
    }
  }
  if (next) return { ok: false, rows, error: "Meta devolvió demasiadas páginas; se detuvo por seguridad." };
  return { ok: true, rows, error: null };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Fetch, persist and audit one store's Meta history for the supplied range. */
export async function syncMetaInsightsHistory(
  admin: SupabaseClient,
  storeId: string,
  token: string,
  accounts: StoreMetaAdAccount[],
  range: { from: string; to: string },
  opts?: { fetchImpl?: typeof fetch; baseUrl?: string; timeoutMs?: number },
): Promise<MetaInsightsSyncReport> {
  const report: MetaInsightsSyncReport = {
    storeId,
    from: range.from,
    to: range.to,
    accounts: accounts.length,
    accountsOk: 0,
    rows: 0,
    ads: 0,
    errors: [],
  };
  const seenAds = new Set<string>();
  for (const account of accounts) {
    const fetched = await fetchMetaDailyInsights(token, account.id, range, opts);
    if (!fetched.ok) {
      report.errors.push(`${account.name || account.id}: ${fetched.error}`);
      continue;
    }
    report.accountsOk += 1;
    const syncedAt = new Date().toISOString();
    for (const batch of chunks(fetched.rows, UPSERT_CHUNK)) {
      const { error } = await admin.from("meta_ad_insights_daily").upsert(
        batch.map((row) => ({ store_id: storeId, ...row, synced_at: syncedAt })),
        { onConflict: "store_id,account_id,ad_id,date" },
      );
      if (error) {
        report.errors.push(`${account.name || account.id}: ${error.message}`);
        break;
      }
      report.rows += batch.length;
      for (const row of batch) seenAds.add(row.ad_id);
    }

    const adRows = new Map<string, Record<string, unknown>>();
    for (const row of fetched.rows) {
      adRows.set(row.ad_id, {
        ad_id: row.ad_id,
        account_id: row.account_id,
        campaign_id: row.campaign_id,
        campaign_name: row.campaign_name,
        adset_id: row.adset_id,
        adset_name: row.adset_name,
        ad_name: row.ad_name,
        fetched_at: syncedAt,
      });
    }
    if (adRows.size) {
      const { error } = await admin.from("meta_ads").upsert([...adRows.values()], { onConflict: "ad_id" });
      if (error) report.errors.push(`${account.name || account.id} (nombres): ${error.message}`);
    }
  }
  report.ads = seenAds.size;
  const status = report.errors.length ? (report.accountsOk ? "partial" : "error") : "ok";
  await admin.from("sync_state").upsert(
    {
      store_id: storeId,
      source: META_INSIGHTS_SOURCE,
      cursor: range.to,
      last_run_at: new Date().toISOString(),
      status,
      error: report.errors.length ? report.errors.join("; ").slice(0, 4000) : null,
    },
    { onConflict: "store_id,source" },
  );
  return report;
}

export function limaDateOffset(offsetDays: number, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now.getTime() + offsetDays * 86_400_000));
}

export function metaInsightsRange(days: number, now = new Date()): { from: string; to: string } {
  const safeDays = Math.max(1, Math.min(365, Math.trunc(days)));
  return { from: limaDateOffset(-(safeDays - 1), now), to: limaDateOffset(0, now) };
}
