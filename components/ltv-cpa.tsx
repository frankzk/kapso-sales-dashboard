// Consolidado › LTV : CPA (MOM §17, 13-10-2026). La métrica que el dueño
// eligió para saber si el negocio se sostiene, con su escala: menos de 3 pierde
// caja, de 3 a 3.5 es estable, de 3.5 a 4 gana cuota y más de 4 es dominio.
//
// Arriba, por tienda, lo que se lee primero: cómo vienen las clientas nuevas
// del último mes (sus primeros 30 días) y cuánto les sumó la recompra a las
// más antiguas. Plegado, mes por mes a 30, 60, 90, 180 y 365 días. Las cuentas
// salen de lib/ltv.ts; acá solo se pintan.

import { Card, cn } from "@/components/ui";
import { formatCurrency, formatPct } from "@/lib/metrics";
import {
  DELIVERY_SETTLE_DAYS,
  HORIZONS,
  LTV_ZONES,
  USD_TO_PEN,
  formatRatio,
  monthLabel,
  ratioZone,
  storeHeadline,
  type CohortCell,
  type CohortView,
} from "@/lib/ltv";

const ZONE_CHIP = {
  crit: "bg-red-50 text-red-700 ring-red-200",
  warn: "bg-amber-50 text-amber-800 ring-amber-200",
  ok: "bg-emerald-50 text-emerald-700 ring-emerald-200",
} as const;

const ZONE_TEXT = {
  crit: "text-red-700",
  warn: "text-amber-700",
  ok: "text-emerald-700",
} as const;

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Montos grandes sin céntimos: «S/ 170,551». */
function formatWhole(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("es-PE", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return formatCurrency(amount, currency);
  }
}

interface StoreLite {
  id: string;
  name: string;
  currency: string;
}

function ZoneBadge({ ratio }: { ratio: number }) {
  const zone = ratioZone(ratio);
  return (
    <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ring-inset", ZONE_CHIP[zone.tone])}>
      {zone.label}
    </span>
  );
}

function StoreSummary({ store, views }: { store: StoreLite; views: CohortView[] }) {
  const { latest, current, longest } = storeHeadline(views);
  return (
    <section aria-labelledby={`ltv-${store.id}`} className="px-5 py-4">
      <h3 id={`ltv-${store.id}`} className="text-sm font-semibold text-slate-800">
        {store.name}
      </h3>
      {latest ? (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-3xl font-semibold tabular-nums tracking-tight text-slate-900">{formatRatio(latest.ratio)}</p>
            <ZoneBadge ratio={latest.ratio} />
          </div>
          <p className="mt-1 text-sm text-slate-600">
            Clientas nuevas de {monthLabel(latest.month)}, en sus primeros 30 días · CPA{" "}
            <span className="tabular-nums">{formatCurrency(latest.cpa, store.currency)}</span>
            {latest.state === "provisional" && " · provisional"}
          </p>
          {current && (
            <p className="mt-2 text-sm text-slate-600">
              {capitalized(monthLabel(current.month))} aún no cumple sus 30 días. Su CPA:{" "}
              <span
                className={cn(
                  "font-semibold tabular-nums",
                  current.cpa > latest.cpa * 1.15 ? "text-red-700" : "text-slate-800",
                )}
              >
                {formatCurrency(current.cpa, store.currency)}
              </span>
              {current.cpa > latest.cpa * 1.15 &&
                `, ${formatPct(current.cpa / latest.cpa - 1, 0)} más caro que en ${monthLabel(latest.month).split(" ")[0]}`}
              {current.provisional && " (provisional)"}.
            </p>
          )}
          {longest && (
            <p className="mt-2 text-sm text-slate-600">
              Lo que suma la recompra: las de {monthLabel(longest.month)} pasaron de{" "}
              <span className="tabular-nums">{formatRatio(longest.from30)}</span> a los 30 días a{" "}
              <span className={cn("font-semibold tabular-nums", ZONE_TEXT[ratioZone(longest.ratio).tone])}>
                {formatRatio(longest.ratio)}
              </span>{" "}
              a los {longest.horizon} días.
            </p>
          )}
        </>
      ) : (
        <p className="mt-2 text-sm text-slate-500">Todavía no hay un mes con sus primeros 30 días cumplidos y gasto de Meta.</p>
      )}
    </section>
  );
}

