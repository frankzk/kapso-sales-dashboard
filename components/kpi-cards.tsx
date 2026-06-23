import type { ReactNode } from "react";
import { Card, DeltaBadge, cn } from "@/components/ui";
import { ACCENT_CHIP, type AccentColor } from "@/components/palette";

/**
 * Premium hero KPI card: colored icon chip + label + big value + a delta line.
 * `delta === undefined` hides the badge entirely (for metrics without a base).
 */
export function KpiCard({
  label,
  value,
  icon,
  accent,
  delta,
  deltaLabel = "vs. periodo previo",
  sub,
  muted,
}: {
  label: string;
  value: string;
  icon: ReactNode;
  accent: AccentColor;
  delta?: number | null;
  deltaLabel?: string;
  sub?: string;
  muted?: boolean;
}) {
  return (
    <Card className="flex items-start gap-4">
      <div
        className={cn(
          "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl",
          ACCENT_CHIP[accent],
        )}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        <p
          className={cn(
            "mt-0.5 text-3xl font-semibold tracking-tight",
            muted ? "text-slate-300" : "text-slate-900",
          )}
        >
          {value}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          {delta !== undefined && !muted && (
            <>
              <span className="text-slate-400">{deltaLabel}</span>
              <DeltaBadge pct={delta ?? null} />
            </>
          )}
          {sub && <span className="text-slate-400">{sub}</span>}
        </div>
      </div>
    </Card>
  );
}
