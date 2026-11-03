"use client";

// «Cómo van las ventas» del Consolidado (MOM §17.5, DESIGN.md › Consolidado):
// arriba de todo, hoy, esta semana o este mes contra el periodo anterior a esta
// misma altura, para leerlo de un vistazo en el teléfono. Tres pestañas eligen
// el periodo; dos cifras eligen lo que dibuja la curva (The Cifras Navegan
// Rule); la curva acumulada del periodo contra el anterior entero, una línea
// por tienda y los cancelados aparte. La pestaña a la vista se relee sola cada
// minuto; si un refresco falla, quedan las últimas cifras y lo dice.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/components/ui";
import { Banner, OpsButton, SECTION_CARD, SectionHead, Skeleton } from "@/components/ops-ui";
import { IconArrowDown, IconArrowUp } from "@/components/icons";
import { VIZ } from "@/components/palette";
import { BUCKET_MINUTES, DAY_MINUTES, changeRatio, type SalesFigure } from "@/lib/today-sales";
import { PULSE_PERIODS, type PulsePeriod, type PulseSlot, type SalesPulse } from "@/lib/sales-pulse";
import { localClock } from "@/lib/local-day";

type Metric = "ingresos" | "pedidos";

const REFRESH_MS = 60_000;

const TAB_LABEL: Record<PulsePeriod, string> = { hoy: "Hoy", semana: "Esta semana", mes: "Este mes" };
const DE: Record<PulsePeriod, string> = { hoy: "de hoy", semana: "de esta semana", mes: "de este mes" };

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

/** «S/ 22,100»: la moneda de la tienda, sin decimales; el espacio no parte el renglón. */
function money(n: number, currency: string): string {
  return `${SYMBOL[currency] ?? currency}\u00a0${nf(n)}`;
}

/** El eje: «50 k», «2.5 k», «800», «1.2 M». */
function axis(v: number): string {
  if (v < 1000) return nf(v);
  if (v >= 1_000_000) return `${String(Math.round((v / 1_000_000) * 10) / 10)} M`;
  const k = Math.round((v / 1000) * 10) / 10;
  return `${String(k)} k`;
}

const valueText = (metric: Metric, n: number, currency: string) => (metric === "ingresos" ? money(n, currency) : nf(n));

/** «4:52 p. m.» en la zona de las tiendas. */
function clockText(iso: string, timeZone: string): string {
  return minuteText(localClock(iso, timeZone).minute);
}

const WEEKDAYS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const WEEK_SHORT = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "setiembre", "octubre", "noviembre", "diciembre"];