function RatioCell({ cell, currency }: { cell: CohortCell; currency: string }) {
  if (cell.state === "abierto" || cell.ltv == null) {
    return (
      <td className="px-3 py-2.5 text-right text-slate-300">
        —<span className="sr-only"> aún no se cumple</span>
      </td>
    );
  }
  return (
    <td className="px-3 py-2.5 text-right">
      {cell.ratio != null ? (
        <span className={cn("font-semibold tabular-nums", ZONE_TEXT[ratioZone(cell.ratio).tone])}>
          {formatRatio(cell.ratio)}
          {cell.state === "provisional" && <span aria-label=" provisional">*</span>}
        </span>
      ) : (
        <span className="text-slate-400">sin gasto</span>
      )}
      <span className="block text-[11px] tabular-nums text-slate-400">{formatCurrency(cell.ltv, currency)}</span>
    </td>
  );
}

function StoreTable({
  store,
  views,
  horizons,
}: {
  store: StoreLite;
  views: CohortView[];
  horizons: readonly (typeof HORIZONS)[number][];
}) {
  return (
    <div>
      <h4 className="mb-2 text-sm font-semibold text-slate-800">{store.name}</h4>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[760px] border-collapse text-left text-sm">
          <thead className="bg-slate-50 text-xs font-medium text-slate-500">
            <tr>
              <th scope="col" className="px-3 py-2">Mes de la primera compra</th>
              <th scope="col" className="px-3 py-2 text-right">Clientas nuevas</th>
              <th scope="col" className="px-3 py-2 text-right">Gasto Meta</th>
              <th scope="col" className="px-3 py-2 text-right">CPA</th>
              {horizons.map((h) => (
                <th key={h} scope="col" className="px-3 py-2 text-right">
                  {h} días
                </th>
              ))}
              <th scope="col" className="px-3 py-2 text-right">Recompra a 90 días</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {views.map((view) => (
              <tr key={view.month}>
                <th scope="row" className="px-3 py-2.5 font-medium text-slate-800">
                  {capitalized(monthLabel(view.month))}
                </th>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{view.newCustomers.toLocaleString("es-PE")}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                  {view.spend == null ? "—" : formatWhole(view.spend, store.currency)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                  {view.inProgress ? (
                    <span className="text-xs text-slate-400">mes en curso</span>
                  ) : view.cpa == null ? (
                    "—"
                  ) : (
                    <>
                      {formatCurrency(view.cpa, store.currency)}
                      {view.cpaProvisional && <span aria-label=" provisional">*</span>}
                    </>
                  )}
                </td>
                {horizons.map((h) => (
                  <RatioCell key={h} cell={view.cells[h]} currency={store.currency} />
                ))}
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                  {view.repeat90 ? (
                    <>
                      {formatPct(view.repeat90.share)}
                      {view.repeat90.state === "provisional" && <span aria-label=" provisional">*</span>}
                    </>
                  ) : (
                    <span className="text-slate-300">
                      —<span className="sr-only"> aún no se cumple</span>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function LtvCpaPanel({ stores, views }: { stores: StoreLite[]; views: CohortView[] }) {
  const byStore = stores.map((store) => ({ store, views: views.filter((view) => view.storeId === store.id) }));
  // Un horizonte sale cuando al menos un mes ya lo cumple; los demás esperan.
  const horizons = HORIZONS.filter((h) => views.some((view) => view.cells[h].state !== "abierto"));
  const pending = HORIZONS.filter((h) => !horizons.includes(h));
  const unknown = [...new Set(views.flatMap((view) => view.unknownCurrencies))];
  return (
    <Card className="overflow-hidden p-0">
      <header className="border-b border-slate-200 px-5 py-4">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">LTV : CPA</h2>
        <p className="mt-0.5 max-w-[75ch] text-sm text-slate-500">
          Lo que compra cada clienta nueva en sus primeros días, por cada sol que costó traerla. Se agrupa por el mes de
          su primera entrega.
        </p>
        <ul aria-label="Escala" className="mt-3 flex flex-wrap gap-2">
          {LTV_ZONES.map((zone) => (
            <li
              key={zone.key}
              title={zone.meaning}
              className={cn("rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset", ZONE_CHIP[zone.tone])}
            >
              {zone.label} · {zone.range}
            </li>
          ))}
        </ul>
      </header>

      <div className="grid divide-y divide-slate-200 md:grid-cols-2 md:divide-x md:divide-y-0">
        {byStore.map(({ store, views: storeViews }) => (
          <StoreSummary key={store.id} store={store} views={storeViews} />
        ))}
      </div>

      <details className="border-t border-slate-200">
        <summary className="cursor-pointer select-none px-5 py-3 text-sm font-medium text-brand-700 hover:bg-slate-50">
          Ver mes por mes
        </summary>
        <div className="space-y-5 px-5 pb-5">
          {byStore
            .filter(({ views: storeViews }) => storeViews.length > 0)
            .map(({ store, views: storeViews }) => (
              <StoreTable key={store.id} store={store} views={storeViews} horizons={horizons} />
            ))}
          {pending.length > 0 && (
            <p className="text-xs text-slate-500">
              {pending.map((h) => `${h} días`).join(" y ")} aparecen cuando el primer mes los cumpla.
            </p>
          )}
        </div>
      </details>

      <footer className="space-y-1 border-t border-slate-200 bg-slate-50 px-5 py-3 text-xs leading-5 text-slate-500">
        <p>
          <strong className="font-semibold text-slate-600">Cómo se calcula.</strong> Valor: ingreso bruto de los pedidos
          entregados de cada clienta desde su primera compra; sin costo de producto, que no está cargado en Costos. Costo:
          el gasto de Meta del mes, con los dólares a S/ {USD_TO_PEN}, entre las clientas nuevas con entrega ese mes;
          otros canales pagados no entran.
        </p>
        <p>
          La clienta es su teléfono. El historial empieza en junio de 2026: las de junio pueden incluir clientas que ya
          habían comprado antes. Un mes se lee a 30 días cuando su última clienta nueva los cumple. Un valor con * es
          provisional: durante {DELIVERY_SETTLE_DAYS} días todavía se están entregando pedidos de esos días, y siguen
          apareciendo clientas nuevas del mes.
        </p>
        {unknown.length > 0 && (
          <p className="text-amber-700">Hay gasto en {unknown.join(", ")} que no se pudo convertir y no se sumó.</p>
        )}
      </footer>
    </Card>
  );
}

export function LtvCpaSkeleton() {
  return (
    <Card className="overflow-hidden p-0" aria-label="Cargando LTV : CPA">
      <div className="animate-pulse">
        <div className="border-b border-slate-200 px-5 py-4">
          <div className="h-5 w-32 rounded bg-slate-200" />
          <div className="mt-2 h-3 w-80 max-w-full rounded bg-slate-100" />
        </div>
        <div className="grid gap-px bg-slate-200 md:grid-cols-2">
          {[0, 1].map((item) => (
            <div key={item} className="h-28 bg-white px-5 py-4">
              <div className="h-3 w-24 rounded bg-slate-200" />
              <div className="mt-3 h-7 w-20 rounded bg-slate-200" />
              <div className="mt-2 h-3 w-64 max-w-full rounded bg-slate-100" />
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
