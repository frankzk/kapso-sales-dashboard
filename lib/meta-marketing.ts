// Meta (Facebook) Marketing / Graph API client — minimal, server-side only.
// Used to list a store's ad accounts so its ad SPEND can later be matched to
// closed COD sales (ROAS). The store's access token is decrypted on demand and
// never reaches the browser. All calls are best-effort and never throw.

/* eslint-disable @typescript-eslint/no-explicit-any */

const GRAPH_BASE = "https://graph.facebook.com/v21.0";

export interface MetaAdAccount {
  id: string; // "act_1234567890"
  accountId: string; // "1234567890"
  name: string;
  currency: string | null;
  status: number | null; // account_status (1 = active, 2 = disabled, …)
}

export type MetaAdAccountsResult =
  | { ok: true; accounts: MetaAdAccount[] }
  | { ok: false; error: string };

/** A store's saved ad account (one of possibly several). */
export interface StoreMetaAdAccount {
  id: string; // "act_1234567890"
  name: string | null;
}

export interface MetaConnectionProbeAccount {
  id: string;
  name: string;
  currency: string | null;
  accessible: boolean;
  insightsOk: boolean;
  spend: number;
  impressions: number;
  reach: number;
  frequency: number | null;
  cpm: number | null;
  error: string | null;
}

export interface MetaConnectionProbe {
  ok: boolean;
  tokenValid: boolean;
  range: { from: string; to: string };
  accounts: MetaConnectionProbeAccount[];
  spendByCurrency: { currency: string; amount: number }[];
  error: string | null;
}

/**
 * Normalize the stored `meta_ad_accounts` jsonb into a clean, deduped list.
 * Back-compat: when the array is empty but a legacy single id exists (migration
 * 0018), it becomes a one-item list. Pure.
 */
export function normalizeMetaAdAccounts(
  raw: unknown,
  legacyId?: string | null,
  legacyName?: string | null,
): StoreMetaAdAccount[] {
  const out: StoreMetaAdAccount[] = [];
  if (Array.isArray(raw)) {
    for (const a of raw) {
      const id = typeof (a as any)?.id === "string" ? (a as any).id.trim() : "";
      if (!id || out.some((x) => x.id === id)) continue;
      const name = typeof (a as any)?.name === "string" ? (a as any).name : null;
      out.push({ id, name });
    }
  }
  if (!out.length && legacyId && legacyId.trim()) {
    out.push({ id: legacyId.trim(), name: legacyName ?? null });
  }
  return out;
}

/**
 * List the ad accounts the token can access (`GET /me/adaccounts`). Returns the
 * accounts on success, or a human error (e.g. an expired/invalid token) without
 * throwing. The token travels as a query param (standard for the Graph API).
 */
export async function listMetaAdAccounts(
  token: string,
  opts?: { fetchImpl?: typeof fetch; baseUrl?: string },
): Promise<MetaAdAccountsResult> {
  if (!token || !token.trim()) return { ok: false, error: "Falta el access token de Meta." };
  const base = (opts?.baseUrl ?? GRAPH_BASE).replace(/\/$/, "");
  const url = new URL(`${base}/me/adaccounts`);
  url.searchParams.set("fields", "id,name,account_id,currency,account_status");
  url.searchParams.set("limit", "200");
  url.searchParams.set("access_token", token.trim());

  const doFetch = opts?.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url.toString(), { headers: { Accept: "application/json" } });
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "error de red" };
  }
  const json: any = await res.json().catch(() => null);
  if (!res.ok || json?.error) {
    return { ok: false, error: json?.error?.message ?? json?.error?.type ?? `HTTP ${res.status}` };
  }
  const accounts: MetaAdAccount[] = (json?.data ?? []).map((a: any) => ({
    id: String(a?.id ?? (a?.account_id ? `act_${a.account_id}` : "")),
    accountId: String(a?.account_id ?? a?.id ?? "").replace(/^act_/, ""),
    name: typeof a?.name === "string" && a.name ? a.name : String(a?.id ?? "Cuenta"),
    currency: typeof a?.currency === "string" ? a.currency : null,
    status: typeof a?.account_status === "number" ? a.account_status : null,
  }));
  return { ok: true, accounts };
}

