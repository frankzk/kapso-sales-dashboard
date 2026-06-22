"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

interface StoreOpt {
  id: string;
  name: string;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function rangeForDays(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { from: isoDate(from), to: isoDate(to) };
}

/**
 * Store selector + date range. Navigates by writing ?from&to and switching
 * between /dashboard (consolidated) and /dashboard/[storeId].
 */
export function DashboardControls({
  stores,
  scope,
  from,
  to,
}: {
  stores: StoreOpt[];
  scope: "all" | string;
  from: string;
  to: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function go(nextScope: string, nextFrom: string, nextTo: string) {
    const base = nextScope === "all" ? "/dashboard" : `/dashboard/${nextScope}`;
    const qs = new URLSearchParams({ from: nextFrom, to: nextTo }).toString();
    startTransition(() => router.push(`${base}?${qs}`));
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={scope}
        onChange={(e) => go(e.target.value, from, to)}
        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 outline-none focus:border-brand-500"
      >
        <option value="all">Todas las tiendas</option>
        {stores.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>

      <div className="flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm">
        <input
          type="date"
          value={from}
          max={to}
          onChange={(e) => go(scope, e.target.value, to)}
          className="bg-transparent text-slate-700 outline-none"
        />
        <span className="text-slate-400">→</span>
        <input
          type="date"
          value={to}
          min={from}
          onChange={(e) => go(scope, from, e.target.value)}
          className="bg-transparent text-slate-700 outline-none"
        />
      </div>

      <div className="flex gap-1">
        {[7, 30, 90].map((d) => (
          <button
            key={d}
            onClick={() => {
              const r = rangeForDays(d);
              go(scope, r.from, r.to);
            }}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
          >
            {d}d
          </button>
        ))}
      </div>

      {pending && <span className="text-xs text-slate-400">actualizando…</span>}
    </div>
  );
}