const dateParts = (date: string) => date.split("-").map(Number) as [number, number, number];
const monthName = (date: string) => MONTHS[dateParts(date)[1] - 1]!;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** «Domingo 25 de octubre». */
function dateText(date: string): string {
  const [y, m, d] = dateParts(date);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} de ${MONTHS[m - 1]}`;
}

/** «Del 19 al 25 de octubre», «Del 28 de setiembre al 4 de octubre»; un solo día, «Lunes 19 de octubre». */
function rangeText(desde: string, hasta: string): string {
  if (desde === hasta) return dateText(desde);
  const [, m1, d1] = dateParts(desde);
  const [, m2, d2] = dateParts(hasta);
  return m1 === m2 ? `Del ${d1} al ${d2} de ${MONTHS[m2 - 1]}` : `Del ${d1} de ${MONTHS[m1 - 1]} al ${d2} de ${MONTHS[m2 - 1]}`;
}

/** Los minutos desde la medianoche, como reloj: 0 → «12 a. m.», 945 → «3:45 p. m.». */
function minuteText(minute: number, withMinutes = true): string {
  const m = ((minute % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const suffix = h < 12 ? "a. m." : "p. m.";
  return withMinutes && mm ? `${h12}:${String(mm).padStart(2, "0")} ${suffix}` : `${h12} ${suffix}`;
}

/** Cómo se dice cada periodo y su anterior. */
interface Words {
  /** La leyenda: «Hoy» / «Ayer», «Esta semana» / «Semana pasada», «Octubre» / «Setiembre». */
  actual: string;
  anterior: string;
  /** Las filas del cursor: «hoy» / «ayer»… */
  filaActual: string;
  filaAnterior: string;
  vs: string;
  igual: string;
  /** Contra qué compara: «ayer a esta hora», «setiembre completo»… */
  ref: string;
  /** «del día», «de la semana», «del mes». */
  del: string;
  /** «de hoy», «de esta semana», «de este mes». */
  de: string;
  /** «hoy», «esta semana», «este mes». */
  este: string;
}

function wordsFor(p: SalesPulse): Words {
  if (p.periodo === "hoy") {
    return {
      actual: "Hoy",
      anterior: "Ayer",
      filaActual: "hoy",
      filaAnterior: "ayer",
      vs: "vs ayer",
      igual: "igual que ayer",
      ref: "ayer a esta hora",
      del: "del día",
      de: DE.hoy,
      este: "hoy",
    };
  }
  if (p.periodo === "semana") {
    return {
      actual: "Esta semana",
      anterior: "Semana pasada",
      filaActual: "esta semana",
      filaAnterior: "semana pasada",
      vs: "vs semana pasada",
      igual: "igual que la semana pasada",
      ref: "la semana pasada a esta altura",
      del: "de la semana",
      de: DE.semana,
      este: "esta semana",
    };
  }
  const mes = monthName(p.desde);
  const antes = monthName(p.anteriorDesde);
  return {
    actual: capitalize(mes),
    anterior: capitalize(antes),
    filaActual: mes,
    filaAnterior: antes,
    vs: `vs ${antes}`,
    igual: `igual que ${antes}`,
    ref: p.corte ? `${antes} a esta altura` : `${antes} completo`,
    del: "del mes",
    de: DE.mes,
    este: "este mes",
  };
}

/** Por qué no se compara: qué tienda no tiene todas sus ventas del periodo anterior. */
function whyNoCompare(p: SalesPulse): string {
  return p.stores
    .filter((s) => !s.comparable)
    .map((s) => {
      if (!s.piso) return `${s.name} todavía no tiene pedidos en Kapta`;
      const [, m, d] = dateParts(s.piso);
      return `Kapta tiene todas las ventas de ${s.name} desde el ${d} de ${MONTHS[m - 1]}`;
    })
    .join("; ");
}

/**
 * El cambio contra el periodo anterior a esta altura: flecha dibujada,
 * porcentaje y, si cabe, «vs ayer». Nunca solo el color. Sin nada en el
 * anterior no hay porcentaje; sin con qué comparar, lo dice.
 */
function Change({
  actual,
  anterior,
  comparable,
  words,
  size = "md",
  withLabel = true,
}: {
  actual: number;
  anterior: number;
  comparable: boolean;
  words: Words;
  size?: "md" | "sm";
  withLabel?: boolean;
}) {
  const text = size === "md" ? "text-[13px] leading-5" : "text-xs leading-4";
  if (!comparable) return <span className={cn(text, "text-ink-500")}>sin comparación</span>;
  const ratio = changeRatio(actual, anterior);
  if (ratio === null) {
    return <span className={cn(text, "text-ink-500")}>{actual ? `${words.ref} no había` : "sin ventas todavía"}</span>;
  }
  const pct = Math.round(Math.abs(ratio) * 100);
  if (pct === 0) return <span className={cn(text, "text-ink-500")}>{words.igual}</span>;
  const up = ratio > 0;
  const Arrow = up ? IconArrowUp : IconArrowDown;
  return (
    <span className={cn(text, "inline-flex max-w-full flex-wrap items-center gap-x-1")}>
      <span className={cn("inline-flex items-center gap-0.5 whitespace-nowrap font-semibold tabular-nums", up ? "text-ok-fg" : "text-crit-fg")}>
        <Arrow className={size === "md" ? "size-3.5" : "size-3"} strokeWidth={2.4} aria-hidden />
        <span className="sr-only">{up ? "subió" : "bajó"}</span>
        {pct}
        {" %"}
      </span>
      {withLabel && <span className="whitespace-nowrap text-ink-500">{words.vs}</span>}
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

/** Lo que dice el cursor arriba: la hora (hoy) o hasta qué día (semana y mes). */
function slotTitle(data: SalesPulse, slot: PulseSlot): string {
  if (data.curva.unidad === "minuto") return `A las ${minuteText(slot.x)}`;
  if (slot.indice === data.curva.slotAhora) return `Hasta hoy, ${clockText(data.generatedAt, data.timezone)}`;
  return data.periodo === "semana" ? `Hasta el ${WEEKDAYS[(slot.indice + 1) % 7]!.toLowerCase()}` : `Hasta el día ${slot.indice + 1}`;
}

/** Las marcas del eje: cinco horas, los siete días o cinco días del mes (menos donde no caben). */
function xTicks(data: SalesPulse, W: number): { x: number; label: string; anchor: "start" | "middle" | "end" }[] {
  if (data.curva.unidad === "minuto") {
    const ms = W >= 300 ? [0, 360, 720, 1080, 1440] : [0, 720, 1440];
    return ms.map((m, i) => ({ x: m, label: minuteText(m, false), anchor: i === 0 ? "start" : i === ms.length - 1 ? "end" : "middle" }));
  }
  if (data.periodo === "semana") return WEEK_SHORT.map((label, k) => ({ x: k + 0.5, label, anchor: "middle" }));
  const days = (W >= 300 ? [1, 8, 15, 22, 29] : [1, 15, 29]).filter((d) => d <= data.curva.largo);
  return days.map((d) => ({ x: d - 0.5, label: String(d), anchor: "middle" }));
}

/**
 * La curva acumulada del periodo: lo de ahora en azul hasta el corte, el
 * anterior entero punteado en tinta clara. Al pasar el cursor (o con las
 * flechas del teclado), una raya y las dos cifras de esa hora o de ese día.
 */
function PulseChart({ data, metric, currency, words }: { data: SalesPulse; metric: Metric; currency: string; words: Words }) {
  const [boxRef, W] = useWidth<HTMLDivElement>(600);
  const [hover, setHover] = useState<number | null>(null);
  // Al lado de las cifras (desde 1024 px) la curva tiene más ancho y crece en alto.
  const H = W >= 560 ? 236 : 196;
  const L = 44;
  const R = 14;
  const T = 12;
  const B = 24;
  const { curva, total, comparable } = data;
  const slots = curva.slots;
  const lastSlot = slots.length - 1;
  const val = (p: { pedidos: number; ingresos: number }) => p[metric];
  const actualNow = total.actual[metric];
  const anteriorNow = total.anterior[metric];

  const x = (u: number) => L + (u / curva.largo) * (W - L - R);
  const top = niceTop(
    Math.max(1, actualNow, ...curva.actual.map(val), ...(comparable ? [total.anteriorCompleto[metric], ...curva.anterior.map(val)] : [])),
  );
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const yTicks = [0, top / 2, top];
  const ticks = xTicks(data, W);
  const path = (pts: { x: number; pedidos: number; ingresos: number }[]) =>
    pts.map((p, i) => `${i ? "L" : "M"}${x(p.x).toFixed(1)} ${y(val(p)).toFixed(1)}`).join(" ");
  const area = `${path(curva.actual)} L${x(curva.ahora).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`;

  const fmt = (v: number) => valueText(metric, v, currency);
  const slot = hover != null ? slots[hover] : undefined;
  const byDay = curva.unidad === "dia";

  const pick = (clientX: number, el: Element) => {
    const rect = el.getBoundingClientRect();
    const u = ((clientX - rect.left - L) / (W - L - R)) * curva.largo;
    // Hoy: el cuarto de hora más cercano. Semana y mes: el día bajo el cursor.
    const i = byDay ? Math.floor(u) : Math.round(u / BUCKET_MINUTES);
    setHover(Math.min(lastSlot, Math.max(0, i)));
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = byDay ? 1 : 60 / BUCKET_MINUTES;
    const cur = hover ?? curva.slotAhora;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = cur - step;
    else if (e.key === "ArrowRight") next = cur + step;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = curva.slotAhora;
    else if (e.key === "Escape") return setHover(null);
    if (next == null) return;
    e.preventDefault();
    setHover(Math.min(lastSlot, Math.max(0, next)));
  };

  const label = metric === "ingresos" ? "Ventas acumuladas" : "Pedidos acumulados";
  const compareText = comparable ? `, ${words.ref} ${fmt(anteriorNow)}` : "";

  return (
    <div
      ref={boxRef}
      className="relative w-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
      tabIndex={0}
      role="group"
      aria-label={`${label} ${words.del}: ${words.este} ${fmt(actualNow)}${compareText}. Usa las flechas para recorrer ${byDay ? "los días" : "las horas"}.`}
      onKeyDown={onKey}
      onFocus={() => setHover((h) => h ?? curva.slotAhora)}
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
        {ticks.map((t) => (
          <text key={t.x} x={x(t.x)} y={H - 6} textAnchor={t.anchor} fontSize="11" fill={VIZ.ink500}>
            {t.label}
          </text>
        ))}
        {comparable && (
          <path d={path(curva.anterior)} fill="none" stroke={VIZ.ink300} strokeWidth={2} strokeDasharray="5 4" strokeLinejoin="round" />
        )}
        <path d={area} fill={VIZ.brand} fillOpacity={0.08} />
        <line x1={x(curva.ahora)} x2={x(curva.ahora)} y1={T} y2={H - B} stroke={VIZ.brand} strokeDasharray="3 3" strokeOpacity={0.55} />
        <path d={path(curva.actual)} fill="none" stroke={VIZ.brand} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        {comparable && <circle cx={x(curva.corte)} cy={y(anteriorNow)} r={4} fill={VIZ.ink300} stroke="#fff" strokeWidth={2} />}
        <circle cx={x(curva.ahora)} cy={y(actualNow)} r={5} fill={VIZ.brand} stroke="#fff" strokeWidth={2} />
        {slot && (
          <g>
            <line x1={x(slot.x)} x2={x(slot.x)} y1={T} y2={H - B} stroke={VIZ.ink300} />
            {slot.anterior && <circle cx={x(slot.x)} cy={y(slot.anterior[metric])} r={4} fill={VIZ.ink300} stroke="#fff" strokeWidth={2} />}
            {slot.actual && <circle cx={x(slot.x)} cy={y(slot.actual[metric])} r={4} fill={VIZ.brand} stroke="#fff" strokeWidth={2} />}
          </g>
        )}
      </svg>
      {slot && (
        <div
          className="pointer-events-none absolute top-0 z-10 min-w-36 whitespace-nowrap rounded-md bg-white px-3 py-2 text-xs leading-5 shadow-pop"
          style={x(slot.x) > W / 2 ? { right: W - x(slot.x) + 10 } : { left: x(slot.x) + 10 }}
        >
          <p className="text-ink-500">{slotTitle(data, slot)}</p>
          {slot.actual && (
            <p className="flex items-center gap-2">
              <span aria-hidden className="h-0 w-3 border-t-[2.5px]" style={{ borderColor: VIZ.brand }} />
              <span className="font-semibold tabular-nums text-ink-900">{fmt(slot.actual[metric])}</span>
              <span className="text-ink-600">{words.filaActual}</span>
            </p>
          )}
          {slot.anterior && (
            <p className="flex items-center gap-2">
              <span aria-hidden className="h-0 w-3 border-t-2 border-dashed" style={{ borderColor: VIZ.ink300 }} />
              <span className="font-semibold tabular-nums text-ink-900">{fmt(slot.anterior[metric])}</span>
              <span className="text-ink-600">{words.filaAnterior}</span>
            </p>
          )}
        </div>
      )}
      {/* La misma curva, hora por hora o día por día, para quien no ve el gráfico. */}
      <table className="sr-only">
        <caption>
          {label} {byDay ? "por día" : "por hora"}, {words.filaActual}
          {comparable ? ` y ${words.filaAnterior}` : ""}
        </caption>
        <thead>
          <tr>
            <th scope="col">{byDay ? "Día" : "Hora"}</th>
            <th scope="col">{words.actual}</th>
            {comparable && <th scope="col">{words.anterior}</th>}
          </tr>
        </thead>
        <tbody>
          {(byDay ? slots : slots.filter((s) => s.indice > 0 && s.indice % (60 / BUCKET_MINUTES) === 0)).map((s) => (
            <tr key={s.indice}>
              <th scope="row">{byDay ? slotTitle(data, s) : `hasta las ${minuteText(s.x, false)}`}</th>
              <td>{s.actual ? fmt(s.actual[metric]) : "—"}</td>
              {comparable && <td>{s.anterior ? fmt(s.anterior[metric]) : "—"}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * En el teléfono las dos cifras van lado a lado en ~130 px: la de la semana o
 * el mes («S/ 1,019,031») no cabe a 28 px y partía en dos renglones. Baja un
 * paso según lo larga que sea; desde 640 px todas van a 32 px.
 */
function valueSize(value: string): string {
  if (value.length <= 9) return "text-[28px] leading-9";
  if (value.length <= 12) return "text-[22px] leading-9";
  return "text-[19px] leading-9";
}

/** Una cifra grande que elige lo que dibuja la curva. */
function MetricButton({
  label,
  value,
  change,
  sub,
  active,
  onSelect,
}: {
  label: string;
  value: string;
  change: ReactNode;
  sub: string | null;
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
      <span className={cn("mt-0.5 whitespace-nowrap font-semibold tracking-[-0.01em] text-ink-900 sm:text-[32px] sm:leading-10", valueSize(value))}>{value}</span>
      {change}
      {sub && <span className="mt-0.5 text-xs leading-4 text-ink-500">{sub}</span>}
    </button>
  );
}

/**
 * Hoy, esta semana o este mes: control segmentado (DESIGN.md › Control
 * segmentado). Las flechas mueven entre pestañas y eligen; al acercarse a una
 * pestaña se lee su periodo, para que el cambio sea inmediato.
 */
function PeriodTabs({
  value,
  panelId,
  onSelect,
  onPrefetch,
}: {
  value: PulsePeriod;
  panelId: string;
  onSelect: (p: PulsePeriod) => void;
  onPrefetch: (p: PulsePeriod) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = PULSE_PERIODS.length;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (i + 1) % n;
    else if (e.key === "ArrowLeft") next = (i - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next == null) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onSelect(PULSE_PERIODS[next]!);
  };
  return (
    <div role="tablist" aria-label="Periodo de las ventas" className="grid grid-cols-3 gap-0.5 rounded-lg bg-wash p-0.5 ring-1 ring-inset ring-line">
      {PULSE_PERIODS.map((p, i) => {
        const active = p === value;
        return (
          <button
            key={p}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`pulso-tab-${p}`}
            aria-selected={active}
            aria-controls={panelId}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(p)}
            onKeyDown={(e) => onKey(e, i)}
            onPointerEnter={() => onPrefetch(p)}
            onFocus={() => onPrefetch(p)}
            className={cn(
              "h-9 whitespace-nowrap rounded-md px-3 text-sm font-semibold outline-none transition-[background-color,color,box-shadow] duration-150",
              "focus-visible:ring-2 focus-visible:ring-brand-600",
              active ? "bg-white text-ink-900 shadow-control ring-1 ring-line" : "text-ink-500 hover:text-ink-900",
            )}
          >
            {TAB_LABEL[p]}
          </button>
        );
      })}
    </div>
  );
}

/** Lo que dice la cabecera bajo el título: el periodo, el corte y contra qué compara. */
function helpLine(data: SalesPulse, words: Words): string {
  const range = data.periodo === "hoy" ? dateText(data.fecha) : rangeText(data.desde, data.fecha);
  const compare = data.comparable ? `contra ${words.ref}` : `sin comparación: ${whyNoCompare(data)}`;
  return `${range} · al corte ${clockText(data.generatedAt, data.timezone)} · ${compare}`;
}

function PulseBody({
  data,
  currency,
  metric,
  setMetric,
}: {
  data: SalesPulse;
  currency: string;
  metric: Metric;
  setMetric: (m: Metric) => void;
}) {
  const words = wordsFor(data);
  const { total, comparable } = data;
  const many = data.stores.length > 1;
  const cancelled = total.cancelados;
  const sub = (v: string) => (comparable ? `${words.ref} ${v}` : null);

  return (
    <>
      {/* En el teléfono: cifras, curva, tiendas. Desde 1024 px, cifras y tiendas
          en una columna a la izquierda y la curva a la derecha, para que la
          tarjeta sea corta y las cifras del periodo sigan a la vista. */}
      <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(260px,300px)_minmax(0,1fr)] lg:gap-x-8">
        <div className="grid grid-cols-2 gap-px self-start overflow-hidden rounded-lg bg-line shadow-control ring-1 ring-line lg:col-start-1 lg:row-start-1 lg:grid-cols-1">
          <MetricButton
            label="Ventas"
            value={money(total.actual.ingresos, currency)}
            change={<Change actual={total.actual.ingresos} anterior={total.anterior.ingresos} comparable={comparable} words={words} />}
            sub={sub(money(total.anterior.ingresos, currency))}
            active={metric === "ingresos"}
            onSelect={() => setMetric("ingresos")}
          />
          <MetricButton
            label="Pedidos"
            value={nf(total.actual.pedidos)}
            change={<Change actual={total.actual.pedidos} anterior={total.anterior.pedidos} comparable={comparable} words={words} />}
            sub={sub(nf(total.anterior.pedidos))}
            active={metric === "pedidos"}
            onSelect={() => setMetric("pedidos")}
          />
        </div>

        <div className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h4 className="text-sm font-semibold leading-5 text-ink-900">
              {metric === "ingresos" ? "Ventas acumuladas" : "Pedidos acumulados"} {words.del}
            </h4>
            <div className="flex items-center gap-3 text-xs leading-4 text-ink-600">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-0 w-4 border-t-[2.5px]" style={{ borderColor: VIZ.brand }} />
                {words.actual}
              </span>
              {comparable && (
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="h-0 w-4 border-t-2 border-dashed" style={{ borderColor: VIZ.ink300 }} />
                  {words.anterior}
                </span>
              )}
            </div>
          </div>
          {total.actual.pedidos === 0 && (
            <p className="mt-1 text-[13px] leading-5 text-ink-500">
              Todavía no hay pedidos {words.este}
              {comparable && total.anterior.pedidos ? ` · ${words.ref} iban ${nf(total.anterior.pedidos)}` : ""}.
            </p>
          )}
          <div className="mt-2">
            <PulseChart key={data.periodo} data={data} metric={metric} currency={currency} words={words} />
          </div>
        </div>

        {many && (
          <table className="w-full self-start text-sm lg:col-start-1 lg:row-start-2">
            <caption className="sr-only">
              {capitalize(words.este)} por tienda{comparable ? `, contra ${words.ref}` : ""}
            </caption>
            <thead>
              <tr className="border-b border-line text-left text-xs font-semibold leading-4 text-ink-600">
                <th scope="col" className="py-2 pr-3 font-semibold">Tienda</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Ventas</th>
                <th scope="col" className="py-2 pl-3 text-right font-semibold">Pedidos</th>
              </tr>
            </thead>
            <tbody>
              {data.stores.map((s) => (
                <tr key={s.storeId} className="border-b border-line align-top last:border-0">
                  <th scope="row" className="py-2.5 pr-3 text-left font-medium text-ink-900">{s.name}</th>
                  <td className="px-3 py-2.5 text-right">
                    <span className="block font-semibold tabular-nums text-ink-900">{money(s.actual.ingresos, currency)}</span>
                    <Change actual={s.actual.ingresos} anterior={s.anterior.ingresos} comparable={s.comparable} words={words} size="sm" withLabel={false} />
                  </td>
                  <td className="py-2.5 pl-3 text-right">
                    <span className="block font-semibold tabular-nums text-ink-900">{nf(s.actual.pedidos)}</span>
                    <Change actual={s.actual.pedidos} anterior={s.anterior.pedidos} comparable={s.comparable} words={words} size="sm" withLabel={false} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {cancelled.pedidos > 0 && (
        <p className="mt-4 text-xs leading-4 text-ink-500">
          {nf(cancelled.pedidos)} {cancelled.pedidos === 1 ? `pedido ${words.de} ya está cancelado` : `pedidos ${words.de} ya están cancelados`}
          {cancelled.ingresos != null ? ` (${money(cancelled.ingresos, currency)})` : ""}: no cuentan en estas cifras.
        </p>
      )}
    </>
  );
}

function BodySkeleton() {
  return (
    <div aria-hidden>
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-[minmax(260px,300px)_minmax(0,1fr)]">
        <Skeleton className="h-[104px]" />
        <Skeleton className="h-[104px]" />
      </div>
      <Skeleton className="mt-5 h-[196px]" />
    </div>
  );
}

export function SalesPulseCard({ initial, currency }: { initial: SalesPulse; currency: string }) {
  const [periodo, setPeriodo] = useState<PulsePeriod>(initial.periodo);
  // La cifra elegida sigue al cambiar de pestaña: quien mira pedidos, sigue en pedidos.
  const [metric, setMetric] = useState<Metric>("ingresos");
  const [datos, setDatos] = useState<Partial<Record<PulsePeriod, SalesPulse>>>({ [initial.periodo]: initial });
  const [fallo, setFallo] = useState<Partial<Record<PulsePeriod, string>>>({});
  const leidoEn = useRef<Partial<Record<PulsePeriod, number>>>({ [initial.periodo]: Date.now() });
  const ocupado = useRef(new Set<PulsePeriod>());
  const vista = useRef(periodo);
  useEffect(() => {
    vista.current = periodo;
  }, [periodo]);

  const leer = useCallback(async (p: PulsePeriod) => {
    if (ocupado.current.has(p)) return;
    ocupado.current.add(p);
    leidoEn.current[p] = Date.now();
    try {
      const res = await fetch(`/api/dashboard/pulso?periodo=${p}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as SalesPulse;
      setDatos((d) => ({ ...d, [p]: json }));
      setFallo((f) => {
        const next = { ...f };
        delete next[p];
        return next;
      });
    } catch {
      setFallo((f) => ({ ...f, [p]: new Date().toISOString() }));
    } finally {
      ocupado.current.delete(p);
    }
  }, []);

  const stale = useCallback((p: PulsePeriod) => Date.now() - (leidoEn.current[p] ?? 0) >= REFRESH_MS, []);

  // La pestaña elegida, cada minuto y solo con la del navegador a la vista; al
  // volver a ella, si ya pasó el minuto.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void leer(vista.current);
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && stale(vista.current)) void leer(vista.current);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [leer, stale]);

  const select = (p: PulsePeriod) => {
    setPeriodo(p);
    if (!datos[p] || stale(p)) void leer(p);
  };
  const prefetch = (p: PulsePeriod) => {
    if (!datos[p] && !fallo[p]) void leer(p);
  };

  const data = datos[periodo];
  const failedAt = fallo[periodo];
  const panelId = "pulso-panel";

  return (
    <section aria-labelledby="pulso-ventas" className={SECTION_CARD}>
      <SectionHead
        id="pulso-ventas"
        title="Cómo van las ventas"
        help={
          data ? (
            <>
              {helpLine(data, wordsFor(data))}
              {failedAt && (
                <span role="status" className="block text-warn-fg">
                  No se pudo actualizar a las {clockText(failedAt, data.timezone)}; se reintenta solo
                </span>
              )}
            </>
          ) : undefined
        }
        aside={<PeriodTabs value={periodo} panelId={panelId} onSelect={select} onPrefetch={prefetch} />}
      />

      <div role="tabpanel" id={panelId} aria-labelledby={`pulso-tab-${periodo}`} aria-busy={!data && !failedAt}>
        {data ? (
          <PulseBody data={data} currency={currency} metric={metric} setMetric={setMetric} />
        ) : failedAt ? (
          <Banner tone="warn" role="status" title={`No se pudieron leer las ventas ${DE[periodo]}`} className="mt-4">
            <p>Las otras pestañas siguen disponibles.</p>
            <OpsButton size="sm" className="mt-2" onClick={() => void leer(periodo)}>
              Reintentar
            </OpsButton>
          </Banner>
        ) : (
          <BodySkeleton />
        )}
      </div>
    </section>
  );
}

export function SalesPulseSkeleton() {
  return (
    <section aria-label="Cargando cómo van las ventas" aria-busy="true" className={SECTION_CARD}>
      <Skeleton className="h-5 w-44" />
      <Skeleton className="mt-2 h-4 w-72 max-w-full" />
      <div className="mt-5 grid grid-cols-2 gap-3">
        <Skeleton className="h-[104px]" />
        <Skeleton className="h-[104px]" />
      </div>
      <Skeleton className="mt-5 h-[196px]" />
    </section>
  );
}