/**
 * Read-only end-to-end check for the Marketing API connection. It validates
 * the token and then requests real account-level Insights for every saved
 * account, keeping failures isolated and spend separated by currency.
 */
export async function probeMetaConnection(
  token: string,
  selected: StoreMetaAdAccount[],
  range: { from: string; to: string },
  opts?: { fetchImpl?: typeof fetch; baseUrl?: string; timeoutMs?: number },
): Promise<MetaConnectionProbe> {
  const listed = await listMetaAdAccounts(token, opts);
  if (!listed.ok) {
    return { ok: false, tokenValid: false, range, accounts: [], spendByCurrency: [], error: listed.error };
  }
  if (!selected.length) {
    return {
      ok: false,
      tokenValid: true,
      range,
      accounts: [],
      spendByCurrency: [],
      error: "No hay cuentas publicitarias seleccionadas.",
    };
  }

  const base = (opts?.baseUrl ?? GRAPH_BASE).replace(/\/$/, "");
  const doFetch = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const available = new Map(listed.accounts.map((account) => [account.id, account]));
  const accounts = await Promise.all(
    selected.map(async (saved): Promise<MetaConnectionProbeAccount> => {
      const id = saved.id.startsWith("act_") ? saved.id : `act_${saved.id}`;
      const account = available.get(id);
      const failed = (error: string, accessible: boolean, currency: string | null = null): MetaConnectionProbeAccount => ({
        id,
        name: account?.name || saved.name || id,
        currency,
        accessible,
        insightsOk: false,
        spend: 0,
        impressions: 0,
        reach: 0,
        frequency: null,
        cpm: null,
        error,
      });
      if (!account) return failed("La cuenta guardada ya no es accesible con este token.", false);

      const url = new URL(`${base}/${id}/insights`);
      url.searchParams.set("fields", "spend,impressions,reach,frequency,cpm");
      url.searchParams.set("level", "account");
      url.searchParams.set("time_range", JSON.stringify({ since: range.from, until: range.to }));
      url.searchParams.set("access_token", token.trim());
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const response = await doFetch(url.toString(), {
          headers: { Accept: "application/json" },
          signal: ctrl.signal,
        });
        const json: any = await response.json().catch(() => null);
        if (!response.ok || json?.error) {
          return failed(json?.error?.message ?? `Meta respondió HTTP ${response.status}.`, true, account.currency);
        }
        const row = json?.data?.[0] ?? {};
        const numeric = (value: unknown): number => {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : 0;
        };
        const nullableNumeric = (value: unknown): number | null => {
          if (value == null || value === "") return null;
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        };
        return {
          id,
          name: account.name,
          currency: account.currency,
          accessible: true,
          insightsOk: true,
          spend: numeric(row.spend),
          impressions: numeric(row.impressions),
          reach: numeric(row.reach),
          frequency: nullableNumeric(row.frequency),
          cpm: nullableNumeric(row.cpm),
          error: null,
        };
      } catch (error: any) {
        return failed(
          error?.name === "AbortError" ? "La consulta de Insights agotó el tiempo." : error?.message ?? "Error de red.",
          true,
          account.currency,
        );
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const totals = new Map<string, number>();
  for (const account of accounts) {
    if (!account.insightsOk) continue;
    const currency = account.currency || "Sin moneda";
    totals.set(currency, (totals.get(currency) ?? 0) + account.spend);
  }
  const spendByCurrency = [...totals.entries()].map(([currency, amount]) => ({
    currency,
    amount: Math.round(amount * 100) / 100,
  }));
  const ok = accounts.every((account) => account.accessible && account.insightsOk);
  return {
    ok,
    tokenValid: true,
    range,
    accounts,
    spendByCurrency,
    error: ok ? null : "Una o más cuentas no pudieron consultar Insights.",
  };
}

/** A resolved Meta ad → the row shape stored in `meta_ads` (real names + status). */
export interface MetaAdRow {
  ad_id: string;
  account_id: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  objective: string | null;
  adset_id: string | null;
  adset_name: string | null;
  ad_name: string | null;
  status: string | null; // effective_status snapshot (ACTIVE/PAUSED/…)
}

/**
 * Resolve Meta `ad_id`s → their real ad / adset / campaign names via the Graph
 * API (`GET /<ad_id>?fields=…`). One request per id (robust: a deleted/forbidden
 * ad just yields null instead of poisoning a whole batch), run concurrently.
 * Best-effort: unresolved ids are omitted and never throw. `access_token` travels
 * as a query param (standard for the Graph API); a short timeout per id keeps a
 * slow API from hanging the sync. Cap the id list at the call site.
 */
export async function fetchMetaAdMeta(
  token: string,
  adIds: string[],
  opts?: { fetchImpl?: typeof fetch; baseUrl?: string; timeoutMs?: number },
): Promise<MetaAdRow[]> {
  if (!token?.trim() || !adIds.length) return [];
  const base = (opts?.baseUrl ?? GRAPH_BASE).replace(/\/$/, "");
  const doFetch = opts?.fetchImpl ?? fetch;
  const timeMs = opts?.timeoutMs ?? 6000;
  const fields = "name,effective_status,account_id,adset{id,name},campaign{id,name,objective}";

  const rows = await Promise.all(
    adIds.map(async (id): Promise<MetaAdRow | null> => {
      const url = new URL(`${base}/${encodeURIComponent(id)}`);
      url.searchParams.set("fields", fields);
      url.searchParams.set("access_token", token.trim());
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeMs);
      try {
        const res = await doFetch(url.toString(), { headers: { Accept: "application/json" }, signal: ctrl.signal });
        const a: any = await res.json().catch(() => null);
        if (!res.ok || !a || a.error) return null; // deleted / no access / error → skip
        return {
          ad_id: id,
          account_id: a.account_id ? String(a.account_id).replace(/^act_/, "") : null,
          campaign_id: a.campaign?.id ?? null,
          campaign_name: a.campaign?.name ?? null,
          objective: a.campaign?.objective ?? null,
          adset_id: a.adset?.id ?? null,
          adset_name: a.adset?.name ?? null,
          ad_name: typeof a.name === "string" ? a.name : null,
          status: a.effective_status ?? null,
        };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return rows.filter((r): r is MetaAdRow => r != null);
}

/**
 * Total ad SPEND across the given ad accounts for a date range (the cost half of
 * ROAS), summed at the account level via `GET /act_<id>/insights?fields=spend`.
 * Best-effort: returns null on any failure (bad token, network, timeout) so the
 * dashboard shows "—" for ROAS instead of breaking. `accountIds` accept "act_…"
 * or bare numeric ids. A short AbortController timeout keeps a slow Graph API
 * from hanging the render.
 */
export async function fetchMetaSpend(
  token: string,
  accountIds: string[],
  range: { from: string; to: string },
  opts?: { fetchImpl?: typeof fetch; baseUrl?: string; timeoutMs?: number },
): Promise<number | null> {
  if (!token?.trim() || !accountIds.length) return null;
  const base = (opts?.baseUrl ?? GRAPH_BASE).replace(/\/$/, "");
  const doFetch = opts?.fetchImpl ?? fetch;
  const timeMs = opts?.timeoutMs ?? 4000;

  const spends = await Promise.all(
    accountIds.map(async (raw) => {
      const act = raw.startsWith("act_") ? raw : `act_${raw}`;
      const url = new URL(`${base}/${act}/insights`);
      url.searchParams.set("fields", "spend");
      url.searchParams.set("level", "account");
      url.searchParams.set("time_range", JSON.stringify({ since: range.from, until: range.to }));
      url.searchParams.set("access_token", token.trim());
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeMs);
      try {
        const res = await doFetch(url.toString(), { headers: { Accept: "application/json" }, signal: ctrl.signal });
        const json: any = await res.json().catch(() => null);
        if (!res.ok || json?.error) return null;
        const spend = Number(json?.data?.[0]?.spend);
        return Number.isFinite(spend) ? spend : 0;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  // If every account failed, we truly have no data → null; otherwise sum the ok ones.
  if (spends.every((s) => s == null)) return null;
  return Math.round(spends.reduce((sum: number, s) => sum + (s ?? 0), 0) * 100) / 100;
}
