import { cn } from "@/components/ui";
import { formatCurrency, type LossReason, type LostRevenue } from "@/lib/metrics";

// Reason bucket → bar color (mirrors the mockup's red/orange/yellow/blue/violet/gray).
const REASON_BAR: Record<string, string> = {
  no_respondio: "bg-red-500",
  compro_otro_lado: "bg-orange-500",
  solo_info: "bg-yellow-500",
  sin_stock: "bg-blue-500",
  cancelado: "bg-violet-500",
  otros: "bg-slate-400",
};

export function LossReasonBars({ items, total }: { items: LossReason[]; total: number }) {
  if (!items.length) {
    return <p className="text-sm text-slate-400">Sin leads sin convertir en el rango.</p>;
  }
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="space-y-3">
      <div className="space-y-2.5">
        {items.map((it) => (
          <div key={it.bucket} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate text-slate-700">{it.label}</span>
              <span className="shrink-0 text-slate-500">
                <span className="font-semibold text-slate-900">{it.pct}%</span> ·{" "}
                {it.count.toLocaleString("es-PE")}
              </span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className={cn("h-full rounded-full", REASON_BAR[it.bucket] ?? "bg-slate-400")}
                style={{ width: `${Math.round((it.count / max) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <p className="border-t border-slate-100 pt-2 text-xs text-slate-500">
        Total oportunidades perdidas:{" "}
        <span className="font-semibold text-slate-800">{total.toLocaleString("es-PE")}</span>
      </p>
    </div>
  );
}

export function LostRevenueCards({
  items,
  total,
  currency,
}: {
  items: LostRevenue[];
  total: number;
  currency: string;
}) {
  if (!items.length) {
    return <p className="text-sm text-slate-400">Sin pérdidas estimadas en el rango.</p>;
  }
  return (
    <div className="space-y-2.5">
      {items.map((it) => (
        <div
          key={it.bucket}
          className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-700">{it.label}</p>
            <p className="text-xs text-slate-400">
              {it.lostCount.toLocaleString("es-PE")} personas
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-sm font-semibold text-red-600">
              {formatCurrency(it.estRevenue, currency)}
            </p>
            <p className="text-[11px] text-slate-400">potencial perdido</p>
          </div>
        </div>
      ))}
      <div className="flex items-center justify-between border-t border-slate-100 pt-2 text-sm">
        <span className="font-medium text-slate-600">Total potencial perdido</span>
        <span className="font-semibold text-red-600">{formatCurrency(total, currency)}</span>
      </div>
    </div>
  );
}
