// El marco de cifras del mundo de operación (DESIGN.md › Productividad): celdas
// blancas sobre hairlines `line`, la etiqueta en 13 px, la cifra en el paso
// Figure y el cambio contra el periodo anterior al lado. Lo comparten
// Productividad y Consolidado para que la misma cifra se lea igual en las dos.

import type { ReactNode } from "react";
import { cn } from "@/components/ui";

const nf1 = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 1 });

/** «4.2 %»: la tasa con un decimal como mucho y espacio duro antes del signo. */
export function pctText(ratio: number, digits = 1): string {
  return `${(ratio * 100).toLocaleString("es-PE", { maximumFractionDigits: digits })}\u00a0%`;
}

/** El marco: una rejilla con 1 px de `line` entre celdas. Las columnas las pone quien lo usa. */
export const FIGURE_FRAME = "grid gap-px overflow-hidden rounded-lg bg-line shadow-control ring-1 ring-line";

export function Figure({
  label,
  value,
  delta,
  sub,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  delta?: ReactNode;
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col bg-white px-4 py-3", className)}>
      <dt className="text-[13px] font-medium leading-5 text-ink-600">{label}</dt>
      <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
        <span className="text-xl font-semibold leading-7 tabular-nums text-ink-900">{value}</span>
        {delta}
      </dd>
      {sub && <dd className="mt-0.5 text-pretty text-xs leading-4 text-ink-500">{sub}</dd>}
    </div>
  );
}

/**
 * El cambio contra el periodo anterior, en su tono: sube en verde, baja en rojo.
 * `pts` es para tasas («+0.4 pts»): el cambio relativo de un 4 % que pasa a 5 %
 * diría «+25 %», que no es lo que pasó.
 */
export function Change({ pct, unit = "pct" }: { pct: number | null; unit?: "pct" | "pts" }) {
  if (pct === null) return <span className="text-xs font-medium text-ink-500">sin base</span>;
  const tone = pct > 0 ? "text-ok-fg" : pct < 0 ? "text-crit-fg" : "text-ink-500";
  return (
    <span className={cn("text-[13px] font-semibold tabular-nums", tone)} title="Contra el periodo anterior">
      {pct > 0 ? "+" : pct < 0 ? "−" : ""}
      {nf1.format(Math.abs(pct))}
      {unit === "pct" ? "\u00a0%" : "\u00a0pts"}
    </span>
  );
}
