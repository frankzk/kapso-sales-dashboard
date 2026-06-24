"use client";

import { useMemo, useState } from "react";
import type { CampaignStat } from "@/lib/metrics";
import { formatCurrency, formatPct } from "@/lib/metrics";
import {
  adObjectiveLabel,
  adStatusLabel,
  adsManagerUrl,
  prettyAdName,
} from "@/lib/meta-ads";
import { cn } from "@/components/ui";

type SortKey = "label" | "leads" | "pedidos" | "conversion" | "ingresos";

const COLUMNS: { key: SortKey; header: string; align: "left" | "right"; numeric: boolean }[] = [
  { key: "label", header: "Campaña / anuncio", align: "left", numeric: false },
  { key: "leads", header: "Leads", align: "right", numeric: true },
  { key: "pedidos", header: "Pedidos", align: "right", numeric: true },
  { key: "conversion", header: "Conversión", align: "right", numeric: true },
  { key: "ingresos", header: "Ingresos", align: "right", numeric: true },
];

/** The campaign / ad name cell — real Meta ad name (linked to Ads Manager) with
 *  the campaign · objetivo · estado context line, or the headline fallback. */
function LabelCell({ r }: { r: CampaignStat }) {
  const href = adsManagerUrl(r.meta?.accountId ?? null, r.adId);
  const name = prettyAdName(r.label);
  const st = adStatusLabel(r.meta?.status ?? null);
  const ctx = [r.meta?.campaignName, adObjectiveLabel(r.meta?.objective ?? null)]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex min-w-0 flex-col">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate font-medium text-brand-700 hover:underline"
          title="Abrir el anuncio en Meta Ads Manager"
        >
          📣 {name}
        </a>
      ) : (
        <span className="truncate font-medium text-slate-800">📣 {name}</span>
      )}
      {r.resolved && (ctx || st) && (
        <span className="truncate text-xs text-slate-400">
          {ctx}
          {st && (
            <span
              className={cn(
                ctx ? "ml-1" : "",
                st.tone === "green"
                  ? "text-emerald-600"
                  : st.tone === "amber"
                    ? "text-amber-600"
                    : "text-slate-400",
              )}
            >
              {ctx ? "· " : ""}
              {st.label}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * Campaign performance table with click-to-sort headers. Client-side so sorting
 * is instant (no navigation/refetch). Rows arrive pre-resolved (CampaignStat),
 * so no functions cross the server→client boundary. Default order = ingresos
 * desc, matching campaignBreakdown(); clicking a header re-sorts by that column.
 */
export function CampaignTable({ rows, currency }: { rows: CampaignStat[]; currency: string }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "ingresos",
    dir: "desc",
  });

  function onSort(key: SortKey, numeric: boolean) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: numeric ? "desc" : "asc" }, // numbers high→low, text A→Z by default
    );
  }

  const sorted = useMemo(() => {
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const d =
        sort.key === "label"
          ? prettyAdName(a.label).localeCompare(prettyAdName(b.label), "es", { sensitivity: "base" })
          : (a[sort.key] as number) - (b[sort.key] as number);
      if (d !== 0) return d * factor;
      return b.ingresos - a.ingresos || b.leads - a.leads; // stable tiebreak (dir-independent)
    });
  }, [rows, sort]);

  if (!rows.length) return <p className="text-sm text-slate-400">Sin campañas atribuidas todavía.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs text-slate-500">
            {COLUMNS.map((c) => {
              const active = sort.key === c.key;
              return (
                <th
                  key={c.key}
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  className={cn("py-2 font-medium", c.align === "right" ? "text-right" : "text-left")}
                >
                  <button
                    type="button"
                    onClick={() => onSort(c.key, c.numeric)}
                    title={`Ordenar por ${c.header}`}
                    className={cn(
                      "inline-flex select-none items-center gap-1 hover:text-slate-700",
                      c.align === "right" ? "flex-row-reverse" : "",
                      active && "text-slate-700",
                    )}
                  >
                    {c.header}
                    <span className={cn("text-[10px]", active ? "text-slate-500" : "text-slate-300")}>
                      {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.adId} className="border-b border-slate-100 last:border-0">
              <td className="py-2.5 text-left text-slate-700">
                <LabelCell r={r} />
              </td>
              <td className="py-2.5 text-right text-slate-700">{r.leads}</td>
              <td className="py-2.5 text-right text-slate-700">{r.pedidos}</td>
              <td className="py-2.5 text-right text-slate-700">{formatPct(r.conversion)}</td>
              <td className="py-2.5 text-right">
                <span className="font-semibold text-emerald-700">
                  {formatCurrency(r.ingresos, currency)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
