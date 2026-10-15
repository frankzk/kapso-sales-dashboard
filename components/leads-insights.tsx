"use client";

// El «Tablero de hoy» de Leads, opción K (Frankz, 15-10-2026): el equipo como
// ranking contra ayer a esta misma hora, con las horas activas contra la meta
// del día; a la derecha, los leads sin llamar por día (filtran la cola) y la
// carrera de pedidos del día. DESIGN.md › Leads › Tablero de hoy.

import Link from "next/link";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { IconArrowDown, IconArrowUp, IconChevronDown, IconChevronRight } from "@/components/icons";
import { Badge, opsButtonClass } from "@/components/ops-ui";
import { VIZ } from "@/components/palette";
import { cn } from "@/components/ui";
import type { LeadsInsights } from "@/lib/leads-insights";
// Del módulo puro: el componente no arrastra la lectura ni el cliente de servicio.
import { CIERRE_MIN_LEADS, type TeamRace, type TeamRow, type TeamToday } from "@/lib/leads-team-today";
import type { LeadInteractionDateFilter } from "@/lib/leads";

const n = (v: number) => v.toLocaleString("es-PE");
const pct = (pedidos: number, leads: number) => Math.round((pedidos / leads) * 100);
const hoursText = (h: number) => (Number.isInteger(h) ? String(h) : h.toFixed(1));

