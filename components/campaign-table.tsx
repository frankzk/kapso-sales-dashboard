"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CampaignDecision, CampaignProductMatch, CampaignStat } from "@/lib/metrics";
import { formatCurrency, formatPct } from "@/lib/metrics";
import { adObjectiveLabel, adsManagerUrl, prettyAdName } from "@/lib/meta-ads";
import { saveAdPromotedProduct } from "@/app/dashboard/actions";
import { cn } from "@/components/ui";

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

function ProductEditor({ row }: { row: CampaignStat }) {
  const router = useRouter();
  const [product, setProduct] = useState(row.promotedProductName ?? "");
  const [skus, setSkus] = useState(row.promotedSkus.join(", "));
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const suggestion = row.productMix[0];

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
        <input value={product} onChange={(e) => setProduct(e.target.value)} placeholder="Nombre del producto promovido" className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-400" />
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

function ExpandedRow({ row, currency }: { row: CampaignStat; currency: string }) {
  return (
    <div className="space-y-4 border-t border-slate-100 bg-slate-50/70 p-4">
      <ProductEditor row={row} />
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Entrega del anuncio en Meta</h4>
        {row.activeDays > 0 ? (
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-200 bg-white p-3 sm:grid-cols-4 lg:grid-cols-8">
            <Metric label="Gasto" value={formatMetaMoney(row.spend, row.metaCurrency)} note={`${row.activeDays} días con datos`} />
            <Metric label="Impresiones" value={formatCompact(row.impressions)} note={`${formatCompact(row.reach)} alcance`} />
            <Metric label="Frecuencia" value={row.frequency == null ? "—" : `${row.frequency.toFixed(2)}×`} />
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
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full min-w-[760px] text-xs">
            <thead><tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-500">
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

export function CampaignTable({ rows, currency }: { rows: CampaignStat[]; currency: string }) {
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
    const delivered = rows.reduce((sum, row) => sum + row.deliveredOrders, 0);
    const coveredLeads = rows.filter((row) => row.activeDays > 0).reduce((sum, row) => sum + row.leads, 0);
    const coveredOrders = rows.filter((row) => row.activeDays > 0).reduce((sum, row) => sum + row.pedidos, 0);
    const coveredDelivered = rows.filter((row) => row.activeDays > 0).reduce((sum, row) => sum + row.deliveredOrders, 0);
    const currencies = [...new Set(rows.filter((row) => row.spend > 0 && row.metaCurrency).map((row) => row.metaCurrency!))];
    const spendByCurrency = new Map<string, number>();
    for (const row of rows) {
      if (row.spend <= 0) continue;
      const key = row.metaCurrency ?? "SIN MONEDA";
      spendByCurrency.set(key, (spendByCurrency.get(key) ?? 0) + row.spend);
    }
    const metaCurrency = currencies.length === 1 ? currencies[0]! : null;
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
      metaCurrency,
      spendLabel: [...spendByCurrency.entries()].map(([code, amount]) => formatMetaMoney(amount, code === "SIN MONEDA" ? null : code)).join(" · "),
      delivery: shipmentKnown ? delivered / shipmentKnown : null,
    };
  }, [rows]);
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
    { key: "cpm", label: "CPM / frecuencia" },
    { key: "leads", label: "Leads / CPL" },
    { key: "pedidos", label: "Pedidos / CPA" },
    { key: "productMatchRate", label: "Mismo producto" },
    { key: "deliveryRate", label: "Entregados / CPA real" },
    { key: "deliveredRoas", label: "ROAS entregado" },
  ];
  const summaryCurrencyMatches = sameCurrency(totals.metaCurrency, currency);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 sm:grid-cols-3 xl:grid-cols-6">
        <Metric
          label="Gasto Meta"
          value={totals.spendLabel || "—"}
          note={`${rows.filter((row) => row.spend > 0).length} anuncios con inversión`}
        />
        <Metric
          label="Entrega publicitaria"
          value={`${formatCompact(totals.impressions)} imp.`}
          note={`${formatCompact(totals.reach)} alcance · ${totals.reach ? (totals.impressions / totals.reach).toFixed(2) : "—"}× frec.`}
        />
        <Metric
          label="Costo por lead"
          value={totals.metaCurrency && totals.coveredLeads ? formatMetaMoney(totals.spend / totals.coveredLeads, totals.metaCurrency) : "—"}
          note={`${totals.coveredLeads}/${totals.leads} leads con gasto`}
        />
        <Metric
          label="CPA generado"
          value={totals.metaCurrency && totals.coveredOrders ? formatMetaMoney(totals.spend / totals.coveredOrders, totals.metaCurrency) : "—"}
          note={`${totals.coveredOrders}/${totals.orders} pedidos con gasto`}
        />
        <Metric
          label="CPA entregado"
          value={totals.metaCurrency && totals.coveredDelivered ? formatMetaMoney(totals.spend / totals.coveredDelivered, totals.metaCurrency) : "—"}
          note={`${totals.coveredDelivered}/${totals.delivered} entregados con gasto`}
        />
        <Metric
          label="ROAS entregado"
          value={summaryCurrencyMatches && totals.spend ? `${(totals.coveredDeliveredRevenue / totals.spend).toFixed(2)}×` : "No comparable"}
          note={summaryCurrencyMatches ? `${formatCurrency(totals.coveredDeliveredRevenue, currency)} entregado con gasto` : `${totals.metaCurrency ?? "Meta"} ≠ ${currency}`}
        />
      </div>
      {!summaryCurrencyMatches && totals.spend > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          El gasto está en {totals.metaCurrency ?? "más de una moneda"} y las ventas en {currency}. CPL y CPA sí son válidos en la moneda de Meta; el ROAS se oculta hasta configurar un tipo de cambio.
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full min-w-[1460px] text-sm">
          <thead><tr className="border-b border-slate-200 bg-white text-xs text-slate-500">
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
              <tr key={row.adId} onClick={() => setExpanded(isOpen ? null : row.adId)} className="cursor-pointer border-b border-slate-100 bg-white hover:bg-slate-50">
                <td className="px-3 py-3 text-slate-400">{isOpen ? "▾" : "›"}</td>
                <td className="px-2 py-3"><LabelCell row={row} /></td>
                <td className="px-2 py-3 text-right"><p className="font-semibold tabular-nums">{row.activeDays ? formatMetaMoney(row.spend, row.metaCurrency) : "—"}</p><p className="text-[11px] text-slate-400">{row.activeDays ? `${formatCompact(row.impressions)} imp.` : "Sin histórico"}</p></td>
                <td className="px-2 py-3 text-right"><p className="font-semibold tabular-nums">{formatMetaMoney(row.cpm, row.metaCurrency)}</p><p className="text-[11px] text-slate-400">{row.frequency == null ? "—" : `${row.frequency.toFixed(2)}×`}</p></td>
                <td className="px-2 py-3 text-right"><p className="font-semibold tabular-nums">{row.leads}</p><p className="text-[11px] text-slate-400">{row.cpl == null ? "CPL —" : `CPL ${formatMetaMoney(row.cpl, row.metaCurrency)}`}</p></td>
                <td className="px-2 py-3 text-right"><p className="font-semibold tabular-nums">{row.pedidos}</p><p className="text-[11px] text-slate-400">{row.cpa == null ? formatPct(row.conversion) : `CPA ${formatMetaMoney(row.cpa, row.metaCurrency)}`}</p></td>
                <td className="px-2 py-3 text-right">{row.productMatchRate == null ? <span className="text-xs text-amber-600">Por mapear</span> : <><p className="font-semibold">{formatPct(row.productMatchRate)}</p><p className="text-[11px] text-slate-400">{row.exactOrders + row.mixedOrders}/{row.exactOrders + row.mixedOrders + row.crossSellOrders}</p></>}</td>
                <td className="px-2 py-3 text-right">{row.deliveryRate == null ? <span className="text-xs text-slate-400">Sin datos</span> : <><p className="font-semibold">{formatPct(row.deliveryRate)}</p><p className="text-[11px] text-slate-400">{row.deliveredCpa == null ? `${row.deliveredOrders}/${row.shipmentKnown}` : `CPA ${formatMetaMoney(row.deliveredCpa, row.metaCurrency)}`}</p></>}</td>
                <td className="px-2 py-3 text-right">
                  {sameCurrency(row.metaCurrency, currency) && row.deliveredRoas != null ? (
                    <><p className="font-semibold tabular-nums text-emerald-700">{row.deliveredRoas.toFixed(2)}×</p><p className="text-[11px] text-slate-400">{formatCurrency(row.deliveredRevenue, currency)} entregado</p></>
                  ) : (
                    <><p className="text-xs font-medium text-amber-600">No comparable</p><p className="text-[11px] text-slate-400">{row.metaCurrency ?? "—"} ≠ {currency}</p></>
                  )}
                </td>
                <td className="px-3 py-3 text-right"><span title={decision.help} className={cn("inline-flex rounded-full px-2.5 py-1 text-xs font-semibold", decision.className)}>{decision.label}</span></td>
              </tr>,
              isOpen && <tr key={`${row.adId}-detail`}><td colSpan={10} className="p-0"><ExpandedRow row={row} currency={currency} /></td></tr>,
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
      <p className="text-xs text-slate-400">CPM y frecuencia se recalculan desde los totales del período, no promedian días. “Mismo producto” compara el pedido enlazado. CPA real usa únicamente pedidos entregados.</p>
    </div>
  );
}
