import Link from "next/link";
import { Card, cn } from "@/components/ui";
import type {
  MomOwnerAlert,
  MomOwnerKpiKey,
  MomOwnerSummary,
} from "@/lib/mom-owner-summary";

const KPI_ROWS: Array<{
  key: MomOwnerKpiKey;
  label: string;
  detail: string;
  accent: string;
}> = [
  {
    key: "province_confirmation",
    label: "Confirmación Provincia COD",
    detail: "Pedidos creados que llegaron a confirmación",
    accent: "bg-amber-500",
  },
  {
    key: "agency_advance",
    label: "Adelanto de Agencia",
    detail: "Pedidos Agencia con S/ 30 validados",
    accent: "bg-violet-500",
  },
  {
    key: "aliclik_delivery",
    label: "Entrega Aliclik",
    detail: "Salidas entregadas sobre salidas despachadas",
    accent: "bg-blue-500",
  },
  {
    key: "lima_delivery",
    label: "Entrega Lima total",
    detail: "Pedidos entregados sobre pedidos despachados",
    accent: "bg-emerald-500",
  },
  {
    key: "agency_full_payment",
    label: "Pago completo de Agencia",
    detail: "Pedidos Shalom u Olva pagados por completo",
    accent: "bg-cyan-500",
  },
];

function formatRate(rate: number | null): string {
  if (rate == null) return "Sin datos";
  return new Intl.NumberFormat("es-PE", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(rate);
}

function generatedLabel(value: string): string {
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function AlertLink({ alert }: { alert: MomOwnerAlert }) {
  const clear = alert.count === 0;
  return (
    <Link
      href={alert.href}
      className={cn(
        "group grid min-h-20 grid-cols-[1fr_auto] items-center gap-3 border-l-2 px-4 py-3 transition-colors",
        clear
          ? "border-emerald-400 bg-emerald-50/50 hover:bg-emerald-50"
          : "border-rose-500 bg-rose-50/60 hover:bg-rose-50",
      )}
    >
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-slate-800">{alert.label}</span>
        <span className="mt-0.5 block text-xs leading-4 text-slate-500">{alert.description}</span>
      </span>
      <span
        className={cn(
          "min-w-9 rounded-full px-2 py-1 text-center text-sm font-semibold tabular-nums",
          clear ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700",
        )}
      >
        {alert.count}
      </span>
    </Link>
  );
}

export function MomOwnerSummaryPanel({ summary }: { summary: MomOwnerSummary }) {
  return (
    <Card className="overflow-hidden p-0">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
            Master Operations Map
          </p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">
            Resumen operativo del owner
          </h2>
          <p className="mt-0.5 text-sm text-slate-500">
            Cierre, entregas y excepciones · actualizado {generatedLabel(summary.generatedAt)}
          </p>
        </div>
        <Link
          href="/dashboard/pedidos"
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50"
        >
          Abrir Master de Pedidos →
        </Link>
      </header>

      <section aria-labelledby="mom-alerts-title" className="border-b border-slate-200">
        <div className="px-5 pb-2 pt-4">
          <h3 id="mom-alerts-title" className="text-sm font-semibold text-slate-800">
            Excepciones que requieren acción
          </h3>
          <p className="text-xs text-slate-500">Cada bloque abre la cola operativa correspondiente.</p>
        </div>
        <div className="grid divide-y divide-slate-200 border-t border-slate-200 md:grid-cols-2 md:divide-x md:divide-y-0 xl:grid-cols-4">
          {summary.alerts.map((alert) => (
            <AlertLink key={alert.key} alert={alert} />
          ))}
        </div>
      </section>

      <section aria-labelledby="mom-kpis-title" className="px-5 py-4">
        <div className="mb-3">
          <h3 id="mom-kpis-title" className="text-sm font-semibold text-slate-800">
            Indicadores operativos
          </h3>
          <p className="text-xs text-slate-500">
            El porcentaje siempre conserva su numerador y denominador.
          </p>
        </div>
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead className="bg-slate-50 text-xs font-medium text-slate-500">
              <tr>
                <th scope="col" className="w-[31%] px-4 py-2.5">Indicador</th>
                {summary.periods.map((period) => (
                  <th key={period.key} scope="col" className="px-4 py-2.5">
                    {period.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white">
              {KPI_ROWS.map((row) => (
                <tr key={row.key} className="hover:bg-slate-50/70">
                  <th scope="row" className="px-4 py-3 font-normal">
                    <span className="flex items-start gap-2.5">
                      <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", row.accent)} />
                      <span>
                        <span className="block text-sm font-semibold text-slate-800">{row.label}</span>
                        <span className="mt-0.5 block text-xs text-slate-500">{row.detail}</span>
                      </span>
                    </span>
                  </th>
                  {summary.periods.map((period) => {
                    const value = period.kpis[row.key];
                    return (
                      <td key={period.key} className="px-4 py-3 align-top">
                        <span
                          className={cn(
                            "block text-sm font-semibold tabular-nums",
                            value.rate == null ? "text-slate-400" : "text-slate-900",
                          )}
                        >
                          {formatRate(value.rate)}
                        </span>
                        <span className="mt-0.5 block text-xs tabular-nums text-slate-500">
                          {value.numerator} de {value.denominator}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </Card>
  );
}

export function MomOwnerSummarySkeleton() {
  return (
    <Card className="overflow-hidden p-0" aria-label="Cargando resumen operativo">
      <div className="animate-pulse">
        <div className="border-b border-slate-200 px-5 py-4">
          <div className="h-3 w-36 rounded bg-slate-200" />
          <div className="mt-3 h-5 w-64 rounded bg-slate-200" />
          <div className="mt-2 h-3 w-48 rounded bg-slate-100" />
        </div>
        <div className="grid gap-px bg-slate-200 md:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="h-20 bg-white px-4 py-3">
              <div className="h-3 w-32 rounded bg-slate-200" />
              <div className="mt-2 h-3 w-full rounded bg-slate-100" />
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
