"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CampaignDecision, CampaignProductMatch, CampaignStat } from "@/lib/metrics";
import {
  campaignMatchesProduct,
  campaignProductOptions,
  formatCurrency,
} from "@/lib/metrics";
import { adObjectiveLabel, adsManagerUrl, prettyAdName } from "@/lib/meta-ads";
import { CopyButton } from "@/components/copy-button";
import { pctText } from "@/components/figures";
import {
  saveAdPromotedProduct,
  searchPromotedProducts,
  type PromotedProductSuggestion,
} from "@/app/dashboard/actions";
import { cn, OVER_TABLE_Z } from "@/components/ui";
import { Badge, Banner, CHECKBOX, FIELD, FIELD_BOX, OpsButton, type BadgeTone } from "@/components/ops-ui";
import { IconChevronRight, IconPackage } from "@/components/icons";

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

const DECISIONS: Record<CampaignDecision, { label: string; tone: BadgeTone; help: string }> = {
  scale: { label: "Escalar", tone: "ok", help: "Conversión claramente superior al promedio." },
  promising: { label: "Prometedor", tone: "info", help: "Conversión igual o superior al promedio." },
  review_close: { label: "Revisar cierre", tone: "warn", help: "Genera leads, pero convierte por debajo del promedio." },
  misaligned: { label: "Producto desalineado", tone: "warn", help: "La mayoría compra un producto distinto al anunciado." },
  operational: { label: "Freno operativo", tone: "crit", help: "La entrega está deteriorando el resultado comercial." },
  insufficient: { label: "Muestra baja", tone: "neutral", help: "Se requieren al menos 20 leads para recomendar una acción." },
  no_attribution: { label: "Sin leads atribuidos", tone: "crit", help: "Meta registra gasto, pero no hay leads atribuidos a este anuncio en el período." },
  data_incomplete: { label: "Datos incompletos", tone: "neutral", help: "No hay gasto con moneda verificable; no se emite una recomendación económica." },
};

const MATCH: Record<CampaignProductMatch, { label: string; tone: BadgeTone }> = {
  exact: { label: "Mismo producto", tone: "ok" },
  mixed: { label: "Mixto", tone: "info" },
  cross_sell: { label: "Otro producto", tone: "warn" },
  unknown: { label: "Sin mapear", tone: "neutral" },
};

/** Una cifra de un marco de celdas: etiqueta de 12 px, cifra tabular y su nota. */
function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0 bg-white px-3 py-2.5">
      <p className="truncate text-xs font-medium leading-4 text-ink-600">{label}</p>
      <p className="mt-0.5 truncate text-sm font-semibold leading-5 tabular-nums text-ink-900">{value}</p>
      {note && <p className="truncate text-xs leading-4 text-ink-500">{note}</p>}
    </div>
  );
}

