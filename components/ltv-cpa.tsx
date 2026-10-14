// Consolidado › LTV : CPA (MOM §17.2, 13-10-2026). La métrica que el dueño
// eligió para saber si el negocio se sostiene, con su escala: menos de 3 pierde
// caja, de 3 a 3.5 es estable, de 3.5 a 4 gana cuota y más de 4 es dominio.
//
// Una tarjeta del mundo de operación debajo de la operación del MOM: por
// tienda, lo que se lee primero —cómo vienen las clientas nuevas del último mes
// (sus primeros 30 días), el CPA del mes que todavía no los cumple y cuánto les
// sumó la recompra a las más antiguas—. El mes por mes a 30, 60, 90, 180 y 365
// días, la escala y cómo se calcula van en el panel lateral. Las cuentas salen
// de lib/ltv.ts; acá solo se pintan.

import { cn } from "@/components/ui";
import { Badge, Banner, SECTION_CARD, SectionHead, Skeleton } from "@/components/ops-ui";
import { FIGURE_FRAME, pctText } from "@/components/figures";
import { PanelButton } from "@/components/module-board";
import { formatCurrency } from "@/lib/metrics";
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

/** La zona de la escala dicha en texto: el tono del estado, nunca solo. */
const ZONE_TEXT = {
  crit: "text-crit-fg",
  warn: "text-warn-fg",
  ok: "text-ok-fg",
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
    <Badge tone={zone.tone} title={zone.meaning}>
      {zone.label}
    </Badge>
  );
}

/** Una tienda: el ratio del último mes que ya cumple 30 días y las dos lecturas que lo acompañan. */
function StoreCell({ store, views, wide }: { store: StoreLite; views: CohortView[]; wide: boolean }) {
  const { latest, current, longest } = storeHeadline(views);
  return (
    <div className={cn("flex min-w-0 flex-col bg-white px-4 py-3", wide && "md:col-span-2")}>
      <dt className="text-[13px] font-medium leading-5 text-ink-600">{store.name}</dt>
      {latest ? (
        <>
          <dd className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xl font-semibold leading-7 tabular-nums text-ink-900">{formatRatio(latest.ratio)}</span>
            <ZoneBadge ratio={latest.ratio} />
          </dd>
          <dd className="mt-0.5 text-xs leading-4 text-ink-500">
            Clientas nuevas de {monthLabel(latest.month)}, en sus primeros 30 días{"\u00a0· "}CPA{" "}
            <span className="tabular-nums">{formatCurrency(latest.cpa, store.currency)}</span>
            {latest.state === "provisional" && "\u00a0· provisional"}
          </dd>
          {current && (
            <dd className="mt-2 text-[13px] leading-5 text-ink-700">
              {capitalized(monthLabel(current.month))} aún no cumple sus 30 días. Su CPA:{" "}
              <span className={cn("font-semibold tabular-nums", current.cpa > latest.cpa * 1.15 ? "text-crit-fg" : "text-ink-900")}>
                {formatCurrency(current.cpa, store.currency)}
              </span>
              {current.cpa > latest.cpa * 1.15 &&
                `, ${pctText(current.cpa / latest.cpa - 1, 0)} más caro que en ${monthLabel(latest.month).split(" ")[0]}`}
              {current.provisional && " (provisional)"}.
            </dd>
          )}
          {longest && (
            <dd className="mt-1 text-[13px] leading-5 text-ink-700">
              Lo que suma la recompra: las de {monthLabel(longest.month)} pasaron de{" "}
              <span className="tabular-nums">{formatRatio(longest.from30)}</span> a los 30 días a{" "}
              <span className={cn("font-semibold tabular-nums", ZONE_TEXT[ratioZone(longest.ratio).tone])}>
                {formatRatio(longest.ratio)}
              </span>{" "}
              a los {longest.horizon} días.
            </dd>
          )}
        </>
      ) : (
        <dd className="mt-1 text-[13px] leading-5 text-ink-500">
          Todavía no hay un mes con sus primeros 30 días cumplidos y gasto de Meta.
        </dd>
      )}
    </div>
  );
}

function RatioCell({ cell, currency }: { cell: CohortCell; currency: string }) {
  if (cell.state === "abierto" || cell.ltv == null) {
    return (
      <td className="px-3 py-2.5 text-right text-ink-300">
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
        <span className="text-ink-500">sin gasto</span>
      )}
      <span className="block text-xs tabular-nums text-ink-500">{formatCurrency(cell.ltv, currency)}</span>
    </td>
  );
}

