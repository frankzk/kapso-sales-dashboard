import Link from "next/link";
import { Card, Section, SimpleTable, StatCard, cn, type Column } from "@/components/ui";
import type { DateRange } from "@/lib/access";
import type { StoreSummary } from "@/lib/types";
import type { AdvisorStat } from "@/lib/productivity";

function money(n: number, currency: string): string {
  return new Intl.NumberFormat("es-PE", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Show the name part of the email (before @) as a friendlier label. */
function advisorName(email: string): string {
  return email.includes("@") ? email.split("@")[0]! : email;
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
  range,
  currency,
  stores,
  storeId,
  source,
}: {
  rows: AdvisorStat[];
  range: DateRange;
  currency: string;
  stores: StoreSummary[];
  storeId: string | null;
  source: string | null;
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

  const columns: Column<AdvisorStat>[] = [
    {
      key: "email",
      header: "Asesora",
      align: "left",
      render: (r) => <span className="font-medium text-slate-800">{advisorName(r.email)}</span>,
    },
    { key: "llamadas", header: "Llamadas", align: "right", render: (r) => r.llamadas },
    { key: "leads", header: "Leads", align: "right", render: (r) => r.leadsTrabajados },
    { key: "cerrados", header: "Cerrados", align: "right", render: (r) => r.cerrados },
    { key: "conv", header: "% cierre", align: "right", render: (r) => pct(r.conversion) },
    {
      key: "ingresos",
      header: "Ingresos",
      align: "right",
      render: (r) => <span className="font-semibold text-emerald-700">{money(r.ingresos, currency)}</span>,
    },
  ];

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
          href={buildHref({ from: range.from, to: range.to, store: storeId, src: "organic" })}
          label="Orgánico"
          active={source === "organic"}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Llamadas" value={String(totals.llamadas)} />
        <StatCard label="Leads trabajados" value={String(totals.leads)} />
        <StatCard label="Pedidos cerrados" value={String(totals.cerrados)} />
        <StatCard label="Ingresos atribuidos" value={money(totals.ingresos, currency)} />
      </div>

      <Section
        title="Desempeño por asesora"
        subtitle="El pedido se acredita a la última asesora que registró una llamada sobre ese lead en el período."
      >
        <Card>
          <SimpleTable columns={columns} rows={rows} empty="Sin actividad de asesoras en este período." />
        </Card>
      </Section>
    </div>
  );
}
