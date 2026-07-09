import Link from "next/link";
import { Card, Section, StatCard, cn } from "@/components/ui";
import { ProductivityTable } from "@/components/productivity-table";
import type { DateRange } from "@/lib/access";
import type { StoreSummary } from "@/lib/types";
import type { AdvisorStatWithDelta, ProductivityTotals, SourceBucket, SourceCell } from "@/lib/productivity";

type SourceFilter = SourceBucket | null;

/** Columns of the advisor×source matrix, in display order (same labels as the
 *  "Fuente" filter chips). */
const SOURCE_COLS: { key: SourceBucket; label: string }[] = [
  { key: "meta_ad", label: "📣 Campaña" },
  { key: "fb_web", label: "🌐 FB/Web" },
  { key: "cod_cart", label: "🛒 Carrito" },
  { key: "abandoned_browse", label: "🔎 Búsqueda" },
  { key: "organic", label: "Orgánico" },
];

function money(n: number, currency: string): string {
  return new Intl.NumberFormat("es-PE", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
}

/** Signed % change current vs previous; null when there's no base (prev = 0). */
function pctDelta(cur: number, prev: number): number | null {
  if (prev === 0) return cur === 0 ? 0 : null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("es-PE", { day: "2-digit", month: "short", timeZone: "UTC" });
}

function buildHref(opts: { from: string; to: string; store: string | null; src: string | null }): string {
  const qs = new URLSearchParams({ from: opts.from, to: opts.to });
  if (opts.store) qs.set("store", opts.store);
  if (opts.src) qs.set("src", opts.src);
  return `/dashboard/productividad?${qs.toString()}`;
}

function presetRange(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/** A single-day range `offset` days ago (0 = hoy, 1 = ayer). */
function dayPreset(offset: number): { from: string; to: string } {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offset);
  const s = d.toISOString().slice(0, 10);
  return { from: s, to: s };
}

function Chip({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        "rounded-lg border px-3 py-1.5 text-sm",
        active
          ? "border-brand-500 bg-brand-50 text-brand-700"
          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
      )}
    >
      {label}
    </Link>
  );
}

