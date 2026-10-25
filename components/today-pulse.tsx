"use client";

// «Hoy» del Consolidado (MOM §17.5, DESIGN.md › Consolidado): cómo van las
// ventas del día contra ayer a esta misma hora, arriba de todo, para leerlo de
// un vistazo en el teléfono. Dos cifras que eligen lo que dibuja la curva
// (The Cifras Navegan Rule), la curva acumulada de hoy contra ayer completo,
// una línea por tienda y los cancelados aparte. Se relee sola cada minuto
// mientras la pestaña está a la vista; si un refresco falla, queda lo último
// que se leyó y lo dice.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/components/ui";
import { SECTION_CARD, SectionHead, Skeleton } from "@/components/ops-ui";
import { IconArrowDown, IconArrowUp } from "@/components/icons";
import { VIZ } from "@/components/palette";
import {
  BUCKET_MINUTES,
  CURVE_POINTS,
  DAY_MINUTES,
  changeRatio,
  type SalesFigure,
  type TodaySales,
} from "@/lib/today-sales";
import { localClock } from "@/lib/local-day";

type Metric = "ingresos" | "pedidos";

const REFRESH_MS = 60_000;

// Los textos se arman a mano y no con `Intl`: el servidor (ICU de Node) y el
// navegador (ICU de Chromium) no ponen los mismos espacios en «4:52 p. m.» ni
// en «S/ 22,100», y React rechazaba la hidratación del bloque (#418). Las
// cifras siguen el formato es-PE del resto del tablero: coma de miles.

/** «22,100»: entero con coma de miles. */
function nf(n: number): string {
  const sign = n < 0 ? "−" : "";
  return sign + String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const SYMBOL: Record<string, string> = { PEN: "S/", USD: "US$", EUR: "€", COP: "COL$", MXN: "MX$", CLP: "CLP$" };

/** «S/ 22,100»: la moneda de la tienda, sin decimales. */
function money(n: number, currency: string): string {
  return `${SYMBOL[currency] ?? currency} ${nf(n)}`;
}

/** El eje: «50 k», «2.5 k», «800». */
function axis(v: number): string {
  if (v < 1000) return nf(v);
  const k = Math.round((v / 1000) * 10) / 10;
  return `${String(k)} k`;
}

const valueText = (metric: Metric, n: number, currency: string) => (metric === "ingresos" ? money(n, currency) : nf(n));

/** «4:52 p. m.» en la zona de las tiendas. */
function clockText(iso: string, timeZone: string): string {
  return minuteText(localClock(iso, timeZone).minute);
}

const WEEKDAYS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "setiembre", "octubre", "noviembre", "diciembre"];

