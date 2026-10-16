import { VIZ } from "@/components/palette";
import type { DateHourPattern } from "@/lib/metrics";

export const WEEKDAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const WEEKDAYS_LONG = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;

/**
 * Cuándo compra la tienda: el pico, una columna por hora (la del pico en el
 * azul de la serie) y una barra por día de la semana. Cada marca dice su cifra
 * al pasar por encima, y la tabla de días va debajo.
 */
export function HourPattern({ pattern }: { pattern: DateHourPattern }) {
  const maxHour = Math.max(1, ...pattern.byHour);
  const maxDay = Math.max(1, ...pattern.byWeekday);
  const peakHour = pattern.byHour.indexOf(Math.max(...pattern.byHour));
  const W = 24 * 12;
  const H = 96;
  return (
    <div className="flex flex-col gap-6">
      {pattern.peak ? (
        <p className="text-sm text-ink-700">
          El pico es el <strong className="font-semibold text-ink-900">{WEEKDAYS_LONG[pattern.peak.weekday]}</strong> a las{" "}
          <strong className="font-semibold tabular-nums text-ink-900">{hh(pattern.peak.hour)}</strong> (
          {pattern.peak.count.toLocaleString("es-PE")} {pattern.peak.count === 1 ? "orden" : "órdenes"}).
        </p>
      ) : (
        <p className="text-sm text-ink-500">Sin órdenes en el periodo.</p>
      )}

      <section aria-labelledby="horas-titulo">
        <h3 id="horas-titulo" className="text-sm font-semibold text-ink-900">
          Por hora
        </h3>
        <svg
          role="img"
          aria-label={`Órdenes por hora; la hora con más es ${hh(peakHour)}`}
          viewBox={`0 0 ${W} ${H + 18}`}
          className="mt-3 block h-auto w-full"
        >
          <line x1={0} x2={W} y1={H} y2={H} stroke={VIZ.lineStrong} strokeWidth={1} />
          {pattern.byHour.map((v, h) => {
            const bh = v > 0 ? Math.max(2, (v / maxHour) * (H - 4)) : 0;
            return (
              <g key={h}>
                <title>{`${hh(h)}: ${v} ${v === 1 ? "orden" : "órdenes"}`}</title>
                <rect x={h * 12 + 1} y={0} width={10} height={H} fill="transparent" />
                {bh > 0 && <rect x={h * 12 + 1} y={H - bh} width={10} height={bh} rx={2} fill={h === peakHour ? VIZ.brand : VIZ.ink300} />}
                {h % 3 === 0 && (
                  <text x={h * 12 + 6} y={H + 14} textAnchor="middle" fontSize={10} fill={VIZ.ink500}>
                    {String(h).padStart(2, "0")}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </section>

      <section aria-labelledby="dias-titulo">
        <h3 id="dias-titulo" className="text-sm font-semibold text-ink-900">
          Por día de la semana
        </h3>
        <ul className="mt-3 flex flex-col gap-2">
          {pattern.byWeekday.map((v, i) => (
            <li key={i} className="grid grid-cols-[2.5rem_1fr_3rem] items-center gap-3 text-sm">
              <span className="text-ink-600">{WEEKDAYS[i]}</span>
              <span className="h-2 rounded-full bg-line">
                <span className="block h-full rounded-full bg-ink-500" style={{ width: `${v ? Math.max(2, (v / maxDay) * 100) : 0}%` }} />
              </span>
              <span className="text-right tabular-nums text-ink-900">{v.toLocaleString("es-PE")}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
