import { cn } from "@/components/ui";
import type { FunnelStage } from "@/lib/metrics";

/**
 * El embudo conversacional en barras horizontales: cada etapa con su volumen,
 * su parte del total de la primera y una barra; entre etapas, cuántos pasan a
 * la siguiente. Una sola tinta para las barras (son la misma medida) y la
 * última etapa —la venta— en el azul de la serie.
 */
export function HorizontalFunnel({ stages }: { stages: FunnelStage[] }) {
  const top = stages[0]?.value || 1;
  if (!stages.length) return <p className="text-sm text-ink-500">Sin conversaciones en el periodo.</p>;
  return (
    <div>
      <ol className="flex flex-col">
        {stages.map((s, i) => {
          const pctTotal = Math.round((s.value / top) * 100);
          const width = Math.max(2, Math.min(100, (s.value / top) * 100));
          const next = stages[i + 1];
          const last = i === stages.length - 1;
          return (
            <li key={s.key}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="w-4 shrink-0 text-xs tabular-nums text-ink-500">{i + 1}</span>
                  <span className="truncate text-sm font-medium text-ink-900">{s.label}</span>
                </span>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-ink-900">
                  {s.value.toLocaleString("es-PE")}
                  <span className="ml-1.5 text-xs font-normal text-ink-500">{pctTotal}&nbsp;%</span>
                </span>
              </div>
              <div className="ml-6 mt-1.5 h-2 rounded-full bg-line">
                <div className={cn("h-full rounded-full", last ? "bg-brand-500" : "bg-ink-500")} style={{ width: `${width}%` }} />
              </div>
              {next && (
                <p className="ml-6 py-1.5 text-xs tabular-nums text-ink-500">
                  {next.stepPct != null ? `${Math.round(next.stepPct * 100)}\u00a0% pasa a la siguiente` : "—"}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      <p className="mt-4 border-t border-line pt-3 text-xs leading-4 text-ink-500">
        El % de la derecha es sobre la primera etapa; entre etapas, la parte que llega a la siguiente.
      </p>
    </div>
  );
}
