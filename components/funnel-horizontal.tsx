import { cn } from "@/components/ui";
import { ACCENT_BAR, ACCENT_CHIP, type AccentColor } from "@/components/palette";
import type { FunnelStage } from "@/lib/metrics";

const STAGE_ACCENTS: AccentColor[] = ["green", "teal", "blue", "purple", "orange", "amber"];

/**
 * Horizontal-bar funnel (not the classic triangle). Each stage shows a numbered
 * chip, its volume + share of stage 1, and a bar; the step-conversion vs. the
 * previous stage sits in the connector below.
 */
export function HorizontalFunnel({ stages }: { stages: FunnelStage[] }) {
  const top = stages[0]?.value || 1;
  return (
    <div>
      <div className="space-y-1">
        {stages.map((s, i) => {
          const accent = STAGE_ACCENTS[i % STAGE_ACCENTS.length]!;
          const pctTotal = Math.round((s.value / top) * 100);
          const width = Math.max(4, Math.min(100, pctTotal));
          const next = stages[i + 1];
          return (
            <div key={s.key}>
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-semibold",
                    ACCENT_CHIP[accent],
                  )}
                >
                  {i + 1}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium text-slate-700">{s.label}</span>
                    <span className="shrink-0 text-sm font-semibold text-slate-900">
                      {s.value.toLocaleString("es-PE")}
                      <span className="ml-1 text-xs font-normal text-slate-400">{pctTotal}%</span>
                    </span>
                  </div>
                  <div className="mt-1 h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={cn("h-full rounded-full", ACCENT_BAR[accent])}
                      style={{ width: `${width}%` }}
                    />
                  </div>
                </div>
              </div>
              {next && (
                <div className="flex justify-center py-0.5 pl-10">
                  <span className="text-[11px] font-medium text-slate-400">
                    ↓ {next.stepPct != null ? `${Math.round(next.stepPct * 100)}%` : "—"}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-100 pt-3 text-[11px] text-slate-400">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> Conversión etapa anterior
        </span>
        <span>% del total de mensajes</span>
      </div>
    </div>
  );
}
