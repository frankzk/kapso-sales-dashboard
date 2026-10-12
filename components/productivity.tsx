import type { ReactNode } from "react";
import { cn } from "@/components/ui";
import { Badge } from "@/components/ops-ui";
import { ProductivityTable, type ProductivityPeriod, type ProductivityWeek } from "@/components/productivity-table";

export type { ProductivityPeriod, ProductivityWeek };
import { ProductivityFilters, type PeriodLink } from "@/components/productivity-filters";
import type { DateRange } from "@/lib/access";
import type { MonthPace, MonthView } from "@/lib/productivity-month";
import type { StoreSummary } from "@/lib/types";
import { SOURCE_LABEL } from "@/lib/productivity-labels";
import {
  FIRST_TOUCH_FAST_MIN,
  HEAT_START,
  formatMinutes,
  localDayPreset,
  localPresetRange,
  storeInitials,
  type AdvisorBoardRow,
  type FirstTouchStats,
  type ProductivityTotals,
  type SourceBucket,
} from "@/lib/productivity";

type SourceFilter = SourceBucket | null;

/** La vista por mes (`?mes=`): qué mes, con qué se compara y a qué ritmo va. */
export interface ProductivityMonth {
  view: MonthView;
  pace: MonthPace;
  /** "agosto": el mes anterior entero, para «agosto cerró en …». */
  prevMonthName: string;
  /** Cerrados e ingresos de ese mes entero (en modo solo, los de la asesora). */
  prevMonthTotals: { cerrados: number; ingresos: number } | null;
}

const nf = new Intl.NumberFormat("es-PE");
const nf1 = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 1 });