function fmtDelay(min: number): string {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

const CARD = "flex min-w-0 flex-col rounded-lg bg-white p-4 shadow-control ring-1 ring-line sm:p-5";

function Head({ id, title, figure, sub, aside }: { id?: string; title: string; figure?: ReactNode; sub?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-3">
      <div className="min-w-0 flex-1 basis-60">
        <h3 id={id} className="text-[13px] font-medium leading-5 text-ink-600">
          {title}
        </h3>
        {figure != null && <p className="mt-0.5 text-xl font-semibold leading-7 tabular-nums text-ink-900">{figure}</p>}
        {sub != null && <p className="mt-0.5 text-xs leading-4 text-ink-500">{sub}</p>}
      </div>
      {aside}
    </div>
  );
}

/** «+13 vs. ayer a esta hora» en verde, «−5 …» en rojo, «igual que ayer…» en gris. */
function DeltaPhrase({ v }: { v: number }) {
  if (v === 0) return <span className="text-ink-500">igual que ayer a esta hora</span>;
  return (
    <span className={v > 0 ? "text-ok-fg" : "text-crit-fg"}>
      {v > 0 ? "+" : "−"}
      {n(Math.abs(v))} vs. ayer a esta hora
    </span>
  );
}

/** La diferencia de una fila: flecha y número, nunca solo el color. */
function Delta({ v }: { v: number }) {
  if (v === 0) {
    return (
      <span className="text-ink-500" title="Igual que ayer a esta hora">
        =
      </span>
    );
  }
  const Arrow = v > 0 ? IconArrowUp : IconArrowDown;
  return (
    <span
      className={cn("inline-flex items-center justify-end gap-0.5 tabular-nums", v > 0 ? "text-ok-fg" : "text-crit-fg")}
      title={`${v > 0 ? "+" : "−"}${Math.abs(v)} contra ayer a esta hora`}
    >
      <Arrow className="size-3" strokeWidth={2.4} aria-hidden />
      <span className="sr-only">{v > 0 ? "más" : "menos"}</span>
      {Math.abs(v)}
    </span>
  );
}

function Bar({ value, className, fill = "bg-ink-600" }: { value: number | null; className?: string; fill?: string }) {
  return (
    <span className={cn("block h-1.5 shrink-0 overflow-hidden rounded-full bg-line", className)} aria-hidden>
      {value != null && value > 0 && (
        <span className={cn("block h-full rounded-full", fill)} style={{ width: `${Math.min(100, Math.max(2, value))}%` }} />
      )}
    </span>
  );
}

const CIERRE_HINT = `Con menos de ${CIERRE_MIN_LEADS} leads trabajados el % de cierre todavía no dice nada.`;

function Cierre({ pedidos, leads, bar = true }: { pedidos: number; leads: number; bar?: boolean }) {
  const c = leads >= CIERRE_MIN_LEADS ? pct(pedidos, leads) : null;
  return (
    <span className="flex items-center justify-end gap-2">
      {bar && <Bar value={c} className="hidden w-20 @3xl:block" />}
      <span
        className={cn("w-10 text-right tabular-nums", c == null ? "text-ink-300" : "text-ink-900")}
        title={c == null ? CIERRE_HINT : `${pedidos} pedidos de ${leads} leads trabajados`}
      >
        {c == null ? "—" : `${c} %`}
      </span>
    </span>
  );
}

/** «8.9 / 8 h»: las horas activas de hoy contra su parte de la meta. */
function Horas({ row, compact = false }: { row: TeamRow; compact?: boolean }) {
  if (row.horas == null || row.metaDia == null) {
    return compact ? null : <span className="text-ink-300">—</span>;
  }
  if (row.metaDia <= 0) {
    return (
      <span className="text-xs tabular-nums text-ink-500">
        {hoursText(row.horas)} h · hoy no le toca
      </span>
    );
  }
  const ok = row.horas >= row.metaDia;
  return (
    <span className="flex items-center gap-2">
      {!compact && <Bar value={(row.horas / row.metaDia) * 100} className="w-24" fill={ok ? "bg-ok-fg" : "bg-brand-600"} />}
      <span className={cn("text-xs tabular-nums", ok ? "font-medium text-ok-fg" : "text-ink-700")}>
        {hoursText(row.horas)}
        <span className={ok ? "text-ok-fg" : "text-ink-500"}> / {hoursText(row.metaDia)} h</span>
      </span>
    </span>
  );
}

/** Los avisos del día contra su horario, con las palabras de Productividad. */
function Avisos({ row }: { row: TeamRow }) {
  return (
    <>
      {row.tardeMin != null && (
        <Badge tone="warn" wrap>
          Tarde {fmtDelay(row.tardeMin)}
        </Badge>
      )}
      {row.inactivaDesde != null && (
        <Badge tone="warn" wrap>
          Sin actividad desde {row.inactivaDesde}
        </Badge>
      )}
      {row.salioAntesMin != null && (
        <Badge tone="warn" wrap>
          Salió {fmtDelay(row.salioAntesMin)} antes
        </Badge>
      )}
    </>
  );
}

/** El número de pedidos abre cuáles son (código y fecha): hover en la
 *  computadora, toque para fijarlo; otro toque, Escape o un clic afuera lo cierran. */
function Pedidos({ row, open, onToggle }: { row: TeamRow; open: boolean; onToggle: (open: boolean) => void }) {
  if (!row.pedidosDetalle.length) {
    return <span className="text-base font-semibold tabular-nums text-ink-900">{row.pedidos}</span>;
  }
  return (
    <span className="group relative inline-block">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${row.pedidos} pedidos de ${row.name}: ver cuáles`}
        onClick={() => onToggle(!open)}
        onBlur={() => onToggle(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onToggle(false);
        }}
        className="rounded text-base font-semibold tabular-nums text-ink-900 underline decoration-ink-300 decoration-dotted underline-offset-4 hover:decoration-ink-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
      >
        {row.pedidos}
      </button>
      <span
        role="tooltip"
        className={cn(
          "absolute right-0 top-full z-20 mt-1 max-h-48 w-max min-w-[10rem] overflow-y-auto rounded-md bg-white p-2 text-left shadow-control ring-1 ring-line",
          open ? "block" : "hidden group-hover:block",
        )}
      >
        {row.pedidosDetalle.map((o, i) => (
          <span key={i} className="flex items-baseline justify-between gap-4 py-0.5">
            <span className="text-xs font-medium text-ink-900">{o.code ?? "Sin código aún"}</span>
            {o.fecha && <span className="text-[11px] tabular-nums text-ink-500">{o.fecha}</span>}
          </span>
        ))}
      </span>
    </span>
  );
}

// Las columnas siguen el ancho de la TARJETA (container queries), no el de la
// pantalla: con la barra lateral, a 1280 px la tarjeta mide unos 600 px.
//   • menos de 576 px: #, persona, pedidos, vs. ayer y cierre; las horas y las
//     llamadas bajan a la segunda línea de la persona;
//   • desde 576 px, las horas en su columna;
//   • desde 768 px, además la barra del cierre y las llamadas.
function TeamRowView({ row, rank, open, onToggle }: { row: TeamRow; rank: number; open: boolean; onToggle: (open: boolean) => void }) {
  const avisos = row.tardeMin != null || row.inactivaDesde != null || row.salioAntesMin != null;
  return (
    <tr className="align-middle">
      <td className="py-2.5 pr-2 tabular-nums text-ink-500">{rank}</td>
      <td className="py-2.5 pr-3">
        <span className="block truncate text-ink-900" title={row.name}>
          {row.name}
        </span>
        {/* La segunda línea: los avisos siempre; las horas y las llamadas solo
            mientras no tienen su columna. Sin avisos, desaparece entera. */}
        <div className={cn("mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-500", !avisos && "@3xl:hidden")}>
          <Avisos row={row} />
          <span className="@xl:hidden">
            <Horas row={row} compact />
          </span>
          <span className="tabular-nums @3xl:hidden">{row.llamadas} llam.</span>
        </div>
      </td>
      <td className="py-2.5 text-right">
        <Pedidos row={row} open={open} onToggle={onToggle} />
      </td>
      <td className="py-2.5 text-right text-xs">
        <Delta v={row.pedidos - row.pedidosAyer} />
      </td>
      <td className="py-2.5 pl-2 @xl:pl-3">
        <Cierre pedidos={row.pedidos} leads={row.leads} />
      </td>
      <td className="hidden py-2.5 pl-4 @xl:table-cell">
        <Horas row={row} />
      </td>
      <td className="hidden py-2.5 text-right tabular-nums text-ink-600 @3xl:table-cell">{row.llamadas}</td>
    </tr>
  );
}

function TeamCard({ team, href }: { team: TeamToday | null; href: string }) {
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  const [showQuiet, setShowQuiet] = useState(false);
  const label = team && !team.horasDeTodas ? "Mi productividad" : "Abrir Productividad";
  const aside = (
    <Link href={href} className={opsButtonClass("secondary", "sm", "shrink-0")}>
      {label}
      <IconChevronRight className="size-4" aria-hidden />
    </Link>
  );

  if (!team) {
    return (
      <section className={CARD}>
        <Head title="El equipo hoy" aside={aside} />
        <p className="mt-6 text-[13px] text-ink-500">No se pudo leer el equipo de hoy. El resto del tablero sigue al día.</p>
      </section>
    );
  }

  const { totals } = team;
  const empty = !team.rows.length && !team.quiet.length;
  const toggle = (id: string) => (open: boolean) => setOpenDetail((cur) => (open ? id : cur === id ? null : cur));
  const shown = showQuiet ? [...team.rows, ...team.quiet] : team.rows;

  return (
    <section className={cn(CARD, "@container")} aria-labelledby="equipo-hoy">
      <Head
        id="equipo-hoy"
        title="El equipo hoy"
        figure={
          empty ? undefined : (
            <>
              {n(totals.pedidos)} pedidos <span className="text-ink-300">·</span> <DeltaPhrase v={totals.pedidos - totals.pedidosAyer} />
            </>
          )
        }
        sub={
          empty
            ? undefined
            : `${n(totals.leads)} leads trabajados · ${totals.leads >= CIERRE_MIN_LEADS ? `${pct(totals.pedidos, totals.leads)} % de cierre` : "cierre aún sin base"} · a las ${team.nowLabel}`
        }
        aside={aside}
      />

      {empty ? (
        <p className="mt-6 text-[13px] text-ink-500">Todavía no hay leads trabajados ni pedidos registrados hoy.</p>
      ) : (
        <>
          <table className="mt-4 w-full table-fixed text-[13px] leading-5">
            <thead>
              <tr className="text-left text-xs text-ink-500">
                <th scope="col" className="w-6 pb-1.5 font-medium @xl:w-7">
                  #
                </th>
                <th scope="col" className="pb-1.5 font-medium">
                  Persona
                </th>
                <th scope="col" className="w-14 pb-1.5 text-right font-medium @xl:w-16">
                  Pedidos
                </th>
                <th scope="col" className="w-14 pb-1.5 text-right font-medium @xl:w-16" title="Contra lo que llevaba ayer a esta misma hora">
                  vs. ayer
                </th>
                <th scope="col" className="w-14 pb-1.5 pl-2 text-right font-medium @xl:w-16 @xl:pl-3 @3xl:w-36" title="Pedidos entre leads trabajados, como en Productividad">
                  Cierre
                </th>
                <th scope="col" className="hidden w-48 pb-1.5 pl-4 font-medium @xl:table-cell" title="Horas activas de hoy (bloques cortados en pausas de más de 45 min) contra su parte de la meta de la semana">
                  Horas activas / meta de hoy
                </th>
                <th scope="col" className="hidden w-14 pb-1.5 text-right font-medium @3xl:table-cell">
                  Llam.
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line border-t border-line">
              {shown.map((row, i) => (
                <TeamRowView key={row.userId} row={row} rank={i + 1} open={openDetail === row.userId} onToggle={toggle(row.userId)} />
              ))}
            </tbody>
            <tfoot className="border-t border-line-strong">
              <tr className="text-ink-900">
                <td />
                <th scope="row" className="pt-2.5 text-left font-medium">
                  Equipo
                </th>
                <td className="pt-2.5 text-right text-base font-semibold tabular-nums">{n(totals.pedidos)}</td>
                <td className="pt-2.5 text-right text-xs">
                  <Delta v={totals.pedidos - totals.pedidosAyer} />
                </td>
                <td className="pt-2.5 pl-2 @xl:pl-3">
                  <Cierre pedidos={totals.pedidos} leads={totals.leads} bar={false} />
                </td>
                <td className="hidden pt-2.5 pl-4 text-xs text-ink-500 @xl:table-cell">
                  {team.metaCumplida && team.metaCumplida.de > 0
                    ? `${team.metaCumplida.cumplen} de ${team.metaCumplida.de} ya cumplen la meta`
                    : null}
                </td>
                <td className="hidden pt-2.5 text-right tabular-nums @3xl:table-cell">{n(totals.llamadas)}</td>
              </tr>
            </tfoot>
          </table>
          {team.quiet.length > 0 && (
            <button
              type="button"
              aria-expanded={showQuiet}
              onClick={() => setShowQuiet((v) => !v)}
              className="mt-3 inline-flex items-center gap-1 self-start rounded text-xs font-medium text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
            >
              {showQuiet
                ? `Ocultar las ${team.quiet.length} con poca actividad`
                : `Y ${team.quiet.length} más con poca actividad`}
              <IconChevronDown className={cn("size-3.5 transition-transform", showQuiet && "rotate-180")} aria-hidden />
            </button>
          )}
        </>
      )}
    </section>
  );
}

function sameInteractionFilter(a: LeadInteractionDateFilter | null, b: LeadInteractionDateFilter | null): boolean {
  if (!a || !b || a.kind !== b.kind) return a === b;
  if (a.kind === "day" && b.kind === "day") return a.date === b.date;
  return a.kind === "older" && b.kind === "older" && a.before === b.before;
}

/** «Sin llamar» por día de su última interacción: el +7 días primero y en rojo
 *  (gente que escribió hace más de una semana y nadie llamó). Cada barra es un
 *  botón que filtra la cola; tocar la elegida quita el filtro. */
function SinLlamarCard({
  data,
  selected,
  onSelect,
}: {
  data: LeadsInsights;
  selected: LeadInteractionDateFilter | null;
  onSelect: (filter: LeadInteractionDateFilter | null) => void;
}) {
  const bars = [
    {
      key: "older",
      label: "+7 d",
      long: "hace más de 7 días",
      count: data.sinLlamarOlder,
      color: VIZ.crit,
      strong: true,
      filter: { kind: "older", before: data.sinLlamarOlderBefore } as LeadInteractionDateFilter,
    },
    ...data.sinLlamar.map((d) => ({
      key: d.date,
      label: d.dia,
      long: d.dia === "Hoy" ? "hoy" : d.date.split("-").reverse().join("/"),
      count: d.count,
      color: VIZ.brand,
      strong: d.dia === "Hoy",
      filter: { kind: "day", date: d.date } as LeadInteractionDateFilter,
    })),
  ];
  const max = Math.max(1, ...bars.map((b) => b.count));
  const anySelected = bars.some((b) => sameInteractionFilter(selected, b.filter));
  const H = 112;

  return (
    <section className={CARD}>
      <Head
        title="Sin llamar"
        figure={n(data.sinLlamarTotal)}
        sub={
          <>
            {data.sinLlamarOlder > 0 && (
              <>
                <span className="font-medium text-crit-fg">{n(data.sinLlamarOlder)} con más de 7 días</span>
                {" · "}
              </>
            )}
            toca una barra para filtrar
          </>
        }
      />
      <div className="mt-4 flex items-end gap-1.5 border-b border-line-strong" style={{ height: H }} role="group" aria-label="Sin llamar por día de su última interacción">
        {bars.map((b) => {
          const active = sameInteractionFilter(selected, b.filter);
          const dim = anySelected && !active;
          return (
            <button
              key={b.key}
              type="button"
              disabled={b.count <= 0}
              aria-pressed={active}
              aria-label={`${n(b.count)} sin llamar con última interacción ${b.long}${active ? ", filtro activo: toca para quitarlo" : ""}`}
              onClick={() => onSelect(active ? null : b.filter)}
              className="group flex h-full min-w-0 flex-1 cursor-pointer flex-col items-center justify-end rounded-t-[4px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-default"
            >
              <span className={cn("mb-1 text-[11px] leading-none tabular-nums", b.strong ? "font-semibold text-ink-900" : "text-ink-600", dim && "opacity-50")}>
                {n(b.count)}
              </span>
              <span
                className={cn(
                  "block w-full max-w-7 rounded-t-[4px] transition-opacity group-enabled:group-hover:opacity-80",
                  active && "ring-2 ring-brand-600 ring-offset-2",
                  dim && "opacity-35",
                )}
                style={{ height: `${Math.max(b.count > 0 ? 3 : 0, (b.count / max) * (H - 22))}px`, background: b.color }}
              />
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-1.5" aria-hidden>
        {bars.map((b) => (
          <span key={b.key} className={cn("min-w-0 flex-1 text-center text-[11px] leading-4", b.strong ? "font-semibold text-ink-900" : "text-ink-500")}>
            {b.label}
          </span>
        ))}
      </div>
    </section>
  );
}

/** Ancho real del contenedor: el SVG se dibuja a escala 1, así el texto mide lo
 *  que dice (11 px) en la columna de la derecha y en dos columnas por igual. */
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

/** El tope del eje: un número redondo y par justo por encima del máximo (102 → 120). */
function niceTop(v: number): number {
  if (v <= 4) return 4;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.6, 2, 3, 4, 5, 6, 8, 10]) if (m * mag >= v && Number.isInteger((m * mag) / 2)) return m * mag;
  return 10 * mag;
}

const clock = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;

/** Pedidos acumulados del día: hoy contra ayer y contra el mismo día de la
 *  semana pasada. Al pasar el cursor, las tres cifras de esa hora. */
function RaceChart({ race }: { race: TeamRace }) {
  const [boxRef, W] = useWidth<HTMLDivElement>(440);
  const [hover, setHover] = useState<number | null>(null);
  const H = 200;
  const L = 34;
  const R = 16;
  const T = 14;
  const B = 22;
  const span = race.to - race.from;
  const nowH = Math.min(race.to, Math.max(race.from, race.now));
  const x = (h: number) => L + ((h - race.from) / span) * (W - L - R);
  const top = niceTop(Math.max(1, race.hoyNow, ...race.ayer, ...race.semana));
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const ticks = Number.isInteger(top / 2) ? [0, top / 2, top] : [0, top];
  const path = (pts: [number, number][]) => pts.map(([h, v], i) => `${i ? "L" : "M"}${x(h).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const series = (vals: number[]) => vals.map((v, i) => [race.from + i, v] as [number, number]);
  const hoyPts = race.now >= race.from ? [...series(race.hoy), [nowH, race.hoyNow] as [number, number]] : [];
  const xTicks: number[] = [];
  for (let h = race.from; h <= race.to; h += 2) xTicks.push(h);

  // Las dos etiquetas junto al «ahora», separadas al menos 14 px.
  const yHoy = y(race.hoyNow);
  const yAyer = y(race.ayerNow);
  const hoyAbove = race.hoyNow >= race.ayerNow;
  const gap = 14;
  let lyHoy = hoyAbove ? yHoy - 9 : yHoy + 17;
  let lyAyer = hoyAbove ? yAyer + 16 : yAyer - 8;
  if (hoyAbove && lyAyer - lyHoy < gap) lyAyer = lyHoy + gap;
  if (!hoyAbove && lyHoy - lyAyer < gap) lyHoy = lyAyer + gap;
  lyHoy = Math.min(H - B - 2, Math.max(T + 10, lyHoy));
  lyAyer = Math.min(H - B - 2, Math.max(T + 10, lyAyer));
  const labelAnchor = x(nowH) > W - 90 ? "end" : "start";
  const labelX = labelAnchor === "end" ? x(nowH) - 8 : x(nowH) + 8;

  const hoverIdx = hover;
  const hoverH = hoverIdx != null ? race.from + hoverIdx : null;
  const value = (vals: number[], i: number) => (i < vals.length ? vals[i] : null);

  return (
    <div ref={boxRef} className="relative w-full">
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="block"
        role="img"
        aria-label={`Pedidos acumulados: hoy ${race.hoyNow}, ayer a esta hora ${race.ayerNow}, ${race.semanaLabel} a esta hora ${race.semanaNow}`}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const h = race.from + ((e.clientX - rect.left - L) / (W - L - R)) * span;
          const i = Math.round(Math.min(race.to, Math.max(race.from, h)) - race.from);
          setHover(i);
        }}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke={t === 0 ? VIZ.lineStrong : VIZ.line} />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill={VIZ.ink500} className="tabular-nums">
              {n(t)}
            </text>
          </g>
        ))}
        {xTicks.map((h) => (
          <text key={h} x={x(h)} y={H - 6} textAnchor="middle" fontSize="11" fill={VIZ.ink500}>
            {clock(h)}
          </text>
        ))}
        <path d={path(series(race.semana))} fill="none" stroke={VIZ.ink300} strokeWidth={2} strokeDasharray="5 4" strokeLinejoin="round" />
        <path d={path(series(race.ayer))} fill="none" stroke={VIZ.ink300} strokeWidth={2} strokeLinejoin="round" />
        <line x1={x(nowH)} x2={x(nowH)} y1={T} y2={H - B} stroke={VIZ.brand} strokeDasharray="3 3" strokeOpacity={0.6} />
        {hoyPts.length > 1 && <path d={path(hoyPts)} fill="none" stroke={VIZ.brand} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />}
        <circle cx={x(nowH)} cy={yAyer} r={4} fill={VIZ.ink300} stroke="#fff" strokeWidth={2} />
        {race.now >= race.from && <circle cx={x(nowH)} cy={yHoy} r={5} fill={VIZ.brand} stroke="#fff" strokeWidth={2} />}
        {/* Halo blanco: la etiqueta se lee aunque cruce una línea. */}
        <text x={labelX} y={lyHoy} textAnchor={labelAnchor} fontSize="12" fontWeight={600} fill={VIZ.ink900} stroke="#fff" strokeWidth={4} paintOrder="stroke" className="tabular-nums">
          {n(race.hoyNow)} hoy
        </text>
        <text x={labelX} y={lyAyer} textAnchor={labelAnchor} fontSize="11" fill={VIZ.ink600} stroke="#fff" strokeWidth={4} paintOrder="stroke" className="tabular-nums">
          {n(race.ayerNow)} ayer
        </text>
        {hoverH != null && <line x1={x(hoverH)} x2={x(hoverH)} y1={T} y2={H - B} stroke={VIZ.ink300} />}
      </svg>
      {hoverIdx != null && hoverH != null && (
        <div
          className="pointer-events-none absolute top-1 z-10 whitespace-nowrap rounded-md bg-white px-2.5 py-1.5 text-xs shadow-control ring-1 ring-line"
          style={x(hoverH) > W / 2 ? { right: W - x(hoverH) + 8 } : { left: x(hoverH) + 8 }}
        >
          <p className="font-medium text-ink-900">A las {clock(hoverH)}</p>
          <p className="tabular-nums text-ink-600">
            {value(race.hoy, hoverIdx) != null && <>Hoy {value(race.hoy, hoverIdx)} · </>}
            Ayer {value(race.ayer, hoverIdx)} · {race.semanaLabel.replace(/^el /, "")} {value(race.semana, hoverIdx)}
          </p>
        </div>
      )}
    </div>
  );
}

