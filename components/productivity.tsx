import Link from "next/link";
import { Card, DeltaBadge, cn } from "@/components/ui";
import { ProductivityTable } from "@/components/productivity-table";
import type { DateRange } from "@/lib/access";
import type { StoreSummary } from "@/lib/types";
import {
  HEAT_START,
  localDayPreset,
  localPresetRange,
  storeInitials,
  type AdvisorBoardRow,
  type ProductivityTotals,
  type SourceBucket,
} from "@/lib/productivity";

type SourceFilter = SourceBucket | null;

const SOURCE_FILTERS: { key: SourceBucket; label: string }[] = [
  { key: "meta_ad", label: "📣 Campaña" },
  { key: "fb_web", label: "🌐 Meta/Web" },
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

function buildHref(opts: { from: string; to: string; store: string | null; src: string | null }): string {
  const qs = new URLSearchParams({ from: opts.from, to: opts.to });
  if (opts.store) qs.set("store", opts.store);
  if (opts.src) qs.set("src", opts.src);
  return `/dashboard/productividad?${qs.toString()}`;
}

function Chip({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        "rounded-lg border px-2 py-1 text-xs whitespace-nowrap",
        active
          ? "border-brand-500 bg-brand-50 font-medium text-brand-700"
          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
      )}
    >
      {label}
    </Link>
  );
}

function ChipDivider() {
  return <span aria-hidden className="mx-1 h-4 w-px self-center bg-slate-200" />;
}

/** Compact KPI (the classic StatCard is too tall for the one-screen layout). */
function Kpi({ label, value, delta, sub }: { label: string; value: string; delta?: number | null; sub?: string }) {
  return (
    <Card className="p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate text-[11px] font-medium tracking-wide text-slate-400 uppercase">{label}</p>
        {delta !== undefined && <DeltaBadge pct={delta} />}
      </div>
      <p className="mt-0.5 text-xl font-semibold text-slate-900">{value}</p>
      {sub && <p className="text-[11px] text-slate-400">{sub}</p>}
    </Card>
  );
}

/**
 * One-screen productivity board: header+filters (1 row) · 5 compact KPIs ·
 * a single dense table (activity heatmap, trend sparkline, per-source chips)
 * that scrolls INTERNALLY — at xl+ the page itself never scrolls.
 */
export function ProductivityBoard({
  rows,
  prevTotals,
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
  solo = false,
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
  /** Vista de vendedora: solo su propia fila — sin KPI de presencia del equipo. */
  solo?: boolean;
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
  const onlineCount = initialOnlineIds.length;
  // Sigla + nombre por tienda para los chips "AUR 5 · KP 12" junto a Cerrados.
  const storeInfo = Object.fromEntries(
    stores.map((s) => [s.id, { short: storeInitials(s.name), name: s.name }]),
  ) as Record<string, { short: string; name: string }>;

  // Range presets anchored on the STORE's local day (a UTC date flips to
  // "tomorrow" at 19:00 Lima and used to blank the board at night).
  const presets: { label: string; p: DateRange }[] = [
    { label: "Hoy", p: localDayPreset(0, tz) },
    { label: "Ayer", p: localDayPreset(1, tz) },
    ...[7, 30, 90].map((d) => ({ label: `${d}d`, p: localPresetRange(d, tz) })),
  ];

  return (
    <div className="flex flex-col gap-3 xl:h-[calc(100vh-3rem)] xl:overflow-hidden">
      {/* Header + todos los filtros en una sola franja */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex items-baseline gap-2">
          <h1 className="text-lg font-semibold text-slate-900">
            {solo ? "Mi productividad" : "Productividad por asesora"}
          </h1>
          <p className="text-xs text-slate-400">
            {range.from} → {range.to}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {presets.map(({ label, p }) => (
            <Chip
              key={label}
              href={buildHref({ from: p.from, to: p.to, store: storeId, src: source })}
              label={label}
              active={range.from === p.from && range.to === p.to}
            />
          ))}
          {stores.length > 1 && (
            <>
              <ChipDivider />
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
            </>
          )}
          <ChipDivider />
          <Chip
            href={buildHref({ from: range.from, to: range.to, store: storeId, src: null })}
            label="Fuente: todas"
            active={!source}
          />
          {SOURCE_FILTERS.map((f) => (
            <Chip
              key={f.key}
              href={buildHref({ from: range.from, to: range.to, store: storeId, src: f.key })}
              label={f.label}
              active={source === f.key}
            />
          ))}
        </div>
      </div>

      {/* KPIs compactos (en modo solo son LOS SUYOS; el de presencia del equipo
          no aplica y se oculta) */}
      <div className={cn("grid shrink-0 grid-cols-2 gap-3 md:grid-cols-3", solo ? "xl:grid-cols-4" : "xl:grid-cols-5")}>
        <Kpi
          label={solo ? "Mis llamadas" : "Llamadas"}
          value={String(totals.llamadas)}
          delta={hasPrev ? pctDelta(totals.llamadas, prevTotals.llamadas) : undefined}
        />
        <Kpi
          label={solo ? "Mis leads" : "Leads trabajados"}
          value={String(totals.leads)}
          delta={hasPrev ? pctDelta(totals.leads, prevTotals.leadsTrabajados) : undefined}
        />
        <Kpi
          label={solo ? "Mis cerrados" : "Pedidos cerrados"}
          value={String(totals.cerrados)}
          delta={hasPrev ? pctDelta(totals.cerrados, prevTotals.cerrados) : undefined}
        />
        <Kpi
          label={solo ? "Mis ingresos" : "Ingresos atribuidos"}
          value={money(totals.ingresos, currency)}
          delta={hasPrev ? pctDelta(totals.ingresos, prevTotals.ingresos) : undefined}
        />
        {!solo && (
          <Kpi
            label="En línea ahora"
            value={String(onlineCount)}
            sub={onlineCount ? "con el dashboard abierto" : "nadie conectada"}
          />
        )}
      </div>

      {/* Tabla única — scroll interno, encabezado sticky */}
      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
        <div className="min-h-0 flex-1 overflow-auto">
          <ProductivityTable
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
          />
        </div>
        <p className="shrink-0 border-t border-slate-100 px-3 py-1.5 text-[11px] text-slate-400">
          Actividad = leads distintos gestionados por hora (sin filtro de fuente): <span className="text-brand-700">azul</span> a
          ritmo (≥6/h) · <span className="text-amber-700">ámbar</span> bajo ritmo · <span className="text-rose-600">rojo</span> hora
          muerta en plena jornada · gris fuera de jornada — la señal de eficiencia es su contraste con el % de
          cierre · el pedido se acredita a la asesora del último toque ·{" "}
          {solo ? "toca tu fila para ver tus leads." : "toca una asesora para ver sus leads."}
        </p>
      </Card>
    </div>
  );
}