export function ProductivityBoard({
  rows,
  prevTotals,
  prevRange,
  hasPrev,
  range,
  currency,
  stores,
  storeId,
  source,
}: {
  rows: AdvisorStatWithDelta[];
  prevTotals: ProductivityTotals;
  prevRange: DateRange;
  hasPrev: boolean;
  range: DateRange;
  currency: string;
  stores: StoreSummary[];
  storeId: string | null;
  source: SourceFilter;
}) {
  const totals = rows.reduce(
    (a, r) => ({
      llamadas: a.llamadas + r.llamadas,
      leads: a.leads + r.leadsTrabajados,
      cerrados: a.cerrados + r.cerrados,
      ingresos: a.ingresos + r.ingresos,
    }),
    { llamadas: 0, leads: 0, cerrados: 0, ingresos: 0 },
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Productividad por asesora</h1>
          <p className="text-sm text-slate-500">
            {range.from} → {range.to}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {[
            { label: "Hoy", p: dayPreset(0) },
            { label: "Ayer", p: dayPreset(1) },
          ].map(({ label, p }) => (
            <Chip
              key={label}
              href={buildHref({ from: p.from, to: p.to, store: storeId, src: source })}
              label={label}
              active={range.from === p.from && range.to === p.to}
            />
          ))}
          {[7, 30, 90].map((d) => {
            const p = presetRange(d);
            return (
              <Chip
                key={d}
                href={buildHref({ from: p.from, to: p.to, store: storeId, src: source })}
                label={`${d}d`}
                active={range.from === p.from && range.to === p.to}
              />
            );
          })}
        </div>
      </div>

      {stores.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          <Chip
            href={buildHref({ from: range.from, to: range.to, store: null, src: source })}
            label="Todas"
            active={!storeId}
          />
          {stores.map((s) => (
            <Chip
              key={s.id}
              href={buildHref({ from: range.from, to: range.to, store: s.id, src: source })}
              label={s.name}
              active={storeId === s.id}
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium text-slate-400">Fuente:</span>
        <Chip
          href={buildHref({ from: range.from, to: range.to, store: storeId, src: null })}
          label="Todas"
          active={!source}
        />
        <Chip
          href={buildHref({ from: range.from, to: range.to, store: storeId, src: "meta_ad" })}
          label="📣 Campaña"
          active={source === "meta_ad"}
        />
        <Chip
          href={buildHref({ from: range.from, to: range.to, store: storeId, src: "fb_web" })}
          label="🌐 FB/Web"
          active={source === "fb_web"}
        />
        <Chip
          href={buildHref({ from: range.from, to: range.to, store: storeId, src: "cod_cart" })}
          label="🛒 Carrito"
          active={source === "cod_cart"}
        />
        <Chip
          href={buildHref({ from: range.from, to: range.to, store: storeId, src: "abandoned_browse" })}
          label="🔎 Búsqueda"
          active={source === "abandoned_browse"}
        />
        <Chip
          href={buildHref({ from: range.from, to: range.to, store: storeId, src: "organic" })}
          label="Orgánico"
          active={source === "organic"}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Llamadas"
          value={String(totals.llamadas)}
          delta={hasPrev ? pctDelta(totals.llamadas, prevTotals.llamadas) : undefined}
        />
        <StatCard
          label="Leads trabajados"
          value={String(totals.leads)}
          delta={hasPrev ? pctDelta(totals.leads, prevTotals.leadsTrabajados) : undefined}
        />
        <StatCard
          label="Pedidos cerrados"
          value={String(totals.cerrados)}
          delta={hasPrev ? pctDelta(totals.cerrados, prevTotals.cerrados) : undefined}
        />
        <StatCard
          label="Ingresos atribuidos"
          value={money(totals.ingresos, currency)}
          delta={hasPrev ? pctDelta(totals.ingresos, prevTotals.ingresos) : undefined}
        />
      </div>

      <Section
        title="Ventas por asesora y fuente"
        subtitle="Pedidos cerrados (y sus ingresos) de cada asesora, desglosados por cómo llegó el lead. El pedido se acredita a la última asesora que registró una llamada sobre ese lead."
      >
        <Card>
          <SourceMatrix rows={rows} currency={currency} />
        </Card>
      </Section>

      <Section
        title="Desempeño por asesora"
        subtitle={
          hasPrev
            ? `El pedido se acredita a la última asesora que registró una llamada sobre ese lead. Flechas = cambio vs el período anterior (${shortDate(prevRange.from)} → ${shortDate(prevRange.to)}).`
            : "El pedido se acredita a la última asesora que registró una llamada sobre ese lead en el período. Las horas se estiman a partir de la actividad registrada."
        }
      >
        <Card>
          <ProductivityTable
            rows={rows}
            currency={currency}
            hasPrev={hasPrev}
            ctx={{ from: range.from, to: range.to, store: storeId, source }}
          />
        </Card>
      </Section>
    </div>
  );
}

/** Show the name part of the email (before @) as a friendlier label. */
function advisorName(email: string): string {
  return email.includes("@") ? email.split("@")[0]! : email;
}

/** One matrix cell: closed-order count (bold) + its net revenue (muted). Renders
 *  a dash when the advisor closed nothing from that source. */
function MatrixCell({ cell, currency, strong }: { cell: SourceCell; currency: string; strong?: boolean }) {
  if (cell.cerrados === 0) {
    return <td className="px-3 py-2 text-right align-top text-slate-300">—</td>;
  }
  return (
    <td className="px-3 py-2 text-right align-top">
      <div className={cn("tabular-nums", strong ? "font-semibold text-slate-900" : "font-medium text-slate-700")}>
        {cell.cerrados}
      </div>
      <div className="text-xs tabular-nums text-slate-400">{money(cell.ingresos, currency)}</div>
    </td>
  );
}

/** Advisor × acquisition-source matrix: each advisor's closed orders (and their
 *  revenue) split across the four sources, with per-source and grand totals.
 *  Advisors with no closes in the period are omitted (an all-dashes row is noise). */
function SourceMatrix({ rows, currency }: { rows: AdvisorStatWithDelta[]; currency: string }) {
  const advisors = rows.filter((r) => r.cerrados > 0);
  if (!advisors.length) {
    return <p className="px-3 py-6 text-center text-sm text-slate-500">Sin pedidos cerrados en este período.</p>;
  }
  const colTotals = SOURCE_COLS.map(({ key }) =>
    advisors.reduce(
      (a, r) => ({ cerrados: a.cerrados + r.porFuente[key].cerrados, ingresos: a.ingresos + r.porFuente[key].ingresos }),
      { cerrados: 0, ingresos: 0 } as SourceCell,
    ),
  );
  const grand = advisors.reduce(
    (a, r) => ({ cerrados: a.cerrados + r.cerrados, ingresos: a.ingresos + r.ingresos }),
    { cerrados: 0, ingresos: 0 } as SourceCell,
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs font-medium text-slate-400">
            <th className="px-3 py-2 text-left">Asesora</th>
            {SOURCE_COLS.map((c) => (
              <th key={c.key} className="px-3 py-2 text-right whitespace-nowrap">
                {c.label}
              </th>
            ))}
            <th className="px-3 py-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {advisors.map((r) => (
            <tr key={r.userId} className="border-b border-slate-100">
              <td className="px-3 py-2 align-top font-medium text-slate-800">{advisorName(r.email)}</td>
              {SOURCE_COLS.map((c) => (
                <MatrixCell key={c.key} cell={r.porFuente[c.key]} currency={currency} />
              ))}
              <MatrixCell cell={{ cerrados: r.cerrados, ingresos: r.ingresos }} currency={currency} strong />
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-slate-200 text-slate-600">
            <td className="px-3 py-2 text-xs font-medium text-slate-400">Total equipo</td>
            {colTotals.map((t, i) => (
              <MatrixCell key={SOURCE_COLS[i]!.key} cell={t} currency={currency} strong />
            ))}
            <MatrixCell cell={grand} currency={currency} strong />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
