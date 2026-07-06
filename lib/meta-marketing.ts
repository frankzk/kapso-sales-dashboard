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
