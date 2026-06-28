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
