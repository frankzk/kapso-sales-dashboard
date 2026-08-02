"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CampaignDecision, CampaignProductMatch, CampaignStat } from "@/lib/metrics";
import { formatCurrency, formatPct } from "@/lib/metrics";
import { adObjectiveLabel, adsManagerUrl, prettyAdName } from "@/lib/meta-ads";
import {
  saveAdPromotedProduct,
  searchPromotedProducts,
  type PromotedProductSuggestion,
} from "@/app/dashboard/actions";
import { cn, STICKY_HEAD, TABLE_WRAP_FROM } from "@/components/ui";

type SortKey =
  | "label"
  | "spend"
  | "cpm"
  | "frequency"
  | "leads"
  | "cpl"
  | "pedidos"
  | "cpa"
  | "productMatchRate"
  | "deliveryRate"
  | "deliveredCpa"
  | "deliveredRoas";

const DECISIONS: Record<CampaignDecision, { label: string; className: string; help: string }> = {
  scale: { label: "Escalar", className: "bg-emerald-100 text-emerald-800", help: "Conversión claramente superior al promedio." },
  promising: { label: "Prometedor", className: "bg-sky-100 text-sky-800", help: "Conversión igual o superior al promedio." },
  review_close: { label: "Revisar cierre", className: "bg-amber-100 text-amber-800", help: "Genera leads, pero convierte por debajo del promedio." },
  misaligned: { label: "Producto desalineado", className: "bg-fuchsia-100 text-fuchsia-800", help: "La mayoría compra un producto distinto al anunciado." },
  operational: { label: "Freno operativo", className: "bg-rose-100 text-rose-800", help: "La entrega está deteriorando el resultado comercial." },
  insufficient: { label: "Muestra baja", className: "bg-slate-100 text-slate-600", help: "Se requieren al menos 20 leads para recomendar una acción." },
  no_attribution: { label: "Sin leads atribuidos", className: "bg-rose-100 text-rose-800", help: "Meta registra gasto, pero no hay leads atribuidos a este anuncio en el período." },
  data_incomplete: { label: "Datos incompletos", className: "bg-slate-100 text-slate-700", help: "No hay gasto con moneda verificable; no se emite una recomendación económica." },
};

