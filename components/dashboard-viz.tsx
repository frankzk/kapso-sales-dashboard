// Los gráficos de bolsillo de las celdas de Consolidado: cada celda lleva su
// cifra y uno de estos, que dice la forma del dato sin ejes (la tabla y el
// gráfico completo están en el panel que abre la celda). Sin estado: se dibujan
// en el servidor. Van DENTRO del botón de la celda, así que solo usan elementos
// en línea (`span`, `svg`): un `div` o una lista no caben en un botón.
// Marcas finas, 2 px de aire entre segmentos y extremos redondeados.

import { cn } from "@/components/ui";
import { VIZ } from "@/components/palette";

/**
 * Una columna por día (o por hora); la resaltada —por defecto la última, el día
 * más reciente— en el color de la serie y el resto en tinta clara.
 */
export function ColumnsGlyph({
  values,
  label,
  highlight,
  className,
}: {
  values: number[];
  label: string;
  highlight?: number;
  className?: string;
}) {
  if (!values.length) return null;
  const mark = highlight ?? values.length - 1;
  const max = Math.max(1, ...values);
  const W = 100;
  const H = 36;
  const gap = values.length > 40 ? 0.6 : values.length > 20 ? 1 : 2;
  const bw = Math.max(0.8, (W - gap * (values.length - 1)) / values.length);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={cn("block h-9 w-full", className)}>
      {values.map((v, i) => {
        const h = v > 0 ? Math.max(1.5, (v / max) * H) : 0.75;
        return (
          <rect
            key={i}
            x={i * (bw + gap)}
            y={H - h}
            width={bw}
            height={h}
            rx={Math.min(1, bw / 3)}
            fill={v > 0 ? (i === mark ? VIZ.brand : VIZ.ink300) : VIZ.line}
          />
        );
      })}
    </svg>
  );
}

/** Una línea con su lavado (al 10 %), para una serie continua como la conversión por día. */
export function LineGlyph({ values, label, className }: { values: number[]; label: string; className?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(...values) || 1;
  const W = 100;
  const H = 36;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, H - 2 - (v / max) * (H - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={cn("block h-9 w-full", className)}>
      <path d={`${line} L${W} ${H} L0 ${H} Z`} fill={VIZ.brand} fillOpacity={0.1} />
      <path d={line} fill="none" stroke={VIZ.brand} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export interface StackPart {
  label: string;
  value: number;
  color: string;
}

/**
 * Una barra partida por proporción, con 2 px de aire entre partes y la
 * leyenda debajo (etiqueta y porcentaje en tinta; el color va en la marca).
 */
export function StackGlyph({ parts, legend = true, className }: { parts: StackPart[]; legend?: boolean; className?: string }) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  if (total <= 0) return <span className={cn("block h-2 rounded-full bg-line", className)} />;
  const shown = parts.filter((p) => p.value > 0);
  const pct = (v: number) => Math.round((v / total) * 100);
  return (
    <span className={cn("block", className)}>
      <span
        role="img"
        aria-label={shown.map((p) => `${p.label} ${pct(p.value)} %`).join(", ")}
        className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full"
      >
        {shown.map((p) => (
          <span key={p.label} className="h-full first:rounded-l-full last:rounded-r-full" style={{ flex: `${p.value} 0 0`, background: p.color }} />
        ))}
      </span>
      {legend && (
        <span aria-hidden className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs leading-4 text-ink-600">
          {shown.slice(0, 4).map((p) => (
            <span key={p.label} className="inline-flex min-w-0 items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-[2px]" style={{ background: p.color }} />
              <span className="truncate">{p.label}</span>
              <span className="tabular-nums text-ink-900">{pct(p.value)}&nbsp;%</span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

export interface BarRow {
  label: string;
  value: number;
  display: string;
}

/** Las primeras filas de una lista con su barra: «Pulsera de cuarzo rosa · 38 u». */
export function BarsGlyph({ rows, max: forcedMax, className }: { rows: BarRow[]; max?: number; className?: string }) {
  if (!rows.length) return null;
  const max = forcedMax ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <span className={cn("flex flex-col gap-1.5", className)}>
      {rows.map((r, i) => (
        <span key={`${r.label}-${i}`} className="block min-w-0">
          <span className="flex items-baseline justify-between gap-3 text-xs leading-4">
            <span className="truncate text-ink-600">{r.label}</span>
            <span className="shrink-0 tabular-nums text-ink-900">{r.display}</span>
          </span>
          <span className="mt-1 block h-1 rounded-full bg-line">
            <span className="block h-full rounded-full bg-ink-500" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
          </span>
        </span>
      ))}
    </span>
  );
}

/** El embudo de bolsillo: una barra por etapa, de la más ancha a la más angosta. */
export function FunnelGlyph({ values, label, className }: { values: number[]; label: string; className?: string }) {
  if (!values.length) return null;
  const top = Math.max(1, values[0] ?? 1);
  return (
    <span role="img" aria-label={label} className={cn("flex flex-col gap-1", className)}>
      {values.map((v, i) => (
        <span
          key={i}
          className={cn("block h-1 rounded-full", i === values.length - 1 ? "bg-brand-500" : "bg-ink-300")}
          style={{ width: `${Math.max(2, (v / top) * 100)}%` }}
        />
      ))}
    </span>
  );
}

export type DotTone = "ok" | "warn" | "crit" | "none";

const DOT: Record<DotTone, string> = {
  ok: "bg-ok-fg",
  warn: "bg-warn-fg",
  crit: "bg-crit-fg",
  none: "bg-ink-300",
};

/** Una fila de estados con su punto y su nombre (nunca el color solo). */
export function DotsGlyph({ items, className }: { items: { label: string; tone: DotTone }[]; className?: string }) {
  if (!items.length) return null;
  return (
    <span className={cn("flex flex-wrap gap-x-3 gap-y-1 text-xs leading-4 text-ink-600", className)}>
      {items.map((it) => (
        <span key={it.label} className="inline-flex min-w-0 items-center gap-1.5">
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[it.tone])} />
          <span className="truncate">{it.label}</span>
        </span>
      ))}
    </span>
  );
}