/** «Domingo 25 de octubre». */
function dayText(iso: string, timeZone: string): string {
  const [y, m, d] = localClock(iso, timeZone).date.split("-").map(Number);
  const weekday = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${d} de ${MONTHS[m! - 1]}`;
}

/** Los minutos desde la medianoche, como reloj: 0 → «12 a. m.», 945 → «3:45 p. m.». */
function minuteText(minute: number, withMinutes = true): string {
  const m = ((minute % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const suffix = h < 12 ? "a. m." : "p. m.";
  return withMinutes && mm ? `${h12}:${String(mm).padStart(2, "0")} ${suffix}` : `${h12} ${suffix}`;
}

/**
 * El cambio contra ayer a esta hora: flecha dibujada, porcentaje y, si cabe,
 * «vs ayer». Nunca solo el color. Sin nada ayer a esta hora no hay porcentaje.
 */
function Change({ hoy, ayer, size = "md", withLabel = true }: { hoy: number; ayer: number; size?: "md" | "sm"; withLabel?: boolean }) {
  const ratio = changeRatio(hoy, ayer);
  const text = size === "md" ? "text-[13px] leading-5" : "text-xs leading-4";
  if (ratio === null) {
    return <span className={cn(text, "text-ink-500")}>{hoy ? "ayer a esta hora no había" : "sin ventas todavía"}</span>;
  }
  const pct = Math.round(Math.abs(ratio) * 100);
  if (pct === 0) return <span className={cn(text, "text-ink-500")}>igual que ayer</span>;
  const up = ratio > 0;
  const Arrow = up ? IconArrowUp : IconArrowDown;
  return (
    <span className={cn(text, "inline-flex items-center gap-1 whitespace-nowrap")}>
      <span className={cn("inline-flex items-center gap-0.5 font-semibold tabular-nums", up ? "text-ok-fg" : "text-crit-fg")}>
        <Arrow className={size === "md" ? "size-3.5" : "size-3"} strokeWidth={2.4} aria-hidden />
        <span className="sr-only">{up ? "subió" : "bajó"}</span>
        {pct}
        {" %"}
      </span>
      {withLabel && <span className="text-ink-500">vs ayer</span>}
    </span>
  );
}

/** El ancho real del contenedor: el SVG se dibuja a escala 1 y el texto mide lo que dice. */
function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || fallback);
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width) || fallback);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallback]);
  return [ref, width] as const;
}

/** El tope del eje: un número redondo y par justo por encima del máximo (28.813 → 30.000). */
function niceTop(v: number): number {
  if (v <= 4) return 4;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.6, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const top = m * mag;
    if (top >= v && Number.isInteger(top / 2)) return top;
  }
  return 10 * mag;
}

const LAST_POINT = CURVE_POINTS - 1;

/**
 * La curva acumulada del día: hoy en azul hasta ahora, ayer completo punteado
 * en tinta clara. Al pasar el cursor (o con las flechas del teclado), una raya
 * y las dos cifras de esa hora.
 */
function PulseChart({ data, metric, currency }: { data: TodaySales; metric: Metric; currency: string }) {
  const [boxRef, W] = useWidth<HTMLDivElement>(600);
  const [hover, setHover] = useState<number | null>(null);
  // Al lado de las cifras (desde 1024 px) la curva tiene más ancho y crece en alto.
  const H = W >= 560 ? 236 : 196;
  const L = 44;
  const R = 14;
  const T = 12;
  const B = 24;
  const hoySerie = data.curva.hoy[metric];
  const ayerSerie = data.curva.ayer[metric];
  const hoyNow = data.total.hoy[metric];
  const ayerNow = data.total.ayerAEstaHora[metric];
  const ahora = Math.min(DAY_MINUTES, Math.max(0, data.ahora));
  const nowIdx = Math.floor(ahora / BUCKET_MINUTES);

  const x = (minute: number) => L + (minute / DAY_MINUTES) * (W - L - R);
  const top = niceTop(Math.max(1, hoyNow, data.total.ayerDia[metric], ...ayerSerie));
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const yTicks = [0, top / 2, top];
  // Cinco horas en el eje desde 300 px; más angosto, tres, para que no choquen.
  const xTicks = W >= 300 ? [0, 360, 720, 1080, 1440] : [0, 720, 1440];
  const path = (pts: [number, number][]) => pts.map(([m, v], i) => `${i ? "L" : "M"}${x(m).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");

  const ayerPts = ayerSerie.map((v, i) => [i * BUCKET_MINUTES, v] as [number, number]);
  const hoyPts: [number, number][] = [];
  for (let i = 0; i <= nowIdx && i < CURVE_POINTS; i++) hoyPts.push([i * BUCKET_MINUTES, hoySerie[i] ?? 0]);
  hoyPts.push([ahora, hoyNow]);
  const hoyArea = `${path(hoyPts)} L${x(ahora).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`;

  const fmt = (v: number) => valueText(metric, v, currency);

  const hoverMin = hover != null ? hover * BUCKET_MINUTES : null;
  // Lo de hoy solo existe hasta ahora: más allá, la fila del tooltip no va.
  const hoverHoy = hoverMin != null && hoverMin <= ahora ? (hoySerie[hover!] ?? null) : null;
  const hoverAyer = hover != null ? ayerSerie[hover] : null;

  const pick = (clientX: number, el: Element) => {
    const rect = el.getBoundingClientRect();
    const minute = ((clientX - rect.left - L) / (W - L - R)) * DAY_MINUTES;
    setHover(Math.round(Math.min(DAY_MINUTES, Math.max(0, minute)) / BUCKET_MINUTES));
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = 60 / BUCKET_MINUTES;
    const cur = hover ?? nowIdx;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = cur - step;
    else if (e.key === "ArrowRight") next = cur + step;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = nowIdx;
    else if (e.key === "Escape") return setHover(null);
    if (next == null) return;
    e.preventDefault();
    setHover(Math.min(LAST_POINT, Math.max(0, next)));
  };

  const label = metric === "ingresos" ? "Ventas acumuladas" : "Pedidos acumulados";

  return (
    <div
      ref={boxRef}
      className="relative w-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
      tabIndex={0}
      role="group"
      aria-label={`${label} del día: hoy ${fmt(hoyNow)}, ayer a esta hora ${fmt(ayerNow)}. Usa las flechas para recorrer las horas.`}
      onKeyDown={onKey}
      onFocus={() => setHover((h) => h ?? nowIdx)}
      onBlur={() => setHover(null)}
    >
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="block touch-pan-y select-none"
        aria-hidden
        onPointerMove={(e) => pick(e.clientX, e.currentTarget)}
        onPointerDown={(e) => pick(e.clientX, e.currentTarget)}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") setHover(null);
        }}
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke={t === 0 ? VIZ.lineStrong : VIZ.line} />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill={VIZ.ink500} className="tabular-nums">
              {axis(t)}
            </text>
          </g>
        ))}
        {xTicks.map((m, i) => (
          <text
            key={m}
            x={x(m)}
            y={H - 6}
            textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
            fontSize="11"
            fill={VIZ.ink500}
          >
            {minuteText(m, false)}
          </text>
        ))}
        <path d={path(ayerPts)} fill="none" stroke={VIZ.ink300} strokeWidth={2} strokeDasharray="5 4" strokeLinejoin="round" />
        <path d={hoyArea} fill={VIZ.brand} fillOpacity={0.08} />
        <line x1={x(ahora)} x2={x(ahora)} y1={T} y2={H - B} stroke={VIZ.brand} strokeDasharray="3 3" strokeOpacity={0.55} />
        <path d={path(hoyPts)} fill="none" stroke={VIZ.brand} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(ahora)} cy={y(ayerNow)} r={4} fill={VIZ.ink300} stroke="#fff" strokeWidth={2} />
        <circle cx={x(ahora)} cy={y(hoyNow)} r={5} fill={VIZ.brand} stroke="#fff" strokeWidth={2} />
        {hoverMin != null && (
          <g>
            <line x1={x(hoverMin)} x2={x(hoverMin)} y1={T} y2={H - B} stroke={VIZ.ink300} />
            {hoverAyer != null && <circle cx={x(hoverMin)} cy={y(hoverAyer)} r={4} fill={VIZ.ink300} stroke="#fff" strokeWidth={2} />}
            {hoverHoy != null && <circle cx={x(hoverMin)} cy={y(hoverHoy)} r={4} fill={VIZ.brand} stroke="#fff" strokeWidth={2} />}
          </g>
        )}
      </svg>
      {hoverMin != null && (
        <div
          className="pointer-events-none absolute top-0 z-10 min-w-36 whitespace-nowrap rounded-md bg-white px-3 py-2 text-xs leading-5 shadow-pop"
          style={x(hoverMin) > W / 2 ? { right: W - x(hoverMin) + 10 } : { left: x(hoverMin) + 10 }}
        >
          <p className="text-ink-500">A las {minuteText(hoverMin)}</p>
          {hoverHoy != null && (
            <p className="flex items-center gap-2">
              <span aria-hidden className="h-0 w-3 border-t-[2.5px]" style={{ borderColor: VIZ.brand }} />
              <span className="font-semibold tabular-nums text-ink-900">{fmt(hoverHoy)}</span>
              <span className="text-ink-600">hoy</span>
            </p>
          )}
          {hoverAyer != null && (
            <p className="flex items-center gap-2">
              <span aria-hidden className="h-0 w-3 border-t-2 border-dashed" style={{ borderColor: VIZ.ink300 }} />
              <span className="font-semibold tabular-nums text-ink-900">{fmt(hoverAyer)}</span>
              <span className="text-ink-600">ayer</span>
            </p>
          )}
        </div>
      )}
      {/* La misma curva, hora por hora, para quien no ve el gráfico. */}
      <table className="sr-only">
        <caption>{label} por hora, hoy y ayer</caption>
        <thead>
          <tr>
            <th scope="col">Hora</th>
            <th scope="col">Hoy</th>
            <th scope="col">Ayer</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 24 }, (_, h) => {
            const i = ((h + 1) * 60) / BUCKET_MINUTES;
            const past = (h + 1) * 60 <= ahora;
            return (
              <tr key={h}>
                <th scope="row">hasta las {minuteText((h + 1) * 60, false)}</th>
                <td>{past ? fmt(hoySerie[i] ?? 0) : "—"}</td>
                <td>{fmt(ayerSerie[i] ?? 0)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Una cifra grande que elige lo que dibuja la curva. */
function MetricButton({
  label,
  value,
  hoy,
  ayer,
  ayerText,
  active,
  onSelect,
}: {
  label: string;
  value: string;
  hoy: number;
  ayer: number;
  ayerText: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={cn(
        "relative flex min-w-0 flex-col items-start bg-white px-4 py-3 text-left transition-colors duration-150 hover:bg-wash",
        "outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600",
        active && "z-10 ring-2 ring-inset ring-brand-600 hover:bg-white",
      )}
    >
      <span className="text-[13px] font-medium leading-5 text-ink-600">{label}</span>
      <span className="mt-0.5 text-[28px] font-semibold leading-9 tracking-[-0.01em] text-ink-900 sm:text-[32px] sm:leading-10">{value}</span>
      <Change hoy={hoy} ayer={ayer} />
      <span className="mt-0.5 text-xs leading-4 text-ink-500">{ayerText}</span>
    </button>
  );
}

export function TodayPulse({ initial, currency }: { initial: TodaySales; currency: string }) {
  const [data, setData] = useState(initial);
  const [metric, setMetric] = useState<Metric>("ingresos");
  const [failedAt, setFailedAt] = useState<string | null>(null);
  const lastFetch = useRef(Date.now());
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    lastFetch.current = Date.now();
    try {
      const res = await fetch("/api/dashboard/hoy", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as TodaySales);
      setFailedAt(null);
    } catch {
      setFailedAt(new Date().toISOString());
    } finally {
      busy.current = false;
    }
  }, []);

  // Cada minuto, solo con la pestaña a la vista; al volver a ella, si ya pasó el minuto.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastFetch.current >= REFRESH_MS) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const { total, timezone } = data;
  const many = data.stores.length > 1;
  const cancelled = total.cancelados;

  return (
    <section aria-labelledby="hoy-ventas" className={SECTION_CARD}>
      <SectionHead
        id="hoy-ventas"
        title="Hoy"
        help={
          <>
            {dayText(data.generatedAt, timezone)}
            {" · al corte "}
            {clockText(data.generatedAt, timezone)}
            {" · contra ayer a esta hora"}
          </>
        }
        aside={
          failedAt ? (
            <span role="status" className="text-[13px] leading-5 text-warn-fg">
              No se pudo actualizar a las {clockText(failedAt, timezone)}; se reintenta solo
            </span>
          ) : undefined
        }
      />

      {/* En el teléfono: cifras, curva, tiendas. Desde 1024 px, cifras y tiendas
          en una columna a la izquierda y la curva a la derecha, para que la
          tarjeta sea corta y las cifras del periodo sigan a la vista. */}
      <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(260px,300px)_minmax(0,1fr)] lg:gap-x-8">
        <div className="grid grid-cols-2 gap-px self-start overflow-hidden rounded-lg bg-line shadow-control ring-1 ring-line lg:col-start-1 lg:row-start-1 lg:grid-cols-1">
          <MetricButton
            label="Ventas"
            value={money(total.hoy.ingresos, currency)}
            hoy={total.hoy.ingresos}
            ayer={total.ayerAEstaHora.ingresos}
            ayerText={`ayer a esta hora ${money(total.ayerAEstaHora.ingresos, currency)}`}
            active={metric === "ingresos"}
            onSelect={() => setMetric("ingresos")}
          />
          <MetricButton
            label="Pedidos"
            value={nf(total.hoy.pedidos)}
            hoy={total.hoy.pedidos}
            ayer={total.ayerAEstaHora.pedidos}
            ayerText={`ayer a esta hora ${nf(total.ayerAEstaHora.pedidos)}`}
            active={metric === "pedidos"}
            onSelect={() => setMetric("pedidos")}
          />
        </div>

        <div className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h4 className="text-sm font-semibold leading-5 text-ink-900">
              {metric === "ingresos" ? "Ventas acumuladas del día" : "Pedidos acumulados del día"}
            </h4>
            <div className="flex items-center gap-3 text-xs leading-4 text-ink-600">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-0 w-4 border-t-[2.5px]" style={{ borderColor: VIZ.brand }} />
                Hoy
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-0 w-4 border-t-2 border-dashed" style={{ borderColor: VIZ.ink300 }} />
                Ayer
              </span>
            </div>
          </div>
          {total.hoy.pedidos === 0 && (
            <p className="mt-1 text-[13px] leading-5 text-ink-500">
              Todavía no hay pedidos hoy
              {total.ayerAEstaHora.pedidos ? ` · ayer a esta hora iban ${nf(total.ayerAEstaHora.pedidos)}` : ""}.
            </p>
          )}
          <div className="mt-2">
            <PulseChart data={data} metric={metric} currency={currency} />
          </div>
        </div>

        {many && (
          <table className="w-full self-start text-sm lg:col-start-1 lg:row-start-2">
            <caption className="sr-only">Hoy por tienda, contra ayer a esta hora</caption>
            <thead>
              <tr className="border-b border-line text-left text-xs font-semibold leading-4 text-ink-600">
                <th scope="col" className="py-2 pr-3 font-semibold">Tienda</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Ventas</th>
                <th scope="col" className="py-2 pl-3 text-right font-semibold">Pedidos</th>
              </tr>
            </thead>
            <tbody>
              {data.stores.map((s) => (
                <StoreRow key={s.storeId} name={s.name} hoy={s.hoy} ayer={s.ayerAEstaHora} currency={currency} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {cancelled.pedidos > 0 && (
        <p className="mt-4 text-xs leading-4 text-ink-500">
          {nf(cancelled.pedidos)} {cancelled.pedidos === 1 ? "pedido de hoy ya está cancelado" : "pedidos de hoy ya están cancelados"} (
          {money(cancelled.ingresos, currency)}): no cuentan en estas cifras.
        </p>
      )}
    </section>
  );
}

function StoreRow({ name, hoy, ayer, currency }: { name: string; hoy: SalesFigure; ayer: SalesFigure; currency: string }) {
  return (
    <tr className="border-b border-line align-top last:border-0">
      <th scope="row" className="py-2.5 pr-3 text-left font-medium text-ink-900">{name}</th>
      <td className="px-3 py-2.5 text-right">
        <span className="block font-semibold tabular-nums text-ink-900">{money(hoy.ingresos, currency)}</span>
        <Change hoy={hoy.ingresos} ayer={ayer.ingresos} size="sm" withLabel={false} />
      </td>
      <td className="py-2.5 pl-3 text-right">
        <span className="block font-semibold tabular-nums text-ink-900">{nf(hoy.pedidos)}</span>
        <Change hoy={hoy.pedidos} ayer={ayer.pedidos} size="sm" withLabel={false} />
      </td>
    </tr>
  );
}

export function TodayPulseSkeleton() {
  return (
    <section aria-label="Cargando las ventas de hoy" aria-busy="true" className={SECTION_CARD}>
      <Skeleton className="h-5 w-16" />
      <Skeleton className="mt-2 h-4 w-72 max-w-full" />
      <div className="mt-5 grid grid-cols-2 gap-3">
        <Skeleton className="h-[104px]" />
        <Skeleton className="h-[104px]" />
      </div>
      <Skeleton className="mt-5 h-[196px]" />
    </section>
  );
}