const MATCH: Record<CampaignProductMatch, { label: string; className: string }> = {
  exact: { label: "Mismo producto", className: "bg-emerald-50 text-emerald-700" },
  mixed: { label: "Mixto", className: "bg-sky-50 text-sky-700" },
  cross_sell: { label: "Otro producto", className: "bg-amber-50 text-amber-700" },
  unknown: { label: "Sin mapear", className: "bg-slate-100 text-slate-500" },
};

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-[.08em] text-slate-400">{label}</p>
      <p className="mt-0.5 truncate text-base font-semibold tabular-nums text-slate-800">{value}</p>
      {note && <p className="truncate text-[11px] text-slate-400">{note}</p>}
    </div>
  );
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("es-PE", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatMetaMoney(value: number | null, currency: string | null): string {
  if (value == null) return "—";
  if (!currency) return value.toFixed(2);
  try {
    return new Intl.NumberFormat("es-PE", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

function sameCurrency(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();
}

function LabelCell({ row }: { row: CampaignStat }) {
  const href = adsManagerUrl(row.meta?.accountId ?? null, row.metaAdId ?? row.adId);
  const context = [row.meta?.campaignName, adObjectiveLabel(row.meta?.objective ?? null)].filter(Boolean).join(" · ");
  return (
    <div className="min-w-[250px] max-w-[360px]">
      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-0.5 text-sm">📣</span>
        <div className="min-w-0">
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" className="block truncate font-semibold text-slate-800 hover:text-brand-700 hover:underline">
              {prettyAdName(row.label)}
            </a>
          ) : (
            <p className="truncate font-semibold text-slate-800">{prettyAdName(row.label)}</p>
          )}
          <p className="mt-0.5 truncate text-[11px] text-slate-400">{context || `ad id ${row.metaAdId ?? "no disponible"}`}</p>
          <p className={cn("mt-1 truncate text-xs font-medium", row.promotedProductName ? "text-indigo-700" : "text-amber-600")}>
            {row.promotedProductName ? `Producto: ${row.promotedProductName}` : "Producto anunciado por definir"}
          </p>
        </div>
      </div>
    </div>
  );
}

function ProductEditor({ row, fallbackStoreIds }: { row: CampaignStat; fallbackStoreIds: string[] }) {
  const router = useRouter();
  const [product, setProduct] = useState(row.promotedProductName ?? "");
  const [skus, setSkus] = useState(row.promotedSkus.join(", "));
  const [message, setMessage] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<PromotedProductSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const searchVersion = useRef(0);
  const suppressNextSearch = useRef(false);
  const [pending, startTransition] = useTransition();
  const suggestion = row.productMix[0];
  const catalogStoreIds = useMemo(
    () => (row.storeIds.length ? row.storeIds : fallbackStoreIds),
    [row.storeIds, fallbackStoreIds],
  );

  useEffect(() => {
    const q = product.trim();
    const version = ++searchVersion.current;
    if (suppressNextSearch.current) {
      suppressNextSearch.current = false;
      setSearching(false);
      return;
    }
    if (!row.metaAdId || q.length < 2 || !catalogStoreIds.length) {
      setSuggestions([]);
      setSearching(false);
      setSearchError(null);
      setResultsOpen(false);
      return;
    }

    setSearching(true);
    setSearchError(null);
    const timer = window.setTimeout(async () => {
      try {
        const result = await searchPromotedProducts(catalogStoreIds, q);
        if (version !== searchVersion.current) return;
        setSuggestions(result.products);
        setSearchError(result.error ?? null);
        setResultsOpen(true);
        setActiveSuggestion(result.products.length ? 0 : -1);
      } catch {
        if (version !== searchVersion.current) return;
        setSuggestions([]);
        setSearchError("No se pudo consultar Shopify. Inténtalo nuevamente.");
        setResultsOpen(true);
      } finally {
        if (version === searchVersion.current) setSearching(false);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [product, catalogStoreIds, row.metaAdId]);

  function chooseProduct(selected: PromotedProductSuggestion) {
    suppressNextSearch.current = true;
    setProduct(selected.title);
    setSkus(selected.skus.join(", "));
    setSuggestions([]);
    setResultsOpen(false);
    setActiveSuggestion(-1);
    setSearchError(null);
  }

  if (!row.metaAdId) return <p className="text-xs text-slate-500">Meta no envió un ad id para este grupo; no se puede guardar un mapeo estable.</p>;
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="font-semibold text-slate-800">Producto anunciado</h4>
          <p className="text-xs text-slate-500">Mapeo manual auditable para comparar anuncio y compra real.</p>
        </div>
        {suggestion && !row.promotedProductName && (
          <button type="button" onClick={() => { setProduct(suggestion.title); setSkus(suggestion.sku ?? ""); }} className="rounded-md border border-indigo-200 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50">
            Usar más comprado
          </button>
        )}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_220px_auto]">
        <div className="relative">
          <input
            value={product}
            onChange={(event) => {
              setProduct(event.target.value);
              setResultsOpen(true);
            }}
            onFocus={() => {
              if (product.trim().length >= 2) setResultsOpen(true);
            }}
            onBlur={() => window.setTimeout(() => setResultsOpen(false), 150)}
            onKeyDown={(event) => {
              if (!resultsOpen || !suggestions.length) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveSuggestion((current) => (current + 1) % suggestions.length);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveSuggestion((current) => (current <= 0 ? suggestions.length - 1 : current - 1));
              } else if (event.key === "Enter" && activeSuggestion >= 0) {
                event.preventDefault();
                chooseProduct(suggestions[activeSuggestion]!);
              } else if (event.key === "Escape") {
                setResultsOpen(false);
              }
            }}
            placeholder="Buscar producto en Shopify"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={resultsOpen}
            aria-controls={`product-results-${row.adId}`}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 pr-9 text-sm outline-none focus:border-brand-400"
          />
          {searching && (
            <span
              aria-label="Buscando productos"
              className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-brand-600"
            />
          )}
          {resultsOpen && product.trim().length >= 2 && (
            <div
              id={`product-results-${row.adId}`}
              role="listbox"
              className="absolute z-30 mt-1 max-h-72 w-full min-w-[320px] overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl shadow-slate-900/10"
            >
              {searching ? (
                <p className="px-3 py-3 text-xs text-slate-500">Buscando en Shopify…</p>
              ) : searchError ? (
                <p className="px-3 py-3 text-xs text-rose-600">{searchError}</p>
              ) : suggestions.length ? (
                suggestions.map((item, index) => (
                  <button
                    key={`${item.title}-${item.skus.join("-")}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeSuggestion}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseProduct(item)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                      index === activeSuggestion ? "bg-brand-50" : "hover:bg-slate-50",
                    )}
                  >
                    {item.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.imageUrl} alt="" className="h-9 w-9 shrink-0 rounded-md border border-slate-100 object-cover" />
                    ) : (
                      <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-slate-100 text-sm">📦</span>
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-slate-800">{item.title}</span>
                      <span className="block truncate text-[11px] text-slate-400">
                        {item.skus.length ? `SKU ${item.skus.join(", ")}` : "Sin SKU"} · {item.stores.join(", ")}
                      </span>
                    </span>
                  </button>
                ))
              ) : (
                <p className="px-3 py-3 text-xs text-slate-500">
                  No encontramos productos activos para “{product.trim()}”.
                </p>
              )}
            </div>
          )}
        </div>
        <input value={skus} onChange={(e) => setSkus(e.target.value)} placeholder="SKU, SKU alternativo" className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-400" />
        <button
          type="button"
          disabled={pending || !product.trim()}
          onClick={() => startTransition(async () => {
            setMessage(null);
            const result = await saveAdPromotedProduct({ adId: row.metaAdId!, productName: product, skus: skus.split(",") });
            setMessage(result.ok ? "Producto guardado." : result.error);
            if (result.ok) router.refresh();
          })}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {pending ? "Guardando…" : "Guardar"}
        </button>
      </div>
      {message && <p className={cn("mt-1.5 text-xs", message.includes("guardado") ? "text-emerald-600" : "text-rose-600")}>{message}</p>}
    </div>
  );
}

function ExpandedRow({
  row,
  currency,
  catalogStoreIds,
}: {
  row: CampaignStat;
  currency: string;
  catalogStoreIds: string[];
}) {
  return (
    <div className="space-y-4 border-t border-slate-100 bg-slate-50/70 p-4">
      <ProductEditor row={row} fallbackStoreIds={catalogStoreIds} />
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Entrega del anuncio en Meta</h4>
        {row.activeDays > 0 ? (
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-200 bg-white p-3 sm:grid-cols-4 lg:grid-cols-8">
            <Metric label="Gasto" value={formatMetaMoney(row.spend, row.metaCurrency)} note={`${row.activeDays} días con datos`} />
            <Metric label="Impresiones" value={formatCompact(row.impressions)} note={`${formatCompact(row.reach)} alcance`} />
            <Metric label="Frec. diaria ponderada" value={row.frequency == null ? "—" : `${row.frequency.toFixed(2)}×`} />
            <Metric label="CPM" value={formatMetaMoney(row.cpm, row.metaCurrency)} />
            <Metric label="Clics" value={formatCompact(row.clicks)} note={row.ctr == null ? undefined : `${formatPct(row.ctr)} CTR`} />
            <Metric label="CPC" value={formatMetaMoney(row.cpc, row.metaCurrency)} />
            <Metric label="CPL" value={formatMetaMoney(row.cpl, row.metaCurrency)} />
            <Metric label="CPA entregado" value={formatMetaMoney(row.deliveredCpa, row.metaCurrency)} />
          </div>
        ) : (
          <p className="text-xs text-slate-400">Este anuncio no tiene histórico de Meta en el período seleccionado.</p>
        )}
      </div>
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Cobertura y calidad del cruce</h4>
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-200 bg-white p-3 sm:grid-cols-4">
          <Metric label="Conversaciones Meta" value={row.metaConversations ? String(row.metaConversations) : "Sin acción disponible"} />
          <Metric label="Leads internos" value={String(row.leads)} note={row.conversationCoverageRate == null ? "No comparable" : `${formatPct(row.conversationCoverageRate)} de Meta`} />
          <Metric label="Pedidos exactos" value={String(row.pedidos)} note={`${formatPct(row.conversion)} lead→pedido`} />
          <Metric label="Seguimiento logístico" value={`${row.shipmentKnown}/${row.pedidos}`} note={row.logisticsCoverageRate == null ? "Sin pedidos" : formatPct(row.logisticsCoverageRate)} />
        </div>
      </div>
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Qué terminaron comprando</h4>
        <div className="flex flex-wrap gap-2">
          {row.productMix.length ? row.productMix.slice(0, 8).map((product) => (
            <span key={`${product.sku}-${product.title}`} className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600">
              {product.title} · {product.orders} pedido{product.orders === 1 ? "" : "s"} · {product.units} u.
            </span>
          )) : <span className="text-xs text-slate-400">Todavía no hay pedidos atribuidos.</span>}
        </div>
      </div>
      {!!row.orders.length && (
        <div className={cn(TABLE_WRAP_FROM[1110], "rounded-lg border border-slate-200 bg-white")}>
          <table className="w-full min-w-[760px] text-xs">
            <thead><tr className={cn(STICKY_HEAD, "bg-slate-50 text-left text-slate-500")}>
              <th className="px-3 py-2 font-medium">Pedido</th><th className="px-3 py-2 font-medium">Cliente / fecha</th>
              <th className="px-3 py-2 font-medium">Producto realmente comprado</th><th className="px-3 py-2 font-medium">Coincidencia</th>
              <th className="px-3 py-2 font-medium">Entrega</th><th className="px-3 py-2 text-right font-medium">Total</th>
            </tr></thead>
            <tbody>{row.orders.map((order) => {
              const match = MATCH[order.match];
              return <tr key={order.orderId} className="border-b border-slate-100 last:border-0">
                <td className="px-3 py-2 font-mono text-slate-700">{order.code ?? order.orderId.slice(0, 8)}</td>
                <td className="px-3 py-2"><p className="text-slate-700">{order.customerName ?? "Sin nombre"}</p><p className="text-slate-400">{order.createdAt ? new Date(order.createdAt).toLocaleDateString("es-PE") : "—"}{order.timeToOrderHours != null ? ` · ${order.timeToOrderHours} h` : ""}</p></td>
                <td className="max-w-[320px] px-3 py-2 text-slate-600">{order.products.map((product) => `${product.quantity}× ${product.title}`).join(" · ") || "Sin detalle"}</td>
                <td className="px-3 py-2"><span className={cn("rounded-full px-2 py-1 font-medium", match.className)}>{match.label}</span></td>
                <td className="px-3 py-2 text-slate-600">{order.deliveryStatus ?? order.statusCategory ?? "Sin seguimiento"}</td>
                <td className="px-3 py-2 text-right font-semibold text-slate-800">{formatCurrency(order.total, currency)}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function CampaignTable({
  rows,
  currency,
  catalogStoreIds,
}: {
  rows: CampaignStat[];
  currency: string;
  catalogStoreIds: string[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(100);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "spend", dir: "desc" });
  const totals = useMemo(() => {
    const leads = rows.reduce((sum, row) => sum + row.leads, 0);
    const orders = rows.reduce((sum, row) => sum + row.pedidos, 0);
    const coveredDeliveredRevenue = rows.filter((row) => row.activeDays > 0).reduce((sum, row) => sum + row.deliveredRevenue, 0);
    const spend = rows.reduce((sum, row) => sum + row.spend, 0);
    const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
    const reach = rows.reduce((sum, row) => sum + row.reach, 0);
    const shipmentKnown = rows.reduce((sum, row) => sum + row.shipmentKnown, 0);
    const metaConversations = rows.reduce((sum, row) => sum + row.metaConversations, 0);
    const leadsCoveredByMeta = rows.filter((row) => row.metaConversations > 0).reduce((sum, row) => sum + row.leads, 0);
    const delivered = rows.reduce((sum, row) => sum + row.deliveredOrders, 0);
    const coveredLeads = rows.filter((row) => row.activeDays > 0).reduce((sum, row) => sum + row.leads, 0);
    const coveredOrders = rows.filter((row) => row.activeDays > 0).reduce((sum, row) => sum + row.pedidos, 0);
    const coveredDelivered = rows.filter((row) => row.activeDays > 0).reduce((sum, row) => sum + row.deliveredOrders, 0);
    const spendByCurrency = new Map<string, { spend: number; leads: number; orders: number; delivered: number }>();
    for (const row of rows) {
      if (row.spend <= 0 || !row.metaCurrency || row.currencyConflict) continue;
      const value = spendByCurrency.get(row.metaCurrency) ?? { spend: 0, leads: 0, orders: 0, delivered: 0 };
      value.spend += row.spend;
      value.leads += row.leads;
      value.orders += row.pedidos;
      value.delivered += row.deliveredOrders;
      spendByCurrency.set(row.metaCurrency, value);
    }
    const currencyCosts = [...spendByCurrency.entries()].map(([code, value]) => ({ code, ...value }));
    const matchingRows = rows.filter((row) => sameCurrency(row.metaCurrency, currency) && row.spend > 0 && !row.currencyConflict);
    const matchingSpend = matchingRows.reduce((sum, row) => sum + row.spend, 0);
    const matchingDeliveredRevenue = matchingRows.reduce((sum, row) => sum + row.deliveredRevenue, 0);
    const syncedAt = rows.map((row) => row.metaSyncedAt).filter((value): value is string => !!value).sort().at(-1) ?? null;
    return {
      leads,
      orders,
      coveredDeliveredRevenue,
      spend,
      impressions,
      reach,
      delivered,
      coveredLeads,
      coveredOrders,
      coveredDelivered,
      metaConversations,
      leadsCoveredByMeta,
      currencyCosts,
      spendLabel: currencyCosts.map(({ code, spend: amount }) => formatMetaMoney(amount, code)).join(" · "),
      delivery: shipmentKnown ? delivered / shipmentKnown : null,
      shipmentKnown,
      matchingSpend,
      matchingDeliveredRevenue,
      syncedAt,
    };
  }, [rows, currency]);
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const av = sort.key === "label" ? prettyAdName(a.label) : (a[sort.key] ?? -1);
    const bv = sort.key === "label" ? prettyAdName(b.label) : (b[sort.key] ?? -1);
    const value = typeof av === "string" ? av.localeCompare(String(bv), "es") : Number(av) - Number(bv);
    return value * (sort.dir === "asc" ? 1 : -1);
  }), [rows, sort]);
  const visibleRows = sorted.slice(0, visibleCount);

  if (!rows.length) return <p className="text-sm text-slate-400">Sin campañas atribuidas todavía.</p>;
  const columns: Array<{ key: SortKey; label: string }> = [
    { key: "label", label: "Anuncio / producto" },
    { key: "spend", label: "Gasto" },
    { key: "cpm", label: "CPM / frec. diaria" },
    { key: "leads", label: "Leads adquiridos / CPL" },
    { key: "pedidos", label: "Pedidos atribuidos / CPA" },
    { key: "productMatchRate", label: "Coincidencia producto" },
    { key: "deliveryRate", label: "Entrega logística / CPA entregado" },
    { key: "deliveredRoas", label: "ROAS entregado" },
  ];
  const costLabel = (field: "leads" | "orders" | "delivered") =>
    totals.currencyCosts
      .filter((item) => item[field] > 0)
      .map((item) => formatMetaMoney(item.spend / item[field], item.code))
      .join(" · ") || "—";
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 sm:grid-cols-4 xl:grid-cols-8">
        <Metric
          label="Gasto Meta"
          value={totals.spendLabel || "—"}
          note={`${rows.filter((row) => row.spend > 0).length} anuncios con inversión`}
        />
        <Metric
          label="Entrega publicitaria"
          value={`${formatCompact(totals.impressions)} imp.`}
          note={`${formatCompact(totals.reach)} alcance diario acum. · ${totals.reach ? (totals.impressions / totals.reach).toFixed(2) : "—"}× frec. diaria`}
        />
        <Metric
          label="Cobertura Meta → CRM"
          value={totals.metaConversations ? formatPct(totals.leadsCoveredByMeta / totals.metaConversations) : "Sin acción Meta"}
          note={`${totals.leadsCoveredByMeta}/${totals.metaConversations} conversaciones`}
        />
        <Metric
          label="Costo por lead"
          value={costLabel("leads")}
          note="Separado por moneda"
        />
        <Metric
          label="CPA generado"
          value={costLabel("orders")}
          note="Pedidos exactos enlazados"
        />
        <Metric
          label="Cobertura logística"
          value={totals.orders ? formatPct(totals.shipmentKnown / totals.orders) : "—"}
          note={`${totals.shipmentKnown}/${totals.orders} pedidos seguidos`}
        />
        <Metric
          label="CPA entregado"
          value={costLabel("delivered")}
          note={`${totals.delivered} entregados conocidos`}
        />
        <Metric
          label="ROAS entregado"
          value={totals.matchingSpend ? `${(totals.matchingDeliveredRevenue / totals.matchingSpend).toFixed(2)}×` : "No comparable"}
          note={totals.matchingSpend ? `Solo gasto y ventas en ${currency}` : `Sin gasto Meta en ${currency}`}
        />
      </div>
      {totals.currencyCosts.some((item) => item.code !== currency) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Los costos se calculan por separado en {totals.currencyCosts.map((item) => item.code).join(" y ")}. El ROAS solo se muestra cuando gasto y ventas comparten moneda; no se convierten ni se suman monedas.
        </div>
      )}
      <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
        Cohorte: leads cuya primera adquisición ocurrió en el período seleccionado, usando el día local de cada tienda. Los pedidos son enlaces exactos de Shopify y pueden haberse generado después. Histórico Meta actualizado: {totals.syncedAt ? new Date(totals.syncedAt).toLocaleString("es-PE") : "sin sincronización verificable"}.
      </div>
      <div className={cn(TABLE_WRAP_FROM[1800], "rounded-xl border border-slate-200")}>
        <table className="w-full min-w-[1460px] text-sm">
          <thead><tr className={cn(STICKY_HEAD, "bg-white text-xs text-slate-500")}>
            <th className="w-9 px-2 py-3" />
            {columns.map((column) => <th key={column.key} className={cn("px-2 py-3 font-medium", column.key === "label" ? "text-left" : "text-right")}>
              <button type="button" onClick={() => setSort((current) => ({ key: column.key, dir: current.key === column.key && current.dir === "desc" ? "asc" : "desc" }))} className="hover:text-slate-800">
                {column.label} {sort.key === column.key ? (sort.dir === "desc" ? "↓" : "↑") : "↕"}
              </button>
            </th>)}
            <th className="px-3 py-3 text-right font-medium">Señal</th>
          </tr></thead>
          <tbody>{visibleRows.map((row) => {
            const decision = DECISIONS[row.decision];
            const isOpen = expanded === row.adId;
            return [
              <tr key={row.rowKey} onClick={() => setExpanded(isOpen ? null : row.adId)} className="cursor-pointer border-b border-slate-100 bg-white hover:bg-slate-50">
                <td className="px-3 py-3 text-slate-400">{isOpen ? "▾" : "›"}</td>
                <td className="px-2 py-3"><LabelCell row={row} /></td>
                <td className="px-2 py-3 text-right"><p className="font-semibold tabular-nums">{row.activeDays ? formatMetaMoney(row.spend, row.metaCurrency) : "—"}</p><p className="text-[11px] text-slate-400">{row.activeDays ? `${formatCompact(row.impressions)} imp.` : "Sin histórico"}</p></td>
                <td className="px-2 py-3 text-right"><p className="font-semibold tabular-nums">{formatMetaMoney(row.cpm, row.metaCurrency)}</p><p className="text-[11px] text-slate-400">{row.frequency == null ? "—" : `${row.frequency.toFixed(2)}×`}</p></td>
                <td className="px-2 py-3 text-right"><p className="font-semibold tabular-nums">{row.leads}</p><p className="text-[11px] text-slate-400">{row.cpl == null ? "CPL —" : `CPL ${formatMetaMoney(row.cpl, row.metaCurrency)}`}</p></td>
                <td className="px-2 py-3 text-right"><p className="font-semibold tabular-nums">{row.pedidos}</p><p className="text-[11px] text-slate-400">{row.cpa == null ? `Conv. lead→pedido ${formatPct(row.conversion)}` : `CPA ${formatMetaMoney(row.cpa, row.metaCurrency)}`}</p></td>
                <td className="px-2 py-3 text-right">{row.productMatchRate == null ? <span className="text-xs text-amber-600">Por mapear</span> : <><p className="font-semibold">{formatPct(row.productMatchRate)}</p><p className="text-[11px] text-slate-400">{row.exactOrders + row.mixedOrders}/{row.exactOrders + row.mixedOrders + row.crossSellOrders}</p></>}</td>
                <td className="px-2 py-3 text-right">{row.deliveryRate == null ? <span className="text-xs text-slate-400">Sin datos</span> : <><p className="font-semibold">{formatPct(row.deliveryRate)}</p><p className="text-[11px] text-slate-400">{row.deliveredCpa == null ? `${row.deliveredOrders}/${row.shipmentKnown}` : `CPA ${formatMetaMoney(row.deliveredCpa, row.metaCurrency)}`}</p></>}</td>
                <td className="px-2 py-3 text-right">
                  {sameCurrency(row.metaCurrency, currency) && row.deliveredRoas != null ? (
                    <><p className="font-semibold tabular-nums text-emerald-700">{row.deliveredRoas.toFixed(2)}×</p><p className="text-[11px] text-slate-400">{formatCurrency(row.deliveredRevenue, currency)} entregado</p></>
                  ) : (
                    <><p className="text-xs font-medium text-amber-600">No comparable</p><p className="text-[11px] text-slate-400">{row.metaCurrency ?? "—"} ≠ {currency}</p></>
                  )}
                </td>
                <td className="px-3 py-3 text-right"><span title={row.decisionReason || decision.help} className={cn("inline-flex rounded-full px-2.5 py-1 text-xs font-semibold", decision.className)}>{decision.label}</span></td>
              </tr>,
              isOpen && <tr key={`${row.rowKey}-detail`}><td colSpan={10} className="p-0"><ExpandedRow row={row} currency={currency} catalogStoreIds={catalogStoreIds} /></td></tr>,
            ];
          })}</tbody>
        </table>
      </div>
      {visibleCount < sorted.length && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-slate-400">Mostrando {visibleRows.length} de {sorted.length} anuncios, ordenados por {columns.find((column) => column.key === sort.key)?.label.toLowerCase()}.</p>
          <button type="button" onClick={() => setVisibleCount((current) => current + 100)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            Mostrar 100 más
          </button>
        </div>
      )}
      <p className="text-xs text-slate-400">CPM se calcula con totales aditivos. La frecuencia es un promedio diario ponderado porque el alcance único entre días no se puede sumar. “Coincidencia producto” compara el producto anunciado con el pedido exacto enlazado. “Conversión lead→pedido” no es CPA. CPA entregado usa únicamente entregas conocidas. Escalar/Prometedor exige gasto verificable y al menos 5 entregas.</p>
    </div>
  );
}
