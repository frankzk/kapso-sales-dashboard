import Link from "next/link";
import { Card, Section, StatCard, cn } from "@/components/ui";
import { ProductivityTable } from "@/components/productivity-table";
import type { DateRange } from "@/lib/access";
import type { StoreSummary } from "@/lib/types";
import type { AdvisorStatWithDelta, ProductivityTotals } from "@/lib/productivity";

type SourceFilter = "meta_ad" | "cod_cart" | "abandoned_browse" | "organic" | null;

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
