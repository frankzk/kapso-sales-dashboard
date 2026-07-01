"use client";

import { useEffect, useState, useTransition } from "react";
import {
  linkShipmentToShopifyOrder,
  resolveShipmentMatch,
  searchOrdersToLink,
  searchShopifyOrdersLive,
  type ShopifyOrderCandidate,
} from "@/app/dashboard/envios/actions";
import type { OrderLinkCandidate } from "@/lib/shipments-access";

function PhoneBadge({
  candidatePhone,
  shipmentPhone,
}: {
  candidatePhone: string | null;
  shipmentPhone?: string | null;
}) {
  if (!shipmentPhone || !candidatePhone) return null;
  return candidatePhone === shipmentPhone ? (
    <span className="text-xs font-medium text-emerald-600">✓ mismo teléfono</span>
  ) : (
    <span className="text-xs font-medium text-amber-600">⚠ teléfono distinto</span>
  );
}

/** Phone-matching candidates first — the safest guess surfaces before a
 *  coincidental digit-substring match. */
function sortByPhoneMatch<T extends { customer_phone: string | null }>(
  list: T[],
  shipmentPhone: string | null | undefined,
): T[] {
  if (!shipmentPhone) return list;
  return [...list].sort((a, b) => {
    const am = a.customer_phone === shipmentPhone ? 0 : 1;
    const bm = b.customer_phone === shipmentPhone ? 0 : 1;
    return am - bm;
  });
}

/**
 * Typeahead to manually link a shipment to a Shopify order — search by order
 * number or phone (orders has no customer-name column, so results are shown
 * as number · phone · date). Used by the shipment drawer and the "Por revisar"
 * queue; both just need a shipmentId and an onLinked callback to refresh.
 */
export function OrderLinkPicker({
  shipmentId,
  prefill,
  customerPhone,
  onLinked,
}: {
  shipmentId: string;
  prefill?: string | null;
  /** The shipment's own phone — flags results as ✓/⚠ so a coincidental
   *  number-substring match (e.g. a bare order number without prefix) isn't
   *  mistaken for the right order without checking the customer first. */
  customerPhone?: string | null;
  onLinked?: () => void;
}) {
  const [q, setQ] = useState(prefill?.trim() || "");
  const [results, setResults] = useState<OrderLinkCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [shopifyResults, setShopifyResults] = useState<ShopifyOrderCandidate[] | null>(null);
  const [searchingShopify, setSearchingShopify] = useState(false);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setShopifyResults(null);
    const term = q.trim();
    if (term.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let alive = true;
    const t = setTimeout(async () => {
      const r = await searchOrdersToLink(term);
      if (alive) {
        setResults(r);
        setSearching(false);
      }
    }, 280);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);

  function link(orderId: string) {
    start(async () => {
      const r = await resolveShipmentMatch(shipmentId, { orderId });
      setMsg(r.error ?? r.notice ?? null);
      if (!r.error) {
        setQ("");
        setResults(null);
        onLinked?.();
      }
    });
  }

  function dismiss() {
    start(async () => {
      const r = await resolveShipmentMatch(shipmentId, { orderId: null });
      setMsg(r.error ?? r.notice ?? null);
      if (!r.error) onLinked?.();
    });
  }

  async function searchShopify() {
    const term = q.trim();
    if (term.length < 2) return;
    setSearchingShopify(true);
    const r = await searchShopifyOrdersLive(shipmentId, term);
    setShopifyResults(r);
    setSearchingShopify(false);
  }

  function linkShopify(gid: string) {
    start(async () => {
      const r = await linkShipmentToShopifyOrder(shipmentId, gid);
      setMsg(r.error ?? r.notice ?? null);
      if (!r.error) {
        setQ("");
        setResults(null);
        setShopifyResults(null);
        onLinked?.();
      }
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar por N° de pedido o celular…"
          className="flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
        />
        <button
          onClick={dismiss}
          disabled={pending}
          className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          Sin pedido
        </button>
      </div>
      {searching && <p className="text-xs text-slate-400">Buscando…</p>}
      {results && results.length === 0 && !searching && (
        <p className="text-xs text-slate-400">Sin coincidencias.</p>
      )}
      {results && results.length > 0 && (
        <ul className="max-h-48 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
          {sortByPhoneMatch(results, customerPhone).map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => link(o.id)}
                disabled={pending}
                className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-slate-50 disabled:opacity-50"
              >
                <span className="font-mono text-xs text-slate-700">{o.name ?? "—"}</span>
                <span className="text-xs text-slate-500">{o.customer_phone ?? "—"}</span>
                <PhoneBadge candidatePhone={o.customer_phone} shipmentPhone={customerPhone} />
                <span className="text-xs text-slate-400">
                  {o.created_at ? new Date(o.created_at).toLocaleDateString("es-PE") : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={searchShopify}
          disabled={q.trim().length < 2 || searchingShopify}
          className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          {searchingShopify ? "Buscando en Shopify…" : "Buscar en Shopify"}
        </button>
        <span className="text-xs text-slate-400">
          Para pedidos que aún no se sincronizaron localmente.
        </span>
      </div>
      {shopifyResults && shopifyResults.length === 0 && !searchingShopify && (
        <p className="text-xs text-slate-400">Sin coincidencias en Shopify.</p>
      )}
      {shopifyResults && shopifyResults.length > 0 && (
        <ul className="max-h-48 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
          {sortByPhoneMatch(shopifyResults, customerPhone).map((o) => (
            <li key={o.gid}>
              <button
                type="button"
                onClick={() => linkShopify(o.gid)}
                disabled={pending}
                className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-slate-50 disabled:opacity-50"
              >
                <span className="font-mono text-xs text-slate-700">{o.name ?? "—"}</span>
                <span className="text-xs text-slate-500">{o.customer_phone ?? "—"}</span>
                <PhoneBadge candidatePhone={o.customer_phone} shipmentPhone={customerPhone} />
                <span className="text-xs text-slate-400">
                  {o.created_at ? new Date(o.created_at).toLocaleDateString("es-PE") : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700">{msg}</p>}
    </div>
  );
}
