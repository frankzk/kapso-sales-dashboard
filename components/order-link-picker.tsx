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
import { cn } from "@/components/ui";
import { Badge, Banner, FIELD_BOX, OpsButton } from "@/components/ops-ui";
import { IconSearch } from "@/components/icons";

/** Una fila de candidato: número, celular, si coincide con el de la guía y fecha. */
const CANDIDATE_ROW =
  "flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] leading-5 transition-colors hover:bg-wash disabled:opacity-50 pointer-coarse:min-h-11";
const CANDIDATE_LIST = "max-h-56 divide-y divide-line overflow-y-auto rounded-md ring-1 ring-line";

function PhoneBadge({
  candidatePhone,
  shipmentPhone,
}: {
  candidatePhone: string | null;
  shipmentPhone?: string | null;
}) {
  if (!shipmentPhone || !candidatePhone) return null;
  return candidatePhone === shipmentPhone ? (
    <Badge tone="ok">Mismo teléfono</Badge>
  ) : (
    <Badge tone="warn">Teléfono distinto</Badge>
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
  /** The shipment's own phone — flags results «mismo / distinto» so a coincidental
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

  // Auto-run the Shopify search once, on open, when there's a candidate
  // reference to search for — skips the manual "Buscar en Shopify" click for
  // the common case (a guide whose NOTA parse gave us a reference), while
  // still leaving the button below for a re-search on an edited/typed term.
  useEffect(() => {
    const term = prefill?.trim();
    if (term && term.length >= 2) void searchShopify(term);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  async function searchShopify(term = q.trim()) {
    if (term.length < 2) return;
    setSearchingShopify(true);
    const r = await searchShopifyOrdersLive(shipmentId, term);
    setShopifyResults(r);
    setSearchingShopify(false);
  }

  // Exactly one live-Shopify result whose phone cross-validates the shipment's
  // own phone — safe to surface as a one-click "Confirmar" instead of making
  // the operator pick it out of the list themselves.
  const phoneMatches =
    customerPhone && shopifyResults ? shopifyResults.filter((o) => o.customer_phone === customerPhone) : [];
  const bestMatch = phoneMatches.length === 1 ? phoneMatches[0]! : null;

  function linkShopify(gid: string, storeId: string) {
    start(async () => {
      const r = await linkShipmentToShopifyOrder(shipmentId, gid, storeId);
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
    <div className="space-y-3">
      <div className="flex gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Buscar el pedido por número o celular</span>
          <IconSearch aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por N° de pedido o celular…"
            className={cn(FIELD_BOX, "h-9 w-full pl-8 pr-3 pointer-coarse:h-11")}
          />
        </label>
        <OpsButton onClick={dismiss} disabled={pending} title="La guía no tiene pedido en Shopify" className="pointer-coarse:h-11">
          Sin pedido
        </OpsButton>
      </div>
      {searching && <p className="text-[13px] text-ink-500">Buscando…</p>}
      {results && results.length === 0 && !searching && (
        <p className="text-[13px] text-ink-500">Sin coincidencias.</p>
      )}
      {results && results.length > 0 && (
        <ul className={CANDIDATE_LIST}>
          {sortByPhoneMatch(results, customerPhone).map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => link(o.id)}
                disabled={pending}
                className={CANDIDATE_ROW}
              >
                <span className="font-mono font-medium text-ink-900">{o.name ?? "—"}</span>
                <span className="tabular-nums text-ink-600">{o.customer_phone ?? "—"}</span>
                <PhoneBadge candidatePhone={o.customer_phone} shipmentPhone={customerPhone} />
                <span className="ml-auto tabular-nums text-ink-500">
                  {o.created_at ? new Date(o.created_at).toLocaleDateString("es-PE") : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <OpsButton
          size="sm"
          onClick={() => searchShopify()}
          disabled={q.trim().length < 2 || searchingShopify}
          className="pointer-coarse:h-11"
        >
          {searchingShopify ? "Buscando en Shopify…" : "Buscar en Shopify"}
        </OpsButton>
        <span className="text-[13px] leading-5 text-ink-500">
          Para pedidos que aún no se sincronizaron localmente.
        </span>
      </div>
      {shopifyResults && shopifyResults.length === 0 && !searchingShopify && (
        <p className="text-[13px] text-ink-500">Sin coincidencias en Shopify.</p>
      )}
      {bestMatch && (
        <Banner tone="ok" title="Coincide el teléfono">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <p>
              Pedido <span className="font-mono font-medium text-ink-900">{bestMatch.name ?? "—"}</span>, con el mismo
              celular que la guía.
            </p>
            <OpsButton
              size="sm"
              variant="primary"
              onClick={() => linkShopify(bestMatch.gid, bestMatch.storeId)}
              disabled={pending}
              className="pointer-coarse:h-11"
            >
              Confirmar vínculo
            </OpsButton>
          </div>
        </Banner>
      )}
      {shopifyResults && shopifyResults.length > (bestMatch ? 1 : 0) && (
        <ul className={CANDIDATE_LIST}>
          {sortByPhoneMatch(shopifyResults, customerPhone).map((o) => (
            <li key={o.gid}>
              <button
                type="button"
                onClick={() => linkShopify(o.gid, o.storeId)}
                disabled={pending}
                className={CANDIDATE_ROW}
              >
                <span className="font-mono font-medium text-ink-900">{o.name ?? "—"}</span>
                <span className="tabular-nums text-ink-600">{o.customer_phone ?? "—"}</span>
                <PhoneBadge candidatePhone={o.customer_phone} shipmentPhone={customerPhone} />
                <span className="ml-auto tabular-nums text-ink-500">
                  {o.created_at ? new Date(o.created_at).toLocaleDateString("es-PE") : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {msg && (
        <p role="status" className="rounded-md bg-wash px-3 py-2 text-[13px] leading-5 text-ink-700">
          {msg}
        </p>
      )}
    </div>
  );
}