/** El marco de las cifras: celdas sobre hairlines. */
const METRIC_FRAME = "grid gap-px overflow-hidden rounded-lg bg-line ring-1 ring-line";

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
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
          className="block truncate font-semibold text-ink-900 hover:text-brand-700 hover:underline"
        >
          {prettyAdName(row.label)}
        </a>
      ) : (
        <p className="truncate font-semibold text-ink-900">{prettyAdName(row.label)}</p>
      )}
      <p className="mt-0.5 truncate text-xs text-ink-500">{context || `ad id ${row.metaAdId ?? "no disponible"}`}</p>
      <p className={cn("mt-1 truncate text-xs font-medium", row.promotedProductName ? "text-ink-700" : "text-warn-fg")}>
        {row.promotedProductName ? `Producto: ${row.promotedProductName}` : "Producto anunciado por definir"}
      </p>
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

  if (!row.metaAdId) return <p className="text-[13px] text-ink-500">Meta no envió un ad id para este grupo; no se puede guardar un mapeo estable.</p>;
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-ink-900">Producto anunciado</h4>
          <p className="text-[13px] text-ink-500">Mapeo manual auditable para comparar anuncio y compra real.</p>
          {/* EL ID Y EL CONJUNTO, A LA VISTA. El id es con lo que se busca el
              anuncio en Ads Manager y con lo que se reporta un cruce dudoso; se
              usaba para guardar y no se mostraba en ningún sitio. El conjunto
              va al lado porque es la unidad que hereda: lo que se guarde acá
              alcanza a los anuncios sin asignar de ESE conjunto. */}
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-500">
            <span className="font-mono">{row.metaAdId}</span>
            <CopyButton value={row.metaAdId} label="Copiar ID" />
            {row.meta?.adsetName && (
              <span>
                · Conjunto: <span className="font-medium text-ink-700">{row.meta.adsetName}</span>
              </span>
            )}
          </p>
        </div>
        {suggestion && !row.promotedProductName && (
          <OpsButton size="sm" onClick={() => { setProduct(suggestion.title); setSkus(suggestion.sku ?? ""); }} className="pointer-coarse:h-11">
            Usar el más comprado
          </OpsButton>
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
                // Cierra la lista y no el panel que la contiene.
                event.preventDefault();
                setResultsOpen(false);
              }
            }}
            placeholder="Buscar producto en Shopify"
            aria-label="Producto anunciado"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={resultsOpen}
            aria-controls={`product-results-${row.adId}`}
            className={cn(FIELD_BOX, "h-9 w-full pl-3 pr-9 pointer-coarse:h-11")}
          />
          {searching && (
            <span
              aria-label="Buscando productos"
              className="pointer-events-none absolute right-3 top-2.5 size-4 animate-spin rounded-full border-2 border-line border-t-brand-600"
            />
          )}
          {resultsOpen && product.trim().length >= 2 && (
            <div
              id={`product-results-${row.adId}`}
              role="listbox"
              className={cn("absolute mt-1 max-h-72 w-full min-w-[320px] overflow-y-auto rounded-lg bg-white p-1 shadow-pop", OVER_TABLE_Z)}
            >
              {searching ? (
                <p className="px-3 py-3 text-[13px] text-ink-500">Buscando en Shopify…</p>
              ) : searchError ? (
                <p className="px-3 py-3 text-[13px] text-crit-fg">{searchError}</p>
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
                      "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                      index === activeSuggestion ? "bg-brand-50" : "hover:bg-wash",
                    )}
                  >
                    {item.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.imageUrl} alt="" className="size-9 shrink-0 rounded-md object-cover ring-1 ring-line" />
                    ) : (
                      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-md bg-wash text-ink-500">
                        <IconPackage className="size-4" />
                      </span>
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink-900">{item.title}</span>
                      <span className="block truncate text-xs text-ink-500">
                        {item.skus.length ? `SKU ${item.skus.join(", ")}` : "Sin SKU"} · {item.stores.join(", ")}
                      </span>
                    </span>
                  </button>
                ))
              ) : (
                <p className="px-3 py-3 text-[13px] text-ink-500">
                  No encontramos productos activos para «{product.trim()}».
                </p>
              )}
            </div>
          )}
        </div>
        <input value={skus} onChange={(e) => setSkus(e.target.value)} placeholder="SKU, SKU alternativo" aria-label="SKU del producto anunciado" className={cn(FIELD, "pointer-coarse:h-11")} />
        <OpsButton
          variant="primary"
          disabled={pending || !product.trim()}
          onClick={() => startTransition(async () => {
            setMessage(null);
            const result = await saveAdPromotedProduct({ adId: row.metaAdId!, productName: product, skus: skus.split(",") });
            // La herencia se DICE. Es un cambio que la persona no pidió
            // explícitamente y que toca filas que no tiene delante: callarlo
            // sería que el panel se moviera solo.
            setMessage(
              !result.ok
                ? result.error
                : result.heredados > 0
                  ? `Producto guardado. Se aplicó también a ${result.heredados} ${result.heredados === 1 ? "anuncio" : "anuncios"} del mismo conjunto que estaban sin asignar.`
                  : "Producto guardado.",
            );
            if (result.ok) router.refresh();
          })}
          className="pointer-coarse:h-11"
        >
          {pending ? "Guardando…" : "Guardar"}
        </OpsButton>
      </div>
      {message && <p role="status" className={cn("mt-1.5 text-[13px]", message.includes("guardado") ? "text-ok-fg" : "text-crit-fg")}>{message}</p>}
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
    <div className="flex flex-col gap-5 border-t border-line bg-wash p-4">
      <ProductEditor row={row} fallbackStoreIds={catalogStoreIds} />
      <div>
        <h4 className="mb-2 text-[13px] font-semibold text-ink-900">Entrega del anuncio en Meta</h4>
        {row.activeDays > 0 ? (
          <div className={cn(METRIC_FRAME, "grid-cols-2 sm:grid-cols-4 lg:grid-cols-8")}>
            <Metric label="Gasto" value={formatMetaMoney(row.spend, row.metaCurrency)} note={`${row.activeDays} días con datos`} />
            <Metric label="Impresiones" value={formatCompact(row.impressions)} note={`${formatCompact(row.reach)} alcance`} />
            <Metric label="Frec. diaria ponderada" value={row.frequency == null ? "—" : `${row.frequency.toFixed(2)}×`} />
            <Metric label="CPM" value={formatMetaMoney(row.cpm, row.metaCurrency)} />
            <Metric label="Clics" value={formatCompact(row.clicks)} note={row.ctr == null ? undefined : `${pctText(row.ctr)} CTR`} />
            <Metric label="CPC" value={formatMetaMoney(row.cpc, row.metaCurrency)} />
            <Metric label="CPL" value={formatMetaMoney(row.cpl, row.metaCurrency)} />
            <Metric label="CPA entregado" value={formatMetaMoney(row.deliveredCpa, row.metaCurrency)} />
          </div>
        ) : (
          <p className="text-[13px] text-ink-500">Este anuncio no tiene histórico de Meta en el período seleccionado.</p>
        )}
      </div>
      <div>
        <h4 className="mb-2 text-[13px] font-semibold text-ink-900">Cobertura y calidad del cruce</h4>
        <div className={cn(METRIC_FRAME, "grid-cols-2 sm:grid-cols-4")}>
          <Metric label="Conversaciones Meta" value={row.metaConversations ? String(row.metaConversations) : "Sin acción disponible"} />
          <Metric label="Leads internos" value={String(row.leads)} note={row.conversationCoverageRate == null ? "No comparable" : `${pctText(row.conversationCoverageRate)} de Meta`} />
          <Metric label="Pedidos exactos" value={String(row.pedidos)} note={`${pctText(row.conversion)} lead→pedido`} />
          <Metric label="Seguimiento logístico" value={`${row.shipmentKnown}/${row.pedidos}`} note={row.logisticsCoverageRate == null ? "Sin pedidos" : pctText(row.logisticsCoverageRate)} />
        </div>
      </div>
      <div>
        <h4 className="mb-2 text-[13px] font-semibold text-ink-900">Qué terminaron comprando</h4>
        <div className="flex flex-wrap gap-1.5">
          {row.productMix.length ? row.productMix.slice(0, 8).map((product) => (
            <span key={`${product.sku}-${product.title}`} className="inline-flex h-7 items-center rounded-full bg-white px-2.5 text-xs text-ink-700 ring-1 ring-inset ring-line-strong">
              {product.title}{"\u00a0· "}{product.orders} pedido{product.orders === 1 ? "" : "s"}{"\u00a0· "}{product.units} u.
            </span>
          )) : <span className="text-[13px] text-ink-500">Todavía no hay pedidos atribuidos.</span>}
        </div>
      </div>
      {!!row.orders.length && (
        <div className="overflow-x-auto rounded-lg bg-white ring-1 ring-line">
          <table className="w-full min-w-[760px] text-xs">
            <thead><tr className="text-left text-ink-600 shadow-[inset_0_-1px_0_var(--color-line)]">
              <th scope="col" className="px-3 py-2 font-semibold">Pedido</th><th scope="col" className="px-3 py-2 font-semibold">Cliente / fecha</th>
              <th scope="col" className="px-3 py-2 font-semibold">Producto realmente comprado</th><th scope="col" className="px-3 py-2 font-semibold">Coincidencia</th>
              <th scope="col" className="px-3 py-2 font-semibold">Entrega</th><th scope="col" className="px-3 py-2 text-right font-semibold">Total</th>
            </tr></thead>
            <tbody>{row.orders.map((order) => {
              const match = MATCH[order.match];
              return <tr key={order.orderId} className="border-t border-line">
                <td className="px-3 py-2 font-mono text-ink-900">{order.code ?? order.orderId.slice(0, 8)}</td>
                <td className="px-3 py-2"><p className="text-ink-900">{order.customerName ?? "Sin nombre"}</p><p className="tabular-nums text-ink-500">{order.createdAt ? new Date(order.createdAt).toLocaleDateString("es-PE") : "—"}{order.timeToOrderHours != null ? ` · ${order.timeToOrderHours} h` : ""}</p></td>
                <td className="max-w-[320px] px-3 py-2 text-ink-700">{order.products.map((product) => `${product.quantity}× ${product.title}`).join(" · ") || "Sin detalle"}</td>
                <td className="px-3 py-2"><Badge tone={match.tone}>{match.label}</Badge></td>
                <td className="px-3 py-2 text-ink-700">{order.deliveryStatus ?? order.statusCategory ?? "Sin seguimiento"}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-ink-900">{formatCurrency(order.total, currency)}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function CampaignTable({
  rows: allRows,
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
  const [productKey, setProductKey] = useState("");
  const [includeSold, setIncludeSold] = useState(false);

  const productOptions = useMemo(
    () => campaignProductOptions(allRows, includeSold),
    [allRows, includeSold],
  );
  // El producto elegido puede dejar de existir al apagar el toggle: si solo lo
  // vendían y nadie lo anuncia, sale del catálogo. Se conserva la selección y
  // el vacío lo explica, en vez de resetear en silencio y que parezca un clic
  // perdido.
  const selectedOption = productOptions.find((option) => option.key === productKey) ?? null;
  const rows = useMemo(
    () => allRows.filter((row) => campaignMatchesProduct(row, productKey, includeSold)),
    [allRows, productKey, includeSold],
  );

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

  if (!allRows.length) return <p className="text-sm text-ink-500">Sin campañas atribuidas todavía.</p>;
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="inline-flex items-center gap-2 text-[13px] font-medium text-ink-600">
          Producto
          <select
            value={productKey}
            onChange={(event) => {
              setProductKey(event.target.value);
              setVisibleCount(100);
              setExpanded(null);
            }}
            className={cn(FIELD_BOX, "h-8 max-w-[320px] px-2.5 font-normal pointer-coarse:h-11")}
          >
            <option value="">Todos los productos</option>
            {productOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
                {includeSold && !option.promotedAds ? " (solo vendido)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-flex items-center gap-2 text-[13px] text-ink-700">
          <input
            type="checkbox"
            checked={includeSold}
            onChange={(event) => {
              setIncludeSold(event.target.checked);
              setVisibleCount(100);
              setExpanded(null);
            }}
            className={CHECKBOX}
          />
          Incluir por producto vendido
        </label>
        {productKey && (
          <span className="text-[13px] tabular-nums text-ink-500">
            {rows.length} de {allRows.length} anuncios
          </span>
        )}
      </div>
      {productKey && (
        <p className="max-w-[80ch] text-[13px] leading-5 text-ink-600">
          {includeSold
            ? "Entran los anuncios que promocionan este producto y también aquellos cuyos pedidos lo contienen aunque anuncien otra cosa."
            : "Entran solo los anuncios que promocionan este producto. Actívalo para ver además los que lo venden sin anunciarlo."}{" "}
          Las cifras de abajo se recalculan sobre este subconjunto; la señal de cada fila sigue comparándose contra el promedio de todos los anuncios.
        </p>
      )}
      <div className={cn(METRIC_FRAME, "grid-cols-2 sm:grid-cols-4")}>
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
          value={totals.metaConversations ? pctText(totals.leadsCoveredByMeta / totals.metaConversations) : "Sin acción Meta"}
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
          value={totals.orders ? pctText(totals.shipmentKnown / totals.orders) : "—"}
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
        <Banner tone="warn">
          Los costos se calculan por separado en {totals.currencyCosts.map((item) => item.code).join(" y ")}. El ROAS solo se muestra cuando gasto y ventas comparten moneda; no se convierten ni se suman monedas.
        </Banner>
      )}
      <p className="max-w-[90ch] text-[13px] leading-5 text-ink-500">
        Cohorte: leads cuya primera adquisición ocurrió en el período seleccionado, usando el día local de cada tienda. Los pedidos son enlaces exactos de Shopify y pueden haberse generado después. Histórico Meta actualizado: {totals.syncedAt ? new Date(totals.syncedAt).toLocaleString("es-PE") : "sin sincronización verificable"}.
      </p>
      <div className="overflow-x-auto rounded-lg ring-1 ring-line">
        <table className="w-full min-w-[1460px] text-sm">
          <thead><tr className="bg-white text-xs text-ink-600 shadow-[inset_0_-1px_0_var(--color-line)]">
            <th scope="col" className="w-9 px-2 py-2.5"><span className="sr-only">Abrir</span></th>
            {columns.map((column) => {
              const active = sort.key === column.key;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={active ? (sort.dir === "desc" ? "descending" : "ascending") : undefined}
                  className={cn("px-2 py-2.5 font-semibold", column.key === "label" ? "text-left" : "text-right")}
                >
                  <button
                    type="button"
                    onClick={() => setSort((current) => ({ key: column.key, dir: current.key === column.key && current.dir === "desc" ? "asc" : "desc" }))}
                    className={cn("inline-flex items-center gap-1 rounded hover:text-ink-900", active && "text-ink-900")}
                  >
                    {column.label}
                    <span aria-hidden className={active ? "text-ink-900" : "text-ink-300"}>{active ? (sort.dir === "desc" ? "↓" : "↑") : "↕"}</span>
                  </button>
                </th>
              );
            })}
            <th scope="col" className="px-3 py-2.5 text-right font-semibold">Señal</th>
          </tr></thead>
          <tbody>{!rows.length && (
            <tr><td colSpan={10} className="px-3 py-8 text-center text-sm text-ink-500">
              {selectedOption
                ? `Ningún anuncio ${includeSold ? "promociona ni vende" : "promociona"} «${selectedOption.label}» en este período.`
                : "El producto elegido ya no está en la lista: nadie lo anuncia, solo aparece en pedidos. Activa «Incluir por producto vendido» para encontrarlo."}
            </td></tr>
          )}
          {visibleRows.map((row) => {
            const decision = DECISIONS[row.decision];
            const isOpen = expanded === row.adId;
            return [
              <tr key={row.rowKey} onClick={() => setExpanded(isOpen ? null : row.adId)} className={cn("cursor-pointer border-t border-line align-top transition-colors hover:bg-wash", isOpen ? "bg-wash" : "bg-white")}>
                <td className="px-2 py-3">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? "Cerrar" : "Abrir"} el detalle de ${prettyAdName(row.label)}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setExpanded(isOpen ? null : row.adId);
                    }}
                    className="grid size-6 place-items-center rounded text-ink-500 hover:text-ink-900"
                  >
                    <IconChevronRight className={cn("size-4 transition-transform", isOpen && "rotate-90")} />
                  </button>
                </td>
                <td className="px-2 py-3"><LabelCell row={row} /></td>
                <td className="px-2 py-3 text-right"><p className="font-semibold tabular-nums text-ink-900">{row.activeDays ? formatMetaMoney(row.spend, row.metaCurrency) : "—"}</p><p className="text-xs text-ink-500">{row.activeDays ? `${formatCompact(row.impressions)} imp.` : "Sin histórico"}</p></td>
                <td className="px-2 py-3 text-right"><p className="font-semibold tabular-nums text-ink-900">{formatMetaMoney(row.cpm, row.metaCurrency)}</p><p className="text-xs tabular-nums text-ink-500">{row.frequency == null ? "—" : `${row.frequency.toFixed(2)}×`}</p></td>
                <td className="px-2 py-3 text-right"><p className="font-semibold tabular-nums text-ink-900">{row.leads}</p><p className="text-xs text-ink-500">{row.cpl == null ? "CPL —" : `CPL ${formatMetaMoney(row.cpl, row.metaCurrency)}`}</p></td>
                <td className="px-2 py-3 text-right"><p className="font-semibold tabular-nums text-ink-900">{row.pedidos}</p><p className="text-xs text-ink-500">{row.cpa == null ? `Conv. lead→pedido ${pctText(row.conversion)}` : `CPA ${formatMetaMoney(row.cpa, row.metaCurrency)}`}</p></td>
                <td className="px-2 py-3 text-right">{row.productMatchRate == null ? <span className="text-xs font-medium text-warn-fg">Por mapear</span> : <><p className="font-semibold tabular-nums text-ink-900">{pctText(row.productMatchRate)}</p><p className="text-xs tabular-nums text-ink-500">{row.exactOrders + row.mixedOrders}/{row.exactOrders + row.mixedOrders + row.crossSellOrders}</p></>}</td>
                <td className="px-2 py-3 text-right">{row.deliveryRate == null ? <span className="text-xs text-ink-500">Sin datos</span> : <><p className="font-semibold tabular-nums text-ink-900">{pctText(row.deliveryRate)}</p><p className="text-xs text-ink-500">{row.deliveredCpa == null ? `${row.deliveredOrders}/${row.shipmentKnown}` : `CPA ${formatMetaMoney(row.deliveredCpa, row.metaCurrency)}`}</p></>}</td>
                <td className="px-2 py-3 text-right">
                  {sameCurrency(row.metaCurrency, currency) && row.deliveredRoas != null ? (
                    <><p className="font-semibold tabular-nums text-ink-900">{row.deliveredRoas.toFixed(2)}×</p><p className="text-xs text-ink-500">{formatCurrency(row.deliveredRevenue, currency)} entregado</p></>
                  ) : (
                    <><p className="text-xs font-medium text-warn-fg">No comparable</p><p className="text-xs text-ink-500">{row.metaCurrency ?? "—"} ≠ {currency}</p></>
                  )}
                </td>
                <td className="px-3 py-3 text-right"><Badge tone={decision.tone} title={row.decisionReason || decision.help}>{decision.label}</Badge></td>
              </tr>,
              isOpen && <tr key={`${row.rowKey}-detail`}><td colSpan={10} className="p-0"><ExpandedRow row={row} currency={currency} catalogStoreIds={catalogStoreIds} /></td></tr>,
            ];
          })}</tbody>
        </table>
      </div>
      {visibleCount < sorted.length && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-ink-500">Mostrando {visibleRows.length} de {sorted.length} anuncios, ordenados por {columns.find((column) => column.key === sort.key)?.label.toLowerCase()}.</p>
          <OpsButton size="sm" onClick={() => setVisibleCount((current) => current + 100)} className="pointer-coarse:h-11">
            Mostrar 100 más
          </OpsButton>
        </div>
      )}
      <p className="max-w-[90ch] text-xs leading-4 text-ink-500">CPM se calcula con totales aditivos. La frecuencia es un promedio diario ponderado porque el alcance único entre días no se puede sumar. «Coincidencia producto» compara el producto anunciado con el pedido exacto enlazado. «Conversión lead→pedido» no es CPA. CPA entregado usa únicamente entregas conocidas. Escalar y Prometedor exigen gasto verificable y al menos 5 entregas.</p>
    </div>
  );
}
