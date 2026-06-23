import { cn } from "@/components/ui";
import { IconActivity, IconAlert } from "@/components/icons";
import type { HealthStatus, StageHealth } from "@/lib/metrics";

const STATUS_HEX: Record<HealthStatus, string> = {
  green: "#10b981",
  amber: "#f59e0b",
  red: "#ef4444",
};
const STATUS_DOT: Record<HealthStatus, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
};

function polar(cx: number, cy: number, r: number, angleDeg: number): [number, number] {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const [x1, y1] = polar(cx, cy, r, startAngle);
  const [x2, y2] = polar(cx, cy, r, endAngle);
  const large = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

/**
 * Concentric semaphore arcs — one ring per funnel stage, colored by health.
 * Outer ring = first stage, inner ring = last. Legend + critical-point alert
 * below.
 */
export function FunnelHealth({
  stages,
  critical,
}: {
  stages: StageHealth[];
  critical: StageHealth | null;
}) {
  const cx = 100;
  const cy = 78;
  const start = 135;
  const end = 405; // 270° sweep, gap at the bottom
  const r0 = 64;
  const step = 9;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-center">
        <svg viewBox="0 0 200 150" className="h-36 w-full max-w-[240px]">
          {stages.map((s, i) => {
            const r = r0 - i * step;
            return (
              <g key={s.key}>
                <path
                  d={arcPath(cx, cy, r, start, end)}
                  fill="none"
                  stroke="#eef2f7"
                  strokeWidth={6}
                  strokeLinecap="round"
                />
                <path
                  d={arcPath(cx, cy, r, start, end)}
                  fill="none"
                  stroke={STATUS_HEX[s.status]}
                  strokeWidth={6}
                  strokeLinecap="round"
                />
              </g>
            );
          })}
          <g transform={`translate(${cx - 11} ${cy - 11})`} className="text-red-500">
            <IconActivity width={22} height={22} />
          </g>
        </svg>
      </div>

      <ul className="space-y-1.5">
        {stages.map((s) => (
          <li key={s.key} className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-2 text-slate-600">
              <span className={cn("inline-block h-2 w-2 rounded-full", STATUS_DOT[s.status])} />
              {s.label}
            </span>
            <span className="font-medium text-slate-400">
              {s.stepPct != null ? `${Math.round(s.stepPct * 100)}%` : "—"}
            </span>
          </li>
        ))}
      </ul>

      {critical && (
        <div className="flex gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5">
          <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
          <div>
            <p className="text-xs font-semibold text-red-700">Punto crítico</p>
            <p className="text-xs text-red-700">{critical.label}</p>
            <p className="mt-0.5 text-[11px] text-red-600/80">
              Revisa seguimiento, tiempos de contacto o logística.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
