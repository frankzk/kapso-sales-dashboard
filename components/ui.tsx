import type { ReactNode } from "react";

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-2xl border border-slate-200 bg-white p-5 shadow-sm", className)}>
      {children}
    </div>
  );
}

export function Section({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-wide text-slate-700 uppercase">{title}</h2>
          {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function DeltaBadge({ pct }: { pct: number | null }) {
  if (pct === null) {
    return <span className="text-xs font-medium text-slate-400">— sin base</span>;
  }
  const up = pct > 0;
  const flat = pct === 0;
  return (
    <span
      className={cn(
        "text-xs font-semibold",
        flat ? "text-slate-400" : up ? "text-emerald-600" : "text-red-600",
      )}
    >
      {up ? "▲" : flat ? "■" : "▼"} {up ? "+" : ""}
      {pct}%
    </span>
  );
}

export function StatCard({
  label,
  value,
  sub,
  delta,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: number | null;
}) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900">{value}</p>
      <div className="mt-1 flex items-center gap-2">
        {delta !== undefined && <DeltaBadge pct={delta} />}
        {sub && <span className="text-xs text-slate-400">{sub}</span>}
      </div>
    </Card>
  );
}

export interface BarItem {
  label: string;
  value: number;
  valueLabel?: string;
  sublabel?: string;
}

export function BarList({ items, empty = "Sin datos" }: { items: BarItem[]; empty?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <p className="text-sm text-slate-400">{empty}</p>;
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-baseline justify-between text-sm">
            <span className="truncate text-slate-700">{it.label}</span>
            <span className="ml-2 shrink-0 font-medium text-slate-900">
              {it.valueLabel ?? it.value}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-brand-500"
              style={{ width: `${Math.round((it.value / max) * 100)}%` }}
            />
          </div>
          {it.sublabel && <p className="text-xs text-slate-400">{it.sublabel}</p>}
        </div>
      ))}
    </div>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  align?: "left" | "right";
  render: (row: T) => ReactNode;
}

export function SimpleTable<T>({
  columns,
  rows,
  empty = "Sin datos",
}: {
  columns: Column<T>[];
  rows: T[];
  empty?: string;
}) {
  if (!rows.length) return <p className="text-sm text-slate-400">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs text-slate-500">
            {columns.map((c) => (
              <th
                key={c.key}
                className={cn("py-2 font-medium", c.align === "right" ? "text-right" : "text-left")}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-slate-100 last:border-0">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn("py-2.5 text-slate-700", c.align === "right" ? "text-right" : "text-left")}
                >
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Card className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <p className="text-base font-medium text-slate-700">{title}</p>
      {children && <div className="text-sm text-slate-500">{children}</div>}
    </Card>
  );
}

/** Pulsing placeholder block for `loading.tsx` skeletons. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-slate-200/70", className)} />;
}