const TH = "whitespace-nowrap px-3 py-2 text-xs font-semibold text-ink-600";

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
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-ink-900">{store.name}</h3>
      <div className="overflow-x-auto rounded-lg ring-1 ring-line">
        <table className="w-full min-w-[760px] border-collapse text-left text-sm">
          <thead className="shadow-[inset_0_-1px_0_var(--color-line)]">
            <tr>
              <th scope="col" className={TH}>Mes de la primera compra</th>
              <th scope="col" className={cn(TH, "text-right")}>Clientas nuevas</th>
              <th scope="col" className={cn(TH, "text-right")}>Gasto Meta</th>
              <th scope="col" className={cn(TH, "text-right")}>CPA</th>
              {horizons.map((h) => (
                <th key={h} scope="col" className={cn(TH, "text-right")}>
                  {h} días
                </th>
              ))}
              <th scope="col" className={cn(TH, "text-right")}>Recompra a 90 días</th>
            </tr>
          </thead>
          <tbody>
            {views.map((view) => (
              <tr key={view.month} className="border-t border-line first:border-0">
                <th scope="row" className="px-3 py-2.5 font-medium text-ink-900">
                  {capitalized(monthLabel(view.month))}
                </th>
                <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{view.newCustomers.toLocaleString("es-PE")}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">
                  {view.spend == null ? "—" : formatWhole(view.spend, store.currency)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">
                  {view.inProgress ? (
                    <span className="whitespace-nowrap text-xs text-ink-500">mes en curso</span>
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
                <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">
                  {view.repeat90 ? (
                    <>
                      {pctText(view.repeat90.share)}
                      {view.repeat90.state === "provisional" && <span aria-label=" provisional">*</span>}
                    </>
                  ) : (
                    <span className="text-ink-300">
                      —<span className="sr-only"> aún no se cumple</span>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function LtvCpaPanel({ stores, views }: { stores: StoreLite[]; views: CohortView[] }) {
  const byStore = stores.map((store) => ({ store, views: views.filter((view) => view.storeId === store.id) }));
  // Un horizonte sale cuando al menos un mes ya lo cumple; los demás esperan.
  const horizons = HORIZONS.filter((h) => views.some((view) => view.cells[h].state !== "abierto"));
  const pending = HORIZONS.filter((h) => !horizons.includes(h));
  const unknown = [...new Set(views.flatMap((view) => view.unknownCurrencies))];
  return (
    <section aria-labelledby="ltv-cpa" className={SECTION_CARD}>
      <SectionHead
        id="ltv-cpa"
        title="LTV : CPA"
        help="Lo que compra cada clienta nueva en sus primeros días por cada sol que costó traerla, por el mes de su primera entrega."
        aside={
          <PanelButton label="Ver mes por mes" title="LTV : CPA" meta="Por mes de la primera entrega, a 30, 60, 90, 180 y 365 días">
            <div className="flex flex-col gap-6">
              <section aria-labelledby="ltv-escala" className="flex flex-col gap-2">
                <h3 id="ltv-escala" className="text-sm font-semibold text-ink-900">
                  La escala
                </h3>
                <ul className="flex flex-wrap gap-x-4 gap-y-2 text-[13px] text-ink-700">
                  {LTV_ZONES.map((zone) => (
                    <li key={zone.key} className="inline-flex items-center gap-2" title={zone.meaning}>
                      <Badge tone={zone.tone}>{zone.label}</Badge>
                      <span className="tabular-nums">{zone.range}</span>
                    </li>
                  ))}
                </ul>
              </section>
              {byStore
                .filter(({ views: storeViews }) => storeViews.length > 0)
                .map(({ store, views: storeViews }) => (
                  <StoreTable key={store.id} store={store} views={storeViews} horizons={horizons} />
                ))}
              {pending.length > 0 && (
                <p className="text-xs leading-4 text-ink-500">
                  {pending.map((h) => `${h} días`).join(" y ")} aparecen cuando el primer mes los cumpla.
                </p>
              )}
              <section aria-labelledby="ltv-calculo" className="flex flex-col gap-1.5 border-t border-line pt-4 text-xs leading-5 text-ink-500">
                <h3 id="ltv-calculo" className="text-[13px] font-semibold text-ink-900">
                  Cómo se calcula
                </h3>
                <p>
                  Valor: ingreso bruto de los pedidos entregados de cada clienta desde su primera compra; sin costo de producto, que no
                  está cargado en Costos. Costo: el gasto de Meta del mes, con los dólares a S/ {USD_TO_PEN}, entre las clientas nuevas
                  con entrega ese mes; otros canales pagados no entran.
                </p>
                <p>
                  La clienta es su teléfono. El historial empieza en junio de 2026: las de junio pueden incluir clientas que ya habían
                  comprado antes. Un mes se lee a 30 días cuando su última clienta nueva los cumple. Un valor con * es provisional:
                  durante {DELIVERY_SETTLE_DAYS} días todavía se están entregando pedidos de esos días, y siguen apareciendo clientas
                  nuevas del mes.
                </p>
              </section>
            </div>
          </PanelButton>
        }
      />
      <dl className={cn(FIGURE_FRAME, "mt-4 grid-cols-1 shadow-none md:grid-cols-2")}>
        {byStore.map(({ store, views: storeViews }, i) => (
          <StoreCell
            key={store.id}
            store={store}
            views={storeViews}
            wide={i === byStore.length - 1 && byStore.length % 2 === 1}
          />
        ))}
      </dl>
      {unknown.length > 0 && (
        <Banner tone="warn" className="mt-4">
          Hay gasto en {unknown.join(", ")} que no se pudo convertir y no se sumó.
        </Banner>
      )}
    </section>
  );
}

export function LtvCpaSkeleton() {
  return (
    <section aria-label="Cargando LTV : CPA" className={SECTION_CARD}>
      <Skeleton className="h-5 w-28" />
      <Skeleton className="mt-2 h-4 w-80 max-w-full" />
      <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
        {[0, 1].map((item) => (
          <Skeleton key={item} className="h-28" />
        ))}
      </div>
    </section>
  );
}
