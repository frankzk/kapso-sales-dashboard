"use client";

import { useEffect, useState, useTransition } from "react";
import { resolveShipmentMatch, searchOrdersToLink } from "@/app/dashboard/envios/actions";
import type { OrderLinkCandidate } from "@/lib/shipments-access";

/**
 * Typeahead to manually link a shipment to a Shopify order — search by order
 * number or phone (orders has no customer-name column, so results are shown
 * as number · phone · date). Used by the shipment drawer and the "Por revisar"
 * queue; both just need a shipmentId and an onLinked callback to refresh.
 */
export function OrderLinkPicker({
  shipmentId,
  prefill,
  onLinked,
}: {
  shipmentId: string;
  prefill?: string | null;
  onLinked?: () => void;
}) {
  const [q, setQ] = useState(prefill?.trim() || "");
  const [results, setResults] = useState<OrderLinkCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
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
          {results.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => link(o.id)}
                disabled={pending}
                className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-slate-50 disabled:opacity-50"
              >
                <span className="font-mono text-xs text-slate-700">{o.name ?? "—"}</span>
                <span className="text-xs text-slate-500">{o.customer_phone ?? "—"}</span>
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