function money(n: number, currency: string): string {
  return new Intl.NumberFormat("es-PE", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
}

/** Signed % change current vs previous; null when there's no base (prev = 0). */
function pctDelta(cur: number, prev: number): number | null {
  if (prev === 0) return cur === 0 ? 0 : null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

/** Un rango de días (`from`/`to`) o un mes (`mes`); el mes manda si viene. */
function buildHref(opts: { from: string; to: string; store: string | null; src: string | null; mes?: string | null }): string {
  const qs = new URLSearchParams(opts.mes ? { mes: opts.mes } : { from: opts.from, to: opts.to });
  if (opts.store) qs.set("store", opts.store);
  if (opts.src) qs.set("src", opts.src);
  return `/dashboard/productividad?${qs.toString()}`;
}

// ── Fechas del contexto («Lunes 12 de octubre · comparado con el domingo 11») ──

function asDate(iso: string): Date {
  return new Date(`${iso}T12:00:00.000Z`);
}

/** «domingo 11 de octubre» (sin la coma que pone el navegador tras el día). */
function longDay(iso: string): string {
  const d = asDate(iso);
  // Sueltos, el día y el mes salen con mayúscula («Octubre»): en la frase van en minúscula.
  const part = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("es-PE", { ...o, timeZone: "UTC" }).toLowerCase();
  return `${part({ weekday: "long" })} ${part({ day: "numeric" })} de ${part({ month: "long" })}`;
}

function shortDay(iso: string, withMonth = true): string {
  return asDate(iso).toLocaleDateString("es-PE", withMonth ? { day: "numeric", month: "short", timeZone: "UTC" } : { day: "numeric", timeZone: "UTC" });
}

/** «lunes 12 de octubre» o «6 – 12 oct» (el mes una vez si no cambia). */
function rangeLabel(r: DateRange): string {
  if (r.from === r.to) return longDay(r.from);
  const sameMonth = r.from.slice(0, 7) === r.to.slice(0, 7);
  return `${shortDay(r.from, !sameMonth)} – ${shortDay(r.to)}`;
}

/** El separador de tramos: el «·» va pegado a la palabra de antes con un
 *  espacio duro, así ningún renglón empieza por él (DESIGN.md). */
const SEP = "\u00a0· ";

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Productividad: cabecera con el periodo, los filtros, las cifras del equipo en
 * un marco y la tabla por asesora. Desde 1280 px es una pantalla —la tabla se
 * desplaza por dentro con su cabecera pegajosa—; más angosta, baja la página.
 */
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
  tz,
  heatMax,
  heatMode,
  onlineIdle,
  initialOnlineIds,
  firstTouch,
  solo = false,
  month = null,
  months = [],
  week = null,
  period = null,
}: {
  rows: AdvisorBoardRow[];
  prevTotals: ProductivityTotals;
  prevRange: DateRange;
  hasPrev: boolean;
  range: DateRange;
  currency: string;
  stores: StoreSummary[];
  storeId: string | null;
  source: SourceFilter;
  tz: string;
  heatMax: number;
  heatMode: "day" | "avg";
  onlineIdle: { userId: string; email: string }[];
  initialOnlineIds: string[];
  /** Velocidad de 1ª gestión del equipo — null en modo solo (privacidad: la
   *  vendedora ve la suya propia, derivada de su fila). */
  firstTouch: FirstTouchStats | null;
  /** Vista de vendedora: solo su propia fila — sin cifra de presencia del equipo. */
  solo?: boolean;
  /** Vista por mes; null cuando se mira un rango de días. */
  month?: ProductivityMonth | null;
  /** Los meses que se pueden elegir, del actual hacia atrás. */
  months?: { month: string; label: string }[];
  /** La semana en curso contra la meta de cada persona (siempre lunes a domingo). */
  week?: ProductivityWeek | null;
  /** Con más de un día: cada día de cada asesora contra su meta (la franja por día). */
  period?: ProductivityPeriod | null;
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
  // Sigla + nombre por tienda para «KP 7 de 44» en la tabla y el panel.
  const storeInfo = Object.fromEntries(
    stores.map((s) => [s.id, { short: storeInitials(s.name), name: s.name }]),
  ) as Record<string, { short: string; name: string }>;

  // Presets anclados en el día LOCAL de la tienda (un día UTC salta a
  // «mañana» a las 19:00 de Lima y dejaba el tablero vacío por la noche).
  const today = localDayPreset(0, tz);
  const presets: { label: string; p: DateRange }[] = [
    { label: "Hoy", p: today },
    { label: "Ayer", p: localDayPreset(1, tz) },
    ...[7, 30, 90].map((d) => ({ label: `${d} días`, p: localPresetRange(d, tz) })),
  ];

  // Vista por mes: el mes en curso y el anterior van en chip —son los que se
  // miran a diario—; el resto, en «Otro mes…». Cambiar de tienda o de fuente
  // conserva el mes elegido.
  const mes = month?.view.month ?? null;
  const [thisMonth, lastMonth] = months;
  const chipMonths = [thisMonth, lastMonth].filter(Boolean) as { month: string; label: string }[];
  const hrefFor = (opts: { store: string | null; src: string | null }) =>
    buildHref({ from: range.from, to: range.to, mes, ...opts });

  const periods: PeriodLink[] = presets.map(({ label, p }) => ({
    label,
    href: buildHref({ from: p.from, to: p.to, store: storeId, src: source }),
    active: !month && range.from === p.from && range.to === p.to,
  }));
  const monthChips: PeriodLink[] = chipMonths.map((m, i) => ({
    label: i === 0 ? "Este mes" : capitalize(m.label.split(" ")[0]!),
    href: buildHref({ from: range.from, to: range.to, store: storeId, src: source, mes: m.month }),
    active: mes === m.month,
  }));
  const otherMonths =
    months.length > 2
      ? months.map((m) => ({ ...m, href: buildHref({ from: range.from, to: range.to, store: storeId, src: source, mes: m.month }) }))
      : [];

  // El contexto: qué se mira y con qué se compara (las cifras de color).
  const isToday = !month && range.from === today.from && range.to === today.to;
  const context = month
    ? [
        month.view.label,
        month.view.current ? `día ${month.view.day} de ${month.view.daysInMonth}` : null,
        hasPrev ? `comparado con ${month.view.prevLabel}` : null,
      ]
        .filter(Boolean)
        .join(SEP)
    : [
        `${isToday ? "Hoy, " : ""}${isToday ? rangeLabel(range) : capitalize(rangeLabel(range))}`,
        hasPrev ? `comparado con ${prevRange.from === prevRange.to ? "el " : ""}${rangeLabel(prevRange)}` : null,
      ]
        .filter(Boolean)
        .join(SEP);
  const periodLabel = month ? month.view.label : capitalize(rangeLabel(range));

  const monthSubs = monthKpiSubs({ month, hasPrev, prevTotals, currency });
  const delta = (cur: number, prev: number) => (hasPrev ? <Change pct={pctDelta(cur, prev)} /> : undefined);

  // 1ª gestión: en equipo manda la mediana de CARRITOS (el segmento con plata);
  // en modo solo, la propia (derivada de la fila — sin datos del equipo).
  const ownFirstTouch = rows[0]?.primeraGestion ?? { medianMin: null, n: 0 };
  const ftPend = firstTouch ? firstTouch.carritos.sinGestionar + firstTouch.resto.sinGestionar : 0;
  const ftSub: ReactNode = solo ? (
    ownFirstTouch.n ? (
      `mediana de ${nf.format(ownFirstTouch.n)} ${ownFirstTouch.n === 1 ? "lead que tocaste" : "leads que tocaste"} primero`
    ) : (
      "aún sin leads nuevos tocados primero"
    )
  ) : firstTouch ? (
    // Dos tramos que no se parten; el «·» cierra el primero para que ningún
    // renglón empiece por él.
    <span className="flex flex-wrap gap-x-1">
      <span className="whitespace-nowrap" title={`Carritos gestionados en menos de ${FIRST_TOUCH_FAST_MIN} minutos`}>
        {firstTouch.carritos.n
          ? `${firstTouch.carritos.under30Pct}\u00a0% en\u00a0<${FIRST_TOUCH_FAST_MIN}\u00a0min\u00a0·`
          : "sin carritos nuevos\u00a0·"}
      </span>
      <span className="whitespace-nowrap">el resto, {formatMinutes(firstTouch.resto.medianMin)}</span>
    </span>
  ) : undefined;
  const onlineCount = initialOnlineIds.length;

  return (
    <div className="flex flex-col gap-4 xl:h-[calc(100dvh-3rem)]">
      <header className="flex shrink-0 flex-col gap-3">
        <div>
          <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">
            {solo ? "Mi productividad" : "Productividad por asesora"}
          </h1>
          <p className="mt-0.5 text-sm text-ink-500 first-letter:uppercase">{context}</p>
        </div>
        <ProductivityFilters
          periods={periods}
          months={monthChips}
          otherMonths={otherMonths}
          otherMonth={mes && !chipMonths.some((m) => m.month === mes) ? mes : null}
          stores={stores.map((s) => ({ value: s.id, label: s.name, href: hrefFor({ store: s.id, src: source }) }))}
          store={{ value: storeId ?? "", allHref: hrefFor({ store: null, src: source }) }}
          sources={(Object.keys(SOURCE_LABEL) as SourceBucket[]).map((k) => ({
            value: k,
            label: SOURCE_LABEL[k],
            href: hrefFor({ store: storeId, src: k }),
          }))}
          source={{ value: source ?? "", allHref: hrefFor({ store: storeId, src: null }) }}
        />
      </header>

      {/* Las cifras del equipo (en modo solo, las suyas) en un marco de celdas
          sobre hairlines: un dato, no tarjetas sueltas. */}
      <dl
        className={cn(
          "grid shrink-0 gap-px overflow-hidden rounded-lg bg-line shadow-control ring-1 ring-line",
          solo ? "grid-cols-2 lg:grid-cols-5" : "grid-cols-2 md:grid-cols-3 xl:grid-cols-6",
        )}
      >
        <Figure
          label={solo ? "Mis llamadas" : "Llamadas"}
          value={nf.format(totals.llamadas)}
          delta={delta(totals.llamadas, prevTotals.llamadas)}
          sub={monthSubs.llamadas}
        />
        <Figure
          label={solo ? "Mis leads" : "Leads trabajados"}
          value={nf.format(totals.leads)}
          delta={delta(totals.leads, prevTotals.leadsTrabajados)}
          sub={monthSubs.leads}
        />
        <Figure
          label={solo ? "Mis cerrados" : "Pedidos cerrados"}
          value={nf.format(totals.cerrados)}
          delta={delta(totals.cerrados, prevTotals.cerrados)}
          sub={monthSubs.cerrados}
        />
        <Figure
          label={solo ? "Mis ingresos" : "Ingresos atribuidos"}
          value={money(totals.ingresos, currency)}
          delta={delta(totals.ingresos, prevTotals.ingresos)}
          sub={monthSubs.ingresos}
        />
        <Figure
          label={solo ? "Mi 1ª gestión" : "1ª gestión de carritos"}
          value={formatMinutes(solo ? ownFirstTouch.medianMin : (firstTouch?.carritos.medianMin ?? null))}
          delta={
            ftPend > 0 ? (
              <Badge tone="warn" title="Leads nuevos del periodo que siguen en cola sin ninguna gestión">
                {nf.format(ftPend)} sin gestionar
              </Badge>
            ) : undefined
          }
          sub={ftSub}
          className={solo ? "col-span-2 lg:col-span-1" : undefined}
        />
        {!solo && (
          <Figure
            label="En línea ahora"
            value={nf.format(onlineCount)}
            sub={onlineCount ? "con el panel abierto" : "nadie conectada"}
          />
        )}
      </dl>

      <section
        aria-label={solo ? "Mi actividad" : "Asesoras"}
        className="flex flex-col rounded-lg bg-white shadow-control ring-1 ring-line xl:min-h-0"
      >
        {/* La clave es el periodo y los filtros: al cambiarlos, los leads ya
            cargados y el panel abierto no son de este tablero. */}
        <ProductivityTable
          key={`${range.from}|${range.to}|${storeId ?? ""}|${source ?? ""}`}
          rows={rows}
          currency={currency}
          hasPrev={hasPrev}
          ctx={{ from: range.from, to: range.to, store: storeId, source }}
          heatMax={heatMax}
          heatMode={heatMode}
          heatStart={HEAT_START}
          storeInfo={storeInfo}
          onlineIdle={onlineIdle}
          initialOnlineIds={initialOnlineIds}
          solo={solo}
          periodLabel={periodLabel}
          week={week}
          period={period}
        />
      </section>
    </div>
  );
}

/** Una celda del marco de cifras: etiqueta, cifra con su cambio y una línea. */
function Figure({
  label,
  value,
  delta,
  sub,
  className,
}: {
  label: string;
  value: string;
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

/** El cambio contra el periodo anterior, en su tono: sube en verde, baja en rojo. */
function Change({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-xs font-medium text-ink-500">sin base</span>;
  const tone = pct > 0 ? "text-ok-fg" : pct < 0 ? "text-crit-fg" : "text-ink-500";
  return (
    <span className={cn("text-[13px] font-semibold tabular-nums", tone)} title="Contra el periodo anterior">
      {pct > 0 ? "+" : pct < 0 ? "−" : ""}
      {nf1.format(Math.abs(pct))}{"\u00a0"}%
    </span>
  );
}

/**
 * Las líneas bajo las cifras en la vista por mes. En las de trabajo, la cifra
 * con la que se compara (solo con base del equipo). En cerrados e ingresos, el
 * mes anterior entero —«agosto: 2.790»— y, en el mes en curso, a qué ritmo va.
 */
function monthKpiSubs({
  month,
  hasPrev,
  prevTotals,
  currency,
}: {
  month: ProductivityMonth | null;
  hasPrev: boolean;
  prevTotals: ProductivityTotals;
  currency: string;
}): { llamadas?: string; leads?: string; cerrados?: string; ingresos?: string } {
  if (!month) return {};
  const { view, pace, prevMonthName, prevMonthTotals } = month;
  const count = (n: number) => nf.format(n);
  const vs = (n: number) => (hasPrev ? `${view.prevLabel}: ${count(n)}` : undefined);
  const closing = (n: number | undefined, fmt: (x: number) => string) =>
    n == null ? null : view.current ? `${prevMonthName} cerró en ${fmt(n)}` : `${prevMonthName}: ${fmt(n)}`;
  const pacing = (n: number | undefined, fmt: (x: number) => string) =>
    !view.current ? null : n == null ? "el ritmo se ve desde mañana" : `a este ritmo, ~${fmt(n)}`;
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(SEP) || undefined;
  const soles = (n: number) => money(n, currency);
  return {
    llamadas: vs(prevTotals.llamadas),
    leads: vs(prevTotals.leadsTrabajados),
    cerrados: join(pacing(pace.projected?.cerrados, count), closing(prevMonthTotals?.cerrados, count)),
    ingresos: join(pacing(pace.projected?.ingresos, soles), closing(prevMonthTotals?.ingresos, soles)),
  };
}