function RaceCard({ race }: { race: TeamRace }) {
  const legend = [
    { label: "Hoy", line: <span className="h-0 w-4 border-t-[2.5px]" style={{ borderColor: VIZ.brand }} /> },
    { label: "Ayer", line: <span className="h-0 w-4 border-t-2" style={{ borderColor: VIZ.ink300 }} /> },
    {
      label: race.semanaLabel.charAt(0).toUpperCase() + race.semanaLabel.slice(1),
      line: <span className="h-0 w-4 border-t-2 border-dashed" style={{ borderColor: VIZ.ink300 }} />,
    },
  ];
  return (
    <section className={CARD}>
      <Head
        title="Pedidos, acumulado del día"
        figure={<DeltaPhrase v={race.hoyNow - race.ayerNow} />}
        sub={`hoy ${n(race.hoyNow)} · ayer a esta hora ${n(race.ayerNow)} · ${race.semanaLabel}, ${n(race.semanaNow)}`}
      />
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs leading-4 text-ink-600">
        {legend.map((it) => (
          <span key={it.label} className="inline-flex items-center gap-1.5">
            {it.line}
            {it.label}
          </span>
        ))}
      </div>
      <div className="mt-2">
        <RaceChart race={race} />
      </div>
    </section>
  );
}

function PanelSkeleton() {
  const block = "animate-pulse rounded bg-wash motion-reduce:animate-none";
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]" aria-label="Cargando el tablero" aria-busy="true">
      <div className={cn(CARD, "min-h-[360px]")}>
        <div className={cn(block, "h-4 w-28")} />
        <div className={cn(block, "mt-2 h-6 w-72 max-w-full")} />
        <div className={cn(block, "mt-2 h-3 w-56 max-w-full")} />
        <div className="mt-6 space-y-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className={cn(block, "h-5")} />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-1">
        {[0, 1].map((i) => (
          <div key={i} className={cn(CARD, "min-h-[220px]")}>
            <div className={cn(block, "h-4 w-24")} />
            <div className={cn(block, "mt-2 h-6 w-20")} />
            <div className={cn(block, "mt-6 h-28")} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** El «Tablero de hoy», encima de los chips de la cola. Se puede ocultar. */
export function LeadsInsightsPanel({
  data,
  productividadHref,
  interactionDateFilter,
  onInteractionDateFilterChange,
}: {
  data: LeadsInsights | null;
  /** Productividad, con la tienda que se mira. */
  productividadHref: string;
  interactionDateFilter: LeadInteractionDateFilter | null;
  onInteractionDateFilterChange: (filter: LeadInteractionDateFilter | null) => void;
}) {
  // Recordar si se ocultó: es una comodidad de cada quien, en su navegador. El
  // panel solo se pinta en el cliente (`ssr: false`), así que se lee al montar.
  const [open, setOpen] = useState(() => {
    try {
      return window.localStorage.getItem("leads.tablero") !== "oculto";
    } catch {
      return true; // sin almacenamiento: se ve abierto
    }
  });
  function toggle() {
    setOpen((v) => {
      try {
        window.localStorage.setItem("leads.tablero", v ? "oculto" : "visible");
      } catch {
        /* sin almacenamiento: solo esta vez */
      }
      return !v;
    });
  }

  return (
    <section aria-labelledby="tablero-de-hoy">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id="tablero-de-hoy" className="text-sm font-semibold text-ink-900">
          Tablero de hoy
        </h2>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="rounded px-1.5 py-0.5 text-xs font-medium text-ink-500 hover:bg-wash hover:text-ink-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          {open ? "Ocultar tablero" : "Mostrar tablero"}
        </button>
      </div>
      {open &&
        (data ? (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <TeamCard team={data.team} href={productividadHref} />
            <div className="grid grid-cols-1 content-start gap-3 md:grid-cols-2 xl:grid-cols-1">
              <SinLlamarCard data={data} selected={interactionDateFilter} onSelect={onInteractionDateFilterChange} />
              {data.team && <RaceCard race={data.team.race} />}
            </div>
          </div>
        ) : (
          <PanelSkeleton />
        ))}
    </section>
  );
}
